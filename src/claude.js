// Cliente da API da Anthropic (chamada direta do navegador, via service worker).
// Faz streaming SSE e emite eventos estruturados:
//   {kind:"text", text}  — delta de texto da resposta
//   {kind:"thinking"}    — o modelo começou a raciocinar (status de UI)
//   {kind:"trunc"}       — resposta cortada por max_tokens
export async function* streamClaude({ apiKey, model, system, messages }) {
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      // Necessário para chamar a API direto do navegador.
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model,
      max_tokens: 16000,
      stream: true,
      system,
      messages,
    }),
  });

  if (!resp.ok) {
    throw new Error(await friendlyHttpError(resp));
  }

  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });

    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return;

      let ev;
      try {
        ev = JSON.parse(data);
      } catch {
        continue;
      }

      if (ev.type === "content_block_start" && ev.content_block) {
        if (ev.content_block.type === "thinking") yield { kind: "thinking" };
      } else if (
        ev.type === "content_block_delta" &&
        ev.delta &&
        ev.delta.type === "text_delta"
      ) {
        yield { kind: "text", text: ev.delta.text };
      } else if (ev.type === "message_delta" && ev.delta) {
        if (ev.delta.stop_reason === "refusal") {
          throw new Error("o modelo recusou responder este conteúdo");
        }
        if (ev.delta.stop_reason === "max_tokens") {
          yield { kind: "trunc" };
        }
      } else if (ev.type === "error") {
        throw new Error((ev.error && ev.error.message) || "erro no stream da API");
      }
    }
  }
}

// Converte respostas de erro da API em mensagens claras em português.
async function friendlyHttpError(resp) {
  let apiMsg = "";
  try {
    const j = await resp.json();
    apiMsg = (j && j.error && j.error.message) || "";
  } catch {
    /* corpo não-JSON */
  }
  const low = apiMsg.toLowerCase();

  if (resp.status === 401) {
    return "Chave de API inválida. Confira a chave nas configurações da extensão.";
  }
  if (resp.status === 400 && (low.includes("credit") || low.includes("billing"))) {
    return "Sua conta Anthropic está sem crédito. Adicione créditos em console.anthropic.com → Billing.";
  }
  if (resp.status === 429) {
    return "Limite de requisições atingido. Aguarde alguns instantes e tente de novo.";
  }
  if (resp.status === 413 || low.includes("too large") || low.includes("exceeds")) {
    return "As peças selecionadas são grandes demais para uma única análise. Desmarque algumas e tente novamente.";
  }
  if (resp.status === 529 || resp.status >= 500) {
    return "A API da Anthropic está sobrecarregada no momento. Tente novamente em instantes.";
  }
  return "Erro da API (" + resp.status + ")" + (apiMsg ? ": " + apiMsg.slice(0, 240) : "");
}
