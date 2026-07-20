// Service worker: recebe pedidos do painel, lê a chave/modelo do storage
// (a página nunca vê a chave) e faz streaming da resposta do Claude.
// Também resolve sozinho as continuações de turno (stop_reason "pause_turn",
// quando o loop de ferramentas do servidor atinge o teto de iterações) — o
// content script enxerga um único turno lógico.
import {
  streamClaude,
  uploadFile,
  downloadFile,
  fileMetadata,
  countTokens,
  MAX_TOKENS_CHAT,
} from "./claude.js";

// Capacidades por modelo. Governam limites de páginas/contexto, as versões das
// ferramentas web, a configuração de thinking/effort aceita por cada um e o
// preço (US$ por 1M de tokens, tabela pública da Anthropic — Sonnet 5 usa o
// preço de tabela, não o promocional, para nunca subestimar). Cache de prompt:
// gravação ≈ 1,25× o preço de input (TTL 5 min); leitura ≈ 0,1×.
const MODEL_CAPS = {
  "claude-sonnet-5": {
    contextTokens: 1000000,
    maxPages: 600,
    webSearch: "web_search_20260209",
    webFetch: "web_fetch_20260209",
    thinking: { type: "adaptive", display: "summarized" },
    effort: true,
    preco: { in: 3, out: 15 },
  },
  "claude-opus-4-8": {
    contextTokens: 1000000,
    maxPages: 600,
    webSearch: "web_search_20260209",
    webFetch: "web_fetch_20260209",
    thinking: { type: "adaptive", display: "summarized" },
    effort: true,
    preco: { in: 5, out: 25 },
  },
  "claude-fable-5": {
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
    contextTokens: 200000,
    maxPages: 100,
    webSearch: "web_search_20250305",
    webFetch: "web_fetch_20250910",
    thinking: null, // geração anterior: sem adaptive; omitimos thinking
    effort: false, // effort retorna erro no Haiku 4.5
    preco: { in: 1, out: 5 },
  },
};

// Custo estimado (US$) de um usage acumulado, pela tabela de preços do modelo.
// A API não devolve valor monetário — só as contagens de tokens por categoria.
function custoUsdDe(usage, preco) {
  if (!usage || !preco) return null;
  return (
    ((usage.input_tokens || 0) * preco.in +
      (usage.cache_creation_input_tokens || 0) * preco.in * 1.25 +
      (usage.cache_read_input_tokens || 0) * preco.in * 0.1 +
      (usage.output_tokens || 0) * preco.out) /
    1e6
  );
}
function capsDe(model) {
  return MODEL_CAPS[model] || MODEL_CAPS["claude-sonnet-5"];
}

function getCfg() {
  return new Promise((resolve) =>
    chrome.storage.local.get(["apiKey", "model", "effort"], (v) =>
      resolve({
        apiKey: v.apiKey,
        model: v.model || "claude-sonnet-5",
        effort: v.effort || "high",
      })
    )
  );
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
    getCfg().then(({ model }) => sendResponse({ model, caps: capsDe(model) }));
    return true; // resposta assíncrona
  }

  if (msg.type === "upload") {
    (async () => {
      try {
        const { apiKey } = await getCfg();
        if (!apiKey) throw new Error("configure sua ANTHROPIC_API_KEY nas opções da extensão");
        const key = msg.payload.cacheKey ? "file:" + msg.payload.cacheKey : null;
        if (key) {
          const cached = await sessGet(key);
          if (cached) return sendResponse({ fileId: cached });
        }
        const fileId = await uploadFile({
          apiKey,
          filename: msg.payload.filename,
          b64: msg.payload.b64,
          mime: msg.payload.mime,
        });
        if (key) await sessSet(key, fileId);
        sendResponse({ fileId });
      } catch (e) {
        sendResponse({ error: String((e && e.message) || e) });
      }
    })();
    return true;
  }

  if (msg.type === "countTokens") {
    (async () => {
      try {
        const { apiKey, model } = await getCfg();
        if (!apiKey) throw new Error("configure sua ANTHROPIC_API_KEY nas opções da extensão");
        const tokens = await countTokens({
          apiKey,
          model,
          system: msg.payload.system,
          messages: msg.payload.messages,
          tools: msg.payload.tools,
          betas: msg.payload.betas,
        });
        sendResponse({ tokens, contextTokens: capsDe(model).contextTokens });
      } catch (e) {
        sendResponse({ error: String((e && e.message) || e) });
      }
    })();
    return true;
  }
});

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

// Executa um turno completo (com continuações pause_turn), emitindo o progresso
// pelo Port. Retorna {content, stopReason}; lança erro em falha ou recusa.
// payload: {system, messages, tools?, container?, betas?, maxTokens?}
async function executarTurno(port, payload) {
  const { apiKey, model, effort } = await getCfg();
  if (!apiKey) {
    throw new Error("configure sua ANTHROPIC_API_KEY nas opções da extensão");
  }
  const caps = capsDe(model);

  const baseReq = {
    apiKey,
    model,
    system: payload.system,
    max_tokens: payload.maxTokens || MAX_TOKENS_CHAT,
  };
  if (payload.tools && payload.tools.length) baseReq.tools = payload.tools;
  if (payload.betas && payload.betas.length) baseReq.betas = payload.betas;
  if (caps.thinking) baseReq.thinking = caps.thinking;
  if (caps.effort) baseReq.output_config = { effort };

  let messages = payload.messages;
  let container = payload.container || null;
  let contentAcumulado = [];
  let stopReason = null;
  // Um turno lógico pode ser vários requests físicos (continuações pause_turn):
  // o custo correto é a SOMA dos usage de todas as iterações.
  const usoTotal = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };

  for (let tentativa = 0; tentativa < 8; tentativa++) {
    const req = Object.assign({}, baseReq, { messages });
    if (container) req.container = container;

    let final = null;
    for await (const ev of streamClaude(req)) {
      if (ev.kind === "text") port.postMessage({ type: "delta", text: ev.text });
      else if (ev.kind === "thinking")
        port.postMessage({ type: "thinking", text: ev.text });
      else if (ev.kind === "citation")
        port.postMessage({ type: "citation", citation: ev.citation });
      else if (ev.kind === "tool")
        port.postMessage({ type: "tool", name: ev.name, input: ev.input });
      else if (ev.kind === "trunc") port.postMessage({ type: "trunc" });
      else if (ev.kind === "final") final = ev;
    }
    if (!final) throw new Error("o stream terminou sem resposta completa — tente de novo");

    contentAcumulado = contentAcumulado.concat(final.content);
    stopReason = final.stopReason;
    if (final.usage) {
      for (const k of Object.keys(usoTotal)) usoTotal[k] += final.usage[k] || 0;
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
    port.postMessage({ type: "file", filename: nome, b64: f.b64, mime: f.mime });
  }
  return r;
}

// Impede o Chrome de matar o service worker durante um turno longo: o MV3
// encerra o worker após ~30 s sem eventos de extensão, e a geração de .docx
// tem longos silêncios (code execution roda no servidor sem emitir SSE).
// Chamar uma API de extensão de tempos em tempos reseta o timer de ociosidade.
function manterVivo() {
  const t = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);
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
          custoUsd: r.custoUsd == null ? null : r.custoUsd,
        })
      )
      .catch((e) =>
        postar(port, { type: "error", error: String((e && e.message) || e) })
      )
      .finally(parar);
  });
});
