const fs = require("node:fs");
const vm = require("node:vm");
const assert = require("node:assert/strict");

const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
const popupSource = fs.readFileSync("popup.js", "utf8");
assert(manifest.permissions.includes("scripting"));
assert.match(popupSource, /chrome\.scripting\.executeScript/);
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
  const requests = [];
  const context = {
    URL,
    Set,
    Map,
    JSON,
    Error,
    AbortController,
    DOMException,
    setTimeout,
    clearTimeout,
    chrome: {
      runtime: {onMessage: {addListener(fn) { listener = fn; }}},
      storage: {local: {
        get: async (keys) => storageGet(storageState, keys),
        set: async (values) => Object.assign(storageState, values)
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
    get lastSignal() { return lastSignal; },
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
