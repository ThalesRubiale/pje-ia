// Camada de acesso ao PJe. Roda no contexto (mundo isolado) da página dos autos.
// Reutiliza os mecanismos validados ao vivo: timeline no DOM + endpoint REST de download.
var PJE = (function () {
  // Base path do PJe (ex.: "pje1grau"). Deriva da URL para tolerar variações.
  function getBase() {
    return location.pathname.split("/")[1] || "pje1grau";
  }

  // Lê o idProcesso da querystring dos autos.
  function getIdProcesso() {
    return new URLSearchParams(location.search).get("idProcesso");
  }

  // Varre a timeline (#divTimeLine) e devolve [{id, titulo}] sem duplicatas.
  function listarDocumentos() {
    const links = [...document.querySelectorAll("#divTimeLine a")];
    const seen = new Set();
    const out = [];
    for (const a of links) {
      const t = (a.textContent || "").trim().replace(/\s+/g, " ");
      const m = t.match(/^(\d{6,})\s*-\s*(.+)$/);
      if (m && !seen.has(m[1])) {
        seen.add(m[1]);
        out.push({ id: m[1], titulo: t.slice(0, 140) });
      }
    }
    return out;
  }

  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

  // O endpoint de download é STATEFUL: o servidor só autoriza a peça que foi
  // "aberta" na sessão. Quando o download dá 404, disparamos o clique da peça
  // na timeline (A4J) para registrá-la e tentamos de novo. As ativações são
  // serializadas — o JSF não tolera dois submits simultâneos na mesma view.
  let activationChain = Promise.resolve();
  function ativarPeca(id) {
    const run = async () => {
      const link = [...document.querySelectorAll("#divTimeLine a")].find((a) =>
        (a.textContent || "").trim().startsWith(id)
      );
      if (!link) throw new Error("peça " + id + " não está visível na linha do tempo");
      link.click();
      // aguarda o servidor registrar a peça na sessão (poll no próprio download)
      const url =
        "/" + getBase() + "/seam/resource/rest/pje-legacy/documento/download/" + id;
      for (let i = 0; i < 8; i++) {
        await sleep(700);
        const probe = await fetch(url, { method: "HEAD", credentials: "include" });
        if (probe.ok) return;
      }
      throw new Error("o PJe não liberou a peça " + id + " a tempo — tente novamente");
    };
    activationChain = activationChain.then(run, run);
    return activationChain;
  }

  // Baixa uma peça pelo id. Endpoint REST autenticado por cookie de sessão.
  // Retorna {kind:"pdf", b64, size} ou {kind:"text", text} conforme o content-type.
  // Corpo vazio com HTTP 200 é tratado como "peça não liberada na sessão":
  // ativa a peça na timeline e tenta uma segunda vez antes de desistir.
  async function baixar(id) {
    const url =
      "/" + getBase() + "/seam/resource/rest/pje-legacy/documento/download/" + id;
    let r = await fetch(url, { credentials: "include" });
    if (r.status === 404) {
      await ativarPeca(id); // registra a peça na sessão e aguarda liberar
      r = await fetch(url, { credentials: "include" });
    }
    if (!r.ok) throw new Error("falha ao baixar a peça " + id + " (HTTP " + r.status + ")");
    let corpo = await lerCorpo(r, id);
    if (!corpo) {
      await ativarPeca(id);
      r = await fetch(url, { credentials: "include" });
      if (!r.ok) throw new Error("falha ao baixar a peça " + id + " (HTTP " + r.status + ")");
      corpo = await lerCorpo(r, id);
      if (!corpo) {
        throw new Error(
          "a peça " + id + " retornou vazia — abra-a na linha do tempo do processo e tente novamente"
        );
      }
    }
    return corpo;
  }

  // Conta as páginas de um PDF por heurística no binário: ocorrências de
  // "/Type /Page" (objetos de página) com fallback no maior "/Count N" da
  // árvore de páginas. Subconta em PDFs com object streams comprimidos — a
  // estimativa de tokens (count_tokens) é a guarda definitiva nesses casos.
  async function contarPaginas(blob) {
    try {
      const s = new TextDecoder("latin1").decode(await blob.arrayBuffer());
      const m = s.match(/\/Type\s*\/Page[^s]/g);
      if (m && m.length) return m.length;
      let max = 0;
      const re = /\/Count\s+(\d+)/g;
      let mm;
      while ((mm = re.exec(s))) max = Math.max(max, parseInt(mm[1], 10));
      return max || 1;
    } catch {
      return 1;
    }
  }

  // Interpreta o corpo da resposta. Devolve null quando veio vazio
  // (PDF de 0 bytes ou texto em branco após a extração).
  async function lerCorpo(r, id) {
    const ct = (r.headers.get("content-type") || "").toLowerCase();
    if (ct.includes("pdf")) {
      const blob = await r.blob();
      if (!blob.size) {
        console.debug("[PJe IA] peça", id, "PDF de 0 bytes");
        return null;
      }
      const pages = await contarPaginas(blob);
      console.debug("[PJe IA] peça", id, "PDF de", blob.size, "bytes,", pages, "página(s)");
      const b64 = await blobToB64(blob);
      return { kind: "pdf", b64, size: blob.size, pages };
    }
    const raw = await r.text();
    // Peças HTML: extrai só o texto legível (sem tags/scripts) para o modelo.
    let text = raw;
    if (ct.includes("html")) {
      try {
        const doc = new DOMParser().parseFromString(raw, "text/html");
        doc.querySelectorAll("script,style").forEach((n) => n.remove());
        text = (doc.body ? doc.body.textContent : raw).replace(/\n{3,}/g, "\n\n");
      } catch {
        /* mantém o bruto */
      }
    }
    text = text.trim();
    console.debug("[PJe IA] peça", id, "texto de", text.length, "chars (" + ct + ")");
    if (!text) return null;
    return { kind: "text", text };
  }

  // Converte Blob -> base64 puro (sem prefixo data: e sem quebras de linha).
  function blobToB64(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => {
        const s = String(fr.result);
        resolve(s.slice(s.indexOf(",") + 1));
      };
      fr.onerror = reject;
      fr.readAsDataURL(blob);
    });
  }

  return { getBase, getIdProcesso, listarDocumentos, baixar };
})();
