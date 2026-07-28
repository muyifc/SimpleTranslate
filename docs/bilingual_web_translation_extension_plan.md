# 双语网页翻译浏览器扩展实施方案

## 文档定位

本文记录一个类似“沉浸式翻译”核心网页翻译体验的独立浏览器扩展方案，供后续在新文件夹、新仓库中实施。

本方案不属于 AudioOutputRecorder 的录音、转写或文本整理职责，不在当前仓库添加扩展源码，也不复用或复制沉浸式翻译的闭源代码。

## 目标

首版只解决一个问题：用户点击扩展按钮后，将当前网页正文翻译为简体中文，并把译文显示在原文下方。

首版目标：

- 支持最新版 Chrome 和 Edge。
- 保留原文，提供双语对照显示。
- 自动识别页面语言，目标语言固定为简体中文。
- 调用一个 OpenAI-compatible 翻译接口。
- 逐段独立翻译并即时显示状态，同时限制并发请求。
- 支持动态网页新增内容。
- 支持恢复原文和再次显示译文。

## 非目标

首版不做：

- PDF、ePub、Word 等文档翻译。
- 图片 OCR、图片修复和漫画翻译。
- 视频字幕、无字幕语音识别和会议翻译。
- 账户、订阅、支付、额度系统。
- 多翻译引擎切换和翻译服务插件体系。
- 云端配置同步和跨设备同步。
- 面向所有网站的复杂规则编辑器。

需要上述能力时再分别立项，不提前搭建抽象层。

## 原理概览

```text
用户点击“翻译当前页”
        ↓
内容脚本扫描当前页面 DOM
        ↓
过滤导航、代码、表单等非正文区域
        ↓
把文本节点合并成可翻译段落
        ↓
逐段发送给扩展后台脚本（限制并发）
        ↓
后台调用 OpenAI-compatible API
        ↓
按段落 ID 映射翻译结果
        ↓
在原文后插入译文节点
        ↓
监听页面新增内容并增量翻译
```

类似产品的核心难点不是调用翻译 API，而是网页正文识别、段落重组、动态页面适配、排版保护和请求调度。

## 技术选择

### 浏览器扩展

- 标准：Manifest V3。
- 首版浏览器：Chrome、Edge。
- 语言：原生 JavaScript、HTML、CSS。
- 构建工具：首版不引入；浏览器直接加载源码目录。
- 权限：`activeTab`、`scripting`、`storage`。

首版由用户主动点击后使用 `activeTab` 注入内容脚本，不申请 `<all_urls>` 常驻访问权限。后续增加“总是翻译此网站”时，再申请可选站点权限。

### 翻译接口

首版只实现一个 `translateBatch()` 函数，调用 OpenAI-compatible Chat Completions 接口。不为单一实现创建 provider 接口或工厂。

建议请求输入：

```json
{
  "sourceLanguage": "auto",
  "targetLanguage": "zh-CN",
  "paragraphs": [
    { "id": "p-1", "text": "First paragraph" },
    { "id": "p-2", "text": "Second paragraph" }
  ]
}
```

要求模型只返回对应 ID 和译文：

```json
{
  "translations": [
    { "id": "p-1", "text": "第一段" },
    { "id": "p-2", "text": "第二段" }
  ]
}
```

如果只是个人使用，可以由用户在扩展设置中填写 API 地址、模型和 Key，并保存在 `chrome.storage.local`。这不等于真正隐藏密钥；如果未来公开发布，应改为服务端持有密钥，扩展只使用短期访问令牌。

## 最小目录结构

建议在新的项目文件夹中创建：

```text
bilingual-web-translator/
├─ manifest.json
├─ README.md
├─ popup.html
├─ popup.js
├─ popup.css
├─ content.js
├─ content.css
├─ background.js
└─ icons/
```

职责：

- `popup.*`：翻译、恢复原文、设置入口。
- `content.js`：扫描 DOM、建立段落、插入译文、监听新增节点。
- `content.css`：双语译文样式。
- `background.js`：读取配置并调用翻译 API。
- `manifest.json`：权限、后台脚本和弹窗声明。

首版文件保持平铺；只有代码明显变大后才拆分目录。

## DOM 扫描规则

### 默认候选区域

优先扫描：

- `article`
- `main`
- `[role="main"]`
- 页面不存在上述区域时回退到 `body`

默认候选元素：

- `h1` 至 `h6`
- `p`
- `li`
- `blockquote`
- `td`、`th`

### 默认排除区域

- `script`、`style`、`noscript`
- `pre`、`code`、`kbd`
- `textarea`、`input`、`select`
- `[contenteditable="true"]`
- `[translate="no"]`、`.notranslate`
- `nav`、`header`、`footer`
- 扩展自己插入的 `.bwt-translation`

### 文本处理

- 忽略纯空白、纯数字和过短文本。
- 合并同一段落内被 `span`、`a`、`strong`、`em` 等内联元素切开的文本。
- 为每个待翻译段落生成稳定 ID。
- 不修改原始文本节点。
- 使用新节点在原文后插入译文。

首版不处理复杂富文本回填。译文使用 `textContent`，禁止把模型返回值直接赋给 `innerHTML`。

## 动态页面处理

使用一个 `MutationObserver` 监听新增节点：

- 忽略扩展自己插入的译文节点。
- 对新增区域执行相同扫描规则。
- 用短延迟合并连续变化，避免每次 DOM 变更都请求 API。
- 记录已处理文本或元素，避免重复翻译。

首版不处理所有 Shadow DOM 和虚拟列表边界；遇到明确网站需求后增加站点规则。

## 请求调度

- 每个段落独立请求，发送前先在对应位置插入占位状态。
- 同时最多处理 3 个请求，避免触发常见接口限流。
- 单个段落不超过 6,000 字符，结果返回后立即替换对应占位。
- 请求失败时保留原文，并在弹窗中显示错误。
- 同一页面重复点击时复用当前会话缓存。

持久化翻译缓存、复杂重试、指数退避和多服务降级不进入首版，等真实使用证明需要后再添加。

## 页面渲染

译文节点示例：

```html
<div class="bwt-translation" data-source-id="p-1">翻译结果</div>
```

首版支持两种状态：

- 双语：原文和译文同时显示。
- 原文：隐藏扩展插入的译文。

“仅译文”模式会涉及隐藏原文后的布局恢复和可访问性问题，首版可暂缓。

## 隐私和安全

- 只在用户点击后读取当前页面。
- 只发送被识别为正文的文本，不发送 Cookie、Local Storage 或完整 HTML。
- 密码框、输入框、可编辑区域默认不读取、不翻译。
- API Key 不写入源码或仓库。
- 日志不打印 Key、请求头或完整网页文本。
- 模型返回值按纯文本渲染，避免脚本注入。
- 弹窗明确提示：翻译文本会发送到用户配置的翻译服务。

## 分阶段实施

### 阶段 1：可运行原型

- 新建独立文件夹和 Git 仓库。
- 创建 Manifest V3 扩展。
- 点击按钮后扫描静态页面。
- 调用一个翻译接口。
- 在原文下方插入译文。
- 在 Chrome 扩展开发者模式中手动加载验证。

### 阶段 2：可用 MVP

- 增加逐段翻译、占位状态和错误提示。
- 增加设置页或简易配置区域。
- 增加 `MutationObserver` 动态内容翻译。
- 增加恢复原文和重复点击保护。
- 验证普通文章、GitHub README、新闻页和一个 SPA 页面。

### 阶段 3：按反馈补齐

- 站点专用选择器规则。
- 可视区域延迟翻译。
- 持久缓存。
- 悬停翻译和划词翻译。
- 可选站点权限和自动翻译规则。

除非真实用户明确需要，不进入 PDF、OCR、视频字幕和账户系统。

## 验收标准

- 用户能在 Chrome/Edge 中手动加载扩展。
- 点击一次后，普通文章页正文显示中英双语。
- 原网页文本、链接和基本布局不被破坏。
- 代码块、输入框、导航栏默认不翻译。
- API 失败不会清空或覆盖原文。
- 动态新增的普通段落能被翻译且不会重复插入。
- API Key 不出现在源码、日志和版本库中。

## 预计工作量

- 可运行原型：约 2 至 3 天。
- 较稳定的网页翻译 MVP：约 2 至 4 周。
- PDF、OCR、视频字幕、会议翻译等完整产品能力：数月级，需分别设计。

## 调研来源

- 沉浸式翻译官网：<https://immersivetranslate.com/zh-Hans/>
- 官方高级配置和站点规则：<https://immersivetranslate.com/docs/advanced/>
- 官方隐私政策：<https://immersivetranslate.com/docs/PRIVACY/>
- 官方发布包：<https://github.com/immersive-translate/immersive-translate/releases>
- 官方仓库关于闭源状态的说明：<https://github.com/immersive-translate/immersive-translate>
- 已归档的旧版源码：<https://github.com/immersive-translate/old-immersive-translate>
- Chrome 内容脚本文档：<https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts>
- MutationObserver 文档：<https://developer.mozilla.org/docs/Web/API/MutationObserver>
