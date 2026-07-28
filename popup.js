const fields = ["apiUrl", "model", "apiKey"];
const status = document.querySelector("#status");

chrome.storage.local.get(fields).then((settings) => {
  for (const field of fields) document.querySelector(`#${field}`).value = settings[field] || "";
});

document.querySelector("#translate").addEventListener("click", () => run("BWT_TRANSLATE_PAGE", true));
document.querySelector("#cancel").addEventListener("click", () => run("BWT_CANCEL_TRANSLATION"));
document.querySelector("#hide").addEventListener("click", () => run("BWT_HIDE_TRANSLATIONS"));
document.querySelector("#show").addEventListener("click", () => run("BWT_SHOW_TRANSLATIONS"));

async function run(type, saveSettings = false) {
  setBusy(true);
  setStatus(type === "BWT_TRANSLATE_PAGE" ? "正在启动按需翻译…" : type === "BWT_CANCEL_TRANSLATION" ? "正在取消…" : "正在更新页面…");

  try {
    if (saveSettings) {
      const settings = Object.fromEntries(fields.map((field) => [field, document.querySelector(`#${field}`).value.trim()]));
      if (!settings.apiUrl || !settings.model) throw new Error("请填写 API 地址和模型");
      const endpoint = new URL(settings.apiUrl);
      if (!/^https?:$/.test(endpoint.protocol)) throw new Error("API 地址只支持 HTTP 或 HTTPS");
      const granted = await chrome.permissions.request({origins: [`${endpoint.protocol}//${endpoint.hostname}/*`]});
      if (!granted) throw new Error("需要授权访问该翻译 API");
      await chrome.storage.local.set(settings);
    }

    const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
    if (!tab?.id || !/^https?:/.test(tab.url || "")) throw new Error("当前页面不支持注入扩展脚本");

    let result;
    try {
      result = await chrome.tabs.sendMessage(tab.id, {type});
    } catch (error) {
      if (!error.message?.includes("Receiving end does not exist")) throw error;
      await chrome.scripting.insertCSS({target: {tabId: tab.id}, files: ["content.css"]});
      await chrome.scripting.executeScript({target: {tabId: tab.id}, files: ["content.js"]});
      result = await chrome.tabs.sendMessage(tab.id, {type});
    }
    if (result?.ok === false) throw new Error(result.error || "操作失败");
    setStatus(result?.message || "完成");
  } catch (error) {
    const message = error.message || String(error);
    setStatus(message.includes("Receiving end does not exist") ? "请刷新网页后重试" : message, true);
  } finally {
    setBusy(false);
  }
}

function setBusy(busy) {
  for (const button of document.querySelectorAll("button")) button.disabled = busy;
}

function setStatus(message, error = false) {
  status.textContent = message;
  status.classList.toggle("error", error);
}
