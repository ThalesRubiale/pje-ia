# PJe IA — Extensão Chrome

Extensão Chrome (Manifest V3, JavaScript puro, **sem build step**) que adiciona um painel
de chat com Claude à tela de autos digitais do PJe 1º grau. O usuário seleciona peças do
processo e conversa sobre elas; os PDFs são enviados diretamente à API da Anthropic.

## Arquitetura

Content scripts injetados em `https://pje.tjce.jus.br/pje1grau/*`, nesta ordem
(cada um é um IIFE que expõe um global — não há imports entre content scripts):

| Arquivo | Global | Papel |
|---|---|---|
| `src/pje.js` | `PJE` | Acesso ao PJe: lista peças da timeline (`#divTimeLine`), baixa cada uma pelo endpoint REST autenticado por cookie de sessão. |
| `src/panel.js` | `PjePanel` | Toda a UI (chat, seletor de peças, chips, popup `@`, card de progresso), isolada em **Shadow DOM**. CSS carregado de `src/panel.css` via `web_accessible_resources`. |
| `src/content.js` | — | Orquestração: downloads com concorrência 3, cache por peça, montagem dos blocos da API, conversa multi-turno, streaming via `Port`. |

O worker (`src/background.js` + `src/claude.js`, ES modules) guarda a chave da API e faz o
streaming SSE — **a chave nunca chega ao contexto da página**. Dois canais content↔worker:

- **Port** `chrome.runtime.connect({name:"claude"})` para os turnos (streaming). Tipos
  content→worker: `chat` e `gerarDoc`; worker→content: `delta`, `thinking`, `citation`,
  `tool`, `file`, `trunc`, `done {content, stopReason}`, `error`.
- **`chrome.runtime.sendMessage`** (request/response) para `caps` (capacidades do modelo),
  `upload` (Files API) e `countTokens` (pré-voo gratuito).

## Fluxo de um turno (protocolo v2)

`claude.js` acumula os **blocos completos** da resposta a partir do SSE (padrão dos SDKs:
`content_block_start/delta/stop`, incluindo `signature_delta` do thinking, `citations_delta`
e `input_json_delta`) e emite `{kind:"final", content, stopReason, containerId}`.
`background.js` resolve sozinho as continuações de **`pause_turn`** (reenvia
`messages + [{role:"assistant", content: parcial}]`, reutilizando `container.id` quando há
skills; máx. 8 iterações) — o content script enxerga um único turno lógico.

`MODEL_CAPS` em `background.js` governa por modelo: `contextTokens`, `maxPages` (600 nos
modelos de 1M; 100 no Haiku), versões de `web_search`/`web_fetch` (variantes `_20260209`
no Sonnet 5/Opus 4.8; básicas no Fable/Haiku), `thinking` (adaptive+summarized; omitido no
Haiku) e `effort` (não suportado no Haiku).

## Invariantes importantes

- **Assistant no histórico é SEMPRE array de blocos** (`response.content` completo), nunca
  string: a API exige thinking assinado intacto e os blocos de ferramenta/citações nos
  turnos seguintes. Em fallback (sem blocos), texto puro com os placeholders de citação
  removidos. **Citações são saneadas antes de ir ao histórico** (`sanearCitacoes` em
  `content.js`): a resposta traz campos que o request rejeita (ex.: `file_id` em
  `page_location` → 400 "Extra inputs are not permitted"); cada citação é reduzida à
  whitelist de campos do seu tipo.
- **Dois tipos de request, nunca misturados**: *chat/busca* (documentos + citações +
  web tools quando o toggle "Jurisprudência" está ligado — e, uma vez usadas na
  conversa, as web tools seguem declaradas nos turnos seguintes mesmo com o toggle
  desligado (`buscaNaConversa`): trocar o conjunto de tools invalidaria o cache de
  prefixo e arriscaria rejeição do histórico com blocos de ferramenta) e *gerar
  documento* (skill
  `docx` + `code_execution_20260521` + betas `code-execution-2025-08-25`/
  `skills-2025-10-02`/`files-api-2025-04-14` — o `container` com skills exige a beta de
  code execution junto com a de skills).
  As versões `_20260209` dos web tools já embutem execução de código — **nunca** declare
  `code_execution` junto delas.
- **Peças vão por `file_id` (Files API)**: upload único pelo worker com cache em
  `chrome.storage.session` (chave `idProcesso:idPeca:tamanho`); beta
  `files-api-2025-04-14` em todos os requests de chat. Base64 inline é só fallback de
  upload (aí vale o teto `MAX_TOTAL_B64_CHARS` de 24 MB).
- **Guardas de processo grande**: contagem de páginas por heurística no binário do PDF
  (`pje.js`) bloqueia acima de `MODEL_CAPS.maxPages` ANTES do envio; `count_tokens`
  (gratuito) estima o contexto e bloqueia acima de 90% da janela. Tratar também
  `stop_reason: model_context_window_exceeded`.
- **Citações**: `citations:{enabled:true}` em TODOS os blocos document (regra da API:
  tudo-ou-nada); peças HTML viram document com source text (citáveis por
  `char_location`). No stream, `citations_delta` gera marcadores por **placeholder PUA**
  (`\uE000<n>\uE001` — sempre como escapes ASCII no código, nunca o caractere cru) que
  atravessam o escape-first do `renderMd` e viram `<sup>` só DEPOIS do escape. PDFs
  escaneados sem camada de texto não são citáveis (degradação graciosa).

- **Fonte de verdade da seleção de peças**: os checkboxes de `.doclist` em `panel.js`.
  Chips da barra de contexto, contador `(x/y no contexto)`, popup `@` e mensagens são
  *projeções* desse estado — nunca guarde seleção em outro lugar.
- **Download do PJe é stateful**: o endpoint REST só libera peças já "abertas" na sessão
  JSF. Em 404 **ou corpo vazio com HTTP 200**, `pje.js` simula o clique na timeline (A4J)
  e faz poll com HEAD até liberar. As ativações são **serializadas** (`activationChain`) —
  o JSF não tolera dois submits simultâneos na mesma view. Cada download loga
  `[PJe IA] peça …` no console da página (F12) para diagnóstico.
- **Peças de encaminhamento são normais no PJe**: petições cujo conteúdo integral é algo
  como `<p>Em Anexo</p>` (o teor real está nos anexos "Documento de Comprovação"
  protocolados junto). Não é falha de download — o system prompt instrui o modelo a
  explicar isso e sugerir marcar os anexos.
- **Anexo incremental de peças** (`pecasNaConversa`): cada peça entra no histórico UMA
  única vez; a cada turno só o DELTA (peças ainda não enviadas) é anexado. Reanexar
  tudo a cada mudança de seleção duplicava páginas/tokens no request (o histórico é
  imutável) e estourava os limites já no segundo envio. Peça desmarcada permanece no
  histórico até "Nova conversa" (⟲) — as mensagens de erro orientam isso. As guardas
  de páginas/tokens contam o request INTEIRO (histórico + novas); o medidor de contexto
  (`panel.setContexto`) mostra tokens e páginas acumulados vs. limites do modelo.
- **Prompt caching**: `montarBlocos()` marca o último bloco com
  `cache_control: {type: "ephemeral"}` e `stripOldCacheControl()` remove breakpoints
  antigos do histórico (a API aceita no máx. 4).
- **Limite de payload**: 24 MB de base64 (`MAX_TOTAL_B64_CHARS`) com folga sob o limite de
  32 MB da API. `montarBlocos()` lança erro amigável se exceder — por isso
  `panel.endPrep()` (confirmação "peças anexadas") só é chamado **depois** de montar os
  blocos.
- **Turnos desfeitos em erro**: em falha ou resposta vazia, `content.js` faz `pop()` do
  turno do usuário e remove as peças do turno de `pecasNaConversa`, para permitir nova
  tentativa limpa.
- **Keepalive do service worker (MV3)**: o Chrome mata o worker após ~30 s sem eventos
  de extensão — fatal na geração de .docx, cujo code execution roda no servidor com
  longos silêncios no SSE (sintoma: "conexão com o serviço interrompida"). Durante um
  turno, `background.js` chama `chrome.runtime.getPlatformInfo` a cada 20 s
  (`manterVivo`) e `content.js` manda `{type:"ping"}` pela porta; o handler do Port
  ignora tipos desconhecidos. Não remova nenhum dos dois lados.
- **Markdown seguro**: `renderMd()` em `panel.js` **escapa primeiro, formata depois**.
  Qualquer mudança ali precisa preservar essa ordem (a resposta do modelo pode conter
  conteúdo dos autos).
- **Blocos `document` levam `title`** (título da peça) para o modelo citar as peças pelo
  nome — exigência do system prompt.

## Popup de menção `@` (panel.js)

Detecção por regex do token `@busca` antes do caret (`findMentionToken`); busca ignora
acentos via `norm()` (NFD + remoção de diacríticos). Ao selecionar, o token é removido do
texto e o checkbox correspondente é alternado. Detalhes fáceis de quebrar:

- As linhas do popup usam `mousedown` + `preventDefault()` (não `click`) para agir antes
  do `blur` do textarea.
- `Enter`/`Tab` com popup aberto selecionam; só com popup fechado o `Enter` envia.
- `updateMention()` é chamado em `input`, `click`, `keyup` (setas/Home/End) e em
  `setDocs()` — todos os caminhos que movem o caret ou mudam a lista.
- Cap de `MENTION_MAX` itens com linha "… e mais N peças" quando excede.

## Geração de .docx (skill oficial)

Botão "📄 Gerar .docx" no painel, em dois cliques guiados: o 1º clique preenche o campo
com a instrução padrão (editável) e explica o próximo passo; o 2º clique dispara o
request `gerarDoc` com as peças selecionadas + a instrução do campo. O worker extrai o
`file_id` dos blocos
`bash_code_execution_tool_result` (fica com o **último** `.docx` gerado), baixa via Files
API e repassa os bytes pelo Port; o content script dispara o download com Blob + âncora
(sem permissão `downloads`). Custo: code execution tem franquia de 1.550 h/mês por
organização (US$ 0,05/h depois), além dos tokens.

## Desenvolvimento e teste

- Não há bundler. Valide sintaxe com `node --check src/*.js`. Testes de unidade fora do
  navegador no scratchpad da sessão: `renderMd` (escape-first + citações) roda com
  `eval` do `panel.js`; o acumulador SSE de `claude.js` roda com `fetch` fake devolvendo
  um `ReadableStream` de eventos simulados (chat com citação, `pause_turn`, docx).
- **Testar a UI sem PJe**: criar um HTML que stub `window.chrome`
  (`runtime.getURL`, `storage.local.get`, `runtime.connect`) e carregue `src/panel.js`,
  servido por HTTP local (fetch do CSS falha em `file://`). Chamar `PjePanel.mount()`,
  `setConfigured(true)`, `setDocs([...])` com peças fictícias. As APIs `startPrep` /
  `setPrepState` / `endPrep` / `addMessage` permitem simular todo o fluxo visual.
- Para testar no PJe de verdade: recarregar a extensão em `chrome://extensions` e
  recarregar a aba do processo (o content script tem guard `window.__pjeIaLoaded`).

## Categorias de peças (destaque visual)

`CATEGORIAS` em `panel.js` classifica cada título por regex **sobre o texto normalizado
sem acentos** (`norm()`): decisões (dourado), audiências (verde), petições (azul),
provas (violeta), outros (neutro). A primeira regra que casar vence — cuidado com
sobreposições ("ata notarial" é prova, tratada com lookahead negativo na regra de
audiências). As cores vivem em variáveis `--cat-*` no `panel.css` e aparecem na lista
lateral (dot + peso da fonte), nos chips e no popup `@`; a legenda só é exibida no modo
expandido.

## Convenções

- Comentários e strings de UI em português do Brasil (com acentuação correta).
- Identidade visual: azul-marinho `#14243d`, dourado `#c49e60`, papel `#fbf9f4`,
  títulos em Georgia serif. Variáveis CSS no topo de `panel.css` (`.wrap`).
- Modelos da API: manter os IDs do `popup.html`/`options.html` alinhados aos aliases
  atuais da Anthropic (`claude-sonnet-5` é o default em `background.js`) e a tabela
  `MODEL_CAPS` sincronizada com os docs (limites, versões de tools, thinking/effort).
- Config no `chrome.storage.local`: `apiKey`, `model`, `effort` (baixo/médio/alto —
  `output_config.effort`; omitido nos modelos sem suporte).
- Alternar o toggle de busca ou trocar de modelo invalida o cache de prompt daquele ponto
  em diante (comportamento aceito). Arquivos enviados à Files API persistem na conta
  (100 GB por organização) — "limpar uploads" é melhoria futura registrada.
