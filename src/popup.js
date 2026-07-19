const apiKeyEl = document.getElementById("apiKey");
const modelEl = document.getElementById("model");
const effortEl = document.getElementById("effort");
const saveBtn = document.getElementById("save");
const saveStatus = document.getElementById("saveStatus");
const chip = document.getElementById("chip");
const chipText = document.getElementById("chipText");
const togglePw = document.getElementById("togglePw");

function setChip(configured) {
  chip.className = "status-chip " + (configured ? "ok" : "warn");
  chipText.textContent = configured ? "Chave configurada" : "Chave não configurada";
}

chrome.storage.local.get(["apiKey", "model", "effort"], (v) => {
  if (v.apiKey) apiKeyEl.value = v.apiKey;
  if (v.model) modelEl.value = v.model;
  if (effortEl && v.effort) effortEl.value = v.effort;
  setChip(!!v.apiKey);
});

togglePw.addEventListener("click", () => {
  const showing = apiKeyEl.type === "text";
  apiKeyEl.type = showing ? "password" : "text";
  togglePw.textContent = showing ? "mostrar" : "ocultar";
});

saveBtn.addEventListener("click", () => {
  const apiKey = apiKeyEl.value.trim();
  const cfg = { apiKey, model: modelEl.value };
  if (effortEl) cfg.effort = effortEl.value;
  chrome.storage.local.set(cfg, () => {
    setChip(!!apiKey);
    saveStatus.textContent = apiKey ? "Configuração salva ✓" : "Salvo (sem chave).";
    setTimeout(() => (saveStatus.textContent = ""), 2500);
  });
});
