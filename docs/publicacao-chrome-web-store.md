# Publicação na Chrome Web Store — guia passo a passo

Estado da extensão frente às políticas (avaliado em 21/07/2026, já contra as regras
novas que entram em vigor em **01/08/2026**): **apta a publicar**. Sem código remoto,
sem `eval`, sem ofuscação, sem servidor intermediário, permissões mínimas (`storage` +
3 hosts), propósito único claro e divulgação de envio de dados já presente na UI
(popup, opções, ajuda) com link para a [política de privacidade](../PRIVACY.md).

O único ponto que alonga a revisão é o host permission amplo `https://*.jus.br/*` —
esperado e justificável (ver texto pronto abaixo). Revisões com permissão ampla podem
levar de alguns dias a algumas semanas.

---

## 0. Pré-requisitos da conta

1. Acesse <https://chrome.google.com/webstore/devconsole> com a conta Google.
2. Se ainda não pagou, pague a **taxa única de US$ 5** de registro de desenvolvedor.
3. Na aba **Conta** (Account) do painel:
   - **Verifique o e-mail de contato** (campo "Contact email" — chega um link de
     confirmação; sem isso o envio fica bloqueado, causa comum de falha em tentativa
     anterior).
   - Ative a **verificação em duas etapas** na conta Google (obrigatória).
   - Preencha a declaração de **comerciante/não comerciante** (DSA): para extensão
     gratuita publicada por pessoa física, marque **"Não sou comerciante"**
     (non-trader).

## 1. Gerar o pacote

```powershell
pwsh ./empacotar.ps1
```

Gera `pje-ia-v<versão>.zip` na raiz (só `manifest.json`, `src/`, `icons/` — valida a
sintaxe dos scripts antes). É esse ZIP que sobe na loja.

## 2. Criar o item e enviar o pacote

Painel → **+ Novo item** → arraste o ZIP. Depois preencha as abas a seguir.

## 3. Aba "Detalhes do item" (Store listing)

- **Idioma**: Português (Brasil).
- **Título**: `PJe IA — Análise de Processos`
- **Resumo** (máx. 132 chars — é a descrição do manifest):
  > Painel de chat com IA (Claude ou Gemini) para analisar os autos do PJe de qualquer tribunal. Selecione as peças e converse.
- **Descrição** (colar):

  ```
  PJe IA adiciona um assistente de IA à tela de autos digitais do PJe (Processo
  Judicial Eletrônico) — em qualquer tribunal que use o sistema (TJs, TRFs, TRTs).

  Você marca as peças do processo, pergunta em linguagem natural e o modelo — Claude
  (Anthropic) ou Gemini (Google), à sua escolha — responde com base no conteúdo real
  dos documentos: resumos, linhas do tempo, partes, pedidos, provas, relatórios em
  .docx, tudo direto na página do processo.

  COMO FUNCIONA
  • Traga sua própria chave de API (Anthropic ou Google) — a extensão não tem servidor
    próprio: os documentos vão direto do seu navegador para a API do provedor que VOCÊ
    escolheu, autenticados pela SUA chave.
  • Nada é enviado sem ação sua: você seleciona as peças (checkboxes ou digitando @) e
    envia a pergunta. A resposta usa somente os documentos marcados.
  • Citações com número de página, busca de jurisprudência em fontes oficiais (STF,
    STJ, Planalto…), geração de relatório em Word, medidor de contexto e custo por
    resposta no rodapé.

  PRIVACIDADE
  • Sem telemetria, sem analytics, sem servidor do desenvolvedor.
  • Chaves e preferências ficam somente no armazenamento local do navegador.
  • Atenção: autos judiciais podem conter dados sigilosos — use conforme as normas do
    seu tribunal. Política de privacidade:
    https://github.com/marcosmarf27/pje-ia/blob/main/PRIVACY.md

  REQUISITOS
  • Acesso ao PJe (login no tribunal) e uma chave de API da Anthropic (console.anthropic.com)
    ou do Google (aistudio.google.com). O uso da API é pago pelo provedor — a página de
    ajuda da extensão mostra a tabela de preços e ensina a criar a chave.

  Código aberto (MIT): https://github.com/marcosmarf27/pje-ia
  Não afiliado ao CNJ, à Anthropic nem ao Google.
  ```

- **Categoria**: Ferramentas (Tools) — alternativa: Produtividade/Fluxo de trabalho.
- **Ícone da loja**: `icons/icon128.png` (já no ZIP; o painel pede upload separado do
  128×128 — usar o mesmo arquivo).
- **Screenshots** (1280×800): `docs/store/screenshot-1-painel-1280x800.png` e
  `docs/store/screenshot-2-mencao-1280x800.png`.
- **Tile promocional pequeno** (440×280, opcional mas recomendado):
  `docs/store/promo-tile-440x280.png`.
- **Site oficial / URL de suporte**: `https://github.com/marcosmarf27/pje-ia`
  (suporte: `https://github.com/marcosmarf27/pje-ia/issues`).

## 4. Aba "Práticas de privacidade" (Privacy practices) — a mais importante

- **Propósito único** (colar):
  > Permitir que o usuário analise, com o modelo de IA que ele próprio configurou (Claude ou Gemini), as peças que ele selecionar dos autos digitais abertos no PJe — chat, resumos, citações e relatórios sobre esses documentos.

- **Justificativa de `storage`**:
  > Guardar localmente as chaves de API fornecidas pelo usuário, o modelo escolhido e preferências de interface (chrome.storage.local), e caches temporários de sessão (chrome.storage.session). Nada é sincronizado nem enviado a servidores do desenvolvedor.

- **Justificativa dos host permissions** (campo único):
  > https://*.jus.br/* — o PJe (Processo Judicial Eletrônico, sistema oficial do Judiciário brasileiro) roda em dezenas de domínios distintos, um por tribunal (pje.tjce.jus.br, pje1g.trf5.jus.br, pje.trt7.jus.br…), todos sob o TLD restrito .jus.br, exclusivo de órgãos da Justiça. Não existe lista fixa de tribunais; o padrão amplo é necessário para a extensão funcionar em qualquer tribunal sem configuração. O content script só constrói interface quando detecta a tela de autos digitais do PJe (elemento #divTimeLine); em qualquer outra página .jus.br ele termina imediatamente sem tocar no DOM. O acesso é usado exclusivamente para listar e baixar, pela sessão já autenticada do próprio usuário, as peças processuais que ele marcar.
  > https://api.anthropic.com/* e https://generativelanguage.googleapis.com/* — chamadas diretas às APIs de IA (Anthropic e Google) feitas pelo service worker com a chave de API do próprio usuário; nenhum servidor intermediário.

- **Código remoto**: marcar **"Não, não uso código remoto"** (não há build, bundler,
  CDN nem scripts externos — todo o código está no pacote).

- **Uso de dados** (checkboxes de coleta): marcar
  - ☑ **Conteúdo do site** (Website content) — as peças processuais que o usuário
    seleciona e as mensagens do chat, transmitidas à API do provedor de IA escolhido
    por ele.
  - ☑ **Informações de autenticação** (Authentication information) — as chaves de API
    do próprio usuário, armazenadas localmente e enviadas apenas ao respectivo
    provedor para autenticar as chamadas.
  - Nenhuma das demais categorias (localização, histórico, atividade, saúde,
    financeiro, comunicações pessoais, PII) é coletada pela extensão.

- **Certificações** (as três, todas verdadeiras aqui): não vendo dados; uso/transfiro
  dados apenas para o propósito único; não uso dados para crédito ou empréstimos.

- **URL da política de privacidade**:
  `https://github.com/marcosmarf27/pje-ia/blob/main/PRIVACY.md`

## 5. Aba "Distribuição"

- **Visibilidade**: Pública (ou "Não listada" se quiser um soft-launch — instalável só
  por quem tem o link; dá para tornar pública depois sem nova revisão).
- **Países**: pode restringir ao Brasil (o público é 100% brasileiro) ou deixar todos.
- **Preço**: gratuito.

## 6. Enviar para revisão

Botão **Enviar para revisão**. Marque a opção de **publicação automática após
aprovação** ou publique manualmente depois. Prazos típicos: 1–3 dias; com permissão
ampla de host pode levar mais (revisão aprofundada — o painel avisa "may require an
in-depth review"). Acompanhe o status no painel e o e-mail de contato.

## 7. Se vier rejeição

Motivos prováveis e resposta:

- **"Permissão ampla demais"** → responder com a justificativa do item 4 (não há como
  enumerar os tribunais; TLD .jus.br é restrito ao Judiciário). Se o revisor insistir,
  alternativa técnica: migrar `*.jus.br` para `optional_host_permissions` com pedido
  em runtime — custa fricção ao usuário, implementar só se exigido.
- **"Metadados insuficientes/enganosos"** → conferir se a descrição bate com o que a
  extensão faz (bate) e se as screenshots mostram a extensão real (mostram).
- **"Divulgação de dados"** → apontar os avisos no popup/opções/ajuda + PRIVACY.md.

Cada reenvio reinicia a fila de revisão; responder pelo próprio painel (há campo de
apelação/observações do desenvolvedor).

## 8. Atualizações futuras

Cada nova versão: subir a `version` no `manifest.json` → `pwsh ./empacotar.ps1` →
painel → **Pacote** → **Enviar novo pacote** → reenviar para revisão (atualizações
costumam ser mais rápidas). As respostas das abas de privacidade ficam salvas — só
precisam mudar se as práticas de dados mudarem (e, pela política de 08/2026, mudanças
de prática exigem divulgação proativa aos usuários: atualizar PRIVACY.md + notas de
versão).
