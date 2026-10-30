/**
 * editor.js — @maxwbh/pdf-lib 功能封装（V1.1 核心逻辑）
 *
 * 对应技术方案 4.2.1。所有编辑/加密操作直接基于文件：
 *   读文件(bytes) → PDFLib.PDFDocument 处理 → 写回沙箱
 * 不依赖阅读器渲染状态（预览由 editor.html 独立承载）。
 *
 * 依赖：
 *   - 全局 bridge（PdfBridgeAdapter，来自 bridge.js）
 *   - 全局 moduleLoader（来自 module-loader.js，负责注入 PDFLib）
 */

class PdfEditor {
  constructor(bridgeArg) {
    // 优先使用显式传入的 bridge，否则回退到全局 bridge 实例
    this.bridge = bridgeArg || (typeof bridge !== 'undefined' ? bridge : null);
    this.lib = null;        // PDFLib 命名空间
    this._cnFontBytes = null; // 中文字体原始字节缓存（跨 doc 复用，但每 doc 重新嵌入）
    this.fontkit = null;    // fontkit 实例（嵌入自定义字体必需）
    this.password = '';     // 当前文档的打开密码（进入时检测加密后缓存，供所有工具复用）
    this._primaryEncrypted = false; // 主文档（SINGLE）是否加密
    this._anyEncrypted = false;     // 会话中是否打开过任意加密文档（用于合并等多文件场景）
  }

  // 初始化：确保 PDFLib 已加载（按需注入）
  async init() {
    if (!this.lib) {
      // editor.html 已同步加载 pdf-lib.min.js 时，直接复用全局，避免重复注入
      if (window.PDFLib) {
        this.lib = window.PDFLib;
      } else {
        await moduleLoader.loadPdfEditor();
        this.lib = window.PDFLib; // UMD 全局变量
      }
    }
    if (!this.bridge) {
      throw new Error('PdfEditor: bridge is not available');
    }
    // 捕获 fontkit（用于嵌入中文等自定义字体）。本构建 registerFontkit 为实例方法。
    if (!this.fontkit) {
      this.fontkit = await this._ensureFontkit();
    }
  }

  // 确保 fontkit 可用：先读全局，再尝试动态加载 UMD（rawfile / 沙箱 file:// 路径），最后返回 null
  async _ensureFontkit() {
    if (typeof window !== 'undefined' && window.fontkit) {
      console.log('PdfEditor: fontkit from window.fontkit');
      return window.fontkit;
    }
    // 兼容其它全局暴露名
    const candidates = ['fontkit', 'FontKit', 'pdfLibFontkit'];
    for (const name of candidates) {
      if (typeof window !== 'undefined' && window[name]) {
        console.log('PdfEditor: fontkit from window.' + name);
        return window[name];
      }
    }
    // 动态加载 fontkit UMD（rawfile 路径）
    try {
      await this._loadScript('../lib/fontkit.umd.js');
      if (window.fontkit) {
        console.log('PdfEditor: fontkit loaded dynamically from rawfile');
        return window.fontkit;
      }
    } catch (e) {
      console.warn('PdfEditor: dynamic fontkit load from rawfile failed', e);
    }
    // 再尝试从 ArkTS 注入的沙箱路径加载（file:// 协议，ArkWeb fileAccess 开启时可用）
    const sandboxPath = (typeof window !== 'undefined' && window.__PDF_FONTKIT_PATH__) ? window.__PDF_FONTKIT_PATH__ : null;
    if (sandboxPath) {
      try {
        await this._loadScript('file://' + sandboxPath);
        if (window.fontkit) {
          console.log('PdfEditor: fontkit loaded dynamically from sandbox');
          return window.fontkit;
        }
      } catch (e) {
        console.warn('PdfEditor: dynamic fontkit load from sandbox failed', e);
      }
    }
    console.warn('PdfEditor: fontkit not available');
    return null;
  }

  _loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  _xhrGetBytes(url) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.responseType = 'arraybuffer';
      xhr.onload = function () {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(new Uint8Array(xhr.response));
        } else {
          reject(new Error('XHR ' + xhr.status));
        }
      };
      xhr.onerror = () => reject(new Error('XHR network error'));
      xhr.send();
    });
  }

  // 判断加载错误是否为「文档已加密、需要密码」
  _isEncryptedError(e) {
    return !!e && /is encrypted/i.test(e && e.message ? e.message : String(e));
  }

  // 请求用户输入打开密码（委托给 Web 侧 UI；未提供时抛明确错误）
  async _requestPassword(reason) {
    if (typeof window !== 'undefined' && typeof window.__promptEditorPassword === 'function') {
      return await window.__promptEditorPassword(reason);
    }
    throw new Error('该文档已加密，但编辑器未提供密码输入界面');
  }

  // 密码感知的文档加载：优先复用已缓存密码；若文档加密则弹窗索取并缓存。
  // 密码错误会循环重试（reason=2 提示密码错误），取消则终止。
  // 每次加载前都重新 slice 一份全新 buffer，避免被底层库 detached 后影响后续调用。
  // opts.markPrimary：是否为「主文档」（决定 _primaryEncrypted 标记，用于保存时询问是否保留加密）。
  //   多文件场景（合并/插入的源文件）传 markPrimary:false，避免覆盖主文档的加密状态。
  async _openDoc(filePath, opts) {
    const markPrimary = !opts || opts.markPrimary !== false;
    if (markPrimary) { this._primaryEncrypted = false; }
    const raw = await this.bridge.readFile(filePath);
    const fresh = () => (raw && raw.slice) ? raw.slice() : new Uint8Array(raw || []);
    // 已缓存密码优先尝试（同一文档的后续工具直接复用，不再弹窗）
    if (this.password) {
      try {
        const d = await this.lib.PDFDocument.load(fresh(), { password: this.password });
        if (markPrimary) { this._primaryEncrypted = true; }
        this._anyEncrypted = true;
        return d;
      } catch (e) {
        // 缓存密码失效（如切换了文件），清空后走弹窗流程
        this.password = '';
      }
    }
    let reason = undefined; // undefined=首次需要，2=密码错误重试
    while (true) {
      let doc = null;
      try {
        // 先按未加密尝试
        doc = await this.lib.PDFDocument.load(fresh());
        if (markPrimary) { this._primaryEncrypted = false; }
        return doc;
      } catch (e) {
        if (!this._isEncryptedError(e)) throw e;
        this._anyEncrypted = true;
        if (markPrimary) { this._primaryEncrypted = true; }
        const pwd = await this._requestPassword(reason);
        if (pwd === null || pwd === undefined) {
          throw new Error('已取消打开（需要密码）');
        }
        try {
          doc = await this.lib.PDFDocument.load(fresh(), { password: pwd });
          this.password = pwd;
          return doc;
        } catch (err) {
          // 密码错误：循环重试
          reason = 2;
        }
      }
    }
  }

  // 进入编辑器时预检测：若文档加密则弹密码并缓存，供全部工具复用
  async prepareSession(filePath) {
    await this.init();
    this._primaryEncrypted = false;
    this._anyEncrypted = false;
    if (!filePath) return;
    await this._openDoc(filePath);
  }

  // ============ 页面编辑 ============

  // 合并多个 PDF
  async mergePDFs(filePaths, outputName) {
    await this.init();
    const taskId = this.bridge.generateTaskId();
    this.bridge.reportProgress(taskId, 0, filePaths.length);

    const merged = await this.lib.PDFDocument.create();

    for (let i = 0; i < filePaths.length; i++) {
      const srcDoc = await this._openDoc(filePaths[i]);
      const pages = await merged.copyPages(srcDoc, srcDoc.getPageIndices());
      pages.forEach(page => merged.addPage(page));
      this.bridge.reportProgress(taskId, i + 1, filePaths.length);
    }

    // 若任一源文件加密，保存前询问是否保留加密（多文件场景用 _anyEncrypted）
    const choice = await this._askKeepEncryption(this._anyEncrypted);
    if (choice === 'cancel') { throw new Error('已取消保存'); }
    const bytes = await this._applyEncryptionChoice(merged, choice);
    const baseDir = this.bridge.getFilesDir();
    const outDir = `${baseDir}/pdfs`;
    // 确保输出目录存在（writeFile 的 openSync(CREATE) 不会自动创建多级目录）
    await this.bridge.createDir(outDir);
    if (!outputName.toLowerCase().endsWith('.pdf')) {
      outputName += '.pdf';
    }
    const outputPath = `${outDir}/${outputName}`;
    await this.bridge.writeFile(outputPath, bytes);
    this.bridge.reportComplete(taskId, outputPath);
    return outputPath;
  }

  // 读取页数（只读，不写回，供 UI 展示「共 N 页」与校验）
  async getPageCount(filePath) {
    await this.init();
    const doc = await this._openDoc(filePath);
    return doc.getPageCount();
  }

  // 获取指定页面尺寸（pt），用于坐标滑杆范围（原点左下角）
  async getPageSize(filePath, pageNum) {
    await this.init();
    const doc = await this._openDoc(filePath);
    const page = doc.getPages()[Math.max(0, (pageNum || 1) - 1)];
    const { width, height } = page.getSize();
    return { width, height };
  }

  // 拆分 PDF（按范围）
  async splitPDF(filePath, ranges, namePrefix) {
    await this.init();
    const taskId = this.bridge.generateTaskId();
    const srcDoc = await this._openDoc(filePath);
    const outputPaths = [];
    const outDir = `${this.bridge.getFilesDir()}/pdfs`;
    await this.bridge.createDir(outDir);

    this.bridge.reportProgress(taskId, 0, ranges.length);
    const prefix = namePrefix ? namePrefix.replace(/\.pdf$/i, '') : 'split';

    // 原文件加密时，保存前询问是否保留加密（整次操作只问一次）
    const choice = await this._askKeepEncryption(this._primaryEncrypted);
    if (choice === 'cancel') { throw new Error('已取消保存'); }

    for (let i = 0; i < ranges.length; i++) {
      const range = ranges[i]; // [start, end]
      const newDoc = await this.lib.PDFDocument.create();
      const pageIndices = [];
      for (let p = range[0] - 1; p < range[1]; p++) {
        pageIndices.push(p);
      }
      const pages = await newDoc.copyPages(srcDoc, pageIndices);
      pages.forEach(page => newDoc.addPage(page));

      const bytes = await this._applyEncryptionChoice(newDoc, choice);
      const outputPath = `${outDir}/${prefix}_${i + 1}.pdf`;
      await this.bridge.writeFile(outputPath, bytes);
      outputPaths.push(outputPath);
      this.bridge.reportProgress(taskId, i + 1, ranges.length);
    }

    this.bridge.reportComplete(taskId, outputPaths);
    return outputPaths;
  }

  // 删除页面
  async deletePages(filePath, pageNumbers) {
    await this.init();
    const doc = await this._openDoc(filePath);

    // 逆序删除（避免索引偏移）
    const sorted = [...pageNumbers].sort((a, b) => b - a);
    for (const pageNum of sorted) {
      doc.removePage(pageNum - 1); // 0-based index
    }

    // 原文件加密时，保存前询问是否保留加密
    const choice = await this._askKeepEncryption(this._primaryEncrypted);
    if (choice === 'cancel') { throw new Error('已取消保存'); }
    const bytes = await this._applyEncryptionChoice(doc, choice);
    return await this._saveNewFile(bytes, filePath, 'deleted');
  }

  // 重排页面顺序
  async reorderPages(filePath, newOrder) {
    await this.init();
    const srcDoc = await this._openDoc(filePath);
    const newDoc = await this.lib.PDFDocument.create();

    // copyPages 按新顺序复制
    const pageIndices = newOrder.map(p => p - 1);
    const pages = await newDoc.copyPages(srcDoc, pageIndices);
    pages.forEach(page => newDoc.addPage(page));

    // 原文件加密时，保存前询问是否保留加密
    const choice = await this._askKeepEncryption(this._primaryEncrypted);
    if (choice === 'cancel') { throw new Error('已取消保存'); }
    const bytes = await this._applyEncryptionChoice(newDoc, choice);
    return await this._saveNewFile(bytes, filePath, 'reordered');
  }

  // 旋转页面（永久）
  // 只写 /Rotate 属性：pdf-lib 的 getSize() 会按 /Rotate 自动交换宽高，
  // 阅读器（pdf.js 与常见阅读器）均按此语义显示，无需手动交换 MediaBox。
  async rotatePages(filePath, pageNumbers, angle) {
    await this.init();
    const srcDoc = await this._openDoc(filePath);
    // 先复制全部页到新文档再修改：避免原地修改已加载页面在部分真实 PDF 上导致内容重复
    const newDoc = await this.lib.PDFDocument.create();
    const pages = await newDoc.copyPages(srcDoc, srcDoc.getPageIndices());
    pages.forEach(p => newDoc.addPage(p));

    for (const pageNum of pageNumbers) {
      const page = pages[pageNum - 1];
      const currentRotation = page.getRotation().angle;
      const next = ((currentRotation + angle) % 360 + 360) % 360;
      page.setRotation(this.lib.degrees(next));
    }

    // 原文件加密时，保存前询问是否保留加密
    const choice = await this._askKeepEncryption(this._primaryEncrypted);
    if (choice === 'cancel') { throw new Error('已取消保存'); }
    const bytes = await this._applyEncryptionChoice(newDoc, choice);
    return await this._saveNewFile(bytes, filePath, 'rotated');
  }

  // 插入页面（从其他 PDF）
  async insertPages(targetPath, sourcePath, insertAfterPage, sourcePages) {
    await this.init();
    const targetDoc = await this._openDoc(targetPath);
    const sourceDoc = await this._openDoc(sourcePath, { markPrimary: false });

    const pages = await targetDoc.copyPages(
      sourceDoc,
      sourcePages.map(p => p - 1)
    );

    pages.forEach((page, i) => {
      targetDoc.insertPage(insertAfterPage + i, page);
    });

    // 原文件（目标）加密时，保存前询问是否保留加密
    const choice = await this._askKeepEncryption(this._primaryEncrypted);
    if (choice === 'cancel') { throw new Error('已取消保存'); }
    const bytes = await this._applyEncryptionChoice(targetDoc, choice);
    return await this._saveNewFile(bytes, targetPath, 'inserted');
  }

  // 提取页面为独立 PDF
  async extractPages(filePath, pageNumbers, separate = false, namePrefix) {
    await this.init();
    const srcDoc = await this._openDoc(filePath);
    const outputPaths = [];
    const outDir = `${this.bridge.getFilesDir()}/pdfs`;
    await this.bridge.createDir(outDir);
    const prefix = namePrefix ? namePrefix.replace(/\.pdf$/i, '') : 'extract';

    // 原文件加密时，保存前询问是否保留加密（整次操作只问一次）
    const choice = await this._askKeepEncryption(this._primaryEncrypted);
    if (choice === 'cancel') { throw new Error('已取消保存'); }

    if (separate) {
      // 每页一个文件
      for (const pageNum of pageNumbers) {
        const newDoc = await this.lib.PDFDocument.create();
        const [page] = await newDoc.copyPages(srcDoc, [pageNum - 1]);
        newDoc.addPage(page);
        const bytes = await this._applyEncryptionChoice(newDoc, choice);
        const path = `${outDir}/${prefix}_p${pageNum}.pdf`;
        await this.bridge.writeFile(path, bytes);
        outputPaths.push(path);
      }
    } else {
      // 合并为一个文件
      const newDoc = await this.lib.PDFDocument.create();
      const pages = await newDoc.copyPages(
        srcDoc,
        pageNumbers.map(p => p - 1)
      );
      pages.forEach(page => newDoc.addPage(page));
      const bytes = await this._applyEncryptionChoice(newDoc, choice);
      const path = `${outDir}/${prefix}.pdf`;
      await this.bridge.writeFile(path, bytes);
      outputPaths.push(path);
    }

    return outputPaths;
  }

  // ============ 内容添加 ============

  // 添加文字标注
  async addText(filePath, pageNum, text, options) {
    await this.init();
    const srcDoc = await this._openDoc(filePath);
    // 先复制全部页到新文档再修改目标页：避免「原地修改已加载页面」在部分真实 PDF
    // （含 XObject Form / 多内容流 / 注释层等）上导致原内容被重复写入。
    const newDoc = await this.lib.PDFDocument.create();
    const pages = await newDoc.copyPages(srcDoc, srcDoc.getPageIndices());
    pages.forEach(p => newDoc.addPage(p));
    const page = pages[pageNum - 1];

    // 嵌入字体（中文需要自定义字体）
    const font = options.font || await this.getEmbeddedFont(newDoc, options.isChinese);

    page.drawText(text, {
      x: options.x,
      y: options.y,
      size: options.fontSize || 12,
      font: font,
      color: this.parseColor(options.color || '#000000'),
      opacity: options.opacity ?? 1.0
    });

    // 原文件加密时，保存前询问是否保留加密
    const choice = await this._askKeepEncryption(this._primaryEncrypted);
    if (choice === 'cancel') { throw new Error('已取消保存'); }
    const bytes = await this._applyEncryptionChoice(newDoc, choice);
    return await this._saveNewFile(bytes, filePath, 'texted');
  }

  // 添加水印
  // options.position: 'tile'(平铺) | 'center'(居中单行) | 'top'(顶部) | 'bottom'(底部) | 'diagonal'(对角)
  // options.rotation: 文字旋转角度（主要用于 tile / diagonal）
  async addWatermark(filePath, watermarkText, options) {
    await this.init();
    const srcDoc = await this._openDoc(filePath);
    // 先复制全部页到新文档再修改：避免原地修改已加载页面在部分真实 PDF 上导致内容重复
    const newDoc = await this.lib.PDFDocument.create();
    const pages = await newDoc.copyPages(srcDoc, srcDoc.getPageIndices());
    pages.forEach(p => newDoc.addPage(p));
    const font = await this.getEmbeddedFont(newDoc, options.isChinese);
    const targetPages = options.pages || pages.map((_, i) => i + 1);

    const fontSize = options.fontSize || 48;
    const position = options.position || 'tile';
    const rotation = options.rotation || (position === 'diagonal' ? 45 : 0);
    const color = options.color || '#FF0000';
    const opacity = (options.opacity === undefined || isNaN(options.opacity)) ? 0.3 : options.opacity;

    for (const pageNum of targetPages) {
      const page = pages[pageNum - 1];
      const { width, height } = page.getSize();
      const textWidth = font.widthOfTextAtSize(watermarkText, fontSize);

      if (position === 'tile') {
        // 平铺：沿整页重复
        const stepX = textWidth + 80;
        const stepY = fontSize * 3;
        for (let y = 0; y < height; y += stepY) {
          for (let x = 0; x < width; x += stepX) {
            this.drawWatermarkText(page, watermarkText, x, y, fontSize, color, opacity, rotation, font);
          }
        }
      } else if (position === 'diagonal') {
        // 对角：沿页面对角线方向平铺一排文字
        const step = fontSize * 2.4;
        const diagLen = Math.sqrt(width * width + height * height);
        const count = Math.ceil(diagLen / step) + 1;
        const angleRad = Math.atan2(height, width);
        for (let i = -1; i < count; i++) {
          const d = i * step;
          const x = d * Math.cos(angleRad);
          const y = d * Math.sin(angleRad);
          this.drawWatermarkText(page, watermarkText, x, y, fontSize, color, opacity, 0, font);
        }
      } else {
        // 单行：center / top / bottom
        const x = (width - textWidth) / 2;
        let y;
        if (position === 'top') { y = height - fontSize - 24; }
        else if (position === 'bottom') { y = fontSize + 12; }
        else { y = (height - fontSize) / 2; } // center
        this.drawWatermarkText(page, watermarkText, x, y, fontSize, color, opacity, 0, font);
      }
    }

    // 原文件加密时，保存前询问是否保留加密
    const choice = await this._askKeepEncryption(this._primaryEncrypted);
    if (choice === 'cancel') { throw new Error('已取消保存'); }
    const bytes = await this._applyEncryptionChoice(newDoc, choice);
    return await this._saveNewFile(bytes, filePath, 'watermarked');
  }

  drawWatermarkText(page, text, x, y, fontSize, color, opacity, rotation, font) {
    page.drawText(text, {
      x, y,
      size: fontSize,
      font: font,
      color: this.parseColor(color),
      opacity: opacity,
      rotate: this.lib.degrees(rotation || 0)
    });
  }

  /**
   * 添加图片 / 签章（V1.2 故事 #100）
   * 支持 PNG / JPEG。位置与尺寸均按页面比例给出，避免依赖具体页面尺寸。
   * options: { pages, xRatio(0-1，图片中心横向位置), yRatio(0-1，中心纵向位置，0 为页底),
   *            widthRatio(0-1，图片宽度占页宽比例), opacity(0-1) }
   */
  async addImage(filePath, imagePath, options) {
    await this.init();
    options = options || {};
    if (!imagePath) { throw new Error('未指定图片文件'); }
    const doc = await this._openDoc(filePath);
    const raw = await this.bridge.readFile(imagePath);
    const bytes = (raw && raw.buffer)
      ? new Uint8Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength))
      : new Uint8Array(raw || []);
    const lower = String(imagePath).toLowerCase();
    // png / jpg 走不同解码器；其余扩展名一律按 png 尝试（多数截图与导出图标为 png）
    const img = /\.jpe?g$/.test(lower)
      ? await doc.embedJpg(bytes)
      : await doc.embedPng(bytes);

    const pages = doc.getPages();
    const list = (options.pages && options.pages.length)
      ? options.pages.filter(n => n >= 1 && n <= pages.length)
      : pages.map((_, i) => i + 1);
    if (!list.length) { throw new Error('没有可处理的页面'); }

    const xRatio = options.xRatio === undefined ? 0.75 : options.xRatio;
    const yRatio = options.yRatio === undefined ? 0.2 : options.yRatio;
    const widthRatio = options.widthRatio === undefined ? 0.25 : options.widthRatio;
    const opacity = options.opacity === undefined ? 1 : options.opacity;

    for (const n of list) {
      const page = pages[n - 1];
      if (!page) { continue; }
      const { width: pw, height: ph } = page.getSize();
      const drawW = Math.max(1, pw * widthRatio);
      const drawH = Math.max(1, drawW * (img.height / img.width));
      page.drawImage(img, {
        x: pw * xRatio - drawW / 2,   // 以中心对齐，参数更直观
        y: ph * yRatio - drawH / 2,
        width: drawW,
        height: drawH,
        opacity: opacity
      });
    }

    const choice = await this._askKeepEncryption(this._primaryEncrypted);
    if (choice === 'cancel') { throw new Error('已取消保存'); }
    const bytesOut = await this._applyEncryptionChoice(doc, choice);
    return await this._saveNewFile(bytesOut, filePath, 'stamped');
  }

  /**
   * 添加超链接（V1.2 故事 #101）
   * pdf-lib 未封装链接注释，这里用底层对象手工构造 /Annots 中的 /Link 字典
   * （Subtype=Link + A<< /S /URI /URI (url) >>）。区域按页面比例给出。
   * options: { page, xRatio, yRatio, widthRatio, heightRatio, url }
   */
  async addLink(filePath, options) {
    await this.init();
    options = options || {};
    const url = String(options.url || '').trim();
    if (!url) { throw new Error('请填写链接地址'); }
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)) {
      throw new Error('链接需带协议前缀，如 https:// 或 mailto:');
    }
    const doc = await this._openDoc(filePath);
    const { PDFName } = this.lib;
    const pages = doc.getPages();
    const page = pages[(options.page || 1) - 1];
    if (!page) { throw new Error('页码超出范围'); }

    const { width: pw, height: ph } = page.getSize();
    const x = pw * (options.xRatio || 0);
    const y = ph * (options.yRatio || 0);
    const w = Math.max(1, pw * (options.widthRatio || 0.2));
    const h = Math.max(1, ph * (options.heightRatio || 0.03));

    const link = doc.context.obj({
      Type: 'Annot',
      Subtype: 'Link',
      Rect: [x, y, x + w, y + h],
      Border: [0, 0, 0],
      A: { Type: 'Action', S: 'URI', URI: url }
    });
    const ref = doc.context.register(link);

    let annots = page.node.get(PDFName.of('Annots'));
    if (!annots) {
      annots = doc.context.obj([]);
      page.node.set(PDFName.of('Annots'), annots);
    }
    annots.push(ref);

    const choice = await this._askKeepEncryption(this._primaryEncrypted);
    if (choice === 'cancel') { throw new Error('已取消保存'); }
    const bytes = await this._applyEncryptionChoice(doc, choice);
    return await this._saveNewFile(bytes, filePath, 'linked');
  }

  // ============ 标注批注（V1.3 故事 #048 手写签名 / #049 高亮标注） ============

  /**
   * 将交互式标注页收集的标注烧写进 PDF，输出新文件（不覆盖原件）。
   *
   * annotations 元素两种形态：
   *   { type:'sign',      page, color, width(PDF pt), strokes:[[{x,y}, ...], ...] }
   *   { type:'highlight', page, color, opacity, rects:[{x,y,w,h}] }
   *
   * 坐标一律为 PDF 用户空间（原点左下、y 向上），与 pdf.js convertToPdfPoint 一致，
   * 因此已内含 /Rotate 与 CropBox 偏移，旋转页同样落点准确。
   *
   * 签名以矢量线段写入（逐段 drawLine + 圆头线帽），比位图 PNG 更清晰且体积更小；
   * 高亮用 drawRectangle + Multiply 混色，保证下方文字不被色块盖住。
   */
  async applyAnnotations(filePath, annotations) {
    await this.init();
    const list = (annotations || []).filter(Boolean);
    if (!list.length) { throw new Error('没有可保存的标注'); }

    const { BlendMode, LineCapStyle } = this.lib;
    const doc = await this._openDoc(filePath);
    const pages = doc.getPages();
    let drawn = 0;

    for (const a of list) {
      const page = pages[(a.page || 1) - 1];
      if (!page) { continue; }

      if (a.type === 'highlight') {
        const color = this.parseColor(a.color || '#FFFF00');
        const opacity = (a.opacity === undefined || isNaN(a.opacity)) ? 0.4 : a.opacity;
        for (const r of (a.rects || [])) {
          if (!(r.w > 0) || !(r.h > 0)) { continue; }
          const opts = { x: r.x, y: r.y, width: r.w, height: r.h, color: color, opacity: opacity };
          try {
            page.drawRectangle(Object.assign({ blendMode: BlendMode.Multiply }, opts));
          } catch (e) {
            // 极少数情况下 Multiply 混色不被支持，退回普通半透明填充
            page.drawRectangle(opts);
          }
          drawn++;
        }
      } else {
        const color = this.parseColor(a.color || '#000000');
        const thickness = Math.max(0.1, Number(a.width) || 1);
        const opacity = (a.opacity === undefined || isNaN(a.opacity)) ? 1 : a.opacity;
        for (let rawStroke of (a.strokes || [])) {
          let s = rawStroke || [];
          if (s.length === 1) {
            // 单点轻触：补一个极近的点，圆头线帽才会渲染出可见圆点
            s = [s[0], { x: s[0].x + 0.3, y: s[0].y }];
          }
          for (let i = 1; i < s.length; i++) {
            page.drawLine({
              start: { x: s[i - 1].x, y: s[i - 1].y },
              end: { x: s[i].x, y: s[i].y },
              thickness: thickness,
              color: color,
              opacity: opacity,
              lineCap: LineCapStyle.Round
            });
          }
          if (s.length > 1) { drawn++; }
        }
      }
    }

    if (!drawn) { throw new Error('标注内容为空或页码超出范围'); }

    const choice = await this._askKeepEncryption(this._primaryEncrypted);
    if (choice === 'cancel') { throw new Error('已取消保存'); }
    const bytes = await this._applyEncryptionChoice(doc, choice);
    return await this._saveNewFile(bytes, filePath, 'annotated');
  }

  // ============ 表单（V1.3 故事 #050 创建字段 / #051 填写 / #052 展平） ============

  /**
   * 表单字段类型判定。
   * 注意：pdf-lib 经压缩后 constructor.name 已被重写（如 PDFTextField → 'kh'），
   * 必须用 instanceof 判断，不能依赖类名字符串。
   */
  _formFieldType(f) {
    const L = this.lib;
    if (f instanceof L.PDFTextField) { return 'text'; }
    if (f instanceof L.PDFCheckBox) { return 'checkbox'; }
    if (f instanceof L.PDFDropdown) { return 'dropdown'; }
    if (f instanceof L.PDFOptionList) { return 'optionlist'; }
    if (f instanceof L.PDFRadioGroup) { return 'radio'; }
    if (f instanceof L.PDFButton) { return 'button'; }
    if (f instanceof L.PDFSignature) { return 'signature'; }
    return 'unknown';
  }

  /** 单个字段 → 可序列化描述（名称 / 类型 / 当前值 / 选项） */
  _describeField(f) {
    const type = this._formFieldType(f);
    const info = { name: f.getName(), type: type, value: '', options: [] };
    try {
      if (type === 'text') {
        info.value = f.getText() || '';
      } else if (type === 'checkbox') {
        info.value = f.isChecked() ? 'true' : 'false';
      } else if (type === 'dropdown' || type === 'optionlist' || type === 'radio') {
        info.options = (f.getOptions && f.getOptions()) || [];
        const sel = f.getSelected ? f.getSelected() : '';
        info.value = Array.isArray(sel) ? (sel[0] || '') : (sel || '');
      }
    } catch (e) {
      // 取值失败不阻断清单展示（部分损坏字段可能抛错）
    }
    return info;
  }

  /** 读取表单字段清单（故事 #051 填写表单的前置步骤） */
  async listFormFields(filePath) {
    await this.init();
    const doc = await this._openDoc(filePath);
    const form = doc.getForm();
    return form.getFields().map((f) => this._describeField(f));
  }

  /** 是否存在非 ASCII 内容（决定是否需要嵌入中文字体） */
  _hasNonAscii(values) {
    return (values || []).some((v) => /[^\x00-\x7F]/.test(String(v === null || v === undefined ? '' : v)));
  }

  /**
   * 创建表单字段（故事 #050）
   * fields: [{ type:'text'|'checkbox'|'dropdown', name, page, xRatio, yRatio, widthRatio, heightRatio, options? }]
   * 位置/尺寸按页面比例给出（0-1，yRatio 以页底为 0），与签章/超链接工具保持一致。
   */
  async createFormFields(filePath, fields) {
    await this.init();
    if (!fields || !fields.length) { throw new Error('请先添加至少一个字段'); }
    const doc = await this._openDoc(filePath);
    const form = doc.getForm();
    const pages = doc.getPages();

    const existing = new Set();
    try { form.getFields().forEach((f) => existing.add(f.getName())); } catch (e) { /* 无表单时忽略 */ }

    for (const f of fields) {
      const name = String(f.name || '').trim();
      if (!name) { throw new Error('字段名不能为空'); }
      if (existing.has(name)) { throw new Error('字段名已存在：' + name); }
      const page = pages[(f.page || 1) - 1];
      if (!page) { throw new Error('页码超出范围：' + (f.page || 1)); }

      const { width: pw, height: ph } = page.getSize();
      const rect = {
        x: pw * (f.xRatio === undefined ? 0.1 : f.xRatio),
        y: ph * (f.yRatio === undefined ? 0.85 : f.yRatio),
        width: Math.max(6, pw * (f.widthRatio === undefined ? 0.4 : f.widthRatio)),
        height: Math.max(6, ph * (f.heightRatio === undefined ? 0.03 : f.heightRatio))
      };

      let field;
      if (f.type === 'checkbox') {
        field = form.createCheckBox(name);
        // 复选框保持正方形，避免比例拉伸出椭圆
        const side = Math.min(rect.width, rect.height);
        rect.width = side;
        rect.height = side;
      } else if (f.type === 'dropdown') {
        field = form.createDropdown(name);
        const opts = (f.options || []).map((s) => String(s).trim()).filter(Boolean);
        if (!opts.length) { throw new Error('下拉框「' + name + '」至少需要一个选项'); }
        field.addOptions.apply(field, opts);
      } else {
        field = form.createTextField(name);
      }
      field.addToPage(page, rect);
      existing.add(name);
    }

    const choice = await this._askKeepEncryption(this._primaryEncrypted);
    if (choice === 'cancel') { throw new Error('已取消保存'); }
    const bytes = await this._applyEncryptionChoice(doc, choice);
    return await this._saveNewFile(bytes, filePath, 'form');
  }

  /**
   * 填写表单（故事 #051）
   * values: { 字段名: 值 }，checkbox 传 true/'true'/'on'/'1'
   * 含中文时会尝试嵌入中文字体以生成正确外观；字体不可用时跳过外观生成，
   * 交由阅读器渲染（不调用 updateFieldAppearances，否则默认 WinAnsi 字体直接抛错）。
   */
  async fillForm(filePath, values) {
    await this.init();
    const map = values || {};
    const names = Object.keys(map);
    if (!names.length) { throw new Error('请至少填写一个字段'); }

    const doc = await this._openDoc(filePath);
    const form = doc.getForm();
    const needCjk = this._hasNonAscii(names.map((n) => map[n]));
    let font = null;
    if (needCjk) {
      try { font = await this.getEmbeddedFont(doc, true); } catch (e) { font = null; }
    }

    let filled = 0;
    for (const name of names) {
      const v = map[name];
      if (v === undefined || v === null || v === '') { continue; }
      let f = null;
      try { f = form.getFieldMaybe(name); } catch (e) { f = null; }
      if (!f) { continue; }
      try {
        if (typeof f.select === 'function' && typeof f.getOptions === 'function') {
          f.select(String(v));
        } else if (typeof f.check === 'function' && typeof f.uncheck === 'function') {
          const on = (v === true || v === 1 || v === '1' || v === 'true' || v === 'on');
          if (on) { f.check(); } else { f.uncheck(); }
        } else if (typeof f.setText === 'function') {
          f.setText(String(v));
        }
        filled++;
      } catch (e) {
        // 单个字段失败不阻断其余字段
      }
    }
    if (!filled) { throw new Error('没有匹配到可填写的字段'); }

    if (font) {
      try { form.updateFieldAppearances(font); } catch (e) { /* 外观失败不影响值写入 */ }
    } else if (!needCjk) {
      try { form.updateFieldAppearances(); } catch (e) { /* 同上 */ }
    }

    const choice = await this._askKeepEncryption(this._primaryEncrypted);
    if (choice === 'cancel') { throw new Error('已取消保存'); }
    const bytes = await this._applyEncryptionChoice(doc, choice);
    return await this._saveNewFile(bytes, filePath, 'filled');
  }

  /**
   * 展平表单（故事 #052）：把字段值烧成静态内容，之后不可再编辑。
   * flatten() 内部会调用 updateFieldAppearances()，中文内容必须提供中文字体，
   * 否则默认 WinAnsi 编码会抛错——故此处按内容决定是否嵌入中文子集字体。
   */
  async flattenForm(filePath) {
    await this.init();
    const doc = await this._openDoc(filePath);
    const form = doc.getForm();
    const fields = form.getFields();
    if (!fields.length) { throw new Error('该文档没有表单字段'); }

    const snapshot = fields.map((f) => this._describeField(f));
    const texts = [];
    snapshot.forEach((s) => {
      texts.push(s.value);
      texts.push(s.name);
      (s.options || []).forEach((o) => texts.push(o));
    });
    const needCjk = this._hasNonAscii(texts);

    let font = null;
    if (needCjk) {
      try { font = await this.getEmbeddedFont(doc, true); } catch (e) { font = null; }
      if (!font) {
        throw new Error('表单含中文内容，需嵌入中文字体才能展平，但字体加载失败');
      }
    }

    try {
      if (font) { form.updateFieldAppearances(font); } else { form.updateFieldAppearances(); }
      form.flatten();
    } catch (e) {
      throw new Error('展平失败：' + (e && e.message ? e.message : e));
    }

    const choice = await this._askKeepEncryption(this._primaryEncrypted);
    if (choice === 'cancel') { throw new Error('已取消保存'); }
    const bytes = await this._applyEncryptionChoice(doc, choice);
    return await this._saveNewFile(bytes, filePath, 'flattened');
  }

  // ============ 页面渲染 / 图片导出 / 压缩 / 缩略图 / 重命名（V1.3） ============

  // dataURL → 字节：canvas.toDataURL 输出 base64，写盘前需还原为原始字节
  _dataUrlBytes(dataUrl) {
    const s = String(dataUrl);
    const comma = s.indexOf(',');
    const b64 = comma >= 0 ? s.slice(comma + 1) : s;
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) { out[i] = bin.charCodeAt(i); }
    return out;
  }

  /**
   * 统一的 pdf.js 渲染循环（#053/#054/#055/#059 共用）
   * 逐页渲染为带白底的 canvas，交给 perPage(canvas, pageNum, index, total) 处理。
   * 白底必需：PDF 透明区域在转 JPEG 时会被填成黑色。
   * @returns {number} 文档总页数
   */
  async _renderPages(filePath, options, perPage) {
    const pdfjs = window.pdfjsLib;
    if (!pdfjs) { throw new Error('pdf.js 未加载，无法渲染页面'); }
    if (!pdfjs.GlobalWorkerOptions.workerSrc) {
      pdfjs.GlobalWorkerOptions.workerSrc = '../lib/pdf.worker.min.js';
    }
    const opts = options || {};
    const onProgress = opts.onProgress || function () {};
    const scale = (opts.dpi || 150) / 72;
    const raw = await this.bridge.readFile(filePath);
    const fresh = () => (raw && raw.slice) ? raw.slice() : new Uint8Array(raw);

    const srcDoc = await pdfjs.getDocument({ data: fresh() }).promise;
    const total = srcDoc.numPages;
    const pageList = (opts.pages && opts.pages.length)
      ? opts.pages.filter(p => p >= 1 && p <= total)
      : Array.from({ length: total }, (_, i) => i + 1);
    if (!pageList.length) { throw new Error('没有可处理的页面'); }

    for (let i = 0; i < pageList.length; i++) {
      const pageNum = pageList[i];
      onProgress(i, pageList.length, `渲染第 ${pageNum} 页`);
      const page = await srcDoc.getPage(pageNum);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.ceil(viewport.width));
      canvas.height = Math.max(1, Math.ceil(viewport.height));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport }).promise;
      await perPage(canvas, pageNum, i, pageList.length);
      if (typeof page.cleanup === 'function') { page.cleanup(); }
      onProgress(i + 1, pageList.length, `第 ${pageNum} 页完成`);
    }
    try { await srcDoc.destroy(); } catch (e) { /* 销毁失败不影响结果 */ }
    return total;
  }

  /**
   * 页面转图片（V1.3 故事 #059 PDF 转图片 / #053 页面转图片）
   * options: { pages, format: 'png'|'jpeg', dpi, quality(1-100), onProgress }
   * @returns {{paths: string[], dir: string, count: number}}
   */
  async pagesToImages(filePath, options) {
    const opts = options || {};
    const fmt = (opts.format === 'jpeg') ? 'jpeg' : 'png';
    const ext = fmt === 'jpeg' ? 'jpg' : 'png';
    const quality = Math.min(1, Math.max(0.1, (opts.quality || 92) / 100));
    const baseDir = this.bridge.getFilesDir();
    const outDir = opts.outDir || `${baseDir}/images`;
    await this.bridge.createDir(outDir);
    const stem = (filePath.split('/').pop() || 'file').replace(/\.[^.]+$/, '');

    const paths = [];
    await this._renderPages(filePath, {
      pages: opts.pages, dpi: opts.dpi || 150, onProgress: opts.onProgress
    }, async (canvas, pageNum) => {
      const dataUrl = canvas.toDataURL(fmt === 'jpeg' ? 'image/jpeg' : 'image/png', quality);
      const outPath = `${outDir}/${stem}_p${pageNum}.${ext}`;
      await this.bridge.writeFile(outPath, this._dataUrlBytes(dataUrl));
      paths.push(outPath);
    });
    return { paths: paths, dir: outDir, count: paths.length };
  }

  /**
   * 缩略图批量生成（V1.3 故事 #055）
   * options: { pages, width（缩略图宽度像素，默认 200）, dpi（渲染精度，默认 96）, onProgress }
   * @returns {{dir: string, paths: string[], count: number}}
   */
  async generateThumbnails(filePath, options) {
    const opts = options || {};
    const width = Math.max(48, Math.min(1024, opts.width || 200));
    const baseDir = this.bridge.getFilesDir();
    const stem = (filePath.split('/').pop() || 'file').replace(/\.[^.]+$/, '');
    const outDir = `${baseDir}/thumbs/${stem}`;
    await this.bridge.createDir(outDir);

    const paths = [];
    await this._renderPages(filePath, {
      pages: opts.pages, dpi: opts.dpi || 96, onProgress: opts.onProgress
    }, async (canvas, pageNum) => {
      const tw = width;
      const th = Math.max(1, Math.round(canvas.height * (width / canvas.width)));
      const small = document.createElement('canvas');
      small.width = tw;
      small.height = th;
      const sctx = small.getContext('2d');
      sctx.fillStyle = '#ffffff';
      sctx.fillRect(0, 0, tw, th);
      sctx.drawImage(canvas, 0, 0, tw, th);
      const outPath = `${outDir}/thumb_${pageNum}.png`;
      await this.bridge.writeFile(outPath, this._dataUrlBytes(small.toDataURL('image/png')));
      paths.push(outPath);
    });
    return { dir: outDir, paths: paths, count: paths.length };
  }

  // 图片字节 → 可嵌入 PDF 的图片对象。
  // JPEG 直接 embedJpg（保留压缩率）；PNG 直接 embedPng；
  // WebP/BMP/GIF 等 pdf-lib 不支持，先经 canvas 转 PNG。
  async _embedImageBytes(doc, path, bytes) {
    const u8 = (bytes instanceof Uint8Array) ? bytes : new Uint8Array(bytes || []);
    const mime = this._guessImageMime(path);
    if (mime === 'image/jpeg') { return await doc.embedJpg(u8); }
    if (mime === 'image/png') { return await doc.embedPng(u8); }
    // 其余格式：借浏览器解码 → 转 PNG
    const blob = new Blob([u8], { type: mime });
    const bmp = await createImageBitmap(blob);
    const cv = document.createElement('canvas');
    cv.width = bmp.width;
    cv.height = bmp.height;
    const c2 = cv.getContext('2d');
    c2.fillStyle = '#ffffff';
    c2.fillRect(0, 0, cv.width, cv.height);
    c2.drawImage(bmp, 0, 0);
    if (typeof bmp.close === 'function') { bmp.close(); }
    return await doc.embedPng(this._dataUrlBytes(cv.toDataURL('image/png')));
  }

  /**
   * 图片转 PDF（V1.3 故事 #058）
   * options: { pageSize: 'fit'|'a4', margin（磅，默认 24）, title }
   * @returns {string} 输出 PDF 路径
   */
  async imagesToPdf(imagePaths, options) {
    await this.init();
    const opts = options || {};
    const list = (imagePaths || []).filter(Boolean);
    if (!list.length) { throw new Error('请先选择至少一张图片'); }

    const doc = await this.lib.PDFDocument.create();
    const fit = (opts.pageSize || 'fit') === 'fit';
    const margin = (typeof opts.margin === 'number') ? opts.margin : 24;
    const A4 = [595.28, 841.89];

    for (let i = 0; i < list.length; i++) {
      const bytes = await this.bridge.readFile(list[i]);
      const img = await this._embedImageBytes(doc, list[i], bytes);
      if (fit) {
        const page = doc.addPage([img.width + margin * 2, img.height + margin * 2]);
        page.drawImage(img, { x: margin, y: margin, width: img.width, height: img.height });
      } else {
        const page = doc.addPage(A4);
        const maxW = A4[0] - margin * 2;
        const maxH = A4[1] - margin * 2;
        const ratio = Math.min(maxW / img.width, maxH / img.height, 1);
        const w = img.width * ratio;
        const h = img.height * ratio;
        // 垂直居中
        page.drawImage(img, { x: (A4[0] - w) / 2, y: (A4[1] + h) / 2 - h, width: w, height: h });
      }
      if (opts.onProgress) { opts.onProgress(i + 1, list.length, `已加入第 ${i + 1} 张`); }
    }
    if (opts.title) { doc.setTitle(opts.title); }

    const bytes = await doc.save({ useObjectStreams: true });
    const baseDir = this.bridge.getFilesDir();
    const outDir = `${baseDir}/pdfs`;
    await this.bridge.createDir(outDir);
    const stem = (list[0].split('/').pop() || 'images').replace(/\.[^.]+$/, '');
    const outPath = `${outDir}/images_${stem}.pdf`;
    await this.bridge.writeFile(outPath, bytes);
    return outPath;
  }

  /**
   * PDF 压缩（V1.3 故事 #054）
   *   lossless：仅重建对象流 + 去除冗余（保留文本层与矢量，体积降幅有限）
   *   lossy   ：按 dpi 重渲染为 JPEG 再重建（降幅大，但会丢失文本层/矢量）
   * options: { mode, dpi（有损默认 120）, quality（有损默认 70）, pages, onProgress }
   * @returns {{path:string, before:number, after:number, ratio:number}}
   */
  async compressPdf(filePath, options) {
    const opts = options || {};
    const mode = opts.mode || 'lossless';
    const raw = await this.bridge.readFile(filePath);
    const before = (raw && raw.byteLength) ? raw.byteLength : ((raw && raw.length) || 0);
    let bytes;

    if (mode === 'lossy') {
      await this.init();
      const cacheDir = `${this.bridge.getCacheDir()}/compress`;
      await this.bridge.createDir(cacheDir);
      const dpi = opts.dpi || 120;
      const quality = Math.min(1, Math.max(0.1, (opts.quality || 70) / 100));
      const stamp = Date.now();
      const items = [];
      await this._renderPages(filePath, {
        pages: opts.pages, dpi: dpi, onProgress: opts.onProgress
      }, async (canvas, pageNum) => {
        const tmp = `${cacheDir}/cmp_${stamp}_${pageNum}.jpg`;
        await this.bridge.writeFile(tmp, this._dataUrlBytes(canvas.toDataURL('image/jpeg', quality)));
        // 页面尺寸还原为磅：canvas 像素 = 磅 × (dpi/72)
        items.push({ path: tmp, w: canvas.width * 72 / dpi, h: canvas.height * 72 / dpi });
      });

      const doc = await this.lib.PDFDocument.create();
      for (const item of items) {
        const b = await this.bridge.readFile(item.path);
        const img = await doc.embedJpg((b instanceof Uint8Array) ? b : new Uint8Array(b));
        const page = doc.addPage([item.w, item.h]);
        page.drawImage(img, { x: 0, y: 0, width: item.w, height: item.h });
        await this.bridge.deleteFile(item.path);
      }
      bytes = await doc.save({ useObjectStreams: true });
    } else {
      await this.init();
      const doc = await this._openDoc(filePath);
      bytes = await doc.save({ useObjectStreams: true });
    }

    const outPath = await this._saveNewFile(bytes, filePath, 'compressed');
    return {
      path: outPath,
      before: before,
      after: bytes.length,
      ratio: before ? (1 - bytes.length / before) : 0
    };
  }

  /**
   * 自动重命名（V1.3 故事 #057）
   * source: 'title'（取元数据标题）| 'text'（取首页文字首行，扫描件走 OCR）
   * options: { source, maxLen, prefix, langs, onProgress }
   * @returns {{path:string, name:string, source:string}}
   */
  async autoRename(filePath, options) {
    const opts = options || {};
    const source = opts.source || 'title';
    const maxLen = opts.maxLen || 40;
    let raw = '';

    if (source === 'title') {
      const meta = await this.getMetadata(filePath);
      raw = String((meta && meta.title) || '').trim();
    } else {
      // 首页文字：extractText 内部对扫描件走 OCR，故二者统一
      const res = await this.extractText(filePath, {
        pages: [1], langs: opts.langs || 'chi_sim+eng',
        dpi: opts.dpi || 200, onProgress: opts.onProgress
      });
      const first = String(res.text || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0] || '';
      raw = first;
    }

    // 清洗：去掉文件系统非法字符，压缩空白，截断
    let name = String(raw || '')
      .replace(/[\\/:*?"<>|\r\n\t]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, maxLen)
      .replace(/[\s.]+$/, '');
    if (!name) {
      const d = new Date();
      const pad = (n) => (n < 10 ? '0' + n : '' + n);
      name = `文档_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
    }
    if (opts.prefix) { name = `${opts.prefix}${name}`; }

    const slash = filePath.lastIndexOf('/');
    const dir = slash >= 0 ? filePath.slice(0, slash) : '';
    let target = dir ? `${dir}/${name}.pdf` : `${name}.pdf`;
    // 同名则追加序号，避免覆盖
    let n = 2;
    while (await this.bridge.fileExists(target)) {
      target = dir ? `${dir}/${name}_${n}.pdf` : `${name}_${n}.pdf`;
      n++;
      if (n > 99) { break; }
    }
    await this.bridge.renameFile(filePath, target);
    return { path: target, name: `${name}.pdf`, source: source };
  }

  // ============ 安全加密 ============

  // 构建加密选项（version + permissions 映射），供 encrypt / permission / dual 复用
  // 注意：@maxwbh/pdf-lib 的 encrypt 选项使用 version（1|2|4|5）而非 algorithm 字符串，
  // permissions 是布尔对象而非 bit flags；PDFLib 全局并未导出 EncryptionAlgorithm/Permissions。
  _buildEncryptOptions(options) {
    const encryptOptions = {
      userPassword: options.userPassword || '',
      ownerPassword: options.ownerPassword || ''
    };

    // 加密算法选择：UI 传 algorithm 字符串，映射为 pdf-lib 期望的 version 数值
    const algorithmVersionMap = {
      aes256: 5,   // 256-bit AES (PDF 1.7+)
      aes128: 4,   // 128-bit AES (PDF 1.5+)
      rc4128: 2,   // 128-bit RC4 (PDF 1.4+)
      rc440: 1     // 40-bit RC4  (PDF 1.1+)
    };
    const version = algorithmVersionMap[options.algorithm];
    if (version !== undefined) {
      encryptOptions.version = version;
    }

    // 权限设置：直接传递布尔对象
    if (options.permissions) {
      const perms = options.permissions;
      const p = {};
      if (perms.printing) { p.printing = true; }
      if (perms.modifying) { p.modifying = true; }
      if (perms.copying) { p.copying = true; }
      if (perms.annotating) { p.annotating = true; }
      if (Object.keys(p).length) { encryptOptions.permissions = p; }
    }

    return encryptOptions;
  }

  // 加密 PDF
  async encryptPDF(filePath, options) {
    await this.init();
    const doc = await this._openDoc(filePath);
    const encryptOptions = this._buildEncryptOptions(options);
    const bytes = await doc.save({ encrypt: encryptOptions });
    return await this._saveNewFile(bytes, filePath, 'encrypted');
  }

  // 权限设置（在原文件基础上加密并施加权限；可保留/设置打开密码）
  async setPermissions(filePath, options) {
    await this.init();
    const doc = await this._openDoc(filePath);
    const opts = {
      userPassword: options.userPassword || '',
      ownerPassword: options.ownerPassword || '',
      algorithm: options.algorithm || 'aes256',
      permissions: {
        printing: !!options.printing,
        modifying: !!options.modifying,
        copying: !!options.copying,
        annotating: !!options.annotating
      }
    };
    const encryptOptions = this._buildEncryptOptions(opts);
    const bytes = await doc.save({ encrypt: encryptOptions });
    return await this._saveNewFile(bytes, filePath, 'protected');
  }

  // 双密码保护（打开密码 + 权限密码，二者都需填写）
  async protectDual(filePath, options) {
    await this.init();
    const doc = await this._openDoc(filePath);
    const opts = {
      userPassword: options.userPassword || '',
      ownerPassword: options.ownerPassword || '',
      algorithm: options.algorithm || 'aes256'
    };
    const encryptOptions = this._buildEncryptOptions(opts);
    const bytes = await doc.save({ encrypt: encryptOptions });
    return await this._saveNewFile(bytes, filePath, 'protected');
  }

  // 解密 PDF（移除密码）
  // 注意：@maxwbh/pdf-lib 加载加密文档后 save() 会保留原 Encrypt 字典，
  // 必须显式清除 trailerInfo.Encrypt 与 isEncrypted 标记才能真正解密。
  async decryptPDF(filePath, password) {
    await this.init();
    // 优先用传入密码，未传则复用进入时已解锁的缓存密码（方案2：密码复用）
    const pwd = (password === undefined || password === null || password === '') ? this.password : password;
    const uint8 = await this.bridge.readFile(filePath);

    // 使用密码加载加密文档
    const doc = await this.lib.PDFDocument.load(uint8, { password: pwd });

    // 清除加密字典，确保 save 后不再加密
    if (doc.context && doc.context.trailerInfo) {
      doc.context.trailerInfo.Encrypt = undefined;
    }
    doc.isEncrypted = false;

    // 不带加密选项重新保存
    const bytes = await doc.save();
    return await this._saveNewFile(bytes, filePath, 'decrypted');
  }

  // ============ 辅助方法 ============

  // 嵌入中文字体
  // 注意：pdf-lib 的嵌入字体是「绑定到具体 doc 实例」的，不能跨 doc 复用。
  // 因此这里只缓存原始字体字节（_cnFontBytes），每次都在当前 doc 上重新 embedFont。
  // OCR：扫描件转可搜索 PDF（V1.2 故事 #34）
  // 流程：pdf.js 渲染页面为位图 → tesseract 识别 → pdf-lib 写回不可见文本层（opacity 0）。
  // 输出新文件，保留原件。
  // options: { langs: 'chi_sim+eng', dpi: 200, pages: number[], onProgress(done, total, status) }
  async ocrPDF(filePath, options) {
    await this.init();
    options = options || {};
    const onProgress = options.onProgress || function () {};
    const scale = (options.dpi || 200) / 72; // PDF 用户单位为 1/72 inch，位图按目标 DPI 放大

    // 目标文档（pdf-lib，密码感知）用于写入文本层
    const doc = await this._openDoc(filePath);
    const font = await this.getEmbeddedFont(doc, /chi|zh/i.test(options.langs || 'chi_sim+eng'));
    const pdfPages = doc.getPages();

    // 置信度标注（V1.2 故事 #80）：低于阈值的行用半透明黄色标出，便于人工核对
    const markLow = options.markLowConfidence !== false;
    const lowThreshold = options.confidenceThreshold || 60;
    const stats = {
      pages: 0, lines: 0, lowLines: 0, marked: false,
      avgConfidence: 0, lowRatio: 0
    };

    await this._ocrPages(filePath, options, (res, pageNum) => {
      // 位图坐标（原点左上，px）→ PDF 坐标（原点左下，pt）
      const pdfPage = pdfPages[pageNum - 1];
      if (!pdfPage) { return; }
      const { height: pageH } = pdfPage.getSize();
      stats.pages++;
      // 优先按行绘制：行数远少于词数，避免上千次 drawText 拖慢速度、撑大文件
      const items = (res.lines && res.lines.length) ? res.lines : res.words;
      for (const it of items) {
        if (!it.text || !it.bbox) { continue; }
        const h = Math.max(1, (it.bbox.y1 - it.bbox.y0) / scale);
        const w = Math.max(1, (it.bbox.x1 - it.bbox.x0) / scale);
        const x = it.bbox.x0 / scale;
        const y = pageH - (it.bbox.y1 / scale);
        const size = Math.max(1, h * 0.72);
        stats.lines++;
        if (typeof it.confidence === 'number') {
          stats.confSum = (stats.confSum || 0) + it.confidence;
          stats.confCount = (stats.confCount || 0) + 1;
        }
        const low = typeof it.confidence === 'number' && it.confidence < lowThreshold;
        if (low) {
          stats.lowLines++;
          if (markLow) {
            pdfPage.drawRectangle({
              x, y, width: w, height: h,
              color: this.lib.rgb(1, 0.85, 0.2),
              opacity: 0.3
            });
            stats.marked = true;
          }
        }
        pdfPage.drawText(it.text, {
          x,
          y,
          size,
          font,
          opacity: 0 // 不可见，但可被检索与复制
        });
      }
    });

    stats.avgConfidence = stats.confCount ? Math.round(stats.confSum / stats.confCount) : 0;
    stats.lowRatio = stats.lines ? Math.round(stats.lowLines / stats.lines * 100) : 0;
    delete stats.confSum;
    delete stats.confCount;

    const choice = await this._askKeepEncryption(this._primaryEncrypted);
    if (choice === 'cancel') { throw new Error('已取消保存'); }
    const bytes = await this._applyEncryptionChoice(doc, choice);
    const out = await this._saveNewFile(bytes, filePath, 'searched');
    return { path: out, stats: stats };
  }

  /**
   * PDF 提取转文字（V1.2 故事 #99）
   * 对图片型/扫描件 PDF 逐页 OCR，把识别到的文字合并为纯文本并导出 .txt（同时返回文本供界面展示）。
   * options: { langs, dpi, pages, pageBreak:boolean（默认每页之间空两行）, onProgress(done,total,status) }
   * @returns {{text:string, confidence:number, path:string}}
   */
  async extractText(filePath, options) {
    await this.init();
    options = options || {};
    const sep = options.pageBreak === false ? '\n' : '\n\n';
    const chunks = [];
    let confSum = 0;
    let confCount = 0;
    await this._ocrPages(filePath, options, (res, pageNum) => {
      const t = String(res.text || '').replace(/[ \t]+$/gm, '').trim();
      chunks.push(t);
      if (res.confidence) { confSum += res.confidence; confCount++; }
      void pageNum;
    });
    const text = chunks.filter(Boolean).join(sep).trim();
    if (!text) {
      throw new Error('未识别到文字。可提高渲染精度（300 DPI）或换用其它语言组合后重试');
    }
    const out = await this._saveText(text, filePath, 'text');
    return {
      text: text,
      confidence: confCount ? Math.round(confSum / confCount) : 0,
      path: out
    };
  }

  /**
   * 图片提取文字（V1.2 故事 #35）
   * 直接对 PNG / JPEG / WebP / BMP 等图片做 OCR，无需先转成 PDF。
   * options: { langs, onProgress(status, progress) }
   * @returns {{text:string, confidence:number, path:string}}
   */
  async ocrImage(imagePath, options) {
    await this.init();
    options = options || {};
    if (!window.ocrEngine) { throw new Error('OCR 引擎未加载（ocr.js）'); }
    const raw = await this.bridge.readFile(imagePath);
    // 复制出独立 buffer：Blob 持有引用，避免后续操作（如识别大图）时与原 Uint8Array 互相影响
    const bytes = (raw && raw.buffer)
      ? new Uint8Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength))
      : new Uint8Array(raw || []);
    const blob = new Blob([bytes], { type: this._guessImageMime(imagePath) });
    const res = await window.ocrEngine.recognize(blob, {
      langs: options.langs || 'chi_sim+eng',
      onProgress: options.onProgress || function () {}
    });
    const text = String(res.text || '').replace(/[ \t]+$/gm, '').trim();
    if (!text) {
      throw new Error('未识别到文字。请确认图片清晰、文字方向正确，或换用其它语言组合');
    }
    const out = await this._saveText(text, imagePath, 'ocr');
    return {
      text: text,
      confidence: res.confidence || 0,
      path: out
    };
  }

  /**
   * 自动旋转校正（V1.2 故事 #47）
   *
   * 对抽样页（默认前 3 页）做「四方向试识别」判定文字方向，再写回 /Rotate。
   * 不用 tesseract OSD：那需要 legacy 引擎 + osd 语言包，离线要多带 11.9MB。
   *
   * options: { langs, dpi（默认 100，检测用低精度即可）, pages, applyToAll, threshold, onProgress }
   *   applyToAll=true（默认）：抽样页判定的众数角度应用到全部页，适合整本同向的扫描件
   *   applyToAll=false：逐页按各自检测结果校正
   * @returns {{path:string, appliedAngle:number, perPage:boolean, results:Array}}
   *          path 为空串表示「无需校正」（方向已正确或页面无文字）
   */
  async autoRotate(filePath, options) {
    await this.init();
    options = options || {};
    const onProgress = options.onProgress || function () {};
    const dpi = options.dpi || 100;
    const threshold = options.threshold === undefined ? 3 : options.threshold;
    const pdfjs = window.pdfjsLib;
    if (!pdfjs) { throw new Error('pdf.js 未加载，无法渲染页面'); }
    if (!pdfjs.GlobalWorkerOptions.workerSrc) {
      pdfjs.GlobalWorkerOptions.workerSrc = '../lib/pdf.worker.min.js';
    }
    if (!window.ocrEngine) { throw new Error('OCR 引擎未加载（ocr.js）'); }

    const doc = await this._openDoc(filePath);
    const pdfPages = doc.getPages();
    const totalPages = pdfPages.length;
    // 抽样：扫描件通常整本方向一致，默认只检测前 3 页
    const pageList = (options.pages && options.pages.length)
      ? options.pages.filter(p => p >= 1 && p <= totalPages)
      : Array.from({ length: Math.min(3, totalPages) }, (_, i) => i + 1);
    if (!pageList.length) { throw new Error('没有可处理的页面'); }

    const raw = await this.bridge.readFile(filePath);
    const fresh = () => (raw && raw.slice) ? raw.slice() : new Uint8Array(raw);
    const srcDoc = await pdfjs.getDocument({ data: fresh() }).promise;
    const results = [];
    try {
      for (let i = 0; i < pageList.length; i++) {
        const pageNum = pageList[i];
        onProgress(i, pageList.length, `检测第 ${pageNum} 页方向`);
        const page = await srcDoc.getPage(pageNum);
        const viewport = page.getViewport({ scale: dpi / 72 });
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.ceil(viewport.width));
        canvas.height = Math.max(1, Math.ceil(viewport.height));
        const ctx = canvas.getContext('2d');
        await page.render({ canvasContext: ctx, viewport }).promise;

        const det = await window.ocrEngine.detectOrientation(canvas, {
          langs: options.langs || 'chi_sim+eng',
          onProgress: (status) => onProgress(i, pageList.length, `${status}（第 ${pageNum} 页）`)
        });
        results.push({
          page: pageNum,
          angle: det.angle,
          confidence: det.confidence,
          scores: det.scores,
          applied: this._decideRotateAngle(det, threshold)
        });
        onProgress(i + 1, pageList.length,
          `第 ${pageNum} 页：${results[i].applied}°（置信度 ${Math.round(det.confidence)}）`);
      }
    } finally {
      try { await srcDoc.destroy(); } catch (e) { /* 销毁失败不影响结果 */ }
    }

    // 只设 /Rotate：pdf-lib 的 getSize() 已按 /Rotate 交换过宽高，再手动 setSize 会被抵消
    const rotate = (page, angle) => {
      const cur = page.getRotation().angle;
      page.setRotation(this.lib.degrees(((cur + angle) % 360 + 360) % 360));
    };

    const perPage = options.applyToAll === false;
    let appliedAngle = 0;
    if (perPage) {
      for (const r of results) {
        if (r.applied > 0) { rotate(pdfPages[r.page - 1], r.applied); }
      }
      if (!results.some(r => r.applied > 0)) {
        return { path: '', appliedAngle: 0, perPage: true, results: results };
      }
    } else {
      appliedAngle = this._modeAngle(results.map(r => r.applied));
      if (appliedAngle === 0) {
        return { path: '', appliedAngle: 0, perPage: false, results: results };
      }
      pdfPages.forEach(p => rotate(p, appliedAngle));
    }

    const choice = await this._askKeepEncryption(this._primaryEncrypted);
    if (choice === 'cancel') { throw new Error('已取消保存'); }
    const bytes = await this._applyEncryptionChoice(doc, choice);
    const out = await this._saveNewFile(bytes, filePath, 'rotated');
    return { path: out, appliedAngle: appliedAngle, perPage: perPage, results: results };
  }

  // 判定旋转角度：置信度过低（空白页）或与 0° 差距不足阈值时，视为无需旋转
  _decideRotateAngle(det, threshold) {
    if (!det || !det.angle) { return 0; }
    if (det.confidence < 20) { return 0; }
    const zero = (det.scores && det.scores[0]) || 0;
    if (det.confidence - zero < threshold) { return 0; }
    return det.angle;
  }

  // 取众数（平票取先出现者）
  _modeAngle(list) {
    const count = {};
    for (const a of list) { count[a] = (count[a] || 0) + 1; }
    let best = 0;
    let bestN = -1;
    for (const k of Object.keys(count)) {
      if (count[k] > bestN) { bestN = count[k]; best = parseInt(k, 10); }
    }
    return best;
  }

  /**
   * OCR 公共流程：pdf.js 逐页渲染为位图 → tesseract 识别 → 交给 perPage 处理
   * @param perPage (res, pageNum, index, total) => void | Promise<void>
   * @returns {number} 文档总页数
   */
  async _ocrPages(filePath, options, perPage) {
    const pdfjs = window.pdfjsLib;
    if (!pdfjs) { throw new Error('pdf.js 未加载，无法渲染页面'); }
    // editor.html 未预设 worker（阅读器侧才设），这里兜底配置
    if (!pdfjs.GlobalWorkerOptions.workerSrc) {
      pdfjs.GlobalWorkerOptions.workerSrc = '../lib/pdf.worker.min.js';
    }
    if (!window.ocrEngine) { throw new Error('OCR 引擎未加载（ocr.js）'); }

    const onProgress = options.onProgress || function () {};
    const scale = (options.dpi || 200) / 72;
    const raw = await this.bridge.readFile(filePath);
    const fresh = () => (raw && raw.slice) ? raw.slice() : new Uint8Array(raw);

    const srcDoc = await pdfjs.getDocument({ data: fresh() }).promise;
    const total = srcDoc.numPages;
    const pageList = (options.pages && options.pages.length)
      ? options.pages.filter(p => p >= 1 && p <= total)
      : Array.from({ length: total }, (_, i) => i + 1);
    if (!pageList.length) { throw new Error('没有可处理的页面'); }

    for (let i = 0; i < pageList.length; i++) {
      const pageNum = pageList[i];
      onProgress(i, pageList.length, `渲染第 ${pageNum} 页`);
      const page = await srcDoc.getPage(pageNum);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.ceil(viewport.width));
      canvas.height = Math.max(1, Math.ceil(viewport.height));
      const ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport }).promise;

      onProgress(i, pageList.length, `识别第 ${pageNum} 页`);
      const res = await window.ocrEngine.recognize(canvas, {
        langs: options.langs || 'chi_sim+eng',
        onProgress: (status) => onProgress(i, pageList.length, `${status}（第 ${pageNum} 页）`)
      });

      if (perPage) { await perPage(res, pageNum, i, pageList.length); }
      onProgress(i + 1, pageList.length, `第 ${pageNum} 页完成`);
    }
    try { await srcDoc.destroy(); } catch (e) { /* 销毁失败不影响结果 */ }
    return total;
  }

  _guessImageMime(path) {
    const lower = String(path || '').toLowerCase();
    if (/\.jpe?g$/.test(lower)) { return 'image/jpeg'; }
    if (/\.webp$/.test(lower)) { return 'image/webp'; }
    if (/\.bmp$/.test(lower)) { return 'image/bmp'; }
    if (/\.gif$/.test(lower)) { return 'image/gif'; }
    return 'image/png';
  }

  /**
   * 读取 PDF 元数据（用于编辑面板预填）
   * @returns {object} { title, author, subject, keywords, creator, producer, creationDate, modificationDate }
   *          日期为 YYYY-MM-DD 字符串（无法解析时为空串）
   */
  async getMetadata(filePath) {
    await this.init();
    const doc = await this._openDoc(filePath);
    const fmt = (d) => {
      if (!d) { return ''; }
      try {
        const dt = new Date(d);
        if (isNaN(dt.getTime())) { return ''; }
        return dt.toISOString().slice(0, 10);
      } catch (e) {
        return '';
      }
    };
    let keywords = doc.getKeywords();
    if (Array.isArray(keywords)) { keywords = keywords.join(', '); }
    return {
      title: doc.getTitle() || '',
      author: doc.getAuthor() || '',
      subject: doc.getSubject() || '',
      keywords: keywords || '',
      creator: doc.getCreator() || '',
      producer: doc.getProducer() || '',
      creationDate: fmt(doc.getCreationDate()),
      modificationDate: fmt(doc.getModificationDate())
    };
  }

  /**
   * 修改 PDF 元数据（标题 / 作者 / 主题 / 关键词 / 创建日期 / 修改日期）
   * @param {string} filePath
   * @param {object} meta 各字段为空字符串表示「不修改」
   * @returns {Promise<string>} 新文件路径
   */
  async editMetadata(filePath, meta) {
    await this.init();
    meta = meta || {};
    const doc = await this._openDoc(filePath);
    const trim = (s) => (typeof s === 'string' ? s.trim() : '');

    const setters = [
      ['title', 'setTitle'],
      ['author', 'setAuthor'],
      ['subject', 'setSubject'],
      ['creator', 'setCreator'],
      ['producer', 'setProducer']
    ];
    for (const [key, fn] of setters) {
      const v = trim(meta[key]);
      if (v) { doc[fn](v); }
    }

    // 关键词支持逗号 / 分号 / 空格分隔，统一转为数组写入
    const kw = trim(meta.keywords);
    if (kw) {
      doc.setKeywords(kw.split(/[,，;；]/).map(s => s.trim()).filter(Boolean));
    }

    if (meta.creationDate) {
      const d = new Date(meta.creationDate);
      if (!isNaN(d.getTime())) { doc.setCreationDate(d); }
    }
    // 修改日期：未指定则用当前时间（符合 PDF 惯例）
    const mod = meta.modificationDate ? new Date(meta.modificationDate) : new Date();
    if (!isNaN(mod.getTime())) { doc.setModificationDate(mod); }

    // 原文件加密时，保存前询问是否保留加密
    const choice = await this._askKeepEncryption(this._primaryEncrypted);
    if (choice === 'cancel') { throw new Error('已取消保存'); }
    const bytes = await this._applyEncryptionChoice(doc, choice);
    return await this._saveNewFile(bytes, filePath, 'meta');
  }

  async getEmbeddedFont(doc, isChinese) {
    if (!isChinese) {
      return await doc.embedFont(this.lib.StandardFonts.Helvetica);
    }

    console.log('PdfEditor: getEmbeddedFont chinese, fontkit=', !!this.fontkit);

    // 首次获取中文字体字节（缓存字节，避免重复下载；每次仍需在当前 doc 重新嵌入）
    if (!this._cnFontBytes || !this._cnFontBytes.length) {
      let lastErr = null;

      // 1) 优先使用 ArkTS 注入的沙箱字体路径（ArkWeb fetch/XHR 读 rawfile 会失败）
      const injectedPath = (typeof window !== 'undefined' && window.__PDF_FONT_PATH__) ? window.__PDF_FONT_PATH__ : null;
      if (injectedPath) {
        try {
          console.log('PdfEditor: loading font from injected path', injectedPath);
          this._cnFontBytes = await this.bridge.readFile(injectedPath);
          console.log('PdfEditor: font bytes loaded from injected path', this._cnFontBytes.length);
        } catch (pe) {
          console.warn('PdfEditor: injected font path read failed', pe);
          lastErr = pe;
        }
      }

      // 2) 回退 WebView 同域 fetch（标准浏览器环境）
      if (!this._cnFontBytes || !this._cnFontBytes.length) {
        const fontUrl = this.fontUrl || '../fonts/SourceHanSansCN-Regular.otf';
        try {
          console.log('PdfEditor: fetching font via fetch', fontUrl);
          const resp = await fetch(fontUrl);
          if (!resp.ok) { throw new Error('HTTP ' + resp.status); }
          this._cnFontBytes = new Uint8Array(await resp.arrayBuffer());
          console.log('PdfEditor: font bytes loaded via fetch', this._cnFontBytes.length);
        } catch (fe) {
          console.warn('PdfEditor: fetch font failed', fe);
          lastErr = fe;
        }
      }

      // 3) 再回退 XHR
      if (!this._cnFontBytes || !this._cnFontBytes.length) {
        const fontUrl = this.fontUrl || '../fonts/SourceHanSansCN-Regular.otf';
        try {
          console.log('PdfEditor: fetching font via XHR', fontUrl);
          this._cnFontBytes = await this._xhrGetBytes(fontUrl);
          console.log('PdfEditor: font bytes loaded via XHR', this._cnFontBytes.length);
        } catch (xe) {
          console.warn('PdfEditor: XHR font failed', xe);
          lastErr = xe;
        }
      }

      // 4) 仍失败则抛错
      if (!this._cnFontBytes || !this._cnFontBytes.length) {
        const msg = '中文字体加载失败：' + (lastErr && lastErr.message ? lastErr.message : '未知错误');
        console.warn('PdfEditor:', msg);
        if (this.bridge && typeof this.bridge.showToast === 'function') {
          this.bridge.showToast(msg);
        }
        throw new Error(msg);
      }
    }

    // 嵌入自定义字体（含中文 OTF）前必须在本 doc 实例上注册 fontkit
    if (!this.fontkit) {
      const msg = 'fontkit 未加载，无法嵌入中文字体';
      console.warn('PdfEditor:', msg);
      if (this.bridge && typeof this.bridge.showToast === 'function') {
        this.bridge.showToast(msg);
      }
      throw new Error(msg);
    }

    try {
      doc.registerFontkit(this.fontkit);
      console.log('PdfEditor: registerFontkit ok');
    } catch (rk) {
      console.warn('PdfEditor: registerFontkit error', rk);
      throw new Error('注册 fontkit 失败：' + (rk && rk.message ? rk.message : '未知错误'));
    }

    try {
      const font = await doc.embedFont(this._cnFontBytes, { subset: true });
      console.log('PdfEditor: embedFont subset ok');
      return font;
    } catch (subErr) {
      console.warn('PdfEditor: 中文子集失败，退回整字体嵌入', subErr);
      try {
        const font = await doc.embedFont(this._cnFontBytes);
        console.log('PdfEditor: embedFont full ok');
        return font;
      } catch (fullErr) {
        console.error('PdfEditor: 整字体嵌入也失败', fullErr);
        throw new Error('中文字体嵌入失败：' + (fullErr && fullErr.message ? fullErr.message : '未知错误'));
      }
    }
  }

  // 询问保存时是否保留加密（仅在原文档加密且为「非加密类工具」时调用）。
  // 返回 'keep'（保留原密码加密）| 'remove'（移除密码）| 'cancel'（取消保存）。
  // forceEncrypted=false 时（原文档未加密）直接返回 'keep'，不弹窗。
  async _askKeepEncryption(forceEncrypted) {
    if (!forceEncrypted) { return 'keep'; }
    if (typeof window !== 'undefined' && typeof window.__promptSaveEncryption === 'function') {
      return await window.__promptSaveEncryption();
    }
    // 无弹窗界面时默认保留加密（最安全）
    return 'keep';
  }

  // 按用户选择对 doc 施加/剥离加密，返回最终要写盘的字节。
  //   remove：清除 Encrypt 字典，输出无密码文件（对新建文档即原样导出）。
  //   keep  ：若 doc 自带 Encrypt 字典则原样保留（沿用原密码）；
  //           若为新建文档（无 Encrypt 字典）则用缓存密码重新加密，确保「保持加密」。
  async _applyEncryptionChoice(doc, choice) {
    if (choice === 'remove') {
      if (doc.context && doc.context.trailerInfo) {
        doc.context.trailerInfo.Encrypt = undefined;
      }
      doc.isEncrypted = false;
      return await doc.save();
    }
    // keep：保留加密
    if (doc.context && doc.context.trailerInfo && doc.context.trailerInfo.Encrypt) {
      // 原文档自带 Encrypt 字典，原样保存即沿用原密码
      return await doc.save();
    }
    if (this.password) {
      // 新建文档：用缓存密码重新加密，保持「加密」状态。
      // 走 _buildEncryptOptions 统一构造，明确算法与权限，避免依赖库默认分支的加密强度。
      const encryptOptions = this._buildEncryptOptions({
        userPassword: this.password,
        ownerPassword: this.password,
        algorithm: 'aes128'
      });
      return await doc.save({ encrypt: encryptOptions });
    }
    // 无密码也无 Encrypt 字典，直接保存（未加密）
    return await doc.save();
  }

  // 保存为新文件（不覆盖原件）
  // 写入 pdfs/ 目录，文件名形如 prefix_原名.pdf，返回完整新路径
  async _saveNewFile(bytes, sourcePath, prefix) {
    const baseDir = this.bridge.getFilesDir();
    const outDir = `${baseDir}/pdfs`;
    // 确保输出目录存在（writeFile 的 openSync(CREATE) 不会自动创建多级目录）
    await this.bridge.createDir(outDir);
    const base = (sourcePath.split('/').pop() || 'file').replace(/\.pdf$/i, '');
    const outPath = `${outDir}/${prefix}_${base}.pdf`;
    await this.bridge.writeFile(outPath, bytes);
    return outPath;
  }

  // 保存文本为新文件（.txt，UTF-8，不覆盖原件）
  // 与 _saveNewFile 同目录（pdfs/），仅扩展名与内容不同，返回完整新路径
  async _saveText(text, sourcePath, prefix) {
    const baseDir = this.bridge.getFilesDir();
    const outDir = `${baseDir}/pdfs`;
    await this.bridge.createDir(outDir);
    const base = (sourcePath.split('/').pop() || 'file').replace(/\.[^.]+$/, '');
    const outPath = `${outDir}/${prefix}_${base}.txt`;
    await this.bridge.writeFile(outPath, this._utf8Bytes(text));
    return outPath;
  }

  // 字符串 → UTF-8 字节（bridge 的 base64 编码按 latin1 逐字节处理，故必须先编码为字节）
  _utf8Bytes(str) {
    if (typeof TextEncoder !== 'undefined') {
      return new TextEncoder().encode(str);
    }
    const s = unescape(encodeURIComponent(str));
    const arr = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) { arr[i] = s.charCodeAt(i); }
    return arr;
  }

  // 颜色解析
  parseColor(hex) {
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    return this.lib.rgb(r, g, b);
  }
}

// 全局实例
window.pdfEditor = new PdfEditor();
