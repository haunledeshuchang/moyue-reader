<div align="center">

<img src="docs/icon.png" width="112" alt="墨阅图标">

# 墨阅 MoYue

**Windows 端沉浸式本地阅读器** — EPUB · PDF · TXT · MOBI，双页对开、纸书排版、旁批留白。

[![格式](https://img.shields.io/badge/格式-EPUB%20·%20PDF%20·%20TXT%20·%20MOBI-0f6e56?style=flat-square)](#四种格式一个书架)
[![平台](https://img.shields.io/badge/平台-Windows%20x64-0f6e56?style=flat-square)](#快速开始)
[![技术](https://img.shields.io/badge/技术-Electron%2040%20·%20零后端-0f6e56?style=flat-square)](#技术架构)
[![License](https://img.shields.io/badge/license-MIT-0f6e56?style=flat-square)](LICENSE)

**简体中文** · [English](README.md)

</div>

---

参考小幻阅读（Rodel.Reader）的产品形态，结合 WPS 式阅读习惯与个人需求，从零构建。

<div align="center">
<img src="docs/screenshots/shelf.png" width="880" alt="书架">
</div>

## 功能特性

### 四种格式，一个书架

| 格式 | 解析方案 | 说明 |
|------|----------|------|
| EPUB | epub.js | 完整排版、双页对开、CFI 进度记忆、目录导航 |
| PDF | pdf.js 4.10 | **左右翻页（横向分页，非上下滚动）**、整页适配、懒渲染、缩放、大纲 |
| TXT | 自研解析器 | 编码自动识别（BOM → UTF-8 严格校验 → GB18030 兜底）、中英文章节智能切分 |
| MOBI / AZW3 | **自研解析器** | 完整实现 PalmDOC LZ77 / HUFF-CDIC 解压、MOBI6 + KF8 双格式、EXTH 元数据、封面与插图提取、DRM 检测 |

### 三套纸面主题

- **日间** ☀ 暖白纸面，长时间阅读不刺眼
- **夜间** ☾ 深灰纸面，暗光环境不伤眼
- **护眼** ❧ 淡绿纸面（RGB 199,237,204），缓解视疲劳

主题作用于应用界面与阅读区域，EPUB 主题注入 iframe 内部，切换即时生效。

### 阅读体验

- **双页对开（像翻开一本真书）**：EPUB / MOBI / TXT 在宽屏下自动左右两页对开，中间是**WPS 式竖向虚线分页线** + 极轻书脊渐变；窗口变窄时自动回退单页，始终不挤压。模式随时可切「单页 / 双页 / 滚动」。
- **左右页严格居中（等比留白）**：正文列到中缝的距离 = 到外侧页边的距离（实测 1904px 窗口下双双 140px），两侧空出的余白正好用来写旁批。单页模式同理：版心居中等分左右留白。**打开目录侧栏 / 标注抽屉后舞台变窄，会立刻按新宽度重新分栏**，文字始终在剩余空间里居中，不会被推出屏幕右侧。
- **左右翻页（含 PDF）**：EPUB/MOBI/TXT 用键盘 `←`/`→` 或贴边箭头翻页，跨章无缝衔接，60fps 满帧。**已取消鼠标拖拽 / 触控板滑动翻页**——避免划词、批注时误翻页，指针完全交给文字选择。**PDF 也改为左右翻页**（横向分页 + scroll-snap，整页完整可见，不再是上下滚动）。
- **一次只翻一页**：所有格式每次翻页严格前进/后退一个「页/跨页」，页码随之 +1，不会出现「感觉翻了两页」。
- **翻页效果三档**：滑动（默认，参考 Moon+ / WPS）/ 淡入 / 无，随心切换。
- **翻页箭头（WPS 式，全格式可见）**：屏幕左右边缘的悬浮箭头默认隐藏，鼠标贴近边缘才淡入，**点击箭头才翻页**；点正文、拖选文字都不会翻页。
- **左下角全书总页码（全格式）**：显示「第 35 / 212 页」这样的**全书页码**而不是章节页码；每翻一页严格 +1，切换单/双页、字号、窗口大小时总页数稳定不乱跳（PDF 为「第 3 / 8 页」）。
- **上下各留一行**：EPUB / MOBI / TXT 的正文块上下各留出正好一行行高的空白（与页眉、页脚等距），不会顶格。
- **纸书级排版**：首行缩进 2 字符、段间 0.26em、两端对齐（`text-justify: inter-character`）、`line-break: strict`、`text-spacing-trim` / `text-autospace`（中西文自动间距、标点挤压）；EPUB 仅在出版方「无缩进且段间无留白」时才补缩进，不破坏原书版式。
- **常驻控制栏**：阅读时顶部的目录 / 主题 / 版式控制栏始终显示，中途不可关闭，随时可调。
- **彩色标注（6 色荧光笔）**：顶栏荧光笔面板或选中文字浮出的工具栏提供红/橙/黄/绿/蓝/紫六色，对重点句段做高亮，复读时一眼可辨。
- **阅读批注（仿 Word 边注）**：选中文字后点「批注」，在旁白编辑区写下阅读心得（Ctrl+Enter 保存）。所有标注与批注汇总于右侧抽屉，支持**跳转 / 修改 / 删除**，并可**一键导出 Markdown** 笔记。
- **版式调节**：字号、行距、字体（系统/宋体/黑体/楷体/**Times New Roman**）、页边距
- **目录导航**：EPUB 完整目录、MOBI/TXT 智能章节识别（支持「第 X 章」「Chapter N」「序/楔子/尾声」等中英文模式）
- **书签**：Ctrl+B 随时标记，书签面板一键回跳
- **进度记忆**：每本书独立记忆阅读位置（CFI / 页码 / 滚动比例）+ 标注数据，重开自动恢复
- **键盘快捷键**：

| 按键 | 功能 |
|------|------|
| `←` `→` / `PgUp` `PgDn` / 空格 | 翻页（程序化，等同翻页箭头） |
| `H` | 顶栏荧光笔颜色面板（开/关） |
| `N` | 标注与批注抽屉（开/关） |
| `T` | 目录/书签面板 |
| `M` | 切换主题 |
| `F` | 版式设置 |
| `Ctrl+B` | 添加书签 |
| `F11` | 全屏 |
| `Esc` | 退出面板/沉浸/返回书架 |

> **标注操作**：选中文字后浮出工具栏，点色块即高亮；点「批注」在旁白区写心得（Ctrl+Enter 保存）。在文本上**长按**可直接进入选词模式，再拖动可扩展选区（移动端/触控板友好）。

<div align="center">
<img src="docs/screenshots/epub-dual.png" width="880" alt="EPUB 双页对开（目录展开）">
<sub>EPUB 双页对开 —— WPS 式竖向虚线中缝、左右严格等距，目录侧栏展开后依然居中</sub>
</div>

<div align="center">
<img src="docs/screenshots/txt-chinese.png" width="880" alt="中文 TXT 排版">
<sub>TXT —— 编码自动识别、首行缩进 2 字符、两端对齐、全书总页码</sub>
</div>

### 书架管理

- 网格 / 列表双视图，封面自动提取（EPUB 内嵌封面、PDF 首页缩略图、MOBI 封面记录、TXT 生成式占位封面）
- 拖拽导入、搜索（书名/作者）、排序（最近阅读/最近导入/书名/进度）
- 阅读进度条直接显示在封面上

## 快速开始

### 方式一：安装包（推荐）

下载 `墨阅MoYue-0.1.1-x64.exe` 双击安装，或使用便携版 `墨阅MoYue-0.1.1-便携版.exe` 免安装直接运行。

### 方式二：开发模式

```bash
# 环境要求：Node.js 22+
npm install
npm start
```

> 注：Electron 二进制如遇网络问题，可使用镜像：
> `npm config set electron_mirror https://npmmirror.com/mirrors/electron/`

### 导入图书

1. 点击右上角「导入图书」，或
2. 直接把 `.epub` / `.pdf` / `.txt` / `.mobi` / `.azw3` 文件拖进窗口，或
3. 在文件资源管理器中双击图书文件（安装版已关联格式）

## 技术架构

```
moyue-reader/
├── main.js                  # 主进程：窗口管理 / 自定义协议 / 书库存储
├── preload.js               # 预加载：contextBridge 安全 API
├── src/
│   ├── index.html           # 书架页
│   ├── reader.html          # 阅读器页
│   ├── js/
│   │   ├── bookshelf.js     # 书架：网格/列表、封面提取、搜索排序
│   │   ├── reader.js        # 阅读器总控：格式路由、快捷键、进度保存、标注/批注/箭头
│   │   ├── themes.js        # 三主题 CSS 变量系统 + 字体族（含 Times New Roman）
│   │   ├── page-turn.js     # 翻页引擎：箭头/键盘翻页 + 长按选词（拖拽翻页已关闭）
│   │   ├── annotations.js   # 标注核心：6 色、CFI/文本偏移/页内偏移三种定位、落盘
│   │   ├── selection-toolbar.js # 选中浮出工具栏：六色荧光笔 + 批注编辑区
│   │   ├── parsers/
│   │   │   ├── mobi-parser.js   # 自研 MOBI/AZW3 解析器（核心）
│   │   │   └── txt-parser.js    # TXT 编码识别与章节切分
│   │   └── renderers/
│   │       ├── epub-renderer.js # epub.js 封装 + iframe 手势 + CFI 高亮
│   │       ├── pdf-renderer.js  # pdf.js 4.10 封装 + 透明文本层（视口变换定位）+ 高亮
│   │       └── text-renderer.js # TXT/MOBI 多列分页 + peek 跨章滑移 + 高亮 + 长按选词
│   ├── vendor/              # epub.js / jszip / pdf.js（本地化，无 CDN 依赖）
│   └── css/                 # 书架与阅读器样式
└── build/                   # 应用图标资源
```

### 关键技术点

1. **自研 MOBI 解析器**：基于 PalmDB / MOBI 头规范完整实现——PalmDOC LZ77 解压（含 0xC0-0xFF 空格压缩规则）、HUFF/CDIC 位流解压（BigInt 64 位滑动窗口）、MOBI6/KF8 双格式切换（EXTH 121 → BOUNDARY 记录定位）、traildata_flags 尾部裁剪。经 11 个真实样本文件验证，文本完整度 98.8%+。
2. **自定义协议**：`moyue-app://`（应用资源）与 `moyue-book://`（书库文件）解决 file:// 下 ESM/fetch/Worker 受限问题；书库 URL 带格式扩展名以便 epub.js/pdf.js 识别类型。
3. **rAF 兜底**：epub.js 的排版队列依赖 requestAnimationFrame，窗口隐藏/最小化时 Chromium 会停发 rAF 导致翻页卡死——渲染层以 setTimeout 替代，主进程同时关闭后台渲染降级开关。
4. **EPUB 分页修复**：epub.js 传 `'100%'` 尺寸时在布局未稳定的窗口里会把舞台测成内容自然宽度（实测 19040px）导致无法翻页——改为显式像素尺寸 + 窗口 resize 时重排。
5. **XHR 规避**：Electron 下 XHR 访问自定义协议会挂起——EPUB 加载改用 fetch 实现的 requestMethod，PDF 直接 fetch 整文件传 ArrayBuffer。
6. **编码识别**：BOM → 严格 UTF-8 校验 → GB18030 兜底，保证中文 TXT 不乱码。
7. **MBP 标签陷阱**：HTML 解析器把 Kindle 的 `<mbp:pagebreak/>` 自闭合标签当作未闭合开标签，导致后续全书内容被吞为子节点——替换为无害分隔标记并保留子内容。
8. **翻页手感**：EPUB 用「滑出 150ms → 换页 → 滑入 175ms」两段缓动（尾段不减速直接接住下一段），接缝处降透明度遮住换页那一帧；TXT/MOBI 用 `translate3d` + `cubic-bezier(.22,.61,.36,1)` 320ms，实测 60fps（平均帧 16.8ms，0 帧超 20ms）。**鼠标拖拽翻页已整体关闭**：与划词/批注抢指针，收益远小于误伤。
9. **横拖选词 vs 翻页冲突**：最终取舍是**指针只用于选词**——长按 420ms 进入选择模式，选词后拖动扩展选区，松手弹工具栏；翻页只走箭头与键盘。EPUB 的长按需用 iframe 内的 `caretRangeFromPoint`（坐标已是 iframe 视口系）。
10. **CSS 多列分页的隐性拉伸**：`column-width` 只是“建议值”，容器宽度不够「整数列 + gap」时浏览器会把列宽拉伸填满容器，于是文字顶到中缝或右边界。必须显式写死容器 `width = 2*colW + gap`（双页）/`colW`（单页），并让 `offset = (half - colW)/2`，才能保证「到中缝 = 到外侧」严格等距。
11. **epub.js 单页模式忽略 gap**：`layout.calculate()` 在 `divisor === 1` 时直接令 `columnWidth = 舞台宽`，gap 完全不参与。若用“满宽舞台 + 巨大 padding”伪装左右留白，内部几何就与真实 DOM 脱节——`displayed.total` 被算成 2、翻页按整屏宽跳字。正解：单页把**舞台本身**收窄到版心宽再水平居中，gap 传 0，两种模式内部几何都自洽。
12. **epub.js 的全书页码**：`displayed` 的单位是**栏**不是页（单/双页栏宽相同，同一章都是 26 栏），跨页数 = 栏数 / 2；而 `locations` 索引是 1200 字符粗粒度，一格跨 2~3 栏，直接换算会让页码 +2/+3。最终做法：每栏字符数采样按**版式签名分桶**并锁值（防止读着读着总页数漂移），当前页用「章节基准栏（首次进入该章时由 locations 反推并缓存）+ 章内栏号」计算，页码才严格 +1。
13. **PDF 文本层镜像陷阱**：`item.transform` 是 PDF 自底向上坐标系，直接取 `tx[4]/tx[5]` 定位会让文字层与画布**上下镜像**（选中位置与所见错位）。必须合并视口变换 `viewport.transform`（含 Y 轴翻转）后再定位：`screenX = a*x + c*y + e`，`screenY = b*x + d*y + f`。
14. **标注三套定位**：EPUB 用 CFI（跨页自动重挂 SVG `<g fill>`）；TXT/MOBI 用章内文本流偏移 `{chapter,start,end}`（`selectNodeContents` 量长度 + 快照文本节点后拆裹 `<mark>`）；PDF 用页内偏移 `{page,start,end}`。三种统一进同一个 `annotationStore`，落盘于 `%APPDATA%/moyue-reader/annotations/`。

### 体积优化

- **运行时降档**：Electron 44 → **40（Chromium 144）**，安装包 98.7MB → 77MB；`text-spacing-trim`、`text-autospace`、`color-mix` 等排版新特性全部保留。
- **裁掉无用组件**：`build/afterPack.cjs` 在打包后删除 `dxcompiler.dll` / `dxil.dll`（Dawn / WebGPU 着色器编译器，共 25.9MB）——阅读器只用 2D 合成与分页排版，从不调用 WebGPU。`vk_swiftshader`（显卡异常时的软件兜底）和 `LICENSES.chromium.html`（Chromium 许可证）保留。
- **pdf.js 固定在 4.10.38**：pdfjs-dist 6.x 依赖 `Uint8Array.prototype.toHex`、`Map.prototype.getOrInsertComputed` 等 Chromium 150+ 的新 API，在较旧内核上会报 `hashOriginal.toHex is not a function`。4.10 覆盖 `getDocument / getPage / render / getTextContent` 全部所用接口，功能一致。
- **语言包精简**：`electronLanguages: ["zh-CN", "en-US"]` 将 Electron 内置的 55 个 locale 砍到 2 个。
- **零运行时后端**：纯前端渲染，无本地服务进程。
- **依赖本地化**：epub.js / jszip / pdf.js 全部 vendor 化，无 CDN 运行时依赖；打包启用 `asar` + `maximum` 压缩。
- **界面与手感向苹果标准看齐**：操作追求丝滑、简洁，翻页与标注交互参照主流移动阅读 App 的体感。

> 说明：安装包剩余体积的 80% 是 Chromium 运行时本体（`墨阅.exe` 约 204MB，压缩后约 60MB），再往下压只能换 WebView2 / Tauri 这类「借用系统内核」的方案，代价是放弃 epub.js 的多列分页与 PDF 渲染一致性，不建议。

## 数据与隐私

- 所有图书与阅读数据仅存本地：`%APPDATA%/moyue-reader/`（library.json / settings.json / books/）
- 无账号、无网络请求、无遥测

## 已知限制

- MOBI 强 DRM 保护的文件无法解析（会给出明确提示）
- 扫描版 PDF（纯图片）无 OCR 文字层，仅能看图
- MOBI 目录依赖章节标题模式识别，非常规排版的书可能只有「全文」一个章节

## 开发验证

```bash
node test/test-mobi.mjs      # MOBI 解析器单元测试（11 个真实文件）
node test/cdp.mjs pages      # CDP 连接运行中的应用
```

---

**墨阅 MoYue** · 本地阅读，隐私无忧
