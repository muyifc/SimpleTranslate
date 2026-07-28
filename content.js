(() => {
  if (globalThis.__bwtContentReady) return;
  globalThis.__bwtContentReady = true;

  const CANDIDATE_SELECTOR = "h1,h2,h3,h4,h5,h6,p,li,blockquote,td,th,div";
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
    "aside",
    '[role="complementary"]',
    '[role="navigation"]',
    '[role="banner"]',
    '[role="contentinfo"]',
    '[role="toolbar"]',
    '[role="menu"]',
    '[role="dialog"]',
    '[aria-hidden="true"]',
    '[class*="sidebar" i]',
    '[id*="sidebar" i]',
    '[class*="advertisement" i]',
    '[id*="advertisement" i]',
    ".bwt-translation",
    "[data-bwt-control]",
  ].join(",");
  const MAX_PARAGRAPH_CHARACTERS = 6000;
  // ponytail: Three concurrent requests keeps scrolling responsive without immediately hitting common API limits.
  const MAX_CONCURRENT_REQUESTS = 3;
  const records = new WeakMap();
  const recordsById = new Map();
  const queue = [];
  let nextId = 1;
  let enabled = false;
  let generation = 0;
  let activeRequests = 0;
  let activeDetections = 0;
  let hasErrors = false;
  let debounceTimer;
  let floatingButton;

  const viewportObserver = new IntersectionObserver((entries) => {
    if (!enabled) return;
    for (const entry of entries) {
      if (entry.isIntersecting) enqueue(entry.target);
    }
    refreshFloatingStatus();
  }, {threshold: 0.01});

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
    return text.length >= 2 && text.length <= MAX_PARAGRAPH_CHARACTERS && !/^[\d\s.,:%+\-–—/()]+$/u.test(text);
  }

  function getRecord(element) {
    let record = records.get(element);
    if (record) return record;

    record = {id: `p-${nextId++}`, element, node: null, status: "idle", text: "", generation: -1};
    records.set(element, record);
    recordsById.set(record.id, record);
    return record;
  }

  function setTranslation(record, text, status) {
    if (!record?.element.isConnected) return false;

    let translation = record.node;
    if (!translation?.isConnected) {
      translation = document.createElement("div");
      translation.dataset.sourceId = record.id;
      translation.lang = "zh-CN";
      translation.dir = "auto";
      if (record.element.matches("li,td,th")) record.element.append(translation);
      else record.element.insertAdjacentElement("afterend", translation);
      record.node = translation;
    }

    const style = status === "queued" ? "pending" : status;
    translation.className = `bwt-translation bwt-translation--${style}`;
    translation.textContent = text;
    record.status = status;
    return true;
  }

  function setFloatingStatus(status) {
    const states = {
      idle: ["译", "开始按需翻译"],
      translating: ["…", "正在翻译，点击停止"],
      ready: ["✓", "当前可见内容已翻译，滚动继续，点击停止"],
      error: ["!", "部分内容翻译失败，点击停止"],
      cancelled: ["停", "翻译已取消，点击重新开始"],
    };
    const [text, label] = states[status];
    floatingButton.dataset.status = status;
    floatingButton.textContent = text;
    floatingButton.title = label;
    floatingButton.setAttribute("aria-label", label);
  }

  function refreshFloatingStatus() {
    if (!enabled) return;
    setFloatingStatus(activeDetections || activeRequests || queue.length ? "translating" : hasErrors ? "error" : "ready");
  }

  function createFloatingButton() {
    const button = document.createElement("button");
    const menu = document.createElement("div");
    button.type = "button";
    button.className = "bwt-floating-button";
    button.dataset.bwtControl = "";
    button.setAttribute("aria-haspopup", "menu");
    button.setAttribute("aria-controls", "bwt-floating-menu");
    button.setAttribute("aria-expanded", "false");
    menu.id = "bwt-floating-menu";
    menu.className = "bwt-floating-menu";
    menu.dataset.bwtControl = "";
    menu.setAttribute("role", "menu");
    menu.popover = "auto";
    floatingButton = button;
    setFloatingStatus("idle");

    const closeMenu = () => menu.matches(":popover-open") && menu.hidePopover();
    const actions = [
      ["cancel", "取消翻译", cancelTranslation],
      ["original", "恢复原文", () => document.documentElement.classList.add("bwt-show-original")],
      ["translations", "显示译文", () => document.documentElement.classList.remove("bwt-show-original")],
    ];
    for (const [action, label, handler] of actions) {
      const item = document.createElement("button");
      item.type = "button";
      item.dataset.action = action;
      item.setAttribute("role", "menuitem");
      item.textContent = label;
      item.addEventListener("click", () => {
        closeMenu();
        handler();
      });
      menu.append(item);
    }

    button.addEventListener("click", () => {
      closeMenu();
      enabled ? cancelTranslation() : startTranslation();
    });
    button.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      if (!menu.matches(":popover-open")) menu.showPopover();
      menu.querySelector("button")?.focus();
    });
    menu.addEventListener("toggle", (event) => button.setAttribute("aria-expanded", String(event.newState === "open")));
    (document.body || document.documentElement).append(button, menu);
  }

  function discoverCandidates() {
    let roots = [];
    for (const selector of ['main article,[role="main"] article', 'main,[role="main"]', "article"]) {
      roots = [...document.querySelectorAll(selector)].filter((root) =>
        !root.closest(EXCLUDED_SELECTOR) && !root.parentElement?.closest(selector)
      );
      if (roots.length > 1) {
        // ponytail: Largest semantic root is the MVP article heuristic; add site rules when a real page disproves it.
        roots = [roots.reduce((largest, root) => root.textContent.length > largest.textContent.length ? root : largest)];
      }
      if (roots.length) break;
    }
    if (!roots.length && document.body) roots.push(document.body);

    const seen = new Set();
    for (const root of roots) {
      for (const element of root.querySelectorAll(CANDIDATE_SELECTOR)) {
        if (seen.has(element) || element.closest(EXCLUDED_SELECTOR)) continue;
        if (element.matches("div") && element.querySelector(`${CANDIDATE_SELECTOR},button`)) continue;
        seen.add(element);
        getRecord(element);
        viewportObserver.observe(element);
      }
    }
    return seen.size;
  }

  function enqueue(element) {
    if (!enabled || !element.isConnected) return;

    const record = getRecord(element);
    const text = paragraphText(element);
    if (!isTranslatable(text)) return;
    if (record.text === text && record.generation === generation && ["detecting", "skipped", "error"].includes(record.status)) return;
    if (
      record.text === text &&
      record.node?.isConnected &&
      ["queued", "pending", "done"].includes(record.status)
    ) {
      return;
    }

    record.text = text;
    record.generation = generation;
    if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(text)) {
      record.node?.remove();
      record.node = null;
      record.status = "skipped";
      return;
    }

    const detectionGeneration = generation;
    record.status = "detecting";
    activeDetections += 1;
    chrome.i18n.detectLanguage(text, (result) => {
      if (detectionGeneration === generation) activeDetections -= 1;
      if (!enabled || detectionGeneration !== generation || record.status !== "detecting" || record.text !== text) {
        refreshFloatingStatus();
        return;
      }
      const primary = result?.languages?.[0];
      if (!primary?.language?.startsWith("en") || (!result.isReliable && (primary.percentage || 0) < 80)) {
        record.node?.remove();
        record.node = null;
        record.status = "skipped";
        refreshFloatingStatus();
        return;
      }

      record.node?.remove();
      record.node = null;
      setTranslation(record, "即将翻译…", "queued");
      queue.push({record, text, generation});
      setFloatingStatus("translating");
      pumpQueue();
    });
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

  async function translate(job) {
    const {record, text, generation: jobGeneration} = job;
    setTranslation(record, "正在翻译…", "pending");

    try {
      const response = await sendMessage({
        type: "BWT_TRANSLATE_BATCH",
        sourceLanguage: "en",
        paragraphs: [{id: record.id, text}],
      });
      if (jobGeneration !== generation || record.status !== "pending" || record.text !== text) return;
      const [translation] = response?.translations || [];
      if (response?.ok === false) throw new Error(response.error || "翻译失败");
      if (response?.translations?.length !== 1 || translation?.id !== record.id || typeof translation.text !== "string") {
        throw new Error("翻译服务返回了无效结果");
      }
      setTranslation(record, translation.text, "done");
    } catch (error) {
      if (jobGeneration === generation && enabled && record.status === "pending" && record.text === text) {
        hasErrors = true;
        setTranslation(record, "翻译失败，点击扩展重试", "error");
      }
    }
  }

  function pumpQueue() {
    while (enabled && activeRequests < MAX_CONCURRENT_REQUESTS && queue.length) {
      const job = queue.shift();
      if (job.generation !== generation || job.record.status !== "queued") continue;
      activeRequests += 1;
      translate(job).finally(() => {
        if (job.generation === generation) activeRequests -= 1;
        pumpQueue();
        refreshFloatingStatus();
      });
    }
  }

  function startTranslation() {
    enabled = true;
    hasErrors = false;
    viewportObserver.disconnect();
    document.documentElement.classList.remove("bwt-show-original");
    setFloatingStatus("translating");
    if (!discoverCandidates()) refreshFloatingStatus();
  }

  async function cancelTranslation() {
    enabled = false;
    generation += 1;
    activeDetections = 0;
    activeRequests = 0;
    queue.length = 0;
    viewportObserver.disconnect();
    for (const record of recordsById.values()) {
      if (record.status === "detecting") {
        record.status = "idle";
      } else if (["queued", "pending"].includes(record.status)) {
        setTranslation(record, "已取消翻译", "cancelled");
      }
    }
    setFloatingStatus("cancelled");
    const response = await sendMessage({type: "BWT_CANCEL_REQUESTS"}).catch(() => ({ok: true, cancelled: 0}));
    return response;
  }

  function resetRecord(element) {
    const record = records.get(element);
    if (!record) return;
    record.node?.remove();
    record.node = null;
    record.status = "idle";
    record.text = "";
    record.generation = -1;
    viewportObserver.unobserve?.(element);
    viewportObserver.observe(element);
  }

  async function removeTranslations() {
    await cancelTranslation();
    document.documentElement.classList.remove("bwt-show-original");
    document.querySelectorAll(".bwt-translation").forEach((node) => node.remove());
    for (const record of recordsById.values()) {
      record.node = null;
      record.status = "idle";
      record.generation = -1;
    }
  }

  createFloatingButton();

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message?.type?.startsWith("BWT_")) return;

    if (["BWT_TRANSLATE", "BWT_TRANSLATE_PAGE"].includes(message.type)) {
      startTranslation();
      sendResponse({ok: true, message: "已开始按可视区域翻译"});
    } else if (message.type === "BWT_CANCEL_TRANSLATION") {
      cancelTranslation()
        .then((result) => sendResponse({ok: true, message: `已取消翻译（中止 ${result.cancelled || 0} 个请求）`}))
        .catch((error) => sendResponse({ok: false, error: error.message}));
      return true;
    } else if (message.type === "BWT_SHOW_ORIGINAL" || message.type === "BWT_HIDE_TRANSLATIONS") {
      document.documentElement.classList.add("bwt-show-original");
      sendResponse({ok: true, message: "已恢复原文"});
    } else if (message.type === "BWT_SHOW_TRANSLATIONS") {
      document.documentElement.classList.remove("bwt-show-original");
      sendResponse({ok: true, message: "已显示现有译文"});
    } else if (message.type === "BWT_REMOVE_TRANSLATIONS") {
      removeTranslations()
        .then(() => sendResponse({ok: true}))
        .catch((error) => sendResponse({ok: false, error: error.message}));
      return true;
    } else {
      return;
    }
  });

  new MutationObserver((mutations) => {
    if (!enabled) return;
    const changed = new Set();
    let added = false;

    for (const mutation of mutations) {
      if (mutation.type === "characterData") {
        const element = mutation.target.parentElement?.closest(CANDIDATE_SELECTOR);
        if (element && !element.closest(EXCLUDED_SELECTOR)) changed.add(element);
      } else if ([...mutation.addedNodes].some((node) => {
        if (node.nodeType === Node.TEXT_NODE) return !node.parentElement?.closest(EXCLUDED_SELECTOR);
        return node.nodeType === Node.ELEMENT_NODE && !node.closest(".bwt-translation");
      })) {
        added = true;
      }
    }
    if (!added && !changed.size) return;

    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      for (const element of changed) resetRecord(element);
      discoverCandidates();
    }, 250);
  }).observe(document.documentElement, {childList: true, characterData: true, subtree: true});
})();
