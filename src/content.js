// Orquestra o painel: lista documentos, baixa peças marcadas, mantém a conversa
// e faz streaming da resposta do Claude (via Port com o service worker).
(function () {
  if (window.__pjeIaLoaded) return;
  window.__pjeIaLoaded = true;

  const SYSTEM_PROMPT = [
    "Você é um assistente jurídico que analisa autos de processos do PJe.",
    "Responda sempre em português do Brasil.",
    "Baseie-se SOMENTE nos documentos anexados (peças selecionadas pelo usuário).",
    "Cite a peça de origem pelo nome ao afirmar fatos (ex.: 'na Contestação…').",
    "As citações precisas de trechos (com página) são geradas automaticamente pelo",
    "sistema — apoie cada afirmação relevante no trecho correspondente sempre que",
    "possível. Peças digitalizadas sem camada de texto podem não permitir citação",
    "automática; nesse caso, apenas indique a peça pelo nome e avise o usuário.",
    "Seja objetivo e técnico. Se a informação não estiver nos documentos selecionados,",
    "diga explicitamente que não consta nas peças fornecidas — não invente.",
    "Atenção a peças de mero encaminhamento: no PJe é comum a petição conter apenas",
    "uma remissão como 'Em anexo' ou 'Segue anexo', com o conteúdo real nos documentos",
    "anexos protocolados junto dela. Nesse caso, diga claramente que a peça é só um",
    "encaminhamento e oriente o usuário a marcar também os anexos correspondentes",
    "(ex.: as peças 'Documento de Comprovação' logo abaixo dela na lista).",
    "Formate a resposta em markdown quando ajudar a leitura: use títulos curtos,",
    "listas e tabelas (ex.: linha do tempo dos atos, partes, pedidos).",
  ].join(" ");

  // Limite de payload do FALLBACK base64 (quando o upload à Files API falha):
  // a API aceita 32 MB por requisição; base64 infla ~33%. No caminho normal as
  // peças são referenciadas por file_id e este teto não se aplica.
  const MAX_TOTAL_B64_CHARS = 24 * 1024 * 1024;

  // Betas enviadas em todos os requests de chat (documentos por file_id).
  const BETAS_CHAT = ["files-api-2025-04-14"];

  // Fontes confiáveis para a busca de jurisprudência/legislação (allowed_domains).
  const DOMINIOS_JURIDICOS = [
    "stf.jus.br",
    "stj.jus.br",
    "tst.jus.br",
    "tjce.jus.br",
    "cnj.jus.br",
    "planalto.gov.br",
    "lexml.gov.br",
    "jusbrasil.com.br",
    "conjur.com.br",
    "migalhas.com.br",
  ];

  // Ferramentas de busca web na versão suportada pelo modelo atual.
  function toolsBusca() {
    if (!modelCaps) return [];
    return [
      {
        type: modelCaps.webSearch,
        name: "web_search",
        max_uses: 5,
        allowed_domains: DOMINIOS_JURIDICOS,
      },
      {
        type: modelCaps.webFetch,
        name: "web_fetch",
        max_uses: 3,
        allowed_domains: DOMINIOS_JURIDICOS,
      },
    ];
  }

  const docsCache = new Map(); // id -> {kind:"pdf",b64,size,pages,fileId?} | {kind:"text",text}
  let conversation = []; // [{role, content}]
  // Peças cujos blocos document JÁ estão no histórico desta conversa. Anexamos
  // só o DELTA a cada turno: reanexar tudo duplicaria as páginas/tokens no
  // request (o histórico não pode ser editado) e estourava os limites já no
  // segundo envio. Peça desmarcada permanece no histórico até "Nova conversa".
  let pecasNaConversa = new Set();
  // A busca web foi usada nesta conversa: o histórico contém blocos de
  // ferramenta, então as tools continuam declaradas nos turnos seguintes
  // (mesmo com o toggle desligado) — remover trocaria o conjunto de tools,
  // invalidando o cache de prefixo e arriscando rejeição do histórico.
  let buscaNaConversa = false;
  let busy = false;

  const panel = PjePanel.mount();

  // Request/response com o worker (upload, contagem de tokens, capacidades).
  function rpc(msg) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(msg, (resp) => {
        if (chrome.runtime.lastError)
          return reject(new Error(chrome.runtime.lastError.message));
        if (!resp) return reject(new Error("sem resposta do serviço da extensão"));
        if (resp.error) return reject(new Error(resp.error));
        resolve(resp);
      });
    });
  }

  // Capacidades do modelo atual (limite de páginas, contexto, ferramentas web).
  let modelCaps = null;
  function refreshCaps() {
    chrome.runtime.sendMessage({ type: "caps" }, (r) => {
      void chrome.runtime.lastError; // worker pode estar acordando — sem ruído
      if (r && r.caps) modelCaps = r.caps;
    });
  }
  refreshCaps();

  // Garante as capacidades ANTES de validar limites (o primeiro envio pode
  // chegar antes do refreshCaps inicial responder — a guarda ficaria muda).
  function garantirCaps() {
    if (modelCaps) return Promise.resolve();
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "caps" }, (r) => {
        void chrome.runtime.lastError;
        if (r && r.caps) modelCaps = r.caps;
        resolve(); // sem caps segue mesmo assim: count_tokens e a API guardam
      });
    });
  }

  // Estado da chave: mostra CTA de configuração quando ausente e reage a mudanças
  // (ex.: quando o usuário salva a chave pelo popup, sem recarregar a página).
  function refreshKey() {
    chrome.storage.local.get(["apiKey"], (v) => panel.setConfigured(!!v.apiKey));
  }
  refreshKey();
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === "local" && ch.apiKey) refreshKey();
    if (area === "local" && (ch.model || ch.apiKey)) refreshCaps();
  });
  panel.onConfigure(() => chrome.runtime.sendMessage({ type: "openOptions" }));

  panel.onReset(() => {
    if (busy) return; // não zera no meio de uma resposta
    conversation = [];
    pecasNaConversa.clear();
    buscaNaConversa = false;
    panel.setContexto(null);
    panel.clearMessages();
    refreshKey(); // re-renderiza CTA de chave se necessário
  });

  let docsIndex = new Map(); // id -> {id, titulo} (para chips e card de progresso)
  function refresh() {
    const docs = PJE.listarDocumentos();
    docsIndex = new Map(docs.map((d) => [d.id, d]));
    panel.setDocs(docs);
  }
  refresh();

  function metaDe(id) {
    return docsIndex.get(id) || { id, titulo: "Peça " + id };
  }

  // Anexa o observer à timeline. Se #divTimeLine ainda não existe (a página pode
  // renderizá-la após o document_idle), espera-a surgir e então observa.
  function attachTimelineObserver() {
    const tl = document.querySelector("#divTimeLine");
    if (!tl) return false;
    let t;
    new MutationObserver(() => {
      clearTimeout(t);
      t = setTimeout(refresh, 400);
    }).observe(tl, { childList: true, subtree: true });
    refresh();
    return true;
  }
  if (!attachTimelineObserver()) {
    const bodyObs = new MutationObserver(() => {
      if (attachTimelineObserver()) bodyObs.disconnect();
    });
    bodyObs.observe(document.documentElement, { childList: true, subtree: true });
  }

  // Baixa as peças com concorrência limitada (3 por vez), com progresso por
  // peça no card de preparo (spinner -> check + barra de progresso).
  async function baixarSelecionadas(ids) {
    panel.startPrep(ids.map(metaDe));
    const queue = ids.slice();
    async function worker() {
      while (queue.length) {
        const id = queue.shift();
        panel.setPrepState(id, "loading");
        if (!docsCache.has(id)) {
          try {
            docsCache.set(id, await PJE.baixar(id));
          } catch (e) {
            // identifica a peça pelo nome na mensagem de erro
            throw new Error('"' + metaDe(id).titulo + '" — ' + (e && e.message ? e.message : e));
          }
        }
        panel.setPrepState(id, "done");
      }
    }
    await Promise.all([worker(), worker(), worker()]);
  }

  // Sobe as peças PDF ainda sem file_id para a Files API (2 por vez). Falha de
  // upload não interrompe: a peça cai no fallback base64 (teto de 24 MB).
  async function subirPecas(ids) {
    const idProc = PJE.getIdProcesso() || "proc";
    const pend = ids.filter((id) => {
      const d = docsCache.get(id);
      return d && d.kind === "pdf" && !d.fileId;
    });
    if (!pend.length) return;
    panel.setStatus("Enviando peças para análise…", true);
    const queue = pend.slice();
    async function w() {
      while (queue.length) {
        const id = queue.shift();
        const d = docsCache.get(id);
        try {
          const r = await rpc({
            type: "upload",
            payload: {
              filename: "peca-" + id + ".pdf",
              b64: d.b64,
              mime: "application/pdf",
              cacheKey: idProc + ":" + id + ":" + (d.size || 0),
            },
          });
          d.fileId = r.fileId;
        } catch (e) {
          console.debug("[PJe IA] upload da peça", id, "falhou; usando base64:", e && e.message);
        }
      }
    }
    await Promise.all([w(), w()]);
  }

  // Bloqueia envios acima do limite de páginas de PDF por request do modelo
  // (600 nos modelos de 1M de contexto; 100 no Haiku). Retorna o total.
  function guardaPaginas(ids) {
    if (!modelCaps) return 0;
    let total = 0;
    for (const id of ids) {
      const d = docsCache.get(id);
      if (d && d.kind === "pdf") total += d.pages || 1;
    }
    if (total > modelCaps.maxPages) {
      const dica =
        modelCaps.maxPages <= 100
          ? " Dica: o Haiku aceita só 100 páginas — nas opções da extensão, troque para o Sonnet 5 (até 600 páginas)."
          : "";
      throw new Error(
        "as peças selecionadas somam ~" + total + " páginas — acima do limite de " +
          modelCaps.maxPages + " páginas por análise deste modelo. Desmarque algumas peças e analise por partes." +
          dica
      );
    }
    return total;
  }

  // Pré-voo gratuito de tokens (count_tokens): estima o tamanho do contexto e
  // bloqueia acima de 90% da janela do modelo. Falha da estimativa não bloqueia.
  async function estimarContexto(messages, comPecasNovas) {
    let r = null;
    try {
      r = await rpc({
        type: "countTokens",
        payload: { system: SYSTEM_PROMPT, messages, betas: BETAS_CHAT },
      });
    } catch {
      return null; // estimativa é opcional
    }
    if (!r || !r.tokens || !r.contextTokens) return null;
    const pct = Math.round((r.tokens / r.contextTokens) * 100);
    if (r.tokens > r.contextTokens * 0.9) {
      // desmarcar peça não a remove do histórico — a saída certa depende da causa
      throw new Error(
        "a conversa ocupa ~" + pct + "% do contexto do modelo (" +
          Math.round(r.tokens / 1000) + " mil tokens) — não sobra espaço para a análise. " +
          (comPecasNovas
            ? "Desmarque algumas das peças novas, ou clique em ⟲ (Nova conversa) e selecione só as peças desta análise."
            : "Clique em ⟲ (Nova conversa) e selecione só as peças desta análise.")
      );
    }
    return { tokens: r.tokens, ctxTokens: r.contextTokens, pct };
  }

  // Remove breakpoints de cache antigos do histórico (a API aceita no máx. 4).
  function stripOldCacheControl() {
    for (const turn of conversation) {
      if (Array.isArray(turn.content)) {
        for (const block of turn.content) {
          if (block && block.cache_control) delete block.cache_control;
        }
      }
    }
  }

  // Monta os blocos das peças; marca o último com cache_control para que os
  // turnos seguintes reaproveitem o prefixo (economia de ~90% nos tokens).
  // O "title" nos blocos document permite ao modelo citar a peça pelo nome.
  function montarBlocos(ids) {
    const blocks = [];
    let totalB64 = 0;
    for (const id of ids) {
      const d = docsCache.get(id);
      if (d.kind === "pdf") {
        if (d.fileId) {
          // caminho normal: referência por file_id (Files API) — payload mínimo
          blocks.push({
            type: "document",
            source: { type: "file", file_id: d.fileId },
            title: metaDe(id).titulo,
            citations: { enabled: true },
          });
        } else {
          // fallback: base64 inline (upload indisponível)
          totalB64 += d.b64.length;
          blocks.push({
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data: d.b64 },
            title: metaDe(id).titulo,
            citations: { enabled: true },
          });
        }
      } else {
        // peças HTML viram documento de texto puro — também citáveis
        blocks.push({
          type: "document",
          source: { type: "text", media_type: "text/plain", data: d.text.slice(0, 60000) },
          title: metaDe(id).titulo,
          citations: { enabled: true },
        });
      }
    }
    if (totalB64 > MAX_TOTAL_B64_CHARS) {
      const mb = Math.round(totalB64 / 1024 / 1024);
      throw new Error(
        `as peças selecionadas somam ~${mb} MB — acima do limite da análise. Desmarque algumas peças maiores e tente de novo.`
      );
    }
    if (blocks.length) blocks[blocks.length - 1].cache_control = { type: "ephemeral" };
    return blocks;
  }

  // Abre um canal com o worker e resolve quando o turno termina.
  // Resolve com {content, stopReason}: os blocos completos da resposta
  // (necessários no histórico para citações, ferramentas e thinking assinado).
  function stream(messages, handlers, opts, tipo) {
    return new Promise((resolve, reject) => {
      const port = chrome.runtime.connect({ name: "claude" });
      let finished = false;
      // Ping periódico: receber mensagem pela porta reseta o timer de
      // ociosidade do service worker (MV3 mata o worker após ~30 s sem
      // eventos — fatal na geração de .docx, que tem longos silêncios).
      const ping = setInterval(() => {
        try {
          port.postMessage({ type: "ping" });
        } catch {
          clearInterval(ping);
        }
      }, 20000);
      port.onMessage.addListener((m) => {
        if (m.type === "delta") handlers.onDelta(m.text);
        else if (m.type === "thinking") handlers.onThinking(m.text);
        else if (m.type === "citation") handlers.onCitation && handlers.onCitation(m.citation);
        else if (m.type === "tool") handlers.onTool && handlers.onTool(m.name);
        else if (m.type === "file") handlers.onFile && handlers.onFile(m);
        else if (m.type === "trunc") handlers.onTrunc();
        else if (m.type === "done") {
          finished = true;
          clearInterval(ping);
          port.disconnect();
          resolve({ content: m.content || [], stopReason: m.stopReason || null });
        } else if (m.type === "error") {
          finished = true;
          clearInterval(ping);
          port.disconnect();
          reject(new Error(m.error));
        }
      });
      port.onDisconnect.addListener(() => {
        clearInterval(ping);
        if (!finished) reject(new Error("conexão com o serviço interrompida — tente de novo"));
      });
      port.postMessage({
        type: tipo || "chat",
        payload: Object.assign(
          { system: SYSTEM_PROMPT, messages, betas: BETAS_CHAT },
          opts || {}
        ),
      });
    });
  }

  // Dispara o download de um arquivo no navegador (Blob + âncora; sem permissão
  // extra de "downloads").
  function baixarArquivo(filename, b64, mime) {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const blob = new Blob([bytes], { type: mime || "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  // Rótulo humano de uma citação da API: "Peça, fl(s). X[–Y]" (fim exclusivo)
  // para PDFs; título do site (com link) para resultados da busca web;
  // só o título para documentos de texto (char_location).
  function infoCitacao(c) {
    if (c.type === "web_search_result_location") {
      return { label: c.title || c.url || "fonte na web", url: c.url };
    }
    const doc = tituloLimpo(c.document_title) || "peça";
    if (c.type === "page_location") {
      const ini = c.start_page_number;
      const fim = (c.end_page_number || ini + 1) - 1;
      return { label: doc + (fim > ini ? ", fls. " + ini + "–" + fim : ", fl. " + ini) };
    }
    return { label: doc };
  }
  function tituloLimpo(t) {
    return String(t || "").replace(/^\d{6,}\s*-\s*/, "");
  }
  function chaveCitacao(c) {
    if (c.type === "web_search_result_location") return "web:" + (c.url || c.title || "");
    return [
      c.type,
      c.document_index,
      c.start_page_number != null ? c.start_page_number : c.start_char_index,
      c.end_page_number != null ? c.end_page_number : c.end_char_index,
    ].join(":");
  }

  panel.onSend(async (text, selectedIds) => {
    if (busy) return;
    if (selectedIds.length === 0) {
      panel.setStatus("Marque ao menos uma peça — na lista acima ou digitando @ no campo.");
      return;
    }
    busy = true;

    // Anexo INCREMENTAL: só as peças que ainda não estão no histórico entram
    // neste turno. As já enviadas continuam valendo (fazem parte do prefixo
    // cacheado da conversa) — reanexá-las duplicaria páginas e tokens.
    const novas = selectedIds.filter((id) => !pecasNaConversa.has(id));
    const attach = novas.length > 0;
    // mostra na mensagem quais peças ENTRAM no contexto neste turno
    panel.addMessage(
      "user",
      text,
      attach ? novas.map((id) => metaDe(id).titulo) : null
    );
    panel.lockInput(true);
    panel.setStatus("");

    let assistantEl = null;
    let acc = "";
    let truncated = false;

    try {
      await garantirCaps(); // limites do modelo antes de qualquer validação
      let userContent;
      let paginas = 0;
      if (attach) {
        await baixarSelecionadas(novas);
        // a guarda conta TUDO que vai no request: histórico + peças novas
        paginas = guardaPaginas([...pecasNaConversa, ...novas]);
        await subirPecas(novas);
        stripOldCacheControl();
        userContent = [...montarBlocos(novas), { type: "text", text }];
      } else {
        paginas = guardaPaginas([...pecasNaConversa]);
        userContent = text;
      }

      panel.setStatus("Estimando o tamanho do contexto…", true);
      const est = await estimarContexto(
        [...conversation, { role: "user", content: userContent }],
        attach
      );
      if (attach) panel.endPrep(); // confirma "peças anexadas" após validar limites
      let infoCtx = "";
      if (est) {
        infoCtx = " (~" + Math.round(est.tokens / 1000) + " mil tokens, " + est.pct + "% do contexto)";
        panel.setContexto({
          tokens: est.tokens,
          ctxTokens: est.ctxTokens,
          paginas,
          maxPaginas: modelCaps ? modelCaps.maxPages : 0,
          pecas: pecasNaConversa.size + novas.length,
        });
      }

      conversation.push({ role: "user", content: userContent });
      for (const id of novas) pecasNaConversa.add(id);

      panel.setStatus("Analisando…" + infoCtx, true);
      assistantEl = panel.addMessage("assistant", "");
      // Citações deste turno: marcadores [n] entram no texto via placeholders
      // (área de uso privado do Unicode — sobrevivem intactos ao escape do
      // renderizador) e a lista numerada vai no rodapé da mensagem.
      const cites = [];
      const citeKeys = new Map();
      // Busca de jurisprudência: ferramentas web entram só com o toggle ligado.
      // Nunca combinamos ferramentas web com code_execution no mesmo request
      // (as versões _20260209 já embutem execução para filtragem dinâmica).
      const opts = {};
      if ((panel.isSearchOn() || buscaNaConversa) && modelCaps) {
        opts.tools = toolsBusca();
        opts.betas = BETAS_CHAT.concat(
          modelCaps.webFetch === "web_fetch_20250910" ? ["web-fetch-2025-09-10"] : []
        );
      }
      let thinkAcc = "";
      const fim = await stream(conversation, {
        onDelta(delta) {
          if (!acc) panel.setStatus("");
          acc += delta;
          panel.updateAssistant(assistantEl, acc, cites);
        },
        onThinking(t) {
          if (t) {
            thinkAcc += t;
            panel.setThinking(assistantEl, thinkAcc);
          }
          if (!acc) panel.setStatus("Raciocinando sobre as peças…", true);
        },
        onCitation(c) {
          const k = chaveCitacao(c);
          let n = citeKeys.get(k);
          if (!n) {
            n = cites.length + 1;
            citeKeys.set(k, n);
            cites.push(infoCitacao(c));
          }
          acc += "\uE000" + n + "\uE001";
          panel.updateAssistant(assistantEl, acc, cites);
        },
        onTool(name) {
          if (acc) return; // ferramenta no meio do texto: não sobrepõe a resposta
          if (name === "web_search") panel.setStatus("Pesquisando jurisprudência na web…", true);
          else if (name === "web_fetch") panel.setStatus("Lendo página de fonte jurídica…", true);
          else panel.setStatus("Executando ferramenta…", true);
        },
        onTrunc() {
          truncated = true;
        },
      }, opts);

      if (acc.trim()) {
        // Preserva os blocos completos da resposta (não só o texto): a API
        // exige thinking assinado intacto e blocos de ferramenta/citações no
        // histórico dos turnos seguintes.
        conversation.push({
          role: "assistant",
          content:
            fim.content && fim.content.length
              ? fim.content
              : [{ type: "text", text: acc.replace(/\uE000\d+\uE001/g, "") }],
        });
        // turno gravado com tools declaradas \u2192 mant\u00EA-las at\u00E9 "Nova conversa"
        if (opts.tools) buscaNaConversa = true;
        let st = "";
        if (truncated)
          st = "A resposta atingiu o tamanho máximo — peça para continuar, se necessário.";
        if (fim.stopReason === "model_context_window_exceeded")
          st =
            "A conversa atingiu o limite de contexto do modelo — clique em ⟲ (Nova conversa) e selecione só as peças desta análise.";
        panel.setStatus(st);
      } else {
        // resposta vazia: não grava turno (evitaria content vazio no próximo request)
        panel.removeMessage(assistantEl);
        conversation.pop(); // remove o turno do usuário correspondente
        for (const id of novas) pecasNaConversa.delete(id); // peças saem junto
        panel.setStatus("O modelo não retornou texto. Tente novamente.");
      }
    } catch (e) {
      panel.endPrep(true); // remove o card de preparo, se ainda estiver na tela
      panel.setStatus("Erro: " + (e && e.message ? e.message : e));
      // remove a bolha vazia do assistente, se houver
      if (assistantEl && !acc) panel.removeMessage(assistantEl);
      // desfaz o turno do usuário para permitir nova tentativa
      if (conversation.length && conversation[conversation.length - 1].role === "user") {
        conversation.pop();
      }
      for (const id of novas) pecasNaConversa.delete(id); // peças do turno desfeito
    } finally {
      busy = false;
      panel.lockInput(false);
    }
  });

  // ---------------------------------------------------------------------------
  // Geração de documento Word (.docx) via skill oficial "docx" da Anthropic:
  // request próprio (code_execution + container com a skill), SEPARADO do chat
  // e sem ferramentas web — dois ambientes de execução confundem o modelo.
  // O arquivo gerado volta pela Files API e é baixado no navegador.
  // ---------------------------------------------------------------------------
  const INSTRUCAO_DOCX_PADRAO =
    "Elabore um relatório completo do processo: identificação e partes, síntese dos fatos, " +
    "linha do tempo dos atos processuais, pedidos, teses de cada parte, provas produzidas e " +
    "situação atual do feito.";

  panel.onGerarDoc(async (text, selectedIds) => {
    if (busy) return;
    if (selectedIds.length === 0) {
      panel.setStatus("Marque as peças que devem embasar o documento.");
      return;
    }
    busy = true;
    panel.lockInput(true);

    const usouPadrao = !(text && text.trim());
    const instrucao = usouPadrao ? INSTRUCAO_DOCX_PADRAO : text.trim();
    panel.addMessage(
      "user",
      "📄 Gerar documento (.docx): " + instrucao,
      selectedIds.map((id) => metaDe(id).titulo)
    );
    let assistantEl = null;
    let acc = "";
    let arquivo = null;

    try {
      await baixarSelecionadas(selectedIds);
      guardaPaginas(selectedIds);
      await subirPecas(selectedIds);
      const blocos = montarBlocos(selectedIds);
      panel.endPrep();

      panel.setStatus(
        usouPadrao
          ? "Nenhuma instrução digitada — gerando o relatório padrão do processo… (pode levar 1–2 minutos)"
          : "Gerando o documento conforme a instrução digitada… (pode levar 1–2 minutos)"
      );
      assistantEl = panel.addMessage("assistant", "");

      const messages = [
        {
          role: "user",
          content: [
            ...blocos,
            {
              type: "text",
              text:
                instrucao +
                " Gere o resultado como um arquivo Word (.docx) bem formatado " +
                "(títulos, listas e tabelas), usando a skill docx.",
            },
          ],
        },
      ];

      await stream(
        messages,
        {
          onDelta(delta) {
            acc += delta;
            panel.updateAssistant(assistantEl, acc);
          },
          onThinking() {
            if (!acc) panel.setStatus("Planejando o documento…", true);
          },
          onTool() {
            if (!acc) panel.setStatus("Gerando o arquivo .docx…", true);
          },
          onFile(f) {
            arquivo = f;
          },
          onTrunc() {},
        },
        {
          tools: [{ type: "code_execution_20260521", name: "code_execution" }],
          container: {
            skills: [{ type: "anthropic", skill_id: "docx", version: "latest" }],
          },
          // o parâmetro container (skills) exige a beta de code execution
          // JUNTO com a de skills — sem ela a API devolve 400
          betas: ["code-execution-2025-08-25", "skills-2025-10-02", "files-api-2025-04-14"],
          maxTokens: 16000,
        },
        "gerarDoc"
      );

      if (arquivo) {
        const idProc = PJE.getIdProcesso();
        const nome = ("processo-" + (idProc ? idProc + "-" : "") + arquivo.filename)
          .replace(/[^\w.\-]+/g, "-")
          .replace(/-+/g, "-");
        baixarArquivo(nome, arquivo.b64, arquivo.mime);
        panel.updateAssistant(
          assistantEl,
          (acc ? acc + "\n\n" : "") + "✅ **Documento gerado e baixado:** " + nome
        );
        panel.setStatus("");
      } else {
        panel.setStatus(
          "O modelo não gerou o arquivo .docx — tente reformular o pedido e gerar de novo."
        );
      }
    } catch (e) {
      panel.endPrep(true);
      panel.setStatus("Erro: " + (e && e.message ? e.message : e));
      if (assistantEl && !acc) panel.removeMessage(assistantEl);
    } finally {
      busy = false;
      panel.lockInput(false);
    }
  });
})();
