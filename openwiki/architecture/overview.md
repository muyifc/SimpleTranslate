---
title: Architecture Overview
type: architecture
---

# Architecture overview

## Components

### Content script

<!-- openwiki: broken internal link [../../content.js#L1-L4] link "../../content.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
`content.js` is an IIFE guarded against duplicate initialization and non-HTML documents ([content.js:1-4](../../content.js#L1-L4)). It owns everything coupled to the host page:

- selecting the active article/main/body root;
- extracting eligible paragraph text;
- observing visibility and DOM mutations;
- detecting source languages;
- batching and prioritizing requests;
- rendering translations and all in-page UI;
- capturing notes and site-specific rules.

### Background service worker

<!-- openwiki: broken internal link [../../background.js#L1-L90] link "../../background.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
`background.js` is the privileged network boundary. It handles translation, interpretation, guide, cancellation, cache-clear, and notes-page messages; tracks abort controllers; loads model settings; fans out requests; validates responses; and persists a bounded cache ([background.js:1-90](../../background.js#L1-L90)). Its module-level maps survive only for the current MV3 worker lifetime, while `chrome.storage.local` provides durability.

### Extension pages

<!-- openwiki: broken internal link [../../popup.js#L64-L76] link "../../popup.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
- `popup.html`/`popup.js`: thin active-tab controller. It asks the content script for state after each operation rather than assuming success ([popup.js:64-76](../../popup.js#L64-L76)).
- `options.html`/`options.js`: model/language/glossary configuration and endpoint permission acquisition.
- `notes.html`/`notes.js`: standalone editor over local reading notes.

## Communication map

| Sender → receiver | Contract |
|---|---|
<!-- openwiki: broken internal link [../../popup.js#L64-L90] link "../../popup.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
<!-- openwiki: broken internal link [../../content.js#L1-L4] link "../../content.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
<!-- openwiki: broken internal link [../../content.js#L1477-L1516] link "../../content.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
| Popup → active-tab content script | `BWT_GET_STATE`; `BWT_TRANSLATE`/`BWT_TRANSLATE_PAGE`; `BWT_CANCEL_TRANSLATION`; `BWT_SHOW_ORIGINAL`/`BWT_HIDE_TRANSLATIONS`; `BWT_SHOW_TRANSLATIONS`; `BWT_SHOW_FLOATING`/`BWT_HIDE_FLOATING`; and `BWT_REMOVE_TRANSLATIONS`. State returns `{ok:true,state:{translationEnabled,translationsVisible,floatingVisible}}`; commands return `{ok:true,message?}` or `{ok:false,error}`. If the initial state query has no receiving end, the popup injects the CSS/script and retries; the content script’s global initialization guard makes duplicate execution a no-op ([popup.js:64-90](../../popup.js#L64-L90), [content.js:1-4](../../content.js#L1-L4), [content.js:1477-1516](../../content.js#L1477-L1516)). |
| Content script → worker | `BWT_TRANSLATE_BATCH`, `BWT_INTERPRET_TEXT`, `BWT_GUIDE_ARTICLE`, request/tab cancellation, and `BWT_OPEN_READING_NOTES`. Responses carry `{ok, ...}` or `{ok:false,error}`. |
<!-- openwiki: broken internal link [../../options.js#L159-L170] link "../../options.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
| Options → worker | `BWT_CLEAR_CACHE`; success/error is displayed in the options status area ([options.js:159-170](../../options.js#L159-L170)). |
| Extension pages/content → storage | Options persists configuration; popup persists the global selection preference; content persists site rules and new notes; notes page edits notes. Content listens for selection-preference storage changes. |
| Worker → configured endpoint | HTTPS/loopback OpenAI-compatible Chat Completions POST; results return through the originating runtime response. |
| Worker → browser tabs | `BWT_OPEN_READING_NOTES` creates a tab at the extension’s `notes.html` URL. |

<!-- openwiki: broken internal link [../../popup.js#L25-L38] link "../../popup.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
Popup tab messages target the resolved active tab ID. A missing receiver is handled only by the popup’s initial injection path; unsupported/non-HTTP(S) pages and messaging failures become user-visible status rather than persistent state ([popup.js:25-38](../../popup.js#L25-L38)).

## End-to-end page translation

```text
user starts translation
  → content script discovers active root and candidate elements
  → IntersectionObserver waits for visible dwell
  → chrome.i18n.detectLanguage filters native/uncertain text
  → queue groups up to 3 same-language paragraphs / 10,000 chars
  → BWT_TRANSLATE_BATCH runtime message
  → background loads up to 4 enabled models and cache
  → cache hits returned; misses POSTed to model endpoint(s)
  → strict ID/result validation and cache update
  → content script rejects stale generations/request IDs
  → translation nodes inserted under original text
```

<!-- openwiki: broken internal link [../../content.js#L41-L54] link "../../content.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
<!-- openwiki: broken internal link [../../background.js#L6-L7] link "../../background.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
<!-- openwiki: broken internal link [../../background.js#L112-L139] link "../../background.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
Content-side limits are three concurrent requests, three paragraphs per batch, 10,000 batch characters, a 40 ms viewport dwell, and a 20 ms coalescing window ([content.js:41-54](../../content.js#L41-L54)). Background fan-out can multiply one scheduled request across four enabled models; the intended ceiling is therefore twelve simultaneous fetches ([background.js:6-7](../../background.js#L6-L7), [background.js:112-139](../../background.js#L112-L139)).

## Context and correctness

<!-- openwiki: broken internal link [../../content.js#L215-L241] link "../../content.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
<!-- openwiki: broken internal link [../../background.js#L303-L335] link "../../background.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
Each page request carries the title, recent translated context, and up to 800 characters from adjacent source paragraphs. Neighbor text is read-only context, not an additional translation target ([content.js:215-241](../../content.js#L215-L241)). Prompts tell models to preserve IDs/layout, use context only for disambiguation, and treat page content as untrusted instructions ([background.js:303-335](../../background.js#L303-L335)).

Asynchronous correctness relies on several identities:

- a page `generation` invalidates work after cancellation/restart;
- every paragraph has a stable record ID;
- every batch has a request ID;
- quick actions and guides use separate generation counters;
- responses are accepted only if generation, request, status, source text, and returned IDs still match.

## Cancellation and viewport priority

<!-- openwiki: broken internal link [../../content.js#L148-L165] link "../../content.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
<!-- openwiki: broken internal link [../../background.js#L32-L44] link "../../background.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
When a paragraph leaves the viewport, detecting/queued/pending state is reset. If an active batch no longer contains visible jobs, the content script sends `BWT_CANCEL_REQUEST` for that batch ([content.js:148-165](../../content.js#L148-L165)). Whole-session cancellation sends `BWT_CANCEL_REQUESTS`; the worker aborts all controllers for the sender tab ([background.js:32-44](../../background.js#L32-L44)).

<!-- openwiki: broken internal link [../../background.js#L8-L12] link "../../background.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
<!-- openwiki: broken internal link [../../background.js#L185-L215] link "../../background.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
The worker applies a 45-second overall timeout and retries network errors, HTTP 429, and 5xx responses after 500 ms and 2,000 ms. Cancellation interrupts both fetch and backoff ([background.js:8-12](../../background.js#L8-L12), [background.js:185-215](../../background.js#L185-L215)).

## Dynamic pages

<!-- openwiki: broken internal link [../../content.js#L1518-L1581] link "../../content.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
A document-wide `MutationObserver` debounces changes. It resets changed records, prunes disconnected records, incrementally registers added subtrees, and rescans only when a semantic root may have changed. This supports SPAs and infinite-scroll pages without repeating a full scan for every mutation ([content.js:1518-1581](../../content.js#L1518-L1581)).

## Persistent state

All durable state uses `chrome.storage.local`: model settings, language/glossary preferences, selection preference, site rules, hashed translation cache, and reading notes. See [Storage and data](../reference/storage-and-data.md).

## Design trade-offs

- **No build layer:** easy unpacked installation and debugging, but large single-file modules and global runtime contracts.
- **Content-side scheduler:** visibility decisions remain close to DOM state, but the worker trusts content-script batch sizing.
- **Strict model response validation:** prevents mismatched translations from being rendered, while malformed model output fails without retry to avoid multiplying billing.
- **Local credentials:** simple personal configuration, but unsuitable for hiding a shared secret.
