/**
 * bridge.js — JS 侧统一桥接适配层
 *
 * 封装与 ArkTS 侧的通信，提供 Promise 化的 API。
 * ArkTS 侧通过 registerJavaScriptProxy 注入 window.nativeBridge 对象。
 *
 * 三种通信通道：
 * 1. nativeBridge.xxx() — JS → ArkTS 同步调用
 * 2. runJavaScript() — ArkTS → JS 执行代码
 * 3. WebMessagePort — 双向异步大数据
 */

// 全局桥接适配器
var bridge = null;

class PdfBridgeAdapter {
  constructor() {
    this.messagePort = null;
    this.binaryCallbacks = [];
    this.taskCallbacks = new Map();
  }

  // ============ 初始化 MessagePort ============
  initMessagePortListener() {
    var self = this;
    window.addEventListener('message', function(event) {
      if (event.data === '__message_port__') {
        // ArkTS 通过 postMessage 传递了 port
        // 实际上 port 通过 ports 数组传递
      }
      if (event.ports && event.ports.length > 0) {
        self.messagePort = event.ports[0];
        self.messagePort.onmessage = function(e) {
          if (e.data instanceof ArrayBuffer) {
            self.handleBinaryFromNative(e.data);
          } else if (typeof e.data === 'string') {
            console.log('Received from ArkTS:', e.data);
          }
        };
        console.log('MessagePort initialized on JS side');
      }
    });

    // 某些鸿蒙版本通过 onmessage event 传递 port
    // 也监听直接的 message event
    window.onmessage = function(event) {
      if (event.ports && event.ports.length > 0) {
        self.messagePort = event.ports[0];
        self.messagePort.onmessage = function(e) {
          if (e.data instanceof ArrayBuffer) {
            self.handleBinaryFromNative(e.data);
          } else if (typeof e.data === 'string') {
            console.log('Received from ArkTS:', e.data);
          }
        };
        console.log('MessagePort initialized via onmessage');
      }
    };
  }

  // ============ 文件操作（调用 ArkTS）============

  /**
   * 读取文件为 Uint8Array
   */
  async readFile(filePath) {
    if (!window.nativeBridge || typeof window.nativeBridge.readFile !== 'function') {
      throw new Error('nativeBridge.readFile is not available');
    }
    if (!filePath || typeof filePath !== 'string') {
      throw new Error('readFile called with invalid path: ' + String(filePath));
    }
    var base64 = window.nativeBridge.readFile(filePath);
    console.log('[bridge.readFile] path=' + filePath + ', type=' + typeof base64 + ', len=' + (base64 ? base64.length : 0));
    if (base64 === undefined || base64 === null) {
      throw new Error('nativeBridge.readFile returned null/undefined');
    }
    if (typeof base64 !== 'string') {
      throw new Error('nativeBridge.readFile returned non-string: ' + Object.prototype.toString.call(base64));
    }
    if (base64.length === 0) {
      throw new Error('nativeBridge.readFile returned empty string (file may be empty or path invalid)');
    }
    if (base64.startsWith('{"error"')) {
      throw new Error(JSON.parse(base64).error);
    }
    return this.base64ToUint8Array(base64);
  }

  /**
   * 将 Uint8Array 写入文件
   * 返回 'OK' 表示成功，否则返回错误信息字符串
   */
  async writeFile(filePath, uint8array) {
    var base64 = this.uint8ArrayToBase64(uint8array);
    var result = window.nativeBridge.writeFile(filePath, base64);
    if (typeof result === 'string' && result.startsWith('ERROR:')) {
      throw new Error(result);
    }
    if (result === true || result === 'OK') {
      return true;
    }
    // 兼容旧版返回 boolean 的桥接
    if (result === false) {
      throw new Error('nativeBridge.writeFile returned false');
    }
    return true;
  }

  /**
   * 获取文件信息
   */
  getFileInfo(filePath) {
    return JSON.parse(window.nativeBridge.getFileInfo(filePath));
  }

  /**
   * 获取 APP 文件目录
   */
  getFilesDir() {
    return window.nativeBridge.getFilesDir();
  }

  /**
   * 获取 APP 缓存目录
   */
  getCacheDir() {
    return window.nativeBridge.getCacheDir();
  }

  /**
   * 创建目录
   */
  createDir(dirPath) {
    return window.nativeBridge.createDir(dirPath);
  }

  /**
   * 列出目录文件
   */
  listFiles(dirPath) {
    return JSON.parse(window.nativeBridge.listFiles(dirPath));
  }

  /**
   * 删除文件
   */
  deleteFile(filePath) {
    return window.nativeBridge.deleteFile(filePath);
  }

  /**
   * 重命名文件
   */
  renameFile(oldPath, newPath) {
    return window.nativeBridge.renameFile(oldPath, newPath);
  }

  /**
   * 检查文件是否存在
   */
  fileExists(filePath) {
    return window.nativeBridge.fileExists(filePath);
  }

  // ============ 系统能力 ============

  showToast(msg) {
    window.nativeBridge.showToast(msg);
  }

  copyToClipboard(text) {
    window.nativeBridge.copyToClipboard(text);
  }

  /**
   * 工具结果：打开结果文件到阅读器（预览）
   */
  openResult(path, name) {
    window.nativeBridge.openResult(path, name);
  }

  /**
   * 工具结果：导出结果文件到用户指定位置
   */
  saveResult(path, name) {
    window.nativeBridge.saveResult(path, name);
  }

  /**
   * 工具结果：调起系统分享面板
   */
  shareResult(path, name) {
    window.nativeBridge.shareResult(path, name);
  }

  // ============ 进度上报 ============

  reportProgress(taskId, current, total) {
    window.nativeBridge.onProgress(taskId, current, total);
  }

  reportComplete(taskId, result) {
    window.nativeBridge.onTaskComplete(taskId, typeof result === 'string' ? result : JSON.stringify(result));
  }

  reportError(taskId, error) {
    window.nativeBridge.onTaskError(taskId, error.message || String(error));
  }

  /**
   * 上报验证结果
   */
  reportVerifyResult(verifyId, status, message) {
    window.nativeBridge.onVerifyResult(verifyId, status, message);
  }

  // ============ 大数据传输 ============

  /**
   * 发送 ArrayBuffer 到 ArkTS（通过 MessagePort）
   */
  sendBinaryToNative(arrayBuffer) {
    if (this.messagePort) {
      this.messagePort.postMessage(arrayBuffer);
      return true;
    } else {
      // 降级为 Base64
      console.warn('MessagePort not available, falling back to Base64');
      return false;
    }
  }

  /**
   * 注册二进制数据接收回调
   */
  onBinaryData(callback) {
    this.binaryCallbacks.push(callback);
  }

  /**
   * 处理来自 ArkTS 的 ArrayBuffer
   */
  handleBinaryFromNative(data) {
    for (var cb of this.binaryCallbacks) {
      cb(data);
    }
  }

  /**
   * 检查 MessagePort 是否就绪
   */
  isMessagePortReady() {
    return this.messagePort !== null;
  }

  // ============ 工具方法 ============

  /**
   * 获取时间戳
   */
  getTimestamp() {
    return window.nativeBridge ? window.nativeBridge.getTimestamp() : Date.now();
  }

  /**
   * 生成唯一任务 ID
   */
  generateTaskId() {
    return 'task_' + Date.now() + '_' + Math.random().toString(36).slice(2, 11);
  }

  /**
   * Base64 → Uint8Array
   */
  base64ToUint8Array(base64) {
    // 兼容 MIME 格式中的换行/回车/空格
    var cleaned = (base64 || '').replace(/[\s\r\n]+/g, '');
    if (cleaned.length === 0) {
      return new Uint8Array(0);
    }
    var binaryStr = atob(cleaned);
    var len = binaryStr.length;
    var bytes = new Uint8Array(len);
    for (var i = 0; i < len; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }
    return bytes;
  }

  /**
   * Uint8Array → Base64
   */
  uint8ArrayToBase64(bytes) {
    try {
      var binary = '';
      var chunkSize = 0x8000;
      for (var i = 0; i < bytes.length; i += chunkSize) {
        var chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
        binary += String.fromCharCode.apply(null, Array.from(chunk));
      }
      return btoa(binary);
    } catch (e) {
      console.error('[bridge] btoa failed, fallback to custom base64:', e.message || String(e));
      return this.uint8ArrayToBase64Custom(bytes);
    }
  }

  /**
   * 自定义 Uint8Array → Base64（不依赖 btoa）
   * 注意尾组补齐规则：剩余 1 字节输出 "xx=="，剩余 2 字节输出 "xxx="
   */
  uint8ArrayToBase64Custom(bytes) {
    var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    var base64 = '';
    var i = 0;
    var len = bytes.length;
    while (i < len) {
      var rem = len - i;                 // 本组实际剩余字节数（1/2/3）
      var b1 = bytes[i++];
      var b2 = rem >= 2 ? bytes[i++] : 0;
      var b3 = rem >= 3 ? bytes[i++] : 0;
      var e1 = b1 >> 2;
      var e2 = ((b1 & 3) << 4) | (b2 >> 4);
      var e3 = ((b2 & 15) << 2) | (b3 >> 6);
      var e4 = b3 & 63;
      if (rem < 2) { e3 = 64; e4 = 64; }
      else if (rem < 3) { e4 = 64; }
      base64 += chars.charAt(e1) + chars.charAt(e2) + (e3 < 64 ? chars.charAt(e3) : '=') + (e4 < 64 ? chars.charAt(e4) : '=');
    }
    return base64;
  }
}

// 全局实例
bridge = new PdfBridgeAdapter();
