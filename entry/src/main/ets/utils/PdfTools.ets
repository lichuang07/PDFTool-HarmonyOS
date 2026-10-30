/**
 * PDF 工具定义（V1.1 共享数据源）
 *
 * 被首页「工具」Tab（FileList）与阅读器「编辑」模态框（Reader）共用，
 * 避免两处重复定义造成漂移。
 *
 * icon：引用 resources/base/media 下的线性 SVG 图标（tool_<id>.svg）。
 */
export interface ToolItem {
  id: string;
  name: string;
  icon: Resource;
  /** 输入模式：single=单个 PDF；multiple=需要 2+ 个 PDF；image=单张图片；images=1+ 张图片；pdfimage=先 PDF 再图片（签章）。默认 single。 */
  input?: 'single' | 'multiple' | 'image' | 'images' | 'pdfimage';
}

export interface ToolCategory {
  title: string;
  /** 图标深字色（分类主题色） */
  accent: string;
  /** 图标方块浅底色（分类主题色浅填充，扁平化磁贴底） */
  tint: string;
  items: ToolItem[];
}

export const TOOL_CATEGORIES: ToolCategory[] = [
  {
    title: '页面编辑',
    accent: '#185FA5',
    tint: '#E6F1FB',
    items: [
      { id: 'merge', name: '合并', icon: $r('app.media.tool_merge'), input: 'multiple' },
      { id: 'split', name: '拆分', icon: $r('app.media.tool_split') },
      { id: 'delete', name: '删除页面', icon: $r('app.media.tool_delete') },
      { id: 'reorder', name: '重排', icon: $r('app.media.tool_reorder') },
      { id: 'rotate', name: '旋转', icon: $r('app.media.tool_rotate') },
      { id: 'insert', name: '插入', icon: $r('app.media.tool_insert'), input: 'multiple' },
      { id: 'extract', name: '提取', icon: $r('app.media.tool_extract') }
    ]
  },
  {
    title: '标注批注',
    accent: '#A32D2D',
    tint: '#FCE8E6',
    items: [
      { id: 'sign', name: '手写签名', icon: $r('app.media.tool_sign') },
      { id: 'highlight', name: '高亮标注', icon: $r('app.media.tool_highlight') }
    ]
  },
  {
    title: '内容添加',
    accent: '#3B6D11',
    tint: '#EAF3DE',
    items: [
      { id: 'text', name: '文字标注', icon: $r('app.media.tool_text') },
      { id: 'watermark', name: '水印', icon: $r('app.media.tool_watermark') },
      { id: 'stamp', name: '图片签章', icon: $r('app.media.tool_stamp'), input: 'pdfimage' },
      { id: 'link', name: '超链接', icon: $r('app.media.tool_link') }
    ]
  },
  {
    title: '安全加密',
    accent: '#854F0B',
    tint: '#FAEEDA',
    items: [
      { id: 'encrypt', name: '加密', icon: $r('app.media.tool_encrypt') },
      { id: 'decrypt', name: '解密', icon: $r('app.media.tool_decrypt') },
      { id: 'permission', name: '权限设置', icon: $r('app.media.tool_permission') },
      { id: 'dual', name: '双密码', icon: $r('app.media.tool_dual') }
    ]
  },
  {
    title: 'OCR 识别',
    accent: '#4C3D8F',
    tint: '#EDE9FB',
    items: [
      { id: 'ocr', name: '扫描件转可搜索', icon: $r('app.media.tool_ocr') },
      { id: 'autorotate', name: '自动旋转校正', icon: $r('app.media.tool_autorotate') },
      { id: 'textocr', name: '提取文字', icon: $r('app.media.tool_textocr') },
      { id: 'imgocr', name: '图片提取文字', icon: $r('app.media.tool_imgocr'), input: 'image' }
    ]
  },
  {
    title: '表单',
    accent: '#5F4B8B',
    tint: '#EDE7F6',
    items: [
      { id: 'formcreate', name: '创建表单字段', icon: $r('app.media.tool_form') },
      { id: 'formfill', name: '填写表单', icon: $r('app.media.tool_fill') },
      { id: 'flatten', name: '展平表单', icon: $r('app.media.tool_flatten') }
    ]
  },
  {
    title: '工具功能',
    accent: '#0F6E6E',
    tint: '#E2F1F1',
    items: [
      { id: 'pagetoimg', name: '页面转图片', icon: $r('app.media.tool_pagetoimg') },
      { id: 'compress', name: 'PDF 压缩', icon: $r('app.media.tool_compress') },
      { id: 'thumbs', name: '缩略图批量生成', icon: $r('app.media.tool_thumbs') },
      { id: 'print', name: '打印', icon: $r('app.media.tool_print') },
      { id: 'rename', name: '自动重命名', icon: $r('app.media.tool_rename') }
    ]
  },
  {
    title: '格式转换',
    accent: '#8A4B0F',
    tint: '#FBEEDC',
    items: [
      { id: 'img2pdf', name: '图片转 PDF', icon: $r('app.media.tool_img2pdf'), input: 'images' },
      { id: 'pdftoimg', name: 'PDF 转图片', icon: $r('app.media.tool_pdftoimg') }
    ]
  },
  {
    title: '文档信息',
    accent: '#0F6E6E',
    tint: '#E2F1F1',
    items: [
      { id: 'metadata', name: '元数据编辑', icon: $r('app.media.tool_metadata') }
    ]
  }
];

/** 根据工具 id 取名称（用于编辑器页展示当前工具） */
export function toolName(id: string): string {
  for (const cat of TOOL_CATEGORIES) {
    const found = cat.items.find((t) => t.id === id);
    if (found) {
      return found.name;
    }
  }
  return id || '工具';
}

/** 根据工具 id 取输入模式（默认 single） */
export function toolInput(id: string): 'single' | 'multiple' | 'image' | 'images' | 'pdfimage' {
  for (const cat of TOOL_CATEGORIES) {
    const found = cat.items.find((t) => t.id === id);
    if (found) {
      return found.input ?? 'single';
    }
  }
  return 'single';
}
