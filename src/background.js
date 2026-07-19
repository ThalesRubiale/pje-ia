// Service worker: recebe pedidos do painel, lê a chave/modelo do storage
// (a página nunca vê a chave) e faz streaming da resposta do Claude.
import { streamClaude } from "./claude.js";

function getCfg() {
  return new Promise((resolve) =>
    chrome.storage.local.get(["apiKey", "model"], (v) =>
      resolve({ apiKey: v.apiKey, model: v.model || "claude-sonnet-5" })
    )
  );
}

// Abre a tela de configuração a partir do painel (content script não pode
// chamar openOptionsPage diretamente).
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "openOptions") chrome.runtime.openOptionsPage();
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "claude") return;

  port.onMessage.addListener(async (msg) => {
    if (!msg || msg.type !== "chat") return;

    const { apiKey, model } = await getCfg();
    if (!apiKey) {
      port.postMessage({
        type: "error",
        error: "configure sua ANTHROPIC_API_KEY nas opções da extensão",
      });
      return;
    }

    try {
      for await (const ev of streamClaude({
        apiKey,
        model,
        system: msg.payload.system,
        messages: msg.payload.messages,
      })) {
        if (ev.kind === "text") port.postMessage({ type: "delta", text: ev.text });
        else if (ev.kind === "thinking") port.postMessage({ type: "thinking" });
        else if (ev.kind === "trunc") port.postMessage({ type: "trunc" });
      }
      port.postMessage({ type: "done" });
    } catch (e) {
      port.postMessage({ type: "error", error: String((e && e.message) || e) });
    }
  });
});
