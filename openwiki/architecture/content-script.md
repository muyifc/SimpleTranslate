---
title: Content-Script Architecture
type: architecture
---

# Content-script architecture

## Initialization and state

<!-- openwiki: broken internal link [../../content.js#L1-L4] link "../../content.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
<!-- openwiki: broken internal link [../../content.js#L109-L124] link "../../content.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
<!-- openwiki: broken internal link [../../content.js#L1458-L1581] link "../../content.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
The script exits if already initialized or if the document is not HTML ([content.js:1-4](../../content.js#L1-L4)). It asynchronously loads `nativeLanguage`, `selectionTranslationEnabled`, and the current host’s `siteRules` entry ([content.js:109-124](../../content.js#L109-L124)). Startup creates the floating ball/menu, article-guide drawer, and selection controls, then installs storage, runtime-message, and mutation listeners ([content.js:1458-1581](../../content.js#L1458-L1581)). Page translation starts only after a user or popup command.

<!-- openwiki: broken internal link [../../content.js#L55-L108] link "../../content.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
Paragraph state is represented by a `WeakMap` keyed by element plus a strong `recordsById` map used for ordering, retries, context, and pruning. Queues, visible-element timers, active batches, request counters, and generation counters coordinate asynchronous work ([content.js:55-108](../../content.js#L55-L108)).

## Root and candidate discovery

<!-- openwiki: broken internal link [../../content.js#L6-L40] link "../../content.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
Candidate tags are headings, paragraphs, list items, blockquotes, table cells, and text-like `div`s. The exclusion selector removes scripts/styles, code, forms, editable/no-translate content, page chrome, ads, dialogs, hidden regions, and extension-generated controls ([content.js:6-40](../../content.js#L6-L40)).

`discoverCandidates()` chooses a root in this order:

1. a saved valid site selector;
2. an article inside a main region;
3. `main` or `[role="main"]`;
4. a standalone `article`;
5. `body`.

<!-- openwiki: broken internal link [../../content.js#L592-L619] link "../../content.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
When a semantic selector matches several roots, the text-largest root wins ([content.js:592-619](../../content.js#L592-L619)). A user can select and save a site-specific root; invalid rules fall back to generic discovery.

<!-- openwiki: broken internal link [../../content.js#L167-L189] link "../../content.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
<!-- openwiki: broken internal link [../../content.js#L191-L194] link "../../content.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
`paragraphText()` traverses owned text and `<br>` nodes, avoids nested candidate ownership, normalizes spaces, and preserves explicit line breaks ([content.js:167-189](../../content.js#L167-L189)). Eligible text is 2–6,000 characters and not numeric/punctuation-only ([content.js:191-194](../../content.js#L191-L194)).

## Visibility and language detection

<!-- openwiki: broken internal link [../../content.js#L126-L146] link "../../content.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
<!-- openwiki: broken internal link [../../content.js#L148-L165] link "../../content.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
One `IntersectionObserver` records visibility. A candidate must remain visible for 40 ms before enqueueing, which filters rapid scrollbar fly-bys ([content.js:126-146](../../content.js#L126-L146)). Leaving the viewport cancels dwell, resets unfinished state, and may abort a now-irrelevant active batch ([content.js:148-165](../../content.js#L148-L165)).

<!-- openwiki: broken internal link [../../content.js#L196-L213] link "../../content.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
`chrome.i18n.detectLanguage` runs before queueing. Reliable results or top confidence of at least 80% are accepted unless they match the target language by primary subtag. Short low-confidence ASCII snippets fall back to English when English is not the target ([content.js:196-213](../../content.js#L196-L213)). Detection callbacks verify generation, state, connectivity, and unchanged source text before proceeding.

<!-- openwiki: broken internal link [../../content.js#L148-L165] link "../../content.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
<!-- openwiki: broken internal link [../../test_scroll_priority.html#L56-L78] link "../../test_scroll_priority.html" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
On exit from the viewport, a pending dwell timer is cleared and unfinished local work returns to `idle`. For active requests, cancellation is sent only when **none** of that batch’s jobs remains visible; a mixed batch with any still-visible job continues. The batch request ID gives the worker request-specific cancellation rather than aborting unrelated current-viewport work ([content.js:148-165](../../content.js#L148-L165)). `test_scroll_priority.html` covers the invariant: a fly-by is never sent, old-viewport work is cancelled, and the newly visible bottom paragraph completes ([test_scroll_priority.html:56-78](../../test_scroll_priority.html#L56-L78)).

## Queue and batching

The paragraph/job state model is:

| From | Event | To |
|---|---|---|
| `idle` | visible dwell expires and text remains eligible | `detecting` |
| `detecting` | native/uncertain detection or invalid current text | `skipped` |
| `detecting` | accepted non-native source language | `queued` |
| `queued` | scheduler assigns the job to a batch | `pending` |
| `pending` | current response contains a valid successful translation | `done` |
| `pending` | multi-paragraph batch fails | `queued` with forced-single isolation |
| `pending` | forced-single request fails | `error` |
| `error` | user retries an eligible connected record | `queued` |
| `detecting`/`queued`/`pending` | element leaves viewport | `idle`; provisional output removed |
| `queued`/`pending` | whole-session cancellation | `cancelled` |
| any stale/disconnected record | source mutation/removal/restart | reset or pruned; stale callback ignored |

<!-- openwiki: broken internal link [../../content.js#L647-L700] link "../../content.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
<!-- openwiki: broken internal link [../../content.js#L737-L847] link "../../content.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
<!-- openwiki: broken internal link [../../content.js#L1111-L1202] link "../../content.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
Responses are accepted only while generation, request ID, status, source text, connectivity, and returned ID still match ([content.js:647-700](../../content.js#L647-L700), [content.js:737-847](../../content.js#L737-L847), [content.js:1111-1202](../../content.js#L1111-L1202)).

<!-- openwiki: broken internal link [../../content.js#L712-L735] link "../../content.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
<!-- openwiki: broken internal link [../../content.js#L792-L832] link "../../content.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
The page queue and quick-action queue share a global three-request budget. Quick work cannot bypass that ceiling. `pumpQueue()` processes queue order, drops stale jobs, and groups only jobs with matching source language. A page batch is capped at three paragraphs and 10,000 characters; jobs marked for single retry are isolated ([content.js:712-735](../../content.js#L712-L735), [content.js:792-832](../../content.js#L792-L832)).

For each batch, the content script sends:

```js
{
  type: "BWT_TRANSLATE_BATCH",
  requestId,
  scope: "page",
  sourceLanguage,
  targetLanguage,
  context: {pageTitle, previousText},
  paragraphs: [{id, text, beforeText, afterText}]
}
```

<!-- openwiki: broken internal link [../../content.js#L300-L347] link "../../content.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
<!-- openwiki: broken internal link [../../content.js#L737-L785] link "../../content.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
Response handling accepts legacy `{id, text}` records and multi-model `{id, variants}` records, requires exact IDs, and rejects invalid variant fields ([content.js:300-347](../../content.js#L300-L347)). A failed multi-paragraph batch is requeued as individual requests; a failed individual request becomes visible error state ([content.js:737-785](../../content.js#L737-L785)).

## Rendering

<!-- openwiki: broken internal link [../../content.js#L279-L298] link "../../content.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
<!-- openwiki: broken internal link [../../content.css#L1-L38] link "../../content.css" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
A translation is a separate `.bwt-translation` element linked through `data-source-id`. It is inserted after ordinary source elements but appended inside `li`, `td`, and `th` to preserve valid structure ([content.js:279-298](../../content.js#L279-L298)). Multi-model responses produce labelled rows. Hiding translations uses CSS; original source text remains untouched ([content.css:1-38](../../content.css#L1-L38)).

<!-- openwiki: broken internal link [../../content.css#L40-L248] link "../../content.css" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
The floating ball exposes progress, ready/error/cancelled/disabled states, drag-and-dock behavior, and a context menu for guide, notes, retry, site/region controls, visibility, and hiding. Most extension UI uses `.bwt-*`, `data-bwt-control`, `all: initial`, and very high z-index values to isolate it from host styling ([content.css:40-248](../../content.css#L40-L248)).

## Dynamic DOM handling

The mutation observer watches child and character changes across the document. After a 250 ms debounce it:

- resets records whose source text changed;
- prunes disconnected records;
- rescans if active semantic-root structure changed;
- otherwise registers only added subtrees.

<!-- openwiki: broken internal link [../../content.js#L1518-L1581] link "../../content.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
See [content.js:1518-1581](../../content.js#L1518-L1581). This prevents stale translations and supports dynamically appended article text.

## Quick actions, guide, and notes capture

<!-- openwiki: broken internal link [../../content.js#L1240-L1455] link "../../content.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
Selection controls reject excluded areas and selections over 1,200 characters. Translation uses `scope: "quick"`; interpretation uses `BWT_INTERPRET_TEXT` and only the first enabled model. Alt-hover waits about 400 ms before previewing a paragraph ([content.js:1240-1455](../../content.js#L1240-L1455)).

<!-- openwiki: broken internal link [../../content.js#L621-L645] link "../../content.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
<!-- openwiki: broken internal link [../../content.js#L1004-L1109] link "../../content.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
The article guide collects ordered text from active roots, capped at 20,000 characters, and sends `BWT_GUIDE_ARTICLE`. Its drawer and request use an independent generation so closing it prevents stale responses from reopening/updating it ([content.js:621-645](../../content.js#L621-L645), [content.js:1004-1109](../../content.js#L1004-L1109)).

<!-- openwiki: broken internal link [../../content.js#L947-L1002] link "../../content.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
Content-side note creation stores `selection`, `interpretation`, or `article-guide` records under `readingNotesV1`, normalizes field lengths, sorts by update time, and retains at most 300 ([content.js:947-1002](../../content.js#L947-L1002)).

## Runtime commands

<!-- openwiki: broken internal link [../../content.js#L1477-L1516] link "../../content.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
The runtime listener answers `BWT_GET_STATE` and handles start/cancel, show/hide translations, show/hide floating UI, and translation removal ([content.js:1477-1516](../../content.js#L1477-L1516)). Popup state is therefore authoritative from the active content script, not maintained separately in the popup.
<!-- openwiki: broken internal link [../../content.js#L1477-L1516] link "../../content.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
ers `BWT_GET_STATE` and handles start/cancel, show/hide translations, show/hide floating UI, and translation removal ([content.js:1477-1516](../../content.js#L1477-L1516)). Popup state is therefore authoritative from the active content script, not maintained separately in the popup.
