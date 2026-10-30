import { common } from '@kit.AbilityKit';

/**
 * 全局 UIAbilityContext 持有者（单例）。
 *
 * 问题背景：
 *   ArkTS 自定义组件在 aboutToAppear 阶段通过
 *   `this.getUIContext().getHostContext()` 取到的宿主上下文可能为 undefined
 *   （页面尚未完全挂载到窗口），直接读取 `context.filesDir` 会抛出
 *   `Cannot read property filesDir of undefined` 导致应用崩溃。
 *
 * 解决方案：
 *   在 EntryAbility.onCreate（UIAbilityContext 一定可用的时机）把上下文存入本单例，
 *   全应用任何页面/服务均通过 AppContext 取用，规避生命周期时序问题。
 */
export class AppContext {
  private static ctx: common.UIAbilityContext | null = null;

  /**
   * 在 EntryAbility.onCreate 中调用一次，注入 UIAbilityContext。
   */
  static setContext(context: common.UIAbilityContext): void {
    AppContext.ctx = context;
  }

  /**
   * 取上下文。若尚未初始化直接抛错，便于尽早暴露配置问题。
   */
  static getContext(): common.UIAbilityContext {
    if (!AppContext.ctx) {
      throw new Error('AppContext is not initialized. Call setContext() in EntryAbility.onCreate.');
    }
    return AppContext.ctx;
  }

  /**
   * 安全取上下文：未初始化时返回 null，调用方自行兜底，避免 aboutToAppear 等
   * 早期时机直接崩溃。
   */
  static getContextOrNull(): common.UIAbilityContext | null {
    return AppContext.ctx;
  }
}
