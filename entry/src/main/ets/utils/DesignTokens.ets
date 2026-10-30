/**
 * 设计 Token（Design Tokens）—— 全局 UI 规范（V1.1 重设计）
 *
 * 集中管理配色、圆角、阴影、间距，保证首页(FileList)与阅读器(Reader)视觉一致。
 * 颜色取自 ui-design-system：主色 + 中性灰阶 + 语义色；圆角遵循 8pt 栅格；
 * 阴影为柔和多层投影，用于卡片抬升；按钮/可点元素触控尺寸 ≥ 44vp。
 */
export class DT {
  // —— 品牌主色（现代蓝）——
  static readonly primary = '#2F6BFF';
  static readonly primaryPressed = '#1F57E0';
  static readonly primarySoft = '#EAF1FF'; // 主色浅底（ghost/pill 按钮）

  // —— 中性色阶 ——
  static readonly textPrimary = '#1A1A1A';
  static readonly textSecondary = '#6B7280';
  static readonly textTertiary = '#9CA3AF';
  static readonly bgPage = '#F5F6F8'; // 页面底色
  static readonly bgCard = '#FFFFFF'; // 卡片底色
  static readonly bgSoft = '#F1F3F5'; // 输入框/未选中底
  static readonly border = '#ECEEF1'; // 1px 分隔/描边

  // —— 语义色 ——
  static readonly danger = '#F5222D';
  static readonly dangerSoft = '#FFECEC';
  static readonly success = '#16A34A';
  static readonly warning = '#F59E0B';

  // —— 圆角（8pt 栅格）——
  static readonly rSm = 8;
  static readonly rMd = 12;
  static readonly rLg = 16;
  static readonly rXl = 22;

  // —— 阴影（柔和多层投影）——
  static readonly shadowCard: ShadowOptions = {
    radius: 12,
    color: '#1A1A1A12',
    offsetX: 0,
    offsetY: 4
  };
  static readonly shadowRaised: ShadowOptions = {
    radius: 18,
    color: '#1A1A1A1A',
    offsetX: 0,
    offsetY: 8
  };
  static readonly shadowBar: ShadowOptions = {
    radius: 16,
    color: '#1A1A1A14',
    offsetX: 0,
    offsetY: -4
  };
}
