# Bibliotecas de terceiros

Arquivos baixados dos pacotes oficiais e usados **sem qualquer modificação**, apenas na
página `src/mapa.html` (mapa mental). Não são carregados nas páginas do PJe.

| Arquivo | Pacote | Versão | Origem | Licença |
|---|---|---|---|---|
| `d3.min.js` | [d3](https://d3js.org) | 7.9.0 | `https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js` | ISC — © Mike Bostock |
| `markmap-view.js` | [markmap-view](https://markmap.js.org) | 0.18.12 | `https://cdn.jsdelivr.net/npm/markmap-view@0.18.12/dist/browser/index.js` | MIT — © Gerald Liu |

`markmap-view.js` é um bundle IIFE que publica `window.markmap` e **consome `d3` global** —
por isso a ordem dos `<script>` em `mapa.html` importa (d3 primeiro).

O pacote `markmap-lib` (transformador de Markdown) **não** é usado: ele arrasta `katex`,
`highlight.js`, `prismjs` e `markdown-it` (~311 KB) e tenta buscar assets em CDN, o que a CSP
de páginas de extensão bloqueia. A conversão Markdown → árvore de nós é feita por
`mdParaArvore()` em `src/mapa.js`.

Para atualizar, baixe novamente a mesma URL com a versão nova, rode `node --check` no arquivo
e atualize a tabela acima.
