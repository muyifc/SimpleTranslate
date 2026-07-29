const assert = require("node:assert/strict");
const {spawn} = require("node:child_process");
const {mkdtempSync, readFileSync, rmSync, writeFileSync} = require("node:fs");
const {tmpdir} = require("node:os");
const {basename, join, resolve, sep} = require("node:path");

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const EXTENSION = resolve(__dirname, "..");
const CONTENT_SOURCE = readFileSync(join(EXTENSION, "content.js"), "utf8");
const CONTENT_STYLE = readFileSync(join(EXTENSION, "content.css"), "utf8");
const PAGES = [
  ["MDN article", "https://developer.mozilla.org/en-US/docs/Web/API/MutationObserver"],
  ["GitHub README", "https://github.com/openai/openai-node"],
  ["Guardian news", "https://www.theguardian.com/international"],
  ["React docs", "https://react.dev/learn"],
];

const sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));

class Cdp {
  constructor(url) {
    this.nextId = 1;
    this.pending = new Map();
    this.events = new Map();
    this.socket = new WebSocket(url);
    this.ready = new Promise((resolveReady, reject) => {
      this.socket.addEventListener("open", resolveReady, {once: true});
      this.socket.addEventListener("error", reject, {once: true});
    });
    this.socket.addEventListener("message", ({data}) => {
      const message = JSON.parse(String(data));
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
        return;
      }
      for (const listener of this.events.get(message.method) || []) listener(message.params);
    });
  }

  async send(method, params = {}, timeout = 30000) {
    await this.ready;
    const id = this.nextId++;
    return new Promise((resolveSend, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeout);
      this.pending.set(id, {resolve: resolveSend, reject, timer});
      this.socket.send(JSON.stringify({id, method, params}));
    });
  }

  close() {
    this.socket.close();
  }
}

async function waitForDevTools(profile) {
  const portFile = join(profile, "DevToolsActivePort");
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      return readFileSync(portFile, "utf8").split(/\r?\n/u)[0];
    } catch {
      await sleep(100);
    }
  }
  throw new Error("Chrome did not expose its debugging port");
}

async function targets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  return response.json();
}

async function waitForTarget(port, predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const target = (await targets(port)).find(predicate);
    if (target) return target;
    await sleep(100);
  }
  throw new Error("Expected Chrome target was not created");
}

async function evaluate(client, expression) {
  const result = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}

async function poll(client, expression, timeout = 30000) {
  const deadline = Date.now() + timeout;
  let value;
  while (Date.now() < deadline) {
    value = await evaluate(client, expression);
    if (value) return value;
    await sleep(250);
  }
  throw new Error(`Condition timed out: ${expression.slice(0, 100)}`);
}

async function navigate(client, url) {
  await client.send("Page.navigate", {url});
  await poll(client, `document.readyState === "complete" && location.href.startsWith(${JSON.stringify(new URL(url).origin)})`, 45000);
  await evaluate(client, `(() => {
    const data = {};
    globalThis.chrome = {
      storage: {local: {
        get: async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, data[key]])),
        set: async (values) => Object.assign(data, values),
      }},
      i18n: {detectLanguage: (_text, callback) => callback({isReliable: true, languages: [{language: "en", percentage: 100}]})},
      runtime: {
        lastError: null,
        onMessage: {addListener: () => {}},
        sendMessage: (message, callback) => queueMicrotask(() => {
          globalThis.__bwtE2eRequests = (globalThis.__bwtE2eRequests || 0) + 1;
          if (message.type === "BWT_TRANSLATE_BATCH") callback({ok: true, translations: message.paragraphs.map(({id, text}) => ({id, text: "测试译文：" + text.slice(0, 160)}))});
          else callback({ok: true, cancelled: 0});
        }),
      },
    };
    globalThis.__bwtE2eErrors = [];
    globalThis.__bwtE2eObserved = 0;
    const NativeIntersectionObserver = IntersectionObserver;
    globalThis.IntersectionObserver = class extends NativeIntersectionObserver {
      constructor(callback, options) {
        super((entries, observer) => {
          globalThis.__bwtE2eObserved += entries.filter((entry) => entry.isIntersecting).length;
          callback(entries, observer);
        }, options);
      }
    };
    addEventListener("error", (event) => __bwtE2eErrors.push(event.error?.stack || event.message));
    addEventListener("unhandledrejection", (event) => __bwtE2eErrors.push(event.reason?.stack || String(event.reason)));
    const style = document.createElement("style");
    style.textContent = ${JSON.stringify(CONTENT_STYLE)};
    document.documentElement.append(style);
  })()`);
  await evaluate(client, CONTENT_SOURCE);
  await poll(client, `Boolean(document.querySelector(".bwt-floating-button"))`, 15000);
}

async function inspectPage(client) {
  return evaluate(client, `(() => {
    const translations = [...document.querySelectorAll(".bwt-translation")];
    return {
      done: translations.filter((node) => node.classList.contains("bwt-translation--done")).length,
      total: translations.length,
      excluded: translations.filter((node) => node.closest("nav,header,footer,aside,pre,code,[role=dialog],[aria-hidden=true]")).length,
      duplicateSources: new Set(translations.map((node) => node.dataset.sourceId)).size !== translations.length,
      dynamic: Boolean(document.querySelector("#bwt-e2e-dynamic + .bwt-translation--done")),
      status: document.querySelector(".bwt-floating-button")?.dataset.status,
      width: document.documentElement.scrollWidth,
      requests: globalThis.__bwtE2eRequests || 0,
    };
  })()`);
}

async function testPage(client, name, url) {
  await navigate(client, url);
  const before = await evaluate(client, `({width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight})`);
  await evaluate(client, `document.querySelector(".bwt-floating-button").click()`);
  await evaluate(client, `(() => {
    const root = document.querySelector("main article,[role=main] article") || document.querySelector("main,[role=main]") || document.querySelector("article") || document.body;
    const firstText = root.querySelector("h1,h2,h3,h4,h5,h6,p,li,blockquote,td,th") || root;
    firstText.scrollIntoView({block: "center"});
  })()`);
  try {
    await poll(client, `document.querySelectorAll(".bwt-translation--done").length > 0`, 30000);
  } catch (error) {
    const diagnostic = await evaluate(client, `({
      url: location.href,
      title: document.title,
      status: document.querySelector(".bwt-floating-button")?.dataset.status,
      translations: [...document.querySelectorAll(".bwt-translation")].map((node) => ({className: node.className, text: node.textContent})).slice(0, 5),
      candidates: [...document.querySelectorAll("h1,h2,h3,h4,h5,h6,p,li,blockquote,td,th,div")].filter((node) => {
        const rect = node.getBoundingClientRect();
        return rect.bottom > 0 && rect.top < innerHeight && node.innerText?.trim().length > 1;
      }).slice(0, 10).map((node) => ({tag: node.tagName, text: node.innerText.trim().slice(0, 100)})),
      requests: globalThis.__bwtE2eRequests || 0,
      observed: globalThis.__bwtE2eObserved || 0,
      errors: globalThis.__bwtE2eErrors,
    })`);
    error.message += ` diagnostic=${JSON.stringify(diagnostic)}`;
    throw error;
  }

  for (const ratio of [0.35, 0.7, 1]) {
    await evaluate(client, `scrollTo(0, Math.max(0, (document.documentElement.scrollHeight - innerHeight) * ${ratio}))`);
    await poll(client, `document.querySelector(".bwt-floating-button").dataset.status !== "translating"`, 30000);
  }

  await evaluate(client, `(() => {
    document.querySelector("#bwt-e2e-dynamic")?.remove();
    const translations = [...document.querySelectorAll(".bwt-translation")];
    const anchor = translations.find((node) => {
      const rect = node.getBoundingClientRect();
      return rect.bottom > 0 && rect.top < innerHeight;
    }) || translations.at(-1);
    const paragraph = document.createElement("p");
    paragraph.id = "bwt-e2e-dynamic";
    paragraph.textContent = "This dynamically inserted English paragraph verifies translation after a page updates without a reload.";
    anchor.before(paragraph);
    paragraph.scrollIntoView({block: "center"});
  })()`);
  try {
    await poll(client, `(() => {
      const node = document.querySelector("#bwt-e2e-dynamic");
      node?.scrollIntoView({block: "center"});
      return Boolean(node?.nextElementSibling?.classList.contains("bwt-translation--done"));
    })()`, 30000);
  } catch (error) {
    const diagnostic = await evaluate(client, `(() => {
      const node = document.querySelector("#bwt-e2e-dynamic");
      return {
        connected: Boolean(node?.isConnected),
        parent: node?.parentElement?.tagName,
        parentClass: node?.parentElement?.className,
        sibling: node?.nextElementSibling?.className,
        rect: node?.getBoundingClientRect().toJSON(),
        excluded: node ? Boolean(node.closest("nav,header,footer,aside,pre,code,[role=dialog],[aria-hidden=true],[class~=sidebar i],[id=sidebar i],[id^=sidebar- i],[id$=-sidebar i]")) : null,
        observed: globalThis.__bwtE2eObserved || 0,
        requests: globalThis.__bwtE2eRequests || 0,
        status: document.querySelector(".bwt-floating-button")?.dataset.status,
      };
    })()`);
    error.message += ` diagnostic=${JSON.stringify(diagnostic)}`;
    throw error;
  }

  const result = await inspectPage(client);
  assert(result.done > 0, `${name}: no completed translations`);
  assert.equal(result.excluded, 0, `${name}: translated excluded page chrome`);
  assert.equal(result.duplicateSources, false, `${name}: duplicate translation source IDs`);
  assert.equal(result.dynamic, true, `${name}: dynamic paragraph was not translated`);
  assert(result.width <= before.width + 40, `${name}: translation widened the page from ${before.width}px to ${result.width}px`);

  await evaluate(client, `document.querySelector(".bwt-floating-button").click()`);
  await poll(client, `document.querySelector(".bwt-floating-button").dataset.status === "cancelled"`);
  console.log(`ok - ${name}: ${result.done} translated, dynamic content and cancellation passed`);
  return {...result, name, url, initialHeight: before.height};
}

async function main() {
  const profile = mkdtempSync(join(tmpdir(), "bwt-real-pages-"));
  const chrome = spawn(CHROME, [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--disable-default-apps",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "about:blank",
  ], {stdio: "ignore"});
  let browserClient;
  let pageClient;

  try {
    const port = await waitForDevTools(profile);
    const browserInfo = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    browserClient = new Cdp(browserInfo.webSocketDebuggerUrl);
    const page = await waitForTarget(port, ({type, url}) => type === "page" && url === "about:blank");
    pageClient = new Cdp(page.webSocketDebuggerUrl);
    await Promise.all([pageClient.send("Runtime.enable"), pageClient.send("Page.enable")]);

    const report = [];
    for (const [name, url] of PAGES) {
      try {
        report.push(await testPage(pageClient, name, url));
      } catch (error) {
        const screenshot = await pageClient.send("Page.captureScreenshot", {format: "png"}).catch(() => null);
        if (screenshot?.data) {
          const path = join(tmpdir(), `bwt-${name.toLowerCase().replace(/\W+/gu, "-")}-failure.png`);
          writeFileSync(path, screenshot.data, "base64");
          error.message += ` (screenshot: ${path})`;
        }
        throw error;
      }
    }
    console.log(`real-page check passed: ${report.length} pages, ${report.reduce((sum, page) => sum + page.requests, 0)} mocked messages`);
  } finally {
    pageClient?.close();
    if (browserClient) await browserClient.send("Browser.close").catch(() => {});
    browserClient?.close();
    await Promise.race([new Promise((resolveExit) => chrome.once("exit", resolveExit)), sleep(5000)]);
    if (!chrome.killed) chrome.kill();
    const safeTemp = resolve(tmpdir()) + sep;
    if (resolve(profile).startsWith(safeTemp) && basename(profile).startsWith("bwt-real-pages-")) rmSync(profile, {recursive: true, force: true});
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
