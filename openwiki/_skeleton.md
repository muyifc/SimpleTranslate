---
title: OpenWiki Skeleton
type: skeleton
---

# OpenWiki skeleton

Scope: A code wiki for the build-free Manifest V3 bilingual web translation extension in this repository. Source code and tests are authoritative.

## Pages

1. `index.md` — repository purpose, capability map, runtime surfaces, and navigation.
2. `quickstart.md` — load unpacked, configure an OpenAI-compatible endpoint, use the extension, run tests, and package a release.
3. `architecture/overview.md` — MV3 topology, component boundaries, end-to-end data flow, and lifecycle.
4. `architecture/content-script.md` — root/candidate discovery, viewport scheduling, language detection, batching, cancellation, DOM rendering, dynamic-page handling, floating/selection/guide UI.
5. `architecture/background-service.md` — runtime message API, model fan-out, API request/response contract, retries/timeouts/cancellation, strict validation, and cache behavior.
6. `reference/storage-and-data.md` — `chrome.storage.local` keys and schemas, model configuration, site rules, cache, reading notes, import/export, and security considerations.
7. `features/user-interfaces.md` — popup, options, floating controls, selection actions, article guide, and standalone notes page.
8. `development/testing-and-release.md` — no-build development model, Node and headless-browser test suites, fixture organization, packaging allowlist, release validation, and known maintenance constraints.

## Cross-cutting requirements

- Every page includes source-linked evidence using repository-relative file/line references.
- Clearly separate content-script scheduling from background API orchestration.
- Document legacy single-model compatibility and explicit multi-model result shapes.
- Call out optional host permissions, local API-key exposure, untrusted prompt context, and endpoint restrictions.
- Explain that HTML fixtures duplicate some production markup and that PowerShell/Chrome paths impose a Windows-oriented test workflow.
