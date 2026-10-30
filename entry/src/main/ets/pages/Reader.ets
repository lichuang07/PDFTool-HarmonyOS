import { webview } from '@kit.ArkWeb';
import { router } from '@kit.ArkUI';
import { common } from '@kit.AbilityKit';
import { fileUri, fileIo as fs, picker } from '@kit.CoreFileKit';
import { systemShare } from '@kit.ShareKit';
import { uniformTypeDescriptor as utd } from '@kit.ArkData';
import { BusinessError } from '@kit.BasicServicesKit';
import { PdfBridge } from '../bridge/PdfBridge';
import { StoreUtil } from '../services/StoreUtil';
import { Constants } from '../utils/Constants';
import { Logger } from '../utils/Logger';
import { AppContext } from '../utils/AppContext';
import { ToolItem, ToolCategory, TOOL_CATEGORIES } from '../utils/PdfTools';
import { DT } from '../utils/DesignTokens';

const TAG = Constants.TAG_READER;

interface ReaderPageInfo {
  path: string;
  page: number;
  total: number;
}

/**
 * PDF 阅读器宿主页（V1.0 MVP）
 *
 * ArkTS 侧仅负责：
 * - 加载 Web 阅读器（reader.html / reader.js，承载 pdf.js）
 * - 注入 PdfBridge 桥接
 * - 顶部栏：返回 / 文件名 / 编辑 / 分享 / 另存为
 * - 「编辑」弹出工具选择模态框，基于当前已打开文件直接进入对应工具（pages/EditorPage，带 filePath/tool）
 * - 接收 Web 上报的阅读页码，持久化进度
 */
@Entry
@Component
struct Reader {
  @State filePath: string = '';
  @State fileName: string = '';
  @State pageLabel: string = '';
  @State loading: boolean = true;
  @State editSheetVisible: boolean = false; // 阅读器内「编辑」工具选择模态框
  private controller: webview.WebviewController = new webview.WebviewController();
  private bridge: PdfBridge | null = null;
  @StorageLink('readerCurrentPage') @Watch('onPageInfoChange') pageInfo: ReaderPageInfo = { path: '', page: 1, total: 0 };

  private get context(): common.UIAbilityContext {
    return AppContext.getContext();
  }

  aboutToAppear(): void {
    const params = router.getParams() as Record<string, Object>;
    if (params) {
      this.filePath = (params['filePath'] as string) || '';
      this.fileName = (params['fileName'] as string) || this.filePath.split('/').pop() || '文档';
    }
    this.bridge = new PdfBridge(this.controller, this.context, this.getUIContext());
    // 打开时恢复上次阅读进度（供 Web 初始化定位）。
    // 必须每次重置：不重置时 AppStorage 会残留上一个文件的页码，
    // 打开无进度的新文件会被错误定位到旧页码。
    if (this.filePath) {
      const saved = StoreUtil.getProgress(this.filePath);
      AppStorage.setOrCreate('readerInitialPage', saved > 1 ? saved : 1);
    }
  }

  aboutToDisappear(): void {
    // 离开阅读器时显式保存当前页码，兜底进度落盘
    if (this.filePath && this.pageInfo && this.pageInfo.path === this.filePath && this.pageInfo.page > 0) {
      StoreUtil.saveProgress(this.filePath, this.pageInfo.page);
      Logger.info(TAG, `save progress on exit: ${this.filePath} -> page ${this.pageInfo.page}`);
    }
  }

  // Web 上报当前页码时持久化
  onPageChanged(page: number): void {
    if (this.filePath && page > 0) {
      StoreUtil.saveProgress(this.filePath, page);
    }
  }

  build() {
    Stack({ alignContent: Alignment.Bottom }) {
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
        .onClick(() => { this.goBack(); })

        Column() {
          Text(this.fileName)
            .fontSize(16)
            .fontWeight(FontWeight.Medium)
            .fontColor('#1a1a1a')
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
          if (this.pageLabel) {
            Text(this.pageLabel)
              .fontSize(11)
              .fontColor('#999')
          }
        }
        .layoutWeight(1)
        .alignItems(HorizontalAlign.Start)
        .margin({ left: 4, right: 4 })

        this.TopAction($r('app.media.ic_edit'), '编辑', () => { this.editSheetVisible = true; })
        this.TopAction($r('app.media.ic_share'), '分享', () => { this.shareFile(); })
        this.TopAction($r('app.media.ic_save'), '另存为', () => { this.saveAsFile(); })
      }
      .width('100%')
      .height(52)
      .padding({ left: 8, right: 12 })
      .backgroundColor('#ffffff')
      .border({ width: { bottom: 1 }, color: '#eeeeee' })

      // Web 阅读器
      Stack() {
        Web({ src: $rawfile('web/reader/reader.html'), controller: this.controller })
          .javaScriptAccess(true)
          .domStorageAccess(true)
          .fileAccess(true)
          .imageAccess(true)
          .width('100%')
          .height('100%')
          .onControllerAttached(() => {
            if (this.bridge) {
              this.controller.registerJavaScriptProxy(this.bridge, 'nativeBridge', [
                'readFile', 'writeFile', 'getFileInfo', 'getFilesDir', 'getCacheDir',
                'createDir', 'listFiles', 'deleteFile', 'renameFile', 'fileExists',
                'showToast', 'copyToClipboard', 'onReaderPage', 'closeReader',
                'reportPassword', 'getTimestamp', 'getDeviceInfo'
              ]);
              Logger.info(TAG, 'nativeBridge registered');
            }
          })
          .onPageEnd(() => {
            this.loading = false;
            // 将文件路径与初始页码传给 Web 阅读器
            const initPage = Number(AppStorage.get('readerInitialPage')) || 1;
            const script = `window.__PDF_PATH__=${JSON.stringify(this.filePath)};window.__INIT_PAGE__=${initPage};if(window.__onPathReady)window.__onPathReady();`;
            this.controller.runJavaScript(script).catch((e: Error) => {
              Logger.error(TAG, `runJavaScript failed: ${e.message}`);
            });
          })

        if (this.loading) {
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

      // 阅读器内「编辑」工具选择模态框（底部弹出）
      if (this.editSheetVisible) {
        this.EditSheet()
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#ffffff')
  }

  /** 顶部操作按钮（图标 + 文字，ghost 风格，带按压反馈） */
  @Builder
  TopAction(icon: Resource, label: string, onClick: () => void) {
    Row({ space: 4 }) {
      Image(icon)
        .width(18)
        .height(18)
        .fillColor(DT.primary)
      Text(label)
        .fontSize(13)
        .fontColor(DT.primary)
    }
    .padding({ left: 10, right: 10, top: 7, bottom: 7 })
    .backgroundColor('rgba(0,0,0,0)')
    .borderRadius(DT.rSm)
    .onClick(onClick)
  }

  /** 毛玻璃磁贴（与首页工具卡一致：半透明分类色 + 亚克力模糊 + 顶部白玻璃高光 + 白色图标块） */
  @Builder
  AcrylicToolCard(item: ToolItem, cat: ToolCategory) {
    Column() {
      Image(item.icon)
        .width(30)
        .height(30)
        .objectFit(ImageFit.Contain)
        .margin({ bottom: 8 })
      Text(item.name)
        .fontSize(13)
        .fontColor(DT.textPrimary)
        .fontWeight(FontWeight.Medium)
    }
    .width('100%')
    .height(92)
    .justifyContent(FlexAlign.Center)
    .backgroundColor(cat.tint)
    .borderRadius(12)
    .onClick(() => { this.openEditorWithTool(item.id); })
  }

  goBack(): void {
    router.back();
  }

  /**
   * 阅读器内编辑入口：基于当前已打开文件直接进入对应工具。
   * 由 EditSheet 中选中的工具触发；文件缺失时兜底提示。
   */
  openEditorWithTool(toolId: string): void {
    this.editSheetVisible = false;
    if (!this.filePath) {
      this.showTip('文件路径无效');
      return;
    }
    router.pushUrl({
      url: 'pages/EditorPage',
      // 若阅读器已用密码打开过该加密 PDF，把密码一并带过去，工具页不再二次弹窗
      params: {
        filePath: this.filePath,
        fileName: this.fileName,
        tool: toolId,
        password: this.bridge ? this.bridge.getPassword(this.filePath) : ''
      }
    }).catch((e: Error) => {
      Logger.error(TAG, `open editor ${this.fileName} failed: ${e.message}`);
      this.showTip('打开编辑器失败');
    });
  }

  /** 编辑工具选择模态框（底部弹出，按分类展示全部工具） */
  @Builder
  EditSheet() {
    // 遮罩（点击关闭）
    Column() {
    }
    .width('100%')
    .height('100%')
    .backgroundColor('rgba(0,0,0,0.45)')
    .onClick(() => { this.editSheetVisible = false; })

    // 底部面板
    Column() {
      Row() {
        Text('选择工具')
          .fontSize(17)
          .fontWeight(FontWeight.Bold)
          .fontColor('#1a1a1a')
        Blank()
        Text('✕')
          .fontSize(18)
          .fontColor('#999')
          .width(32)
          .height(32)
          .textAlign(TextAlign.Center)
          .onClick(() => { this.editSheetVisible = false; })
      }
      .width('100%')
      .padding({ left: 16, right: 12, top: 4, bottom: 8 })

      Text(this.fileName)
        .fontSize(12)
        .fontColor('#999')
        .alignSelf(ItemAlign.Start)
        .margin({ left: 16, bottom: 8 })

      Scroll() {
        Column() {
          ForEach(TOOL_CATEGORIES, (cat: ToolCategory) => {
            Column() {
              Row() {
                Text('')
                  .width(7)
                  .height(7)
                  .borderRadius(3.5)
                  .backgroundColor(cat.accent)
                  .margin({ right: 6 })
                Text(cat.title)
                  .fontSize(14)
                  .fontWeight(FontWeight.Medium)
                  .fontColor('#374151')
              }
              .width('100%')
              .margin({ left: 12, top: 8, bottom: 6 })

              Grid() {
                ForEach(cat.items, (item: ToolItem) => {
                  GridItem() {
                    this.AcrylicToolCard(item, cat)
                  }
                }, (item: ToolItem) => item.id)
              }
              .columnsTemplate('1fr 1fr 1fr 1fr')
              .rowsGap(10)
              .columnsGap(10)
              .width('100%')
              .padding({ left: 12, right: 12 })
            }
            .width('100%')
          }, (cat: ToolCategory) => cat.title)
        }
        .width('100%')
      }
      .layoutWeight(1)
      .width('100%')
    }
    .width('100%')
    .height('72%')
    .backgroundColor('#ffffff')
    .borderRadius({ topLeft: 16, topRight: 16 })
    .padding({ top: 12, bottom: 16 })
  }

  shareFile(): void {
    if (!this.filePath) {
      this.showTip('文件路径无效');
      return;
    }
    try {
      // 关键：沙箱 filesDir 内的文件直接分享时，接收方应用无权限访问，系统会报 Parameter error。
      // 官方最佳实践是把文件复制到应用 cacheDir（应用缓存目录，分享框架可临时授权给其他应用），再生成 URI。
      const fileName: string = this.filePath.split('/').pop() || 'document.pdf';
      const cachePath: string = `${this.context.cacheDir}/${fileName}`;
      fs.copyFileSync(this.filePath, cachePath);
      // 复制后的缓存文件 → 系统可访问的 file:// URI
      const uri: string = fileUri.getUriFromPath(cachePath);
      // PDF 在 UDMF 的标准 UTD 枚举（值 'com.adobe.pdf'，官方表格确认）。
      // 不要用 MIME 字符串、不要手写 'general.pdf'、也不要用 getUniformDataTypeByFilenameExtension
      // 返回的字符串直接赋给 utd 字段（类型不兼容且运行时易不被识别）。
      const pdfUtd: utd.UniformDataType = utd.UniformDataType.PDF;
      Logger.info(TAG, `share utd=${pdfUtd}, uri=${uri}`);
      const data: systemShare.SharedData = new systemShare.SharedData({
        utd: pdfUtd,
        uri: uri,
        title: this.fileName
      });
      const controller: systemShare.ShareController = new systemShare.ShareController(data);
      controller.show(this.context, {
        previewMode: systemShare.SharePreviewMode.DEFAULT,
        selectionMode: systemShare.SelectionMode.SINGLE
      })
        .then(() => {
          Logger.info(TAG, 'share panel shown');
        })
        .catch((e: BusinessError) => {
          Logger.error(TAG, `share failed: code=${e.code}, msg=${e.message}`);
          this.showTip(`分享失败(${e.code})：${e.message}`);
        });
    } catch (e) {
      Logger.error(TAG, `share error: ${(e as Error).message}`);
          this.showTip('分享失败');
    }
  }

  /**
   * 另存为：调起系统文件选择器让用户选定保存位置，把当前 PDF 复制落盘。
   * 不依赖 Share Kit，仅用文件选择器框架（模拟器/真机均可验证）。
   */
  async saveAsFile(): Promise<void> {
    if (!this.filePath) {
      this.showTip('文件路径无效');
      return;
    }
    try {
      // 文件名给定默认名（含 .pdf 后缀）；用户在保存对话框中仍可自行修改。
      const opts: picker.DocumentSaveOptions = new picker.DocumentSaveOptions();
      const safeName: string = (this.fileName || 'document').replace(/[\\/:*?"<>|]/g, '_');
      opts.newFileNames = [safeName.endsWith('.pdf') ? safeName : `${safeName}.pdf`];
      // DocumentViewPicker 必须传入 this.context：save() 返回的 URI 依赖 context 获取临时读写权限，
      // 缺 context 时文件会被框架创建、但写入静默失败（落盘 0 字节、内容为空）。
      const documentPicker: picker.DocumentViewPicker = new picker.DocumentViewPicker(this.context);
      const result: Array<string> = await documentPicker.save(opts);
      if (!result || result.length === 0) {
        return; // 用户取消
      }
      const dstUri: string = result[0];
      // 采用鸿蒙官方论坛验证可用的写法：源/目标都以 READ_WRITE|CREATE 打开，再用 copyFileSync(fd, fd)。
      // 关键教训：dst 不可用 WRITE_ONLY|CREATE|TRUNC（本 SDK 在 URI 目标上会残留框架创建的空壳）；
      //   也不可用自读自写（readSync+writeSync 多版实测均静默落空）。只有 READ_WRITE|CREATE + 直接
      //   copyFileSync(fd, fd) 才能把字节真正落到选择器 URI。
      const srcFile = fs.openSync(this.filePath, fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE);
      const dstFile = fs.openSync(dstUri, fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE);
      fs.copyFileSync(srcFile.fd, dstFile.fd);
      fs.closeSync(srcFile);
      fs.closeSync(dstFile);

      // 比对落盘大小与源大小，确认字节确实落盘
      const srcStat = fs.statSync(this.filePath);
      const dstStat = fs.statSync(dstUri);
      Logger.info(TAG, `saveAs done: ${dstUri}, srcSize=${srcStat.size}, dstSize=${dstStat.size}`);
      if (dstStat.size !== srcStat.size) {
        this.showTip(`保存异常：大小不符(落${dstStat.size}/源${srcStat.size})`);
      } else {
        this.showTip('已保存');
      }
    } catch (e) {
      const be = e as BusinessError;
      // 用户取消选择不提示失败
      if (be && (be.code === 801 || (be.message && be.message.toLowerCase().includes('cancel')))) {
        return;
      }
      Logger.error(TAG, `saveAs failed: ${(e as Error).message}`);
      this.showTip('保存失败');
    }
  }

  onPageInfoChange(): void {
    if (this.pageInfo.path === this.filePath) {
      const p = this.pageInfo.page;
      this.onPageChanged(p);
      const t = this.pageInfo.total;
      this.pageLabel = t > 0 ? `第 ${p} / ${t} 页` : `第 ${p} 页`;
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
