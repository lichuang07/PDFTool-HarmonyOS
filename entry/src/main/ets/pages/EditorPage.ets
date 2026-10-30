import { webview } from '@kit.ArkWeb';
import { router } from '@kit.ArkUI';
import { fileIo as fs } from '@kit.CoreFileKit';
import { PdfBridge } from '../bridge/PdfBridge';
import { FileService } from '../services/FileService';
import { AppContext } from '../utils/AppContext';
import { Constants } from '../utils/Constants';
import { Logger } from '../utils/Logger';
import { toolInput, toolName } from '../utils/PdfTools';

const TAG = 'EditorPage';

/**
 * PDF 编辑器宿主页（V1.1 骨架）
 *
 * ArkTS 侧仅负责：
 * - 加载 Web 编辑器（web/editor/editor.html，承载 pdf.js 预览 + PdfEditor）
 * - 注入 PdfBridge 桥接
 * - 顶部栏：返回 / 文件名
 * - 入口来源：阅读器顶部「编辑」模态框（基于已打开文件，带 filePath + tool）、
 *   FileList 底部栏「PDF工具」Tab（带 tool 参数、先引导选文件），或列表左滑「编辑」（带 filePath）
 *
 * 工具选择已在入口处前置（模态框 / Tab），编辑器本身不再堆叠按钮（见技术方案 4.2.2）。
 */
@Entry
@Component
struct Editor {
  @State filePath: string = '';
  @State fileName: string = '';
  @State imagePath: string = '';   // 图片签章工具的第二输入（PNG/JPEG）
  @State imagePaths: string[] = []; // 多图片工具（图片转 PDF）传入的图片集合
  @State filePaths: string[] = []; // 多文件工具（如合并）传入的文件集合
  @State tool: string = '';
  @State password: string = '';   // 从阅读器跳转携带的密码（阅读器已输对时免去二次弹窗）
  /** 选文件阶段：0=已就绪（加载 Web 编辑器） 1=待选 PDF 2=待选签章图片 */
  @State pickStage: number = 0;
  @State loading: boolean = true;
  private controller: webview.WebviewController = new webview.WebviewController();
  private bridge: PdfBridge | null = null;

  aboutToAppear(): void {
    const params = router.getParams() as Record<string, Object>;
    if (params) {
      this.filePath = (params['filePath'] as string) || '';
      this.fileName = (params['fileName'] as string) || this.filePath.split('/').pop() || '文档';
      this.tool = (params['tool'] as string) || '';
      this.password = (params['password'] as string) || '';
      const fps = params['filePaths'] as string[] | undefined;
      if (fps && fps.length > 0) {
        this.filePaths = fps;
      }
    }
    // 工具入口未带文件时，先引导选择 PDF；图片签章工具还需第二阶段选图片
    if (!this.filePath && this.filePaths.length === 0 && this.imagePaths.length === 0) {
      this.pickStage = 1;
    } else if (this.isStampTool()) {
      this.pickStage = 2;
    }
    this.bridge = new PdfBridge(this.controller, AppContext.getContextOrNull(), this.getUIContext());
    // 把 rawfile 中文字体复制到沙箱，供 WebView 通过 bridge 读取（ArkWeb fetch/XHR 读 rawfile 会失败）
    this.copyFontToSandbox().catch((e: Error) => {
      Logger.error(TAG, `copyFontToSandbox failed: ${e.message}`);
    });
  }

  /**
   * 将 rawfile 中文字体 / fontkit 复制到沙箱，避免 WebView fetch/XHR/script 无法直接访问 rawfile。
   */
  private async copyFontToSandbox(): Promise<void> {
    const ctx = AppContext.getContextOrNull();
    if (!ctx) {
      Logger.warn(TAG, 'copyFontToSandbox skipped: context not ready');
      return;
    }
    const fontDir = `${ctx.filesDir}/fonts`;
    const libDir = `${ctx.filesDir}/web-lib`;
    if (!fs.accessSync(fontDir)) { fs.mkdirSync(fontDir, true); }
    if (!fs.accessSync(libDir)) { fs.mkdirSync(libDir, true); }

    // 中文字体
    const fontDest = `${fontDir}/SourceHanSansCN-Regular.otf`;
    if (!fs.accessSync(fontDest)) {
      const data = ctx.resourceManager.getRawFileContentSync('web/fonts/SourceHanSansCN-Regular.otf');
      const file = fs.openSync(fontDest, fs.OpenMode.CREATE | fs.OpenMode.READ_WRITE | fs.OpenMode.TRUNC);
      fs.writeSync(file.fd, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
      fs.closeSync(file);
      Logger.info(TAG, `font copied to sandbox: ${fontDest}, bytes=${data.length}`);
    }

    // fontkit（UMD 过大，同步 script 加载可能失败；复制到沙箱供动态 file:// 加载兜底）
    const fontkitDest = `${libDir}/fontkit.umd.js`;
    if (!fs.accessSync(fontkitDest)) {
      const kit = ctx.resourceManager.getRawFileContentSync('web/lib/fontkit.umd.js');
      const file = fs.openSync(fontkitDest, fs.OpenMode.CREATE | fs.OpenMode.READ_WRITE | fs.OpenMode.TRUNC);
      fs.writeSync(file.fd, kit.buffer.slice(kit.byteOffset, kit.byteOffset + kit.byteLength));
      fs.closeSync(file);
      Logger.info(TAG, `fontkit copied to sandbox: ${fontkitDest}, bytes=${kit.length}`);
    }
  }

  build() {
    Column() {
      // 顶部栏
      Row() {
        Row() {
          Text('‹')
            .fontSize(28)
            .fontColor('#1a1a1a')
            .width(40)
            .height(40)
            .textAlign(TextAlign.Center)
        }
        .onClick(() => { router.back(); })

        Column() {
          Text(this.fileName || 'PDF 工具')
            .fontSize(16)
            .fontWeight(FontWeight.Medium)
            .fontColor('#1a1a1a')
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
          if (this.tool) {
            Text(toolName(this.tool))
              .fontSize(11)
              .fontColor('#2F6BFF')
              .maxLines(1)
          }
        }
        .layoutWeight(1)
        .alignItems(HorizontalAlign.Start)
        .margin({ left: 4, right: 4 })
      }
      .width('100%')
      .height(52)
      .padding({ left: 8, right: 12 })
      .backgroundColor('#ffffff')
      .border({ width: { bottom: 1 }, color: '#eeeeee' })

      // 内容区：未选文件时展示选文件面板，否则加载 Web 编辑器
      Stack() {
        if (this.pickStage > 0) {
          this.PickPanel()
        } else if (this.isAnnotTool()) {
          // 手写签名 / 高亮标注走独立交互式标注页（V1.3）
          this.AnnotWebView()
        } else {
          this.EditorWebView()
        }
        if (this.loading && this.pickStage === 0) {
          Column() {
            LoadingProgress()
              .width(40)
              .height(40)
            Text('正在加载…')
              .fontSize(13)
              .fontColor('#999')
              .margin({ top: 12 })
          }
          .width('100%')
          .height('100%')
          .justifyContent(FlexAlign.Center)
          .backgroundColor('#ffffff')
        }
      }
      .layoutWeight(1)
      .width('100%')
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#ffffff')
  }

  /**
   * Web 编辑器（通用工具：页面编辑 / 内容添加 / 加密 / OCR / 元数据）
   * 两个 Web 组件除 src 外配置完全一致——ArkTS 的 $rawfile 只能接收字面量，
   * 无法用变量拼接，故拆成两个 @Builder 而不是参数化一个。
   */
  @Builder
  EditorWebView() {
    Web({ src: $rawfile('web/editor/editor.html'), controller: this.controller })
      .javaScriptAccess(true)
      .domStorageAccess(true)
      .fileAccess(true)
      .imageAccess(true)
      .width('100%')
      .height('100%')
      .onControllerAttached(() => { this.registerBridge(); })
      .onPageEnd(() => { this.injectParams(); })
  }

  /**
   * 交互式标注页（V1.3：手写签名 / 高亮标注）
   * 该页自带 pdf.js 预览 + 透明叠加画布，工具参数由页面内部接管。
   */
  @Builder
  AnnotWebView() {
    Web({ src: $rawfile('web/annot/annot.html'), controller: this.controller })
      .javaScriptAccess(true)
      .domStorageAccess(true)
      .fileAccess(true)
      .imageAccess(true)
      .width('100%')
      .height('100%')
      .onControllerAttached(() => { this.registerBridge(); })
      .onPageEnd(() => { this.injectParams(); })
  }

  /** 注册 nativeBridge 代理（两个 Web 页共用） */
  private registerBridge(): void {
    if (this.bridge) {
      this.controller.registerJavaScriptProxy(this.bridge, 'nativeBridge', [
        'readFile', 'writeFile', 'getFileInfo', 'getFilesDir', 'getCacheDir',
        'createDir', 'listFiles', 'deleteFile', 'renameFile', 'fileExists',
        'showToast', 'copyToClipboard', 'onProgress', 'onTaskComplete', 'onTaskError',
        'getTimestamp', 'getDeviceInfo',
        'openResult', 'saveResult', 'shareResult', 'ensureOcrAssets', 'printFile'
      ]);
      Logger.info(TAG, 'nativeBridge registered');
    }
  }

  /** 注入运行参数（两个 Web 页共用，晚于页面脚本执行，故 JS 侧需轮询读取） */
  private injectParams(): void {
    try {
      this.loading = false;
      // 字体路径走沙箱：ArkWeb 无法 fetch/XHR 直接读 rawfile，需由原生侧先复制（见 copyFontToSandbox）
      const ctx = AppContext.getContextOrNull();
      const fontPath = ctx ? `${ctx.filesDir}/fonts/SourceHanSansCN-Regular.otf` : '';
      const fontkitPath = ctx ? `${ctx.filesDir}/web-lib/fontkit.umd.js` : '';
      const script = `window.__PDF_PATH__=${JSON.stringify(this.filePath)};` +
        `window.__PDF_PATHS__=${JSON.stringify(this.filePaths)};` +
        `window.__PDF_TOOL__=${JSON.stringify(this.tool)};` +
        `window.__PDF_PASSWORD__=${JSON.stringify(this.password)};` +
        `window.__PDF_FONT_PATH__=${JSON.stringify(fontPath)};` +
        `window.__PDF_FONTKIT_PATH__=${JSON.stringify(fontkitPath)};` +
        `window.__STAMP_IMAGE__=${JSON.stringify(this.imagePath)};` +
        `window.__PDF_IMAGES__=${JSON.stringify(this.imagePaths)};`;
      this.controller.runJavaScript(script).catch((e: Error) => {
        Logger.error(TAG, `runJavaScript failed: ${e.message}`);
      });
    } catch (e) {
      Logger.error(TAG, `onPageEnd failed: ${(e as Error).message}`);
    }
  }

  /**
   * 工具入口未带文件时的选文件面板（V1.1）
   * 点击「选择 PDF」调起系统选择器，导入沙箱后加载 Web 编辑器。
   */
  @Builder
  PickPanel() {
    Column() {
      Column() {
        Text(this.pickStage === 2 ? '选择签章图片' : 'PDF 工具')
          .fontSize(22)
          .fontWeight(FontWeight.Bold)
          .fontColor('#1a1a1a')
          .margin({ bottom: 8 })
        Text(this.pickStage === 2
          ? `将盖到：${this.filePath.split('/').pop() || '文档'}`
          : (this.tool ? `即将使用工具：${toolName(this.tool)}` : '选择一个文件开始处理'))
          .fontSize(14)
          .fontColor('#666666')
          .margin({ bottom: 28 })
        Button(this.pickButtonLabel(), { type: ButtonType.Normal })
          .width(220)
          .height(44)
          .backgroundColor('#0a7aff')
          .fontColor('#ffffff')
          .onClick(() => { this.pickFile(); })
      }
      .padding(24)
      .backgroundColor('#ffffff')
      .borderRadius(16)
      .shadow({ radius: 12, color: 'rgba(0,0,0,0.08)', offsetY: 4 })
    }
    .width('100%')
    .height('100%')
    .justifyContent(FlexAlign.Center)
    .backgroundColor('#f7f8fa')
  }

  /**
   * 选文件按钮文案：随工具的输入类型变化（多 PDF / 图片 / 单个 PDF）
   */
  private pickButtonLabel(): string {
    if (this.pickStage === 2) {
      return '选择图片';
    }
    if (!this.tool) {
      return '选择 PDF';
    }
    if (this.isImageTool()) {
      return '选择图片';
    }
    if (toolInput(this.tool) === 'multiple') {
      return '选择 PDF（至少2个）';
    }
    if (this.isImagesTool()) {
      return '选择图片（可多选）';
    }
    return '选择 PDF';
  }

  /** 当前工具是否以图片为输入 */
  private isImageTool(): boolean {
    return this.tool ? toolInput(this.tool) === 'image' : false;
  }

  /** 当前工具是否需要 1 张以上图片（图片转 PDF） */
  private isImagesTool(): boolean {
    return this.tool ? toolInput(this.tool) === 'images' : false;
  }

  /** 当前工具是否需要「PDF + 图片」两段输入（图片签章） */
  private isStampTool(): boolean {
    return this.tool ? toolInput(this.tool) === 'pdfimage' : false;
  }

  /** 当前工具是否走交互式标注页（V1.3：手写签名 / 高亮标注） */
  private isAnnotTool(): boolean {
    return this.tool === 'sign' || this.tool === 'highlight';
  }

  /**
   * 通过系统选择器导入文件到沙箱，并取得其沙箱路径（供 Web 编辑器读取）。
   */
  private async pickFile(): Promise<void> {
    const ctx = AppContext.getContextOrNull();
    if (!ctx) {
      this.showTip('应用上下文未就绪');
      return;
    }
    const isMulti: boolean = this.tool ? toolInput(this.tool) === 'multiple' : false;
    const isImages: boolean = this.isImagesTool();
    const stage2: boolean = this.pickStage === 2;
    const kind: 'pdf' | 'image' = (stage2 || this.isImageTool() || isImages) ? 'image' : 'pdf';
    try {
      const res = await FileService.importFromPicker(ctx, kind);
      const added: string[] = res.imported.length > 0 ? res.imported : res.skippedPaths;
      if (added.length === 0) {
        if (res.skipped > 0) {
          this.showTip('该文件已导入');
        } else {
          this.showTip('未选择文件');
        }
        return;
      }
      if (stage2) {
        // 图片签章第二阶段：拿到图片后加载 Web 编辑器
        this.imagePath = added[0];
        this.pickStage = 0;
        return;
      }
      if (isImages) {
        // 图片转 PDF：累积所选图片（支持多选），至少 1 张即可合成
        for (const p of added) {
          if (!this.imagePaths.includes(p)) {
            this.imagePaths.push(p);
          }
        }
        this.fileName = this.imagePaths.length > 0
          ? (this.imagePaths[0].split('/').pop() || '图片')
          : '图片';
        this.pickStage = 0;
        return;
      }
      if (isMulti) {
        // 多文件工具：累积选择，达到 2 个再加载编辑器
        for (const p of added) {
          if (!this.filePaths.includes(p)) {
            this.filePaths.push(p);
          }
        }
        if (this.filePaths.length >= 2) {
          this.fileName = this.filePaths[0].split('/').pop() || '文档';
          this.pickStage = 0;
        } else {
          this.showTip(`已选 ${this.filePaths.length} 个，再选 1 个`);
        }
      } else {
        this.filePath = added[0];
        this.fileName = this.filePath.split('/').pop() || '文档';
        // 图片签章还需第二阶段选图片
        this.pickStage = this.isStampTool() ? 2 : 0;
      }
    } catch (e) {
      Logger.error(TAG, `pick failed: ${(e as Error).message}`);
      this.showTip('选择文件失败');
    }
  }

  private showTip(msg: string): void {
    try {
      this.getUIContext().getPromptAction().showToast({ message: msg, duration: 1800 });
    } catch (e) {
      Logger.warn(TAG, `toast failed: ${(e as Error).message}`);
    }
  }
}
