const controllersByTab = new Map();
const CACHE_STORAGE_KEY = "translationCacheV1";
const CACHE_PROMPT_VERSION = 1;
const MAX_CACHE_ENTRIES = 300;
let cachePromise;
let cacheGeneration = 0;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  if (message.type === "BWT_CLEAR_CACHE") {
    cacheGeneration += 1;
    cachePromise = Promise.resolve({});
    chrome.storage.local.set({[CACHE_STORAGE_KEY]: {}})
      .then(() => sendResponse({ok: true}))
      .catch((error) => sendResponse({ok: false, error: error.message || String(error)}));
    return true;
  }
  if (message.type === "BWT_CANCEL_REQUESTS") {
    const controllers = controllersByTab.get(tabId) || new Set();
    for (const controller of controllers) controller.abort();
    controllersByTab.delete(tabId);
    sendResponse({ok: true, cancelled: controllers.size});
    return;
  }
  if (message.type !== "BWT_TRANSLATE_BATCH") return;

  const controller = new AbortController();
  const controllers = controllersByTab.get(tabId) || new Set();
  controllers.add(controller);
  controllersByTab.set(tabId, controllers);

  translateBatch(message.paragraphs, message.sourceLanguage, message.targetLanguage, message.context, controller.signal)
    .then((translations) => sendResponse({ok: true, translations}))
    .catch((error) => sendResponse({
      ok: false,
      error: error.name === "AbortError" ? "翻译已取消" : error.message || String(error),
    }))
    .finally(() => {
      controllers.delete(controller);
      if (!controllers.size && controllersByTab.get(tabId) === controllers) controllersByTab.delete(tabId);
    });
  return true;
});

async function getCache() {
  if (!cachePromise) {
    cachePromise = chrome.storage.local.get(CACHE_STORAGE_KEY).then((stored) => {
      const cache = stored[CACHE_STORAGE_KEY];
      return cache && typeof cache === "object" && !Array.isArray(cache) ? cache : {};
    });
  }
  return cachePromise;
}

function safeContext(context) {
  return {
    pageTitle: typeof context?.pageTitle === "string" ? context.pageTitle.slice(0, 300) : "",
    previousText: typeof context?.previousText === "string" ? context.previousText.slice(0, 1600) : "",
  };
}

function cacheKey({apiUrl, model, glossary, sourceLanguage, targetLanguage, context, text}) {
  return JSON.stringify([
    CACHE_PROMPT_VERSION,
    apiUrl,
    model,
    glossary,
    sourceLanguage,
    targetLanguage,
    context.pageTitle,
    context.previousText,
    text,
  ]);
}

function isAllowedEndpoint(endpoint) {
  return endpoint.protocol === "https:" || (endpoint.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname));
}

async function persistCache(cache) {
  const entries = Object.entries(cache);
  if (entries.length > MAX_CACHE_ENTRIES) {
    entries.sort(([, left], [, right]) => (left.at || 0) - (right.at || 0));
    for (const [key] of entries.slice(0, entries.length - MAX_CACHE_ENTRIES)) delete cache[key];
  }
  await chrome.storage.local.set({[CACHE_STORAGE_KEY]: cache}).catch(() => {});
}

async function translateBatch(paragraphs, sourceLanguage = "en", targetLanguage = "zh-CN", context, signal) {
  if (!Array.isArray(paragraphs) || !paragraphs.length) return [];
  if (paragraphs.some(({id, text}) => typeof id !== "string" || typeof text !== "string" || !id || !text)) {
    throw new Error("翻译请求包含无效段落");
  }

  const {apiUrl, model, apiKey, glossary = ""} = await chrome.storage.local.get(["apiUrl", "model", "apiKey", "glossary"]);
  if (!apiUrl || !model) throw new Error("请先在扩展弹窗中填写 API 地址和模型");

  const endpoint = new URL(apiUrl);
  if (!isAllowedEndpoint(endpoint)) throw new Error("API 地址必须使用 HTTPS（本机 localhost 可使用 HTTP）");

  const normalizedGlossary = typeof glossary === "string" ? glossary.trim().slice(0, 4000) : "";
  const normalizedContext = safeContext(context);
  const requestCacheGeneration = cacheGeneration;
  const cache = await getCache();
  const results = new Map();
  const misses = [];

  for (const paragraph of paragraphs) {
    const key = cacheKey({
      apiUrl: endpoint.href,
      model,
      glossary: normalizedGlossary,
      sourceLanguage,
      targetLanguage,
      context: normalizedContext,
      text: paragraph.text,
    });
    const cached = cache[key];
    if (typeof cached?.text === "string") results.set(paragraph.id, cached.text);
    else misses.push({...paragraph, cacheKey: key});
  }

  if (misses.length) {
    const headers = {"Content-Type": "application/json"};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      signal,
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          {
            role: "system",
            content: "You translate web paragraphs. Return only valid JSON matching {\"translations\":[{\"id\":\"...\",\"text\":\"...\"}]}. Preserve every input id exactly. Preserve paragraph breaks, numbered lists, and bullet lists. Mirror the source layout in plain text using escaped newlines, and never add HTML. Use the glossary and page context only for terminology consistency; translate only paragraphs."
          },
          {
            role: "user",
            content: JSON.stringify({
              sourceLanguage,
              targetLanguage,
              glossary: normalizedGlossary,
              context: normalizedContext,
              paragraphs: misses.map(({id, text}) => ({id, text})),
            })
          }
        ]
      })
    });

    if (!response.ok) throw new Error(`翻译接口请求失败（${response.status}）`);

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new Error("翻译接口没有返回有效内容");

    let parsed;
    try {
      parsed = JSON.parse(content.replace(/^```(?:json)?\s*|\s*```$/gi, ""));
    } catch {
      throw new Error("翻译接口返回的不是有效 JSON");
    }

    const expected = new Set(misses.map(({id}) => id));
    const translations = parsed?.translations;
    const seen = new Set();
    const invalid = !Array.isArray(translations) || translations.length !== expected.size || translations.some(({id, text}) => {
      if (!expected.has(id) || seen.has(id) || typeof text !== "string") return true;
      seen.add(id);
      return false;
    });
    if (invalid) throw new Error("翻译接口返回的数据格式不正确");

    const missById = new Map(misses.map((paragraph) => [paragraph.id, paragraph]));
    for (const {id, text} of translations) {
      results.set(id, text);
      if (requestCacheGeneration === cacheGeneration) cache[missById.get(id).cacheKey] = {text, at: Date.now()};
    }
    if (requestCacheGeneration === cacheGeneration) await persistCache(cache);
  }

  return paragraphs.map(({id}) => ({id, text: results.get(id)}));
}
