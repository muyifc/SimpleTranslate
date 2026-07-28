(() => {
  const READY_ATTRIBUTE = "data-bwt-content-ready";
  if (document.documentElement.hasAttribute(READY_ATTRIBUTE)) return;
  document.documentElement.setAttribute(READY_ATTRIBUTE, "");

  const CANDIDATE_SELECTOR = "h1,h2,h3,h4,h5,h6,p,li,blockquote,td,th";
  const EXCLUDED_SELECTOR = [
    "script",
    "style",
    "noscript",
    "pre",
    "code",
    "kbd",
    "textarea",
    "input",
    "select",
    '[contenteditable]:not([contenteditable="false"])',
    '[translate="no"]',
    ".notranslate",
    "nav",
    "header",
    "footer",
    ".bwt-translation",
  ].join(",");
  const BATCH_SIZE = 10;
  const BATCH_CHARACTERS = 6000;
  const records = new WeakMap();
  const recordsById = new Map();
  let nextId = 1;
  let enabled = false;
  let currentRun = null;
  let rescanRequested = false;
  let debounceTimer;

  function paragraphText(element) {
    const parts = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node;

    while ((node = walker.nextNode())) {
      const parent = node.parentElement;
      if (
        parent &&
        !parent.closest(EXCLUDED_SELECTOR) &&
        parent.closest(CANDIDATE_SELECTOR) === element
      ) {
        parts.push(node.nodeValue);
      }
    }

    return parts.join("").replace(/\s+/g, " ").trim();
  }

  function isTranslatable(text) {
    // ponytail: Skip unusually large single paragraphs; split them only if real pages need it.
    return text.length >= 2 && text.length <= BATCH_CHARACTERS && !/^[\d\s.,:%+\-–—/()]+$/u.test(text);
  }

  function getRecord(element) {
    let record = records.get(element);
    if (record) return record;

    record = { id: `p-${nextId++}`, element, node: null, status: "idle", text: "" };
    records.set(element, record);
    recordsById.set(record.id, record);
    return record;
  }

  function scan() {
    const roots = [...document.querySelectorAll('article,main,[role="main"]')];
    if (!roots.length && document.body) roots.push(document.body);

    const seen = new Set();
    const pending = [];
    for (const root of roots) {
      for (const element of root.querySelectorAll(CANDIDATE_SELECTOR)) {
        if (seen.has(element) || element.closest(EXCLUDED_SELECTOR)) continue;
        seen.add(element);

        const text = paragraphText(element);
        if (!isTranslatable(text)) continue;

        const record = getRecord(element);
        if (
          record.text === text &&
          (record.status === "pending" || (record.status === "done" && record.node?.isConnected))
        ) {
          continue;
        }

        record.node?.remove();
        record.node = null;
        record.text = text;
        record.status = "pending";
        pending.push({ id: record.id, text });
      }
    }
    return pending;
  }

  function batches(paragraphs) {
    const result = [];
    let batch = [];
    let characters = 0;

    for (const paragraph of paragraphs) {
      if (batch.length && (batch.length >= BATCH_SIZE || characters + paragraph.text.length > BATCH_CHARACTERS)) {
        result.push(batch);
        batch = [];
        characters = 0;
      }
      batch.push(paragraph);
      characters += paragraph.text.length;
    }
    if (batch.length) result.push(batch);
    return result;
  }

  function sendMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve(response);
      });
    });
  }

  function render(record, text) {
    if (record.status !== "pending" || !record.element.isConnected || typeof text !== "string") return false;

    const translation = document.createElement("div");
    translation.className = "bwt-translation";
    translation.dataset.sourceId = record.id;
    translation.lang = "zh-CN";
    translation.dir = "auto";
    translation.textContent = text;

    if (record.element.matches("li,td,th")) record.element.append(translation);
    else record.element.insertAdjacentElement("afterend", translation);

    record.node = translation;
    record.status = "done";
    return true;
  }

  async function translateBatch(paragraphs) {
    const response = await sendMessage({ type: "BWT_TRANSLATE_BATCH", paragraphs });
    if (!response || response.ok === false || !Array.isArray(response.translations)) {
      throw new Error(response?.error || "翻译服务返回了无效结果");
    }

    const translatedIds = new Set();
    for (const translation of response.translations) {
      const record = recordsById.get(translation?.id);
      if (!record) continue;
      if (render(record, translation.text)) translatedIds.add(record.id);
    }

    for (const paragraph of paragraphs) {
      if (!translatedIds.has(paragraph.id)) recordsById.get(paragraph.id).status = "idle";
    }
  }

  async function runTranslation() {
    if (currentRun) {
      rescanRequested = true;
      return currentRun;
    }

    currentRun = (async () => {
      try {
        do {
          rescanRequested = false;
          const paragraphs = scan();
          for (const batch of batches(paragraphs)) {
            if (!enabled) {
              for (const record of recordsById.values()) {
                if (record.status === "pending") record.status = "idle";
              }
              break;
            }
            await translateBatch(batch);
          }
        } while (enabled && rescanRequested);
      } catch (error) {
        for (const record of recordsById.values()) {
          if (record.status === "pending") record.status = "idle";
        }
        throw error;
      }
    })().finally(() => {
      currentRun = null;
    });

    return currentRun;
  }

  function setOriginalOnly(originalOnly) {
    document.documentElement.classList.toggle("bwt-show-original", originalOnly);
    enabled = !originalOnly;
  }

  function removeTranslations() {
    enabled = false;
    document.documentElement.classList.remove("bwt-show-original");
    document.querySelectorAll(".bwt-translation").forEach((node) => node.remove());
    for (const record of recordsById.values()) {
      record.node = null;
      record.status = "idle";
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message?.type?.startsWith("BWT_")) return;

    let action;
    if (["BWT_TRANSLATE", "BWT_TRANSLATE_PAGE", "BWT_SHOW_TRANSLATIONS"].includes(message.type)) {
      setOriginalOnly(false);
      action = runTranslation();
    } else if (message.type === "BWT_SHOW_ORIGINAL" || message.type === "BWT_HIDE_TRANSLATIONS") {
      setOriginalOnly(true);
      action = Promise.resolve();
    } else if (message.type === "BWT_REMOVE_TRANSLATIONS") {
      removeTranslations();
      action = Promise.resolve();
    } else {
      return;
    }

    action.then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  });

  new MutationObserver((mutations) => {
    if (!enabled) return;
    const changed = mutations.some((mutation) => {
      if (mutation.type === "characterData") {
        return !mutation.target.parentElement?.closest(EXCLUDED_SELECTOR);
      }
      return [...mutation.addedNodes].some((node) => {
        if (node.nodeType === Node.TEXT_NODE) return !node.parentElement?.closest(EXCLUDED_SELECTOR);
        return node.nodeType === Node.ELEMENT_NODE && !node.closest(".bwt-translation");
      });
    });
    if (!changed) return;

    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      runTranslation().catch(() => {});
    }, 250);
  }).observe(document.documentElement, { childList: true, characterData: true, subtree: true });
})();
