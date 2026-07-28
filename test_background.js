const fs = require("node:fs");
const vm = require("node:vm");
const assert = require("node:assert/strict");

let listener;
let fetchMode = "success";
let lastSignal;
const settings = {apiUrl: "https://example.test/v1/chat/completions", model: "test-model", apiKey: "secret"};
const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
assert.deepEqual(manifest.content_scripts, [{
  matches: ["http://*/*", "https://*/*"],
  js: ["content.js"],
  css: ["content.css"],
  run_at: "document_idle"
}]);
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
    storage: {local: {get: async () => settings}}
  },
  fetch: async (_url, options) => {
    assert.equal(options.headers.Authorization, "Bearer secret");
    lastSignal = options.signal;
    const request = JSON.parse(options.body);
    const paragraphs = JSON.parse(request.messages[1].content).paragraphs;
    if (fetchMode === "success") {
      return {
        ok: true,
        json: async () => ({choices: [{message: {content: JSON.stringify({translations: paragraphs.map(({id}) => ({id, text: `译文-${id}`}))})}}]})
      };
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

function send(message, sender = {tab: {id: 7}}) {
  return new Promise((resolve) => {
    const handled = listener(message, sender, resolve);
    if (handled !== true) resolve(undefined);
  });
}

(async () => {
  const success = await send({type: "BWT_TRANSLATE_BATCH", paragraphs: [{id: "p-1", text: "Hello"}]});
  assert.equal(success.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(success.translations)), [{id: "p-1", text: "译文-p-1"}]);

  fetchMode = "pending";
  const firstPending = send({type: "BWT_TRANSLATE_BATCH", paragraphs: [{id: "p-2", text: "Slow"}]});
  await new Promise((resolve) => setTimeout(resolve));
  const firstSignal = lastSignal;
  const firstCancellation = send({type: "BWT_CANCEL_REQUESTS"});
  const secondPending = send({type: "BWT_TRANSLATE_BATCH", paragraphs: [{id: "p-3", text: "Slow again"}]});
  const firstCancelled = await firstCancellation;
  assert.equal(firstCancelled.cancelled, 1);
  assert.equal(firstSignal.aborted, true);

  await new Promise((resolve) => setTimeout(resolve));
  const secondSignal = lastSignal;
  const secondCancelled = await send({type: "BWT_CANCEL_REQUESTS"});
  assert.equal(secondCancelled.cancelled, 1);
  assert.equal(secondSignal.aborted, true);
  assert.deepEqual(JSON.parse(JSON.stringify(await firstPending)), {ok: false, error: "翻译已取消"});
  assert.deepEqual(JSON.parse(JSON.stringify(await secondPending)), {ok: false, error: "翻译已取消"});
  console.log("background self-check passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
