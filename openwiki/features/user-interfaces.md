---
title: User Interfaces
type: feature
---

# User interfaces

## Popup

The popup is an active-tab control surface with links to settings and notes plus four switches:

- page translation enabled;
- translations visible;
- floating ball visible;
- selection translation enabled.

<!-- openwiki: broken internal link [../../popup.js#L23-L48] link "../../popup.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
<!-- openwiki: broken internal link [../../popup.js#L64-L76] link "../../popup.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
Initialization loads model readiness and the global selection preference, resolves the active HTTP(S) tab, and asks the content script for `BWT_GET_STATE` ([popup.js:23-48](../../popup.js#L23-L48)). Page switches map to paired runtime commands; after each operation, the popup re-queries state ([popup.js:64-76](../../popup.js#L64-L76)).

<!-- openwiki: broken internal link [../../popup.js#L82-L90] link "../../popup.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
If the declarative content script is missing, the initial query can inject `content.css` and `content.js` through `chrome.scripting` and retry ([popup.js:82-90](../../popup.js#L82-L90)). Translation start is blocked unless all enabled models have an endpoint and model name.

<!-- openwiki: broken internal link [../../popup.js#L51-L61] link "../../popup.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
Selection translation is a global storage preference rather than a current-tab command ([popup.js:51-61](../../popup.js#L51-L61)).

## Options page

The options page manages up to four model cards plus native language, glossary, import/export, and cache clearing. Saving:

1. normalizes model cards;
2. validates enabled endpoints/models;
3. requests optional endpoint-origin permissions;
4. writes models, glossary, language, and pending imported site rules.

<!-- openwiki: broken internal link [../../options.js#L26-L46] link "../../options.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
<!-- openwiki: broken internal link [../../options.js#L130-L147] link "../../options.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
<!-- openwiki: broken internal link [../../options.js#L149-L157] link "../../options.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
See [options.js:26-46](../../options.js#L26-L46) and [options.js:130-147](../../options.js#L130-L147). It can load legacy scalar model fields into one editable card ([options.js:149-157](../../options.js#L149-L157)).

<!-- openwiki: broken internal link [../../options.js#L48-L93] link "../../options.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
<!-- openwiki: broken internal link [../../options.js#L159-L170] link "../../options.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
Export requires confirmation because API keys are included. Import validates but does not persist until Save, preserving a user gesture for permission acquisition ([options.js:48-93](../../options.js#L48-L93)). Cache clearing delegates to `BWT_CLEAR_CACHE` instead of directly modifying the worker’s cache ([options.js:159-170](../../options.js#L159-L170)).

## Floating ball and context menu

The content script creates a draggable fixed-position ball that docks to either viewport edge. Primary click starts/stops translation; context-click opens controls for:

- article guide and reading notes;
- cancellation and failed-paragraph retry;
- selection-action preference;
- selecting or clearing a content region;
- disabling/enabling the site;
- original/translation visibility;
- hiding the floating control.

<!-- openwiki: broken internal link [../../content.js#L440-L562] link "../../content.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
<!-- openwiki: broken internal link [../../content.js#L349-L413] link "../../content.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
<!-- openwiki: broken internal link [../../content.css#L40-L248] link "../../content.css" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
Creation and pointer behavior live at [content.js:440-562](../../content.js#L440-L562). Status rendering covers idle, translating progress, ready, error, cancelled, region-selection, and disabled states ([content.js:349-413](../../content.js#L349-L413)). CSS uses reset/isolation rules, fixed positioning, maximum z-index, state colors, and reduced-motion handling ([content.css:40-248](../../content.css#L40-L248)).

## Selection and hover actions

The quick toolbar offers:

- **译:** quick translation using the shared request scheduler;
- **释:** contextual plain-language interpretation and key-term explanation;
- **记:** direct selection excerpt.

<!-- openwiki: broken internal link [../../content.js#L1330-L1416] link "../../content.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
<!-- openwiki: broken internal link [../../content.js#L1418-L1455] link "../../content.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
Selection is ignored inside extension controls and excluded page regions, when site/feature state disallows it, or above 1,200 characters ([content.js:1330-1416](../../content.js#L1330-L1416)). Interpretation can be saved as a separate note. Holding Alt over a candidate for about 400 ms opens a quick translation preview; click-away, mouseout, Escape, or generation changes invalidate it ([content.js:1418-1455](../../content.js#L1418-L1455)).

## Article guide drawer

<!-- openwiki: broken internal link [../../content.js#L621-L645] link "../../content.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
<!-- openwiki: broken internal link [../../content.js#L1026-L1109] link "../../content.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
The guide gathers connected candidate text from active roots up to 20,000 characters. The background prompt asks for summary, outline, core points, and key terms. Results appear in an accessible right-side drawer and can be saved as an `article-guide` note ([content.js:621-645](../../content.js#L621-L645), [content.js:1026-1109](../../content.js#L1026-L1109)). Closing or reopening advances a generation counter so stale responses cannot update a closed drawer.

## Reading notes page

<!-- openwiki: broken internal link [../../notes.js#L9-L27] link "../../notes.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
The standalone notes page reads `readingNotesV1`, normalizes entries, sorts newest first, and selects the latest record ([notes.js:9-27](../../notes.js#L9-L27)). Its two-pane UI provides:

- note list with type/time/excerpt;
- editable content;
- save;
- safe opening of HTTP(S) source URLs;
- Markdown export;
- deletion.

<!-- openwiki: broken internal link [../../notes.js#L89-L220] link "../../notes.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
<!-- openwiki: broken internal link [../../notes.js#L61-L87] link "../../notes.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
Rendering and actions are implemented at [notes.js:89-220](../../notes.js#L89-L220). Markdown output includes title, type, update time, optional source link/quotation, and current editor text ([notes.js:61-87](../../notes.js#L61-L87)). Content-page creation and standalone-page editing deliberately share the same storage schema.

<!-- openwiki: broken internal link [../../background.js#L18-L23] link "../../background.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
The notes page is opened either by the popup’s direct `notes.html` link or by `BWT_OPEN_READING_NOTES`, which asks the worker to create an extension tab ([background.js:18-23](../../background.js#L18-L23)).

## Accessibility and host-page isolation

<!-- openwiki: broken internal link [../../content.js#L7-L40] link "../../content.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
Controls use buttons, labels, live/status regions, `aria-current`, labelled drawer controls, focus/hover styles, and `dir="auto"` for generated text. In-page CSS is scoped to `.bwt-*` and controls are marked `data-bwt-control`, which also keeps them out of candidate discovery ([content.js:7-40](../../content.js#L7-L40)).
