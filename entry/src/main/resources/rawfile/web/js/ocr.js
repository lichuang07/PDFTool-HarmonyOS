/**
 * ocr.js — OCR 引擎封装（V1.2 OCR 识别与内容增强）
 *
 * 职责：
 * - 按需加载 tesseract.js（不进首屏，遵循技术方案 4.2.3 延迟加载约定）
 * - 复用 worker：同一语言组合不重复创建，避免重复加载体积较大的语言包
 * - 统一识别结果：{ text, confidence, words, lines }
 *
 * 资源策略（离线优先）：
 * - core(WASM) 与语言包已内置于 rawfile/web/tess/，由原生侧复制到沙箱后以 file:// 指向本地，
 *   首次识别无需联网（中+英量化语言包共约 4.5MB，core 约 6.4MB）。
 * - 语言包使用量化版 4.0.0_best_int（lstmOnly: true），体积约为标准版 1/7。
 * - 本地资源缺失或加载失败（如设备不支持 SIMD、file:// 访问受限）时，自动回退 CDN，保证功能可用。
 */
(function (global) {
  'use strict';

  var DEFAULT_LANGS = 'chi_sim+eng';
  // CDN 兜底（本地资源不可用时）
  var CDN_CORE = 'https://cdn.jsdelivr.net/npm/tesseract.js-core@v7.0.0';
  var CDN_LANG = 'https://cdn.jsdelivr.net/npm/@tesseract.js-data';
  // 相对 editor.html（web/editor/）解析到 web/lib/，作为 CDN 兜底时的同源 worker
  var FALLBACK_WORKER_PATH = '../lib/tesseract-worker.min.js';

  /**
   * 检测 WebAssembly SIMD 支持。
   * 本地仅内置 simd-lstm 变体，不支持时须回退 CDN 让 tesseract 自选变体。
   */
  function hasSimd() {
    try {
      return global.WebAssembly && global.WebAssembly.validate(new Uint8Array([
        0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123,
        3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11
      ]));
    } catch (e) {
      return false;
    }
  }

  class OcrEngine {
    constructor() {
      this.Tesseract = null;
      this.worker = null;
      this.langs = '';
      this.assets = null;        // 本地资源路径 { core, lang, worker }
      this.assetsChecked = false;
      this.usingLocal = false;   // 当前是否走本地资源（供 UI 提示）
    }

    /** 加载 tesseract.js（幂等） */
    async init() {
      if (this.Tesseract) { return this.Tesseract; }
      if (global.Tesseract) {
        this.Tesseract = global.Tesseract;
      } else if (global.moduleLoader) {
        await global.moduleLoader.loadOcr();
        this.Tesseract = global.Tesseract;
      }
      if (!this.Tesseract) {
        throw new Error('tesseract.js 加载失败，请检查 rawfile 资源');
      }
      return this.Tesseract;
    }

    /** 是否已完成语言包加载 */
    isReady() {
      return !!this.worker;
    }

    /** 当前是否使用本地离线资源 */
    isOffline() {
      return this.usingLocal;
    }

    /**
     * 取本地资源路径（原生侧已把 rawfile 复制到沙箱）。
     * 首次调用会触发同步复制，耗时通常 1-3 秒，之后直接命中。
     * @returns {?{core:string, lang:string, worker:string}} 不可用则返回 null
     */
    async prepareAssets() {
      if (this.assetsChecked) { return this.assets; }
      this.assetsChecked = true;
      try {
        if (!global.nativeBridge || typeof global.nativeBridge.ensureOcrAssets !== 'function') {
          return null;
        }
        var obj = JSON.parse(global.nativeBridge.ensureOcrAssets());
        if (obj && obj.ok && obj.core && obj.lang && obj.worker) {
          this.assets = { core: obj.core, lang: obj.lang, worker: obj.worker };
        }
      } catch (e) {
        this.assets = null;
      }
      return this.assets;
    }

    async ensureWorker(langs, onProgress) {
      await this.init();
      if (this.worker && this.langs === langs) { return this.worker; }
      if (this.worker) { await this.dispose(); }

      var logger = function (m) {
        if (onProgress && m && m.status) {
          onProgress(m.status, m.progress || 0);
        }
      };

      var assets = await this.prepareAssets();
      var self = this;

      // 第一选择：本地离线资源（core 指向具体 .js 文件，tesseract 直接使用不再按变体拼接）
      if (assets && hasSimd()) {
        try {
          if (onProgress) { onProgress('准备本地识别资源', 0); }
          this.worker = await this.Tesseract.createWorker(langs, 1, {
            workerPath: assets.worker,
            corePath: assets.core,
            langPath: assets.lang,
            lstmOnly: true,     // 对应 4.0.0_best_int 量化语言包
            workerBlobURL: false,
            logger: logger
          });
          this.langs = langs;
          this.usingLocal = true;
          return this.worker;
        } catch (e) {
          // 本地加载失败（file:// 访问受限 / 资源缺失）→ 回退 CDN
          this.worker = null;
          if (onProgress) { onProgress('本地资源不可用，改用在线资源', 0); }
        }
      }

      // 兜底：CDN（需联网，使用标准版 4.0.0 语言包，精度更高）
      var fallbackOpts = {
        workerPath: FALLBACK_WORKER_PATH,
        corePath: CDN_CORE,
        langPath: CDN_LANG,
        lstmOnly: false,
        workerBlobURL: false,
        logger: logger
      };
      try {
        this.worker = await this.Tesseract.createWorker(langs, 1, fallbackOpts);
      } catch (err) {
        // 同源 worker 失败时，最后尝试不指定 workerPath（交回 tesseract 默认行为）
        delete fallbackOpts.workerPath;
        this.worker = await this.Tesseract.createWorker(langs, 1, fallbackOpts);
      }
      this.langs = langs;
      this.usingLocal = false;
      void self;
      return this.worker;
    }

    /**
     * 识别图片
     * @param {HTMLCanvasElement|HTMLImageElement|Blob|string} image 图片源
     * @param {object} options { langs, onProgress(status, progress) }
     * @returns {Promise<{text:string, confidence:number, words:Array, lines:Array}>}
     */
    async recognize(image, options) {
      options = options || {};
      var langs = options.langs || DEFAULT_LANGS;
      var onProgress = options.onProgress || function () {};
      var worker = await this.ensureWorker(langs, onProgress);

      var res = await worker.recognize(image);
      var data = (res && res.data) || {};
      var words = (data.words || []).map(function (w) {
        return {
          text: w.text,
          bbox: w.bbox,       // { x0, y0, x1, y1 }（图片坐标系，原点左上）
          confidence: w.confidence
        };
      });
      // 行级结果：绘制文本层时优先用行，数量远少于词，避免上千次 drawText 拖慢速度
      var lines = (data.lines || []).map(function (l) {
        return {
          text: l.text,
          bbox: l.bbox,
          confidence: l.confidence
        };
      });
      return {
        text: data.text || '',
        confidence: data.confidence || 0,
        words: words,
        lines: lines
      };
    }

    /**
     * 方向检测（V1.2 故事 #47）
     *
     * 不用 tesseract 的 OSD：那属于 Legacy 引擎能力，需要额外的 osd 语言包(4.1MB)
     * 与含 legacy 的 core(7.8MB)。这里改为「四方向试识别」——把图片分别旋转
     * 0/90/180/270 后各识别一次，取置信度最高的角度。tesseract 对侧倒/倒置文本的
     * 置信度会明显下降，信号足够可靠；代价是约 4 倍耗时，故默认只取页面中间条带。
     *
     * @param {HTMLCanvasElement|Blob|HTMLImageElement} image 图片源
     * @param {object} options { langs, bandRatio（0.2-1，默认 0.5，取中间横向条带加速）, onProgress }
     * @returns {Promise<{angle:number, confidence:number, scores:number[]}>}
     *          angle 为使文字转正所需旋转的度数（0/90/180/270）
     */
    async detectOrientation(image, options) {
      options = options || {};
      const langs = options.langs || DEFAULT_LANGS;
      const onProgress = options.onProgress || function () {};
      const canvas = await this._toCanvas(image);
      const scores = [0, 0, 0, 0];
      for (let i = 0; i < 4; i++) {
        const angle = i * 90;
        onProgress(`检测方向 ${angle}°`, i / 4);
        const rotated = (angle === 0) ? canvas : this._rotateCanvas(canvas, angle);
        const band = this._cropCenterBand(rotated, options.bandRatio || 0.5);
        const res = await this.recognize(band, { langs });
        scores[i] = res.confidence || 0;
      }
      let best = 0;
      for (let i = 1; i < 4; i++) {
        if (scores[i] > scores[best]) { best = i; }
      }
      return { angle: best * 90, confidence: scores[best], scores: scores };
    }

    /** 统一转为 canvas：canvas 直接返回，Blob/Image 先解码再绘制 */
    async _toCanvas(image) {
      if (image && typeof image.getContext === 'function') { return image; }
      let bmp = image;
      if (typeof image === 'string' || (image && image instanceof Blob)) {
        bmp = await createImageBitmap(image);
      }
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, bmp.width || bmp.videoWidth || 1);
      canvas.height = Math.max(1, bmp.height || bmp.videoHeight || 1);
      canvas.getContext('2d').drawImage(bmp, 0, 0);
      return canvas;
    }

    /** 旋转画布（顺时针 angle 度，90/270 时宽高互换） */
    _rotateCanvas(src, angle) {
      const w = src.width;
      const h = src.height;
      const swap = (angle === 90 || angle === 270);
      const out = document.createElement('canvas');
      out.width = swap ? h : w;
      out.height = swap ? w : h;
      const ctx = out.getContext('2d');
      ctx.translate(out.width / 2, out.height / 2);
      ctx.rotate(angle * Math.PI / 180);
      ctx.drawImage(src, -w / 2, -h / 2);
      return out;
    }

    /** 裁取中间横向条带（文字方向信号主要来自行结构，取中间即可，显著减少识别量） */
    _cropCenterBand(src, ratio) {
      const r = Math.min(1, Math.max(0.2, ratio || 1));
      if (r >= 1) { return src; }
      const h = Math.max(1, Math.round(src.height * r));
      const y = Math.round((src.height - h) / 2);
      const out = document.createElement('canvas');
      out.width = src.width;
      out.height = h;
      out.getContext('2d').drawImage(src, 0, y, src.width, h, 0, 0, src.width, h);
      return out;
    }

    /** 释放 worker（切换语言或退出工具时调用） */
    async dispose() {
      if (this.worker) {
        try {
          await this.worker.terminate();
        } catch (e) {
          // terminate 失败不阻塞后续流程
        }
        this.worker = null;
        this.langs = '';
      }
    }
  }

  global.ocrEngine = new OcrEngine();
})(window);
