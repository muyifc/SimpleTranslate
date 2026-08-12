# Edge 扩展商店提交 — 隐私表单填写说明

在 Microsoft Edge 扩展商店提交扩展时,「隐私」(Privacy) 页需要填写 4 个字段(各限 1000 字符),分别对应本项目 `manifest.json` 中声明的权限。以下内容可直接复制使用(英文,便于审核)。

## Single purpose description

> This extension translates web pages in place: it detects non-native paragraphs in the visible content of a page and renders their translation in the user's chosen language directly below the original text. It supports configurable AI models via OpenAI-compatible APIs, user-managed glossaries, and on-demand translation triggered from a floating ball or the extension popup.

## activeTab justification

> The activeTab permission is used only when the user explicitly triggers translation, so the extension can access the current tab's page content to identify and translate the visible paragraphs. No background or automatic access to any tab is performed; translation starts exclusively from explicit user actions such as clicking the floating ball, the popup switch, or a selected-text shortcut.

## scripting justification

> The scripting permission is required to inject the content script and CSS into the current page when the user starts a translation, and to insert translated paragraphs under the original text. Scripts are injected only on explicit user request on the active tab; the extension never executes code in the background or on arbitrary pages.

## storage justification

> The storage permission saves the user's own configuration locally in the browser: model endpoints and API keys, target language, glossary terms, per-site content-area rules, and translated-text cache. All data stays in chrome.storage.local; nothing is transmitted to any server except the translation request to the user-configured API endpoint.

## 备注

- 每栏文本总长均小于 1000 字符,可直接粘贴。
- 表单只要求填写这 4 栏;`manifest.json` 中的 `optional_host_permissions`(按需请求站点权限)不在本表单范围,无需在此说明。
- API Key 说明:扩展在设置页中提示密钥仅存于本地浏览器,公开分发无法真正隐藏个人密钥,建议生产环境改用服务端短期令牌。
