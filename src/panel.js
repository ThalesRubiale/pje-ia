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

  function renderMd(text) {
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

    return out.join("");
  }

  // Ícones SVG (evita depender de glifos unicode que podem faltar na fonte)
  const SVG = {
    expand:
      '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 2H2v4M10 2h4v4M6 14H2v-4M10 14h4v-4"/></svg>',
    close:
      '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 3l10 10M13 3L3 13"/></svg>',
    reset:
      '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 8a5.5 5.5 0 1 1 1.6 3.9M2.5 12V8.8h3.2"/></svg>',
  };

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
          <button class="reset" title="Nova conversa">${SVG.reset}</button>
          <button class="expand" title="Expandir / recolher">${SVG.expand}</button>
          <button class="close" title="Fechar">${SVG.close}</button>
        </div>
        <div class="content">
          <div class="docs">
            <div class="docs-hd">
              <span><strong>Peças do processo</strong><span class="count"></span></span>
              <label class="all"><input type="checkbox" class="chk-all"> todas</label>
            </div>
            <div class="doclist"></div>
            <div class="docs-tip">Não achou uma peça? Role a linha do tempo do processo para carregá-la.</div>
          </div>
          <div class="main">
            <div class="msgs"></div>
            <div class="ft">
              <div class="status"></div>
              <div class="inrow">
                <textarea class="in" rows="1" placeholder="Pergunte sobre as peças marcadas…"></textarea>
                <button class="send">Enviar</button>
              </div>
              <div class="hint-key">As peças marcadas são enviadas ao Claude. Enter envia • Shift+Enter quebra linha.</div>
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
    const inEl = $(".in");
    const sendBtn = $(".send");

    let hintEl = null;
    function showEmptyHint() {
      if (hintEl || msgs.querySelector(".msg")) return;
      hintEl = document.createElement("div");
      hintEl.className = "hint-empty";
      hintEl.innerHTML =
        '<span class="big">Como posso ajudar?</span>Marque as peças acima e faça sua pergunta — ex.: <em>"Resuma a inicial e a réplica"</em>.';
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
    closeBtn.addEventListener("click", () => wrap.classList.remove("open", "expanded"));
    expandBtn.addEventListener("click", () => wrap.classList.toggle("expanded"));
    backdrop.addEventListener("click", () => wrap.classList.remove("expanded"));

    let resetCb = null;
    resetBtn.addEventListener("click", () => {
      if (resetCb) resetCb();
    });

    // auto-resize do textarea
    inEl.addEventListener("input", () => {
      inEl.style.height = "auto";
      inEl.style.height = Math.min(inEl.scrollHeight, 140) + "px";
    });

    chkAll.addEventListener("change", () => {
      doclist
        .querySelectorAll('input[type="checkbox"]')
        .forEach((c) => (c.checked = chkAll.checked));
    });
    function getSelected() {
      return [...doclist.querySelectorAll('input[type="checkbox"]:checked')].map(
        (c) => c.value
      );
    }

    let sendCb = null;
    let configureCb = null;
    function doSend() {
      if (!sendCb) return;
      const t = inEl.value;
      if (!t.trim()) return;
      sendCb(t, getSelected());
      inEl.value = "";
      inEl.style.height = "auto";
    }
    sendBtn.addEventListener("click", doSend);
    inEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        doSend();
      }
    });

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
        statusEl.textContent = "";
        showEmptyHint();
      },
      setDocs(docs) {
        const cur = new Set(getSelected());
        doclist.innerHTML = "";
        for (const d of docs) {
          const row = document.createElement("label");
          row.className = "docrow";
          row.innerHTML =
            `<input type="checkbox" value="${escapeHtml(d.id)}"><span title="${escapeHtml(
              d.titulo
            )}">${escapeHtml(d.titulo)}</span>`;
          if (cur.has(d.id)) row.querySelector("input").checked = true;
          doclist.appendChild(row);
        }
        countEl.textContent = docs.length ? "(" + docs.length + ")" : "";
        if (!docs.length) {
          doclist.innerHTML = '<div class="empty">Nenhuma peça encontrada nesta tela.</div>';
        }
      },
      addMessage(role, text) {
        clearEmptyHint();
        const el = document.createElement("div");
        el.className = "msg " + role;
        if (role === "assistant") el.innerHTML = renderMd(text);
        else el.textContent = text;
        msgs.appendChild(el);
        msgs.scrollTop = msgs.scrollHeight;
        return el;
      },
      updateAssistant(el, fullText) {
        el.innerHTML = renderMd(fullText);
        msgs.scrollTop = msgs.scrollHeight;
      },
      removeMessage(el) {
        if (el) el.remove();
        showEmptyHint();
      },
      setStatus(s) {
        statusEl.textContent = s || "";
      },
      lockInput(b) {
        inEl.disabled = b;
        sendBtn.disabled = b;
      },
    };
  }

  return { mount, _renderMd: renderMd };
})();
