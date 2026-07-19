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
streaming SSE — **a chave nunca chega ao contexto da página**. Comunicação content↔worker
por `chrome.runtime.connect({name: "claude"})`.

## Invariantes importantes

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
- **Prompt caching**: `montarBlocos()` marca o último bloco com
  `cache_control: {type: "ephemeral"}` e `stripOldCacheControl()` remove breakpoints
  antigos do histórico (a API aceita no máx. 4). Peças são (re)anexadas apenas quando a
  seleção muda (`lastSentKey`).
- **Limite de payload**: 24 MB de base64 (`MAX_TOTAL_B64_CHARS`) com folga sob o limite de
  32 MB da API. `montarBlocos()` lança erro amigável se exceder — por isso
  `panel.endPrep()` (confirmação "peças anexadas") só é chamado **depois** de montar os
  blocos.
- **Turnos desfeitos em erro**: em falha ou resposta vazia, `content.js` faz `pop()` do
  turno do usuário e zera `lastSentKey` para permitir nova tentativa limpa.
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

## Desenvolvimento e teste

- Não há bundler nem testes automatizados. Valide sintaxe com `node --check src/*.js`.
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
- Modelos da API: manter os IDs do `popup.html` alinhados aos aliases atuais da Anthropic
  (`claude-sonnet-5` é o default em `background.js`).
