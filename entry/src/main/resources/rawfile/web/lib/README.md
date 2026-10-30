# lib/ — 第三方库文件

以下文件已下载就位，无需手动获取：

| 文件 | 库 | 版本 | 来源 |
|------|------|------|------|
| pdf.min.js | pdf.js | 3.11.174 | cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js |
| pdf.worker.min.js | pdf.js Worker | 3.11.174 | cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js |
| pdf-lib.min.js | @maxwbh/pdf-lib | 1.18.1 | cdn.jsdelivr.net/npm/@maxwbh/pdf-lib@1.18.1/dist/pdf-lib.min.js |
| tesseract.min.js | tesseract.js | 7.0.0 | cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/tesseract.min.js |
| tesseract-worker.min.js | tesseract.js Worker | 7.0.0 | cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/worker.min.js |

## 全局变量

| 库 | UMD 全局变量 |
|----|-------------|
| pdf.js | `pdfjsLib` |
| @maxwbh/pdf-lib | `PDFLib` |
| tesseract.js | `Tesseract` |

## 注意事项

- tesseract.js 的 Core WASM 和语言包从 CDN 加载，需要联网
- 如需离线使用 OCR，需额外下载 tesseract.js-core 和 traineddata 文件
