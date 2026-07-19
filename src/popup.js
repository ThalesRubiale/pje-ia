const apiKeyEl = document.getElementById("apiKey");
const modelEl = document.getElementById("model");
const saveBtn = document.getElementById("save");
const saveStatus = document.getElementById("saveStatus");
const chip = document.getElementById("chip");
const chipText = document.getElementById("chipText");
const togglePw = document.getElementById("togglePw");

function setChip(configured) {
  chip.className = "status-chip " + (configured ? "ok" : "warn");
  chipText.textContent = configured ? "Chave configurada" : "Chave não configurada";
}

chrome.storage.local.get(["apiKey", "model"], (v) => {
  if (v.apiKey) apiKeyEl.value = v.apiKey;
  if (v.model) modelEl.value = v.model;
  setChip(!!v.apiKey);
});

togglePw.addEventListener("click", () => {
  const showing = apiKeyEl.type === "text";
  apiKeyEl.type = showing ? "password" : "text";
  togglePw.textContent = showing ? "mostrar" : "ocultar";
});

saveBtn.addEventListener("click", () => {
  const apiKey = apiKeyEl.value.trim();
  chrome.storage.local.set({ apiKey, model: modelEl.value }, () => {
    setChip(!!apiKey);
    saveStatus.textContent = apiKey ? "Configuração salva ✓" : "Salvo (sem chave).";
    setTimeout(() => (saveStatus.textContent = ""), 2500);
  });
});
