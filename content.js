(() => {
  if (globalThis.__bwtContentReady) return;
  globalThis.__bwtContentReady = true;
  if (document.contentType !== "text/html") return;

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
    '[class~="sidebar" i]',
    '[id="sidebar" i]',
    '[id^="sidebar-" i]',
    '[id$="-sidebar" i]',
    '[class*="advertisement" i]',
    '[id*="advertisement" i]',
    ".bwt-translation",
    "[data-bwt-control]",
  ].join(",");
  const MAX_PARAGRAPH_CHARACTERS = 6000;
  const MAX_QUICK_CHARACTERS = 1200;
  const MAX_ARTICLE_GUIDE_CHARACTERS = 20_000;
  const NOTES_STORAGE_KEY = "readingNotesV1";
  const MAX_NOTES = 300;
  const MAX_NOTE_CONTENT_CHARACTERS = 10_000;
  // ponytail: Three concurrent requests keeps scrolling responsive without immediately hitting common API limits.
  const MAX_CONCURRENT_REQUESTS = 3;
  const MAX_BATCH_PARAGRAPHS = 3;
  const MAX_BATCH_CHARACTERS = 10000;
  // ponytail: A short dwell filters scrollbar fly-bys; make it configurable only if real usage needs tuning.
  const VIEWPORT_SETTLE_MS = 40;
  // ponytail: A fixed 20ms window coalesces one viewport burst; make it adaptive only if measurements justify it.
  const BATCH_DELAY_MS = 20;
  const records = new WeakMap();
  const recordsById = new Map();
  const queue = [];
  const quickQueue = [];
  const recentContext = [];
  const visibilityTimers = new Map();
  const activeBatches = new Map();
  const cancellingBatches = new Set();
  let visibleElements = new WeakSet();
  const siteKey = location.hostname;
  let nextId = 1;
  let nextQuickId = 1;
  let nextBatchRequestId = 1;
  let progressWave = 0;
  let progressTotal = 0;
  let progressDone = 0;
  let progressActive = false;
  let enabled = false;
  let generation = 0;
  let activeRequests = 0;
  let activeQuickRequests = 0;
  let activeDetections = 0;
  let hasErrors = false;
  let debounceTimer;
  let pumpTimer;
  let floatingButton;
  let floatingLabel;
  let floatingMenu;
  let siteRule = null;
  let activeRoots = [];
  let selectingRegion = false;
  let regionCandidate;
  let stopRegionSelection;
  let quickActions;
  let quickAction;
  let interpretAction;
  let noteAction;
  let quickPanel;
  let articleGuidePanel;
  let articleGuideTitle;
  let articleGuideAction;
  let articleGuideBody;
  let articleGuideGeneration = 0;
  let quickGeneration = 0;
  let hoverTimer;
  let hoverTarget;
  let contextPageUrl = location.href;
  let siteRuleLoaded = !chrome.storage?.local;
  let contextInvalidated = false;
  let prunePending = false;
  let fullScanCount = 0;
  let targetLanguage = "zh-CN";
  let selectionTranslationEnabled = true;

  const preferencesReady = chrome.storage?.local
    ? Promise.resolve().then(() => chrome.storage.local.get(["nativeLanguage", "selectionTranslationEnabled"])).then(({nativeLanguage, selectionTranslationEnabled: storedSelectionTranslationEnabled}) => {
        if (typeof nativeLanguage === "string" && /^[a-z]{2,3}(?:-[A-Z]{2})?$/u.test(nativeLanguage)) targetLanguage = nativeLanguage;
        selectionTranslationEnabled = storedSelectionTranslationEnabled !== false;
      }).catch(handleExtensionError)
    : Promise.resolve();

  const siteRuleReady = chrome.storage?.local
    ? Promise.resolve().then(() => chrome.storage.local.get("siteRules")).then(({siteRules = {}}) => {
        siteRule = siteRules[siteKey] || null;
        siteRuleLoaded = true;
      }).catch((error) => {
        siteRuleLoaded = true;
        handleExtensionError(error);
      })
    : Promise.resolve();

  const viewportObserver = new IntersectionObserver((entries) => {
    if (!enabled) return;
    for (const entry of entries) {
      if (entry.isIntersecting) scheduleVisible(entry.target);
      else deferOffscreen(entry.target);
    }
    refreshFloatingStatus();
  }, {threshold: 0.01});

  function scheduleVisible(element) {
    visibleElements.add(element);
    clearTimeout(visibilityTimers.get(element));
    visibilityTimers.delete(element);
    if (["done", "pending"].includes(records.get(element)?.status)) return;
    const timer = setTimeout(() => {
      visibilityTimers.delete(element);
      if (enabled && visibleElements.has(element) && element.isConnected) enqueue(element);
      refreshFloatingStatus();
    }, VIEWPORT_SETTLE_MS);
    visibilityTimers.set(element, timer);
  }

  function deferOffscreen(element) {
    visibleElements.delete(element);
    clearTimeout(visibilityTimers.get(element));
    visibilityTimers.delete(element);
    const record = records.get(element);
    if (record && ["detecting", "queued", "pending"].includes(record.status)) {
      removeProgress(record);
      record.status = "idle";
      record.node?.remove();
      record.node = null;
    }
    for (const [requestId, jobs] of activeBatches) {
      if (cancellingBatches.has(requestId) || jobs.some(({record: jobRecord}) => visibleElements.has(jobRecord.element))) continue;
      cancellingBatches.add(requestId);
      sendMessage({type: "BWT_CANCEL_REQUEST", requestId}).catch(handleExtensionError);
    }
    schedulePumpQueue();
  }

  function paragraphText(element) {
    const parts = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    let node;

    while ((node = walker.nextNode())) {
      if (node.nodeType === Node.ELEMENT_NODE && node.matches("br")) {
        if (!node.closest(EXCLUDED_SELECTOR) && node.parentElement?.closest(CANDIDATE_SELECTOR) === element) parts.push("\n");
        continue;
      }
      const parent = node.parentElement;
      if (
        node.nodeType === Node.TEXT_NODE &&
        parent &&
        !parent.closest(EXCLUDED_SELECTOR) &&
        parent.closest(CANDIDATE_SELECTOR) === element
      ) {
        parts.push(node.nodeValue.replace(/\s+/g, " "));
      }
    }

    return parts.join("").replace(/ *\n+ */g, "\n").replace(/ {2,}/g, " ").trim();
  }

  function isTranslatable(text) {
    // ponytail: Skip unusually large single paragraphs; split them only if real pages need it.
    return text.length >= 2 && text.length <= MAX_PARAGRAPH_CHARACTERS && !/^[\d\s.,:%+\-–—/()]+$/u.test(text);
  }

  function languageCode(result) {
    const primary = result?.languages?.[0];
    return typeof primary?.language === "string" ? primary.language : "";
  }

  function sameLanguage(left, right) {
    return left && right && left.toLowerCase().split("-")[0] === right.toLowerCase().split("-")[0];
  }

  function detectedSourceLanguage(text, result) {
    const language = languageCode(result);
    const shortAsciiText = text.length <= 80 && /^[\x00-\x7f]*[A-Za-z][\x00-\x7f]*$/u.test(text);
    if (language && (result?.isReliable || (result.languages?.[0]?.percentage || 0) >= 80)) {
      return sameLanguage(language, targetLanguage) ? "" : language;
    }
    // Chrome sometimes labels short English snippets with a low-confidence language.
    return !result?.isReliable && shortAsciiText && !sameLanguage("en", targetLanguage) ? "en" : "";
  }

  function requestContext(includeRecent = true) {
    if (contextPageUrl !== location.href) {
      contextPageUrl = location.href;
      recentContext.length = 0;
    }
    return {
      pageTitle: document.title.slice(0, 300),
      previousText: includeRecent ? recentContext.slice(-3).map(({source, translation}) => `${source}\n${translation}`).join("\n\n").slice(-1600) : "",
    };
  }

  function paragraphContext(element) {
    // ponytail: Batches top out at three paragraphs; build one shared index only if huge pages make this measurable.
    const candidates = [...recordsById.values()].filter((record) =>
      record.element.isConnected && isInActiveRoot(record.element)
    ).sort((left, right) => left.element.compareDocumentPosition(right.element) & Node.DOCUMENT_POSITION_PRECEDING ? 1 : -1);
    const index = candidates.findIndex((record) => record.element === element);
    if (index < 0) return {};
    return {
      beforeText: candidates[index - 1] ? paragraphText(candidates[index - 1].element).slice(-800) : "",
      afterText: candidates[index + 1] ? paragraphText(candidates[index + 1].element).slice(0, 800) : "",
    };
  }

  function rememberContext(source, translation) {
    recentContext.push({source: source.slice(0, 500), translation: translation.slice(0, 500)});
    if (recentContext.length > 6) recentContext.shift();
  }

  function isInActiveRoot(element) {
    return activeRoots.some((root) => root === element || root.contains(element));
  }

  async function saveSiteRule(nextRule) {
    siteRule = nextRule?.selector || nextRule?.disabled ? {
      ...(nextRule.selector ? {selector: nextRule.selector} : {}),
      ...(nextRule.disabled ? {disabled: true} : {}),
    } : null;
    if (!chrome.storage?.local) return;
    const {siteRules = {}} = await chrome.storage.local.get("siteRules");
    if (siteRule) siteRules[siteKey] = siteRule;
    else delete siteRules[siteKey];
    await chrome.storage.local.set({siteRules});
    refreshMenuState();
  }

  function formatTranslation(source, text) {
    const normalized = text.replace(/\r\n?/g, "\n").trim();
    if (!source.includes("\n")) return normalized;
    return normalized
      .replace(/[ \t]+(?=(?:\d+[.)、]|[一二三四五六七八九十]+、|[-•●▪])(?:[ \t]+|$))/g, "\n")
      .replace(/\n{3,}/g, "\n\n");
  }

  function getRecord(element) {
    let record = records.get(element);
    if (record) return record;

    record = {id: `p-${nextId++}`, element, node: null, status: "idle", text: "", translation: "", generation: -1, progressWave: -1, progressDoneWave: -1};
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
      translation.lang = targetLanguage;
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

  function translationMap(translations, expected) {
    if (!Array.isArray(translations) || translations.length !== expected.size) return null;
    const byId = new Map();
    for (const translation of translations) {
      if (!expected.has(translation?.id) || byId.has(translation.id)) return null;
      const variants = typeof translation.text === "string"
        ? [{modelId: "legacy", modelName: "", text: translation.text}]
        : translation.variants;
      if (!Array.isArray(variants) || !variants.length || variants.some(({modelId, modelName, text, error}) =>
        typeof modelId !== "string" || typeof modelName !== "string" || (typeof text !== "string" && typeof error !== "string")
      )) return null;
      byId.set(translation.id, variants);
    }
    return byId;
  }

  function renderVariants(container, source, variants) {
    const formatted = variants.map((variant) => ({
      ...variant,
      ...(typeof variant.text === "string" ? {text: formatTranslation(source, variant.text)} : {}),
    }));
    if (formatted.length === 1 && typeof formatted[0].text === "string") {
      container.textContent = formatted[0].text;
      return formatted;
    }

    container.replaceChildren(...formatted.map((variant, index) => {
      const row = document.createElement("div");
      const label = document.createElement("div");
      const text = document.createElement("div");
      row.className = `bwt-translation__variant${variant.error ? " bwt-translation__variant--error" : ""}`;
      label.className = "bwt-translation__model";
      label.textContent = variant.modelName || `模型 ${index + 1}`;
      text.className = "bwt-translation__text";
      text.textContent = variant.error || variant.text;
      row.append(label, text);
      return row;
    }));
    return formatted;
  }

  function setTranslationVariants(record, source, variants) {
    const failed = variants.some(({error}) => typeof error === "string");
    setTranslation(record, "", failed ? "error" : "done");
    const formatted = renderVariants(record.node, source, variants);
    record.translation = formatted.find(({text}) => typeof text === "string")?.text || "";
    return failed;
  }

  function beginProgressWave() {
    if (progressActive) return;
    progressActive = true;
    progressWave += 1;
    progressTotal = 0;
    progressDone = 0;
  }

  function addProgress(record) {
    beginProgressWave();
    if (record.progressWave === progressWave) return;
    record.progressWave = progressWave;
    record.progressDoneWave = -1;
    progressTotal += 1;
    setFloatingStatus("translating");
  }

  function finishProgress(record) {
    if (!progressActive || record.progressWave !== progressWave || record.progressDoneWave === progressWave) return;
    record.progressDoneWave = progressWave;
    progressDone = Math.min(progressTotal, progressDone + 1);
    setFloatingStatus("translating");
  }

  function removeProgress(record) {
    if (!progressActive || record.progressWave !== progressWave || record.progressDoneWave === progressWave) return;
    record.progressWave = -1;
    progressTotal = Math.max(progressDone, progressTotal - 1);
    setFloatingStatus("translating");
  }

  function setFloatingStatus(status) {
    const progressText = progressTotal ? `${Math.min(progressDone, progressTotal)}/${progressTotal}` : "0/…";
    const states = {
      idle: ["译", "开始按需翻译"],
      translating: [progressText, progressTotal ? `正在翻译，已完成 ${progressText}，点击停止` : "正在分析可见内容，点击停止"],
      ready: ["✓", "当前可见内容已翻译，滚动继续，点击停止"],
      error: ["!", "部分内容翻译失败，点击停止"],
      cancelled: ["停", "翻译已取消，点击重新开始"],
      selecting: ["选", "点击网页正文区域，按 Esc 取消"],
      disabled: ["禁", "此网站已禁用翻译，右键可重新启用"],
    };
    const [text, label] = states[status];
    floatingButton.dataset.status = status;
    floatingButton.dataset.progress = status === "translating" ? progressText : "";
    floatingButton.style.setProperty("--bwt-progress", status === "translating" && progressTotal ? `${Math.round(progressDone / progressTotal * 100)}%` : "0%");
    floatingLabel.textContent = text;
    floatingButton.title = label;
    floatingButton.setAttribute("aria-label", label);
  }

  function refreshFloatingStatus() {
    if (siteRule?.disabled) {
      setFloatingStatus("disabled");
      return;
    }
    if (selectingRegion || !enabled) return;
    if (activeDetections || activeRequests || activeQuickRequests || queue.length || quickQueue.length || visibilityTimers.size) {
      setFloatingStatus("translating");
      return;
    }
    progressDone = progressTotal;
    progressActive = false;
    setFloatingStatus(hasErrors ? "error" : "ready");
  }

  function handleExtensionError(error) {
    if (!/Extension context invalidated/i.test(error?.message || "")) return false;
    contextInvalidated = true;
    enabled = false;
    generation += 1;
    queue.length = 0;
    quickGeneration += 1;
    hideQuickActions();
    if (quickPanel) {
      quickPanel.hidden = false;
      quickPanel.textContent = "扩展已更新，请刷新页面";
    }
    if (floatingButton) {
      setFloatingStatus("error");
      floatingButton.title = "扩展已更新，请刷新页面";
      floatingButton.setAttribute("aria-label", "扩展已更新，请刷新页面");
    }
    return true;
  }

  function setFloatingVisible(visible) {
    if (floatingMenu?.matches(":popover-open")) floatingMenu.hidePopover();
    floatingButton.hidden = !visible;
  }

  function createFloatingButton() {
    const button = document.createElement("button");
    const label = document.createElement("span");
    const menu = document.createElement("div");
    button.type = "button";
    button.className = "bwt-floating-button";
    button.dataset.bwtControl = "";
    button.setAttribute("aria-haspopup", "menu");
    button.setAttribute("aria-controls", "bwt-floating-menu");
    button.setAttribute("aria-expanded", "false");
    label.className = "bwt-floating-label";
    button.append(label);
    menu.id = "bwt-floating-menu";
    menu.className = "bwt-floating-menu";
    menu.dataset.bwtControl = "";
    menu.setAttribute("role", "menu");
    menu.popover = "auto";
    floatingButton = button;
    floatingLabel = label;
    floatingMenu = menu;
    setFloatingStatus("idle");

    const closeMenu = () => menu.matches(":popover-open") && menu.hidePopover();
    let drag;
    let ignoreClick = false;
    const placeButton = (clientX, clientY) => {
      const left = clientX < innerWidth / 2;
      button.style.setProperty("--bwt-top", `${Math.max(26, Math.min(innerHeight - 26, clientY))}px`);
      button.style.setProperty("--bwt-left", left ? "18px" : "auto");
      button.style.setProperty("--bwt-right", left ? "auto" : "18px");
      menu.style.setProperty("--bwt-menu-left", left ? "82px" : "auto");
      menu.style.setProperty("--bwt-menu-right", left ? "auto" : "82px");
    };
    const positionMenu = () => {
      const buttonRect = button.getBoundingClientRect();
      const menuRect = menu.getBoundingClientRect();
      const halfHeight = menuRect.height / 2;
      menu.style.setProperty("--bwt-menu-top", `${Math.max(halfHeight + 8, Math.min(innerHeight - halfHeight - 8, buttonRect.top + 26))}px`);
    };
    const actions = [
      ["article-guide", "文章导读", showArticleGuide],
      ["reading-notes", "阅读笔记", openReadingNotes],
      ["cancel", "取消翻译", cancelTranslation],
      ["retry", "重试失败", retryFailures],
      null,
      ["selection-toggle", "禁用划线翻译", toggleSelectionTranslation],
      ["select-region", "选择翻译区域", beginRegionSelection],
      ["clear-region", "清除区域规则", clearRegionRule],
      null,
      ["site-toggle", "禁用此网站", toggleSite],
      ["original", "恢复原文", () => document.documentElement.classList.add("bwt-show-original")],
      ["translations", "显示译文", () => document.documentElement.classList.remove("bwt-show-original")],
      ["hide-floating", "隐藏悬浮球", () => setFloatingVisible(false)],
    ];
    for (const entry of actions) {
      if (!entry) {
        menu.append(document.createElement("hr"));
        continue;
      }
      const [action, label, handler] = entry;
      const item = document.createElement("button");
      item.type = "button";
      item.dataset.action = action;
      item.setAttribute("role", "menuitem");
      item.textContent = label;
      item.addEventListener("click", () => {
        closeMenu();
        try {
          Promise.resolve(handler()).catch(handleExtensionError);
        } catch (error) {
          handleExtensionError(error);
        }
      });
      menu.append(item);
    }

    button.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      closeMenu();
      drag = {pointerId: event.pointerId, x: event.clientX, y: event.clientY, moved: false};
      button.dataset.dragging = "";
      try { button.setPointerCapture(event.pointerId); } catch {}
    });
    button.addEventListener("pointermove", (event) => {
      if (event.pointerId !== drag?.pointerId) return;
      if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 4) return;
      drag.moved = true;
      placeButton(event.clientX, event.clientY);
    });
    button.addEventListener("pointerup", (event) => {
      if (event.pointerId !== drag?.pointerId) return;
      ignoreClick = drag.moved;
      drag = null;
      delete button.dataset.dragging;
    });
    button.addEventListener("pointercancel", () => {
      drag = null;
      delete button.dataset.dragging;
    });
    button.addEventListener("click", () => {
      if (ignoreClick) {
        ignoreClick = false;
        return;
      }
      closeMenu();
      if (selectingRegion) stopRegionSelection?.();
      else enabled ? cancelTranslation() : startTranslation();
    });
    button.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      refreshMenuState();
      if (!menu.matches(":popover-open")) {
        menu.showPopover();
        positionMenu();
      }
      menu.querySelector("button")?.focus();
    });
    addEventListener("resize", () => {
      const rect = button.getBoundingClientRect();
      placeButton(rect.left + 26, rect.top + 26);
      if (menu.matches(":popover-open")) positionMenu();
    });
    menu.addEventListener("toggle", (event) => button.setAttribute("aria-expanded", String(event.newState === "open")));
    (document.body || document.documentElement).append(button, menu);
  }

  function refreshMenuState() {
    if (!floatingMenu) return;
    const failed = [...recordsById.values()].some((record) => record.status === "error");
    const retry = floatingMenu.querySelector('[data-action="retry"]');
    const clear = floatingMenu.querySelector('[data-action="clear-region"]');
    const toggle = floatingMenu.querySelector('[data-action="site-toggle"]');
    const selectionToggle = floatingMenu.querySelector('[data-action="selection-toggle"]');
    if (retry) retry.disabled = !failed;
    if (clear) clear.disabled = !siteRule?.selector;
    if (toggle) toggle.textContent = siteRule?.disabled ? "启用此网站" : "禁用此网站";
    if (selectionToggle) selectionToggle.textContent = selectionTranslationEnabled ? "禁用划线翻译" : "启用划线翻译";
  }

  function registerCandidates(container) {
    const candidates = container.matches(CANDIDATE_SELECTOR) ? [container, ...container.querySelectorAll(CANDIDATE_SELECTOR)] : container.querySelectorAll(CANDIDATE_SELECTOR);
    let registered = 0;
    for (const element of candidates) {
      if (element.closest(EXCLUDED_SELECTOR)) continue;
      if (element.matches("div") && element.querySelector(`${CANDIDATE_SELECTOR},button`)) continue;
      registered += 1;
      getRecord(element);
      viewportObserver.observe(element);
    }
    return registered;
  }

  function discoverCandidates() {
    fullScanCount += 1;
    let roots = [];
    if (siteRule?.selector) {
      try {
        const selected = document.querySelector(siteRule.selector);
        if (selected && !selected.closest(EXCLUDED_SELECTOR)) roots = [selected];
      } catch {}
    }
    if (!roots.length) {
      for (const selector of ['main article,[role="main"] article', 'main,[role="main"]', "article"]) {
        roots = [...document.querySelectorAll(selector)].filter((root) =>
          !root.closest(EXCLUDED_SELECTOR) && !root.parentElement?.closest(selector)
        );
        if (roots.length > 1) {
          // ponytail: Largest semantic root is the fallback heuristic; the user can save a site region when it misses.
          roots = [roots.reduce((largest, root) => root.textContent.length > largest.textContent.length ? root : largest)];
        }
        if (roots.length) break;
      }
    }
    if (!roots.length && document.body) roots.push(document.body);
    activeRoots = roots;

    let registered = 0;
    for (const root of roots) registered += registerCandidates(root);
    return registered;
  }

  function collectArticleGuideText() {
    const candidates = [...recordsById.values()].filter((record) =>
      record.element.isConnected && isInActiveRoot(record.element)
    ).sort((left, right) => left.element.compareDocumentPosition(right.element) & Node.DOCUMENT_POSITION_PRECEDING ? 1 : -1);
    const parts = [];
    let length = 0;
    let truncated = false;
    for (const {element} of candidates) {
      const text = paragraphText(element);
      if (!text) continue;
      const separator = parts.length ? 2 : 0;
      const remaining = MAX_ARTICLE_GUIDE_CHARACTERS - length - separator;
      if (remaining <= 0) {
        truncated = true;
        break;
      }
      parts.push(text.slice(0, remaining));
      length += separator + Math.min(text.length, remaining);
      if (text.length > remaining) {
        truncated = true;
        break;
      }
    }
    return {text: parts.join("\n\n"), truncated};
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
    beginProgressWave();
    const detectionGeneration = generation;
    record.status = "detecting";
    activeDetections += 1;
    const onDetected = (result) => {
      if (detectionGeneration === generation) activeDetections -= 1;
      if (!enabled || detectionGeneration !== generation || record.status !== "detecting" || record.text !== text) {
        refreshFloatingStatus();
        return;
      }
      const sourceLanguage = detectedSourceLanguage(text, result);
      if (!sourceLanguage) {
        record.node?.remove();
        record.node = null;
        record.status = "skipped";
        refreshFloatingStatus();
        return;
      }

      record.sourceLanguage = sourceLanguage;

      record.node?.remove();
      record.node = null;
      addProgress(record);
      setTranslation(record, "即将翻译…", "queued");
      queue.push({record, text, generation});
      setFloatingStatus("translating");
      schedulePumpQueue();
    };
    try {
      chrome.i18n.detectLanguage(text, onDetected);
    } catch (error) {
      if (detectionGeneration === generation) activeDetections -= 1;
      record.status = "idle";
      handleExtensionError(error);
    }
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

  function sendQuickMessage(message, token) {
    return new Promise((resolve, reject) => {
      quickQueue.push({message, token, resolve, reject});
      pumpQuickQueue();
    });
  }

  function pumpQuickQueue() {
    while (activeRequests + activeQuickRequests < MAX_CONCURRENT_REQUESTS && quickQueue.length) {
      const job = quickQueue.shift();
      if (job.token !== quickGeneration || siteRule?.disabled) {
        job.reject(new Error("翻译已取消"));
        continue;
      }
      activeQuickRequests += 1;
      sendMessage(job.message)
        .then(job.resolve, job.reject)
        .finally(() => {
          activeQuickRequests -= 1;
          pumpQuickQueue();
          pumpQueue();
        });
    }
  }

  async function translate(jobs) {
    const requestId = `page-${generation}-${nextBatchRequestId++}`;
    activeBatches.set(requestId, jobs);
    for (const {record} of jobs) {
      record.requestId = requestId;
      setTranslation(record, "正在翻译…", "pending");
    }

    try {
      const response = await sendMessage({
        type: "BWT_TRANSLATE_BATCH",
        requestId,
        scope: "page",
        sourceLanguage: jobs[0]?.record.sourceLanguage || "auto",
        targetLanguage,
        context: requestContext(false),
        paragraphs: jobs.map(({record, text}) => ({id: record.id, text, ...paragraphContext(record.element)})),
      });
      if (response?.ok === false) throw new Error(response.error || "翻译失败");
      const expected = new Set(jobs.map(({record}) => record.id));
      const byId = translationMap(response?.translations, expected);
      if (!byId) throw new Error("翻译服务返回了无效结果");
      if (jobs.length > 1 && [...byId.values()].some((variants) => variants.some(({error}) => error))) throw new Error("部分模型翻译失败");

      for (const {record, text, generation: jobGeneration} of jobs) {
        if (jobGeneration !== generation || record.requestId !== requestId || record.status !== "pending" || record.text !== text) continue;
        if (setTranslationVariants(record, text, byId.get(record.id))) hasErrors = true;
        finishProgress(record);
        if (record.translation) rememberContext(text, record.translation);
      }
    } catch (error) {
      if (handleExtensionError(error)) return;
      const currentJobs = jobs.filter(({record, text, generation: jobGeneration}) =>
        jobGeneration === generation && enabled && record.requestId === requestId && record.status === "pending" && record.text === text
      );
      if (jobs.length > 1 && currentJobs.length) {
        for (const job of [...currentJobs].reverse()) {
          setTranslation(job.record, "即将翻译…", "queued");
          queue.unshift({...job, single: true});
        }
        return;
      }
      if (!currentJobs.length) return;
      hasErrors = true;
      for (const {record} of currentJobs) {
        setTranslation(record, "翻译失败，请右键悬浮球重试", "error");
        finishProgress(record);
      }
      refreshMenuState();
    } finally {
      activeBatches.delete(requestId);
      cancellingBatches.delete(requestId);
    }
  }

  function schedulePumpQueue() {
    if (pumpTimer) return;
    pumpTimer = setTimeout(() => {
      pumpTimer = null;
      pumpQueue();
    }, BATCH_DELAY_MS);
  }

  function pumpQueue() {
    while (enabled && activeRequests + activeQuickRequests < MAX_CONCURRENT_REQUESTS && queue.length) {
      const jobs = [];
      let batchCharacters = 0;
      while (queue.length && jobs.length < MAX_BATCH_PARAGRAPHS) {
        const job = queue.shift();
        if (job.generation !== generation || job.record.status !== "queued") continue;
        if (jobs.length && job.record.sourceLanguage !== jobs[0].record.sourceLanguage) {
          queue.unshift(job);
          break;
        }
        if (jobs.length && (jobs[0].single || job.single)) {
          queue.unshift(job);
          break;
        }
        if (jobs.length && batchCharacters + job.text.length > MAX_BATCH_CHARACTERS) {
          queue.unshift(job);
          break;
        }
        jobs.push(job);
        batchCharacters += job.text.length;
        if (job.single) break;
      }
      if (!jobs.length) continue;
      activeRequests += 1;
      translate(jobs).finally(() => {
        if (jobs[0].generation === generation) activeRequests -= 1;
        pumpQuickQueue();
        pumpQueue();
        refreshFloatingStatus();
      });
    }
  }

  function retryFailures() {
    if (siteRule?.disabled) return;
    enabled = true;
    hasErrors = false;
    for (const record of recordsById.values()) {
      if (record.status !== "error" || !record.element.isConnected || !isInActiveRoot(record.element)) continue;
      record.node?.remove();
      record.node = null;
      record.status = "idle";
      enqueue(record.element);
    }
    refreshMenuState();
    refreshFloatingStatus();
  }

  function selectorFor(element) {
    if (element.id) {
      const selector = `#${CSS.escape(element.id)}`;
      if (document.querySelectorAll(selector).length === 1) return selector;
    }
    for (const attribute of ["data-testid", "data-test", "data-qa", "role"]) {
      const value = element.getAttribute(attribute);
      if (!value) continue;
      const selector = `${element.localName}[${attribute}="${CSS.escape(value)}"]`;
      if (document.querySelectorAll(selector).length === 1) return selector;
    }

    const parts = [];
    for (let current = element; current && current !== document.body; current = current.parentElement) {
      let part = current.localName;
      const siblings = current.parentElement ? [...current.parentElement.children].filter((node) => node.localName === current.localName) : [];
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      parts.unshift(part);
      const selector = parts.join(" > ");
      if (document.querySelectorAll(selector).length === 1) return selector;
    }
    return "body";
  }

  function regionFromTarget(target) {
    if (!(target instanceof Element) || target.closest(EXCLUDED_SELECTOR)) return null;
    return target.closest('article,main,section,[role="main"],div') || target.closest(CANDIDATE_SELECTOR);
  }

  async function beginRegionSelection() {
    await siteRuleReady;
    if (siteRule?.disabled) {
      setFloatingStatus("disabled");
      return;
    }
    await cancelTranslation();
    selectingRegion = true;
    setFloatingStatus("selecting");

    const cleanup = (status = siteRule?.disabled ? "disabled" : "idle") => {
      selectingRegion = false;
      regionCandidate?.classList.remove("bwt-region-candidate");
      regionCandidate = null;
      document.removeEventListener("mouseover", onHover, true);
      document.removeEventListener("click", onChoose, true);
      document.removeEventListener("keydown", onKeyDown, true);
      stopRegionSelection = null;
      setFloatingStatus(status);
    };
    const onHover = (event) => {
      const candidate = regionFromTarget(event.target);
      if (!candidate || candidate === regionCandidate) return;
      regionCandidate?.classList.remove("bwt-region-candidate");
      regionCandidate = candidate;
      regionCandidate.classList.add("bwt-region-candidate");
    };
    const onChoose = async (event) => {
      if (!regionCandidate) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const selected = regionCandidate;
      cleanup("translating");
      await saveSiteRule({selector: selectorFor(selected)});
      await removeTranslations();
      startTranslation();
    };
    const onKeyDown = (event) => {
      if (event.key === "Escape") cleanup();
    };
    stopRegionSelection = cleanup;
    document.addEventListener("mouseover", onHover, true);
    document.addEventListener("click", onChoose, true);
    document.addEventListener("keydown", onKeyDown, true);
  }

  async function clearRegionRule() {
    await siteRuleReady;
    await saveSiteRule({disabled: siteRule?.disabled});
    await removeTranslations();
    if (!siteRule?.disabled) startTranslation();
  }

  async function toggleSite() {
    await siteRuleReady;
    const disabled = !siteRule?.disabled;
    await saveSiteRule({selector: siteRule?.selector, disabled});
    if (disabled) {
      await cancelTranslation();
      setFloatingStatus("disabled");
    } else {
      setFloatingStatus("idle");
    }
  }

  async function toggleSelectionTranslation() {
    await chrome.storage.local.set({selectionTranslationEnabled: !selectionTranslationEnabled});
  }

  function validNoteUrl(value) {
    try {
      const url = new URL(value);
      return ["http:", "https:"].includes(url.protocol) ? url.href.slice(0, 2000) : "";
    } catch {
      return "";
    }
  }

  function currentNoteUrl() {
    return validNoteUrl(document.querySelector('link[rel="canonical"]')?.href || location.href);
  }

  function normalizedNote(note) {
    if (!note || !["selection", "interpretation", "article-guide"].includes(note.type) || typeof note.id !== "string") return null;
    const createdAt = Number.isFinite(note.createdAt) ? note.createdAt : Date.now();
    const updatedAt = Number.isFinite(note.updatedAt) ? note.updatedAt : createdAt;
    return {
      id: note.id.slice(0, 100),
      type: note.type,
      title: String(note.title || "未命名页面").slice(0, 300),
      url: validNoteUrl(note.url),
      sourceText: String(note.sourceText || "").slice(0, MAX_QUICK_CHARACTERS),
      content: String(note.content || "").slice(0, MAX_NOTE_CONTENT_CHARACTERS),
      createdAt,
      updatedAt,
    };
  }

  async function readNotes() {
    const stored = await chrome.storage.local.get(NOTES_STORAGE_KEY);
    return (Array.isArray(stored[NOTES_STORAGE_KEY]) ? stored[NOTES_STORAGE_KEY] : [])
      .map(normalizedNote).filter(Boolean).sort((left, right) => right.updatedAt - left.updatedAt);
  }

  async function writeNotes(notes) {
    const limited = notes.sort((left, right) => right.updatedAt - left.updatedAt).slice(0, MAX_NOTES);
    await chrome.storage.local.set({[NOTES_STORAGE_KEY]: limited});
    return limited;
  }

  async function addNote(type, sourceText, content) {
    const now = Date.now();
    const note = normalizedNote({
      id: crypto.randomUUID?.() || `note-${now}-${Math.random().toString(16).slice(2)}`,
      type,
      title: document.title,
      url: currentNoteUrl(),
      sourceText,
      content,
      createdAt: now,
      updatedAt: now,
    });
    await writeNotes([note, ...await readNotes()]);
    return note;
  }

  function setDrawer(title, actionLabel = "", actionHandler = null, actionName = "") {
    articleGuideTitle.textContent = title;
    articleGuidePanel.setAttribute("aria-label", title);
    articleGuideAction.hidden = !actionLabel;
    articleGuideAction.disabled = false;
    articleGuideAction.textContent = actionLabel;
    articleGuideAction.onclick = actionHandler;
    articleGuideAction.dataset.action = actionName;
  }

  async function openReadingNotes() {
    const response = await sendMessage({type: "BWT_OPEN_READING_NOTES"});
    if (response?.ok === false) throw new Error(response.error || "打开阅读笔记失败");
  }

  function closeArticleGuide() {
    const wasOpen = articleGuidePanel && !articleGuidePanel.hidden;
    articleGuideGeneration += 1;
    if (articleGuidePanel) articleGuidePanel.hidden = true;
    if (wasOpen) floatingButton?.focus();
  }

  async function showArticleGuide() {
    const token = ++articleGuideGeneration;
    articleGuidePanel.hidden = false;
    setDrawer("文章导读");
    articleGuideBody.textContent = "正在生成文章导读…";
    articleGuidePanel.querySelector('[data-action="close-article-guide"]')?.focus();
    if (!siteRuleLoaded) await siteRuleReady;
    await preferencesReady;
    if (token !== articleGuideGeneration) return;
    if (siteRule?.disabled) {
      articleGuideBody.textContent = "此网站已禁用翻译与解读";
      return;
    }
    if (!activeRoots.some((root) => root.isConnected)) discoverCandidates();
    const article = collectArticleGuideText();
    if (article.text.length < 20) {
      articleGuideBody.textContent = "未识别到足够的正文内容";
      return;
    }
    try {
      const response = await sendMessage({
        type: "BWT_GUIDE_ARTICLE",
        text: article.text,
        sourceLanguage: "auto",
        targetLanguage,
        context: requestContext(false),
      });
      if (response?.ok === false) throw new Error(response.error || "文章导读失败");
      if (typeof response?.guide !== "string" || !response.guide.trim()) throw new Error("导读服务返回了无效结果");
      if (token === articleGuideGeneration) {
        const guide = `${article.truncated ? `已基于前 ${MAX_ARTICLE_GUIDE_CHARACTERS} 字生成\n\n` : ""}${response.guide.trim()}`;
        articleGuideBody.textContent = guide;
        setDrawer("文章导读", "保存导读", async () => {
          articleGuideAction.disabled = true;
          try {
            await addNote("article-guide", "", guide);
            articleGuideAction.textContent = "已保存";
          } catch (error) {
            articleGuideAction.disabled = false;
            articleGuideAction.textContent = error.message || "保存失败";
          }
        }, "save-article-guide");
      }
    } catch (error) {
      if (handleExtensionError(error)) return;
      if (token === articleGuideGeneration) articleGuideBody.textContent = error.message || "文章导读失败";
    }
  }

  function createArticleGuidePanel() {
    const panel = document.createElement("aside");
    const header = document.createElement("header");
    const title = document.createElement("h2");
    const headerActions = document.createElement("div");
    const action = document.createElement("button");
    const close = document.createElement("button");
    const body = document.createElement("div");
    panel.className = "bwt-article-guide";
    panel.dataset.bwtControl = "";
    panel.setAttribute("aria-label", "文章导读");
    panel.hidden = true;
    header.className = "bwt-article-guide__header";
    title.textContent = "文章导读";
    headerActions.className = "bwt-article-guide__actions";
    action.type = "button";
    action.className = "bwt-article-guide__action";
    action.hidden = true;
    close.type = "button";
    close.className = "bwt-article-guide__close";
    close.dataset.action = "close-article-guide";
    close.textContent = "×";
    close.setAttribute("aria-label", "关闭文章导读");
    body.className = "bwt-article-guide__body";
    body.setAttribute("aria-live", "polite");
    close.addEventListener("click", closeArticleGuide);
    headerActions.append(action, close);
    header.append(title, headerActions);
    panel.append(header, body);
    articleGuidePanel = panel;
    articleGuideTitle = title;
    articleGuideAction = action;
    articleGuideBody = body;
    (document.body || document.documentElement).append(panel);
  }

  async function startTranslation() {
    if (!siteRuleLoaded) await siteRuleReady;
    await preferencesReady;
    if (siteRule?.disabled) {
      enabled = false;
      setFloatingStatus("disabled");
      return false;
    }
    enabled = true;
    hasErrors = false;
    progressActive = false;
    progressTotal = 0;
    progressDone = 0;
    for (const timer of visibilityTimers.values()) clearTimeout(timer);
    visibilityTimers.clear();
    visibleElements = new WeakSet();
    viewportObserver.disconnect();
    document.documentElement.classList.remove("bwt-show-original");
    setFloatingStatus("translating");
    if (!discoverCandidates()) refreshFloatingStatus();
    return true;
  }

  async function cancelTranslation() {
    if (selectingRegion) stopRegionSelection?.("cancelled");
    quickGeneration += 1;
    hideQuickActions();
    quickPanel && (quickPanel.hidden = true);
    for (const job of quickQueue.splice(0)) job.reject(new Error("翻译已取消"));
    enabled = false;
    progressActive = false;
    progressTotal = 0;
    progressDone = 0;
    generation += 1;
    clearTimeout(pumpTimer);
    pumpTimer = null;
    activeDetections = 0;
    activeRequests = 0;
    queue.length = 0;
    for (const timer of visibilityTimers.values()) clearTimeout(timer);
    visibilityTimers.clear();
    activeBatches.clear();
    cancellingBatches.clear();
    visibleElements = new WeakSet();
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
    record.translation = "";
    record.generation = -1;
    viewportObserver.unobserve?.(element);
    viewportObserver.observe(element);
  }

  function pruneRecords() {
    // ponytail: recordsById pins removed elements strongly; without pruning, SPA navigation leaks every old article.
    for (const [id, record] of recordsById) {
      if (record.element.isConnected) continue;
      viewportObserver.unobserve(record.element);
      record.node?.remove();
      recordsById.delete(id);
    }
  }

  async function removeTranslations() {
    await cancelTranslation();
    document.documentElement.classList.remove("bwt-show-original");
    document.querySelectorAll(".bwt-translation").forEach((node) => node.remove());
    recentContext.length = 0;
    for (const record of recordsById.values()) {
      record.node = null;
      record.status = "idle";
      record.translation = "";
      record.generation = -1;
    }
  }

  function detectSource(text) {
    if (!isTranslatable(text) || text.length > MAX_QUICK_CHARACTERS) return Promise.resolve(null);
    return new Promise((resolve) => {
      try {
        chrome.i18n.detectLanguage(text, (result) => {
          resolve(detectedSourceLanguage(text, result) || null);
        });
      } catch (error) {
        handleExtensionError(error);
        resolve(null);
      }
    });
  }

  function placeQuickControl(element, rect) {
    const left = Math.max(8, Math.min(innerWidth - 260, rect.left));
    const top = Math.max(8, Math.min(innerHeight - 80, rect.bottom + 8));
    element.style.left = `${left}px`;
    element.style.top = `${top}px`;
  }

  function hideQuickActions() {
    if (quickActions) quickActions.hidden = true;
  }

  function showQuickActions(text, rect) {
    quickAction.dataset.text = text;
    interpretAction.dataset.text = text;
    noteAction.dataset.text = text;
    noteAction.disabled = false;
    noteAction.textContent = "记";
    quickActions.hidden = false;
    quickActions.style.left = `${Math.max(8, Math.min(innerWidth - quickActions.offsetWidth - 8, rect.left))}px`;
    quickActions.style.top = `${Math.max(8, Math.min(innerHeight - quickActions.offsetHeight - 8, rect.bottom + 8))}px`;
  }

  async function showQuickTranslation(text, rect, existingTranslation = "") {
    const token = ++quickGeneration;
    hideQuickActions();
    quickPanel.hidden = false;
    quickPanel.textContent = existingTranslation || "正在翻译…";
    placeQuickControl(quickPanel, rect);
    if (existingTranslation) return;
    if (siteRule?.disabled) {
      quickPanel.textContent = "此网站已禁用翻译";
      return;
    }
    await preferencesReady;
    const sourceLanguage = await detectSource(text);
    if (token !== quickGeneration || siteRule?.disabled) return;
    if (!sourceLanguage) {
      if (token === quickGeneration) quickPanel.textContent = "当前语言无需翻译或无法识别";
      return;
    }

    const id = `quick-${nextQuickId++}`;
    try {
      const response = await sendQuickMessage({
        type: "BWT_TRANSLATE_BATCH",
        scope: "quick",
        sourceLanguage,
        targetLanguage,
        context: requestContext(),
        paragraphs: [{id, text}],
      }, token);
      const byId = translationMap(response?.translations, new Set([id]));
      if (response?.ok === false) throw new Error(response.error || "翻译失败");
      if (!byId) throw new Error("翻译服务返回了无效结果");
      if (token === quickGeneration) renderVariants(quickPanel, text, byId.get(id));
    } catch (error) {
      if (handleExtensionError(error)) return;
      if (token === quickGeneration) quickPanel.textContent = error.message || "翻译失败";
    }
  }

  async function showQuickInterpretation(text, rect) {
    const token = ++quickGeneration;
    hideQuickActions();
    quickPanel.hidden = false;
    quickPanel.textContent = "正在解读…";
    placeQuickControl(quickPanel, rect);
    if (siteRule?.disabled) {
      quickPanel.textContent = "此网站已禁用翻译";
      return;
    }
    await preferencesReady;
    if (token !== quickGeneration || siteRule?.disabled) return;

    try {
      const response = await sendQuickMessage({
        type: "BWT_INTERPRET_TEXT",
        text,
        sourceLanguage: "auto",
        targetLanguage,
        context: requestContext(),
      }, token);
      if (response?.ok === false) throw new Error(response.error || "解读失败");
      if (typeof response?.interpretation !== "string" || !response.interpretation.trim()) throw new Error("解读服务返回了无效结果");
      if (token === quickGeneration) {
        const content = response.interpretation.trim();
        const result = document.createElement("div");
        const save = document.createElement("button");
        result.className = "bwt-quick-result__text";
        result.textContent = content;
        save.type = "button";
        save.className = "bwt-quick-note-save";
        save.dataset.action = "save-quick-note";
        save.textContent = "保存笔记";
        save.addEventListener("click", async () => {
          save.disabled = true;
          try {
            await addNote("interpretation", text, content);
            save.textContent = "已保存";
          } catch (error) {
            save.disabled = false;
            save.textContent = error.message || "保存失败";
          }
        });
        quickPanel.replaceChildren(result, save);
      }
    } catch (error) {
      if (handleExtensionError(error)) return;
      if (token === quickGeneration) quickPanel.textContent = error.message || "解读失败";
    }
  }

  function createQuickControls() {
    quickActions = document.createElement("div");
    quickAction = document.createElement("button");
    interpretAction = document.createElement("button");
    noteAction = document.createElement("button");
    quickPanel = document.createElement("div");
    quickAction.type = "button";
    interpretAction.type = "button";
    noteAction.type = "button";
    quickAction.className = "bwt-selection-action";
    interpretAction.className = "bwt-selection-action";
    noteAction.className = "bwt-selection-action";
    quickAction.dataset.bwtControl = "";
    interpretAction.dataset.bwtControl = "";
    noteAction.dataset.bwtControl = "";
    quickAction.dataset.action = "translate-selection";
    interpretAction.dataset.action = "interpret-selection";
    noteAction.dataset.action = "save-selection-note";
    quickAction.textContent = "译";
    interpretAction.textContent = "释";
    noteAction.textContent = "记";
    quickActions.className = "bwt-selection-actions";
    quickActions.dataset.bwtControl = "";
    quickActions.setAttribute("role", "toolbar");
    quickActions.setAttribute("aria-label", "选中文本操作");
    quickAction.setAttribute("aria-label", "翻译选中文本");
    interpretAction.setAttribute("aria-label", "解读选中文本");
    noteAction.setAttribute("aria-label", "将选中文本记入笔记");
    quickActions.hidden = true;
    quickPanel.className = "bwt-quick-translation";
    quickPanel.dataset.bwtControl = "";
    quickPanel.setAttribute("role", "status");
    quickPanel.setAttribute("aria-live", "polite");
    quickPanel.hidden = true;
    quickActions.append(quickAction, interpretAction, noteAction);
    (document.body || document.documentElement).append(quickActions, quickPanel);

    quickAction.addEventListener("mousedown", (event) => event.preventDefault());
    interpretAction.addEventListener("mousedown", (event) => event.preventDefault());
    noteAction.addEventListener("mousedown", (event) => event.preventDefault());
    quickAction.addEventListener("click", (event) => {
      event.stopPropagation();
      if (!selectionTranslationEnabled) return;
      const rect = quickAction.getBoundingClientRect();
      showQuickTranslation(quickAction.dataset.text || "", rect);
    });
    interpretAction.addEventListener("click", (event) => {
      event.stopPropagation();
      if (!selectionTranslationEnabled) return;
      const rect = interpretAction.getBoundingClientRect();
      showQuickInterpretation(interpretAction.dataset.text || "", rect);
    });
    noteAction.addEventListener("click", async (event) => {
      event.stopPropagation();
      if (!selectionTranslationEnabled || noteAction.disabled) return;
      const text = noteAction.dataset.text || "";
      if (!text) return;
      noteAction.disabled = true;
      try {
        await addNote("selection", "", text);
        if (noteAction.dataset.text === text) noteAction.textContent = "已记";
      } catch (error) {
        if (noteAction.dataset.text === text) {
          noteAction.disabled = false;
          noteAction.textContent = error.message || "保存失败";
        }
      }
    });

    document.addEventListener("mouseup", (event) => setTimeout(async () => {
      await preferencesReady;
      if (!selectionTranslationEnabled) {
        hideQuickActions();
        return;
      }
      if (event.target.closest?.("[data-bwt-control]") || selectingRegion || siteRule?.disabled) return;
      const selection = getSelection();
      const text = selection?.toString().replace(/\s+/g, " ").trim() || "";
      if (!text || text.length > MAX_QUICK_CHARACTERS || !selection.rangeCount) {
        hideQuickActions();
        return;
      }
      const container = selection.getRangeAt(0).commonAncestorContainer;
      const parent = container.nodeType === Node.ELEMENT_NODE ? container : container.parentElement;
      if (parent?.closest(EXCLUDED_SELECTOR)) return;
      showQuickActions(text, selection.getRangeAt(0).getBoundingClientRect());
    }, 0), true);

    document.addEventListener("mouseover", (event) => {
      clearTimeout(hoverTimer);
      if (!event.altKey || selectingRegion || siteRule?.disabled || event.target.closest?.("[data-bwt-control]")) return;
      const element = event.target.closest?.(CANDIDATE_SELECTOR);
      if (!element || element.closest(EXCLUDED_SELECTOR)) return;
      const text = paragraphText(element);
      if (!isTranslatable(text) || text.length > MAX_QUICK_CHARACTERS) return;
      const rect = element.getBoundingClientRect();
      hoverTarget = element;
      hoverTimer = setTimeout(() => {
        const record = records.get(element);
        showQuickTranslation(text, rect, record?.status === "done" ? record.translation : "");
      }, 400);
    }, true);

    document.addEventListener("mouseout", (event) => {
      const element = event.target.closest?.(CANDIDATE_SELECTOR);
      if (!element || element !== hoverTarget || element.contains(event.relatedTarget)) return;
      clearTimeout(hoverTimer);
      hoverTarget = null;
      quickGeneration += 1;
      quickPanel.hidden = true;
    }, true);

    document.addEventListener("click", (event) => {
      if (event.target.closest?.("[data-bwt-control]")) return;
      quickGeneration += 1;
      hideQuickActions();
      quickPanel.hidden = true;
    }, true);

    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      closeArticleGuide();
      quickGeneration += 1;
      hideQuickActions();
      quickPanel.hidden = true;
    }, true);
  }

  // ponytail: Read-only counters for the browser test pages; internal state stays otherwise sealed in the IIFE.
  globalThis.__bwtDebug = {recordCount: () => recordsById.size, fullScans: () => fullScanCount};

  createFloatingButton();
  createArticleGuidePanel();
  createQuickControls();
  chrome.storage?.onChanged?.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes.selectionTranslationEnabled) return;
    selectionTranslationEnabled = changes.selectionTranslationEnabled.newValue !== false;
    if (selectionTranslationEnabled) return;
    quickGeneration += 1;
    hideQuickActions();
    quickPanel.hidden = true;
  });
  siteRuleReady.then(() => {
    refreshMenuState();
    if (siteRule?.disabled) setFloatingStatus("disabled");
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message?.type?.startsWith("BWT_")) return;

    if (message.type === "BWT_GET_STATE") {
      sendResponse({
        ok: true,
        state: {
          translationEnabled: enabled,
          translationsVisible: !document.documentElement.classList.contains("bwt-show-original"),
          floatingVisible: !floatingButton.hidden,
        },
      });
    } else if (["BWT_TRANSLATE", "BWT_TRANSLATE_PAGE"].includes(message.type)) {
      startTranslation()
        .then((started) => sendResponse({ok: started, ...(started ? {message: "已开始按可视区域翻译"} : {error: "此网站已禁用翻译"})}))
        .catch((error) => sendResponse({ok: false, error: error.message}));
      return true;
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
    } else if (message.type === "BWT_HIDE_FLOATING" || message.type === "BWT_SHOW_FLOATING") {
      setFloatingVisible(message.type === "BWT_SHOW_FLOATING");
      sendResponse({ok: true, message: floatingButton.hidden ? "已隐藏悬浮球" : "已显示悬浮球"});
    } else if (message.type === "BWT_REMOVE_TRANSLATIONS") {
      removeTranslations()
        .then(() => sendResponse({ok: true}))
        .catch((error) => sendResponse({ok: false, error: error.message}));
      return true;
    } else {
      return;
    }
  });

  const ROOT_HINT_SELECTOR = 'article,main,[role="main"]';
  const pendingChanged = new Set();
  const pendingAdded = new Set();
  let rescanPending = false;

  new MutationObserver((mutations) => {
    if (!enabled) return;
    let scheduled = false;

    for (const mutation of mutations) {
      if (mutation.type === "characterData") {
        const element = mutation.target.parentElement?.closest(CANDIDATE_SELECTOR);
        if (element && isInActiveRoot(element) && !element.closest(EXCLUDED_SELECTOR)) {
          pendingChanged.add(element);
          scheduled = true;
        }
        continue;
      }
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.TEXT_NODE) {
          const element = node.parentElement?.closest(CANDIDATE_SELECTOR);
          if (element && isInActiveRoot(element) && !element.closest(EXCLUDED_SELECTOR)) {
            pendingChanged.add(element);
            scheduled = true;
          }
          continue;
        }
        if (node.nodeType !== Node.ELEMENT_NODE || node.closest(".bwt-translation")) continue;
        // ponytail: A new semantic root can change which container wins discovery, so only that forces a full rescan.
        if (node.matches(ROOT_HINT_SELECTOR) || node.querySelector(ROOT_HINT_SELECTOR)) rescanPending = true;
        else pendingAdded.add(node);
        scheduled = true;
      }
      if ([...mutation.removedNodes].some((node) => node.nodeType === Node.ELEMENT_NODE && !node.matches(".bwt-translation"))) {
        prunePending = true;
        scheduled = true;
      }
    }
    if (!scheduled) return;

    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const changed = [...pendingChanged];
      const added = [...pendingAdded];
      pendingChanged.clear();
      pendingAdded.clear();
      for (const element of changed) {
        if (element.isConnected) resetRecord(element);
      }
      if (prunePending) {
        prunePending = false;
        pruneRecords();
      }
      const fullScan = rescanPending || !activeRoots.length || activeRoots.some((root) => !root.isConnected);
      rescanPending = false;
      if (fullScan) {
        discoverCandidates();
        return;
      }
      for (const element of added) {
        if (element.isConnected && isInActiveRoot(element) && !element.closest(EXCLUDED_SELECTOR)) registerCandidates(element);
      }
    }, 250);
  }).observe(document.documentElement, {childList: true, characterData: true, subtree: true});
})();
