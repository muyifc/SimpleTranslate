---
title: Quickstart
type: guide
---

# Quickstart

## Load the extension

No compilation is required.

1. Open `chrome://extensions` or `edge://extensions`.
2. Enable developer mode.
3. Choose **Load unpacked** and select the repository root.
4. Open the extension popup and choose **Settings**.
5. Add at least one enabled model with an OpenAI-compatible Chat Completions URL and model name. Add an API key if the endpoint requires one.
6. Save and accept the requested endpoint-origin permission.
7. Open or refresh an ordinary HTTP(S) page and start translation from the popup or floating “译” ball.

<!-- openwiki: broken internal link [../README.md#L5-L15] link "../README.md" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
<!-- openwiki: broken internal link [../options.js#L130-L147] link "../options.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
These are the repository’s documented installation steps ([README.md:5-15](../README.md#L5-L15)). The options page accepts HTTPS endpoints, plus HTTP only for `localhost`, `127.0.0.1`, and `[::1]`, then requests optional permission for enabled origins ([options.js:130-147](../options.js#L130-L147)).

## Basic use

- **Page translation:** toggle “当前网页翻译” or click the floating ball. Only paragraphs that settle in the viewport are queued.
- **Stop:** click the translating ball again or use its context menu. Cancellation clears queued work and aborts background requests.
- **Original/translation visibility:** toggle from the popup or floating menu. Original DOM content is not replaced.
- **Selection actions:** select up to 1,200 characters and use “译” for translation, “释” for contextual interpretation, or “记” for a direct excerpt.
- **Alt-hover:** hold Alt over a paragraph for a short translation preview.
- **Article guide:** right-click the ball and generate a summary/outline/core-points/key-terms guide from up to 20,000 characters.
- **Reading notes:** save excerpts, interpretations, or article guides, then open the standalone notes page to edit or export Markdown.

<!-- openwiki: broken internal link [../README.md#L17-L42] link "../README.md" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
The implemented feature range is summarized in [README.md:17-42](../README.md#L17-L42).

## Configuration behavior

<!-- openwiki: broken internal link [../background.js#L93-L139] link "../background.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
The extension supports up to four active model configurations. Ordinary page and quick translations call enabled models concurrently and show labelled variants; interpretation and article-guide operations use only the first enabled model ([background.js:93-139](../background.js#L93-L139)).

A model endpoint is expected to accept an OpenAI-style request:

```json
{
  "model": "configured-model-name",
  "temperature": 0,
  "messages": [
    {"role": "system", "content": "operation-specific instructions"},
    {"role": "user", "content": "serialized languages, glossary, context, and paragraphs"}
  ]
}
```

<!-- openwiki: broken internal link [../background.js#L299-L369] link "../background.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
The service worker reads `choices[0].message.content`, removes optional Markdown JSON fences, and strictly validates translation IDs and cardinality ([background.js:299-369](../background.js#L299-L369)).

## Run validation

From a Windows PowerShell prompt in the repository root:

```powershell
node test_background.js
powershell -ExecutionPolicy Bypass -File .\test_content.ps1
```

- `test_background.js` runs service-worker code in a mocked Node VM and checks manifest/static contracts.
- `test_content.ps1` opens browser fixtures in headless Chrome and requires each dumped DOM to report `data-test="passed"`.

For a full release gate:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\package.ps1
```

<!-- openwiki: broken internal link [../scripts/package.ps1#L18-L69] link "../scripts/package.ps1" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
The packaging script runs syntax checks and both test suites before staging the release allowlist, creating a ZIP, verifying its contents, and writing an SHA-256 sidecar ([scripts/package.ps1:18-69](../scripts/package.ps1#L18-L69)).

## Development loop

Because there is no build step:

1. Edit the root-level production file directly.
2. Reload the extension at the extensions page.
3. Refresh the target page when changing the content script.
4. Run the narrow fixture covering the behavior, then the complete suites before release.
5. If a production runtime asset is added, add it to the packaging allowlist or it will not appear in the ZIP.

When changing popup, options, or notes-page markup, check their browser fixtures too: those tests reproduce page structure and can drift from the production HTML.

## Security note

<!-- openwiki: broken internal link [../README.md#L15] link "../README.md" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
<!-- openwiki: broken internal link [../options.js#L48-L69] link "../options.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
Configuration is stored in `chrome.storage.local`. The browser extension cannot truly conceal a personal API key; exported JSON explicitly includes API keys. Do not publish exported settings, and use server-issued short-lived credentials for public distribution ([README.md:15](../README.md#L15), [options.js:48-69](../options.js#L48-L69)).
