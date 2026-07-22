// Service worker: recebe pedidos do painel, lê a chave/modelo do storage
// (a página nunca vê a chave) e faz streaming da resposta do modelo.
// Também resolve sozinho as continuações de turno (stop_reason "pause_turn",
// quando o loop de ferramentas do servidor atinge o teto de iterações) — o
// content script enxerga um único turno lógico.
// Dois provedores: Anthropic (claude.js) e Google Gemini (gemini.js). O
// provedor é inferido do id do modelo (prefixo "gemini-") e os dois clientes
// emitem o MESMO vocabulário de eventos — o resto deste arquivo não distingue.
import {
  streamClaude,
  uploadFile,
  downloadFile,
  fileMetadata,
  countTokens,
  MAX_TOKENS_CHAT,
} from "./claude.js";
import {
  streamGemini,
  uploadFileGemini,
  countTokensGemini,
} from "./gemini.js";

// Capacidades por modelo. Governam limites de páginas/contexto, as versões das
// ferramentas web, a configuração de thinking/effort aceita por cada um e o
// preço (US$ por 1M de tokens, tabela pública da Anthropic — Sonnet 5 usa o
// preço de tabela, não o promocional, para nunca subestimar). Cache de prompt:
// gravação ≈ 1,25× o preço de input (TTL 5 min); leitura ≈ 0,1×.
const MODEL_CAPS = {
  "claude-sonnet-5": {
    provider: "anthropic",
    contextTokens: 1000000,
    maxPages: 600,
    webSearch: "web_search_20260209",
    webFetch: "web_fetch_20260209",
    thinking: { type: "adaptive", display: "summarized" },
    effort: true,
    preco: { in: 3, out: 15 },
  },
  "claude-opus-4-8": {
    provider: "anthropic",
    contextTokens: 1000000,
    maxPages: 600,
    webSearch: "web_search_20260209",
    webFetch: "web_fetch_20260209",
    thinking: { type: "adaptive", display: "summarized" },
    effort: true,
    preco: { in: 5, out: 25 },
  },
  "claude-fable-5": {
    provider: "anthropic",
    contextTokens: 1000000,
    maxPages: 600,
    // fable não está na lista das variantes _20260209 — usa as básicas
    webSearch: "web_search_20250305",
    webFetch: "web_fetch_20250910",
    thinking: { type: "adaptive", display: "summarized" },
    effort: true,
    preco: { in: 10, out: 50 },
  },
  "claude-haiku-4-5": {
    provider: "anthropic",
    contextTokens: 200000,
    maxPages: 100,
    webSearch: "web_search_20250305",
    webFetch: "web_fetch_20250910",
    thinking: null, // geração anterior: sem adaptive; omitimos thinking
    effort: false, // effort retorna erro no Haiku 4.5
    preco: { in: 1, out: 5 },
  },
  // Modelos Google Gemini (Interactions API). docx:false → o botão "Gerar
  // .docx" fica desabilitado (o code execution do Gemini não devolve
  // arquivos); citacoesNativas:false → o system prompt pede citações
  // TEXTUAIS ("conforme a Contestação, fl. 12") e a UI mostra a nota.
  // tokensPagina: 258 (documentação oficial) — a estimativa local usa este
  // valor no lugar dos 2000/pág. da Anthropic. preco.cacheRead: tabela
  // oficial (implicit caching; não há cobrança de gravação).
  "gemini-3.6-flash": {
    provider: "gemini",
    contextTokens: 1000000,
    maxPages: 1000,
    googleSearch: true,
    docx: false,
    citacoesNativas: false,
    thinking: null,
    effort: true, // vira generation_config.thinking_level
    tokensPagina: 258,
    preco: { in: 1.5, out: 7.5, cacheRead: 0.15 },
  },
  "gemini-3.5-flash-lite": {
    provider: "gemini",
    contextTokens: 1000000,
    maxPages: 1000,
    googleSearch: true,
    docx: false,
    citacoesNativas: false,
    thinking: null,
    effort: true,
    tokensPagina: 258,
    preco: { in: 0.3, out: 2.5, cacheRead: 0.03 },
  },
};

// Provedor do modelo (prefixo do id — a lista de modelos vive nos <option>
// do popup/options; ids desconhecidos caem no default Anthropic via capsDe).
function providerDe(model) {
  return model && model.startsWith("gemini-") ? "gemini" : "anthropic";
}

// effort salvo (high/medium/low) → thinking_level do Gemini. A escala do
// Gemini tem os mesmos três nomes (há também "minimal", que não usamos: o
// "low" já é a opção econômica equivalente ao effort baixo da Anthropic).
const EFFORT_PARA_THINKING_LEVEL = { high: "high", medium: "medium", low: "low" };

// Custo estimado (US$) de um usage acumulado, pela tabela de preços do modelo.
// A API não devolve valor monetário — só as contagens de tokens por categoria.
function custoUsdDe(usage, preco) {
  if (!usage || !preco) return null;
  // cache read: preço próprio quando a tabela do modelo define (Gemini);
  // senão a regra da Anthropic (0,1× o input) — resultado idêntico ao atual.
  const cacheRead = preco.cacheRead != null ? preco.cacheRead : preco.in * 0.1;
  return (
    ((usage.input_tokens || 0) * preco.in +
      (usage.cache_creation_input_tokens || 0) * preco.in * 1.25 +
      (usage.cache_read_input_tokens || 0) * cacheRead +
      (usage.output_tokens || 0) * preco.out) /
    1e6
  );
}
function capsDe(model) {
  return MODEL_CAPS[model] || MODEL_CAPS["claude-haiku-4-5"];
}

// Default: Haiku 4.5 — mais rápido e ~3× mais barato que o Sonnet 5; todas as
// features funcionam nele (inclusive a skill docx via code_execution_20260521,
// confirmado nos docs). O custo funcional é a janela menor (200 mil tokens,
// 100 págs. de PDF) — para autos volumosos o usuário troca para o Sonnet 5
// (1M) no popup/opções; o MODEL_CAPS e o medidor cuidam dos limites.
function getCfg() {
  return new Promise((resolve) =>
    chrome.storage.local.get(["apiKey", "geminiApiKey", "model", "effort"], (v) =>
      resolve({
        apiKey: v.apiKey,
        geminiApiKey: v.geminiApiKey,
        model: v.model || "claude-haiku-4-5",
        effort: v.effort || "high",
      })
    )
  );
}

// Chave do provedor do modelo atual, com erro claro quando falta.
function chaveDe(cfg, provider) {
  if (provider === "gemini") {
    if (!cfg.geminiApiKey) {
      throw new Error(
        "configure sua chave da API do Google Gemini nas opções da extensão (o modelo escolhido é Gemini)"
      );
    }
    return cfg.geminiApiKey;
  }
  if (!cfg.apiKey) {
    throw new Error("configure sua ANTHROPIC_API_KEY nas opções da extensão");
  }
  return cfg.apiKey;
}

// Cache (sessão do navegador) de uploads na Files API: peça já enviada não
// sobe de novo, mesmo que a aba recarregue. Chave: idProcesso:idPeca:tamanho.
function sessGet(key) {
  return new Promise((resolve) =>
    chrome.storage.session.get([key], (v) => resolve(v[key]))
  );
}
function sessSet(key, value) {
  return new Promise((resolve) => chrome.storage.session.set({ [key]: value }, resolve));
}

// Mensagens avulsas (request/response): configuração, capacidades do modelo,
// upload de peças e contagem de tokens. O canal de streaming continua no Port.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg) return;

  if (msg.type === "openOptions") {
    chrome.runtime.openOptionsPage();
    return;
  }

  if (msg.type === "caps") {
    // model + effort vão junto: o painel mostra o que está ATIVO (o usuário
    // não deveria precisar confiar às cegas no que salvou nas opções)
    getCfg().then(({ model, effort }) =>
      sendResponse({ model, effort, caps: capsDe(model) })
    );
    return true; // resposta assíncrona
  }

  if (msg.type === "upload") {
    (async () => {
      try {
        const cfg = await getCfg();
        const provider = providerDe(cfg.model);
        const apiKey = chaveDe(cfg, provider);
        if (provider === "gemini") {
          // namespace próprio ("gfile:") e VALIDAÇÃO de expiração na leitura:
          // a File API do Google apaga os arquivos após 48 h — um URI vencido
          // no cache derrubaria o request com erro críptico.
          const key = msg.payload.cacheKey ? "gfile:" + msg.payload.cacheKey : null;
          if (key) {
            const cached = await sessGet(key);
            if (cached && cached.uri && cached.exp > Date.now()) {
              return sendResponse({ fileId: cached.uri, provider });
            }
          }
          const r = await uploadFileGemini({
            apiKey,
            filename: msg.payload.filename,
            b64: msg.payload.b64,
            mime: msg.payload.mime,
          });
          if (key) await sessSet(key, { uri: r.fileUri, exp: r.expiraEm });
          return sendResponse({ fileId: r.fileUri, provider });
        }
        const key = msg.payload.cacheKey ? "file:" + msg.payload.cacheKey : null;
        if (key) {
          const cached = await sessGet(key);
          if (cached) return sendResponse({ fileId: cached, provider });
        }
        const fileId = await uploadFile({
          apiKey,
          filename: msg.payload.filename,
          b64: msg.payload.b64,
          mime: msg.payload.mime,
        });
        if (key) await sessSet(key, fileId);
        sendResponse({ fileId, provider });
      } catch (e) {
        sendResponse({ error: String((e && e.message) || e) });
      }
    })();
    return true;
  }

  if (msg.type === "countTokens") {
    (async () => {
      try {
        const cfg = await getCfg();
        const provider = providerDe(cfg.model);
        const apiKey = chaveDe(cfg, provider);
        const tokens =
          provider === "gemini"
            ? await countTokensGemini({
                apiKey,
                model: cfg.model,
                system: msg.payload.system,
                messages: msg.payload.messages,
              })
            : await countTokens({
                apiKey,
                model: cfg.model,
                system: msg.payload.system,
                messages: msg.payload.messages,
                tools: msg.payload.tools,
                betas: msg.payload.betas,
              });
        sendResponse({ tokens, contextTokens: capsDe(cfg.model).contextTokens });
      } catch (e) {
        sendResponse({ error: String((e && e.message) || e) });
      }
    })();
    return true;
  }

  // Guarda o markdown de um mapa mental para a página src/mapa.html abrir.
  // Vai por storage.session (some ao fechar o navegador, não polui o local) e
  // é o worker quem grava: a página é contexto confiável e lê direto, e o
  // content script não precisa de acesso à área session.
  if (msg.type === "guardarMapa") {
    (async () => {
      try {
        const id = String(Date.now()) + "-" + Math.random().toString(36).slice(2, 8);
        await sessSet("mapa:" + id, {
          md: msg.payload.md,
          titulo: msg.payload.titulo,
          processo: msg.payload.processo,
          ts: Date.now(),
        });
        await podarMapas();
        sendResponse({ id });
      } catch (e) {
        sendResponse({ error: String((e && e.message) || e) });
      }
    })();
    return true;
  }
});

// Mantém no máximo MAX_MAPAS mapas na sessão (cada um é o markdown inteiro de
// um processo; sem poda, uma tarde de uso encheria a cota de 10 MB).
const MAX_MAPAS = 5;
function podarMapas() {
  return new Promise((resolve) =>
    chrome.storage.session.get(null, (tudo) => {
      const chaves = Object.keys(tudo || {})
        .filter((k) => k.startsWith("mapa:"))
        .sort((a, b) => (tudo[b].ts || 0) - (tudo[a].ts || 0));
      const sobrando = chaves.slice(MAX_MAPAS);
      if (!sobrando.length) return resolve();
      chrome.storage.session.remove(sobrando, resolve);
    })
  );
}

// Remove o campo citations dos blocos de texto antes de reenviar conteúdo do
// assistant à API: citações reenviadas são rejeitadas (400 "Extra inputs" /
// "Invalid citation indices"). Bloco de texto sem citações é sempre válido.
function stripCitacoes(blocks) {
  return blocks.map((b) => {
    if (!b || b.type !== "text" || b.citations == null) return b;
    const c = Object.assign({}, b);
    delete c.citations;
    return c;
  });
}

// Erros transitórios que valem nova tentativa do MESMO request: 429/529/5xx
// (flag retryable vinda do claude.js) e quedas de rede no meio do SSE — o
// docx tem longos silêncios de code execution, janela típica dessas quedas.
function erroRetryavel(e) {
  if (e && e.retryable) return true;
  const msg = String((e && e.message) || e).toLowerCase();
  return (
    e instanceof TypeError ||
    msg.includes("failed to fetch") ||
    msg.includes("network") ||
    msg.includes("err_")
  );
}
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

// Executa um turno completo (com continuações pause_turn), emitindo o progresso
// pelo Port. Retorna {content, stopReason}; lança erro em falha ou recusa.
// payload: {system, messages, tools?, container?, betas?, maxTokens?, maxIter?}
async function executarTurno(port, payload) {
  const cfg = await getCfg();
  const { model, effort } = cfg;
  const caps = capsDe(model);
  const provider = caps.provider || "anthropic";
  const apiKey = chaveDe(cfg, provider);
  // Os dois clientes emitem o mesmo vocabulário de eventos — daqui em diante
  // o turno não distingue provedor (o Gemini nunca emite pause_turn, então o
  // loop de continuações sai naturalmente na primeira iteração).
  const streamFn = provider === "gemini" ? streamGemini : streamClaude;

  const baseReq = {
    apiKey,
    model,
    system: payload.system,
    max_tokens: payload.maxTokens || MAX_TOKENS_CHAT,
  };
  if (payload.tools && payload.tools.length) baseReq.tools = payload.tools;
  if (provider === "gemini") {
    // Gemini: sem betas/thinking/output_config; o effort vira thinking_level.
    if (caps.effort) {
      baseReq.thinkingLevel = EFFORT_PARA_THINKING_LEVEL[effort] || "medium";
    }
  } else {
    if (payload.betas && payload.betas.length) baseReq.betas = payload.betas;
    if (caps.thinking) baseReq.thinking = caps.thinking;
    if (caps.effort) baseReq.output_config = { effort };
  }

  let messages = payload.messages;
  let container = payload.container || null;
  let contentAcumulado = [];
  let stopReason = null;
  // Um turno lógico pode ser vários requests físicos (continuações pause_turn):
  // o CUSTO correto é a SOMA dos usage de todas as iterações; já o TAMANHO do
  // contexto é o usage do ÚLTIMO request (cada iteração reenvia o prefixo —
  // somar duplicaria a contagem).
  const usoTotal = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
  let usoUltimo = null;

  // Um turno lógico = até maxIter requests físicos (continuações pause_turn);
  // o docx pede um teto maior (modelos menores precisam de mais rodadas de
  // code execution). Cada request físico ganha até 2 RE-TENTATIVAS em erro
  // transitório (429/529/5xx/queda de rede): "iter" marca o checkpoint na UI
  // e "retry" manda descartar o parcial da tentativa que falhou — sem isso o
  // texto duplicaria na tela.
  const maxIter = payload.maxIter || 8;
  for (let iteracao = 0; iteracao < maxIter; iteracao++) {
    const req = Object.assign({}, baseReq, { messages });
    if (container) req.container = container;
    postar(port, { type: "iter" });

    let final = null;
    for (let tentativa = 0; ; tentativa++) {
      try {
        for await (const ev of streamFn(req)) {
          if (ev.kind === "text") postar(port, { type: "delta", text: ev.text });
          else if (ev.kind === "thinking")
            postar(port, { type: "thinking", text: ev.text });
          else if (ev.kind === "citation")
            postar(port, { type: "citation", citation: ev.citation });
          else if (ev.kind === "tool")
            postar(port, { type: "tool", name: ev.name, input: ev.input });
          else if (ev.kind === "trunc") postar(port, { type: "trunc" });
          else if (ev.kind === "final") final = ev;
        }
        break; // request físico concluído
      } catch (e) {
        if (tentativa >= 2 || !erroRetryavel(e)) throw e;
        console.debug("[PJe IA] erro transitório, re-tentando:", String(e && e.message));
        postar(port, { type: "retry" });
        // 429 merece espera maior (janela de rate limit); demais, backoff curto
        await espera(e && e.status === 429 ? 10000 : tentativa === 0 ? 2000 : 6000);
      }
    }
    if (!final) throw new Error("o stream terminou sem resposta completa — tente de novo");

    contentAcumulado = contentAcumulado.concat(final.content);
    stopReason = final.stopReason;
    if (final.usage) {
      for (const k of Object.keys(usoTotal)) usoTotal[k] += final.usage[k] || 0;
      usoUltimo = final.usage;
    }
    // geração com skills: preserva o container para as continuações
    if (final.containerId && payload.container) {
      container = Object.assign({}, payload.container, { id: final.containerId });
    }
    if (stopReason !== "pause_turn") break;
    // o servidor pausou o loop de ferramentas: reenvia com o turno parcial.
    // As citações NÃO voltam no reenvio: a API rejeita citações em conteúdo
    // de assistant (campos extras e revalidação de índices) — mesma regra do
    // histórico multi-turno no content script.
    messages = payload.messages.concat([
      { role: "assistant", content: stripCitacoes(contentAcumulado) },
    ]);
  }

  if (stopReason === "refusal") {
    throw new Error("o modelo recusou responder este conteúdo");
  }
  return {
    content: contentAcumulado,
    stopReason,
    usage: usoTotal,
    usageReq: usoUltimo,
    custoUsd: custoUsdDe(usoTotal, caps.preco),
  };
}

// Extrai os file_ids de arquivos gerados pela execução de código
// (blocos bash_code_execution_tool_result → bash_code_execution_result →
//  saídas com file_id), na ordem em que aparecem.
function extrairFileIds(blocks) {
  const ids = [];
  for (const b of blocks || []) {
    if (b && b.type === "bash_code_execution_tool_result" && b.content) {
      const outs = (b.content && b.content.content) || [];
      for (const o of outs) if (o && o.file_id) ids.push(o.file_id);
    }
  }
  return ids;
}

// Geração de documento (skill docx): executa o turno, localiza o .docx entre os
// arquivos gerados no container e o baixa pela Files API, repassando os bytes
// ao content script para download no navegador.
async function gerarDocumento(port, payload) {
  {
    // Defesa em profundidade: a UI desabilita o botão nos modelos Gemini
    // (o code execution do Gemini não devolve arquivos — limitação da API).
    const { model } = await getCfg();
    if (providerDe(model) === "gemini") {
      throw new Error(
        "a geração de .docx não está disponível nos modelos Gemini — troque para um modelo Claude nas opções da extensão"
      );
    }
  }
  const r = await executarTurno(port, payload);
  const { apiKey } = await getCfg();
  const ids = extrairFileIds(r.content);

  let alvo = null;
  let nome = "documento.docx";
  for (const id of ids) {
    try {
      const meta = await fileMetadata({ apiKey, fileId: id });
      if (meta && meta.filename && /\.docx$/i.test(meta.filename)) {
        alvo = id; // fica com o ÚLTIMO .docx gerado (versão final)
        nome = meta.filename;
      }
    } catch {
      /* metadados indisponíveis: segue para o próximo */
    }
  }
  if (!alvo && ids.length) alvo = ids[ids.length - 1];

  if (alvo) {
    const f = await downloadFile({ apiKey, fileId: alvo });
    postar(port, { type: "file", filename: nome, b64: f.b64, mime: f.mime });
  } else if (r.stopReason === "pause_turn") {
    // o teto de iterações estourou ANTES de o arquivo sair — antes isso
    // retornava em silêncio e o usuário via só "não gerou o arquivo"
    throw new Error(
      "a geração precisou de mais etapas do que o limite do servidor e não concluiu o arquivo — " +
        "tente de novo (instruções mais simples ajudam; modelos menores, como o Haiku, às vezes precisam de nova tentativa)"
    );
  } else if (r.stopReason === "max_tokens") {
    throw new Error(
      "a resposta atingiu o limite de tokens antes de concluir o arquivo — tente de novo com uma instrução mais direta"
    );
  }
  return r;
}

// Impede o Chrome de matar o service worker durante um turno longo: o MV3
// encerra o worker após ~30 s sem eventos de extensão, e a geração de .docx
// tem longos silêncios (code execution roda no servidor sem emitir SSE).
// Chamar uma API de extensão de tempos em tempos reseta o timer de ociosidade.
function manterVivo() {
  // 15 s (não 20): margem maior sobre o teto de ~30 s de ociosidade — o
  // ping do content script pode atrasar com a aba em segundo plano
  // (throttling de timers de página), então o worker não depende só dele.
  const t = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 15000);
  return () => clearInterval(t);
}

// postMessage tolerante: a aba pode ter fechado a porta no meio do stream.
function postar(port, m) {
  try {
    port.postMessage(m);
  } catch {
    /* porta já desconectada */
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "claude") return;

  port.onMessage.addListener((msg) => {
    // "ping" (e qualquer tipo desconhecido) só serve de keepalive: o próprio
    // recebimento da mensagem reseta o timer de ociosidade do worker.
    if (!msg || (msg.type !== "chat" && msg.type !== "gerarDoc")) return;

    const parar = manterVivo();
    (msg.type === "chat"
      ? executarTurno(port, msg.payload)
      : gerarDocumento(port, msg.payload)
    )
      .then((r) =>
        postar(port, {
          type: "done",
          content: r.content,
          stopReason: r.stopReason,
          usage: r.usage || null,
          usageReq: r.usageReq || null,
          custoUsd: r.custoUsd == null ? null : r.custoUsd,
        })
      )
      .catch((e) =>
        postar(port, { type: "error", error: String((e && e.message) || e) })
      )
      .finally(parar);
  });
});
