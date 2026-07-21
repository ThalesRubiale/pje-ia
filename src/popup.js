const apiKeyEl = document.getElementById("apiKey");
const geminiKeyEl = document.getElementById("geminiApiKey");
const modelEl = document.getElementById("model");
const effortEl = document.getElementById("effort");
const customEl = document.getElementById("customPrompt");
const saveBtn = document.getElementById("save");
const saveStatus = document.getElementById("saveStatus");
const chip = document.getElementById("chip");
const chipText = document.getElementById("chipText");
const togglePw = document.getElementById("togglePw");
const togglePwG = document.getElementById("togglePwG");

// O chip reflete a chave do PROVEDOR do modelo selecionado: escolher um
// modelo Gemini sem chave do Google (ou Claude sem chave Anthropic) avisa
// na hora, antes mesmo de salvar.
function ehGemini() {
  return String(modelEl.value || "").startsWith("gemini-");
}
function setChip() {
  const gemini = ehGemini();
  const temChave = gemini ? !!geminiKeyEl.value.trim() : !!apiKeyEl.value.trim();
  chip.className = "status-chip " + (temChave ? "ok" : "warn");
  chipText.textContent = temChave
    ? gemini
      ? "Chave Google configurada"
      : "Chave Anthropic configurada"
    : gemini
      ? "Falta a chave do Google para este modelo"
      : "Falta a chave da Anthropic para este modelo";
}

chrome.storage.local.get(
  ["apiKey", "geminiApiKey", "model", "effort", "customPrompt"],
  (v) => {
    if (v.apiKey) apiKeyEl.value = v.apiKey;
    if (v.geminiApiKey) geminiKeyEl.value = v.geminiApiKey;
    if (v.model) modelEl.value = v.model;
    if (effortEl && v.effort) effortEl.value = v.effort;
    if (customEl && v.customPrompt) customEl.value = v.customPrompt;
    setChip();
  }
);

function ligarToggle(btn, input) {
  btn.addEventListener("click", () => {
    const showing = input.type === "text";
    input.type = showing ? "password" : "text";
    btn.textContent = showing ? "mostrar" : "ocultar";
  });
}
ligarToggle(togglePw, apiKeyEl);
ligarToggle(togglePwG, geminiKeyEl);

modelEl.addEventListener("change", setChip);
apiKeyEl.addEventListener("input", setChip);
geminiKeyEl.addEventListener("input", setChip);

saveBtn.addEventListener("click", () => {
  const apiKey = apiKeyEl.value.trim();
  const geminiApiKey = geminiKeyEl.value.trim();
  const cfg = { apiKey, geminiApiKey, model: modelEl.value };
  if (effortEl) cfg.effort = effortEl.value;
  if (customEl) cfg.customPrompt = customEl.value.trim();
  chrome.storage.local.set(cfg, () => {
    setChip();
    const temChaveDoModelo = ehGemini() ? !!geminiApiKey : !!apiKey;
    saveStatus.textContent = temChaveDoModelo
      ? "Configuração salva ✓"
      : "Salvo — falta a chave do provedor do modelo escolhido.";
    setTimeout(() => (saveStatus.textContent = ""), 2500);
  });
});
