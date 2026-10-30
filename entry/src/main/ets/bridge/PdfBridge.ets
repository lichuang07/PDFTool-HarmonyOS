import { webview } from '@kit.ArkWeb';
import { fileIo as fs, picker, fileUri } from '@kit.CoreFileKit';
import { common } from '@kit.AbilityKit';
import { util } from '@kit.ArkTS';
import { router, UIContext } from '@kit.ArkUI';
import { pasteboard, print, BusinessError } from '@kit.BasicServicesKit';
import { systemShare } from '@kit.ShareKit';
import { uniformTypeDescriptor as utd } from '@kit.ArkData';
import deviceInfo from '@ohos.deviceInfo';
import { Logger } from '../utils/Logger';
import { Constants } from '../utils/Constants';
import { AppContext } from '../utils/AppContext';

interface FileItem {
  name: string;
  path: string;
  isDir: boolean;
}

interface DeviceInfo {
  deviceType: string;
}

/**
 * ArkTS ↔ JS 桥接对象
 *
 * 通过 registerJavaScriptProxy 注入到 Web 组件的 JS 上下文中，
 * JS 侧通过 window.nativeBridge.xxx() 调用原生能力。
 *
 * 三种通信通道：
 * 1. registerJavaScriptProxy — JS → ArkTS（方法调用）
 * 2. runJavaScript — ArkTS → JS（执行 JS 代码）
 * 3. WebMessagePort — 双向异步大数据（ArrayBuffer 零拷贝）
 */
export class PdfBridge {
  private controller: webview.WebviewController;
  private context: common.UIAbilityContext | null;
  private uiContext: UIContext;
  private ports: webview.WebMessagePort[] = [];
  private messagePortReady: boolean = false;
  private binaryDataCallback: ((data: ArrayBuffer) => void) | null = null;
  private verifyResultCallback: ((id: number, status: string, message: string) => void) | null = null;
  // 阅读器为加密 PDF 输入的正确密码，按文件路径缓存，供跳转工具页时复用（避免二次输密码）
  private passwords: Map<string, string> = new Map();

  constructor(controller: webview.WebviewController, context: common.UIAbilityContext | null, uiContext: UIContext) {
    this.controller = controller;
    this.context = context;
    this.uiContext = uiContext;
  }

  // ============ 文件 I/O（JS → ArkTS）============

  /**
   * 读取文件为 Base64 字符串
   * @param filePath 沙箱内文件路径
   * @returns Base64 编码的文件内容，或 JSON 错误对象
   */
  readFile(filePath: string): string {
    try {
      Logger.info(Constants.TAG_BRIDGE, `readFile: ${filePath}`);
      if (!fs.accessSync(filePath)) {
        return JSON.stringify({ error: `File not found: ${filePath}` });
      }
      const stat = fs.statSync(filePath);
      if (stat.size === 0) {
        return JSON.stringify({ error: `File is empty: ${filePath}` });
      }
      const file = fs.openSync(filePath, fs.OpenMode.READ_ONLY);
      const buffer = new ArrayBuffer(stat.size);
      fs.readSync(file.fd, buffer);
      fs.closeSync(file);

      const helper = new util.Base64Helper();
      // 使用 BASIC base64，不插入换行，JS 端处理更直接
      const base64 = helper.encodeToStringSync(new Uint8Array(buffer), util.Type.BASIC);
      Logger.info(Constants.TAG_BRIDGE, `readFile success, size=${stat.size}, base64Len=${base64.length}`);
      if (!base64 || base64.length === 0) {
        return JSON.stringify({ error: `Base64 encoding returned empty for: ${filePath}` });
      }
      return base64;
    } catch (e) {
      const msg = (e as Error).message;
      Logger.error(Constants.TAG_BRIDGE, `readFile error: ${msg}`);
      return JSON.stringify({ error: msg });
    }
  }

  /**
   * 将 Base64 数据写入文件
   * @param filePath 目标路径
   * @param base64Data Base64 编码的数据
   * @returns 成功返回 'OK'，失败返回错误信息字符串（以 ERROR: 开头）
   */
  writeFile(filePath: string, base64Data: string): string {
    try {
      Logger.info(Constants.TAG_BRIDGE, `writeFile: ${filePath}, dataLen=${base64Data ? base64Data.length : 0}, type=${typeof base64Data}`);
      if (!base64Data || typeof base64Data !== 'string') {
        return 'ERROR: base64Data is not a valid string';
      }

      // 防御性清理：移除换行/空格，补全 padding
      let cleaned = base64Data.replace(/[\s\r\n]/g, '');
      const padLen = (4 - (cleaned.length % 4)) % 4;
      if (padLen > 0) {
        cleaned += '='.repeat(padLen);
      }
      Logger.info(Constants.TAG_BRIDGE, `writeFile cleaned base64 length=${cleaned.length}`);

      const helper = new util.Base64Helper();
      const uint8 = helper.decodeSync(cleaned, util.Type.BASIC);
      Logger.info(Constants.TAG_BRIDGE, `writeFile decoded ${uint8.length} bytes`);

      // 鸿蒙 fs.writeSync 接受 ArrayBuffer|string，不接受 Uint8Array
      // 必须切出精确的 ArrayBuffer，uint8.buffer 可能指向更大的共享缓冲区
      const exactBuffer = uint8.buffer.slice(uint8.byteOffset, uint8.byteOffset + uint8.byteLength);
      const file = fs.openSync(filePath, fs.OpenMode.CREATE | fs.OpenMode.READ_WRITE | fs.OpenMode.TRUNC);
      fs.writeSync(file.fd, exactBuffer);
      fs.closeSync(file);
      Logger.info(Constants.TAG_BRIDGE, `writeFile success, decodedBytes=${uint8.length}`);
      return 'OK';
    } catch (e) {
      const msg = (e as Error).message || String(e);
      Logger.error(Constants.TAG_BRIDGE, `writeFile error: ${msg}`);
      return 'ERROR: ' + msg;
    }
  }

  /**
   * 获取文件信息
   */
  getFileInfo(filePath: string): string {
    try {
      const stat = fs.statSync(filePath);
      return JSON.stringify({
        size: stat.size,
        isFile: stat.isFile(),
        isDir: stat.isDirectory(),
        lastModified: stat.mtime
      });
    } catch (e) {
      return JSON.stringify({ error: (e as Error).message });
    }
  }

  /**
   * 获取 APP 文件目录
   * 说明：registerJavaScriptProxy 注入对象被 JS 调用时，方法内 `this` 未必稳定绑定到
   * 原实例（this.context 可能取不到），故从全局单例 AppContext 兜底获取，避免崩溃。
   */
  getFilesDir(): string {
    const ctx = this.context ?? AppContext.getContextOrNull();
    if (!ctx) {
      throw new Error('AppContext not ready: filesDir unavailable');
    }
    return ctx.filesDir;
  }

  /**
   * 获取 APP 缓存目录
   */
  getCacheDir(): string {
    const ctx = this.context ?? AppContext.getContextOrNull();
    if (!ctx) {
      throw new Error('AppContext not ready: cacheDir unavailable');
    }
    return ctx.cacheDir;
  }

  /**
   * 创建目录
   */
  createDir(dirPath: string): boolean {
    try {
      if (!fs.accessSync(dirPath)) {
        fs.mkdirSync(dirPath, true);
      }
      return true;
    } catch (e) {
      Logger.error(Constants.TAG_BRIDGE, `createDir error: ${(e as Error).message}`);
      return false;
    }
  }

  /**
   * 列出目录文件
   */
  listFiles(dirPath: string): string {
    try {
      const names: string[] = fs.listFileSync(dirPath);
      const result: FileItem[] = names.map((name: string): FileItem => ({
        name: name,
        path: `${dirPath}/${name}`,
        isDir: fs.statSync(`${dirPath}/${name}`).isDirectory()
      }));
      return JSON.stringify(result);
    } catch (e) {
      return JSON.stringify({ error: (e as Error).message });
    }
  }

  /**
   * 删除文件
   */
  deleteFile(filePath: string): boolean {
    try {
      fs.unlinkSync(filePath);
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * 重命名文件
   */
  renameFile(oldPath: string, newPath: string): boolean {
    try {
      fs.renameSync(oldPath, newPath);
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * 检查文件是否存在
   */
  fileExists(filePath: string): boolean {
    try {
      return fs.accessSync(filePath);
    } catch (e) {
      return false;
    }
  }

  // ============ 系统能力调用 ============

  /**
   * 显示 Toast
   */
  showToast(message: string): void {
    try {
      this.uiContext.getPromptAction().showToast({ message: message, duration: 2000 });
    } catch (e) {
      Logger.error(Constants.TAG_BRIDGE, `showToast error: ${(e as Error).message}`);
    }
  }

  /**
   * 复制到剪贴板
   */
  copyToClipboard(text: string): void {
    try {
      const clipboard = pasteboard.getSystemPasteboard();
      const data = pasteboard.createData(pasteboard.MIMETYPE_TEXT_PLAIN, text);
      clipboard.setDataSync(data);
    } catch (e) {
      Logger.error(Constants.TAG_BRIDGE, `copyToClipboard error: ${(e as Error).message}`);
    }
  }

  // ============ 进度回调接收 ============

  /**
   * JS 侧调用此方法推送任务进度
   */
  onProgress(taskId: string, current: number, total: number): void {
    AppStorage.setOrCreate(`progress_${taskId}`, { current, total });
  }

  /**
   * JS 侧任务完成回调
   */
  onTaskComplete(taskId: string, result: string): void {
    Logger.info(Constants.TAG_BRIDGE, `Task complete: ${taskId}`);
    AppStorage.setOrCreate(`result_${taskId}`, result);
  }

  /**
   * JS 侧任务出错回调
   */
  onTaskError(taskId: string, error: string): void {
    Logger.error(Constants.TAG_BRIDGE, `Task error: ${taskId} - ${error}`);
    AppStorage.setOrCreate(`error_${taskId}`, error);
  }

  /**
   * 设置验证结果回调（由 TechVerify 注入，直接驱动 UI 更新）
   */
  setVerifyResultCallback(callback: (id: number, status: string, message: string) => void): void {
    this.verifyResultCallback = callback;
  }

  /**
   * 阅读器上报当前阅读页码（由 reader.js 在翻页/滚动翻页时调用，total 为总页数）
   * ArkTS 侧（Reader.ets）监听 AppStorage 的 readerCurrentPage 做进度持久化与页码展示。
   */
  onReaderPage(filePath: string, page: number, total: number): void {
    AppStorage.setOrCreate('readerCurrentPage', { path: filePath, page: page, total: total || 0 });
  }

  /**
   * 阅读器请求关闭（返回文件列表）
   */
  closeReader(): void {
    AppStorage.setOrCreate('readerCloseRequest', Date.now());
  }

  /**
   * 阅读器成功用密码打开加密 PDF 后，上报该密码（按路径缓存）。
   * 随后从阅读器跳转工具页时，ArkTS 取出并注入编辑器，避免用户二次输入。
   */
  reportPassword(filePath: string, password: string): void {
    if (filePath) {
      this.passwords.set(filePath, password || '');
      Logger.info(Constants.TAG_BRIDGE, `reportPassword cached for ${filePath}`);
    }
  }

  /**
   * 取出某个文件已缓存的密码（无则返回空串）。
   */
  getPassword(filePath: string): string {
    return (filePath && this.passwords.get(filePath)) || '';
  }

  /**
   * 确保 OCR 资源已复制到沙箱：tesseract core(WASM) + 量化语言包 + worker。
   *
   * 背景：ArkWeb 无法直接 fetch/XHR 读取 rawfile，tesseract 的 core 与语言包若走 CDN 则首次识别必须联网。
   * 故由原生侧把资源从 rawfile 复制到沙箱，JS 侧用 file:// 路径指向本地，实现完全离线识别。
   *
   * @returns JSON 字符串 { ok, core, lang, worker }；ok=false 时 JS 需回退 CDN
   */
  ensureOcrAssets(): string {
    const ctx = this.context ?? AppContext.getContextOrNull();
    if (!ctx) {
      return JSON.stringify({ ok: false, reason: 'context unavailable' });
    }
    try {
      const base = `${ctx.filesDir}/tess`;
      const coreDir = `${base}/core`;
      const langDir = `${base}/lang/4.0.0_best_int`;
      const libDir = `${ctx.filesDir}/web-lib`;
      if (!fs.accessSync(base)) { fs.mkdirSync(base, true); }
      if (!fs.accessSync(coreDir)) { fs.mkdirSync(coreDir, true); }
      if (!fs.accessSync(langDir)) { fs.mkdirSync(langDir, true); }
      if (!fs.accessSync(libDir)) { fs.mkdirSync(libDir, true); }

      const coreFile = `${coreDir}/tesseract-core-simd-lstm.wasm.js`;
      const wasmFile = `${coreDir}/tesseract-core-simd-lstm.wasm`;
      const chiFile = `${langDir}/chi_sim.traineddata.gz`;
      const engFile = `${langDir}/eng.traineddata.gz`;
      const workerFile = `${libDir}/tesseract-worker.min.js`;

      this.copyRawFile(ctx, 'web/tess/core/tesseract-core-simd-lstm.wasm.js', coreFile);
      this.copyRawFile(ctx, 'web/tess/core/tesseract-core-simd-lstm.wasm', wasmFile);
      this.copyRawFile(ctx, 'web/tess/lang/4.0.0_best_int/chi_sim.traineddata.gz', chiFile);
      this.copyRawFile(ctx, 'web/tess/lang/4.0.0_best_int/eng.traineddata.gz', engFile);
      this.copyRawFile(ctx, 'web/lib/tesseract-worker.min.js', workerFile);

      const files: string[] = [coreFile, wasmFile, chiFile, engFile, workerFile];
      let allExist = true;
      for (let i = 0; i < files.length; i++) {
        if (!fs.accessSync(files[i])) { allExist = false; }
      }
      Logger.info(Constants.TAG_BRIDGE, `ensureOcrAssets done, ok=${allExist}`);
      return JSON.stringify({
        ok: allExist,
        // lang 指向 lang 根，tesseract 会按 lstmOnly 再拼 /4.0.0_best_int/<lang>.traineddata.gz
        core: `file://${coreFile}`,
        lang: `file://${base}/lang`,
        worker: `file://${workerFile}`
      });
    } catch (e) {
      const err = e as BusinessError;
      return JSON.stringify({ ok: false, reason: err.message || String(e) });
    }
  }

  /** 从 rawfile 复制单个文件到沙箱（已存在则跳过） */
  private copyRawFile(ctx: common.UIAbilityContext, rawPath: string, destPath: string): void {
    if (fs.accessSync(destPath)) { return; }
    const data = ctx.resourceManager.getRawFileContentSync(rawPath);
    const file = fs.openSync(destPath, fs.OpenMode.CREATE | fs.OpenMode.READ_WRITE | fs.OpenMode.TRUNC);
    fs.writeSync(file.fd, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    fs.closeSync(file);
    Logger.info(Constants.TAG_BRIDGE, `copied ${rawPath} -> ${destPath}, bytes=${data.length}`);
  }

  // ============ 工具结果处理（生成后预览 / 保存 / 分享）============

  /**
   * 工具执行成功后，打开结果文件到阅读器（预览 + 分享 + 另存为）。
   * Reader 已具备成熟的预览与分享/另存能力，此处直接跳转复用。
   */
  openResult(path: string, name: string): void {
    try {
      router.pushUrl({
        url: 'pages/Reader',
        params: { filePath: path, fileName: name }
      }).catch((e: Error) => {
        Logger.error(Constants.TAG_BRIDGE, `openResult push failed: ${e.message}`);
      });
    } catch (e) {
      Logger.error(Constants.TAG_BRIDGE, `openResult error: ${(e as Error).message}`);
    }
  }

  /**
   * 保存（导出）结果文件到用户指定位置（系统文件选择器）。
   * 复用 Reader.saveAsFile 的官方可用写法：READ_WRITE|CREATE + copyFileSync(fd, fd)。
   */
  async saveResult(path: string, name: string): Promise<void> {
    const ctx = this.context ?? AppContext.getContextOrNull();
    if (!ctx) {
      this.showToast('应用上下文未就绪');
      return;
    }
    try {
      const opts: picker.DocumentSaveOptions = new picker.DocumentSaveOptions();
      const safeName: string = (name || 'document').replace(/[\\/:*?"<>|]/g, '_');
      opts.newFileNames = [safeName.endsWith('.pdf') ? safeName : `${safeName}.pdf`];
      const documentPicker: picker.DocumentViewPicker = new picker.DocumentViewPicker(ctx);
      const result: Array<string> = await documentPicker.save(opts);
      if (!result || result.length === 0) {
        return; // 用户取消
      }
      const dstUri: string = result[0];
      const srcFile = fs.openSync(path, fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE);
      const dstFile = fs.openSync(dstUri, fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE);
      fs.copyFileSync(srcFile.fd, dstFile.fd);
      fs.closeSync(srcFile);
      fs.closeSync(dstFile);

      const srcStat = fs.statSync(path);
      const dstStat = fs.statSync(dstUri);
      if (dstStat.size !== srcStat.size) {
        this.showToast(`保存异常：大小不符(落${dstStat.size}/源${srcStat.size})`);
      } else {
        this.showToast('已保存');
      }
    } catch (e) {
      const be = e as BusinessError;
      if (be && (be.code === 801 || (be.message && be.message.toLowerCase().includes('cancel')))) {
        return;
      }
      Logger.error(Constants.TAG_BRIDGE, `saveResult failed: ${(e as Error).message}`);
      this.showToast('保存失败');
    }
  }

  /**
   * 分享结果文件：复制到 cacheDir 临时授权，再调起系统分享面板。
   * 复用 Reader.shareFile 的官方最佳实践（沙箱文件需经 cacheDir 才能被其他应用访问）。
   */
  shareResult(path: string, name: string): void {
    const ctx = this.context ?? AppContext.getContextOrNull();
    if (!ctx) {
      this.showToast('应用上下文未就绪');
      return;
    }
    try {
      const fileName: string = path.split('/').pop() || 'document.pdf';
      const cachePath: string = `${ctx.cacheDir}/${fileName}`;
      fs.copyFileSync(path, cachePath);
      const uri: string = fileUri.getUriFromPath(cachePath);
      const pdfUtd: utd.UniformDataType = utd.UniformDataType.PDF;
      const data: systemShare.SharedData = new systemShare.SharedData({
        utd: pdfUtd,
        uri: uri,
        title: name
      });
      const controller: systemShare.ShareController = new systemShare.ShareController(data);
      controller.show(ctx, {
        previewMode: systemShare.SharePreviewMode.DEFAULT,
        selectionMode: systemShare.SelectionMode.SINGLE
      })
        .then(() => {
          Logger.info(Constants.TAG_BRIDGE, 'share panel shown');
        })
        .catch((e: BusinessError) => {
          Logger.error(Constants.TAG_BRIDGE, `share failed: code=${e.code}, msg=${e.message}`);
          this.showToast(`分享失败(${e.code})`);
        });
    } catch (e) {
      Logger.error(Constants.TAG_BRIDGE, `share error: ${(e as Error).message}`);
      this.showToast('分享失败');
    }
  }

  /**
   * 打印（V1.3 故事 #056）：调起系统打印服务打印 PDF。
   *
   * 需 ohos.permission.PRINT。若被拒（201）或环境无打印服务（401/其它），
   * 回退为系统分享——用户仍可选用打印类应用完成输出，避免功能「点了没反应」。
   */
  printFile(path: string, name: string): void {
    const ctx = this.context ?? AppContext.getContextOrNull();
    if (!ctx) {
      this.showToast('应用上下文未就绪');
      return;
    }
    try {
      print.print([path], ctx)
        .then(() => {
          Logger.info(Constants.TAG_BRIDGE, `print task started: ${path}`);
          this.showToast('已调起打印服务');
        })
        .catch((e: BusinessError) => {
          Logger.error(Constants.TAG_BRIDGE, `print failed: code=${e.code}, msg=${e.message}`);
          this.showToast(`打印服务不可用(${e.code})，已改为分享`);
          this.shareResult(path, name);
        });
    } catch (e) {
      Logger.error(Constants.TAG_BRIDGE, `print error: ${(e as Error).message}`);
      this.showToast('打印失败，已改为分享');
      this.shareResult(path, name);
    }
  }

  /**
   * JS 侧验证结果回调
   * @param verifyId 验证项编号 (1-20)
   * @param status 状态: 'passed' | 'failed' | 'warning'
   * @param message 结果描述
   */
  onVerifyResult(verifyId: number, status: string, message: string): void {
    Logger.info(Constants.TAG_VERIFY, `Verify #${verifyId}: ${status} - ${message}`);
    AppStorage.setOrCreate(`verify_${verifyId}`, { id: verifyId, status, message, timestamp: Date.now() });
    if (this.verifyResultCallback) {
      this.verifyResultCallback(verifyId, status, message);
    }
  }

  // ============ WebMessagePort 通道 ============

  /**
   * 建立大数据通道
   */
  setupMessagePort(): void {
    try {
      this.ports = this.controller.createWebMessagePorts();
      if (this.ports.length >= 2) {
        // port[1] 留在 ArkTS 侧，接收 JS 发来的数据
        this.ports[1].onMessageEvent((result: webview.WebMessage) => {
          if (result instanceof ArrayBuffer) {
            Logger.info(Constants.TAG_BRIDGE, `Received ArrayBuffer from JS, size=${result.byteLength}`);
            if (this.binaryDataCallback) {
              this.binaryDataCallback(result);
            }
          } else if (typeof result === 'string') {
            Logger.info(Constants.TAG_BRIDGE, `Received string from JS: ${result}`);
          }
        });
        // port[0] 发送到 JS 侧
        this.controller.postMessage('', [this.ports[0]], '*');
        this.messagePortReady = true;
        Logger.info(Constants.TAG_BRIDGE, 'MessagePort established');
      }
    } catch (e) {
      Logger.error(Constants.TAG_BRIDGE, `setupMessagePort error: ${(e as Error).message}`);
    }
  }

  /**
   * 检查 MessagePort 是否就绪
   */
  isMessagePortReady(): boolean {
    return this.messagePortReady;
  }

  /**
   * 通过 MessagePort 向 JS 侧发送 ArrayBuffer
   */
  sendBinaryToJS(data: ArrayBuffer): void {
    if (this.ports[1]) {
      try {
        this.ports[1].postMessageEvent(data);
      } catch (e) {
        Logger.error(Constants.TAG_BRIDGE, `sendBinaryToJS error: ${(e as Error).message}`);
      }
    }
  }

  /**
   * 设置二进制数据接收回调
   */
  setBinaryDataCallback(callback: (data: ArrayBuffer) => void): void {
    this.binaryDataCallback = callback;
  }

  /**
   * 获取当前时间戳（用于性能测试）
   */
  getTimestamp(): number {
    return Date.now();
  }

  /**
   * 获取设备信息
   */
  getDeviceInfo(): string {
    const info: DeviceInfo = {
      deviceType: deviceInfo.deviceType || 'unknown'
    };
    return JSON.stringify(info);
  }
}
