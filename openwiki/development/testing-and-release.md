---
title: Testing and Release
type: development
---

# Testing and release

## Development model

<!-- openwiki: broken internal link [../../manifest.json#L14-L44] link "../../manifest.json" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
The repository ships plain JavaScript, HTML, and CSS directly; there is no bundling or dependency installation step. The manifest points at root-level production assets ([manifest.json:14-44](../../manifest.json#L14-L44)). Reload the unpacked extension after edits, and refresh target tabs after content-script changes.

## Node service-worker suite

Run:

```powershell
node test_background.js
```

<!-- openwiki: broken internal link [../../test_background.js#L1-L43] link "../../test_background.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
<!-- openwiki: broken internal link [../../test_background.js#L62-L174] link "../../test_background.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
`test_background.js` combines static assertions with execution of `background.js` in a mocked Node VM. It validates manifest/page contracts and deterministically exercises runtime messages, fetches, storage, model fan-out, cache behavior, cancellation, retry, timeout, interpretation, guide generation, and opening notes. The harness setup begins at [test_background.js:1-43](../../test_background.js#L1-L43) and [test_background.js:62-174](../../test_background.js#L62-L174).

Because the worker is evaluated with mocks, these tests can force network/status/timing paths without real endpoints.

## Headless browser fixtures

Run all browser fixtures:

```powershell
powershell -ExecutionPolicy Bypass -File .\test_content.ps1
```

<!-- openwiki: broken internal link [../../test_content.ps1#L1-L32] link "../../test_content.ps1" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
The runner starts each HTML fixture with a fresh temporary Chrome profile, headless mode, and `--dump-dom`. A test passes only when the resulting DOM contains `data-test="passed"`; failures report the page title and preserve relevant output ([test_content.ps1:1-32](../../test_content.ps1#L1-L32)).

Fixture responsibilities include:

| Fixture | Main coverage |
|---|---|
| `test_content.html` | core root selection, translation lifecycle, batching, progress, visibility, cancellation |
| `test_features.html` | site rules, dynamic DOM, context, fallback/retry, quick actions, guide |
| `test_batching.html` | 10,000-character batch limit |
| `test_multi_model.html` | variant labels, partial/stale behavior |
| `test_scroll_priority.html` | dwell, offscreen cancellation, current-viewport priority |
| `test_popup.html` | popup state and controls |
| `test_options.html` | legacy load, multi-model save, permissions, import/export, cache clear |
| `test_notes.html` | content-side note creation and cap |
| `test_notes_page.html` | standalone note editing/export/deletion and storage races |

Popup/options/notes-page fixtures reproduce portions of production markup instead of loading the production HTML documents. When changing those pages, update and review both the real markup and fixture structure.

## Real-page smoke test

Run the optional live-page suite separately:

```powershell
node .\scripts\test_real_pages.js
```

<!-- openwiki: broken internal link [../../scripts/test_real_pages.js#L254-L304] link "../../scripts/test_real_pages.js" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
`scripts/test_real_pages.js` drives Chrome DevTools Protocol against live pages and checks real-world discovery, dynamic content, exclusion behavior, duplicate IDs, layout width, and cancellation. It is useful for smoke testing but depends on Chrome, network access, and external page stability ([scripts/test_real_pages.js:254-304](../../scripts/test_real_pages.js#L254-L304)). Keep deterministic repository fixtures as the primary regression gate. This script is **not invoked by `scripts/package.ps1`**, so it is an additional check rather than a release-archive gate.

## Packaging

Run:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\package.ps1
```

The script:

1. reads the manifest version for archive naming;
2. defines an explicit production-file allowlist;
3. fails if an allowlisted file is absent;
4. runs `node --check` on selected production scripts;
5. runs the Node and browser suites;
6. stages only allowlisted files;
7. creates the ZIP;
8. extracts and verifies expected contents;
9. writes an SHA-256 sidecar;
10. removes temporary directories in `finally`.

<!-- openwiki: broken internal link [../../scripts/package.ps1#L12-L73] link "../../scripts/package.ps1" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
See [scripts/package.ps1:12-73](../../scripts/package.ps1#L12-L73). Tests, logs, repository metadata, plans, scripts, and OpenWiki pages are intentionally excluded from the extension archive.

## Adding a runtime asset

A new file can work while loading the repository unpacked yet be absent from a release. When adding runtime HTML, JS, CSS, or images:

1. reference it from the manifest or an existing packaged page/script;
2. add it to the `$files` allowlist in `scripts/package.ps1`;
3. add a syntax check when appropriate;
4. add or update a deterministic test;
5. run the full package command.

<!-- openwiki: broken internal link [../../scripts/package.ps1#L18-L44] link "../../scripts/package.ps1" is outside the wiki root. Fix the href or restore the target, then delete this comment. -->
One current detail: `notes.js` is packaged and exercised by the browser suite, but the explicit `node --check` loop covers `background.js`, `content.js`, `popup.js`, and `options.js` rather than `notes.js` ([scripts/package.ps1:18-44](../../scripts/package.ps1#L18-L44)).

## Platform constraints

The documented automation is Windows-oriented:

- PowerShell scripts are used for browser tests and packaging.
- `test_content.ps1` uses a Windows Chrome installation path.
- The real-page script also expects a Chrome executable.

On another platform, reproduce the same commands/flags and pass criteria with a local Chrome path rather than assuming the PowerShell runner is portable.

## Change validation guide

- **Background/network/cache:** run `node test_background.js` first.
- **DOM/scheduler/floating UI:** run the relevant content fixture, then all of `test_content.ps1`.
- **Popup/options/notes UI:** check production markup and its duplicated fixture.
- **Manifest/permissions/assets:** run the background static assertions and package command.
- **Release:** always run `scripts/package.ps1`, since it validates both behavior and archive composition.
