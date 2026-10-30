import { fileIo as fs } from '@kit.CoreFileKit';
import { picker } from '@kit.CoreFileKit';
import { common } from '@kit.AbilityKit';
import { Logger } from '../utils/Logger';
import { Constants } from '../utils/Constants';

/**
 * PDF 文件元信息
 */
export interface PdfFileInfo {
  name: string;
  path: string;
  size: number;
  lastModified: number;
}

/**
 * 导入结果
 */
export interface ImportResult {
  imported: string[];
  skipped: number;
  skippedPaths: string[];
}

/**
 * 文件管理服务
 *
 * 负责沙箱内 PDF 文件的扫描、导入、删除、重命名、搜索与分类。
 * 所有操作限定在应用沙箱 filesDir/pdf 目录下，避免越权访问系统文件。
 */
export class FileService {
  private static readonly TAG: string = Constants.TAG_FILE;

  /**
   * 取得沙箱 PDF 目录（自动创建）
   */
  static getPdfDir(context: common.Context): string {
    const dir: string = `${context.filesDir}/${Constants.PDF_DIR_NAME}`;
    try {
      if (!fs.accessSync(dir)) {
        fs.mkdirSync(dir, true);
      }
    } catch (e) {
      Logger.error(FileService.TAG, `getPdfDir create failed: ${(e as Error).message}`);
    }
    return dir;
  }

  /**
   * 取得沙箱图片目录（自动创建，供图片类工具使用）
   */
  static getImageDir(context: common.Context): string {
    const dir: string = `${context.filesDir}/images`;
    try {
      if (!fs.accessSync(dir)) {
        fs.mkdirSync(dir, true);
      }
    } catch (e) {
      Logger.error(FileService.TAG, `getImageDir create failed: ${(e as Error).message}`);
    }
    return dir;
  }

  /**
   * 列出沙箱内全部 PDF 文件
   */
  static listPdfs(context: common.Context): PdfFileInfo[] {
    const dir: string = FileService.getPdfDir(context);
    let names: string[] = [];
    try {
      names = fs.listFileSync(dir);
    } catch (e) {
      Logger.error(FileService.TAG, `listPdfs failed: ${(e as Error).message}`);
      return [];
    }
    const result: PdfFileInfo[] = [];
    for (const name of names) {
      if (!name.toLowerCase().endsWith('.pdf')) {
        continue;
      }
      const path: string = `${dir}/${name}`;
      try {
        const stat = fs.statSync(path);
          if (stat.isDirectory()) {
            continue;
          }
        result.push({
          name: name,
          path: path,
          size: stat.size,
          lastModified: stat.mtime
        });
      } catch (e) {
        Logger.warn(FileService.TAG, `skip ${name}: ${(e as Error).message}`);
      }
    }
    // 默认按修改时间倒序
    result.sort((a: PdfFileInfo, b: PdfFileInfo): number => b.lastModified - a.lastModified);
    return result;
  }

  /**
   * 通过系统文件选择器导入文件到沙箱
   * @param kind 'pdf'（默认）导入 PDF 到 pdfs/；'image' 导入图片到 images/（供图片类工具使用）
   * @returns ImportResult：新导入路径、跳过（重复）数量、被跳过的已有副本路径
   */
  static async importFromPicker(context: common.UIAbilityContext, kind: 'pdf' | 'image' = 'pdf'): Promise<ImportResult> {
    const isImage: boolean = kind === 'image';
    const filters: string[] = isImage ? ['.png', '.jpg', '.jpeg', '.webp', '.bmp'] : ['.pdf'];
    let picked: string[];
    try {
      picked = await new picker.DocumentViewPicker(context).select({
        maxSelectNumber: 20,
        fileSuffixFilters: filters
      });
    } catch (e) {
      const msg: string = (e as Error).message || '';
      // 用户取消选择时，系统选择器会以异常形式 reject；不视为导入失败，避免误报
      if (FileService.isPickerCancel(msg)) {
        Logger.info(FileService.TAG, 'import canceled by user');
        return { imported: [], skipped: 0, skippedPaths: [] };
      }
      // 真实异常：记录详情便于排查（如模拟器缺少文件管理器、选择器拉起失败等）
      Logger.error(FileService.TAG, `picker select failed: ${msg}`);
      throw new Error(`文件选择器打开失败：${msg}`);
    }

    if (!picked || picked.length === 0) {
      return { imported: [], skipped: 0, skippedPaths: [] };
    }

    const dir: string = isImage ? FileService.getImageDir(context) : FileService.getPdfDir(context);
    const imported: string[] = [];
    const errors: string[] = [];
    const skippedPaths: string[] = [];
    let skipped: number = 0;
    for (const uri of picked) {
      try {
        const fileName: string = FileService.extractNameFromUri(uri, isImage ? '.png' : '.pdf');
        const existing: string = `${dir}/${fileName}`;
        // 同名且内容一致：视为重复导入，跳过以免产生 (1)(2)(3) 副本
        if (fs.accessSync(existing) && FileService.isSameContent(uri, existing)) {
          Logger.info(FileService.TAG, `skip duplicate import: ${fileName}`);
          skipped++;
          skippedPaths.push(existing);
          continue;
        }
        const safeName: string = FileService.ensureUniqueName(dir, fileName);
        const dest: string = `${dir}/${safeName}`;
        FileService.copyUriToSandbox(uri, dest);
        imported.push(dest);
        Logger.info(FileService.TAG, `imported ${uri} -> ${dest}`);
      } catch (e) {
        const em: string = (e as Error).message || String(e);
        errors.push(em);
        Logger.error(FileService.TAG, `import ${uri} failed: ${em}`);
      }
    }

    // 选中了文件却全部复制失败：把首个真实错误抛到外层，让 UI 提示出真实原因
    if (imported.length === 0 && skipped === 0 && errors.length > 0) {
      throw new Error(`文件复制失败：${errors[0]}`);
    }
    return { imported, skipped, skippedPaths };
  }

  /**
   * 判断选择器异常是否为「用户取消」
   */
  private static isPickerCancel(msg: string): boolean {
    const lower: string = msg.toLowerCase();
    return (
      lower.includes('cancel') ||
      msg.includes('取消') ||
      lower.includes('operation canceled') ||
      lower.includes('user cancel')
    );
  }

  /**
   * 从选择器 URI 提取文件名（去除查询参数，兼容 file:// 与 datashare://）
   */
  private static extractNameFromUri(uri: string, fallbackExt: string = '.pdf'): string {
    let name: string = uri;
    const qIdx: number = name.indexOf('?');
    if (qIdx >= 0) {
      name = name.substring(0, qIdx);
    }
    const lastSlash: number = name.lastIndexOf('/');
    if (lastSlash >= 0) {
      name = name.substring(lastSlash + 1);
    }
    // 选择返回的 URI 中，中文/特殊字符多为百分号编码（如 %E6%B5%8B.pdf）。
    // 仅对文件名段解码，避免误伤目录分隔符；编码序列非法时（如裸 '%'）保留原值。
    try {
      name = decodeURIComponent(name);
    } catch (e) {
      Logger.warn(FileService.TAG, `extractName decode skipped: ${(e as Error).message}`);
    }
    if (name.length === 0 || name === 'file:') {
      name = `imported_${Date.now()}${fallbackExt}`;
    }
    return name;
  }

  /**
   * 将选择器返回的 URI 复制到应用沙箱
   *
   * 采用 fd 复制（fs.open + fs.copyFile + fs.close），兼容 file:// 与
   * datashare:// 临时 URI，规避 fs.copy(uri, dest) 字符串直复制在跨沙箱
   * 场景下失败的问题。
   */
  private static copyUriToSandbox(uri: string, dest: string): void {
    const src: fs.File = fs.openSync(uri, fs.OpenMode.READ_ONLY);
    try {
      const out: fs.File = fs.openSync(dest, fs.OpenMode.CREATE | fs.OpenMode.WRITE_ONLY | fs.OpenMode.TRUNC);
      try {
        fs.copyFileSync(src.fd, out.fd);
      } finally {
        fs.closeSync(out);
      }
    } finally {
      fs.closeSync(src);
    }
  }

  /**
   * 判断源 URI 与目标文件是否为同一份内容（先比大小，再分块逐字节比对）。
   * 用于导入时去重：同名且内容一致则跳过，避免产生 (1)(2)(3) 副本。
   */
  private static isSameContent(srcUri: string, destPath: string): boolean {
    let src: fs.File | null = null;
    let dst: fs.File | null = null;
    try {
      const srcStat = fs.statSync(srcUri);
      const dstStat = fs.statSync(destPath);
      if (srcStat.size !== dstStat.size) {
        return false;
      }
      if (srcStat.size === 0) {
        return true;
      }
      src = fs.openSync(srcUri, fs.OpenMode.READ_ONLY);
      dst = fs.openSync(destPath, fs.OpenMode.READ_ONLY);
      const bufSize: number = 64 * 1024;
      const srcBuf: ArrayBuffer = new ArrayBuffer(bufSize);
      const dstBuf: ArrayBuffer = new ArrayBuffer(bufSize);
      let remaining: number = srcStat.size;
      while (remaining > 0) {
        const toRead: number = Math.min(bufSize, remaining);
        // 该 SDK 的 readSync 直接返回已读字节数（number），且文件描述符自动顺序偏移
        const sLen: number = fs.readSync(src.fd, srcBuf, { offset: 0, length: toRead });
        const dLen: number = fs.readSync(dst.fd, dstBuf, { offset: 0, length: toRead });
        if (sLen === 0 || dLen === 0 || sLen !== dLen) {
          return false;
        }
        const s8: Uint8Array = new Uint8Array(srcBuf, 0, sLen);
        const d8: Uint8Array = new Uint8Array(dstBuf, 0, dLen);
        for (let i: number = 0; i < sLen; i++) {
          if (s8[i] !== d8[i]) {
            return false;
          }
        }
        remaining -= sLen;
      }
      return true;
    } catch (e) {
      Logger.warn(FileService.TAG, `isSameContent failed: ${(e as Error).message}`);
      return false;
    } finally {
      if (src) {
        try { fs.closeSync(src); } catch (e) { /* ignore */ }
      }
      if (dst) {
        try { fs.closeSync(dst); } catch (e) { /* ignore */ }
      }
    }
  }

  /**
   * 导入外部分享的文件（datashare/file URI）到沙箱 PDF 目录
   * 用于「系统分享 → 图文匣」链路：EntryAbility 收到 sendData 后写入
   * AppStorage.sharedFilePath，FileList 启动时消费并调用本方法落盘。
   * @returns 沙箱内路径，失败返回 null
   */
  static importSharedUri(context: common.UIAbilityContext, uri: string): string | null {
    try {
      const dir: string = FileService.getPdfDir(context);
      const name: string = FileService.ensureUniqueName(dir, FileService.extractNameFromUri(uri, '.pdf'));
      const dest: string = `${dir}/${name}`;
      FileService.copyUriToSandbox(uri, dest);
      Logger.info(FileService.TAG, `importSharedUri ${uri} -> ${dest}`);
      return dest;
    } catch (e) {
      Logger.error(FileService.TAG, `importSharedUri failed: ${(e as Error).message}`);
      return null;
    }
  }

  /**
   * 确保目标文件名在目录内不重名（重名则追加 (n)）
   */
  private static ensureUniqueName(dir: string, name: string): string {
    if (!fs.accessSync(`${dir}/${name}`)) {
      return name;
    }
    const dotIdx: number = name.lastIndexOf('.');
    const base: string = dotIdx > 0 ? name.substring(0, dotIdx) : name;
    const ext: string = dotIdx > 0 ? name.substring(dotIdx) : '';
    let n: number = 1;
    while (fs.accessSync(`${dir}/${base} (${n})${ext}`)) {
      n++;
    }
    return `${base} (${n})${ext}`;
  }

  /**
   * 移除文件（删除沙箱内的副本，不影响用户原始源文件）
   */
  static deletePdf(path: string): boolean {
    try {
      fs.unlinkSync(path);
      return true;
    } catch (e) {
      Logger.error(FileService.TAG, `delete ${path} failed: ${(e as Error).message}`);
      return false;
    }
  }

  /**
   * 重命名文件（自动追加扩展名并检查冲突）
   */
  static renamePdf(oldPath: string, newBaseName: string): string | null {
    try {
      const dir: string = oldPath.substring(0, oldPath.lastIndexOf('/'));
      const oldName: string = oldPath.substring(oldPath.lastIndexOf('/') + 1);
      const ext: string = oldName.toLowerCase().endsWith('.pdf') ? '.pdf' : '';
      let newName: string = newBaseName.endsWith('.pdf') ? newBaseName : `${newBaseName}${ext}`;
      newName = FileService.ensureUniqueName(dir, newName);
      const newPath: string = `${dir}/${newName}`;
      fs.renameSync(oldPath, newPath);
      return newPath;
    } catch (e) {
      Logger.error(FileService.TAG, `rename ${oldPath} failed: ${(e as Error).message}`);
      return null;
    }
  }

  /**
   * 按关键词检索文件名（不区分大小写）
   */
  static searchPdfs(context: common.Context, keyword: string): PdfFileInfo[] {
    if (!keyword || keyword.trim().length === 0) {
      return FileService.listPdfs(context);
    }
    const kw: string = keyword.trim().toLowerCase();
    return FileService.listPdfs(context).filter((f: PdfFileInfo): boolean => f.name.toLowerCase().includes(kw));
  }

  /**
   * 按模式排序：name / size / time
   * @param asc 是否升序；默认 false（名称：Z→A / 大小：大→小 / 时间：新→旧）
   */
  static sortPdfs(list: PdfFileInfo[], mode: 'name' | 'size' | 'time', asc: boolean = false): PdfFileInfo[] {
    const copy: PdfFileInfo[] = list.slice();
    switch (mode) {
      case 'name':
        copy.sort((a: PdfFileInfo, b: PdfFileInfo): number => a.name.localeCompare(b.name, 'zh'));
        break;
      case 'size':
        copy.sort((a: PdfFileInfo, b: PdfFileInfo): number => a.size - b.size);
        break;
      case 'time':
      default:
        copy.sort((a: PdfFileInfo, b: PdfFileInfo): number => a.lastModified - b.lastModified);
        break;
    }
    // 自然序为：名称 A→Z / 大小 小→大 / 时间 旧→新；asc=false 时整体翻转成倒序
    if (!asc) {
      copy.reverse();
    }
    return copy;
  }
}
