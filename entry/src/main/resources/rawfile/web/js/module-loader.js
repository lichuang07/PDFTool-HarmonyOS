/**
 * module-loader.js — 按版本延迟加载 JS 库（V1.1 引入）
 *
 * 设计目标：pdf-lib 不在首屏加载，进入编辑/加密功能时按需注入，
 * 控制首屏体积与内存（详见技术方案 4.2.3）。
 *
 * 用法：
 *   await moduleLoader.loadPdfEditor();   // 注入 web/lib/pdf-lib.min.js
 *   const PDFLib = window.PDFLib;          // UMD 全局变量
 */

(function (global) {
  'use strict';

  class ModuleLoader {
    constructor() {
      // 已加载模块缓存，避免重复注入
      this.loaded = {};
    }

    /**
     * 通用：动态注入 <script> 并 Promise 化
     * @param {string} src 相对 editor.html 的脚本路径
     * @returns {Promise<boolean>}
     */
    loadScript(src) {
      var self = this;
      return new Promise(function (resolve, reject) {
        if (self.loaded[src]) {
          return resolve(self.loaded[src]);
        }
        var script = document.createElement('script');
        script.src = src; // rawfile 路径经 ArkWeb 解析为沙箱内 URL
        script.onload = function () {
          self.loaded[src] = true;
          resolve(true);
        };
        script.onerror = function (e) {
          reject(new Error('Failed to load script: ' + src));
        };
        document.head.appendChild(script);
      });
    }

    /**
     * V1.1 引入：加载 @maxwbh/pdf-lib
     * editor.html 位于 web/editor/，pdf-lib 在 web/lib/，故路径为 ../lib/pdf-lib.min.js
     * @returns {Promise<object>} PDFLib 命名空间
     */
    async loadPdfEditor() {
      await this.loadScript('../lib/pdf-lib.min.js');
      return global.PDFLib; // UMD 全局变量，供 PdfEditor 使用
    }

    /**
     * V1.2 引入：加载 tesseract.js（OCR）
     * 仅在使用 OCR 工具时注入，避免首屏加载 62KB 主包。
     * @returns {Promise<object>} Tesseract 命名空间
     */
    async loadOcr() {
      await this.loadScript('../lib/tesseract.min.js');
      return global.Tesseract; // UMD 全局变量，供 OcrEngine 使用
    }
  }

  // 全局实例（editor.js 中的 PdfEditor.init() 会引用它）
  global.moduleLoader = new ModuleLoader();
})(window);
