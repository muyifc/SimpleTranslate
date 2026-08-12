---
title: Background Service Architecture
type: architecture
---

# Background service architecture

## Runtime message API

<!-- openwiki: broken internal link [../../manifest.json#L42-L44] link "../../manifest.json" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
`background.js` is the MV3 service worker ([manifest.json:42-44](../../manifest.json#L42-L44)). Its listener supports:

| Message | Purpose | Response |
|---|---|---|
| `BWT_TRANSLATE_BATCH` | Translate page or quick paragraphs | `{ok, translations}` |
| `BWT_INTERPRET_TEXT` | Interpret up to 1,200 characters | `{ok, interpretation}` |
| `BWT_GUIDE_ARTICLE` | Guide up to 20,000 characters | `{ok, guide}` |
| `BWT_CANCEL_REQUEST` | Abort one tab/request ID | `{ok, cancelled}` |
| `BWT_CANCEL_REQUESTS` | Abort every active request from sender tab | `{ok, cancelled}` |
| `BWT_CLEAR_CACHE` | Reset memory and persisted translation cache | `{ok}` |
| `BWT_OPEN_READING_NOTES` | Open `notes.html` in a tab | `{ok}` |

<!-- openwiki: broken internal link [../../background.js#L16-L90] link "../../background.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
Dispatch, validation, and response shaping live at [background.js:16-90](../../background.js#L16-L90). Asynchronous handlers return `true` to keep `sendResponse` alive. Unknown messages are ignored.

### Per-message request, success, and failure contract

| Request | Success | Validation/failure |
|---|---|---|
| `{type:"BWT_TRANSLATE_BATCH", requestId?, scope:"page"|"quick", sourceLanguage?, targetLanguage?, context?, paragraphs:[{id,text,beforeText?,afterText?}]}` | `{ok:true,translations:[...]}`; an empty array yields `[]` | Every provided paragraph requires non-empty string `id` and `text`; async failures use `{ok:false,error}`. Timeout/cancel errors are translation-specific. |
| `{type:"BWT_INTERPRET_TEXT", requestId?, text, sourceLanguage?, targetLanguage?, context?}` | `{ok:true,interpretation:string}` | Trimmed text must contain 1–1,200 characters; invalid input returns `{ok:false,error:"解读文本无效或过长"}`. Timeout/cancel errors are interpretation-specific. |
| `{type:"BWT_GUIDE_ARTICLE", requestId?, text, sourceLanguage?, targetLanguage?, context?}` | `{ok:true,guide:string}` | Trimmed text must contain 1–20,000 characters; invalid input returns `{ok:false,error:"文章导读文本无效或过长"}`. Timeout/cancel errors are guide-specific. |
| `{type:"BWT_CANCEL_REQUEST",requestId}` | `{ok:true,cancelled:0|1}` | ID is truncated to 100 characters and scoped to sender tab; a missing controller is a successful no-op. |
| `{type:"BWT_CANCEL_REQUESTS"}` | `{ok:true,cancelled:number}` | Aborts and counts all controllers for sender tab; no active work yields zero. |
| `{type:"BWT_CLEAR_CACHE"}` | `{ok:true}` | Persistence failure returns `{ok:false,error}` after memory/generation reset. |
| `{type:"BWT_OPEN_READING_NOTES"}` | `{ok:true}` | Tab-creation failure returns `{ok:false,error}`. |

<!-- openwiki: broken internal link [../../background.js#L16-L90] link "../../background.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
<!-- openwiki: broken internal link [../../background.js#L254-L274] link "../../background.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
See [background.js:16-90](../../background.js#L16-L90) and [background.js:254-274](../../background.js#L254-L274).

## Cancellation and timeout

<!-- openwiki: broken internal link [../../background.js#L32-L89] link "../../background.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
Each translation-like message receives one `AbortController`. Controllers are indexed by sender tab and optionally `${tabId}:${requestId}`. Request IDs are truncated to 100 characters. A 45-second timer aborts the operation; cleanup removes maps and timers in `finally` ([background.js:32-89](../../background.js#L32-L89)). The error text distinguishes timeout from explicit cancellation.

## Model configuration and fan-out

<!-- openwiki: broken internal link [../../background.js#L93-L110] link "../../background.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
Every operation reads `modelConfigs`, legacy `apiUrl`/`model`/`apiKey`, and `glossary` from local storage. If `modelConfigs` is absent, one enabled legacy record is synthesized. At most four enabled configurations are normalized ([background.js:93-110](../../background.js#L93-L110)).

<!-- openwiki: broken internal link [../../background.js#L112-L139] link "../../background.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
Ordinary page and quick operations call all enabled models concurrently with `Promise.all`. Failures are isolated per model and returned as error variants rather than suppressing successful variants. Interpretation and article-guide scopes use only the first enabled model and fail if it fails ([background.js:112-139](../../background.js#L112-L139)).

Compatibility affects response shape:

```js
// Legacy scalar configuration
{id: "p-1", text: "..."}

// Explicit modelConfigs, including one model
{id: "p-1", variants: [
  {modelId: "...", modelName: "...", text: "..."},
  // or {modelId, modelName, error}
]}
```

## Endpoint and request contract

<!-- openwiki: broken internal link [../../background.js#L217-L219] link "../../background.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
<!-- openwiki: broken internal link [../../background.js#L254-L265] link "../../background.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
<!-- openwiki: broken internal link [../../background.js#L299-L338] link "../../background.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
Configured URL and model are mandatory. HTTPS is required except HTTP loopback endpoints ([background.js:217-219](../../background.js#L217-L219), [background.js:254-265](../../background.js#L254-L265)). The worker POSTs JSON with `Content-Type: application/json`, an optional Bearer header, `temperature: 0`, and system/user chat messages ([background.js:299-338](../../background.js#L299-L338)).

<!-- openwiki: broken internal link [../../background.js#L157-L162] link "../../background.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
<!-- openwiki: broken internal link [../../background.js#L254-L274] link "../../background.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
Page context is restricted to a 300-character title and 1,600-character recent-context string. Neighbor fields are truncated to 800 characters each ([background.js:157-162](../../background.js#L157-L162), [background.js:254-274](../../background.js#L254-L274)). Prompts explicitly treat source and context as untrusted and require output IDs to remain unchanged.

<!-- openwiki: broken internal link [../../background.js#L340-L369] link "../../background.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
<!-- openwiki: broken internal link [../../background.js#L70-L75] link "../../background.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
<!-- openwiki: broken internal link [../../background.js#L303-L320] link "../../background.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
The model endpoint always returns content through `choices[0].message.content`. For page/quick translation, that content must be a JSON object with a `translations` array; the worker strips optional JSON fences, parses it, and requires exactly one unique string translation for each expected cache miss—no missing, duplicate, or extra IDs ([background.js:340-369](../../background.js#L340-L369)). Interpretation and guide prompts request structured human-readable plain text under one synthetic paragraph ID; after the same endpoint parsing/validation path, the worker unwraps the first translated text as `interpretation` or `guide` ([background.js:70-75](../../background.js#L70-L75), [background.js:303-320](../../background.js#L303-L320)). Invalid model output is not retried, avoiding repeated billing against a structurally broken endpoint.

## Retry policy

<!-- openwiki: broken internal link [../../background.js#L185-L215] link "../../background.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
`fetchWithRetry()` makes up to three attempts with 500 ms and 2,000 ms delays. It retries network failures, HTTP 429, and 5xx responses. Other HTTP errors fail immediately; `AbortError` never retries. The abort signal also interrupts waiting backoff ([background.js:185-215](../../background.js#L185-L215)).

## Cache

<!-- openwiki: broken internal link [../../background.js#L142-L155] link "../../background.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
`translationCacheV1` is lazily loaded once per worker lifetime. Only 64-character lowercase SHA-256 keys survive loading, so older raw-text keys are discarded ([background.js:142-155](../../background.js#L142-L155)). Key material includes:

- prompt/cache version;
- model ID, endpoint, and model name;
- glossary;
- source and target language;
- operation scope;
- page title;
- recent context for non-page scopes;
- neighbor text;
- source text.

<!-- openwiki: broken internal link [../../background.js#L164-L183] link "../../background.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
See [background.js:164-183](../../background.js#L164-L183). Page scope intentionally excludes rolling `previousText` from the key, while stable neighbor context remains included.

<!-- openwiki: broken internal link [../../background.js#L221-L299] link "../../background.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
Only misses are sent to the API. Successful results are stored with timestamps; the oldest entries are evicted above 300. Storage write failures do not turn a successful translation into a user-visible request failure ([background.js:221-299](../../background.js#L221-L299)). Writes are coalesced so only one `storage.local.set` is in flight.

<!-- openwiki: broken internal link [../../background.js#L24-L30] link "../../background.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
<!-- openwiki: broken internal link [../../background.js#L361-L366] link "../../background.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
Cache clearing increments `cacheGeneration`, replaces the in-memory cache, and writes `{}`. A request captures the generation and cannot repopulate a cache cleared while it was in flight ([background.js:24-30](../../background.js#L24-L30), [background.js:361-366](../../background.js#L361-L366)).

## Responsibility boundary

The worker does **not** detect languages, discover DOM content, choose visible work, split oversized batches, or enforce the three-request scheduler. Those are content-script responsibilities. The worker receives already formed paragraphs and fans each cache-miss batch out to selected models.
<!-- openwiki: broken internal link [../../background.js#L221-L299] link "../../background.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
a user-visible request failure ([background.js:221-299](../../background.js#L221-L299)). Writes are coalesced so only one `storage.local.set` is in flight.

<!-- openwiki: broken internal link [../../background.js#L24-L30] link "../../background.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
<!-- openwiki: broken internal link [../../background.js#L361-L366] link "../../background.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
Cache clearing increments `cacheGeneration`, replaces the in-memory cache, and writes `{}`. A request captures the generation and cannot repopulate a cache cleared while it was in flight ([background.js:24-30](../../background.js#L24-L30), [background.js:361-366](../../background.js#L361-L366)).

## Responsibility boundary

The worker does **not** detect languages, discover DOM content, choose visible work, split oversized batches, or enforce the three-request scheduler. Those are content-script responsibilities. The worker receives already formed paragraphs and fans each cache-miss batch out to selected models.
