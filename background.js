const controllersByTab = new Map();
const CACHE_STORAGE_KEY = "translationCacheV1";
const CACHE_PROMPT_VERSION = 1;
const MAX_CACHE_ENTRIES = 300;
const REQUEST_TIMEOUT_MS = 45_000;
// ponytail: Two backoff retries cover throttling bursts; anything longer keeps paragraphs stuck in "pending" too long.
const RETRY_DELAYS_MS = [500, 2000];
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
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  const controllers = controllersByTab.get(tabId) || new Set();
  controllers.add(controller);
  controllersByTab.set(tabId, controllers);

  translateBatch(message.paragraphs, message.sourceLanguage, message.targetLanguage, message.context, controller.signal)
    .then((translations) => sendResponse({ok: true, translations}))
    .catch((error) => sendResponse({
      ok: false,
      error: error.name === "AbortError" ? timedOut ? "翻译请求超时" : "翻译已取消" : error.message || String(error),
    }))
    .finally(() => {
      clearTimeout(timeout);
      controllers.delete(controller);
      if (!controllers.size && controllersByTab.get(tabId) === controllers) controllersByTab.delete(tabId);
    });
  return true;
});

async function getCache() {
  if (!cachePromise) {
    cachePromise = chrome.storage.local.get(CACHE_STORAGE_KEY).then((stored) => {
      const cache = stored[CACHE_STORAGE_KEY];
      if (!cache || typeof cache !== "object" || Array.isArray(cache)) return {};
      // ponytail: Entries from before key hashing embed full paragraph text in the key; drop them instead of migrating.
      for (const key of Object.keys(cache)) {
        if (!/^[0-9a-f]{64}$/.test(key)) delete cache[key];
      }
      return cache;
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

async function cacheKey({apiUrl, model, glossary, sourceLanguage, targetLanguage, context, text}) {
  // ponytail: The rolling previousText changes with scroll order, so keying on it would defeat the persistent cache.
  const material = JSON.stringify([
    CACHE_PROMPT_VERSION,
    apiUrl,
    model,
    glossary,
    sourceLanguage,
    targetLanguage,
    context.pageTitle,
    text,
  ]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, {once: true});
  });
}

async function fetchWithRetry(endpoint, requestInit) {
  for (let attempt = 0; ; attempt += 1) {
    if (attempt) await wait(RETRY_DELAYS_MS[attempt - 1], requestInit.signal);
    let response;
    try {
      response = await fetch(endpoint, requestInit);
    } catch (error) {
      // ponytail: Network failures retry; malformed responses do not, so a broken endpoint never triples the bill.
      if (error?.name === "AbortError" || attempt >= RETRY_DELAYS_MS.length) throw error;
      continue;
    }
    if (response.ok) return response;
    const transient = response.status === 429 || response.status >= 500;
    if (!transient || attempt >= RETRY_DELAYS_MS.length) throw new Error(`翻译接口请求失败（${response.status}）`);
  }
}

function isAllowedEndpoint(endpoint) {
  return endpoint.protocol === "https:" || (endpoint.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname));
}

async function writeCache(cache) {
  const entries = Object.entries(cache);
  if (entries.length > MAX_CACHE_ENTRIES) {
    entries.sort(([, left], [, right]) => (left.at || 0) - (right.at || 0));
    for (const [key] of entries.slice(0, entries.length - MAX_CACHE_ENTRIES)) delete cache[key];
  }
  await chrome.storage.local.set({[CACHE_STORAGE_KEY]: cache}).catch(() => {});
}

let cacheWriteInFlight = null;
let cacheWriteQueued = null;
let cacheWriteQueuedArgs = null;

function persistCache(cache, generation) {
  // ponytail: One storage.set in flight at a time; batches finishing meanwhile share a single follow-up write.
  if (!cacheWriteInFlight) {
    cacheWriteInFlight = writeCache(cache).finally(() => { cacheWriteInFlight = null; });
    return cacheWriteInFlight;
  }
  cacheWriteQueuedArgs = {cache, generation};
  if (!cacheWriteQueued) {
    cacheWriteQueued = cacheWriteInFlight.then(() => {
      const {cache: nextCache, generation: nextGeneration} = cacheWriteQueuedArgs;
      cacheWriteQueued = null;
      cacheWriteQueuedArgs = null;
      if (nextGeneration !== cacheGeneration) return;
      cacheWriteInFlight = writeCache(nextCache).finally(() => { cacheWriteInFlight = null; });
      return cacheWriteInFlight;
    });
  }
  return cacheWriteQueued;
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

  const keys = await Promise.all(paragraphs.map(({text}) => cacheKey({
    apiUrl: endpoint.href,
    model,
    glossary: normalizedGlossary,
    sourceLanguage,
    targetLanguage,
    context: normalizedContext,
    text,
  })));
  paragraphs.forEach((paragraph, index) => {
    const cached = cache[keys[index]];
    if (typeof cached?.text === "string") results.set(paragraph.id, cached.text);
    else misses.push({...paragraph, cacheKey: keys[index]});
  });

  if (misses.length) {
    const headers = {"Content-Type": "application/json"};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const response = await fetchWithRetry(endpoint, {
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
    if (requestCacheGeneration === cacheGeneration) await persistCache(cache, requestCacheGeneration);
  }

  return paragraphs.map(({id}) => ({id, text: results.get(id)}));
}
