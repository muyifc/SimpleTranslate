const fs = require("node:fs");
const vm = require("node:vm");
const assert = require("node:assert/strict");

const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
const popupSource = fs.readFileSync("popup.js", "utf8");
assert(manifest.permissions.includes("scripting"));
assert.match(popupSource, /chrome\.scripting\.executeScript/);
assert.deepEqual(manifest.icons, {
  16: "icons/icon-16.png",
  32: "icons/icon-32.png",
  48: "icons/icon-48.png",
  128: "icons/icon-128.png"
});
assert.deepEqual(manifest.action.default_icon, manifest.icons);
assert(manifest.web_accessible_resources.some(({resources}) => resources.includes("icons/floating-ball-128.png")));
assert.deepEqual(manifest.content_scripts, [{
  matches: ["http://*/*", "https://*/*"],
  js: ["content.js"],
  css: ["content.css"],
  run_at: "document_idle"
}]);

function storageGet(state, keys) {
  if (keys == null) return {...state};
  if (typeof keys === "string") return {[keys]: state[keys]};
  if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, state[key]]));
  return Object.fromEntries(Object.entries(keys).map(([key, fallback]) => [key, state[key] ?? fallback]));
}

function findTranslationInput(request) {
  for (const message of [...request.messages].reverse()) {
    try {
      const input = JSON.parse(message.content);
      if (Array.isArray(input.paragraphs)) return input;
    } catch {}
  }
  throw new Error("翻译请求中缺少 paragraphs JSON");
}

function createHarness(storageState) {
  let listener;
  let fetchMode = "success";
  let lastSignal;
  let fetchCount = 0;
  let cacheWrites = 0;
  const requests = [];
  const timeoutDelays = [];
  const context = {
    URL,
    Set,
    Map,
    JSON,
    Error,
    AbortController,
    DOMException,
    TextEncoder,
    crypto,
    // 记录 background 内部请求的等待时长，并压缩到 25ms 内让退避测试保持快速。
    setTimeout: (fn, ms, ...args) => {
      timeoutDelays.push(ms);
      return setTimeout(fn, Math.min(ms || 0, 25), ...args);
    },
    clearTimeout,
    chrome: {
      runtime: {onMessage: {addListener(fn) { listener = fn; }}},
      storage: {local: {
        get: async (keys) => storageGet(storageState, keys),
        set: (values) => new Promise((resolve) => {
          if ("translationCacheV1" in values) cacheWrites += 1;
          setTimeout(() => {
            Object.assign(storageState, values);
            resolve();
          }, 5);
        })
      }}
    },
    fetch: async (_url, options) => {
      fetchCount += 1;
      assert.equal(options.headers.Authorization, "Bearer secret");
      lastSignal = options.signal;
      const request = JSON.parse(options.body);
      requests.push(request);
      assert.match(request.messages.map(({content}) => content).join("\n"), /Preserve paragraph breaks, numbered lists, and bullet lists/);
      const input = findTranslationInput(request);
      const successResponse = {
          ok: true,
          json: async () => ({choices: [{message: {content: JSON.stringify({
            translations: input.paragraphs.map(({id}) => ({id, text: `译文-${id}`}))
          })}}]})
        };
      if (fetchMode === "success") return successResponse;
      if (fetchMode === "delayedSuccess") return new Promise((resolve) => setTimeout(() => resolve(successResponse), 50));
      if (fetchMode === "flaky429") return fetchCount === 1 ? {ok: false, status: 429} : successResponse;
      if (fetchMode === "always429") return {ok: false, status: 429};
      if (fetchMode === "badRequest") return {ok: false, status: 400};
      if (fetchMode === "networkErrorOnce") {
        if (fetchCount === 1) throw new TypeError("network down");
        return successResponse;
      }
      if (fetchMode === "hung") {
        return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        }, {once: true}));
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 1000);
        options.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    }
  };

  vm.runInNewContext(fs.readFileSync("background.js", "utf8"), context);
  assert.equal(typeof listener, "function");

  return {
    get fetchCount() { return fetchCount; },
    get cacheWrites() { return cacheWrites; },
    get lastSignal() { return lastSignal; },
    timeoutDelays,
    requests,
    setFetchMode(mode) { fetchMode = mode; },
    send(message, sender = {tab: {id: 7}}) {
      return new Promise((resolve) => {
        const handled = listener(message, sender, resolve);
        if (handled !== true) resolve(undefined);
      });
    }
  };
}

function settings(overrides = {}) {
  return {
    apiUrl: "https://example.test/v1/chat/completions",
    model: "test-model",
    apiKey: "secret",
    glossary: "agent=智能体\ncockpit=座舱",
    ...overrides
  };
}

const tests = [];
function test(name, run) {
  tests.push({name, run});
}

test("translates a valid paragraph batch", async () => {
  const harness = createHarness(settings());
  const success = await harness.send({type: "BWT_TRANSLATE_BATCH", paragraphs: [
    {id: "p-1", text: "Hello"},
    {id: "p-2", text: "World"},
    {id: "p-3", text: "Again"},
  ]});
  assert.equal(success.ok, true);
  assert.equal(harness.fetchCount, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(success.translations)), [
    {id: "p-1", text: "译文-p-1"},
    {id: "p-2", text: "译文-p-2"},
    {id: "p-3", text: "译文-p-3"},
  ]);
});

test("persists translations and avoids a second identical API fetch after worker restart", async () => {
  const storageState = settings();
  const message = {
    type: "BWT_TRANSLATE_BATCH",
    sourceLanguage: "en",
    targetLanguage: "zh-CN",
    context: {pageTitle: "Autonomous agents", previousText: "An article about autonomous agents."},
    paragraphs: [{id: "cache-1", text: "The agent entered the cockpit."}]
  };
  const firstWorker = createHarness(storageState);
  assert.equal((await firstWorker.send(message)).ok, true);
  assert.equal(firstWorker.fetchCount, 1);

  const restartedWorker = createHarness(storageState);
  assert.equal((await restartedWorker.send(message)).ok, true);
  assert.equal(restartedWorker.fetchCount, 0, "相同请求在后台重启后应从 chrome.storage.local 缓存读取");
});

test("reuses cached translations when only the rolling context differs", async () => {
  const storageState = settings();
  const baseMessage = {
    type: "BWT_TRANSLATE_BATCH",
    sourceLanguage: "en",
    targetLanguage: "zh-CN",
    context: {pageTitle: "Autonomous agents", previousText: "First rolling context."},
    paragraphs: [{id: "ctx-vary-1", text: "The agent entered the cockpit."}]
  };
  const firstWorker = createHarness(storageState);
  assert.equal((await firstWorker.send(baseMessage)).ok, true);
  assert.equal(firstWorker.fetchCount, 1);

  const restartedWorker = createHarness(storageState);
  const laterMessage = {
    ...baseMessage,
    context: {pageTitle: "Autonomous agents", previousText: "A completely different rolling context accumulated while scrolling."}
  };
  assert.equal((await restartedWorker.send(laterMessage)).ok, true);
  assert.equal(restartedWorker.fetchCount, 0, "滚动上下文变化不应导致持久缓存未命中");
});

test("separates cached translations by model, glossary, source language, and target language", async () => {
  const storageState = settings();
  const baseMessage = {
    type: "BWT_TRANSLATE_BATCH",
    sourceLanguage: "en",
    targetLanguage: "zh-CN",
    paragraphs: [{id: "vary-1", text: "The agent entered the cockpit."}]
  };
  await createHarness(storageState).send(baseMessage);

  const variants = [
    {settings: {model: "another-model"}, message: baseMessage, label: "model"},
    {settings: {glossary: "agent=代理\ncockpit=驾驶舱"}, message: baseMessage, label: "glossary"},
    {settings: {}, message: {...baseMessage, sourceLanguage: "fr"}, label: "source language"},
    {settings: {}, message: {...baseMessage, targetLanguage: "ja"}, label: "target language"}
  ];

  for (const variant of variants) {
    Object.assign(storageState, settings(variant.settings));
    const worker = createHarness(storageState);
    assert.equal((await worker.send(variant.message)).ok, true);
    assert.equal(worker.fetchCount, 1, `缓存键必须包含 ${variant.label}`);
  }
});

test("stores hashed cache keys and coalesces writes for concurrent batches", async () => {
  const storageState = settings();
  const harness = createHarness(storageState);
  const responses = await Promise.all(["one", "two", "three"].map((word, index) => harness.send({
    type: "BWT_TRANSLATE_BATCH",
    paragraphs: [{id: `co-${index}`, text: `Concurrent paragraph ${word}`}]
  })));
  assert(responses.every((response) => response.ok));
  assert.equal(harness.fetchCount, 3);

  const keys = Object.keys(storageState.translationCacheV1 || {});
  assert.equal(keys.length, 3);
  assert(keys.every((key) => /^[0-9a-f]{64}$/.test(key)), "缓存键应为定长哈希，而不是包含原文的 JSON 字符串");
  assert(harness.cacheWrites < 3, `并发批次完成后的缓存写入应合并（实际写入 ${harness.cacheWrites} 次）`);
});

test("drops legacy full-text cache entries on load", async () => {
  const legacyKey = JSON.stringify([1, "https://example.test/v1/chat/completions", "test-model", "", "en", "zh-CN", "Old title", "Legacy cached paragraph"]);
  const storageState = settings({translationCacheV1: {[legacyKey]: {text: "旧译文", at: 1}}});
  const harness = createHarness(storageState);
  assert.equal((await harness.send({type: "BWT_TRANSLATE_BATCH", paragraphs: [{id: "m-1", text: "Fresh paragraph"}]})).ok, true);

  const keys = Object.keys(storageState.translationCacheV1);
  assert(!keys.includes(legacyKey), "旧格式的全文键条目应在加载时被清理");
  assert.equal(keys.length, 1);
});

test("adds the configured glossary and page context without translating context as paragraphs", async () => {
  const harness = createHarness(settings());
  const currentParagraphs = [{id: "current-1", text: "The agent entered the cockpit."}];
  const pageContext = "Earlier, the article defined the agent as an autonomous assistant.";
  const response = await harness.send({
    type: "BWT_TRANSLATE_BATCH",
    sourceLanguage: "en",
    targetLanguage: "zh-CN",
    context: {pageTitle: "Agent article", previousText: pageContext},
    paragraphs: currentParagraphs
  });

  const request = harness.requests[0];
  const prompt = request.messages.map(({content}) => content).join("\n");
  assert.match(prompt, /agent=智能体/);
  assert.match(prompt, /cockpit=座舱/);
  assert.match(prompt, new RegExp(pageContext.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.deepEqual(JSON.parse(JSON.stringify(findTranslationInput(request).paragraphs)), currentParagraphs);
  assert.deepEqual(JSON.parse(JSON.stringify(response.translations)), [{id: "current-1", text: "译文-current-1"}]);
});

test("clears the persisted translation cache", async () => {
  const storageState = settings();
  const harness = createHarness(storageState);
  await harness.send({type: "BWT_TRANSLATE_BATCH", paragraphs: [{id: "clear-1", text: "Cached text"}]});
  assert(Object.keys(storageState.translationCacheV1 || {}).length > 0);
  assert.equal((await harness.send({type: "BWT_CLEAR_CACHE"})).ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(storageState.translationCacheV1)), {});
});

test("does not let an in-flight request restore a cleared cache", async () => {
  const storageState = settings();
  const harness = createHarness(storageState);
  harness.setFetchMode("delayedSuccess");
  const pending = harness.send({type: "BWT_TRANSLATE_BATCH", paragraphs: [{id: "clear-race", text: "Private cached text"}]});
  await new Promise((resolve) => setTimeout(resolve, 10));
  await harness.send({type: "BWT_CLEAR_CACHE"});
  assert.equal((await pending).ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(storageState.translationCacheV1)), {});
});

test("retries a transient 429 response with backoff", async () => {
  const harness = createHarness(settings());
  harness.setFetchMode("flaky429");
  const response = await harness.send({type: "BWT_TRANSLATE_BATCH", paragraphs: [{id: "retry-1", text: "Retry after throttling"}]});
  assert.equal(response.ok, true);
  assert.equal(harness.fetchCount, 2, "429 后应自动重试一次");
  assert(harness.timeoutDelays.some((ms) => ms >= 400), "重试前应有退避等待");
});

test("retries a transient network failure", async () => {
  const harness = createHarness(settings());
  harness.setFetchMode("networkErrorOnce");
  const response = await harness.send({type: "BWT_TRANSLATE_BATCH", paragraphs: [{id: "retry-2", text: "Retry after network failure"}]});
  assert.equal(response.ok, true);
  assert.equal(harness.fetchCount, 2, "网络错误后应自动重试一次");
});

test("does not retry non-transient client errors", async () => {
  const harness = createHarness(settings());
  harness.setFetchMode("badRequest");
  const response = await harness.send({type: "BWT_TRANSLATE_BATCH", paragraphs: [{id: "retry-3", text: "Bad request stays failed"}]});
  assert.equal(response.ok, false);
  assert.match(response.error, /400/);
  assert.equal(harness.fetchCount, 1, "400 不应触发重试");
});

test("times out a hung translation request", async () => {
  const harness = createHarness(settings());
  harness.setFetchMode("hung");
  const response = await Promise.race([
    harness.send({type: "BWT_TRANSLATE_BATCH", paragraphs: [{id: "timeout-1", text: "Never returns"}]}),
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error("翻译请求没有自动超时")), 200)),
  ]);
  assert.equal(response.ok, false);
  assert.match(response.error, /超时/);
  assert.equal(harness.lastSignal.aborted, true);
  assert(harness.timeoutDelays.some((ms) => ms >= 30000), "应设置明确的请求超时");
});

test("abort during backoff cancels immediately without another attempt", async () => {
  const harness = createHarness(settings());
  harness.setFetchMode("always429");
  const pending = harness.send({type: "BWT_TRANSLATE_BATCH", paragraphs: [{id: "retry-4", text: "Cancel during backoff"}]});
  await new Promise((resolve) => setTimeout(resolve, 5));
  await harness.send({type: "BWT_CANCEL_REQUESTS"});
  const response = await pending;
  assert.deepEqual(JSON.parse(JSON.stringify(response)), {ok: false, error: "翻译已取消"});
  assert.equal(harness.fetchCount, 1, "取消后不应再发起重试请求");
});

test("cancels each pending request for the active tab", async () => {
  const harness = createHarness(settings());
  harness.setFetchMode("pending");
  const firstPending = harness.send({type: "BWT_TRANSLATE_BATCH", paragraphs: [{id: "p-2", text: "Slow"}]});
  await new Promise((resolve) => setTimeout(resolve));
  const firstSignal = harness.lastSignal;
  const firstCancellation = harness.send({type: "BWT_CANCEL_REQUESTS"});
  const secondPending = harness.send({type: "BWT_TRANSLATE_BATCH", paragraphs: [{id: "p-3", text: "Slow again"}]});
  const firstCancelled = await firstCancellation;
  assert.equal(firstCancelled.cancelled, 1);
  assert.equal(firstSignal.aborted, true);

  await new Promise((resolve) => setTimeout(resolve));
  const secondSignal = harness.lastSignal;
  const secondCancelled = await harness.send({type: "BWT_CANCEL_REQUESTS"});
  assert.equal(secondCancelled.cancelled, 1);
  assert.equal(secondSignal.aborted, true);
  assert.deepEqual(JSON.parse(JSON.stringify(await firstPending)), {ok: false, error: "翻译已取消"});
  assert.deepEqual(JSON.parse(JSON.stringify(await secondPending)), {ok: false, error: "翻译已取消"});
});

(async () => {
  let failures = 0;
  for (const {name, run} of tests) {
    try {
      await run();
      console.log(`ok - ${name}`);
    } catch (error) {
      failures += 1;
      console.error(`not ok - ${name}`);
      console.error(error);
    }
  }
  if (failures) {
    process.exitCode = 1;
    return;
  }
  console.log("background self-check passed");
})();
