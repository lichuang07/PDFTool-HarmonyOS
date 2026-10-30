# PDFTool-HarmonyOS（图文匣）

> 一款面向 **HarmonyOS NEXT（鸿蒙）** 的 PDF 工具箱 App —— 32 个工具，**全部离线运行**，文件不出设备。

![HarmonyOS](https://img.shields.io/badge/HarmonyOS-6.1.1%20(24)-blue)
![ArkTS](https://img.shields.io/badge/ArkTS-ArkUI-ff6a00)
![License](https://img.shields.io/badge/License-MIT-green)

---

## ✨ 特性

- **全离线**：PDF 编辑、渲染、OCR 识别均在本地完成，不依赖任何服务端。
- **32 个工具**：覆盖页面编辑、批注、表单、加解密、OCR、格式转换、打印。
- **中文字体完整支持**：内置思源黑体（8 MB），水印 / 文字标注 / 表单填写均支持中文。
- **离线 OCR**：内置 tesseract.js LSTM 核心与中英文量化语言包（约 11 MB），无需联网下载模型。
- **混合架构**：ArkTS 负责原生壳与系统能力（文件、分享、打印），Web 组件承载 PDF 渲染与识别引擎。

---

## 📱 功能一览

| 分类 | 工具 |
|---|---|
| 页面编辑 | 合并、拆分、删除页面、重排、旋转、插入、提取 |
| 标注批注 | 手写签名（Canvas 手绘）、高亮标注（文本选区） |
| 内容添加 | 文字标注、水印、图片签章、超链接 |
| 安全加密 | 加密、解密、权限设置、双密码（支持 AES-256 / AES-128 / RC4） |
| OCR 识别 | 扫描件转可搜索 PDF、自动旋转校正、PDF 提取文字、图片提取文字（中英混识） |
| 表单 | 创建表单字段（文本/复选/下拉）、填写表单、展平表单 |
| 工具功能 | 页面转图片、PDF 压缩（无损/有损）、缩略图批量生成、打印、自动重命名 |
| 格式转换 | 图片转 PDF（多图）、PDF 转图片 |
| 文档信息 | 元数据编辑 |

---

## 🏗 技术架构

采用 **Hybrid 混合架构**：

```
┌─────────────────────────────────────────┐
│  ArkTS / ArkUI（原生层）                  │
│  FileList · Reader · EditorPage          │
│  文件系统 · 分享 · 打印 · 剪贴板 · 偏好存储  │
└──────────────┬──────────────────────────┘
               │ registerJavaScriptProxy / runJavaScript
┌──────────────▼──────────────────────────┐
│  ArkWeb（Web 组件）                       │
│  pdf.js 渲染 · pdf-lib 编辑 · tesseract OCR │
└─────────────────────────────────────────┘
```

| 职责 | 选型 | 说明 |
|---|---|---|
| PDF 渲染 / 文本层 | pdf.js v3.11.174 | 阅读器、标注页、转图片 |
| PDF 编辑与加解密 | `@maxwbh/pdf-lib` | 带加密能力的 pdf-lib 分支 |
| OCR | tesseract.js v7 | 离线 LSTM 核心 + chi_sim / eng |
| 中文字体嵌入 | fontkit + 思源黑体 | 子集化嵌入，避免体积膨胀 |
| 桥接 | JavaScriptProxy | ArkTS ↔ JS 双向调用 |

**为什么不用纯原生？** 鸿蒙生态暂无成熟 PDF 渲染/编辑库，而 Web 侧有久经检验的 pdf.js / pdf-lib。混合架构在功能完整性与开发效率之间取得了平衡，且全部计算仍在设备本地完成。

---

## 📂 工程结构

```
PDFTool/
├── AppScope/                        # 应用级配置
├── entry/src/main/
│   ├── ets/
│   │   ├── pages/                   # FileList（首页）· Reader（阅读器）· EditorPage（工具页）· TechVerify
│   │   ├── bridge/PdfBridge.ets     # ArkTS ↔ JS 桥接（文件读写、结果回调、打印）
│   │   ├── services/                # FileService（导入/导出）· StoreUtil（偏好存储）
│   │   └── utils/                   # PdfTools（工具定义）· Constants · DesignTokens · Logger
│   └── resources/rawfile/web/
│       ├── reader/                  # 阅读器页面（pdf.js 渲染 + 搜索 + 复制）
│       ├── editor/                  # 工具页面（32 个工具的参数面板）
│       ├── annot/                   # 交互式标注页（Canvas 签名 / 高亮）
│       ├── js/                      # editor.js · reader.js · ocr.js · annot.js · bridge.js
│       ├── lib/                     # pdf-lib · pdf.js · fontkit
│       ├── fonts/                   # 思源黑体（SIL OFL 1.1）
│       └── tess/                    # tesseract 离线核心与语言包
└── hvigorfile.ts / build-profile.json5
```

---

## 🚀 快速开始

### 环境要求

- DevEco Studio 5.0+（建议最新版）
- HarmonyOS SDK `6.1.1(24)` 及以上
- 真机或模拟器（**推荐真机**：模拟器无打印服务、无分享接收应用）

### 运行

1. DevEco Studio 打开本仓库根目录（靠 `hvigorfile.ts` + `build-profile.json5` 识别为鸿蒙工程）。
2. `File → Project Structure → Signing Configs`，勾选自动生成签名。
3. 连接设备，点击 Run。

### 命令行构建

```bash
export JAVA_HOME="<DevEco>/jbr"
export DEVECO_SDK_HOME="<DevEco>/sdk"
node "<DevEco>/tools/hvigor/bin/hvigorw.js" --mode module -p product=default assembleHap --no-daemon
```

产物：`entry/build/default/outputs/default/entry-default-unsigned.hap`

> 若构建报 `00305006 Not a correct JSON format`，删除 `.hvigor/cache` 后重试（被中断的构建会留下损坏缓存，可安全重建）。

---

## 🧩 关键实现笔记

这一节记录了几处**不看源码会踩的坑**，供二次开发者参考：

1. **ArkWeb 无法 fetch / XHR 读取 rawfile**。中文字体、OCR 资源必须先由 ArkTS 复制到应用沙箱，再用 `file://` 指向（`PdfBridge.ensureOcrAssets()`）。
2. **pdf.js 与 `@maxwbh/pdf-lib` 的加密产物互不兼容**。本应用加密的 PDF 需用 pdf-lib 在内存中解密后，再交给 pdf.js 渲染（阅读器与标注页均已内置该兜底）。
3. **`save()` 不带 encrypt 参数时会保留原 Encrypt 字典**。要真正解密，必须显式清空 `trailerInfo.Encrypt` 并置 `isEncrypted = false`。
4. **`worker.detect()`（OSD 方向检测）属于 Legacy 引擎**，离线量化包下会抛 `requires Legacy model`。本项目改用**四方向试识别**判断旋转角，零额外体积。
5. **pdf-lib 没有创建链接标注的 API**（仅有解析用的 `PDFLinkAnnotation`），超链接需手工构造字典并挂到页面的 `/Annots`。
6. **中文表单必须注册 fontkit 并嵌入字体子集**，再调用 `updateFieldAppearances(font)`，否则展平会失败。
7. **每次调用 pdf.js 前需 `cloneBytes()` / `.slice()`**，否则 ArrayBuffer 会被 detach。
8. **PDF 透明区转 JPEG 会变黑**，转图片前需先铺白底。

---

## 📦 体积说明

HAP 约 **23 MB**，其中离线资源占 19 MB：

| 资源 | 体积 | 用途 |
|---|---|---|
| tesseract 核心 + 中英文语言包 | ~11 MB | 离线 OCR |
| 思源黑体 SourceHanSansCN | 8 MB | 中文绘制与表单 |
| pdf.js + pdf-lib + fontkit | ~3.4 MB | 渲染与编辑 |

如不需要 OCR，可删除 `rawfile/web/tess/`（约省 11 MB）。

---

## ⚠️ 已知限制

- **真机验证尚不充分**：打印唤起、Canvas 手写笔迹流畅度、图片转 PDF 清晰度等依赖真机手感，建议在真机上回归。
- **有损压缩会丢失文本层**（重渲染为位图），面板中已明确提示。
- **打印依赖系统打印服务**：设备无服务或权限被拒时，会自动回退到系统分享。
- HAP 默认未签名，真机安装前需配置签名。

---

## 🙏 第三方库

| 库 | 许可 |
|---|---|
| [pdf.js](https://github.com/mozilla/pdf.js) | Apache-2.0 |
| [@maxwbh/pdf-lib](https://github.com/Maxwell-WB/pdf-lib) | MIT |
| [tesseract.js](https://github.com/naptha/tesseract.js) | Apache-2.0 |
| [fontkit](https://github.com/foliojs/fontkit) | MIT |
| [Source Han Sans](https://github.com/adobe-fonts/source-han-sans) | SIL OFL 1.1（见 `fonts/OFL.txt`） |

---

## 📄 许可

本项目基于 **[MIT License](LICENSE)** 开源。

字体资源遵循 SIL Open Font License 1.1，详见 `entry/src/main/resources/rawfile/web/fonts/OFL.txt`。
