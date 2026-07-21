// ---------------------------------------------------------------------------
// PJe IA — biblioteca de prompts do usuário (título + texto reutilizáveis).
//
// Persistência em chrome.storage.SYNC: os prompts acompanham o usuário em
// qualquer Chrome logado na mesma conta Google (com sincronização ligada);
// sem login/sync a área se comporta como local, sem erro. Cotas do sync:
// 8.192 bytes POR ITEM e ~100 KB no total — por isso cada prompt é gravado
// como um item próprio (chave "plib:<id>"), nunca num array único.
// Trocar a área é mudar só AREA — mas os dados NÃO migram sozinhos.
// ---------------------------------------------------------------------------
const PLIB = (() => {
  const AREA = "sync"; // único ponto de troca sync/local
  const PREFIXO = "plib:";
  // margem sob os 8.192 B/item do sync: a cota conta chave + JSON do valor
  const TETO_BYTES = 7800;

  function area() {
    return chrome.storage[AREA];
  }

  function novoId() {
    try {
      return crypto.randomUUID();
    } catch {
      // harness sem crypto.randomUUID: id por tempo + aleatório basta
      return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
    }
  }

  // Bytes REAIS (UTF-8) que a entrada ocupa no storage — .length de string
  // mentiria com acentos/emoji (multibyte), e texto jurídico é acentuado.
  function bytesDe(p) {
    try {
      return new TextEncoder().encode(PREFIXO + p.id + JSON.stringify(p)).length;
    } catch {
      return Infinity;
    }
  }

  function tamanhoOk(p) {
    return bytesDe(p) <= TETO_BYTES;
  }

  // cb(prompts) — sempre chamada, com [] em qualquer falha (harness sem
  // storage, contexto invalidado…): a UI nunca pode quebrar por causa daqui.
  function listar(cb) {
    try {
      area().get(null, (all) => {
        const out = [];
        for (const k in all || {}) {
          if (k.startsWith(PREFIXO) && all[k] && all[k].id) out.push(all[k]);
        }
        out.sort((a, b) =>
          String(a.titulo || "").localeCompare(String(b.titulo || ""), "pt-BR")
        );
        cb(out);
      });
    } catch {
      cb([]);
    }
  }

  // cb(erro) — string amigável ou null. Valida a cota ANTES do set e checa
  // chrome.runtime.lastError (cota total/rate-limit do sync): nunca falha mudo.
  function salvar(p, cb) {
    if (!tamanhoOk(p)) {
      cb("o prompt excede o limite de sincronização (~6 mil caracteres) — encurte o texto.");
      return;
    }
    try {
      area().set({ [PREFIXO + p.id]: p }, () => {
        cb(chrome.runtime.lastError ? chrome.runtime.lastError.message : null);
      });
    } catch (e) {
      cb(String((e && e.message) || e));
    }
  }

  function excluir(id, cb) {
    try {
      area().remove(PREFIXO + id, () => {
        if (cb) cb(chrome.runtime.lastError ? chrome.runtime.lastError.message : null);
      });
    } catch (e) {
      if (cb) cb(String((e && e.message) || e));
    }
  }

  // Re-lista e entrega ao cb sempre que algum prompt muda — na própria aba,
  // em outra aba ou vindo do sync de outra máquina. Filtra a área e o
  // prefixo: não colide com o onChanged de "local" do content.js.
  function aoMudar(cb) {
    try {
      chrome.storage.onChanged.addListener((ch, areaName) => {
        if (areaName !== AREA) return;
        if (!Object.keys(ch).some((k) => k.startsWith(PREFIXO))) return;
        listar(cb);
      });
    } catch {
      /* sem storage (harness): sem propagação, a lista local segue valendo */
    }
  }

  return { listar, salvar, excluir, tamanhoOk, bytesDe, aoMudar, novoId, TETO_BYTES, _AREA: AREA };
})();
