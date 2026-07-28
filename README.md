# 双语网页翻译

一个无需构建的 Chrome / Edge Manifest V3 扩展。点击扩展按钮后，它会识别当前网页正文，通过用户配置的 OpenAI-compatible Chat Completions 接口批量翻译，并把简体中文译文插入原文下方。

## 安装

1. 打开 `chrome://extensions`（Edge 使用 `edge://extensions`）。
2. 开启“开发者模式”。
3. 选择“加载已解压的扩展程序”，并选择本仓库目录。
4. 打开普通网页，在扩展弹窗填写完整 Chat Completions API 地址、模型和可选 API Key。
5. 点击“翻译当前页”，并允许扩展访问该 API 域名。

配置保存在 `chrome.storage.local`。API Key 不会写入源码，但浏览器扩展本身不能真正隐藏个人密钥；公开发布前应改用服务端短期令牌。

## 当前范围

- 正文候选：`article`、`main`、`[role="main"]`，否则回退到 `body`。
- 段落候选：标题、段落、列表项、引用和表格单元格。
- 排除导航、页眉页脚、代码、表单、可编辑区域和 `translate="no"` 内容。
- 批次串行请求，每批最多 20 段且不超过约 6000 字符。
- 支持动态新增内容、隐藏译文和再次显示译文。

详细范围见 [实施方案](docs/bilingual_web_translation_extension_plan.md)。
