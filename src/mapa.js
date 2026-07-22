// Página do mapa mental: lê o markdown gerado pelo modelo (guardado pelo
// worker em chrome.storage.session) e o desenha com markmap.
//
// Por que esta página existe em vez de um overlay no painel: markmap-view
// precisa de d3 GLOBAL (~340 KB somados) e content scripts do manifest não
// podem ser ES modules — carregar isso em toda página *.jus.br seria caro, e
// import() dinâmico no content script fica à mercê da CSP do tribunal (a mesma
// que já barra o embed blob: do preview de PDF). Numa página chrome-extension://
// vale a CSP da extensão: os scripts locais sempre carregam.
(function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // Markdown mínimo — ESCAPA PRIMEIRO, formata depois.
  // Duplicado de propósito a partir de panel.js (que é um IIFE de content
  // script e não pode ser importado aqui). O conteúdo vem dos autos e é
  // injetado como HTML dentro do <foreignObject> de cada nó, então a ordem
  // escape → formata é obrigatória nos dois lugares.
  // ---------------------------------------------------------------------------
  function escapeHtml(s) {
    return String(s).replace(
      /[&<>"]/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
    );
  }

  function inlineMd(s) {
    let h = s;
    h = h.replace(/`([^`]+)`/g, "<code>$1</code>");
    h = h.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    h = h.replace(/==([^=]+)==/g, "<mark>$1</mark>");
    h = h.replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>");
    h = h.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (m, t, u) => {
      return '<a href="' + u + '" target="_blank" rel="noopener">' + t + "</a>";
    });
    return h;
  }

  // ---------------------------------------------------------------------------
  // Realces do vocabulário processual: folha, id da peça, data, valor e norma
  // viram pílulas coloridas. Rodam entre o escape e o inlineMd — o texto ainda
  // não tem tags nesse ponto, então nenhum atributo é corrompido.
  // ---------------------------------------------------------------------------
  function realces(s) {
    let h = s;
    // id do documento no PJe: "id 123456789" (o título de cada peça na
    // timeline começa por esse número — é como o usuário reencontra a peça)
    h = h.replace(/\bid\.?:?\s*(\d{5,})/gi, '<span class="mm-b mm-id">id $1</span>');
    // folhas: fl. 12 · fls. 18-40 · fls. 18/22
    h = h.replace(
      /\bfls?\.?\s*(\d+(?:\s*[-–\/aà]\s*\d+)?)/gi,
      (m, n) => '<span class="mm-b mm-fl">fl. ' + n.replace(/\s+/g, "") + "</span>"
    );
    h = h.replace(/\b(\d{2}\/\d{2}\/\d{2,4})\b/g, '<span class="mm-b mm-dt">$1</span>');
    h = h.replace(
      /R\$\s?\d[\d.]*(?:,\d{2})?/g,
      (m) => '<span class="mm-b mm-vl">' + m + "</span>"
    );
    h = h.replace(
      /\b(?:arts?\.\s*\d+[\wº°.\-\s§]{0,12}|s[úu]mula\s+(?:vinculante\s+)?\d+(?:\/[A-Z]{2,4})?)/gi,
      (m) => '<span class="mm-b mm-lei">' + m.trim() + "</span>"
    );
    return h;
  }

  // A refer\u00EAncia de origem \u2014 "(Contesta\u00E7\u00E3o, id 123461, fl. 61)" no fim do item \u2014
  // sai do meio da frase e vira uma etiqueta discreta em linha pr\u00F3pria: o
  // t\u00F3pico fica leg\u00EDvel e a proced\u00EAncia continua sempre \u00E0 vista (\u00E9 requisito do
  // mapa: toda afirma\u00E7\u00E3o aponta a pe\u00E7a, o id e a folha).
  function origemNoRodape(h) {
    return h.replace(/\s*\(([^()]*(?:mm-id|mm-fl)[^()]*)\)\s*$/, (m, dentro) => {
      const partes = dentro
        .replace(/^\s*[,;\u00B7]?\s*/, "")
        .replace(/\s*,\s*/g, " \u00B7 ")
        .trim();
      return '<span class="mm-src">' + partes + "</span>";
    });
  }

  const RE_COD_PLACEHOLDER = new RegExp("\uE010(\\d+)\uE011", "g");

  // escape → (realces fora de `código`) → inlineMd. Os trechos entre crases
  // saem de cena por placeholders na Área de Uso Privado enquanto os realces
  // rodam (mesma técnica dos marcadores de citação em panel.js), senão um
  // `art. 5º` escrito como código viraria pílula dentro do <code>.
  function conteudoNo(txt) {
    const esc = escapeHtml(String(txt || "").trim());
    const codigos = [];
    const semCodigo = esc.replace(/`[^`]+`/g, (m) => {
      codigos.push(m);
      return "\uE010" + (codigos.length - 1) + "\uE011";
    });
    const comRealces = realces(semCodigo).replace(
      RE_COD_PLACEHOLDER,
      (m, i) => codigos[Number(i)]
    );
    return inlineMd(origemNoRodape(comRealces));
  }

  // ---------------------------------------------------------------------------
  // Eixos da análise processual: cada um ganha ícone e cor próprios, e a cor
  // desce para todos os descendentes (o ramo inteiro fala do mesmo assunto).
  // A paleta espelha as categorias de peças do painel (decisões douradas,
  // provas violeta, petições azul…), para o mapa e a lista de peças
  // "combinarem" na cabeça de quem usa os dois.
  // A primeira regra que casar vence — ordem importa.
  // ---------------------------------------------------------------------------
  const SVGP = {
    partes:
      "M9 11a3.5 3.5 0 100-7 3.5 3.5 0 000 7zm7.5 1a3 3 0 100-6 3 3 0 000 6zM9 13c-3.3 0-6 1.8-6 4v2h12v-2c0-2.2-2.7-4-6-4zm7.5.5c-.9 0-1.7.1-2.4.4 1.2.9 1.9 2 1.9 3.1V19H22v-1.8c0-2-2.5-3.7-5.5-3.7z",
    fatos:
      "M12 3a9 9 0 109 9h-2a7 7 0 11-7-7v4l5-5-5-5v4zM11 8h2v5l4 2-.9 1.7L11 14V8z",
    pedidos:
      "M12 2a10 10 0 100 20 10 10 0 000-20zm0 3.5a6.5 6.5 0 110 13 6.5 6.5 0 010-13zm0 3a3.5 3.5 0 100 7 3.5 3.5 0 000-7z",
    teses:
      "M12 2l1 2h6v2h-2.2l3.2 6c0 1.9-1.6 3.2-3.5 3.2S13 13.9 13 12l3.2-6H13v12h4v2H7v-2h4V6H7.8L11 12c0 1.9-1.6 3.2-3.5 3.2S4 13.9 4 12l3.2-6H5V4h6l1-2z",
    provas:
      "M10.5 3a7.5 7.5 0 015.9 12.1l4.3 4.3-1.4 1.4-4.3-4.3A7.5 7.5 0 1110.5 3zm0 2a5.5 5.5 0 100 11 5.5 5.5 0 000-11z",
    decisoes:
      "M14.1 2.5l7.4 7.4-2.1 2.1-1.1-1.1-3.2 3.2 1.1 1.1-2.1 2.1-7.4-7.4 2.1-2.1 1.1 1.1L13.1 5.7 12 4.6l2.1-2.1zM7.5 14.5l2 2L4 22l-2-2 5.5-5.5z",
    audiencias:
      "M12 3a3 3 0 013 3v5a3 3 0 01-6 0V6a3 3 0 013-3zm-5 8h2a3 3 0 006 0h2a5 5 0 01-4 4.9V19h3v2H8v-2h3v-3.1A5 5 0 017 11z",
    prazos:
      "M7 2h10v2h3v2h-3.1A6 6 0 0113 11.9V13a6 6 0 013.9 5H20v2H4v-2h3.1A6 6 0 0111 13v-1.1A6 6 0 017.1 6H4V4h3V2z",
    recursos:
      "M12 3l7 7h-4v5h-6v-5H5l7-7zm-7 16h14v2H5v-2z",
    situacao:
      "M12 2a7 7 0 017 7c0 5.2-7 13-7 13S5 14.2 5 9a7 7 0 017-7zm0 4.5A2.5 2.5 0 1012 11.5 2.5 2.5 0 0012 6.5z",
    outro: "M12 6a6 6 0 110 12 6 6 0 010-12z",
  };

  const EIXOS = [
    { k: "partes", rot: "Partes", cor: "#2f5583", re: /\b(parte|partes|polo|autor|autora|reu|re|requerente|requerido|exequente|executado|litisconsorte|representa|procurador|advogad|denunciad|acusad|vitima|ofendid|ministerio publico)/ },
    { k: "fatos", rot: "Fatos", cor: "#0e7490", re: /\b(fato|fatos|sintese|historico|contexto|narrativa|cronologia|linha do tempo|ocorrenci)/ },
    { k: "pedidos", rot: "Pedidos", cor: "#8a5a2b", re: /\b(pedido|pedidos|requerimento|postula|tutela|liminar|causa de pedir|objeto|denuncia|imputa)/ },
    { k: "teses", rot: "Teses", cor: "#7a5c94", re: /\b(tese|teses|argument|defesa|contestac|preliminar|merito|fundament|alegac|razoes|impugnac)/ },
    { k: "provas", rot: "Provas", cor: "#2e7d4f", re: /\b(prova|provas|pericia|laudo|documental|testemunh|depoiment|exame|indicio)/ },
    { k: "audiencias", rot: "Audiências", cor: "#3f7f66", re: /\b(audienci|instruc|interrogatori|oitiva|sessao|julgamento em plenario)/ },
    { k: "decisoes", rot: "Decisões", cor: "#a8752f", re: /\b(decis|sentenc|despacho|acordao|liminar deferid|juizo|magistrad|pronuncia|absolvic|condenac)/ },
    { k: "recursos", rot: "Recursos", cor: "#4a5d78", re: /\b(recurs|apelac|agravo|embargos|contrarrazoes|habeas|instancia superior)/ },
    { k: "prazos", rot: "Prazos", cor: "#b04a3f", re: /\b(prazo|prescri|decadenci|intimac|citac|suspens|tempestiv)/ },
    { k: "situacao", rot: "Situação atual", cor: "#0078aa", re: /\b(situac|andamento|atual|conclus|proximos passos|pendenci|status|providencia)/ },
  ];

  const COR_PADRAO = "#0078aa";

  function norm(s) {
    return String(s || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
  }

  function classificarEixo(titulo) {
    const t = norm(titulo);
    for (const e of EIXOS) if (e.re.test(t)) return e;
    return { k: "outro", rot: "Outros", cor: COR_PADRAO };
  }

  function icone(eixo) {
    const d = SVGP[eixo.k] || SVGP.outro;
    return (
      '<svg class="mm-ic" viewBox="0 0 24 24" aria-hidden="true" style="color:' +
      eixo.cor +
      '"><path d="' +
      d +
      '"/></svg>'
    );
  }

  // ---------------------------------------------------------------------------
  // Tabelas markdown viram <table> dentro do nó — o markmap renderiza o content
  // como HTML no <foreignObject>, e uma tabela de partes ou da linha do tempo
  // diz num relance o que dez itens soltos não dizem.
  // ---------------------------------------------------------------------------
  function ehSeparadorTabela(l) {
    return /^\s*\|?\s*:?-{2,}[\s:|-]*$/.test(l) && l.includes("-");
  }
  function celulas(l) {
    let s = l.trim();
    if (s.startsWith("|")) s = s.slice(1);
    if (s.endsWith("|")) s = s.slice(0, -1);
    return s.split("|").map((c) => c.trim());
  }
  function tabelaHtml(linhas) {
    const cab = celulas(linhas[0]);
    const corpo = linhas.slice(2).map(celulas);
    let h = '<table class="mm-tab"><thead><tr>';
    for (const c of cab) h += "<th>" + conteudoNo(c) + "</th>";
    h += "</tr></thead><tbody>";
    for (const linha of corpo) {
      h += "<tr>";
      for (let i = 0; i < cab.length; i++) h += "<td>" + conteudoNo(linha[i] || "") + "</td>";
      h += "</tr>";
    }
    return h + "</tbody></table>";
  }

  // ---------------------------------------------------------------------------
  // Markdown → árvore de nós do markmap (IPureNode: {content, children}).
  //
  // Substitui o markmap-lib, que arrastaria katex + highlight.js + prismjs +
  // markdown-it (~311 KB) e tentaria buscar assets em CDN. O modelo recebe
  // instrução prescritiva para responder só com títulos (#), listas (-) e
  // tabelas simples, que é exatamente o que este parser entende.
  // ---------------------------------------------------------------------------
  function mdParaArvore(md, tituloPadrao) {
    const raiz = { content: conteudoNo(tituloPadrao || "Mapa"), children: [] };
    const pilhaH = [{ nivel: 0, no: raiz }]; // títulos (#) por profundidade
    let pilhaL = []; // itens de lista por coluna de indentação
    let fence = false;

    const linhas = String(md || "").split(/\r?\n/);
    for (let i = 0; i < linhas.length; i++) {
      const linha = linhas[i];
      if (/^\s*(```|~~~)/.test(linha)) {
        fence = !fence;
        continue;
      }
      if (fence || !linha.trim()) continue;

      const h = linha.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        const nivel = h[1].length;
        while (pilhaH.length > 1 && pilhaH[pilhaH.length - 1].nivel >= nivel) pilhaH.pop();
        const pai = pilhaH[pilhaH.length - 1].no;
        const no = { content: conteudoNo(h[2]), children: [], __titulo: h[2] };
        pai.children.push(no);
        pilhaH.push({ nivel, no });
        pilhaL = []; // um título fecha a lista anterior
        continue;
      }

      // tabela: linha com | seguida do separador |---|
      if (linha.includes("|") && ehSeparadorTabela(linhas[i + 1] || "")) {
        const bloco = [];
        while (i < linhas.length && linhas[i].includes("|")) bloco.push(linhas[i++]);
        i--; // o for avança
        const pai = pilhaL.length
          ? pilhaL[pilhaL.length - 1].no
          : pilhaH[pilhaH.length - 1].no;
        pai.children.push(novoNo(tabelaHtml(bloco)));
        continue;
      }

      const li = linha.match(/^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/);
      if (li) {
        // tab conta como 4 espaços; cada 2 espaços é um nível de aninhamento
        const col = li[1].replace(/\t/g, "    ").length;
        while (pilhaL.length && pilhaL[pilhaL.length - 1].col >= col) pilhaL.pop();
        const pai = pilhaL.length
          ? pilhaL[pilhaL.length - 1].no
          : pilhaH[pilhaH.length - 1].no;
        const no = novoNo(conteudoNo(li[2]));
        pai.children.push(no);
        pilhaL.push({ col, no });
        continue;
      }

      // parágrafo solto: vira filho do título corrente (não quebra a árvore)
      const texto = linha.replace(/^\s*>\s?/, "").trim();
      if (texto) {
        const pai = pilhaH[pilhaH.length - 1].no;
        pai.children.push(novoNo(conteudoNo(texto)));
        pilhaL = [];
      }
    }

    // um único "# título" no topo é a raiz natural do mapa
    const final =
      raiz.children.length === 1 && raiz.children[0].children.length
        ? raiz.children[0]
        : raiz;
    return decorarEixos(final);
  }

  // Ícone e cor são atribuídos DEPOIS de montar a árvore: só aqui se sabe quem
  // ficou como raiz (com "# título" no topo, os eixos são os "##"; sem ele, os
  // "#"). Fazer isso durante a leitura decorava o próprio título do processo.
  function decorarEixos(raiz) {
    for (const eixoNo of raiz.children) {
      const eixo = classificarEixo(eixoNo.__titulo || textoDe(eixoNo.content));
      eixoNo.content = icone(eixo) + eixoNo.content;
      eixoNo.payload = { cor: eixo.cor, eixo: eixo.k, rot: eixo.rot };
      pintar(eixoNo, eixo.cor);
    }
    limparInternos(raiz);
    return raiz;
  }
  function pintar(no, cor) {
    for (const f of no.children || []) {
      f.payload = { ...(f.payload || {}), cor };
      pintar(f, cor);
    }
  }
  function textoDe(html) {
    return String(html || "").replace(/<[^>]*>/g, "");
  }
  function limparInternos(no) {
    delete no.__titulo;
    for (const f of no.children || []) limparInternos(f);
  }

  function novoNo(content) {
    return { content, children: [] };
  }

  function contarNos(no) {
    let n = 1;
    for (const f of no.children || []) n += contarNos(f);
    return n;
  }

  // Quantos tópicos folha citam a origem (fl. e/ou id da peça). Indicar a peça
  // é requisito do mapa — mostrar a proporção deixa visível quando o modelo
  // deixou tópicos sem lastro nos autos.
  function contarComOrigem(no, r) {
    r = r || { folhas: 0, total: 0 };
    for (const f of no.children || []) {
      if (!f.children.length) {
        r.total++;
        if (/mm-fl|mm-id/.test(f.content)) r.folhas++;
      }
      contarComOrigem(f, r);
    }
    return r;
  }

  // A árvore ganha `state` (id, depth, fold…) no primeiro render; para reaplicar
  // initialExpandLevel é preciso entregar uma árvore limpa.
  function clonarArvore(no) {
    const c = { content: no.content, children: (no.children || []).map(clonarArvore) };
    if (no.payload) c.payload = { ...no.payload };
    return c;
  }

  // ---------------------------------------------------------------------------
  // Página
  // ---------------------------------------------------------------------------
  const $ = (s) => document.querySelector(s);
  const svgEl = $("#mapa");
  const avisoEl = $("#aviso");
  const subEl = $("#subtitulo");
  const legendaEl = $("#legenda");

  const DURACAO = 300; // animação de abrir/fechar ramo

  let mm = null;
  let arvore = null;
  let dados = null; // {md, titulo, processo}
  let nivelAtual = 2;

  function mostrarAviso(html) {
    avisoEl.innerHTML = html;
    avisoEl.hidden = false;
  }

  function opcoes(nivel) {
    // deriveOptions traduz as opções "JSON" (números, lineWidth…) para as
    // funções que o construtor espera; a cor vem do payload de cada nó, então
    // é passada depois, por cima.
    const o = markmap.deriveOptions({
      initialExpandLevel: nivel > 0 ? nivel : -1,
      maxWidth: 380,
      spacingVertical: 12,
      spacingHorizontal: 96,
      duration: DURACAO,
      lineWidth: 2.5,
    });
    o.color = (n) => (n.payload && n.payload.cor) || COR_PADRAO;
    return o;
  }

  // As transições do d3 rodam em requestAnimationFrame, congelado pelo Chrome
  // em aba de segundo plano: animar ali deixaria os nós presos a meio caminho.
  // Só anima quando a aba está de fato visível.
  function duracaoSegura() {
    return document.visibilityState === "visible" ? DURACAO : 0;
  }

  async function aplicarNivel(nivel) {
    nivelAtual = nivel;
    document
      .querySelectorAll("[data-nivel]")
      .forEach((b) => b.classList.toggle("on", Number(b.dataset.nivel) === nivel));
    if (!mm) return;
    mm.setOptions({ ...opcoes(nivel), duration: duracaoSegura() });
    await mm.setData(clonarArvore(arvore));
    await mm.fit();
    mm.setOptions({ duration: DURACAO });
  }

  function baixar(nome, conteudo, mime) {
    const blob = new Blob([conteudo], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = nome;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  function nomeBase() {
    const p = (dados && dados.processo) || "";
    return ("mapa-mental" + (p ? "-processo-" + p : "")).replace(/[^\w.\-]+/g, "-");
  }

  function ligarBotoes() {
    document
      .querySelectorAll("[data-nivel]")
      .forEach((b) => b.addEventListener("click", () => aplicarNivel(Number(b.dataset.nivel))));
    $("#mais").addEventListener("click", () => mm && mm.rescale(1.25));
    $("#menos").addEventListener("click", () => mm && mm.rescale(0.8));
    $("#ajustar").addEventListener("click", () => mm && mm.fit());
    $("#imprimir").addEventListener("click", () => window.print());
    // imprimir o que está fora do enquadramento sairia cortado — o mapa é um
    // SVG com zoom/pan, não uma página que rola
    window.addEventListener("beforeprint", () => mm && mm.fit());
    $("#tema").addEventListener("click", () => {
      const escuro = document.documentElement.classList.toggle("markmap-dark");
      $("#tema").textContent = escuro ? "☀" : "🌙";
      $("#tema").title = escuro ? "Voltar ao tema claro" : "Tema escuro";
    });
    $("#md").addEventListener("click", () => {
      if (dados) baixar(nomeBase() + ".md", dados.md, "text/markdown");
    });
    window.addEventListener("resize", () => mm && mm.fit());
  }

  // Legenda: só os eixos que o mapa realmente tem, na ordem em que aparecem.
  function montarLegenda() {
    const vistos = [];
    for (const filho of arvore.children) {
      const p = filho.payload;
      if (p && p.rot && !vistos.some((v) => v.rot === p.rot)) {
        vistos.push({ rot: p.rot, cor: p.cor });
      }
    }
    legendaEl.innerHTML = vistos
      .map(
        (v) =>
          '<span class="lg"><i style="background:' +
          v.cor +
          '"></i>' +
          escapeHtml(v.rot) +
          "</span>"
      )
      .join("");
    legendaEl.hidden = !vistos.length;
  }

  function desenhar() {
    arvore = mdParaArvore(dados.md, dados.titulo || "Processo");
    if (!arvore.children.length) {
      mostrarAviso(
        "<div>O texto recebido não tem estrutura de tópicos para virar mapa.<br>" +
          "Volte ao painel e gere o mapa novamente.</div>"
      );
      return;
    }
    // a raiz leva o brasão da extensão — é a única imagem de bitmap do mapa,
    // e vem do próprio pacote (a CSP da extensão bloqueia imagem remota)
    arvore.content =
      '<img class="mm-brasao" src="../icons/icon48.png" alt=""><span class="mm-raiz">' +
      arvore.content +
      "</span>";
    document.title =
      "Mapa mental" + (dados.processo ? " — processo " + dados.processo : "") + " — PJe IA";
    const orig = contarComOrigem(arvore);
    subEl.textContent =
      (dados.titulo || "Processo") +
      " · " +
      arvore.children.length +
      " eixos · " +
      contarNos(arvore) +
      " tópicos" +
      (orig.total ? " · " + orig.folhas + "/" + orig.total + " com peça e folha" : "");
    montarLegenda();
    // O primeiro desenho é SEM animação (duration 0) de propósito: as
    // transições do d3 rodam em requestAnimationFrame, que o Chrome congela em
    // aba de segundo plano — abrindo o mapa em nova aba sem foco (ctrl+clique,
    // bloqueador de pop-up) os nós ficavam presos no estado inicial, invisíveis.
    // A animação volta logo depois, para abrir/fechar ramos e trocar de nível.
    mm = new markmap.Markmap(svgEl, { ...opcoes(nivelAtual), duration: 0 });
    mm.setData(clonarArvore(arvore)).then(() => {
      mm.fit();
      mm.setOptions({ duration: DURACAO });
    });
    // Ao voltar para a aba: redesenha (destrava qualquer transição que tenha
    // ficado pela metade em segundo plano) e reenquadra — em background o
    // layout pode ter sido medido com dimensões zeradas.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible" || !mm) return;
      mm.setOptions({ duration: 0 });
      mm.renderData().then(() => {
        mm.fit();
        mm.setOptions({ duration: DURACAO });
      });
    });
  }

  // ponto de entrada para os testes fora do navegador (mesmo estilo dos
  // _findSlashToken/_montarTextoEnvio expostos por panel.js)
  window.__mapa = { mdParaArvore, contarNos, escapeHtml, inlineMd, realces, classificarEixo };

  ligarBotoes();

  const id = new URLSearchParams(location.search).get("id");
  if (!id) {
    mostrarAviso("<div>Endereço sem identificador de mapa.</div>");
    return;
  }
  chrome.storage.session.get("mapa:" + id, (res) => {
    const d = res && res["mapa:" + id];
    if (!d || !d.md) {
      mostrarAviso(
        "<div><b>Mapa não encontrado.</b><br>Os mapas ficam guardados só enquanto o navegador " +
          "está aberto. Volte à aba do processo e gere o mapa novamente.</div>"
      );
      return;
    }
    dados = d;
    desenhar();
  });
})();
