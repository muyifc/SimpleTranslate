const status = document.querySelector("#status");
const switches = {
  translationEnabled: document.querySelector("#translationEnabled"),
  translationsVisible: document.querySelector("#translationsVisible"),
  floatingVisible: document.querySelector("#floatingVisible"),
};
const selectionSwitch = document.querySelector("#selectionTranslationEnabled");
const actions = {
  translationEnabled: ["BWT_TRANSLATE_PAGE", "BWT_CANCEL_TRANSLATION"],
  translationsVisible: ["BWT_SHOW_TRANSLATIONS", "BWT_HIDE_TRANSLATIONS"],
  floatingVisible: ["BWT_SHOW_FLOATING", "BWT_HIDE_FLOATING"],
};
let tabId;
let activeModels = 0;
let readyModels = 0;

document.querySelector("#openSettings").addEventListener("click", () => chrome.runtime.openOptionsPage());
for (const [name, control] of Object.entries(switches)) {
  control.addEventListener("change", () => updatePage(name, control.checked));
}
selectionSwitch.addEventListener("change", updateSelectionTranslation);

initialize();

async function initialize() {
  try {
    const settings = await loadModelSummary();
    selectionSwitch.checked = settings.selectionTranslationEnabled !== false;
    selectionSwitch.disabled = false;
    const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
    if (!tab?.id || !/^https?:/.test(tab.url || "")) throw new Error("当前页面不支持网页翻译");
    tabId = tab.id;
    applyState((await sendToPage("BWT_GET_STATE", true)).state);
    setStatus("");
  } catch (error) {
    const message = error.message || String(error);
    setStatus(/Receiving end does not exist|Could not establish connection|message port closed/i.test(message) ? "当前页面不支持网页翻译" : message, true);
  }
}

async function loadModelSummary() {
  const settings = await chrome.storage.local.get(["modelConfigs", "apiUrl", "model", "selectionTranslationEnabled"]);
  const configured = Array.isArray(settings.modelConfigs);
  const models = configured ? settings.modelConfigs.filter((config) => config && typeof config === "object" && config.enabled !== false) : [];
  activeModels = configured ? models.length : Number(Boolean(settings.model));
  readyModels = configured ? models.filter(({apiUrl, model}) => apiUrl && model).length : Number(Boolean(settings.apiUrl && settings.model));
  document.querySelector("#modelSummary").textContent = activeModels ? `已启用 ${activeModels} 个模型` : "尚未配置翻译模型";
  return settings;
}

async function updateSelectionTranslation() {
  selectionSwitch.disabled = true;
  try {
    await chrome.storage.local.set({selectionTranslationEnabled: selectionSwitch.checked});
    setStatus("设置已更新");
  } catch (error) {
    selectionSwitch.checked = !selectionSwitch.checked;
    setStatus(error.message || String(error), true);
  } finally {
    selectionSwitch.disabled = false;
  }
}

async function updatePage(name, checked) {
  setBusy(true);
  try {
    if (name === "translationEnabled" && checked && (!activeModels || readyModels < activeModels)) throw new Error("请先在设置页完善并启用模型");
    const response = await sendToPage(actions[name][checked ? 0 : 1]);
    if (response?.ok === false) throw new Error(response.error || "操作失败");
    applyState((await sendToPage("BWT_GET_STATE")).state);
    setStatus(response?.message || "设置已更新");
  } catch (error) {
    setStatus(error.message || String(error), true);
    try {
      applyState((await sendToPage("BWT_GET_STATE")).state);
    } catch {}
  } finally {
    setBusy(false);
  }
}

async function sendToPage(type, inject = false) {
  try {
    return await chrome.tabs.sendMessage(tabId, {type});
  } catch (error) {
    if (!inject || !error.message?.includes("Receiving end does not exist")) throw error;
    await chrome.scripting.insertCSS({target: {tabId}, files: ["content.css"]});
    await chrome.scripting.executeScript({target: {tabId}, files: ["content.js"]});
    return chrome.tabs.sendMessage(tabId, {type});
  }
}

function applyState(state = {}) {
  for (const [name, control] of Object.entries(switches)) control.checked = Boolean(state[name]);
  setBusy(false);
}

function setBusy(busy) {
  for (const control of Object.values(switches)) control.disabled = busy || !tabId;
}

function setStatus(message, error = false) {
  status.textContent = message;
  status.classList.toggle("error", error);
}
