<p align="center">
  <img src="docs/banner.png" alt="PJe IA — Análise de autos judiciais com Claude" width="100%">
</p>

<p align="center">
  <a href="LICENSE"><img alt="Licença MIT" src="https://img.shields.io/badge/licen%C3%A7a-MIT-c49e60?style=flat-square"></a>
  <img alt="Chrome Manifest V3" src="https://img.shields.io/badge/Chrome-Manifest%20V3-14243d?style=flat-square&logo=googlechrome&logoColor=white">
  <img alt="Claude API" src="https://img.shields.io/badge/IA-Claude%20(Anthropic)-c49e60?style=flat-square">
  <img alt="PJe 1º grau" src="https://img.shields.io/badge/PJe-1%C2%BA%20grau-14243d?style=flat-square">
</p>

**PJe IA** é uma extensão Chrome que adiciona um assistente de IA à tela de autos digitais
do **PJe (Processo Judicial Eletrônico)**. Você marca as peças do processo, pergunta em
linguagem natural e o **Claude** responde com base no conteúdo real dos documentos —
resumos, linhas do tempo, partes, pedidos, provas — direto na página do processo.

<p align="center">
  <img src="docs/painel.png" alt="Painel do assistente com seleção de peças e resposta em tabela" width="430">
</p>

## ✨ Recursos

- **Chat sobre os autos** — converse com o Claude sobre as peças selecionadas, com histórico multi-turno.
- **Seleção de peças** — checkboxes por documento; só o que você marcar é enviado.
- **Menção com `@`** — digite `@` no campo de pergunta para buscar e marcar peças sem sair do teclado: filtro que ignora acentos (`@peticao` acha "Petição Inicial"), navegação por `↑↓`, `Enter` marca/desmarca, `Esc` fecha.
- **Contexto sempre visível** — chips acima do campo mostram as peças marcadas (com `×` para remover), o contador indica `x/y no contexto`, e cada pergunta exibe quais peças foram anexadas naquele turno.
- **Progresso por peça** — ao preparar a análise, um card mostra o estado de cada peça (aguardando → baixando → pronta) com barra de progresso, e a resposta chega com indicador de digitação animado.
- **OCR nativo** — peças digitalizadas (imagem) são lidas pelo próprio Claude, sem OCR externo.
- **Respostas formatadas** — markdown completo: tabelas, listas, títulos e citações.
- **Citações pelo nome da peça** — cada PDF é enviado com o título da peça, para o modelo citar "na Contestação…" em vez de números de id.
- **Streaming** — a resposta aparece em tempo real, com indicador de raciocínio.
- **Modo expandido** — painel em tela cheia com duas colunas para leitura confortável.
- **Prompt caching** — os PDFs anexados são cacheados pela API (~90% mais barato nos turnos seguintes).
- **Erros amigáveis** — chave inválida, conta sem crédito, limites e sobrecarga explicados em português.

## 🚀 Instalação

> A extensão ainda não está na Chrome Web Store — instale em modo desenvolvedor:

1. Baixe o projeto (`Code → Download ZIP`) e extraia, ou `git clone` este repositório.
2. Abra `chrome://extensions` e ative o **Modo do desenvolvedor**.
3. Clique em **Carregar sem compactação** e selecione a pasta do projeto.
4. Clique no ícone **PJe IA** na barra do Chrome, cole sua chave da API da Anthropic e salve.
   - Não tem chave? O popup traz um **guia passo a passo** para criar a chave e adicionar crédito
     no [console.anthropic.com](https://console.anthropic.com).

## 📖 Como usar

1. Faça login no PJe e abra os **autos de um processo** (tela da linha do tempo de documentos).
2. Clique no botão **⚖️ Analisar com IA** no canto inferior direito da página.
3. Marque as peças que quer incluir na análise — pela lista, ou digitando **`@`** no próprio campo de pergunta (ex.: `@contestação`).
4. Pergunte — por exemplo:
   - *"Resuma o pedido da inicial e os argumentos da contestação"*
   - *"Monte uma tabela com a linha do tempo dos atos"*
   - *"Quais provas foram juntadas e o que cada uma demonstra?"*

**Atalhos:** `@` cita peças no campo · `Enter` envia · `Shift+Enter` quebra linha · com o popup `@` aberto: `↑↓` navega, `Enter`/`Tab` marca, `Esc` fecha · botão `⤢` expande o painel · `↺` inicia nova conversa.

## 🏗️ Arquitetura

```mermaid
flowchart LR
    subgraph Página do PJe
        A[content.js<br>orquestração] --> B[pje.js<br>timeline + download REST]
        A --> C[panel.js<br>chat em Shadow DOM]
    end
    A -- Port --> D[background.js<br>service worker]
    D --> E[claude.js<br>streaming SSE]
    E -- x-api-key --> F[(API Anthropic<br>Claude)]
    G[(chrome.storage.local<br>chave + modelo)] --> D
```

| Módulo | Papel |
|---|---|
| `src/pje.js` | Lista as peças na timeline e baixa cada uma pelo endpoint REST do PJe (sessão do usuário). Ativa peças "não abertas" automaticamente. |
| `src/panel.js` / `panel.css` | UI do chat em Shadow DOM (isolada do CSS do PJe): seletor de peças, menção `@`, chips de contexto, card de progresso e renderizador markdown próprio e seguro. |
| `src/content.js` | Orquestra: downloads paralelos, cache por peça, prompt caching, conversa multi-turno. |
| `src/background.js` + `claude.js` | Service worker que guarda a chave e chama a API da Anthropic com streaming. **A chave nunca é exposta à página.** |
| `src/popup.html` | Configuração em 1 clique no ícone da barra (chave, modelo, guia de primeiros passos). |

## 🔒 Privacidade e segurança

- A chave da API fica **somente** no `chrome.storage.local` do seu navegador (não sincroniza, não passa por servidores de terceiros).
- Os documentos marcados são enviados **diretamente à API da Anthropic** — nenhum outro serviço intermedia.
- A extensão só roda no domínio do PJe configurado e não coleta telemetria.

> ⚠️ **Aviso legal:** autos judiciais podem conter dados pessoais e sigilosos. O uso da
> extensão — e o envio de peças a um provedor de IA — é de responsabilidade do usuário,
> observadas as normas do tribunal, a LGPD e eventuais segredos de justiça. As respostas
> da IA são apoio à leitura, **não substituem** a análise jurídica humana.

## 🗺️ Roadmap

- [ ] Suporte a outros tribunais que usam PJe (TJs/TRFs/TRTs) via configuração de domínio
- [ ] Carregamento automático da timeline completa (peças fora da rolagem)
- [ ] Files API para processos muito volumosos
- [ ] Exportar a análise (copiar/DOCX)
- [ ] Publicação na Chrome Web Store

## 🤝 Contribuindo

Issues e PRs são bem-vindos! Para bugs, inclua o tribunal/versão do PJe e a mensagem de
erro do painel (F12 → Console também ajuda).

## 📄 Licença

[MIT](LICENSE) © marcosmarf27

---

<p align="center"><sub>Feito com ⚖️ para quem lê autos o dia inteiro. Não afiliado ao CNJ nem à Anthropic.</sub></p>
