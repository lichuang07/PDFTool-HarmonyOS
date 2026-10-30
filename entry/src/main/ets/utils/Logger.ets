import { hilog } from '@kit.PerformanceAnalysisKit';

const DOMAIN = 0x9501;

/**
 * 日志工具类
 */
export class Logger {
  static debug(tag: string, msg: string): void {
    hilog.debug(DOMAIN, tag, `%{public}s`, msg);
  }

  static info(tag: string, msg: string): void {
    hilog.info(DOMAIN, tag, `%{public}s`, msg);
  }

  static warn(tag: string, msg: string): void {
    hilog.warn(DOMAIN, tag, `%{public}s`, msg);
  }

  static error(tag: string, msg: string): void {
    hilog.error(DOMAIN, tag, `%{public}s`, msg);
  }
}
