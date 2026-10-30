import { UIAbility, AbilityConstant, Want } from '@kit.AbilityKit';
import { webview } from '@kit.ArkWeb';
import { window } from '@kit.ArkUI';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import { Constants } from '../utils/Constants';
import { StoreUtil } from '../services/StoreUtil';
import { AppContext } from '../utils/AppContext';

const DOMAIN = 0x9501;
const TAG = 'EntryAbility';

/**
 * APP 入口 Ability
 * - 预加载 Web 引擎（冷启动优化）
 * - 接收外部分享的 PDF 文件
 */
export default class EntryAbility extends UIAbility {

  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    // 注入全局 UIAbilityContext 单例（必须在任何页面 aboutToAppear 之前完成）
    AppContext.setContext(this.context);

    // 预加载 Web 引擎动态库，减少首次打开 Web 组件的延迟
    try {
      webview.WebviewController.initializeWebEngine();
      hilog.info(DOMAIN, TAG, 'Web engine preloaded');
    } catch (e) {
      hilog.error(DOMAIN, TAG, `Failed to preload web engine: ${(e as Error).message}`);
    }

    // 处理外部传入的 PDF 文件
    if (want.action === 'ohos.want.action.sendData') {
      const uri = want.parameters?.uri as string;
      if (uri) {
        hilog.info(DOMAIN, TAG, `Received shared file: ${uri}`);
        AppStorage.setOrCreate('sharedFilePath', uri);
      }
    }
    // 初始化本地偏好存储（最近打开 / 收藏 / 阅读进度）
    StoreUtil.init(this.context);

    // 首次启动自动将内置示例 PDF 拷贝到沙箱，便于 M0 文件管理/渲染验证
    this.ensureSamplePdf().catch((e: Error) => {
      hilog.error(DOMAIN, TAG, `ensureSamplePdf failed: ${e.message}`);
    });
  }

  onNewWant(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    // 接收新的分享文件
    if (want.action === 'ohos.want.action.sendData') {
      const uri = want.parameters?.uri as string;
      if (uri) {
        hilog.info(DOMAIN, TAG, `Received new shared file: ${uri}`);
        AppStorage.setOrCreate('sharedFilePath', uri);
      }
    }
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    windowStage.loadContent('pages/FileList', (err) => {
      if (err.code) {
        hilog.error(DOMAIN, TAG, `Failed to load content: ${JSON.stringify(err)}`);
        return;
      }
      hilog.info(DOMAIN, TAG, 'Content loaded successfully');
    });
  }

  onDestroy(): void {
    hilog.info(DOMAIN, TAG, 'EntryAbility destroyed');
  }

  /**
   * 首次启动将内置示例 PDF（rawfile/sample.pdf）拷贝到应用沙箱 filesDir，
   * 使文件管理 / PDF 渲染等 M0 验证项无需手动传文件即可运行。
   */
  private async ensureSamplePdf(): Promise<void> {
    const sampleName: string = 'sample.pdf';
    const pdfDir: string = `${this.context.filesDir}/${Constants.PDF_DIR_NAME}`;
    const target: string = `${pdfDir}/${sampleName}`;
    try {
      if (!fs.accessSync(pdfDir)) {
        fs.mkdirSync(pdfDir, true);
      }
    } catch (e) {
      hilog.error(DOMAIN, TAG, `Failed to create pdfs dir: ${(e as Error).message}`);
    }
    let exists: boolean = false;
    try {
      exists = fs.accessSync(target);
    } catch (e) {
      exists = false;
    }
    if (exists) {
      return;
    }
    try {
      const data: Uint8Array = await this.context.resourceManager.getRawFileContent(sampleName);
      hilog.info(DOMAIN, TAG, `Raw sample loaded, size=${data.length}, buffer=${data.byteLength}`);
      const file = fs.openSync(target, fs.OpenMode.CREATE | fs.OpenMode.WRITE_ONLY);
      // 必须切出精确 ArrayBuffer；data.buffer 可能指向更大的共享缓冲区
      const exactBuffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      fs.writeSync(file.fd, exactBuffer);
      fs.closeSync(file);
      const stat = fs.statSync(target);
      hilog.info(DOMAIN, TAG, `Sample PDF copied to ${target}, written=${stat.size}`);
    } catch (e) {
      hilog.error(DOMAIN, TAG, `Failed to copy sample PDF: ${(e as Error).message}`);
    }
  }
}
