const fs = require("node:fs");
const vm = require("node:vm");
const assert = require("node:assert/strict");

let listener;
const settings = {apiUrl: "https://example.test/v1/chat/completions", model: "test-model", apiKey: "secret"};
const context = {
  URL,
  Set,
  JSON,
  Error,
  chrome: {
    runtime: {onMessage: {addListener(fn) { listener = fn; }}},
    storage: {local: {get: async () => settings}}
  },
  fetch: async (_url, options) => {
    assert.equal(options.headers.Authorization, "Bearer secret");
    const request = JSON.parse(options.body);
    const paragraphs = JSON.parse(request.messages[1].content).paragraphs;
    return {
      ok: true,
      json: async () => ({choices: [{message: {content: JSON.stringify({translations: paragraphs.map(({id}) => ({id, text: `译文-${id}`}))})}}]})
    };
  }
};

vm.runInNewContext(fs.readFileSync("background.js", "utf8"), context);
assert.equal(typeof listener, "function");

new Promise((resolve) => {
  const asyncResponse = listener(
    {type: "BWT_TRANSLATE_BATCH", paragraphs: [{id: "p-1", text: "Hello"}]},
    {},
    resolve
  );
  assert.equal(asyncResponse, true);
}).then((response) => {
  assert.equal(response.ok, true);
  assert.equal(JSON.stringify(response.translations), JSON.stringify([{id: "p-1", text: "译文-p-1"}]));
  console.log("background self-check passed");
});
