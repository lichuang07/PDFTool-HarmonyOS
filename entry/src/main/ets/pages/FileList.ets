/**
 * 首页：PDF 列表 + PDF 工具中心（V1.1）
 *
 * 底部双 Tab 导航：
 *  - 「列表」：沙箱 PDF 文件列表，点击进入阅读器；左滑「编辑」进入编辑器（带文件），
 *    右滑「移除」；长按重命名；支持搜索 / 排序 / 收藏。
 *  - 「工具」：按分类展示 13 个 PDF 工具，点击进入编辑器并携带 tool 参数，
 *    未选文件时由编辑器引导选文件。
 *
 * 工具定义与图标来自 utils/PdfTools，与阅读器「编辑」模态框共用同一数据源。
 * UI 视觉遵循 utils/DesignTokens 统一规范。
 */
import router from '@ohos.router';
import { FileService } from '../services/FileService';
import type { PdfFileInfo } from '../services/FileService';
import { StoreUtil } from '../services/StoreUtil';
import type { RecentItem } from '../services/StoreUtil';
import { Constants } from '../utils/Constants';
import { Logger } from '../utils/Logger';
import { AppContext } from '../utils/AppContext';
import { TOOL_CATEGORIES, toolInput } from '../utils/PdfTools';
import type { ToolItem, ToolCategory } from '../utils/PdfTools';
import { DT } from '../utils/DesignTokens';

const TAG = Constants.TAG_FILE;

@Entry
@Component
struct FileList {
  @State fileList: PdfFileInfo[] = [];
  @State keyword: string = '';
  @State tab: number = 0; // 0 全部 / 1 最近 / 2 收藏
  @State favorites: string[] = [];
  @State recents: RecentItem[] = [];
  @State displayList: PdfFileInfo[] = [];
  @State sortMode: 'name' | 'size' | 'time' = 'time';
  @State sortAsc: boolean = false;
  @State dialogVisible: boolean = false;
  @State pendingDelete: PdfFileInfo | null = null;
  @State renameVisible: boolean = false;
  @State pendingRename: PdfFileInfo | null = null;
  @State newName: string = '';
  @State bottomTab: number = 0; // 0 列表 / 1 工具
  @State toolSheetVisible: boolean = false; // 工具选 PDF 模态框
  @State pendingTool: string = ''; // 待执行的工具 id
  @State pendingToolName: string = ''; // 待执行工具名（展示用）
  @State selectedPaths: string[] = []; // 多选模式（如合并）已勾选的 PDF 路径
  @State toolMulti: boolean = false; // 当前待执行工具是否为多文件输入（如合并）

  aboutToAppear(): void {
    this.refresh();
    this.consumeSharedFile();
  }

  /**
   * 消费外部分享进来的 PDF：EntryAbility 收到系统分享（sendData）后写入
   * AppStorage.sharedFilePath，此处复制到沙箱并直接打开，使「分享 → 图文匣」链路可用。
   */
  private consumeSharedFile(): void {
    const ctx = AppContext.getContextOrNull();
    if (!ctx) {
      return;
    }
    const uri = AppStorage.get('sharedFilePath') as string | undefined;
    if (!uri) {
      return;
    }
    AppStorage.setOrCreate('sharedFilePath', ''); // 立即清除，避免重复消费
    const dest: string | null = FileService.importSharedUri(ctx, uri);
    if (!dest) {
      this.showTip('分享文件导入失败');
      return;
    }
    this.refresh();
    this.showTip('已导入分享的文件');
    const name: string = dest.split('/').pop() || '文档';
    this.openFile({ name: name, path: dest, size: 0, lastModified: Date.now() });
  }

  onPageShow(): void {
    this.refresh();
  }

  refresh(): void {
    const ctx = AppContext.getContextOrNull();
    if (!ctx) {
      Logger.warn(TAG, 'refresh: AppContext not ready, skip');
      return;
    }
    this.fileList = FileService.listPdfs(ctx);
    this.favorites = StoreUtil.getFavorites();
    this.recents = StoreUtil.getRecents();
    this.computeDisplayList();
    Logger.info(TAG, `refresh: ${this.fileList.length} files`);
  }

  private computeDisplayList(): void {
    let base: PdfFileInfo[];
    if (this.tab === 1) {
      // 最近：按 recents 顺序映射到现有文件
      const map: Map<string, PdfFileInfo> = new Map();
      this.fileList.forEach((f) => map.set(f.path, f));
      base = this.recents
        .map((r) => map.get(r.path))
        .filter((f) => f !== undefined) as PdfFileInfo[];
    } else if (this.tab === 2) {
      const favSet: Set<string> = new Set(this.favorites);
      base = this.fileList.filter((f) => favSet.has(f.path));
    } else {
      base = this.fileList;
    }
    if (this.keyword.trim().length > 0) {
      const kw: string = this.keyword.trim().toLowerCase();
      base = base.filter((f) => f.name.toLowerCase().includes(kw));
    }
    this.displayList = FileService.sortPdfs(base, this.sortMode, this.sortAsc);
  }

  formatSize(size: number): string {
    if (size < 1024) {
      return `${size} B`;
    } else if (size < 1024 * 1024) {
      return `${(size / 1024).toFixed(1)} KB`;
    } else {
      return `${(size / 1024 / 1024).toFixed(1)} MB`;
    }
  }

  formatDate(ts: number): string {
    const d = new Date(ts);
    const pad = (n: number): string => (n < 10 ? `0${n}` : `${n}`);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  openFile(f: PdfFileInfo): void {
    StoreUtil.saveRecent(f.path, f.name);
    router.pushUrl({
      url: 'pages/Reader',
      params: { filePath: f.path, fileName: f.name }
    }).catch((e: Error) => {
      Logger.error(TAG, `open ${f.name} failed: ${e.message}`);
    });
  }

  build() {
    Stack({ alignContent: Alignment.Center }) {
      // 底部导航容器：列表 / 工具
      Tabs({ barPosition: BarPosition.End }) {
        TabContent() {
          // 主内容（PDF列表）
          Column() {
            // 顶部标题 + 导入
            Row() {
              Row({ space: 10 }) {
                Stack() {
                  Image($r('app.media.ic_list'))
                    .width(18)
                    .height(18)
                    .fillColor('#FFFFFF')
                }
                .width(32)
                .height(32)
                .backgroundColor(DT.primary)
                .borderRadius(10)
                .alignContent(Alignment.Center)
                .shadow(DT.shadowCard)
                Text(Constants.APP_NAME)
                  .fontSize(20)
                  .fontWeight(FontWeight.Bold)
                  .fontColor(DT.textPrimary)
              }
              Blank()
              Button({ type: ButtonType.Normal }) {
                Row({ space: 4 }) {
                  Image($r('app.media.ic_plus'))
                    .width(16)
                    .height(16)
                    .fillColor(DT.primary)
                  Text('导入')
                    .fontSize(14)
                    .fontColor(DT.primary)
                }
              }
              .height(36)
              .padding({ left: 14, right: 14 })
              .backgroundColor(DT.primarySoft)
              .borderRadius(DT.rXl)
              .onClick(() => {
                const ctx = AppContext.getContextOrNull();
                if (!ctx) {
                  this.showTip('导入失败：应用上下文未就绪');
                  return;
                }
                FileService.importFromPicker(ctx)
                  .then((res) => {
                    if (res.imported.length > 0 || res.skipped > 0) {
                      this.refresh();
                      let msg: string = `已导入 ${res.imported.length} 个文件`;
                      if (res.skipped > 0) {
                        msg += `，跳过 ${res.skipped} 个重复`;
                      }
                      this.showTip(msg);
                    } else {
                      this.showTip('未选择文件');
                    }
                  })
                  .catch((e: Error) => {
                    Logger.error(TAG, `import failed: ${e.message}`);
                    const raw: string = e.message || '未知错误';
                    const msg: string = raw.length > 50 ? `${raw.substring(0, 50)}…` : raw;
                    this.showTip(`导入失败：${msg}`);
                  });
              })
            }
            .width('100%')
            .padding({ left: 16, right: 16, top: 14, bottom: 10 })

            // 搜索框（带图标）
            Row() {
              Image($r('app.media.ic_search'))
                .width(18)
                .height(18)
                .fillColor(DT.textTertiary)
                .margin({ left: 16, right: 8 })
              TextInput({ placeholder: '搜索文件名', text: this.keyword })
                .backgroundColor('rgba(0,0,0,0)')
                .layoutWeight(1)
                .height(40)
                .onChange((v: string) => {
                  this.keyword = v;
                  this.computeDisplayList();
                })
            }
            .width('100%')
            .height(44)
            .backgroundColor(DT.bgSoft)
            .borderRadius(DT.rXl)
            .margin({ left: 16, right: 16, bottom: 10 })

            // 分段选择器：全部 / 最近 / 收藏
            Row() {
              this.SegItem('全部', 0)
              this.SegItem('最近', 1)
              this.SegItem('收藏', 2)
            }
            .padding(3)
            .backgroundColor(DT.bgSoft)
            .borderRadius(DT.rMd)
            .alignSelf(ItemAlign.Start)
            .margin({ left: 16, right: 16, bottom: 8 })

            // 排序栏
            Row() {
              Text('排序')
                .fontSize(13)
                .fontColor(DT.textTertiary)
                .margin({ right: 6 })
              this.SortChip('名称', 'name')
              this.SortChip('大小', 'size')
              this.SortChip('时间', 'time')
              Blank()
              Row() {
                Image($r('app.media.ic_tools'))
                  .width(12)
                  .height(12)
                  .fillColor(DT.primary)
                  .margin({ right: 4 })
                Text(this.sortAsc ? '升序' : '降序')
                  .fontSize(13)
                  .fontColor(DT.primary)
              }
              .padding({ left: 10, right: 10, top: 5, bottom: 5 })
              .backgroundColor(DT.primarySoft)
              .borderRadius(DT.rSm)
              .onClick(() => {
                this.sortAsc = !this.sortAsc;
                this.computeDisplayList();
              })
            }
            .width('100%')
            .padding({ left: 16, right: 16, top: 2, bottom: 10 })
            .justifyContent(FlexAlign.Start)

            if (this.displayList.length === 0) {
              Column() {
                Text(this.tab === 2 ? '还没有收藏的文件' : '暂无 PDF 文件')
                  .fontSize(15)
                  .fontColor(DT.textTertiary)
                  .margin({ top: 80 })
                if (this.tab !== 2) {
                  Text('点击右上角「导入」添加 PDF')
                    .fontSize(13)
                    .fontColor('#C2C7CE')
                    .margin({ top: 8 })
                }
              }
              .width('100%')
            } else {
              List({ space: 10 }) {
                ForEach(
                  this.displayList,
                  (f: PdfFileInfo) => {
                    ListItem() {
                      this.FileCard(f)
                    }
                    .swipeAction({
                      start: {
                        builder: () => {
                          this.EditSwipeItem(f);
                        }
                      },
                      end: {
                        builder: () => {
                          this.DeleteSwipeItem(f);
                        }
                      }
                    })
                  },
                  (f: PdfFileInfo) => f.path
                )
              }
              .width('100%')
              .layoutWeight(1)
              .padding({ left: 12, right: 12, top: 4, bottom: 8 })
            }
          }
          .width('100%')
          .height('100%')
          .backgroundColor(DT.bgPage)
        }
        .tabBar(this.BottomTab('列表', 0, $r('app.media.ic_list')))

        TabContent() {
          this.ToolsTabContent()
        }
        .tabBar(this.BottomTab('工具', 1, $r('app.media.ic_tools')))
      }
      .onChange((index: number) => {
        this.bottomTab = index;
      })
      .width('100%')
      .height('100%')
      .backgroundColor(DT.bgPage)

      // 移除确认遮罩
      if (this.dialogVisible) {
        Column() {
          this.ConfirmDialog(
            '移除文件',
            `确定移除「${this.pendingDelete?.name ?? ''}」？`,
            () => {
              if (this.pendingDelete) {
                if (FileService.deletePdf(this.pendingDelete.path)) {
                  this.showTip('已移除');
                } else {
                  this.showTip('移除失败');
                }
              }
              this.dialogVisible = false;
              this.pendingDelete = null;
              this.refresh();
            },
            () => {
              this.dialogVisible = false;
              this.pendingDelete = null;
            }
          )
        }
        .width('100%')
        .height('100%')
        .backgroundColor('rgba(0,0,0,0.45)')
        .justifyContent(FlexAlign.Center)
      }

      // 重命名遮罩
      if (this.renameVisible) {
        Column() {
          this.RenameDialog()
        }
        .width('100%')
        .height('100%')
        .backgroundColor('rgba(0,0,0,0.45)')
        .justifyContent(FlexAlign.Center)
      }

      // 工具选 PDF 模态框（点击工具后，从已导入文件中选择）
      if (this.toolSheetVisible) {
        this.ToolPickSheet()
      }
    }
    .width('100%')
    .height('100%')
  }

  @Builder
  SegItem(label: string, index: number) {
    Text(label)
      .fontSize(14)
      .fontWeight(this.tab === index ? FontWeight.Medium : FontWeight.Normal)
      .fontColor(this.tab === index ? DT.primary : DT.textSecondary)
      .padding({ left: 18, right: 18, top: 7, bottom: 7 })
      .backgroundColor(this.tab === index ? DT.bgCard : 'rgba(0,0,0,0)')
      .borderRadius(DT.rSm)
      .shadow(this.tab === index ? DT.shadowCard : {
        radius: 0,
        color: '#00000000',
        offsetX: 0,
        offsetY: 0
      })
      .onClick(() => {
        this.tab = index;
        this.computeDisplayList();
      })
  }

  @Builder
  SortChip(label: string, mode: 'name' | 'size' | 'time') {
    Text(label)
      .fontSize(13)
      .fontColor(this.sortMode === mode ? DT.primary : DT.textSecondary)
      .backgroundColor(this.sortMode === mode ? DT.primarySoft : 'rgba(0,0,0,0)')
      .padding({ left: 12, right: 12, top: 6, bottom: 6 })
      .borderRadius(DT.rSm)
      .margin({ right: 8 })
      .onClick(() => {
        this.switchSortMode(mode);
      })
  }

  private switchSortMode(mode: 'name' | 'size' | 'time'): void {
    if (this.sortMode === mode) {
      this.sortAsc = !this.sortAsc; // 同键再点切换升降序
    } else {
      this.sortMode = mode;
      this.sortAsc = mode === 'name'; // 名称默认升序(A→Z)，大小/时间默认降序
    }
    this.computeDisplayList();
  }

  @Builder
  FileCard(f: PdfFileInfo) {
    Row() {
      // 文件图标（文档缩略）
      Stack() {
        Column() {
          Text('PDF')
            .fontSize(13)
            .fontWeight(FontWeight.Bold)
            .fontColor('#FFFFFF')
        }
        .width(46)
        .height(58)
        .linearGradient({
          angle: 135,
          colors: [[0xF5222D, 0.0], [0xD9363E, 1.0]]
        })
        .borderRadius(10)
        .justifyContent(FlexAlign.Center)
        .shadow(DT.shadowCard)
      }
      .margin({ right: 12 })

      Column() {
        Text(f.name)
          .fontSize(15)
          .fontWeight(FontWeight.Medium)
          .fontColor(DT.textPrimary)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .width('100%')
        Row() {
          Text(this.formatSize(f.size))
            .fontSize(12)
            .fontColor(DT.textTertiary)
          Text(this.formatDate(f.lastModified))
            .fontSize(12)
            .fontColor(DT.textTertiary)
            .margin({ left: 12 })
        }
        .margin({ top: 6 })
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)

      // 收藏星标
      Text(this.favorites.includes(f.path) ? '★' : '☆')
        .fontSize(22)
        .fontColor(this.favorites.includes(f.path) ? DT.warning : DT.textTertiary)
        .width(28)
        .textAlign(TextAlign.Center)
        .onClick(() => {
          StoreUtil.toggleFavorite(f.path);
          this.favorites = StoreUtil.getFavorites();
          this.showTip(this.favorites.includes(f.path) ? '已收藏' : '已取消收藏');
        })
    }
    .width('100%')
    .padding(12)
    .backgroundColor(DT.bgCard)
    .borderRadius(DT.rLg)
    .shadow(DT.shadowCard)
    .onClick(() => {
      this.openFile(f);
    })
    .gesture(
      LongPressGesture()
        .onAction(() => {
          this.pendingRename = f;
          this.newName = f.name.replace(/\.pdf$/i, '');
          this.renameVisible = true;
        })
    )
  }

  @Builder
  EditSwipeItem(f: PdfFileInfo) {
    Button('编辑', { type: ButtonType.Normal })
      .width(70)
      .height('100%')
      .backgroundColor(DT.primary)
      .fontColor('#ffffff')
      .onClick(() => {
        StoreUtil.saveRecent(f.path, f.name);
        router.pushUrl({
          url: 'pages/EditorPage',
          params: { filePath: f.path, fileName: f.name }
        }).catch((e: Error) => {
          Logger.error(TAG, `open editor ${f.name} failed: ${e.message}`);
        });
      })
  }

  @Builder
  DeleteSwipeItem(f: PdfFileInfo) {
    Button('移除', { type: ButtonType.Normal })
      .width(70)
      .height('100%')
      .backgroundColor(DT.danger)
      .fontColor('#ffffff')
      .onClick(() => {
        this.pendingDelete = f;
        this.dialogVisible = true;
      })
  }

  @Builder
  ConfirmDialog(
    title: string,
    msg: string,
    onConfirm: () => void,
    onCancel: () => void
  ) {
    Column() {
      Text(title)
        .fontSize(17)
        .fontWeight(FontWeight.Bold)
        .fontColor(DT.textPrimary)
        .margin({ bottom: 12 })
      Text(msg)
        .fontSize(14)
        .fontColor(DT.textSecondary)
        .margin({ bottom: 20 })
      Row() {
        Button('取消', { type: ButtonType.Normal })
          .layoutWeight(1)
          .height(42)
          .backgroundColor(DT.bgSoft)
          .fontColor(DT.textPrimary)
          .borderRadius(DT.rMd)
          .onClick(onCancel)
        Button('移除', { type: ButtonType.Normal })
          .layoutWeight(1)
          .height(42)
          .backgroundColor(DT.danger)
          .fontColor('#ffffff')
          .borderRadius(DT.rMd)
          .margin({ left: 12 })
          .onClick(onConfirm)
      }
    }
    .padding(20)
    .backgroundColor(DT.bgCard)
    .borderRadius(DT.rLg)
    .width(280)
    .shadow(DT.shadowRaised)
  }

  @Builder
  RenameDialog() {
    Column() {
      Text('重命名')
        .fontSize(17)
        .fontWeight(FontWeight.Bold)
        .fontColor(DT.textPrimary)
        .margin({ bottom: 12 })
      TextInput({ placeholder: '文件名', text: this.newName })
        .width('100%')
        .height(42)
        .backgroundColor(DT.bgSoft)
        .borderRadius(DT.rMd)
        .onChange((v: string) => {
          this.newName = v;
        })
        .margin({ bottom: 20 })
      Row() {
        Button('取消', { type: ButtonType.Normal })
          .layoutWeight(1)
          .height(42)
          .backgroundColor(DT.bgSoft)
          .fontColor(DT.textPrimary)
          .borderRadius(DT.rMd)
          .onClick(() => {
            this.renameVisible = false;
            this.pendingRename = null;
          })
        Button('确定', { type: ButtonType.Normal })
          .layoutWeight(1)
          .height(42)
          .backgroundColor(DT.primary)
          .fontColor('#ffffff')
          .borderRadius(DT.rMd)
          .margin({ left: 12 })
          .onClick(() => {
            if (this.pendingRename && this.newName.trim().length > 0) {
              const np = FileService.renamePdf(this.pendingRename.path, this.newName.trim());
              if (np) {
                this.showTip('已重命名');
              } else {
                this.showTip('重命名失败');
              }
            }
            this.renameVisible = false;
            this.pendingRename = null;
            this.refresh();
          })
      }
    }
    .padding(20)
    .backgroundColor(DT.bgCard)
    .borderRadius(DT.rLg)
    .width(280)
    .shadow(DT.shadowRaised)
  }

  /**
   * 底部导航项（图标 + 文字，选中态主色）
   */
  @Builder
  BottomTab(label: string, index: number, icon: Resource) {
    Column({ space: 3 }) {
      Image(icon)
        .width(22)
        .height(22)
        .fillColor(this.bottomTab === index ? DT.primary : DT.textTertiary)
      Text(label)
        .fontSize(12)
        .fontWeight(this.bottomTab === index ? FontWeight.Medium : FontWeight.Normal)
        .fontColor(this.bottomTab === index ? DT.primary : DT.textTertiary)
    }
    .width('100%')
    .height('100%')
    .justifyContent(FlexAlign.Center)
  }

  /**
   * PDF 工具中心：按分类展示工具卡片（V1.1）
   * 点击工具 → 跳转 EditorPage 并携带 tool 参数；未选文件时由 EditorPage 引导选文件。
   * 图标使用矢量 SVG（Image），与阅读器「编辑」模态框风格保持一致。
   */
  @Builder
  ToolsTabContent() {
    Stack({ alignContent: Alignment.TopStart }) {
      Scroll() {
        Column() {
        Text('PDF 工具')
          .fontSize(22)
          .fontWeight(FontWeight.Bold)
          .fontColor(DT.textPrimary)
          .alignSelf(ItemAlign.Start)
          .margin({ left: 16, top: 14, bottom: 4 })
        Text('选择工具开始处理你的 PDF')
          .fontSize(13)
          .fontColor(DT.textTertiary)
          .alignSelf(ItemAlign.Start)
          .margin({ left: 16, bottom: 12 })

        ForEach(
          TOOL_CATEGORIES,
          (cat: ToolCategory) => {
            Column() {
              // 分类标题
              Row() {
                Text('')
                  .width(7)
                  .height(7)
                  .borderRadius(3.5)
                  .backgroundColor(cat.accent)
                  .margin({ right: 6 })
                Text(cat.title)
                  .fontSize(15)
                  .fontWeight(FontWeight.Medium)
                  .fontColor(DT.textPrimary)
              }
              .width('100%')
              .margin({ left: 16, top: 14, bottom: 10 })

              Grid() {
                ForEach(
                  cat.items,
                  (item: ToolItem) => {
                    GridItem() {
                      this.ToolCard(item, cat)
                    }
                  },
                  (item: ToolItem) => item.id
                )
              }
              .columnsTemplate('1fr 1fr 1fr 1fr')
              .rowsGap(12)
              .columnsGap(12)
              .width('100%')
              .padding({ left: 12, right: 12 })
            }
            .width('100%')
          },
          (cat: ToolCategory) => cat.title
        )
      }
      .width('100%')
      }
      .width('100%')
      .height('100%')
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#FFFFFF')
    .clip(true)
  }

  @Builder
  ToolCard(item: ToolItem, cat: ToolCategory) {
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
    .onClick(() => {
      this.openToolSheet(item.id, item.name);
    })
  }

  /**
   * 点击工具 → 弹出「选择已导入 PDF」模态框（替代长链路：工具→选文件页→再选）。
   * 若本地尚无 PDF，仍提供「导入新 PDF」入口直接拉起系统选择器。
   */
  openToolSheet(toolId: string, toolName: string): void {
    const input = toolInput(toolId);
    // 图片类工具（图片提字 / 图片转 PDF）的输入不是 PDF：
    // 不走「选择 PDF」模态框，直接进编辑器由其 PickPanel 引导选图片
    if (input === 'image' || input === 'images') {
      router.pushUrl({
        url: 'pages/EditorPage',
        params: { tool: toolId }
      }).catch((e: Error) => {
        Logger.error(TAG, `open image tool ${toolId} failed: ${e.message}`);
        this.showTip('打开工具失败');
      });
      return;
    }
    this.pendingTool = toolId;
    this.pendingToolName = toolName;
    this.toolMulti = input === 'multiple';
    this.selectedPaths = [];
    this.toolSheetVisible = true;
  }

  /**
   * 从模态框选中某个已导入 PDF（单文件工具）→ 跳转编辑器并携带 tool + 文件信息。
   */
  private openToolWithFile(toolId: string, f: PdfFileInfo): void {
    this.toolSheetVisible = false;
    StoreUtil.saveRecent(f.path, f.name);
    router.pushUrl({
      url: 'pages/EditorPage',
      params: { tool: toolId, filePath: f.path, fileName: f.name }
    }).catch((e: Error) => {
      Logger.error(TAG, `open tool ${toolId} with ${f.name} failed: ${e.message}`);
      this.showTip('打开工具失败');
    });
  }

  /**
   * 多选模式（如合并）：将已勾选的多个 PDF 一并带入编辑器。
   */
  private openToolWithFiles(toolId: string, paths: string[]): void {
    this.toolSheetVisible = false;
    StoreUtil.saveRecent(paths[0], paths[0].split('/').pop() || '文档');
    router.pushUrl({
      url: 'pages/EditorPage',
      params: { tool: toolId, filePaths: paths }
    }).catch((e: Error) => {
      Logger.error(TAG, `open tool ${toolId} with ${paths.length} files failed: ${e.message}`);
      this.showTip('打开工具失败');
    });
  }

  /**
   * 模态框内「导入新 PDF」：
   * - 多文件工具（如合并）：导入后加入选择集，不跳转，待用户点「开始」。
   * - 单文件工具：导入后直接进入编辑器（带文件 + 工具）。
   */
  private importThenOpenTool(): void {
    const ctx = AppContext.getContextOrNull();
    if (!ctx) {
      this.showTip('导入失败：应用上下文未就绪');
      return;
    }
    if (this.toolMulti) {
      // 多选模式：保持模态框打开，仅把导入结果并入选择集
      FileService.importFromPicker(ctx)
        .then((res) => {
          const added: string[] = res.imported.length > 0 ? res.imported : res.skippedPaths;
          if (added.length === 0) {
            if (res.skipped > 0) {
              this.showTip('该文件已导入，请在列表勾选');
            } else {
              this.showTip('未选择文件');
            }
            return;
          }
          // 新导入的自动勾选加入选择集，并刷新列表展示（整体替换数组引用以触发 UI 重建）
          const merged: string[] = [...this.selectedPaths];
          for (const p of added) {
            if (!merged.includes(p)) {
              merged.push(p);
            }
          }
          this.selectedPaths = merged;
          this.refresh();
          this.showTip(`已添加 ${added.length} 个文件到选择集`);
        })
        .catch((e: Error) => {
          Logger.error(TAG, `import in tool sheet failed: ${e.message}`);
          this.showTip('导入失败');
        });
      return;
    }
    // 单文件：导入后直接进编辑器
    this.toolSheetVisible = false;
    FileService.importFromPicker(ctx)
      .then((res) => {
        const target: string | undefined = res.imported[0] ?? res.skippedPaths[0];
        if (target) {
          const name: string = target.split('/').pop() || '文档';
          StoreUtil.saveRecent(target, name);
          router.pushUrl({
            url: 'pages/EditorPage',
            params: { tool: this.pendingTool, filePath: target, fileName: name }
          }).catch((e: Error) => {
            Logger.error(TAG, `import+open tool failed: ${e.message}`);
            this.showTip('打开工具失败');
          });
        } else if (res.skipped > 0 && res.skippedPaths.length === 0) {
          this.showTip('已导入该文件，请在「列表」中选择');
        } else {
          this.showTip('未选择文件');
        }
      })
      .catch((e: Error) => {
        Logger.error(TAG, `import in tool sheet failed: ${e.message}`);
        this.showTip('导入失败');
      });
  }

  private showTip(msg: string): void {
    try {
      this.getUIContext().getPromptAction().showToast({ message: msg, duration: 1800 });
    } catch (e) {
      Logger.warn(TAG, `toast failed: ${(e as Error).message}`);
    }
  }

  /**
   * 工具选 PDF 模态框：
   * - 单文件工具：点选即进编辑器。
   * - 多文件工具（如合并）：勾选多个，底部「开始」按钮进入编辑器；「导入新 PDF」加入选择集。
   */
  @Builder
  ToolPickSheet() {
    // 遮罩（点击关闭）
    Column() {
    }
    .width('100%')
    .height('100%')
    .backgroundColor('rgba(0,0,0,0.45)')
    .onClick(() => { this.toolSheetVisible = false; })

    // 底部面板
    Column() {
      Row() {
        Text(this.toolMulti ? `选择 PDF（已选 ${this.selectedPaths.length}）` : '选择 PDF')
          .fontSize(17)
          .fontWeight(FontWeight.Bold)
          .fontColor(DT.textPrimary)
        Blank()
        Text('✕')
          .fontSize(18)
          .fontColor('#999')
          .width(32)
          .height(32)
          .textAlign(TextAlign.Center)
          .onClick(() => { this.toolSheetVisible = false; })
      }
      .width('100%')
      .padding({ left: 16, right: 12, top: 4, bottom: 8 })

      Text(this.toolMulti
        ? `「${this.pendingToolName}」需要至少 2 个 PDF，可勾选多个并按顺序合并`
        : `「${this.pendingToolName}」将作用于以下 PDF`)
        .fontSize(12)
        .fontColor(DT.textTertiary)
        .alignSelf(ItemAlign.Start)
        .margin({ left: 16, bottom: 8 })

      if (this.fileList.length === 0) {
        Column() {
          Text('还没有导入的 PDF')
            .fontSize(14)
            .fontColor(DT.textTertiary)
            .margin({ top: 40, bottom: 6 })
          Text('点击下方「导入新 PDF」添加文件')
            .fontSize(12)
            .fontColor('#C2C7CE')
        }
        .width('100%')
      } else {
        List({ space: 8 }) {
          ForEach(
            this.fileList,
            (f: PdfFileInfo) => {
              ListItem() {
                Row() {
                  Stack() {
                    Column() {
                      Text('PDF')
                        .fontSize(12)
                        .fontWeight(FontWeight.Bold)
                        .fontColor('#FFFFFF')
                    }
                    .width(38)
                    .height(48)
                    .linearGradient({
                      angle: 135,
                      colors: [[0xF5222D, 0.0], [0xD9363E, 1.0]]
                    })
                    .borderRadius(9)
                    .justifyContent(FlexAlign.Center)
                  }
                  .margin({ right: 12 })
                  Column() {
                    Text(f.name)
                      .fontSize(14)
                      .fontWeight(FontWeight.Medium)
                      .fontColor(DT.textPrimary)
                      .maxLines(1)
                      .textOverflow({ overflow: TextOverflow.Ellipsis })
                      .width('100%')
                    Text(this.formatSize(f.size))
                      .fontSize(12)
                      .fontColor(DT.textTertiary)
                      .margin({ top: 4 })
                  }
                  .layoutWeight(1)
                  .alignItems(HorizontalAlign.Start)

                  if (this.toolMulti) {
                    // 多选勾选状态
                    Text(this.selectedPaths.includes(f.path) ? '✓' : '○')
                      .fontSize(20)
                      .fontColor(this.selectedPaths.includes(f.path) ? DT.primary : DT.textTertiary)
                      .width(32)
                      .textAlign(TextAlign.Center)
                  }
                }
                .width('100%')
                .padding(12)
                .backgroundColor(this.toolMulti && this.selectedPaths.includes(f.path) ? DT.primarySoft : DT.bgCard)
                .borderRadius(DT.rLg)
                .border({ width: 1, color: DT.border })
                .onClick(() => {
                  if (this.toolMulti) {
                    this.toggleSelect(f.path);
                  } else {
                    this.openToolWithFile(this.pendingTool, f);
                  }
                })
              }
            },
            (f: PdfFileInfo) => f.path
          )
        }
        .width('100%')
        .layoutWeight(1)
        .padding({ left: 12, right: 12, top: 4 })
      }

      // 底部按钮区
      if (this.toolMulti) {
        Button({ type: ButtonType.Normal }) {
          Text(`开始${this.pendingToolName}（${this.selectedPaths.length}）`)
            .fontSize(15)
            .fontColor('#ffffff')
        }
        .width('100%')
        .height(46)
        .backgroundColor(this.selectedPaths.length >= 2 ? DT.primary : '#BBBBBB')
        .borderRadius(DT.rMd)
        .margin({ left: 16, right: 16, top: 10, bottom: 8 })
        .enabled(this.selectedPaths.length >= 2)
        .onClick(() => {
          if (this.selectedPaths.length >= 2) {
            this.openToolWithFiles(this.pendingTool, this.selectedPaths);
          }
        })
      }

      Button({ type: ButtonType.Normal }) {
        Row({ space: 6 }) {
          Image($r('app.media.ic_plus'))
            .width(16)
            .height(16)
            .fillColor('#ffffff')
          Text(this.toolMulti ? '导入并加入选择集' : '导入新 PDF')
            .fontSize(15)
            .fontColor('#ffffff')
        }
      }
      .width('100%')
      .height(46)
      .backgroundColor(this.toolMulti ? DT.success : DT.primary)
      .borderRadius(DT.rMd)
      .margin({ left: 16, right: 16, top: this.toolMulti ? 0 : 10, bottom: 16 })
      .onClick(() => { this.importThenOpenTool(); })
    }
    .width('100%')
    .height('72%')
    .backgroundColor('#ffffff')
    .borderRadius({ topLeft: 16, topRight: 16 })
    .padding({ top: 12, bottom: 8 })
  }

  /**
   * 多选模式：切换某 PDF 的勾选状态。
   * 注意：必须整体替换数组引用——@State 只观察引用变化，
   * 原地 push/splice 不会触发 UI 重建（勾选态、计数、按钮 enable 都会不刷新）。
   */
  private toggleSelect(path: string): void {
    const idx: number = this.selectedPaths.indexOf(path);
    if (idx >= 0) {
      this.selectedPaths = this.selectedPaths.filter((p: string): boolean => p !== path);
    } else {
      this.selectedPaths = [...this.selectedPaths, path];
    }
  }
}
