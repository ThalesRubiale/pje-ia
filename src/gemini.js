// Cliente da API do Google Gemini (Interactions API), irmão de claude.js.
// Emite o MESMO vocabulário de eventos que streamClaude — o background.js
// consome os dois sem saber qual provedor está por trás:
//   {kind:"text", text}          — delta de texto da resposta
//   {kind:"thinking", text}      — delta do resumo de raciocínio
//   {kind:"citation", citation}  — citação (annotations url_citation → formato
//                                  web_search_result_location que a UI já trata)
//   {kind:"tool", name, input}   — o servidor executou google_search
//   {kind:"trunc"}               — resposta cortada pelo teto de saída
//   {kind:"final", content, stopReason, containerId, usage} — fim do request
//
// FORMATOS DA INTERACTIONS API (extraídos da documentação oficial via skill
// gemini-api-dev — ai.google.dev/gemini-api/docs/*.md.txt, 2026-07):
//  - Request: POST {v1beta}/interactions, headers x-goog-api-key +
//    Api-Revision: 2026-05-20 (fixa o schema novo, com "steps").
//    Body: {model, system_instruction, input, store:false, stream:true,
//    tools?, generation_config:{thinking_level}}. PROIBIDO: temperature/
//    top_p/top_k e terminar o input com turno do modelo (prefill) → 400.
//    TETO DE SAÍDA: o limite dos modelos é 65.536 tokens e NÃO enviamos
//    campo nenhum — omitido, o modelo gera até o teto (máximo possível).
//    A Interactions API não documenta um campo de max output (só
//    thinking_level/temperature no generation_config); NUNCA repassar o
//    req.max_tokens do caminho Anthropic (32000): cortaria o teto pela
//    metade, e um nome de campo chutado daria 400 em todo request.
//  - input (modo STATELESS, o nosso): array com turnos
//    {type:"user_input", content:[{type:"text",text} | {type:"document",
//    uri|data, mime_type}]} e, para o histórico do modelo, os próprios STEPS
//    recebidos na resposta, VERBATIM: {type:"model_output", content:[...]},
//    {type:"thought", summary:[...], signature}, {type:"google_search_call"},
//    {type:"google_search_result"}… Blocos thought carregam assinatura
//    criptografada e DEVEM voltar intactos (regra igual à da Anthropic).
//  - Streaming (SSE, "data: {json}" terminando em "data: [DONE]"):
//    event_type = interaction.created | interaction.status_update |
//    step.start {index, step} | step.delta {index, delta} | step.stop {index} |
//    interaction.completed {interaction}. Deltas: {type:"text", text},
//    {type:"thought_summary", content:{type:"text",text}},
//    {type:"thought_signature", signature}.
//  - usage (em interaction.usage): total_tokens, total_input_tokens (INCLUI os
//    cacheados), total_output_tokens, total_thought_tokens, total_cached_tokens.
//  - Annotations: dentro de model_output.content[].annotations —
//    {type:"url_citation", url, title, start_index, end_index}.
//  - File API: upload resumable em /upload/v1beta/files (headers
//    X-Goog-Upload-*), resposta {file:{name, uri, state, expirationTime}};
//    arquivos EXPIRAM EM 48 H; PDF ≤ 50 MB / 1000 páginas (258 tokens/pág.).
//  - countTokens: POST /v1beta/models/{model}:countTokens
//    {contents:[{role:"user"|"model", parts:[{text}|{file_data}|{inline_data}]}]}
//    → {totalTokens}.

const API = "https://generativelanguage.googleapis.com/v1beta";
const API_UPLOAD = "https://generativelanguage.googleapis.com/upload/v1beta";
// Margem de 1 h sob as 48 h oficiais: um upload "quase vencido" nunca entra
// num request que chegaria à API depois de expirado.
const UPLOAD_TTL_MS = 47 * 60 * 60 * 1000;

function headersGemini(apiKey) {
  return {
    "content-type": "application/json",
    "x-goog-api-key": apiKey,
    "Api-Revision": "2026-05-20",
  };
}

// ---------------------------------------------------------------------------
// Tradução do histórico interno (blocos estilo Anthropic, o formato canônico
// da extensão) para o input stateless da Interactions API. Regras:
//  - document file/base64 → item {type:"document"} precedido de um item de
//    texto "[Peça anexada: título]" (o document do Gemini não tem `title`, e
//    o system prompt exige citar as peças pelo nome);
//  - document text → item de texto com o título como cabeçalho;
//  - blocos do assistant: {type:"text"} viram model_output; {type:
//    "x-gemini-item", raw} é o step ORIGINAL do Gemini (thought assinado,
//    chamadas de busca) e volta VERBATIM — nunca tocar no raw.
// Campos internos/proprietários (cache_control, citations, __pecaId) nunca
// são copiados: os itens são construídos do zero.
// ---------------------------------------------------------------------------
function traduzirHistorico(messages) {
  const input = [];
  for (const turn of messages || []) {
    if (turn.role === "user") {
      const content = [];
      const blocos =
        typeof turn.content === "string"
          ? [{ type: "text", text: turn.content }]
          : turn.content || [];
      for (const b of blocos) {
        if (!b) continue;
        if (b.type === "document") {
          const t = b.title || "peça do processo";
          const src = b.source || {};
          if (src.type === "file") {
            content.push({ type: "text", text: "[Peça anexada: " + t + "]" });
            content.push({
              type: "document",
              uri: src.file_id,
              mime_type: "application/pdf",
            });
          } else if (src.type === "base64") {
            content.push({ type: "text", text: "[Peça anexada: " + t + "]" });
            content.push({
              type: "document",
              data: src.data,
              mime_type: src.media_type || "application/pdf",
            });
          } else if (src.type === "text") {
            content.push({
              type: "text",
              text: "=== Peça: " + t + " ===\n" + (src.data || ""),
            });
          }
        } else if (b.type === "text") {
          content.push({ type: "text", text: b.text || "" });
        }
        // outros tipos em turno de usuário não existem no fluxo da extensão
      }
      if (content.length) input.push({ type: "user_input", content });
    } else {
      // turno do assistant: agrupa textos em model_output; steps originais
      // do Gemini (x-gemini-item) entram verbatim, na ordem em que vieram
      let textos = [];
      const flush = () => {
        if (textos.length) {
          input.push({ type: "model_output", content: textos });
          textos = [];
        }
      };
      const blocos =
        typeof turn.content === "string"
          ? [{ type: "text", text: turn.content }]
          : turn.content || [];
      for (const b of blocos) {
        if (!b) continue;
        if (b.type === "x-gemini-item" && b.raw) {
          flush();
          input.push(b.raw);
        } else if (b.type === "text") {
          textos.push({ type: "text", text: b.text || "" });
        }
        // blocos de outro provedor (thinking/tool da Anthropic) não chegam
        // aqui: trocar de provedor no meio da conversa é bloqueado na UI
      }
      flush();
    }
  }
  // A API devolve 400 se o request terminar com turno do modelo (prefill
  // proibido). No fluxo normal o último turno é sempre do usuário — falhar
  // alto aqui é melhor que um 400 críptico.
  const ultimo = input[input.length - 1];
  if (ultimo && ultimo.type !== "user_input") {
    throw new Error(
      "o histórico termina em um turno do modelo — a API do Gemini não aceita esse formato"
    );
  }
  return input;
}

// req: {apiKey, model, system, messages, tools?, thinkingLevel?}
// Campos do caminho Anthropic (betas, container, thinking, output_config,
// max_tokens) são simplesmente ignorados — em especial max_tokens: sem teto
// declarado, a saída vai até o limite do modelo (65.536 tokens; ver o
// cabeçalho do arquivo antes de "melhorar" isso).
export async function* streamGemini(req) {
  const body = {
    model: req.model,
    system_instruction: req.system,
    input: traduzirHistorico(req.messages),
    store: false,
    stream: true,
  };
  if (req.tools && req.tools.length) body.tools = req.tools;
  if (req.thinkingLevel) {
    body.generation_config = { thinking_level: req.thinkingLevel };
  }

  const resp = await fetch(API + "/interactions", {
    method: "POST",
    headers: headersGemini(req.apiKey),
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const err = new Error(await friendlyHttpErrorGemini(resp));
    err.status = resp.status;
    // transitórios: o chamador re-tenta o MESMO request com backoff
    err.retryable = resp.status === 429 || resp.status >= 500;
    throw err;
  }

  // Acumula os STEPS do turno (indexados por ev.index). interaction.completed
  // pode trazer os steps completos — quando traz, eles são a versão oficial.
  const steps = [];
  let interacaoFinal = null;

  for await (const ev of sseEvents(resp)) {
    const tipo = ev.event_type || "";
    if (tipo === "step.start") {
      const s = structuredClone(ev.step || {});
      steps[ev.index] = s;
      if (s.type === "google_search_call") {
        const q = s.arguments && s.arguments.queries && s.arguments.queries[0];
        yield { kind: "tool", name: "web_search", input: { query: q } };
      }
    } else if (tipo === "step.delta") {
      const s = steps[ev.index] || (steps[ev.index] = { type: "model_output" });
      const d = ev.delta || {};
      if (d.type === "text") {
        // anexa ao último item de texto do model_output (ou cria o primeiro)
        if (!Array.isArray(s.content)) s.content = [];
        let alvo = s.content[s.content.length - 1];
        if (!alvo || alvo.type !== "text") {
          alvo = { type: "text", text: "" };
          s.content.push(alvo);
        }
        alvo.text = (alvo.text || "") + (d.text || "");
        yield { kind: "text", text: d.text || "" };
      } else if (d.type === "thought_summary") {
        const t = (d.content && d.content.text) || "";
        if (!Array.isArray(s.summary)) s.summary = [];
        let alvo = s.summary[s.summary.length - 1];
        if (!alvo || alvo.type !== "text") {
          alvo = { type: "text", text: "" };
          s.summary.push(alvo);
        }
        alvo.text = (alvo.text || "") + t;
        if (s.type === "model_output") s.type = "thought";
        yield { kind: "thinking", text: t };
      } else if (d.type === "thought_signature") {
        // assinatura criptografada: precisa voltar INTACTA no reenvio
        s.signature = (s.signature || "") + (d.signature || "");
      }
      // deltas desconhecidos: ignorados (o interaction.completed traz a
      // versão oficial dos steps quando o schema evolui)
    } else if (tipo === "interaction.completed") {
      interacaoFinal = ev.interaction || null;
    } else if (tipo === "error" || ev.error) {
      const m =
        (ev.error && (ev.error.message || ev.error.status)) ||
        "erro no stream da API do Gemini";
      const err = new Error(String(m));
      err.retryable = /unavailable|internal|overloaded|resource_exhausted/i.test(
        String(m)
      );
      throw err;
    }
  }

  // Stream encerrado SEM o interaction.completed: conexão caiu de forma
  // "limpa" no meio do turno (proxy, rede) — a resposta parcial não pode
  // passar por completa. Erro re-tentável: o executarTurno re-tenta o mesmo
  // request com backoff (o prefixo está no implicit cache, custa pouco).
  if (!interacaoFinal) {
    const err = new Error(
      "o stream da API do Gemini terminou sem o evento de conclusão — tente de novo"
    );
    err.retryable = true;
    throw err;
  }

  // Steps oficiais: os do interaction.completed quando presentes; senão os
  // acumulados dos deltas.
  const oficiais =
    interacaoFinal && Array.isArray(interacaoFinal.steps) && interacaoFinal.steps.length
      ? interacaoFinal.steps
      : steps.filter(Boolean);

  // Annotations (url_citation) chegam nos itens de texto do model_output —
  // normalizadas para o formato web que infoCitacao/chaveCitacao já tratam.
  for (const s of oficiais) {
    if (!s || s.type !== "model_output" || !Array.isArray(s.content)) continue;
    for (const item of s.content) {
      for (const a of (item && item.annotations) || []) {
        if (a && a.type === "url_citation") {
          yield {
            kind: "citation",
            citation: {
              type: "web_search_result_location",
              url: a.url,
              title: a.title,
            },
          };
        }
      }
    }
  }

  const status = (interacaoFinal && interacaoFinal.status) || "completed";
  if (/^(failed|error|cancelled)$/i.test(status)) {
    // turno encerrado com falha do lado do servidor: melhor lançar (e deixar
    // o retry do background agir) do que devolver um "end_turn" mudo
    const err = new Error("a API do Gemini encerrou o turno com falha — tente de novo");
    err.retryable = true;
    throw err;
  }
  if (/max[_ ]?tokens|length/i.test(status)) yield { kind: "trunc" };

  yield {
    kind: "final",
    content: stepsParaBlocos(oficiais),
    stopReason: mapStopReason(status),
    containerId: null,
    usage: normalizarUsage(interacaoFinal && interacaoFinal.usage),
  };
}

// Converte os steps do Gemini nos blocos que a extensão guarda no histórico:
//  - model_output só de texto e SEM assinatura → blocos {type:"text"} comuns
//    (compatíveis com sanearCitacoes, transcript e o fallback do content.js);
//  - qualquer outro step (thought assinado, buscas, texto com assinatura) →
//    {type:"x-gemini-item", raw} — wrapper OPACO que prepararEnvio e
//    sanearCitacoes não tocam; traduzirHistorico devolve o raw verbatim.
function stepsParaBlocos(oficiais) {
  const blocos = [];
  for (const s of oficiais) {
    if (!s) continue;
    const soTexto =
      s.type === "model_output" &&
      !s.signature &&
      Array.isArray(s.content) &&
      s.content.every(
        (it) => it && it.type === "text" && !it.signature && !it.thought_signature
      );
    if (soTexto) {
      for (const it of s.content) {
        // annotations ficam só na UI (mesma regra das citations da Anthropic)
        blocos.push({ type: "text", text: it.text || "" });
      }
    } else {
      blocos.push({ type: "x-gemini-item", raw: s });
    }
  }
  return blocos;
}

// status da Interaction → vocabulário de stop_reason que a extensão já trata.
// O Gemini não tem pause_turn: o loop de continuação do background sai
// naturalmente na primeira iteração.
function mapStopReason(status) {
  const s = String(status || "").toLowerCase();
  if (/max[_ ]?tokens|length/.test(s)) return "max_tokens";
  if (/safety|recitation|blocklist|prohibited|spii/.test(s)) return "refusal";
  return "end_turn";
}

// usage do Gemini → as 4 categorias estilo Anthropic que custo/gauge/tooltip
// já consomem. total_input_tokens INCLUI os cacheados; o implicit caching não
// tem "gravação" cobrada à parte (cache_creation = 0).
function normalizarUsage(u) {
  if (!u) return null;
  const cached = u.total_cached_tokens || 0;
  const input = Math.max(0, (u.total_input_tokens || 0) - cached);
  const output = (u.total_output_tokens || 0) + (u.total_thought_tokens || 0);
  return {
    input_tokens: input,
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: 0,
    output_tokens: output,
  };
}

// Itera os eventos SSE ("data: {...}") do corpo da resposta (mesmo parser do
// claude.js — o framing SSE é idêntico, inclusive o [DONE] final).
async function* sseEvents(resp) {
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
      yield ev;
    }
  }
}

// ---------------------------------------------------------------------------
// Upload à File API do Gemini (protocolo resumable em duas etapas) + poll até
// o arquivo ficar ACTIVE. Devolve {fileUri, expiraEm} — o chamador guarda a
// expiração no cache (48 h oficiais; usamos 47 h de margem).
// ---------------------------------------------------------------------------
export async function uploadFileGemini({ apiKey, filename, b64, mime }) {
  const mimeType = mime || "application/pdf";
  const blob = await (await fetch("data:" + mimeType + ";base64," + b64)).blob();

  // etapa 1: "start" — devolve a URL de upload no header x-goog-upload-url
  const start = await fetch(API_UPLOAD + "/files", {
    method: "POST",
    headers: {
      "x-goog-api-key": apiKey,
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(blob.size),
      "X-Goog-Upload-Header-Content-Type": mimeType,
      "content-type": "application/json",
    },
    body: JSON.stringify({ file: { display_name: filename || "documento.pdf" } }),
  });
  if (!start.ok) throw new Error(await friendlyHttpErrorGemini(start));
  const uploadUrl = start.headers.get("x-goog-upload-url");
  if (!uploadUrl) throw new Error("a File API do Google não retornou a URL de upload");

  // etapa 2: bytes + finalize
  const up = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "X-Goog-Upload-Offset": "0",
      "X-Goog-Upload-Command": "upload, finalize",
    },
    body: blob,
  });
  if (!up.ok) throw new Error(await friendlyHttpErrorGemini(up));
  const j = await up.json();
  const file = (j && j.file) || {};
  if (!file.uri) throw new Error("a File API do Google não retornou o URI do arquivo");

  // PDFs ficam em PROCESSING por alguns segundos antes de poderem ser usados
  let estado = file.state;
  const fim = Date.now() + 60000;
  while (estado === "PROCESSING" && Date.now() < fim) {
    await new Promise((r) => setTimeout(r, 2000));
    const meta = await fetch(API + "/" + file.name, {
      headers: { "x-goog-api-key": apiKey },
    });
    if (!meta.ok) break;
    const m = await meta.json();
    estado = m && m.state;
  }
  if (estado === "FAILED") {
    throw new Error("o processamento do arquivo falhou na File API do Google — tente de novo");
  }
  if (estado === "PROCESSING") {
    throw new Error("a File API do Google demorou demais para processar o arquivo — tente de novo");
  }

  return { fileUri: file.uri, expiraEm: Date.now() + UPLOAD_TTL_MS };
}

// ---------------------------------------------------------------------------
// Contagem de tokens (endpoint countTokens do generateContent — a Interactions
// API não tem um próprio). Aproximação honesta: documents viram file_data/
// inline_data (contagem real de páginas), textos viram parts de texto e steps
// opacos (x-gemini-item) são serializados como texto. A guarda de 90% da
// janela absorve a imprecisão; o usage pós-turno corrige de graça.
// ---------------------------------------------------------------------------
export async function countTokensGemini({ apiKey, model, system, messages }) {
  const contents = [];
  if (system) contents.push({ role: "user", parts: [{ text: system }] });
  for (const turn of messages || []) {
    const role = turn.role === "assistant" ? "model" : "user";
    const parts = [];
    const blocos =
      typeof turn.content === "string"
        ? [{ type: "text", text: turn.content }]
        : turn.content || [];
    for (const b of blocos) {
      if (!b) continue;
      if (b.type === "text") {
        parts.push({ text: b.text || "" });
      } else if (b.type === "document") {
        const src = b.source || {};
        if (src.type === "file") {
          parts.push({
            file_data: { file_uri: src.file_id, mime_type: "application/pdf" },
          });
        } else if (src.type === "base64") {
          parts.push({
            inline_data: {
              mime_type: src.media_type || "application/pdf",
              data: src.data,
            },
          });
        } else if (src.type === "text") {
          parts.push({ text: src.data || "" });
        }
      } else if (b.type === "x-gemini-item") {
        // aproximação: o conteúdo textual do step (ou o JSON, limitado)
        parts.push({ text: textoDeStep(b.raw) });
      }
    }
    if (parts.length) contents.push({ role, parts });
  }
  const resp = await fetch(API + "/models/" + model + ":countTokens", {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({ contents }),
  });
  if (!resp.ok) throw new Error(await friendlyHttpErrorGemini(resp));
  const j = await resp.json();
  return (j && (j.totalTokens || j.total_tokens)) || 0;
}

function textoDeStep(s) {
  if (!s) return "";
  const pedacos = [];
  for (const it of s.content || s.summary || []) {
    if (it && typeof it.text === "string") pedacos.push(it.text);
  }
  if (pedacos.length) return pedacos.join("\n");
  try {
    return JSON.stringify(s).slice(0, 4000);
  } catch {
    return "";
  }
}

// Converte respostas de erro da API do Google em mensagens claras em português.
export async function friendlyHttpErrorGemini(resp) {
  let apiMsg = "";
  try {
    const j = await resp.json();
    apiMsg = (j && j.error && j.error.message) || "";
  } catch {
    /* corpo não-JSON */
  }
  const low = apiMsg.toLowerCase();

  if (resp.status === 400 && (low.includes("api key not valid") || low.includes("api_key_invalid"))) {
    return "Chave da API do Google inválida. Confira a chave Gemini nas configurações da extensão.";
  }
  if (resp.status === 401 || resp.status === 403) {
    return "Chave da API do Google sem permissão para este recurso. Confira a chave em aistudio.google.com.";
  }
  if (
    resp.status === 400 &&
    (low.includes("token count") || low.includes("exceeds the maximum") || low.includes("context"))
  ) {
    return "As peças selecionadas excedem o contexto do modelo. Desmarque algumas peças ou inicie uma nova conversa.";
  }
  if (resp.status === 429) {
    return (
      "Limite de requisições da API do Google atingido (no plano gratuito a cota é pequena). " +
      "Aguarde alguns instantes e tente de novo."
    );
  }
  if (resp.status === 413 || (resp.status === 400 && low.includes("too large"))) {
    return "As peças selecionadas são grandes demais para uma única análise. Desmarque algumas e tente novamente.";
  }
  if (resp.status === 503 || resp.status >= 500) {
    return "A API do Google está sobrecarregada no momento. Tente novamente em instantes.";
  }
  return "Erro da API do Google (" + resp.status + ")" + (apiMsg ? ": " + apiMsg.slice(0, 240) : "");
}
