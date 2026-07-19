// Orquestra o painel: lista documentos, baixa peças marcadas, mantém a conversa
// e faz streaming da resposta do Claude (via Port com o service worker).
(function () {
  if (window.__pjeIaLoaded) return;
  window.__pjeIaLoaded = true;

  const SYSTEM_PROMPT = [
    "Você é um assistente jurídico que analisa autos de processos do PJe.",
    "Responda sempre em português do Brasil.",
    "Baseie-se SOMENTE nos documentos anexados (peças selecionadas pelo usuário).",
    "Cite a peça de origem ao afirmar fatos (ex.: 'na Petição 1002233…').",
    "Seja objetivo e técnico. Se a informação não estiver nos documentos selecionados,",
    "diga explicitamente que não consta nas peças fornecidas — não invente.",
    "Formate a resposta em markdown quando ajudar a leitura: use títulos curtos,",
    "listas e tabelas (ex.: linha do tempo dos atos, partes, pedidos).",
  ].join(" ");

  // Limite de payload: a API aceita 32 MB por requisição; base64 infla ~33%.
  // Mantemos folga para histórico + resposta.
  const MAX_TOTAL_B64_CHARS = 24 * 1024 * 1024;

  const docsCache = new Map(); // id -> {kind:"pdf",b64,size} | {kind:"text",text}
  let conversation = []; // [{role, content}]
  let lastSentKey = null; // conjunto de peças já anexado nesta conversa
  let busy = false;

  const panel = PjePanel.mount();

  // Estado da chave: mostra CTA de configuração quando ausente e reage a mudanças
  // (ex.: quando o usuário salva a chave pelo popup, sem recarregar a página).
  function refreshKey() {
    chrome.storage.local.get(["apiKey"], (v) => panel.setConfigured(!!v.apiKey));
  }
  refreshKey();
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === "local" && ch.apiKey) refreshKey();
  });
  panel.onConfigure(() => chrome.runtime.sendMessage({ type: "openOptions" }));

  panel.onReset(() => {
    if (busy) return; // não zera no meio de uma resposta
    conversation = [];
    lastSentKey = null;
    panel.clearMessages();
    refreshKey(); // re-renderiza CTA de chave se necessário
  });

  function refresh() {
    panel.setDocs(PJE.listarDocumentos());
  }
  refresh();

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

  // Baixa as peças com concorrência limitada (3 por vez), com progresso.
  async function baixarSelecionadas(ids) {
    let done = 0;
    const report = () =>
      panel.setStatus(`Baixando peças ${done}/${ids.length}…`);
    report();
    const queue = ids.slice();
    async function worker() {
      while (queue.length) {
        const id = queue.shift();
        if (!docsCache.has(id)) docsCache.set(id, await PJE.baixar(id));
        done++;
        report();
      }
    }
    await Promise.all([worker(), worker(), worker()]);
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
  function montarBlocos(ids) {
    const blocks = [];
    let totalB64 = 0;
    for (const id of ids) {
      const d = docsCache.get(id);
      if (d.kind === "pdf") {
        totalB64 += d.b64.length;
        blocks.push({
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data: d.b64 },
        });
      } else {
        blocks.push({
          type: "text",
          text: `[Documento ${id}]:\n` + d.text.slice(0, 60000),
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

  // Abre um canal com o worker e resolve quando o stream termina.
  function stream(messages, handlers) {
    return new Promise((resolve, reject) => {
      const port = chrome.runtime.connect({ name: "claude" });
      let finished = false;
      port.onMessage.addListener((m) => {
        if (m.type === "delta") handlers.onDelta(m.text);
        else if (m.type === "thinking") handlers.onThinking();
        else if (m.type === "trunc") handlers.onTrunc();
        else if (m.type === "done") {
          finished = true;
          port.disconnect();
          resolve();
        } else if (m.type === "error") {
          finished = true;
          port.disconnect();
          reject(new Error(m.error));
        }
      });
      port.onDisconnect.addListener(() => {
        if (!finished) reject(new Error("conexão com o serviço interrompida — tente de novo"));
      });
      port.postMessage({ type: "chat", payload: { system: SYSTEM_PROMPT, messages } });
    });
  }

  panel.onSend(async (text, selectedIds) => {
    if (busy) return;
    if (selectedIds.length === 0) {
      panel.setStatus("Marque ao menos uma peça na lista acima antes de perguntar.");
      return;
    }
    busy = true;
    panel.addMessage("user", text);
    panel.lockInput(true);
    panel.setStatus("");

    const key = selectedIds.slice().sort().join(",");
    const attach = key !== lastSentKey; // (re)anexa peças quando a seleção muda
    let assistantEl = null;
    let acc = "";
    let truncated = false;

    try {
      let userContent;
      if (attach) {
        await baixarSelecionadas(selectedIds);
        stripOldCacheControl();
        userContent = [...montarBlocos(selectedIds), { type: "text", text }];
      } else {
        userContent = text;
      }

      conversation.push({ role: "user", content: userContent });
      lastSentKey = key;

      panel.setStatus("Analisando…");
      assistantEl = panel.addMessage("assistant", "");
      await stream(conversation, {
        onDelta(delta) {
          if (!acc) panel.setStatus("");
          acc += delta;
          panel.updateAssistant(assistantEl, acc);
        },
        onThinking() {
          if (!acc) panel.setStatus("Raciocinando sobre as peças…");
        },
        onTrunc() {
          truncated = true;
        },
      });

      if (acc.trim()) {
        conversation.push({ role: "assistant", content: acc });
        panel.setStatus(
          truncated
            ? "A resposta atingiu o tamanho máximo — peça para continuar, se necessário."
            : ""
        );
      } else {
        // resposta vazia: não grava turno (evitaria content vazio no próximo request)
        panel.removeMessage(assistantEl);
        conversation.pop(); // remove o turno do usuário correspondente
        lastSentKey = null;
        panel.setStatus("O modelo não retornou texto. Tente novamente.");
      }
    } catch (e) {
      panel.setStatus("Erro: " + (e && e.message ? e.message : e));
      // remove a bolha vazia do assistente, se houver
      if (assistantEl && !acc) panel.removeMessage(assistantEl);
      // desfaz o turno do usuário para permitir nova tentativa
      if (conversation.length && conversation[conversation.length - 1].role === "user") {
        conversation.pop();
        lastSentKey = null;
      }
    } finally {
      busy = false;
      panel.lockInput(false);
    }
  });
})();
