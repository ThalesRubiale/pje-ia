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
// ferramentas web e a configuração de thinking/effort aceita por cada um.
const MODEL_CAPS = {
  "claude-sonnet-5": {
    contextTokens: 1000000,
    maxPages: 600,
    webSearch: "web_search_20260209",
    webFetch: "web_fetch_20260209",
    thinking: { type: "adaptive", display: "summarized" },
    effort: true,
  },
  "claude-opus-4-8": {
    contextTokens: 1000000,
    maxPages: 600,
    webSearch: "web_search_20260209",
    webFetch: "web_fetch_20260209",
    thinking: { type: "adaptive", display: "summarized" },
    effort: true,
  },
  "claude-fable-5": {
    contextTokens: 1000000,
    maxPages: 600,
    // fable não está na lista das variantes _20260209 — usa as básicas
    webSearch: "web_search_20250305",
    webFetch: "web_fetch_20250910",
    thinking: { type: "adaptive", display: "summarized" },
    effort: true,
  },
  "claude-haiku-4-5": {
    contextTokens: 200000,
    maxPages: 100,
    webSearch: "web_search_20250305",
    webFetch: "web_fetch_20250910",
    thinking: null, // geração anterior: sem adaptive; omitimos thinking
    effort: false, // effort retorna erro no Haiku 4.5
  },
};
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
      else if (ev.kind === "tool") port.postMessage({ type: "tool", name: ev.name });
      else if (ev.kind === "trunc") port.postMessage({ type: "trunc" });
      else if (ev.kind === "final") final = ev;
    }
    if (!final) throw new Error("o stream terminou sem resposta completa — tente de novo");

    contentAcumulado = contentAcumulado.concat(final.content);
    stopReason = final.stopReason;
    // geração com skills: preserva o container para as continuações
    if (final.containerId && payload.container) {
      container = Object.assign({}, payload.container, { id: final.containerId });
    }
    if (stopReason !== "pause_turn") break;
    // o servidor pausou o loop de ferramentas: reenvia com o turno parcial
    messages = payload.messages.concat([
      { role: "assistant", content: contentAcumulado },
    ]);
  }

  if (stopReason === "refusal") {
    throw new Error("o modelo recusou responder este conteúdo");
  }
  return { content: contentAcumulado, stopReason };
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

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "claude") return;

  port.onMessage.addListener((msg) => {
    if (!msg) return;
    const fluxo =
      msg.type === "chat"
        ? executarTurno(port, msg.payload)
        : msg.type === "gerarDoc"
          ? gerarDocumento(port, msg.payload)
          : null;
    if (!fluxo) return;
    fluxo
      .then((r) =>
        port.postMessage({ type: "done", content: r.content, stopReason: r.stopReason })
      )
      .catch((e) =>
        port.postMessage({ type: "error", error: String((e && e.message) || e) })
      );
  });
});
