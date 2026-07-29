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
  // ponytail: Three concurrent requests keeps scrolling responsive without immediately hitting common API limits.
  const MAX_CONCURRENT_REQUESTS = 3;
  const MAX_BATCH_PARAGRAPHS = 3;
  // ponytail: A fixed 20ms window coalesces one viewport burst; make it adaptive only if measurements justify it.
  const BATCH_DELAY_MS = 20;
  const records = new WeakMap();
  const recordsById = new Map();
  const queue = [];
  const quickQueue = [];
  const recentContext = [];
  const siteKey = location.hostname;
  let nextId = 1;
  let nextQuickId = 1;
  let enabled = false;
  let generation = 0;
  let activeRequests = 0;
  let activeQuickRequests = 0;
  let activeDetections = 0;
  let hasErrors = false;
  let debounceTimer;
  let pumpTimer;
  let floatingButton;
  let floatingMenu;
  let siteRule = null;
  let activeRoots = [];
  let selectingRegion = false;
  let regionCandidate;
  let stopRegionSelection;
  let quickAction;
  let quickPanel;
  let quickGeneration = 0;
  let hoverTimer;
  let hoverTarget;
  let contextPageUrl = location.href;
  let siteRuleLoaded = !chrome.storage?.local;
  let contextInvalidated = false;

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
      if (entry.isIntersecting) enqueue(entry.target);
    }
    refreshFloatingStatus();
  }, {threshold: 0.01});

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

  function hasCjk(text) {
    return /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(text);
  }

  function requestContext() {
    if (contextPageUrl !== location.href) {
      contextPageUrl = location.href;
      recentContext.length = 0;
    }
    return {
      pageTitle: document.title.slice(0, 300),
      previousText: recentContext.slice(-3).map(({source, translation}) => `${source}\n${translation}`).join("\n\n").slice(-1600),
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

    record = {id: `p-${nextId++}`, element, node: null, status: "idle", text: "", translation: "", generation: -1};
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
      selecting: ["选", "点击网页正文区域，按 Esc 取消"],
      disabled: ["禁", "此网站已禁用翻译，右键可重新启用"],
    };
    const [text, label] = states[status];
    floatingButton.dataset.status = status;
    floatingButton.textContent = text;
    floatingButton.title = label;
    floatingButton.setAttribute("aria-label", label);
  }

  function refreshFloatingStatus() {
    if (siteRule?.disabled) {
      setFloatingStatus("disabled");
      return;
    }
    if (selectingRegion || !enabled) return;
    setFloatingStatus(activeDetections || activeRequests || activeQuickRequests || queue.length || quickQueue.length ? "translating" : hasErrors ? "error" : "ready");
  }

  function handleExtensionError(error) {
    if (!/Extension context invalidated/i.test(error?.message || "")) return false;
    contextInvalidated = true;
    enabled = false;
    generation += 1;
    queue.length = 0;
    quickGeneration += 1;
    if (quickAction) quickAction.hidden = true;
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
    floatingMenu = menu;
    setFloatingStatus("idle");

    const closeMenu = () => menu.matches(":popover-open") && menu.hidePopover();
    const actions = [
      ["cancel", "取消翻译", cancelTranslation],
      ["retry", "重试失败", retryFailures],
      ["select-region", "选择翻译区域", beginRegionSelection],
      ["clear-region", "清除区域规则", clearRegionRule],
      ["site-toggle", "禁用此网站", toggleSite],
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
        try {
          Promise.resolve(handler()).catch(handleExtensionError);
        } catch (error) {
          handleExtensionError(error);
        }
      });
      menu.append(item);
    }

    button.addEventListener("click", () => {
      closeMenu();
      if (selectingRegion) stopRegionSelection?.();
      else enabled ? cancelTranslation() : startTranslation();
    });
    button.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      refreshMenuState();
      if (!menu.matches(":popover-open")) menu.showPopover();
      menu.querySelector("button")?.focus();
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
    if (retry) retry.disabled = !failed;
    if (clear) clear.disabled = !siteRule?.selector;
    if (toggle) toggle.textContent = siteRule?.disabled ? "启用此网站" : "禁用此网站";
  }

  function discoverCandidates() {
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

    const seen = new Set();
    for (const root of roots) {
      const candidates = root.matches(CANDIDATE_SELECTOR) ? [root, ...root.querySelectorAll(CANDIDATE_SELECTOR)] : root.querySelectorAll(CANDIDATE_SELECTOR);
      for (const element of candidates) {
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
    if (hasCjk(text)) {
      record.node?.remove();
      record.node = null;
      record.status = "skipped";
      return;
    }

    const detectionGeneration = generation;
    record.status = "detecting";
    activeDetections += 1;
    const onDetected = (result) => {
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
    for (const {record} of jobs) setTranslation(record, "正在翻译…", "pending");

    try {
      const response = await sendMessage({
        type: "BWT_TRANSLATE_BATCH",
        scope: "page",
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
        context: requestContext(),
        paragraphs: jobs.map(({record, text}) => ({id: record.id, text})),
      });
      if (response?.ok === false) throw new Error(response.error || "翻译失败");
      const expected = new Set(jobs.map(({record}) => record.id));
      const translations = response?.translations;
      const byId = new Map();
      if (!Array.isArray(translations) || translations.length !== expected.size || translations.some(({id, text}) => {
        if (!expected.has(id) || byId.has(id) || typeof text !== "string") return true;
        byId.set(id, text);
        return false;
      })) {
        throw new Error("翻译服务返回了无效结果");
      }

      for (const {record, text, generation: jobGeneration} of jobs) {
        if (jobGeneration !== generation || record.status !== "pending" || record.text !== text) continue;
        record.translation = formatTranslation(text, byId.get(record.id));
        setTranslation(record, record.translation, "done");
        rememberContext(text, record.translation);
      }
    } catch (error) {
      if (handleExtensionError(error)) return;
      const currentJobs = jobs.filter(({record, text, generation: jobGeneration}) =>
        jobGeneration === generation && enabled && record.status === "pending" && record.text === text
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
      for (const {record} of currentJobs) setTranslation(record, "翻译失败，请右键悬浮球重试", "error");
      refreshMenuState();
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
      while (queue.length && jobs.length < MAX_BATCH_PARAGRAPHS) {
        const job = queue.shift();
        if (job.generation !== generation || job.record.status !== "queued") continue;
        if (jobs.length && (jobs[0].single || job.single)) {
          queue.unshift(job);
          break;
        }
        jobs.push(job);
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

  async function startTranslation() {
    if (!siteRuleLoaded) await siteRuleReady;
    if (siteRule?.disabled) {
      enabled = false;
      setFloatingStatus("disabled");
      return false;
    }
    enabled = true;
    hasErrors = false;
    viewportObserver.disconnect();
    document.documentElement.classList.remove("bwt-show-original");
    setFloatingStatus("translating");
    if (!discoverCandidates()) refreshFloatingStatus();
    return true;
  }

  async function cancelTranslation() {
    if (selectingRegion) stopRegionSelection?.("cancelled");
    quickGeneration += 1;
    quickAction && (quickAction.hidden = true);
    quickPanel && (quickPanel.hidden = true);
    for (const job of quickQueue.splice(0)) job.reject(new Error("翻译已取消"));
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
    record.translation = "";
    record.generation = -1;
    viewportObserver.unobserve?.(element);
    viewportObserver.observe(element);
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

  function detectEnglish(text) {
    if (!isTranslatable(text) || text.length > MAX_QUICK_CHARACTERS || hasCjk(text)) return Promise.resolve(false);
    const shortAsciiText = text.length <= 80 && /^[\x00-\x7f]*[A-Za-z][\x00-\x7f]*$/u.test(text);
    return new Promise((resolve) => {
      try {
        chrome.i18n.detectLanguage(text, (result) => {
          const primary = result?.languages?.[0];
          const detectedEnglish = primary?.language?.startsWith("en") && (result.isReliable || (primary.percentage || 0) >= 80);
          resolve(Boolean(detectedEnglish || (!result?.isReliable && shortAsciiText)));
        });
      } catch (error) {
        handleExtensionError(error);
        resolve(false);
      }
    });
  }

  function placeQuickControl(element, rect) {
    const left = Math.max(8, Math.min(innerWidth - 260, rect.left));
    const top = Math.max(8, Math.min(innerHeight - 80, rect.bottom + 8));
    element.style.left = `${left}px`;
    element.style.top = `${top}px`;
  }

  async function showQuickTranslation(text, rect, existingTranslation = "") {
    const token = ++quickGeneration;
    quickAction.hidden = true;
    quickPanel.hidden = false;
    quickPanel.textContent = existingTranslation || "正在翻译…";
    placeQuickControl(quickPanel, rect);
    if (existingTranslation) return;
    if (siteRule?.disabled) {
      quickPanel.textContent = "此网站已禁用翻译";
      return;
    }
    const english = await detectEnglish(text);
    if (token !== quickGeneration || siteRule?.disabled) return;
    if (!english) {
      if (token === quickGeneration) quickPanel.textContent = "当前仅支持英文";
      return;
    }

    const id = `quick-${nextQuickId++}`;
    try {
      const response = await sendQuickMessage({
        type: "BWT_TRANSLATE_BATCH",
        scope: "quick",
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
        context: requestContext(),
        paragraphs: [{id, text}],
      }, token);
      const [translation] = response?.translations || [];
      if (response?.ok === false) throw new Error(response.error || "翻译失败");
      if (translation?.id !== id || typeof translation.text !== "string") throw new Error("翻译服务返回了无效结果");
      if (token === quickGeneration) quickPanel.textContent = formatTranslation(text, translation.text);
    } catch (error) {
      if (handleExtensionError(error)) return;
      if (token === quickGeneration) quickPanel.textContent = error.message || "翻译失败";
    }
  }

  function createQuickControls() {
    quickAction = document.createElement("button");
    quickPanel = document.createElement("div");
    quickAction.type = "button";
    quickAction.className = "bwt-selection-action";
    quickAction.dataset.bwtControl = "";
    quickAction.textContent = "译";
    quickAction.setAttribute("aria-label", "翻译选中文本");
    quickAction.hidden = true;
    quickPanel.className = "bwt-quick-translation";
    quickPanel.dataset.bwtControl = "";
    quickPanel.setAttribute("role", "status");
    quickPanel.setAttribute("aria-live", "polite");
    quickPanel.hidden = true;
    (document.body || document.documentElement).append(quickAction, quickPanel);

    quickAction.addEventListener("mousedown", (event) => event.preventDefault());
    quickAction.addEventListener("click", (event) => {
      event.stopPropagation();
      const rect = quickAction.getBoundingClientRect();
      showQuickTranslation(quickAction.dataset.text || "", rect);
    });

    document.addEventListener("mouseup", (event) => setTimeout(() => {
      if (event.target.closest?.("[data-bwt-control]") || selectingRegion || siteRule?.disabled) return;
      const selection = getSelection();
      const text = selection?.toString().replace(/\s+/g, " ").trim() || "";
      if (!text || text.length > MAX_QUICK_CHARACTERS || hasCjk(text) || !selection.rangeCount) {
        quickAction.hidden = true;
        return;
      }
      const container = selection.getRangeAt(0).commonAncestorContainer;
      const parent = container.nodeType === Node.ELEMENT_NODE ? container : container.parentElement;
      if (parent?.closest(EXCLUDED_SELECTOR)) return;
      quickAction.dataset.text = text;
      placeQuickControl(quickAction, selection.getRangeAt(0).getBoundingClientRect());
      quickAction.hidden = false;
    }, 0), true);

    document.addEventListener("mouseover", (event) => {
      clearTimeout(hoverTimer);
      if (!event.altKey || selectingRegion || siteRule?.disabled || event.target.closest?.("[data-bwt-control]")) return;
      const element = event.target.closest?.(CANDIDATE_SELECTOR);
      if (!element || element.closest(EXCLUDED_SELECTOR)) return;
      const text = paragraphText(element);
      if (!isTranslatable(text) || text.length > MAX_QUICK_CHARACTERS || hasCjk(text)) return;
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
      quickAction.hidden = true;
      quickPanel.hidden = true;
    }, true);

    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      quickGeneration += 1;
      quickAction.hidden = true;
      quickPanel.hidden = true;
    }, true);
  }

  createFloatingButton();
  createQuickControls();
  siteRuleReady.then(() => {
    refreshMenuState();
    if (siteRule?.disabled) setFloatingStatus("disabled");
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message?.type?.startsWith("BWT_")) return;

    if (["BWT_TRANSLATE", "BWT_TRANSLATE_PAGE"].includes(message.type)) {
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
        if (element && isInActiveRoot(element) && !element.closest(EXCLUDED_SELECTOR)) changed.add(element);
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
