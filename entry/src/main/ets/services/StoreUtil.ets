import { preferences } from '@kit.ArkData';
import { common } from '@kit.AbilityKit';
import { Logger } from '../utils/Logger';

/**
 * 最近打开 / 收藏夹 / 阅读进度 的本地持久化存储
 *
 * 基于 @ohos.data.preferences（@kit.ArkData），使用同步 API 简化调用。
 * 必须在 UI 侧取得 UIAbilityContext 后调用 init()。
 */
export interface RecentItem {
  path: string;
  name: string;
  time: number;
}

export class StoreUtil {
  private static pref: preferences.Preferences | null = null;
  private static readonly STORE_NAME: string = 'pdf_tool_store';
  private static readonly KEY_RECENTS: string = 'recents';
  private static readonly KEY_FAVORITES: string = 'favorites';
  private static readonly KEY_PROGRESS: string = 'progress';

  static init(context: common.UIAbilityContext): void {
    try {
      StoreUtil.pref = preferences.getPreferencesSync(context, { name: StoreUtil.STORE_NAME });
      Logger.info('StoreUtil', 'Preferences initialized');
    } catch (e) {
      Logger.error('StoreUtil', `init failed: ${(e as Error).message}`);
    }
  }

  private static ensure(): preferences.Preferences {
    if (!StoreUtil.pref) {
      throw new Error('StoreUtil not initialized. Call init(context) first.');
    }
    return StoreUtil.pref;
  }

  // ============ 最近打开 ============

  static saveRecent(path: string, name: string): void {
    const p = StoreUtil.ensure();
    let list: RecentItem[] = StoreUtil.getRecents();
    list = list.filter((i: RecentItem): boolean => i.path !== path);
    list.unshift({ path, name, time: Date.now() });
    if (list.length > 20) {
      list = list.slice(0, 20);
    }
    p.putSync(StoreUtil.KEY_RECENTS, JSON.stringify(list));
    p.flushSync();
  }

  static getRecents(): RecentItem[] {
    const p = StoreUtil.ensure();
    const raw = p.getSync(StoreUtil.KEY_RECENTS, '[]') as string;
    try {
      return JSON.parse(raw) as RecentItem[] || [];
    } catch (e) {
      return [];
    }
  }

  // ============ 收藏夹 ============

  static toggleFavorite(path: string): boolean {
    const p = StoreUtil.ensure();
    let favs: string[] = StoreUtil.getFavorites();
    if (favs.includes(path)) {
      favs = favs.filter((x: string): boolean => x !== path);
    } else {
      favs.push(path);
    }
    p.putSync(StoreUtil.KEY_FAVORITES, JSON.stringify(favs));
    p.flushSync();
    return favs.includes(path);
  }

  static isFavorite(path: string): boolean {
    return StoreUtil.getFavorites().includes(path);
  }

  static getFavorites(): string[] {
    const p = StoreUtil.ensure();
    const raw = p.getSync(StoreUtil.KEY_FAVORITES, '[]') as string;
    try {
      return JSON.parse(raw) as string[] || [];
    } catch (e) {
      return [];
    }
  }

  // ============ 阅读进度（路径 -> 页码）============

  static saveProgress(path: string, page: number): void {
    const p = StoreUtil.ensure();
    const map: Record<string, number> = StoreUtil.getAllProgress();
    map[path] = page;
    p.putSync(StoreUtil.KEY_PROGRESS, JSON.stringify(map));
    p.flushSync();
  }

  static getProgress(path: string): number {
    return StoreUtil.getAllProgress()[path] || 1;
  }

  static getAllProgress(): Record<string, number> {
    const p = StoreUtil.ensure();
    const raw = p.getSync(StoreUtil.KEY_PROGRESS, '{}') as string;
    try {
      return JSON.parse(raw) as Record<string, number> || {};
    } catch (e) {
      return {};
    }
  }
}
