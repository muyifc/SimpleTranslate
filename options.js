const MAX_MODELS = 4;
const modelConfigs = document.querySelector("#modelConfigs");
const addModelButton = document.querySelector("#addModel");
const status = document.querySelector("#status");
const importFile = document.querySelector("#importFile");
let pendingImport = null;

chrome.storage.local.get(["modelConfigs", "apiUrl", "model", "apiKey", "glossary", "nativeLanguage"]).then((settings) => {
  loadSettings(settings);
}).catch((error) => setStatus(error.message || String(error), true));

addModelButton.addEventListener("click", () => {
  addModel({id: newId(), enabled: true});
  modelConfigs.lastElementChild?.querySelector('[data-field="name"]')?.focus();
});
document.querySelector("#save").addEventListener("click", save);
document.querySelector("#clearCache").addEventListener("click", clearCache);
document.querySelector("#exportConfig").addEventListener("click", exportConfig);
document.querySelector("#importConfig").addEventListener("click", () => {
  if (!confirm("导入会覆盖当前模型、母语、术语表和站点规则。仅选择你信任的 JSON 文件。继续吗？")) return;
  importFile.value = "";
  importFile.click();
});
importFile.addEventListener("change", importConfig);

async function save() {
  setBusy(true);
  setStatus("正在保存…");
  try {
    const configs = collectModelConfigs();
    await requestModelPermissions(configs);
    await chrome.storage.local.set({
      modelConfigs: configs,
      glossary: document.querySelector("#glossary").value.trim(),
      nativeLanguage: document.querySelector("#nativeLanguage").value,
      ...(pendingImport ? {siteRules: pendingImport.siteRules} : {}),
    });
    const imported = Boolean(pendingImport);
    pendingImport = null;
    setStatus(imported ? "配置已导入，请妥善保管或删除包含 API Key 的 JSON 文件" : "设置已保存");
  } catch (error) {
    setStatus(error.message || String(error), true);
  } finally {
    setBusy(false);
  }
}

async function exportConfig() {
  if (!confirm("导出的 JSON 包含 API Key，可直接访问你的翻译服务。请勿上传、公开或转发。仍要导出吗？")) return;
  try {
    const {siteRules = {}} = await chrome.storage.local.get("siteRules");
    const payload = {
      format: "bilingual-web-translation-settings",
      version: 1,
      exportedAt: new Date().toISOString(),
      settings: {
        nativeLanguage: document.querySelector("#nativeLanguage").value,
        glossary: document.querySelector("#glossary").value.trim(),
        modelConfigs: collectModelConfigs(),
        siteRules,
      },
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], {type: "application/json"}));
    const link = document.createElement("a");
    link.href = url;
    link.download = `bwt-settings-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
    setStatus("配置已导出，请妥善保管 JSON 文件");
  } catch (error) {
    setStatus(error.message || String(error), true);
  }
}

async function importConfig() {
  const file = importFile.files?.[0];
  if (!file) return;
  pendingImport = null;
  setBusy(true);
  setStatus("正在读取配置…");
  try {
    if (file.size > 1_000_000) throw new Error("配置文件不能超过 1 MB");
    const settings = parseImportedSettings(JSON.parse(await file.text()));
    pendingImport = {siteRules: settings.siteRules};
    loadSettings(settings);
    setStatus("配置文件已读取，请点击“保存设置”完成导入");
  } catch (error) {
    setStatus(error instanceof SyntaxError ? "配置文件不是有效的 JSON" : error.message || String(error), true);
  } finally {
    importFile.value = "";
    setBusy(false);
  }
}

function parseImportedSettings(payload) {
  if (payload?.format !== "bilingual-web-translation-settings" || payload.version !== 1 || !payload.settings || typeof payload.settings !== "object") {
    throw new Error("不是受支持的翻译配置文件");
  }
  const settings = payload.settings;
  const languages = new Set([...document.querySelector("#nativeLanguage").options].map(({value}) => value));
  if (!languages.has(settings.nativeLanguage)) throw new Error("配置文件中的母语不受支持");
  if (typeof settings.glossary !== "string" || settings.glossary.length > 4000) throw new Error("配置文件中的术语表无效");
  if (!Array.isArray(settings.modelConfigs) || !settings.modelConfigs.length || settings.modelConfigs.length > MAX_MODELS) throw new Error("配置文件中的模型数量无效");
  const modelConfigs = settings.modelConfigs.map((config, index) => {
    if (!config || typeof config !== "object") throw new Error("配置文件中的模型无效");
    const text = (field, max) => {
      if (typeof config[field] !== "string" || config[field].length > max) throw new Error(`模型 ${index + 1} 的 ${field} 无效`);
      return config[field];
    };
    return {
      id: typeof config.id === "string" && config.id ? config.id.slice(0, 100) : newId(),
      name: text("name", 100),
      apiUrl: text("apiUrl", 2000),
      model: text("model", 200),
      apiKey: text("apiKey", 10000),
      enabled: config.enabled !== false,
    };
  });
  const entries = Object.entries(settings.siteRules || {});
  if (entries.length > 500 || entries.some(([host, rule]) => !host || host.length > 255 || !rule || typeof rule !== "object" ||
    (rule.selector !== undefined && (typeof rule.selector !== "string" || rule.selector.length > 1000)) ||
    (rule.disabled !== undefined && typeof rule.disabled !== "boolean"))) throw new Error("配置文件中的站点规则无效");
  const siteRules = Object.fromEntries(entries.map(([host, rule]) => [host, {
    ...(rule.selector ? {selector: rule.selector} : {}),
    ...(rule.disabled ? {disabled: true} : {}),
  }]));
  return {nativeLanguage: settings.nativeLanguage, glossary: settings.glossary, modelConfigs, siteRules};
}

async function requestModelPermissions(configs) {
  const active = configs.filter(({enabled}) => enabled);
  if (!active.length) throw new Error("请至少启用一个模型");
  const origins = new Set();
  for (const config of active) {
    if (!config.apiUrl || !config.model) throw new Error(`请完善 ${config.name || "已启用模型"} 的 API 地址和模型`);
    let endpoint;
    try {
      endpoint = new URL(config.apiUrl);
    } catch {
      throw new Error(`${config.name || "已启用模型"} 的 API 地址无效`);
    }
    const localHttp = endpoint.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname);
    if (endpoint.protocol !== "https:" && !localHttp) throw new Error("API 地址必须使用 HTTPS（本机 localhost 可使用 HTTP）");
    origins.add(`${endpoint.protocol}//${endpoint.hostname}/*`);
  }
  if (!await chrome.permissions.request({origins: [...origins]})) throw new Error("需要授权访问已启用模型的翻译 API");
}

function loadSettings(settings) {
  document.querySelector("#glossary").value = settings.glossary || "";
  document.querySelector("#nativeLanguage").value = settings.nativeLanguage || "zh-CN";
  modelConfigs.replaceChildren();
  const configs = Array.isArray(settings.modelConfigs) && settings.modelConfigs.length
    ? settings.modelConfigs.slice(0, MAX_MODELS)
    : [{id: newId(), name: settings.model || "", apiUrl: settings.apiUrl || "", model: settings.model || "", apiKey: settings.apiKey || "", enabled: true}];
  configs.forEach(addModel);
}

async function clearCache() {
  setBusy(true);
  setStatus("正在清空翻译缓存…");
  try {
    const response = await chrome.runtime.sendMessage({type: "BWT_CLEAR_CACHE"});
    if (response?.ok === false) throw new Error(response.error || "清空缓存失败");
    setStatus("翻译缓存已清空");
  } catch (error) {
    setStatus(error.message || String(error), true);
  } finally {
    setBusy(false);
  }
}

function addModel(config = {}) {
  config ||= {};
  if (modelConfigs.children.length >= MAX_MODELS) return;
  const card = document.createElement("fieldset");
  card.className = "model-config";
  card.dataset.id = typeof config.id === "string" && config.id ? config.id : newId();
  card.innerHTML = `
    <legend class="visually-hidden">模型配置</legend>
    <div class="model-config__heading">
      <input data-field="name" type="text" aria-label="配置名称" placeholder="配置名称">
      <label class="enabled"><input data-field="enabled" type="checkbox">启用</label>
      <button data-action="remove" type="button" class="remove" aria-label="删除模型配置">删除</button>
    </div>
    <div class="model-fields">
      <label>API URL<input data-field="apiUrl" type="url" inputmode="url" placeholder="https://api.openai.com/v1/chat/completions"></label>
      <label>模型<input data-field="model" type="text" placeholder="兼容接口的模型名"></label>
      <label>API Key<input data-field="apiKey" type="password" autocomplete="off" placeholder="保存在本机扩展存储中"></label>
    </div>`;
  for (const field of ["name", "apiUrl", "model", "apiKey"]) card.querySelector(`[data-field="${field}"]`).value = config[field] || "";
  card.querySelector('[data-field="enabled"]').checked = config.enabled !== false;
  card.querySelector('[data-field="enabled"]').addEventListener("change", refreshModelState);
  card.querySelector('[data-action="remove"]').addEventListener("click", () => {
    if (modelConfigs.children.length === 1) return;
    card.remove();
    refreshModelState();
  });
  modelConfigs.append(card);
  refreshModelState();
}

function collectModelConfigs() {
  return [...modelConfigs.querySelectorAll(".model-config")].map((card, index) => {
    const value = (field) => card.querySelector(`[data-field="${field}"]`).value.trim();
    const model = value("model");
    return {
      id: card.dataset.id,
      name: value("name") || model || `模型 ${index + 1}`,
      apiUrl: value("apiUrl"),
      model,
      apiKey: value("apiKey"),
      enabled: card.querySelector('[data-field="enabled"]').checked,
    };
  });
}

function refreshModelState() {
  const cards = [...modelConfigs.querySelectorAll(".model-config")];
  document.querySelector("#activeCount").textContent = `已启用 ${cards.filter((card) => card.querySelector('[data-field="enabled"]').checked).length}/${cards.length}`;
  addModelButton.disabled = cards.length >= MAX_MODELS;
  for (const button of modelConfigs.querySelectorAll('[data-action="remove"]')) button.disabled = cards.length === 1;
}

function newId() {
  return crypto.randomUUID?.() || `model-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function setBusy(busy) {
  for (const button of document.querySelectorAll("button")) button.disabled = busy;
  if (!busy) refreshModelState();
}

function setStatus(message, error = false) {
  status.textContent = message;
  status.classList.toggle("error", error);
}
