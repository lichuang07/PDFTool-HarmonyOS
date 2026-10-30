/**
 * 全局常量定义
 */
export class Constants {
  // 应用信息
  static readonly APP_NAME = 'PDF工具';
  static readonly APP_VERSION = 'V1.3';

  // 沙箱目录名（与 web 侧 editor.js 的输出目录保持一致）
  static readonly PDF_DIR_NAME = 'pdfs';
  static readonly THUMB_DIR_NAME = 'thumbs';
  static readonly TESSDATA_DIR_NAME = 'tessdata';
  static readonly FONTS_DIR_NAME = 'fonts';

  // 文件大小阈值
  static readonly LARGE_FILE_THRESHOLD = 20 * 1024 * 1024;  // 20MB
  static readonly MAX_OPEN_DOCS = 3;

  // 日志 TAG
  static readonly TAG_BRIDGE = 'PdfBridge';
  static readonly TAG_VERIFY = 'TechVerify';
  static readonly TAG_FILE = 'FileService';
  static readonly TAG_READER = 'Reader';

  // 阅读器参数
  static readonly DEFAULT_SCALE: number = 1.0;
  static readonly SCALE_STEP: number = 0.2;
  static readonly MIN_SCALE: number = 0.5;
  static readonly MAX_SCALE: number = 5.0;
  static readonly RECENT_LIMIT: number = 20;

  // 验证项数量
  static readonly VERIFY_ITEM_COUNT = 20;

  // Web 资源路径
  static readonly WEB_INDEX = 'web/index.html';

  // 验证状态
  static readonly VERIFY_PENDING = 'pending';
  static readonly VERIFY_RUNNING = 'running';
  static readonly VERIFY_PASSED = 'passed';
  static readonly VERIFY_FAILED = 'failed';
}
