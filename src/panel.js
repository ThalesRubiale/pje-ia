// UI do painel lateral (chat + seletor de documentos), isolada em Shadow DOM.
var PjePanel = (function () {
  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
    );
  }

  // ---------------------------------------------------------------------------
  // Renderizador markdown seguro (escapa primeiro, depois formata).
  // Suporta: títulos, negrito/itálico, código inline, blocos ```, listas,
  // listas numeradas, tabelas, citações (>), linhas --- e links http(s).
  // ---------------------------------------------------------------------------
  function inlineMd(s) {
    let h = s;
    h = h.replace(/`([^`]+)`/g, "<code>$1</code>");
    h = h.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    h = h.replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>");
    h = h.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (m, t, u) => {
      return '<a href="' + u + '" target="_blank" rel="noopener">' + t + "</a>";
    });
    return h;
  }

  function isTableSep(line) {
    return /^\s*\|?\s*:?-{2,}[\s:|-]*$/.test(line) && line.includes("-");
  }
  function splitRow(line) {
    let l = line.trim();
    if (l.startsWith("|")) l = l.slice(1);
    if (l.endsWith("|")) l = l.slice(0, -1);
    return l.split("|").map((c) => c.trim());
  }

  function renderMd(text, cites) {
    const src = escapeHtml(text);
    const lines = src.split(/\r?\n/);
    const out = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      // bloco de código cercado
      if (/^```/.test(line)) {
        const buf = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
        i++; // pula o fecho
        out.push("<pre><code>" + buf.join("\n") + "</code></pre>");
        continue;
      }

      // tabela (linha com | seguida do separador |---|)
      if (line.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        const head = splitRow(line);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
          rows.push(splitRow(lines[i++]));
        }
        let t = "<table><thead><tr>";
        for (const c of head) t += "<th>" + inlineMd(c) + "</th>";
        t += "</tr></thead><tbody>";
        for (const r of rows) {
          t += "<tr>";
          for (let k = 0; k < head.length; k++) t += "<td>" + inlineMd(r[k] || "") + "</td>";
          t += "</tr>";
        }
        t += "</tbody></table>";
        out.push(t);
        continue;
      }

      // título
      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        const lvl = Math.min(h[1].length + 2, 6); // #→h3… (mantém hierarquia visual do chat)
        out.push("<h" + lvl + ">" + inlineMd(h[2]) + "</h" + lvl + ">");
        i++;
        continue;
      }

      // linha horizontal
      if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
        out.push("<hr>");
        i++;
        continue;
      }

      // citação
      if (/^\s*&gt;\s?/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s*&gt;\s?/.test(lines[i])) {
          buf.push(lines[i].replace(/^\s*&gt;\s?/, ""));
          i++;
        }
        out.push("<blockquote>" + buf.map(inlineMd).join("<br>") + "</blockquote>");
        continue;
      }

      // lista com marcadores
      if (/^\s*[-*]\s+/.test(line)) {
        let ul = "<ul>";
        while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
          ul += "<li>" + inlineMd(lines[i].replace(/^\s*[-*]\s+/, "")) + "</li>";
          i++;
        }
        out.push(ul + "</ul>");
        continue;
      }

      // lista numerada
      if (/^\s*\d+[.)]\s+/.test(line)) {
        let ol = "<ol>";
        while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
          ol += "<li>" + inlineMd(lines[i].replace(/^\s*\d+[.)]\s+/, "")) + "</li>";
          i++;
        }
        out.push(ol + "</ol>");
        continue;
      }

      // linha em branco
      if (line.trim() === "") {
        i++;
        continue;
      }

      // parágrafo (junta linhas consecutivas com <br>)
      const buf = [line];
      i++;
      while (
        i < lines.length &&
        lines[i].trim() !== "" &&
        !/^(#{1,6}\s|```|\s*[-*]\s|\s*\d+[.)]\s|\s*&gt;)/.test(lines[i]) &&
        !(lines[i].includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1]))
      ) {
        buf.push(lines[i]);
        i++;
      }
      out.push("<p>" + buf.map(inlineMd).join("<br>") + "</p>");
    }

    let html = out.join("");
    // Marcadores de citação: o content script injeta placeholders na área de
    // uso privado do Unicode (U+E000 n U+E001) — eles atravessam o escapeHtml
    // intactos e só aqui, DEPOIS do escape, viram sobrescritos [n].
    html = html.replace(new RegExp("\\uE000(\\d+)\\uE001", "g"), (m, n) => {
      const c = cites && cites[Number(n) - 1];
      return (
        '<sup class="cit"' +
        (c ? ' title="' + escapeHtml(c.label) + '"' : "") +
        ">" + n + "</sup>"
      );
    });
    return html;
  }

  // Ações rápidas: preenchem o campo de texto com um prompt pronto (o usuário
  // revisa e envia). Só UI — nenhum request é disparado automaticamente.
  const ACOES_RAPIDAS = [
    {
      rot: "Resumo do processo",
      p: "Faça um resumo objetivo do processo: partes, objeto, pedidos, andamento e situação atual.",
    },
    {
      rot: "Linha do tempo",
      p: "Monte uma linha do tempo dos atos processuais em tabela: data, ato e peça de origem.",
    },
    {
      rot: "Preparar audiência",
      p: "Prepare um roteiro para a audiência: pontos controvertidos, provas de cada parte, sugestões de perguntas e riscos.",
    },
    {
      rot: "Minuta de despacho",
      p: "Redija uma minuta de despacho/decisão adequada à fase atual do processo, fundamentando nas peças.",
    },
  ];

  // Ícones SVG (evita depender de glifos unicode que podem faltar na fonte)
  const SVG = {
    fs:
      '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2H2v4M10 2h4v4M6 14H2v-4M10 14h4v-4"/></svg>',
    expand:
      '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 2H2v4M10 2h4v4M6 14H2v-4M10 14h4v-4"/></svg>',
    close:
      '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 3l10 10M13 3L3 13"/></svg>',
    reset:
      '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 8a5.5 5.5 0 1 1 1.6 3.9M2.5 12V8.8h3.2"/></svg>',
    download:
      '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v8M4.8 7l3.2 3.2L11.2 7M3 13h10"/></svg>',
    copy:
      '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2"/></svg>',
    doc:
      '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 1.5h-5a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V5z"/><path d="M9.5 1.5V5h3"/></svg>',
    x:
      '<svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9"/></svg>',
    check:
      '<svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 8.5l3.5 3.5 7-8"/></svg>',
  };

  // Título curto da peça (sem o prefixo numérico do id) para chips e menções.
  function tituloCurto(t) {
    return String(t).replace(/^\d{6,}\s*-\s*/, "");
  }
  // Separa "141516171 - Petição Inicial" em {id, nome} para exibição.
  function partesTitulo(t) {
    const m = String(t).match(/^(\d{6,})\s*-\s*(.+)$/);
    return m ? { id: m[1], nome: m[2] } : { id: "", nome: String(t) };
  }

  // ---------------------------------------------------------------------------
  // Categorias de peças (regex sobre o título sem acentos) para destaque visual.
  // A primeira que casar vence — mantenha as mais específicas primeiro.
  // ---------------------------------------------------------------------------
  const CATEGORIAS = [
    // atos do juízo
    { cls: "cat-decisao", re: /\b(sentenca|decisao|despacho|acordao|liminar|tutela|julgamento)\b/ },
    // atas e audiências ("ata notarial" é prova — fica para a regra de provas)
    { cls: "cat-audiencia", re: /\b(ata(?!\s+notarial)|audiencia|assentada|depoimento)\b/ },
    // peças das partes
    { cls: "cat-peticao", re: /\b(peticao|inicial|contestacao|replica|treplica|recurso|apelacao|embargos|agravo|impugnacao|alegacoes|manifestacao|defesa|denuncia|queixa|memoriais|razoes|contrarrazoes)\b/ },
    // provas técnicas
    { cls: "cat-prova", re: /\b(laudo|pericia|parecer|ata notarial)\b/ },
  ];
  function categoriaDe(titulo) {
    const t = norm(titulo);
    for (const c of CATEGORIAS) if (c.re.test(t)) return c.cls;
    return "cat-outro";
  }
  // Normaliza para busca sem acentos/caixa (ex.: "peticao" acha "Petição").
  function norm(s) {
    return String(s)
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "");
  }

  function mount() {
    const host = document.createElement("div");
    host.id = "pje-ia-host";
    document.documentElement.appendChild(host);
    const root = host.attachShadow({ mode: "open" });

    const styleEl = document.createElement("style");
    root.appendChild(styleEl);
    fetch(chrome.runtime.getURL("src/panel.css"))
      .then((r) => r.text())
      .then((css) => (styleEl.textContent = css))
      .catch(() => {});

    const iconUrl = chrome.runtime.getURL("icons/icon48.png");
    const wrap = document.createElement("div");
    wrap.className = "wrap pulse";
    wrap.innerHTML = `
      <div class="backdrop"></div>
      <button class="launcher"><span class="sc">⚖️</span> Analisar com IA</button>
      <div class="panel">
        <div class="hd">
          <img class="mark" src="${iconUrl}" alt="">
          <span class="ttl">Assistente dos Autos</span>
          <button class="dl" title="Baixar conversa (.md)">${SVG.download}</button>
          <button class="reset" title="Nova conversa">${SVG.reset}</button>
          <button class="expand" title="Expandir / recolher">${SVG.expand}</button>
          <button class="fs" title="Tela cheia / restaurar">${SVG.fs}</button>
          <button class="close" title="Fechar">${SVG.close}</button>
        </div>
        <div class="content">
          <div class="docs">
            <div class="docs-hd">
              <span><strong>Peças do processo</strong><span class="count"></span></span>
              <label class="all"><input type="checkbox" class="chk-all"> todas</label>
            </div>
            <div class="legend" aria-hidden="true">
              <span><i class="l-dot cat-decisao"></i>decisões</span>
              <span><i class="l-dot cat-audiencia"></i>audiências</span>
              <span><i class="l-dot cat-peticao"></i>petições</span>
              <span><i class="l-dot cat-prova"></i>provas</span>
            </div>
            <div class="doclist"></div>
            <div class="docs-tip">Não achou uma peça? Role a linha do tempo do processo para carregá-la.</div>
          </div>
          <div class="main">
            <div class="msgs"></div>
            <div class="ft">
              <div class="mention" hidden>
                <div class="mention-hd">
                  <span>Adicionar peça ao contexto</span>
                  <span class="mention-keys"><kbd>↑↓</kbd> navegar <kbd>↵</kbd> marcar <kbd>esc</kbd> fechar</span>
                </div>
                <div class="mention-list" role="listbox"></div>
              </div>
              <div class="status" aria-live="polite"></div>
              <div class="gauge" hidden title="Quanto do limite do modelo esta conversa já ocupa (tokens e páginas de PDF). Ao encher, clique em ⟲ para começar uma nova conversa.">
                <div class="gauge-bar"><div class="gauge-fill"></div></div>
                <span class="gauge-txt"></span>
              </div>
              <div class="ctxbar" hidden></div>
              <div class="quick"></div>
              <div class="toolbar">
                <span class="ctxlab">Ferramentas</span>
                <div class="tools">
                  <button class="tgl-search" aria-pressed="false" title="Liga/desliga a busca de jurisprudência e legislação em fontes oficiais (STF, STJ, Planalto…). Com a busca ligada, escreva a pergunta e use o botão Enviar normalmente.">🔍 Jurisprudência</button>
                  <button class="btn-docx" title="Gera um documento Word (.docx) com base nas peças marcadas. 1º clique: preenche a instrução no campo (edite à vontade). 2º clique: gera o documento. Não use o botão Enviar para isso.">📄 Gerar .docx</button>
                </div>
              </div>
              <div class="inrow">
                <textarea class="in" rows="1" placeholder="Pergunte sobre as peças… (@ cita uma peça)"></textarea>
                <button class="send">Enviar</button>
              </div>
              <div class="hint-key"><b>@</b> cita peças &nbsp;·&nbsp; <b>Enter</b> envia &nbsp;·&nbsp; <b>Shift+Enter</b> quebra linha &nbsp;·&nbsp; <b>📄 .docx</b> em 2 cliques: revisar → gerar</div>
            </div>
          </div>
        </div>
      </div>`;
    root.appendChild(wrap);

    const $ = (s) => wrap.querySelector(s);
    const launcher = $(".launcher");
    const backdrop = $(".backdrop");
    const resetBtn = $(".reset");
    const expandBtn = $(".expand");
    const closeBtn = $(".close");
    const docsBox = $(".docs");
    const doclist = $(".doclist");
    const chkAll = $(".chk-all");
    const countEl = $(".count");
    const msgs = $(".msgs");
    const ft = $(".ft");
    const statusEl = $(".status");
    const gaugeEl = $(".gauge");
    const gaugeFill = $(".gauge-fill");
    const gaugeTxt = $(".gauge-txt");
    const ctxbar = $(".ctxbar");
    const mentionEl = $(".mention");
    const mentionList = $(".mention-list");
    const inEl = $(".in");
    const sendBtn = $(".send");

    let allDocs = []; // [{id, titulo}] espelho da lista lateral

    let hintEl = null;
    function showEmptyHint() {
      if (hintEl || msgs.querySelector(".msg")) return;
      hintEl = document.createElement("div");
      hintEl.className = "hint-empty";
      hintEl.innerHTML =
        '<span class="big">Como posso ajudar?</span>Marque as peças acima ou digite <b>@</b> no campo abaixo para escolhê-las — ex.: <em>"Resuma a inicial e a réplica"</em>.';
      msgs.appendChild(hintEl);
    }
    function clearEmptyHint() {
      if (hintEl) {
        hintEl.remove();
        hintEl = null;
      }
    }
    showEmptyHint();

    function open() {
      wrap.classList.add("open");
      wrap.classList.remove("pulse");
    }
    launcher.addEventListener("click", open);
    closeBtn.addEventListener("click", () => wrap.classList.remove("open", "expanded", "full"));
    expandBtn.addEventListener("click", () => {
      wrap.classList.remove("full"); // sair da tela cheia volta ao expandido/normal
      wrap.classList.toggle("expanded");
    });
    // Tela cheia: terceiro estágio (flutuante → expandido → tela cheia).
    // Entrar implica o layout expandido (peças na lateral); sair volta ao expandido.
    const fsBtn = $(".fs");
    fsBtn.addEventListener("click", () => {
      if (wrap.classList.contains("full")) {
        wrap.classList.remove("full");
      } else {
        wrap.classList.add("expanded", "full");
      }
    });
    backdrop.addEventListener("click", () => wrap.classList.remove("expanded", "full"));

    let resetCb = null;
    resetBtn.addEventListener("click", () => {
      if (resetCb) resetCb();
    });

    // Toggle de busca de jurisprudência (estado lido pelo content script no envio)
    const tglSearch = $(".tgl-search");
    let searchOn = false;
    tglSearch.addEventListener("click", () => {
      searchOn = !searchOn;
      tglSearch.setAttribute("aria-pressed", String(searchOn));
      tglSearch.classList.toggle("on", searchOn);
      // feedback imediato: o rótulo e o status dizem o que o toggle faz
      tglSearch.textContent = searchOn ? "🔍 Jurisprudência ligada" : "🔍 Jurisprudência";
      statusEl.textContent = searchOn
        ? "Busca de jurisprudência ligada: as próximas perguntas enviadas poderão consultar STF, STJ, Planalto e outras fontes oficiais."
        : "Busca de jurisprudência desligada.";
    });

    // Geração de .docx em DOIS cliques guiados: o primeiro clique preenche o
    // campo com a instrução (padrão, editável) e explica o próximo passo; o
    // segundo clique — com instrução no campo — dispara a geração.
    const INSTRUCAO_DOCX_PADRAO =
      "Elabore um relatório completo do processo: identificação e partes, síntese dos fatos, " +
      "linha do tempo dos atos processuais, pedidos, teses de cada parte, provas produzidas e " +
      "situação atual do feito.";
    const btnDocx = $(".btn-docx");
    let gerarDocCb = null;
    btnDocx.addEventListener("click", () => {
      if (!gerarDocCb) return;
      if (!getSelected().length) {
        statusEl.textContent =
          "Para gerar o documento, primeiro marque as peças na lista ao lado.";
        return;
      }
      const t = inEl.value.trim();
      if (!t) {
        inEl.value = INSTRUCAO_DOCX_PADRAO;
        autoresize();
        inEl.focus();
        statusEl.textContent =
          "Instrução preenchida no campo — edite se quiser e clique em “📄 Gerar .docx” de novo para gerar o documento.";
        return;
      }
      gerarDocCb(t, getSelected());
      inEl.value = "";
      inEl.style.height = "auto";
      closeMention();
    });

    // Ações rápidas: preenchem o campo com um prompt pronto para revisão
    const quickEl = $(".quick");
    const quickLab = document.createElement("span");
    quickLab.className = "ctxlab";
    quickLab.textContent = "Perguntas prontas";
    quickEl.appendChild(quickLab);
    const quickList = document.createElement("div");
    quickList.className = "quick-list";
    quickEl.appendChild(quickList);
    for (const a of ACOES_RAPIDAS) {
      const b = document.createElement("button");
      b.className = "quick-btn";
      b.textContent = a.rot;
      b.title = a.p;
      b.addEventListener("click", () => {
        inEl.value = a.p;
        autoresize();
        inEl.focus();
      });
      quickList.appendChild(b);
    }

    // -------------------------------------------------------------------------
    // Transcript da conversa (para exportar .md e copiar por mensagem).
    // Os placeholders de citação viram [n] no texto exportado.
    // -------------------------------------------------------------------------
    const transcript = []; // [{role, text, cites?}]
    const RE_CIT_PLACEHOLDER = new RegExp("\\uE000(\\d+)\\uE001", "g");
    function textoExportavel(t) {
      return String(t || "").replace(RE_CIT_PLACEHOLDER, "[$1]");
    }

    const dlBtn = $(".dl");
    dlBtn.addEventListener("click", () => {
      if (!transcript.length) return;
      const linhas = ["# Conversa — PJe IA", ""];
      for (const t of transcript) {
        linhas.push(t.role === "user" ? "## Usuário" : "## Assistente");
        linhas.push("");
        linhas.push(t.text || "");
        if (t.cites && t.cites.length) {
          linhas.push("");
          linhas.push("Fontes:");
          t.cites.forEach((c, i) =>
            linhas.push(i + 1 + ". " + c.label + (c.url ? " — " + c.url : ""))
          );
        }
        linhas.push("");
      }
      const blob = new Blob([linhas.join("\n")], { type: "text/markdown" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "conversa-pje-ia.md";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    });

    // Estrutura interna da bolha do assistant: raciocínio colapsável + corpo +
    // botão de copiar. Criada sob demanda (a bolha nasce com o indicador de
    // digitação e só ganha estrutura no primeiro delta/thinking).
    function estruturaAssistant(el) {
      if (el.__body) return el;
      el.classList.remove("typing");
      el.innerHTML =
        '<details class="think" hidden><summary>Raciocínio</summary><div class="think-t"></div></details>' +
        '<div class="body"></div>' +
        '<button class="copy" title="Copiar texto da resposta">' + SVG.copy + "</button>";
      el.__think = el.querySelector(".think");
      el.__thinkT = el.querySelector(".think-t");
      el.__body = el.querySelector(".body");
      el.querySelector(".copy").addEventListener("click", () => {
        const entry = el.__entry;
        const txt = textoExportavel(entry && entry.text);
        if (txt && navigator.clipboard) navigator.clipboard.writeText(txt).catch(() => {});
      });
      return el;
    }

    // auto-resize do textarea
    function autoresize() {
      inEl.style.height = "auto";
      inEl.style.height = Math.min(inEl.scrollHeight, 140) + "px";
    }

    // -------------------------------------------------------------------------
    // Seleção de peças: os checkboxes da lista lateral são a fonte de verdade.
    // Chips da barra de contexto, contador e popup @ são visões sincronizadas.
    // -------------------------------------------------------------------------
    function getSelected() {
      return [...doclist.querySelectorAll('input[type="checkbox"]:checked')].map(
        (c) => c.value
      );
    }
    function getSelectedDocs() {
      const ids = new Set(getSelected());
      return allDocs.filter((d) => ids.has(d.id));
    }
    function setDocChecked(id, on) {
      const c = doclist.querySelector('input[value="' + CSS.escape(id) + '"]');
      if (c) c.checked = on;
    }

    let prevChipIds = new Set(); // anima só chips recém-adicionados
    function syncSelection() {
      const sel = getSelectedDocs();
      const total = allDocs.length;

      chkAll.checked = total > 0 && sel.length === total;
      countEl.textContent = total
        ? sel.length
          ? `(${sel.length}/${total} no contexto)`
          : `(${total})`
        : "";

      // chips da barra de contexto
      ctxbar.innerHTML = "";
      if (!sel.length) {
        ctxbar.hidden = true;
        prevChipIds = new Set();
        return;
      }
      ctxbar.hidden = false;
      const lab = document.createElement("span");
      lab.className = "ctxlab";
      lab.textContent = "Peças no contexto (" + sel.length + ")";
      ctxbar.appendChild(lab);
      // bandeja própria para os chips: rolagem interna sem empurrar o rótulo
      const bandeja = document.createElement("div");
      bandeja.className = "chips";
      ctxbar.appendChild(bandeja);
      for (const d of sel) {
        const chip = document.createElement("span");
        chip.className =
          "chip " + categoriaDe(d.titulo) + (prevChipIds.has(d.id) ? "" : " new");
        chip.innerHTML =
          SVG.doc +
          '<span class="chip-t" title="' + escapeHtml(d.titulo) + '">' +
          escapeHtml(tituloCurto(d.titulo)) +
          '</span><button class="chip-x" title="Remover do contexto" aria-label="Remover ' +
          escapeHtml(tituloCurto(d.titulo)) + ' do contexto">' + SVG.x + "</button>";
        chip.querySelector(".chip-x").addEventListener("click", () => {
          setDocChecked(d.id, false);
          syncSelection();
        });
        bandeja.appendChild(chip);
      }
      prevChipIds = new Set(sel.map((d) => d.id));
    }

    chkAll.addEventListener("change", () => {
      doclist
        .querySelectorAll('input[type="checkbox"]')
        .forEach((c) => (c.checked = chkAll.checked));
      syncSelection();
    });
    // eventos change dos checkboxes individuais borbulham até a lista
    doclist.addEventListener("change", syncSelection);

    // -------------------------------------------------------------------------
    // Menção @: digitar "@" abre um popup com as peças; selecionar marca a peça
    // (mesmo estado da lista lateral) e remove o token "@busca" do texto.
    // -------------------------------------------------------------------------
    let mention = null; // {start, end, items:[{id,titulo}], idx}

    function findMentionToken() {
      const pos = inEl.selectionStart;
      const before = inEl.value.slice(0, pos);
      // "@" no início ou após espaço/pontuação de abertura; busca pode ter espaços
      const m = before.match(/(^|[\s([{])@([^@\n]*)$/);
      if (!m) return null;
      return { start: pos - m[2].length - 1, end: pos, query: m[2] };
    }

    function closeMention() {
      mention = null;
      mentionEl.hidden = true;
    }

    const MENTION_MAX = 50; // itens visíveis no popup; o excedente vira aviso

    function updateMention() {
      const tok = findMentionToken();
      if (!tok || !allDocs.length) return closeMention();
      const q = norm(tok.query.trim());
      const all = allDocs.filter((d) => !q || norm(d.titulo).includes(q));
      if (!all.length) return closeMention();
      const items = all.slice(0, MENTION_MAX);
      const prevId =
        mention && mention.items[mention.idx] ? mention.items[mention.idx].id : null;
      const keepIdx = items.findIndex((d) => d.id === prevId);
      mention = {
        start: tok.start,
        end: tok.end,
        items,
        extra: all.length - items.length,
        idx: keepIdx >= 0 ? keepIdx : 0,
      };
      renderMention();
    }

    function renderMention() {
      const ids = new Set(getSelected());
      mentionList.innerHTML = "";
      mention.items.forEach((d, i) => {
        const row = document.createElement("div");
        row.setAttribute("role", "option");
        row.setAttribute("aria-selected", i === mention.idx ? "true" : "false");
        row.className =
          "mrow " + categoriaDe(d.titulo) +
          (i === mention.idx ? " active" : "") + (ids.has(d.id) ? " on" : "");
        row.innerHTML =
          SVG.doc +
          '<span class="t" title="' + escapeHtml(d.titulo) + '">' +
          escapeHtml(d.titulo) +
          "</span>" +
          (ids.has(d.id)
            ? '<span class="on-badge">' + SVG.check + " no contexto</span>"
            : "");
        // mousedown (não click) para agir antes do blur do textarea
        row.addEventListener("mousedown", (e) => {
          e.preventDefault();
          pickMention(i);
        });
        row.addEventListener("mouseenter", () => {
          if (mention && mention.idx !== i) {
            mention.idx = i;
            renderMention();
          }
        });
        mentionList.appendChild(row);
      });
      if (mention.extra > 0) {
        const more = document.createElement("div");
        more.className = "mrow-more";
        more.textContent =
          "… e mais " + mention.extra + " peças — continue digitando para filtrar";
        mentionList.appendChild(more);
      }
      mentionEl.hidden = false;
      const act = mentionList.querySelector(".mrow.active");
      if (act) act.scrollIntoView({ block: "nearest" });
    }

    function pickMention(i) {
      if (!mention || !mention.items[i]) return;
      const d = mention.items[i];
      const already = new Set(getSelected()).has(d.id);
      // remove o token "@busca" do texto
      const v = inEl.value;
      inEl.value = v.slice(0, mention.start) + v.slice(mention.end);
      const caret = mention.start;
      setDocChecked(d.id, !already); // alterna: marcado sai, desmarcado entra
      syncSelection();
      closeMention();
      autoresize();
      inEl.focus();
      inEl.setSelectionRange(caret, caret);
    }

    inEl.addEventListener("input", () => {
      autoresize();
      updateMention();
    });
    // o caret pode mudar sem input (clique, setas, Home/End) — reavalia o token
    inEl.addEventListener("click", updateMention);
    inEl.addEventListener("keyup", (e) => {
      if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) updateMention();
    });
    inEl.addEventListener("blur", () => setTimeout(closeMention, 120));

    let sendCb = null;
    let configureCb = null;
    function doSend() {
      if (!sendCb) return;
      const t = inEl.value;
      if (!t.trim()) return;
      sendCb(t, getSelected());
      inEl.value = "";
      inEl.style.height = "auto";
      closeMention();
    }
    sendBtn.addEventListener("click", doSend);
    inEl.addEventListener("keydown", (e) => {
      if (mention && !mentionEl.hidden) {
        const n = mention.items.length;
        if (e.key === "ArrowDown") {
          e.preventDefault();
          mention.idx = (mention.idx + 1) % n;
          renderMention();
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          mention.idx = (mention.idx - 1 + n) % n;
          renderMention();
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          pickMention(mention.idx);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          closeMention();
          return;
        }
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        doSend();
      }
    });

    // -------------------------------------------------------------------------
    // Card de preparo: progresso por peça enquanto os PDFs são baixados.
    // -------------------------------------------------------------------------
    let prepEl = null;
    let prepTotal = 0;
    let prepDone = 0;

    function startPrep(items) {
      endPrep(true);
      clearEmptyHint();
      prepTotal = items.length;
      prepDone = 0;
      prepEl = document.createElement("div");
      prepEl.className = "prep";
      let rows = "";
      for (const d of items) {
        rows +=
          '<div class="prep-row" data-id="' + escapeHtml(d.id) + '">' +
          '<span class="prep-ic wait"></span>' +
          '<span class="t" title="' + escapeHtml(d.titulo) + '">' +
          escapeHtml(tituloCurto(d.titulo)) +
          "</span></div>";
      }
      prepEl.innerHTML =
        '<div class="prep-hd"><span class="prep-spin"></span><span class="prep-ttl">Preparando peças…</span>' +
        '<span class="prep-n">0/' + prepTotal + "</span></div>" +
        '<div class="prep-list">' + rows + "</div>" +
        '<div class="prep-bar"><i></i></div>';
      msgs.appendChild(prepEl);
      msgs.scrollTop = msgs.scrollHeight;
    }

    function setPrepState(id, state) {
      if (!prepEl) return;
      const row = prepEl.querySelector('.prep-row[data-id="' + CSS.escape(id) + '"]');
      if (!row) return;
      const ic = row.querySelector(".prep-ic");
      ic.className = "prep-ic " + state;
      ic.innerHTML = state === "done" ? SVG.check : "";
      if (state === "done") {
        prepDone++;
        prepEl.querySelector(".prep-n").textContent = prepDone + "/" + prepTotal;
        prepEl.querySelector(".prep-bar i").style.width =
          Math.round((prepDone / prepTotal) * 100) + "%";
      }
      msgs.scrollTop = msgs.scrollHeight;
    }

    function endPrep(immediate) {
      if (!prepEl) return;
      const el = prepEl;
      prepEl = null;
      if (immediate) {
        el.remove();
        return;
      }
      // confirma visualmente e recolhe
      el.querySelector(".prep-ttl").textContent =
        prepTotal === 1 ? "Peça anexada à conversa" : prepTotal + " peças anexadas à conversa";
      el.querySelector(".prep-spin").outerHTML =
        '<span class="prep-okic">' + SVG.check + "</span>";
      el.classList.add("ok");
      setTimeout(() => {
        el.classList.add("fade");
        setTimeout(() => el.remove(), 350);
      }, 1100);
    }

    // Overlay "configure sua chave"
    let needkeyEl = null;
    function setConfigured(ok) {
      if (ok) {
        if (needkeyEl) {
          needkeyEl.remove();
          needkeyEl = null;
        }
        docsBox.style.display = "";
        ft.style.display = "";
        showEmptyHint();
        return;
      }
      docsBox.style.display = "none";
      ft.style.display = "none";
      clearEmptyHint();
      if (!needkeyEl) {
        needkeyEl = document.createElement("div");
        needkeyEl.className = "needkey";
        needkeyEl.innerHTML =
          '<div class="k">Configure sua chave</div><p>Para usar o assistente, informe sua chave da API da Anthropic (uma única vez).</p><button>Abrir configuração</button>';
        needkeyEl
          .querySelector("button")
          .addEventListener("click", () => configureCb && configureCb());
        msgs.appendChild(needkeyEl);
      }
    }

    return {
      open,
      onSend(cb) {
        sendCb = cb;
      },
      onConfigure(cb) {
        configureCb = cb;
      },
      onReset(cb) {
        resetCb = cb;
      },
      setConfigured,
      clearMessages() {
        msgs.innerHTML = "";
        hintEl = null;
        needkeyEl = null;
        prepEl = null;
        transcript.length = 0;
        statusEl.textContent = "";
        showEmptyHint();
      },
      setDocs(docs) {
        const cur = new Set(getSelected());
        allDocs = docs.slice();
        doclist.innerHTML = "";
        for (const d of docs) {
          const p = partesTitulo(d.titulo);
          const row = document.createElement("label");
          row.className = "docrow " + categoriaDe(d.titulo);
          row.innerHTML =
            `<input type="checkbox" value="${escapeHtml(d.id)}">` +
            '<span class="d-dot" aria-hidden="true"></span>' +
            `<span class="d-t" title="${escapeHtml(d.titulo)}">` +
            `<span class="d-nm">${escapeHtml(p.nome)}</span>` +
            (p.id ? `<span class="d-id">${p.id}</span>` : "") +
            "</span>";
          if (cur.has(d.id)) row.querySelector("input").checked = true;
          doclist.appendChild(row);
        }
        if (!docs.length) {
          doclist.innerHTML = '<div class="empty">Nenhuma peça encontrada nesta tela.</div>';
        }
        syncSelection();
        if (mention) updateMention(); // popup aberto: reflete a lista atualizada
      },
      // attachments: títulos das peças anexadas neste turno (opcional)
      addMessage(role, text, attachments) {
        clearEmptyHint();
        const el = document.createElement("div");
        el.className = "msg " + role;
        el.__entry = { role, text: text || "" };
        transcript.push(el.__entry);
        if (role === "assistant") {
          if (text) {
            estruturaAssistant(el).__body.innerHTML = renderMd(text);
          } else {
            // aguardando o modelo: indicador de digitação
            el.classList.add("typing");
            el.innerHTML = '<span class="dots"><i></i><i></i><i></i></span>';
          }
        } else {
          const txt = document.createElement("div");
          txt.className = "txt";
          txt.textContent = text;
          el.appendChild(txt);
          if (attachments && attachments.length) {
            const at = document.createElement("div");
            at.className = "msg-atts";
            for (const t of attachments) {
              const c = document.createElement("span");
              c.className = "chip-mini";
              c.innerHTML =
                SVG.doc + "<span title=\"" + escapeHtml(t) + "\">" +
                escapeHtml(tituloCurto(t)) + "</span>";
              at.appendChild(c);
            }
            el.appendChild(at);
          }
        }
        msgs.appendChild(el);
        msgs.scrollTop = msgs.scrollHeight;
        return el;
      },
      // cites: [{label, url?}] — citações do turno; viram sobrescritos [n] no
      // texto e uma lista numerada de fontes no rodapé da bolha.
      updateAssistant(el, fullText, cites) {
        estruturaAssistant(el);
        // recolhe o raciocínio quando a resposta começa a chegar
        if (el.__think && !el.__think.hidden && fullText) el.__think.open = false;
        let html = renderMd(fullText, cites);
        if (cites && cites.length) {
          html +=
            '<div class="cites">' +
            cites
              .map((c, i) => {
                const rot = escapeHtml(c.label);
                // fontes da web (busca de jurisprudência) viram links
                const corpo =
                  c.url && /^https?:\/\//.test(c.url)
                    ? '<a href="' + escapeHtml(c.url) + '" target="_blank" rel="noopener">' +
                      rot + "</a>"
                    : rot;
                return (
                  '<span class="cite-row"><sup class="cit">' + (i + 1) + "</sup> " +
                  corpo + "</span>"
                );
              })
              .join("") +
            "</div>";
        }
        el.__body.innerHTML = html;
        if (el.__entry) {
          el.__entry.text = fullText;
          el.__entry.cites = cites || null;
        }
        msgs.scrollTop = msgs.scrollHeight;
      },
      // Resumo do raciocínio (thinking) em bloco colapsável no topo da bolha.
      setThinking(el, text) {
        estruturaAssistant(el);
        el.__think.hidden = !text;
        if (text) {
          if (!el.__body.innerHTML) el.__think.open = true;
          el.__thinkT.textContent = text;
        }
        msgs.scrollTop = msgs.scrollHeight;
      },
      removeMessage(el) {
        if (el) {
          const i = transcript.indexOf(el.__entry);
          if (i >= 0) transcript.splice(i, 1);
          el.remove();
        }
        showEmptyHint();
      },
      startPrep,
      setPrepState,
      endPrep,
      isSearchOn() {
        return searchOn;
      },
      onGerarDoc(cb) {
        gerarDocCb = cb;
      },
      // busy=true mostra um spinner antes do texto (trabalho em andamento —
      // análise, geração de documento, upload…), para o usuário ver que a
      // extensão está trabalhando e não travada.
      setStatus(s, busy) {
        statusEl.textContent = s || "";
        statusEl.classList.toggle("busy", !!busy && !!s);
      },
      // Medidor de contexto da conversa: barra + resumo (tokens e páginas
      // acumulados no request vs. limites do modelo). null esconde.
      setContexto(info) {
        if (!info || !info.ctxTokens) {
          gaugeEl.hidden = true;
          return;
        }
        const pctTok = info.tokens / info.ctxTokens;
        const pctPag = info.maxPaginas ? (info.paginas || 0) / info.maxPaginas : 0;
        const pct = Math.min(1, Math.max(pctTok, pctPag));
        gaugeFill.style.width = Math.round(pct * 100) + "%";
        gaugeEl.classList.toggle("warn", pct >= 0.7 && pct < 0.9);
        gaugeEl.classList.toggle("crit", pct >= 0.9);
        gaugeTxt.textContent =
          "Conversa: " + (info.pecas || 0) + " peça(s), ~" +
          Math.round(info.tokens / 1000) + " mil tokens (" +
          Math.round(pctTok * 100) + "%)" +
          (info.maxPaginas
            ? " • " + (info.paginas || 0) + "/" + info.maxPaginas + " págs. de PDF"
            : "");
        gaugeEl.hidden = false;
      },
      lockInput(b) {
        inEl.disabled = b;
        sendBtn.disabled = b;
        // trava também as ações — clicar durante uma resposta não faz nada,
        // e botão ativo-porém-morto confunde
        tglSearch.disabled = b;
        btnDocx.disabled = b;
        for (const q of quickEl.querySelectorAll("button")) q.disabled = b;
      },
    };
  }

  return { mount, _renderMd: renderMd };
})();
