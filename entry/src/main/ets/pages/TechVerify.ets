import { webview } from '@kit.ArkWeb';
import { common } from '@kit.AbilityKit';
import { UIContext } from '@kit.ArkUI';
import { fileIo as fs, picker } from '@kit.CoreFileKit';
import { PdfBridge } from '../bridge/PdfBridge';
import { Logger } from '../utils/Logger';
import { Constants } from '../utils/Constants';
import { AppContext } from '../utils/AppContext';

/**
 * 验证项数据结构
 */
interface VerifyItem {
  id: number;
  title: string;
  category: string;
  method: string;
  criteria: string;
  status: string;   // 'pending' | 'running' | 'passed' | 'failed' | 'warning'
  message: string;
}

interface VerifyResult {
  id: number;
  status: string;
  message: string;
  timestamp: number;
}

/**
 * M0 技术验证页面
 *
 * 20 项关键技术验证点，涵盖：
 * - pdf.js 加载、Worker、渲染、手势、文本提取
 * - @maxwbh/pdf-lib 加载、合并、加密、解密
 * - tesseract.js 加载、Worker、中文识别
 * - WebMessagePort、registerJavaScriptProxy、runJavaScript
 * - 沙箱文件读写、中文字体嵌入、Canvas 手写、内存监控、冷启动
 */
@Entry
@Component
struct TechVerify {
  @State verifyItems: VerifyItem[] = this.initVerifyItems();
  @State webReady: boolean = false;
  @State bridgeReady: boolean = false;
  @State selectedFilePath: string = '';
  @State logText: string = '';
  @State passCount: number = 0;
  @State failCount: number = 0;
  @State totalCount: number = 20;

  // 构建版本号：每次修改 JS/ArkTS 后同步更新，便于一眼确认模拟器是否跑的新包
  private buildVersion: string = '20260809-2235';

  private controller: webview.WebviewController = new webview.WebviewController();
  private bridge: PdfBridge | null = null;
  private context!: common.UIAbilityContext;
  private uiContext!: UIContext;

  // ============ 初始化 20 项验证清单 ============
  private initVerifyItems(): VerifyItem[] {
    return [
      // pdf.js 验证
      { id: 1, title: 'pdf.js 加载运行', category: 'pdf.js', method: '加载 pdf.js 并打开测试 PDF', criteria: '正常渲染，首页 ≤ 2 秒', status: 'pending', message: '' },
      { id: 2, title: 'pdf.js Worker 模式', category: 'pdf.js', method: '检查 Web Worker 是否创建', criteria: 'Worker 正常工作或降级模式可用', status: 'pending', message: '' },
      { id: 3, title: 'pdf.js 100 页性能', category: 'pdf.js', method: '打开大页数 PDF 翻页', criteria: '帧率 ≥ 30fps', status: 'pending', message: '' },
      { id: 4, title: 'pdf.js 手势缩放', category: 'pdf.js', method: '双指缩放操作', criteria: '缩放流畅无卡顿', status: 'pending', message: '' },
      { id: 5, title: 'pdf.js 文本提取', category: 'pdf.js', method: 'getTextContent()', criteria: '中文文本正确提取', status: 'pending', message: '' },
      // @maxwbh/pdf-lib 验证
      { id: 6, title: '@maxwbh/pdf-lib 加载', category: 'pdf-lib', method: '加载 UMD 构建', criteria: '库正常初始化', status: 'pending', message: '' },
      { id: 7, title: 'pdf-lib 合并 PDF', category: 'pdf-lib', method: 'copyPages API', criteria: '合并后 PDF 正常打开', status: 'pending', message: '' },
      { id: 8, title: 'pdf-lib 加密 AES-256', category: 'pdf-lib', method: 'save({ encrypt })', criteria: 'Adobe Reader 需密码打开', status: 'pending', message: '' },
      { id: 9, title: 'pdf-lib 解密', category: 'pdf-lib', method: 'load({ password })', criteria: '解密后无密码可打开', status: 'pending', message: '' },
      // tesseract.js 验证
      { id: 10, title: 'tesseract.js 加载', category: 'tesseract', method: '加载 tesseract.js', criteria: '库正常初始化', status: 'pending', message: '' },
      { id: 11, title: 'tesseract.js Worker', category: 'tesseract', method: '创建 Worker', criteria: 'Worker 正常工作或降级可用', status: 'pending', message: '' },
      { id: 12, title: 'tesseract.js 中文识别', category: 'tesseract', method: 'chi_sim 语言包', criteria: '中文识别结果正确', status: 'pending', message: '' },
      // 桥接通信验证
      { id: 13, title: 'WebMessagePort 传输', category: 'bridge', method: '传输 5MB ArrayBuffer', criteria: '数据完整无损', status: 'pending', message: '' },
      { id: 14, title: 'registerJavaScriptProxy', category: 'bridge', method: 'JS 调用 ArkTS 方法', criteria: '方法调用成功', status: 'pending', message: '' },
      { id: 15, title: 'runJavaScript', category: 'bridge', method: 'ArkTS 调用 JS 函数', criteria: '函数执行成功', status: 'pending', message: '' },
      // 系统能力验证
      { id: 16, title: '沙箱文件读写', category: 'system', method: 'fs API 读写 PDF', criteria: '文件正确读写', status: 'pending', message: '' },
      { id: 17, title: '中文字体嵌入', category: 'system', method: '嵌入 TTF 后绘制中文', criteria: '中文文字标注可显示', status: 'pending', message: '' },
      { id: 18, title: 'Canvas 手写采集', category: 'system', method: 'pointer 事件采集笔迹', criteria: '笔迹流畅无明显延迟', status: 'pending', message: '' },
      { id: 19, title: '内存监控', category: 'system', method: '打开 50MB PDF', criteria: '内存峰值 ≤ 200MB', status: 'pending', message: '' },
      { id: 20, title: '冷启动性能', category: 'system', method: 'Web 引擎预加载', criteria: '冷启动 ≤ 3 秒', status: 'pending', message: '' }
    ];
  }

  aboutToAppear() {
    this.uiContext = this.getUIContext();
    this.context = AppContext.getContext();
    // 预加载 Web 引擎
    try {
      webview.WebviewController.initializeWebEngine();
      Logger.info(Constants.TAG_VERIFY, 'Web engine preloaded in aboutToAppear');
    } catch (e) {
      Logger.error(Constants.TAG_VERIFY, `Preload failed: ${(e as Error).message}`);
    }
    // 强制清除 WebView 缓存，避免模拟器/真机重复使用旧 rawfile JS 资源（M0 验证期间尤为重要）
    try {
      webview.WebviewController.removeAllCache(true);
      Logger.info(Constants.TAG_VERIFY, 'WebView cache removed');
    } catch (e) {
      Logger.error(Constants.TAG_VERIFY, `removeAllCache failed: ${(e as Error).message}`);
    }
    // 主动确保内置示例 PDF 已拷贝到沙箱（与 EntryAbility 的异步拷贝双保险）
    this.ensureSamplePdfInSandbox().catch((e: Error) => {
      Logger.error(Constants.TAG_VERIFY, `ensureSamplePdfInSandbox failed: ${e.message}`);
    });
  }

  /**
   * 将 rawfile/sample.pdf 拷贝到应用沙箱 filesDir
   */
  private async ensureSamplePdfInSandbox(): Promise<void> {
    const sampleName: string = 'sample.pdf';
    const target: string = `${this.context.filesDir}/${sampleName}`;
    try {
      if (fs.accessSync(target)) {
        Logger.info(Constants.TAG_VERIFY, `Sample PDF already exists: ${target}`);
        return;
      }
    } catch (e) {
      // 不存在则继续拷贝
    }
    try {
      const data: Uint8Array = await this.context.resourceManager.getRawFileContent(sampleName);
      Logger.info(Constants.TAG_VERIFY, `Raw sample loaded, size=${data.length}, buffer=${data.byteLength}`);
      const file = fs.openSync(target, fs.OpenMode.CREATE | fs.OpenMode.WRITE_ONLY);
      // 必须切出精确 ArrayBuffer；data.buffer 可能指向更大的共享缓冲区
      const exactBuffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      fs.writeSync(file.fd, exactBuffer);
      fs.closeSync(file);
      const stat = fs.statSync(target);
      Logger.info(Constants.TAG_VERIFY, `Sample PDF copied to ${target}, written=${stat.size}`);
    } catch (e) {
      Logger.error(Constants.TAG_VERIFY, `Failed to copy sample PDF: ${(e as Error).message}`);
    }
  }

  // ============ Web 控制器绑定后注入桥接对象（页面加载前）============
  onControllerAttached(): void {
    try {
      this.bridge = new PdfBridge(this.controller, this.context, this.uiContext);
      // 注入验证结果回调，使 JS 侧每项结果直接回流到 UI（避免只写 AppStorage 造成"验证中"卡死）
      this.bridge.setVerifyResultCallback((id: number, status: string, msg: string) => {
        this.updateItemStatus(id, status, msg);
      });
      // 在控制器已绑定、页面尚未加载时注入，页面加载后 nativeBridge 即可用
      this.controller.registerJavaScriptProxy(
        this.bridge,
        'nativeBridge',
        [
          'readFile', 'writeFile', 'getFileInfo',
          'getFilesDir', 'getCacheDir',
          'createDir', 'listFiles', 'deleteFile', 'renameFile', 'fileExists',
          'showToast', 'copyToClipboard',
          'onProgress', 'onTaskComplete', 'onTaskError', 'onVerifyResult',
          'setupMessagePort', 'isMessagePortReady', 'sendBinaryToJS',
          'setBinaryDataCallback', 'getTimestamp', 'getDeviceInfo'
        ]
      );
      this.log('Bridge proxy registered');
      Logger.info(Constants.TAG_VERIFY, 'Bridge proxy registered (onControllerAttached)');
    } catch (e) {
      this.log(`Proxy register failed: ${(e as Error).message}`);
      Logger.error(Constants.TAG_VERIFY, `Proxy register error: ${(e as Error).message}`);
    }
  }

  // ============ Web 页面加载完成后完成桥接握手 ============
  onPageEnd(): void {
    try {
      // 1) 先通知 JS 侧注册 MessagePort listener，避免后续 postMessage 的 port 事件丢失
      this.controller.runJavaScript('window.__bridgeReady = true; if (window.onBridgeReady) { window.onBridgeReady(); }');

      // 2) 再建立 MessagePort 双向通道（ArkTS 侧持有 port[1]，port[0] 发给 JS）
      if (this.bridge) {
        this.bridge.setupMessagePort();
      }

      this.bridgeReady = true;
      this.log('Bridge registered successfully');
      Logger.info(Constants.TAG_VERIFY, 'Bridge registered');

      // 3) 确保 sample.pdf 存在后再通知 JS 测试路径
      this.waitForSamplePdf().then(() => {
        const samplePath = `${this.context.filesDir}/sample.pdf`;
        this.selectedFilePath = samplePath;
        this.log(`Test PDF ready: ${samplePath}`);
        Logger.info(Constants.TAG_VERIFY, `Setting test PDF path: ${samplePath}`);
        this.syncTestFilePathToJs(samplePath);
      }).catch((e: Error) => {
        const msg = e.message;
        this.log(`Test PDF not ready: ${msg}`);
        Logger.error(Constants.TAG_VERIFY, `waitForSamplePdf error: ${msg}`);
        // 即使等待失败，仍把默认路径同步给 JS，让验证能继续（JS 侧 readFile 会暴露真实错误）
        const fallbackPath = `${this.context.filesDir}/sample.pdf`;
        this.selectedFilePath = fallbackPath;
        this.syncTestFilePathToJs(fallbackPath);
      });
    } catch (e) {
      this.log(`Bridge register failed: ${(e as Error).message}`);
      Logger.error(Constants.TAG_VERIFY, `Bridge register error: ${(e as Error).message}`);
    }
  }

  /**
   * 将测试文件路径同步给 JS 验证引擎
   */
  private syncTestFilePathToJs(path: string): void {
    if (!path) {
      return;
    }
    try {
      const jsCode = `if (typeof verifyEngine !== 'undefined') { verifyEngine.setTestFilePath('${path}'); }`;
      this.controller.runJavaScript(jsCode);
      Logger.info(Constants.TAG_VERIFY, `syncTestFilePathToJs: ${path}`);
    } catch (e) {
      Logger.error(Constants.TAG_VERIFY, `syncTestFilePathToJs error: ${(e as Error).message}`);
    }
  }

  /**
   * 轮询等待 sample.pdf 拷贝完成（最多 5 秒）
   */
  private waitForSamplePdf(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const target = `${this.context.filesDir}/sample.pdf`;
      let attempts = 0;
      const maxAttempts = 50;
      const timer = setInterval(() => {
        attempts++;
        try {
          if (fs.accessSync(target) && fs.statSync(target).size > 0) {
            clearInterval(timer);
            resolve();
            return;
          }
        } catch (e) {
          // 文件尚不存在
        }
        if (attempts >= maxAttempts) {
          clearInterval(timer);
          reject(new Error(`sample.pdf not found after waiting: ${target}`));
        }
      }, 100);
    });
  }

  // ============ 选择测试 PDF 文件 ============
  async pickTestPdf() {
    try {
      const options = new picker.DocumentSelectOptions();
      options.maxSelectNumber = 1;
      options.fileSuffixFilters = ['.pdf'];

      const documentPicker = new picker.DocumentViewPicker();
      const uris = await documentPicker.select(options);

      if (uris.length > 0) {
        // 复制到沙箱
        const fileName = uris[0].split('/').pop() || 'test.pdf';
        const destPath = `${this.context.filesDir}/${fileName}`;
        this.copyFileToSandbox(uris[0], destPath);
        this.selectedFilePath = destPath;
        this.syncTestFilePathToJs(destPath);
        this.log(`Test PDF selected: ${fileName}`);
        this.log(`Sandbox path: ${destPath}`);
      }
    } catch (e) {
      this.log(`File pick failed: ${(e as Error).message}`);
    }
  }

  private copyFileToSandbox(srcUri: string, destPath: string) {
    try {
      const srcFile = fs.openSync(srcUri, fs.OpenMode.READ_ONLY);
      const destFile = fs.openSync(destPath, fs.OpenMode.CREATE | fs.OpenMode.READ_WRITE | fs.OpenMode.TRUNC);
      fs.copyFileSync(srcFile.fd, destFile.fd);
      fs.closeSync(srcFile);
      fs.closeSync(destFile);
    } catch (e) {
      this.log(`Copy failed: ${(e as Error).message}`);
    }
  }

  // ============ 执行单个验证项 ============
  runVerify(itemId: number) {
    if (!this.bridgeReady) {
      this.log('Bridge not ready yet, please wait...');
      return;
    }

    // 更新状态为运行中
    this.updateItemStatus(itemId, 'running', '验证中...');

    // 调用 JS 侧验证函数，并把当前选中的测试文件路径作为参数传入
    const path = this.selectedFilePath || `${this.context.filesDir}/sample.pdf`;
    const escapedPath = path.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const jsCode = `verifyEngine.runTest(${itemId}, '${escapedPath}').catch(err => {
      nativeBridge.onVerifyResult(${itemId}, 'failed', err.message || String(err));
    });`;

    try {
      this.controller.runJavaScript(jsCode);
      this.log(`Running verify #${itemId}...`);
    } catch (e) {
      this.updateItemStatus(itemId, 'failed', (e as Error).message);
    }
  }

  // ============ 执行全部验证 ============
  runAllVerify() {
    if (!this.bridgeReady) {
      this.log('Bridge not ready yet, please wait...');
      return;
    }
    this.log('Running all verifications...');
    // 先置全部为运行中，给出视觉反馈，结果由 onVerifyResult 回调逐项覆盖
    for (const item of this.verifyItems) {
      this.updateItemStatus(item.id, 'running', '验证中...');
    }
    try {
      const path = this.selectedFilePath || `${this.context.filesDir}/sample.pdf`;
      const escapedPath = path.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      this.controller.runJavaScript(`verifyEngine.runAllTests('${escapedPath}');`);
    } catch (e) {
      this.log(`Run all failed: ${(e as Error).message}`);
    }
  }

  // ============ 更新验证项状态 ============
  private updateItemStatus(id: number, status: string, message: string) {
    this.verifyItems = this.verifyItems.map(item => {
      if (item.id === id) {
        return {
          id: item.id,
          title: item.title,
          category: item.category,
          method: item.method,
          criteria: item.criteria,
          status: status,
          message: message
        };
      }
      return item;
    });
    this.updateCounts();
  }

  private updateCounts() {
    let pass = 0, fail = 0;
    for (const item of this.verifyItems) {
      if (item.status === 'passed') pass++;
      else if (item.status === 'failed') fail++;
    }
    this.passCount = pass;
    this.failCount = fail;
  }

  // ============ 轮询验证结果 ============
  private checkVerifyResults() {
    for (let i = 1; i <= 20; i++) {
      const key = `verify_${i}`;
      const stored = AppStorage.get<VerifyResult>(key);
      if (stored) {
        const currentItem = this.verifyItems.find(item => item.id === i);
        if (currentItem && currentItem.status !== stored.status) {
          this.updateItemStatus(i, stored.status, stored.message);
        }
      }
    }
  }

  // ============ 日志 ============
  private log(msg: string) {
    const time = new Date().toLocaleTimeString();
    this.logText = `[${time}] ${msg}\n` + this.logText;
    Logger.info(Constants.TAG_VERIFY, msg);
  }

  // ============ 清空日志 ============
  clearLog() {
    this.logText = '';
  }

  // ============ 手动检查结果（按钮触发）============
  refreshResults() {
    this.checkVerifyResults();
    this.log('Results refreshed');
  }

  build() {
    Column() {
      // ===== 顶部标题栏 =====
      Row() {
        Column() {
          Text('PDF 工具 M0 技术验证')
            .fontSize(20)
            .fontWeight(FontWeight.Bold)
            .fontColor('#333333')
          Text(`build ${this.buildVersion}`)
            .fontSize(10)
            .fontColor('#AAAAAA')
            .margin({ top: 2 })
        }
        .alignItems(HorizontalAlign.Start)

        Blank()
        Text(`通过 ${this.passCount}/${this.totalCount}`)
          .fontSize(14)
          .fontColor(this.passCount === this.totalCount ? '#4CAF50' : '#666666')
        Text(`  失败 ${this.failCount}`)
          .fontSize(14)
          .fontColor(this.failCount > 0 ? '#F44336' : '#999999')
      }
      .width('100%')
      .height(56)
      .padding({ left: 16, right: 16 })
      .backgroundColor('#FFFFFF')

      // ===== 操作按钮区 =====
      Row() {
        Button('选择测试PDF')
          .fontSize(14)
          .height(36)
          .backgroundColor('#1976D2')
          .fontColor('#FFFFFF')
          .onClick(() => this.pickTestPdf())
          .margin({ right: 8 })

        Button('全部验证')
          .fontSize(14)
          .height(36)
          .backgroundColor('#4CAF50')
          .fontColor('#FFFFFF')
          .onClick(() => this.runAllVerify())
          .margin({ right: 8 })

        Button('刷新结果')
          .fontSize(14)
          .height(36)
          .backgroundColor('#FF9800')
          .fontColor('#FFFFFF')
          .onClick(() => this.refreshResults())
      }
      .width('100%')
      .padding({ left: 16, right: 16, top: 8, bottom: 8 })

      // ===== 文件路径显示 =====
      if (this.selectedFilePath) {
        Text(`测试文件: ${this.selectedFilePath}`)
          .fontSize(12)
          .fontColor('#666666')
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .width('100%')
          .padding({ left: 16, right: 16, bottom: 8 })
      }

      // ===== 桥接状态指示 =====
      Row() {
        Text('桥接状态:')
          .fontSize(12)
          .fontColor('#666666')
        Text(this.bridgeReady ? '已就绪' : '等待中...')
          .fontSize(12)
          .fontColor(this.bridgeReady ? '#4CAF50' : '#FF9800')
          .margin({ left: 4 })
      }
      .width('100%')
      .padding({ left: 16, right: 16, bottom: 8 })

      // ===== Web 引擎视图（桥接核心：加载 verify.js 与第三方库）=====
      Web({ src: $rawfile('web/index.html'), controller: this.controller })
        .width('100%')
        .height(240)
        .backgroundColor('#F0F0F0')
        .cacheMode(CacheMode.None) // 禁用 WebView 缓存，确保 rawfile 中的 JS 修改能生效
        .onControllerAttached(() => {
          this.onControllerAttached();
        })
        .onPageEnd(() => {
          this.onPageEnd();
        })

      // ===== 验证清单列表 =====
      Scroll() {
        Column() {
          ForEach(this.verifyItems, (item: VerifyItem) => {
            Row() {
              // 状态图标
              Text(this.getStatusIcon(item.status))
                .fontSize(18)
                .width(32)

              // 验证项信息
              Column() {
                Text(`${item.id}. ${item.title}`)
                  .fontSize(14)
                  .fontWeight(FontWeight.Medium)
                  .fontColor('#333333')
                Text(`方法: ${item.method}`)
                  .fontSize(11)
                  .fontColor('#999999')
                  .margin({ top: 2 })
                Text(`标准: ${item.criteria}`)
                  .fontSize(11)
                  .fontColor('#999999')
                  .margin({ top: 2 })
                if (item.message) {
                  Text(item.message)
                    .fontSize(11)
                    .fontColor(item.status === 'passed' ? '#4CAF50' : item.status === 'failed' ? '#F44336' : '#FF9800')
                    .margin({ top: 4 })
                }
              }
              .layoutWeight(1)
              .alignItems(HorizontalAlign.Start)

              // 分类标签
              Text(item.category)
                .fontSize(10)
                .fontColor('#FFFFFF')
                .backgroundColor(this.getCategoryColor(item.category))
                .borderRadius(4)
                .padding({ left: 6, right: 6, top: 2, bottom: 2 })

              // 执行按钮
              Button('执行')
                .fontSize(12)
                .height(28)
                .backgroundColor(item.status === 'running' ? '#999999' : '#1976D2')
                .fontColor('#FFFFFF')
                .enabled(item.status !== 'running')
                .onClick(() => this.runVerify(item.id))
                .margin({ left: 8 })
            }
            .width('100%')
            .padding({ left: 16, right: 16, top: 8, bottom: 8 })
            .backgroundColor(item.id % 2 === 0 ? '#FAFAFA' : '#FFFFFF')
          })
        }
      }
      .layoutWeight(1)
      .align(Alignment.Top)

      // ===== 日志区域 =====
      Column() {
        Row() {
          Text('日志输出')
            .fontSize(13)
            .fontWeight(FontWeight.Medium)
            .fontColor('#666666')
          Blank()
          Button('清空')
            .fontSize(11)
            .height(24)
            .backgroundColor('#999999')
            .fontColor('#FFFFFF')
            .onClick(() => this.clearLog())
        }
        .width('100%')
        .padding({ left: 16, right: 16, top: 4, bottom: 4 })

        Scroll() {
          Text(this.logText || '暂无日志')
            .fontSize(11)
            .fontColor('#333333')
            .fontFamily('monospace')
            .width('100%')
            .padding({ left: 16, right: 16 })
        }
        .height(120)
        .backgroundColor('#F5F5F5')
      }
      .width('100%')
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#FFFFFF')
  }

  // ============ 辅助方法 ============
  private getStatusIcon(status: string): string {
    switch (status) {
      case 'passed': return '\u2713'  // ✓
      case 'failed': return '\u2717'  // ✗
      case 'running': return '\u25CB' // ○
      case 'warning': return '!'
      default: return '?'
    }
  }

  private getCategoryColor(category: string): string {
    switch (category) {
      case 'pdf.js': return '#1976D2'
      case 'pdf-lib': return '#7B1FA2'
      case 'tesseract': return '#E65100'
      case 'bridge': return '#00695C'
      case 'system': return '#455A64'
      default: return '#757575'
    }
  }
}
