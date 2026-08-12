---
title: Storage and Data Reference
type: reference
---

# Storage and data reference

All persistent state uses `chrome.storage.local`. The background worker’s maps and lazy cache promise are ephemeral MV3 service-worker memory.

## Settings keys

| Key | Shape | Writers/readers |
|---|---|---|
| `modelConfigs` | Array of up to four `{id,name,apiUrl,model,apiKey,enabled}` records | Options writes; popup summarizes; background reads per operation |
| `apiUrl`, `model`, `apiKey` | Legacy scalar configuration | Read as fallback by options, popup, and background |
| `nativeLanguage` | Supported language code, default `zh-CN` | Options writes; content reads as translation target |
| `glossary` | Text, import limit 4,000 characters | Options writes; background includes in prompt/cache key |
| `selectionTranslationEnabled` | Boolean, default enabled | Popup writes; content reads and watches changes |
| `siteRules` | Object keyed by hostname | Content updates; options import/export |
| `translationCacheV1` | Object keyed by SHA-256 digest | Background owns |
| `readingNotesV1` | Array of normalized note records | Content creates; notes page edits/deletes |

<!-- openwiki: broken internal link [../../options.js#L149-L157] link "../../options.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
<!-- openwiki: broken internal link [../../popup.js#L41-L48] link "../../popup.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
<!-- openwiki: broken internal link [../../background.js#L93-L110] link "../../background.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
Legacy compatibility is implemented in [options.js:149-157](../../options.js#L149-L157), [popup.js:41-48](../../popup.js#L41-L48), and [background.js:93-110](../../background.js#L93-L110).

## Model configuration

```js
{
  id: "stable-id-up-to-100-chars",
  name: "display label",
  apiUrl: "https://…/v1/chat/completions",
  model: "endpoint model identifier",
  apiKey: "optional bearer token",
  enabled: true
}
```

<!-- openwiki: broken internal link [../../options.js#L95-L147] link "../../options.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
The options page requires one to four model records, at least one enabled record, and complete URL/model fields for enabled records. Remote endpoints must use HTTPS; loopback may use HTTP. Enabled origins are deduplicated and requested through `chrome.permissions.request` ([options.js:95-147](../../options.js#L95-L147)).

## Site rules

`siteRules` is keyed by `location.hostname`:

```js
{
  "example.com": {
    selector: "main article", // optional saved content root
    disabled: true            // optional site disable flag
  }
}
```

<!-- openwiki: broken internal link [../../content.js#L248-L259] link "../../content.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
<!-- openwiki: broken internal link [../../options.js#L119-L127] link "../../options.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
Empty rules are removed. Content-side updates re-read the object, modify the current host, and persist it ([content.js:248-259](../../content.js#L248-L259)). Imported files allow up to 500 hosts, 255-character host keys, and 1,000-character selectors ([options.js:119-127](../../options.js#L119-L127)). A missing/invalid selected root falls back to semantic discovery.

## Translation cache

```js
translationCacheV1 = {
  "<64-char-sha256>": {text: "translated text", at: 1710000000000}
}
```

<!-- openwiki: broken internal link [../../background.js#L164-L183] link "../../background.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
<!-- openwiki: broken internal link [../../background.js#L221-L252] link "../../background.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
The digest prevents raw source text from appearing in storage keys. Key material isolates entries by prompt version, model configuration, endpoint/model, glossary, languages, scope, title, relevant rolling context, neighbor text, and source text ([background.js:164-183](../../background.js#L164-L183)). The cache retains at most 300 oldest-by-timestamp entries and coalesces writes ([background.js:221-252](../../background.js#L221-L252)).

## Reading notes

```js
{
  id: "…",
  type: "selection" | "interpretation" | "article-guide",
  title: "page title",
  url: "https://…",
  sourceText: "selected/source text",
  content: "editable note body",
  createdAt: 1710000000000,
  updatedAt: 1710000000000
}
```

<!-- openwiki: broken internal link [../../content.js#L947-L1002] link "../../content.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
<!-- openwiki: broken internal link [../../notes.js#L23-L50] link "../../notes.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
Content-side normalization caps title at 300, URL at 2,000, source text at 1,200, content at 10,000, ID at 100, and the complete collection at the 300 most recently updated notes ([content.js:947-1002](../../content.js#L947-L1002)). The notes page applies the same accepted types and safety-oriented URL normalization ([notes.js:23-50](../../notes.js#L23-L50)).

<!-- openwiki: broken internal link [../../notes.js#L179-L220] link "../../notes.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
Before save or delete, the notes page re-reads storage to preserve ordinary additions made by another extension page. This mitigates races but is not transactional because Chrome storage offers no transaction here ([notes.js:179-220](../../notes.js#L179-L220)).

## Import/export format

<!-- openwiki: broken internal link [../../options.js#L48-L69] link "../../options.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
Settings export creates a JSON object containing format/version metadata and all native-language, glossary, model, API-key, and site-rule data ([options.js:48-69](../../options.js#L48-L69)):

```json
{
  "format": "bilingual-web-translation-settings",
  "version": 1,
  "exportedAt": "…",
  "settings": {
    "nativeLanguage": "zh-CN",
    "glossary": "term=译词",
    "modelConfigs": [],
    "siteRules": {}
  }
}
```

<!-- openwiki: broken internal link [../../options.js#L75-L93] link "../../options.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
Import is intentionally staged: parsing fills the form and stores pending site rules in memory, but the user must click Save so endpoint permissions are requested under a user gesture ([options.js:75-93](../../options.js#L75-L93)). Files over 1 MB and malformed or out-of-range fields are rejected.

## Security and privacy

- API keys are local extension settings, not secret from someone with access to the browser profile or extension runtime.
- Export files contain API keys and must not be uploaded or shared.
- Source paragraphs, title, glossary, and contextual neighbors are sent to configured third-party endpoints.
- Prompts classify page/context content as untrusted, but endpoint operators still receive that content.
- Translation cache values and reading notes persist locally until cleared/deleted.
