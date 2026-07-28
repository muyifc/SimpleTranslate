const controllersByTab = new Map();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id;
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

  translateBatch(message.paragraphs, message.sourceLanguage, message.targetLanguage, controller.signal)
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

async function translateBatch(paragraphs, sourceLanguage = "auto", targetLanguage = "zh-CN", signal) {
  if (!Array.isArray(paragraphs) || !paragraphs.length) return [];

  const {apiUrl, model, apiKey} = await chrome.storage.local.get(["apiUrl", "model", "apiKey"]);
  if (!apiUrl || !model) throw new Error("请先在扩展弹窗中填写 API 地址和模型");

  const endpoint = new URL(apiUrl);
  if (!/^https?:$/.test(endpoint.protocol)) throw new Error("API 地址只支持 HTTP 或 HTTPS");

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
          content: "You translate web paragraphs. Return only valid JSON matching {\"translations\":[{\"id\":\"...\",\"text\":\"...\"}]}. Preserve every input id exactly and never add HTML."
        },
        {
          role: "user",
          content: JSON.stringify({sourceLanguage, targetLanguage, paragraphs})
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

  const expected = new Set(paragraphs.map(({id}) => id));
  const translations = parsed?.translations;
  const seen = new Set();
  const invalid = !Array.isArray(translations) || translations.length !== expected.size || translations.some(({id, text}) => {
    if (!expected.has(id) || seen.has(id) || typeof text !== "string") return true;
    seen.add(id);
    return false;
  });
  if (invalid) {
    throw new Error("翻译接口返回的数据格式不正确");
  }
  return translations;
}
