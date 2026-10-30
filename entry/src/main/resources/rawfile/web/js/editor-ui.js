/**
 * editor-ui.js — 编辑器工具交互层（通用框架，V1.2）
 *
 * 职责：根据 window.__PDF_TOOL__ / __PDF_PATH__ / __PDF_PATHS__ 渲染对应工具的
 * 参数面板，调用 window.pdfEditor（editor.js 中的算法封装），展示处理中 / 结果。
 *
 * 本阶段完整实现全部工具（13 个）：
 *   页面编辑：merge（多文件）、split、delete、reorder、rotate、insert（多文件）、extract
 *   内容添加：text、watermark
 *   安全加密：encrypt、decrypt、permission、dual
 *
 * 依赖：bridge.js（window.bridge）、editor.js（window.pdfEditor）、pdf-lib（window.PDFLib）。
 */
(function () {
  'use strict';

  var body = document.getElementById('editor-body');
  var headerTool = document.getElementById('e-tool-name');

  // 注意：__PDF_TOOL__ / __PDF_PATH__ / __PDF_PATHS__ 由 ArkTS 在 onPageEnd 经
  // runJavaScript 注入，晚于本脚本执行。故在 boot() 内读取，并先轮询等待注入完成。
  var TOOL = '';
  var SINGLE = '';
  var MULTI = [];
  var IMAGES = [];  // 图片集合（图片转 PDF，由 ArkTS 注入 __PDF_IMAGES__）
  var PASSWORD = ''; // 从阅读器跳转携带的密码（阅读器已输对时免去二次弹窗）

  function readInjected() {
    TOOL = (typeof window.__PDF_TOOL__ !== 'undefined' && window.__PDF_TOOL__) ? window.__PDF_TOOL__ : '';
    SINGLE = (typeof window.__PDF_PATH__ !== 'undefined' && window.__PDF_PATH__) ? window.__PDF_PATH__ : '';
    MULTI = (typeof window.__PDF_PATHS__ !== 'undefined' && Array.isArray(window.__PDF_PATHS__))
      ? window.__PDF_PATHS__ : [];
    IMAGES = (typeof window.__PDF_IMAGES__ !== 'undefined' && Array.isArray(window.__PDF_IMAGES__))
      ? window.__PDF_IMAGES__ : [];
    PASSWORD = (typeof window.__PDF_PASSWORD__ !== 'undefined' && window.__PDF_PASSWORD__) ? window.__PDF_PASSWORD__ : '';
  }

  // ============ 通用工具函数 ============

  function baseName(p) {
    if (!p) return '';
    return p.split('/').pop() || p;
  }

  function el(tag, style, text) {
    var e = document.createElement(tag);
    if (style) { for (var k in style) { e.style[k] = style[k]; } }
    if (text !== undefined && text !== null) { e.textContent = text; }
    return e;
  }

  function clearBody() {
    while (body.firstChild) { body.removeChild(body.firstChild); }
  }

  // 结果 / 状态横幅
  function banner(msg, type) {
    var colorMap = { info: '#9aa0a6', ok: '#2ea44f', err: '#e5534b', warn: '#d29922' };
    var b = el('div', {
      position: 'absolute', left: '12px', right: '12px', bottom: '12px',
      color: '#fff', fontSize: '13px', background: colorMap[type || 'info'] || '#333',
      padding: '10px 12px', borderRadius: '10px', lineHeight: '1.5',
      boxShadow: '0 4px 12px rgba(0,0,0,0.25)', whiteSpace: 'pre-wrap',
      maxHeight: '40%', overflowY: 'auto'
    }, msg);
    b.id = 'editor-output';
    var old = document.getElementById('editor-output');
    if (old) { old.parentNode.removeChild(old); }
    body.appendChild(b);
    return b;
  }

  function toast(msg) {
    if (window.bridge && typeof window.bridge.showToast === 'function') {
      window.bridge.showToast(msg);
    }
  }

  function setRunning(btn, running, label) {
    btn.disabled = running;
    btn.style.opacity = running ? '0.6' : '1';
    btn.textContent = running ? '处理中…' : label;
  }

  function fileNote(path) {
    return el('div', { fontSize: '12px', color: '#8a8a8a', marginBottom: '12px' },
      '文件：' + (path ? baseName(path) : '未指定'));
  }

  function totalInfo(total) {
    return el('div', { fontSize: '12px', color: '#8a8a8a', marginBottom: '12px' },
      total > 0 ? ('共 ' + total + ' 页') : '（无法读取页数，请手动填写）');
  }

  // 读取目标文件页数（读写安全，失败返回 0）
  async function getTotal(path) {
    try {
      if (!window.pdfEditor || !window.pdfEditor.getPageCount) { return 0; }
      return await window.pdfEditor.getPageCount(path);
    } catch (e) {
      return 0;
    }
  }

  // 解析页码文本为 1-based 数组，支持 "1,3,5" 与 "1-3"，并校验范围、去重
  function parsePages(text, total) {
    if (!text || !text.trim()) { return { ok: false, msg: '请填写页码' }; }
    var pages = [];
    var parts = text.split(',');
    for (var i = 0; i < parts.length; i++) {
      var part = parts[i].trim();
      if (!part) { continue; }
      if (part.indexOf('-') >= 0) {
        var segs = part.split('-');
        var a = parseInt(segs[0], 10), b = parseInt(segs[1], 10);
        if (isNaN(a) || isNaN(b) || a < 1 || b < a) { return { ok: false, msg: '范围格式错误：' + part }; }
        for (var p = a; p <= b; p++) { pages.push(p); }
      } else {
        var n = parseInt(part, 10);
        if (isNaN(n) || n < 1) { return { ok: false, msg: '页码无效：' + part }; }
        pages.push(n);
      }
    }
    if (!pages.length) { return { ok: false, msg: '未解析到页码' }; }
    if (total) {
      for (var j = 0; j < pages.length; j++) {
        if (pages[j] > total) { return { ok: false, msg: '页码超出范围（共 ' + total + ' 页）：' + pages[j] }; }
      }
    }
    var uniq = [];
    for (var k = 0; k < pages.length; k++) { if (uniq.indexOf(pages[k]) < 0) { uniq.push(pages[k]); } }
    return { ok: true, pages: uniq };
  }

  // 同 parsePages，但留空时返回全部页码
  function parsePagesOrAll(text, total) {
    if (!text || !text.trim()) {
      if (!total) { return { ok: false, msg: '请填写页码' }; }
      var all = [];
      for (var i = 1; i <= total; i++) { all.push(i); }
      return { ok: true, pages: all };
    }
    return parsePages(text, total);
  }

  // 解析拆分范围为 [[start,end], ...]，支持 "1-3,4-5" 与 "1,2,3"
  function parseRanges(text) {
    if (!text || !text.trim()) { return { ok: false, msg: '请填写拆分范围' }; }
    var ranges = [];
    var parts = text.split(',');
    for (var i = 0; i < parts.length; i++) {
      var part = parts[i].trim();
      if (!part) { continue; }
      if (part.indexOf('-') >= 0) {
        var segs = part.split('-');
        var a = parseInt(segs[0], 10), b = parseInt(segs[1], 10);
        if (isNaN(a) || isNaN(b) || a < 1 || b < a) { return { ok: false, msg: '范围格式错误：' + part }; }
        ranges.push([a, b]);
      } else {
        var n = parseInt(part, 10);
        if (isNaN(n) || n < 1) { return { ok: false, msg: '页码无效：' + part }; }
        ranges.push([n, n]);
      }
    }
    if (!ranges.length) { return { ok: false, msg: '未解析到范围' }; }
    return { ok: true, ranges: ranges };
  }

  // ============ 表单控件 ============

  function field(labelText, inputEl, hint) {
    var wrap = el('div', { marginBottom: '14px' });
    wrap.appendChild(el('div', {
      fontSize: '13px', color: '#c8c8c8', marginBottom: '6px'
    }, labelText));
    wrap.appendChild(inputEl);
    if (hint) {
      wrap.appendChild(el('div', {
        fontSize: '11px', color: '#8a8a8a', marginTop: '4px'
      }, hint));
    }
    return wrap;
  }

  function textInput(placeholder, value) {
    var i = el('input', {
      width: '100%', boxSizing: 'border-box', height: '40px', padding: '0 12px',
      borderRadius: '8px', border: '1px solid #3a3a3a', background: '#2b2b2b',
      color: '#f2f2f2', fontSize: '14px', outline: 'none'
    });
    i.placeholder = placeholder || '';
    if (value) { i.value = value; }
    return i;
  }

  function numberInput(value, min, max) {
    var i = textInput('', String(value));
    i.type = 'number';
    if (min !== undefined) { i.min = String(min); }
    if (max !== undefined) { i.max = String(max); }
    return i;
  }

  // 坐标控件：左侧滑杆 + 右侧数字输入框，二者双向联动
  // 返回 { wrap, range, input, setMax }，setMax 可动态更新范围上限并 clamp 当前值
  function coordControl(value, max, oninput) {
    var wrap = el('div', { display: 'flex', alignItems: 'center', gap: '10px' });
    var range = el('input', {
      flex: '1', min: '0', max: String(max), step: '1', value: String(value),
      cursor: 'pointer', accentColor: '#2f6bff'
    });
    range.type = 'range';
    var input = el('input', {
      width: '84px', boxSizing: 'border-box', height: '38px', padding: '0 10px',
      borderRadius: '8px', border: '1px solid #3a3a3a', background: '#2b2b2b',
      color: '#f2f2f2', fontSize: '14px', outline: 'none', textAlign: 'right'
    });
    input.type = 'number';
    input.min = '0';
    input.max = String(max);
    input.value = String(value);

    range.addEventListener('input', function () {
      input.value = range.value;
      if (oninput) oninput(parseFloat(range.value));
    });
    input.addEventListener('input', function () {
      var v = parseFloat(input.value);
      if (isNaN(v)) return;
      v = Math.min(Math.max(v, 0), max);   // clamp 到 [0, max]
      range.value = String(v);
      input.value = String(v);             // 同步回数字框，避免读取值时拿到越界值
      if (oninput) oninput(v);
    });

    function setMax(newMax) {
      max = newMax;
      range.max = String(newMax);
      input.max = String(newMax);
      var cur = parseFloat(range.value) || 0;
      if (cur > newMax) { range.value = String(newMax); input.value = String(newMax); }
    }

    wrap.appendChild(range);
    wrap.appendChild(input);
    return { wrap: wrap, range: range, input: input, setMax: setMax };
  }

  function textAreaInput(placeholder, value) {
    var t = el('textarea', {
      width: '100%', boxSizing: 'border-box', minHeight: '80px', padding: '10px 12px',
      borderRadius: '8px', border: '1px solid #3a3a3a', background: '#2b2b2b',
      color: '#f2f2f2', fontSize: '14px', outline: 'none', resize: 'vertical',
      fontFamily: 'inherit'
    });
    t.placeholder = placeholder || '';
    if (value) { t.value = value; }
    return t;
  }

  function colorInput(value) {
    var i = el('input', {
      width: '48px', height: '36px', border: '1px solid #3a3a3a', background: '#2b2b2b',
      borderRadius: '6px', cursor: 'pointer', padding: '2px'
    });
    i.type = 'color';
    i.value = value || '#000000';
    return i;
  }

  // 复选框：返回 { wrap, input }
  function checkboxInput(labelText, def) {
    var wrap = el('label', {
      display: 'flex', alignItems: 'center', gap: '8px', fontSize: '14px',
      color: '#f2f2f2', marginBottom: '10px', cursor: 'pointer'
    });
    var c = el('input');
    c.type = 'checkbox';
    if (def) { c.checked = true; }
    wrap.appendChild(c);
    wrap.appendChild(el('span', null, labelText));
    return { wrap: wrap, input: c };
  }

  function selectInput(options, def) {
    var s = el('select', {
      width: '100%', boxSizing: 'border-box', height: '40px', padding: '0 10px',
      borderRadius: '8px', border: '1px solid #3a3a3a', background: '#2b2b2b',
      color: '#f2f2f2', fontSize: '14px', outline: 'none'
    });
    options.forEach(function (o) {
      var opt = el('option', null, o.label);
      opt.value = o.value;
      if (o.value === def) { opt.selected = true; }
      s.appendChild(opt);
    });
    return s;
  }

  var ALGO_OPTS = [
    { label: 'AES 256（推荐）', value: 'aes256' },
    { label: 'AES 128', value: 'aes128' },
    { label: 'RC4 128', value: 'rc4128' },
    { label: 'RC4 40', value: 'rc440' }
  ];

  // OCR 语言组合（V1.2 故事 #36：中英文混合识别为默认项）
  var OCR_LANG_OPTS = [
    { value: 'chi_sim+eng', label: '中英文混合（推荐）' },
    { value: 'chi_sim', label: '仅中文简体' },
    { value: 'eng', label: '仅英文' }
  ];
  var OCR_LANG_HINT = '默认「中英文混合」会同时加载 chi_sim + eng 语言包，适合中英混排文档；纯中文/纯英文文档选单项可略快一些。';

  function actionButton(label) {
    var b = el('button', {
      width: '100%', height: '46px', borderRadius: '10px', border: 'none',
      background: '#2f6bff', color: '#fff', fontSize: '15px', fontWeight: '600',
      cursor: 'pointer', marginTop: '6px'
    }, label);
    return b;
  }

  function scrollArea(children) {
    var box = el('div', {
      position: 'absolute', left: '0', right: '0', top: '0', bottom: '0',
      overflowY: 'auto', padding: '16px 16px 90px', boxSizing: 'border-box'
    });
    children.forEach(function (c) { box.appendChild(c); });
    return box;
  }

  function titleEl(text) {
    return el('div', { fontSize: '16px', fontWeight: '600', color: '#f2f2f2', marginBottom: '4px' }, text);
  }

  function descEl(text) {
    return el('div', { fontSize: '13px', color: '#9aa0a6', marginBottom: '6px' }, text);
  }

  // ============ 结果卡片 ============

  function resultBtnStyle(bg) {
    return {
      flex: '1', height: '40px', borderRadius: '8px', border: 'none',
      background: bg, color: '#fff', fontSize: '14px', fontWeight: '600', cursor: 'pointer',
      boxSizing: 'border-box'
    };
  }

  // 单文件结果卡片（预览 / 保存 / 分享）
  function renderResult(path, name) {
    var old = document.getElementById('editor-output');
    if (old && old.parentNode) { old.parentNode.removeChild(old); }

    var card = el('div', {
      position: 'absolute', left: '12px', right: '12px', bottom: '12px',
      background: 'rgba(38,44,52,0.97)', borderRadius: '14px', padding: '14px',
      boxShadow: '0 6px 20px rgba(0,0,0,0.35)', boxSizing: 'border-box'
    });
    card.appendChild(el('div', {
      fontSize: '14px', fontWeight: '600', color: '#2ea44f', marginBottom: '4px',
      paddingRight: '28px'
    }, '✓ 处理完成'));
    // 右上角关闭叉号：关闭后回到编辑面板，可再次编辑
    var closeBtn = el('div', {
      position: 'absolute', top: '8px', right: '8px', width: '24px', height: '24px',
      borderRadius: '50%', background: 'rgba(255,255,255,0.08)', color: '#c8c8c8',
      fontSize: '18px', lineHeight: '22px', textAlign: 'center', cursor: 'pointer'
    }, '×');
    closeBtn.onclick = function () {
      if (card.parentNode) card.parentNode.removeChild(card);
    };
    card.appendChild(closeBtn);
    card.id = 'editor-output';
    card.appendChild(el('div', {
      fontSize: '12px', color: '#c8c8c8', marginBottom: '10px',
      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
    }, name || baseName(path)));

    var row = el('div', { display: 'flex', gap: '8px' });
    var previewBtn = el('button', resultBtnStyle('#2f6bff'), '预览');
    previewBtn.onclick = function () {
      if (window.bridge && window.bridge.openResult) { window.bridge.openResult(path, name || baseName(path)); }
    };
    var saveBtn = el('button', resultBtnStyle('#3a3f47'), '保存');
    saveBtn.onclick = function () {
      if (window.bridge && window.bridge.saveResult) { window.bridge.saveResult(path, name || baseName(path)); }
    };
    var shareBtn = el('button', resultBtnStyle('#3a3f47'), '分享');
    shareBtn.onclick = function () {
      if (window.bridge && window.bridge.shareResult) { window.bridge.shareResult(path, name || baseName(path)); }
    };
    row.appendChild(previewBtn);
    row.appendChild(saveBtn);
    row.appendChild(shareBtn);
    card.appendChild(row);
    body.appendChild(card);
  }

  // 文本结果卡片（复制 / 保存 / 分享）
  // 用于 OCR 提取文字：结果不是 PDF，故不提供「预览」（阅读器只支持 PDF）。
  function renderTextResult(path, text, name) {
    var old = document.getElementById('editor-output');
    if (old && old.parentNode) { old.parentNode.removeChild(old); }

    var card = el('div', {
      position: 'absolute', left: '12px', right: '12px', bottom: '12px',
      background: 'rgba(38,44,52,0.97)', borderRadius: '14px', padding: '14px',
      boxShadow: '0 6px 20px rgba(0,0,0,0.35)', boxSizing: 'border-box',
      maxHeight: '70%', display: 'flex', flexDirection: 'column'
    });
    card.id = 'editor-output';
    card.appendChild(el('div', {
      fontSize: '14px', fontWeight: '600', color: '#2ea44f', marginBottom: '4px',
      paddingRight: '28px'
    }, '✓ 识别完成'));
    var closeBtn = el('div', {
      position: 'absolute', top: '8px', right: '8px', width: '24px', height: '24px',
      borderRadius: '50%', background: 'rgba(255,255,255,0.08)', color: '#c8c8c8',
      fontSize: '18px', lineHeight: '22px', textAlign: 'center', cursor: 'pointer'
    }, '×');
    closeBtn.onclick = function () {
      if (card.parentNode) { card.parentNode.removeChild(card); }
    };
    card.appendChild(closeBtn);
    card.appendChild(el('div', {
      fontSize: '12px', color: '#c8c8c8', marginBottom: '8px',
      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
    }, name || baseName(path)));

    var preview = el('div', {
      fontSize: '12px', color: '#d8d8d8', background: '#1f2429', borderRadius: '8px',
      padding: '10px', marginBottom: '10px', overflowY: 'auto', flex: '1',
      whiteSpace: 'pre-wrap', lineHeight: '1.6', maxHeight: '220px'
    }, text || '');
    card.appendChild(preview);

    var row = el('div', { display: 'flex', gap: '8px' });
    var copyBtn = el('button', resultBtnStyle('#2f6bff'), '复制文字');
    copyBtn.onclick = function () {
      if (window.bridge && window.bridge.copyToClipboard) {
        window.bridge.copyToClipboard(text || '');
        toast('已复制到剪贴板');
      } else {
        toast('当前环境不支持复制');
      }
    };
    var saveBtn = el('button', resultBtnStyle('#3a3f47'), '保存');
    saveBtn.onclick = function () {
      if (window.bridge && window.bridge.saveResult) { window.bridge.saveResult(path, name || baseName(path)); }
    };
    var shareBtn = el('button', resultBtnStyle('#3a3f47'), '分享');
    shareBtn.onclick = function () {
      if (window.bridge && window.bridge.shareResult) { window.bridge.shareResult(path, name || baseName(path)); }
    };
    row.appendChild(copyBtn);
    row.appendChild(saveBtn);
    row.appendChild(shareBtn);
    card.appendChild(row);
    body.appendChild(card);
  }

  function miniBtn(bg) {
    return {
      padding: '6px 10px', borderRadius: '6px', border: 'none',
      background: bg, color: '#fff', fontSize: '12px', cursor: 'pointer', marginLeft: '6px'
    };
  }

  function resultRow(path, name) {
    var row = el('div', {
      display: 'flex', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid #333'
    });
    row.appendChild(el('div', {
      flex: '1', fontSize: '13px', color: '#e8e8e8',
      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginRight: '8px'
    }, name || baseName(path)));
    var pv = el('button', miniBtn('#2f6bff'), '预览');
    pv.onclick = function () {
      if (window.bridge && window.bridge.openResult) { window.bridge.openResult(path, name || baseName(path)); }
    };
    var sv = el('button', miniBtn('#3a3f47'), '保存');
    sv.onclick = function () {
      if (window.bridge && window.bridge.saveResult) { window.bridge.saveResult(path, name || baseName(path)); }
    };
    var sh = el('button', miniBtn('#3a3f47'), '分享');
    sh.onclick = function () {
      if (window.bridge && window.bridge.shareResult) { window.bridge.shareResult(path, name || baseName(path)); }
    };
    row.appendChild(pv); row.appendChild(sv); row.appendChild(sh);
    return row;
  }

  // 多文件结果列表（如拆分 / 提取多个文件）
  function renderResultList(paths) {
    var old = document.getElementById('editor-output');
    if (old && old.parentNode) { old.parentNode.removeChild(old); }
    var card = el('div', {
      position: 'absolute', left: '12px', right: '12px', bottom: '12px',
      background: 'rgba(38,44,52,0.97)', borderRadius: '14px', padding: '14px',
      boxShadow: '0 6px 20px rgba(0,0,0,0.35)', boxSizing: 'border-box',
      maxHeight: '60%', display: 'flex', flexDirection: 'column'
    });
    card.appendChild(el('div', {
      fontSize: '14px', fontWeight: '600', color: '#2ea44f', marginBottom: '8px',
      paddingRight: '28px'
    }, '✓ 处理完成（' + paths.length + ' 个文件）'));
    // 右上角关闭叉号：关闭后回到编辑面板，可再次编辑
    var closeBtn = el('div', {
      position: 'absolute', top: '8px', right: '8px', width: '24px', height: '24px',
      borderRadius: '50%', background: 'rgba(255,255,255,0.08)', color: '#c8c8c8',
      fontSize: '18px', lineHeight: '22px', textAlign: 'center', cursor: 'pointer'
    }, '×');
    closeBtn.onclick = function () {
      if (card.parentNode) card.parentNode.removeChild(card);
    };
    card.appendChild(closeBtn);
    card.id = 'editor-output';
    var list = el('div', { overflowY: 'auto', flex: '1' });
    paths.forEach(function (p) { list.appendChild(resultRow(p, baseName(p))); });
    card.appendChild(list);
    body.appendChild(card);
  }

  // ============ 工具实现 ============

  // 合并（多文件）
  function renderMerge() {
    var paths = MULTI.slice();
    if (!paths.length && SINGLE) { paths = [SINGLE]; }

    var listBox = el('div', { marginBottom: '16px' });

    function paintList() {
      while (listBox.firstChild) { listBox.removeChild(listBox.firstChild); }
      if (paths.length === 0) {
        listBox.appendChild(el('div', {
          fontSize: '13px', color: '#9aa0a6', padding: '20px 0', textAlign: 'center'
        }, '还没有选择 PDF，请先返回选择或导入'));
        return;
      }
      paths.forEach(function (p, idx) {
        var row = el('div', {
          display: 'flex', alignItems: 'center', padding: '10px 12px', marginBottom: '8px',
          background: '#2b2b2b', borderRadius: '10px', border: '1px solid #3a3a3a'
        });
        row.appendChild(el('div', {
          width: '22px', color: '#5aa9ff', fontSize: '13px', fontWeight: '600'
        }, (idx + 1) + ''));
        row.appendChild(el('div', {
          flex: '1', color: '#f2f2f2', fontSize: '14px',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginRight: '8px'
        }, baseName(p)));
        var up = el('button', btnMini(), '↑');
        up.onclick = function () {
          if (idx > 0) { var t = paths[idx]; paths[idx] = paths[idx - 1]; paths[idx - 1] = t; paintList(); }
        };
        var down = el('button', btnMini(), '↓');
        down.onclick = function () {
          if (idx < paths.length - 1) { var t = paths[idx]; paths[idx] = paths[idx + 1]; paths[idx + 1] = t; paintList(); }
        };
        var del = el('button', btnMini('#e5534b'), '✕');
        del.onclick = function () {
          paths.splice(idx, 1); paintList();
        };
        row.appendChild(up); row.appendChild(down); row.appendChild(del);
        listBox.appendChild(row);
      });
    }

    function btnMini(color) {
      return {
        width: '30px', height: '30px', marginLeft: '6px', borderRadius: '6px',
        border: '1px solid #444', background: '#1f1f1f', color: color || '#cfcfcf',
        fontSize: '14px', cursor: 'pointer'
      };
    }

    var nameInput = textInput('输出文件名（含.pdf）', 'merged_' + Date.now() + '.pdf');
    var runBtn = actionButton('开始合并');

    runBtn.onclick = async function () {
      if (paths.length < 2) { banner('请至少选择 2 个 PDF', 'warn'); return; }
      var name = nameInput.value.trim();
      if (!name) { name = 'merged_' + Date.now() + '.pdf'; }
      if (!/\.pdf$/i.test(name)) { name += '.pdf'; }
      setRunning(runBtn, true, '开始合并');
      try {
        var out = await window.pdfEditor.mergePDFs(paths, name);
        toast('合并完成');
        renderResult(out, baseName(out));
      } catch (e) {
        banner('合并失败：' + (e.message || e), 'err');
        toast('合并失败');
      } finally {
        setRunning(runBtn, false, '开始合并');
      }
    };

    paintList();
    var children = [titleEl('合并 PDF'), descEl('按当前顺序将多个 PDF 合并为一个文件。可用 ↑ ↓ 调整顺序，✕ 移除。')];
    children.push(field('PDF 列表（按顺序合并）', listBox));
    children.push(field('输出文件名', nameInput));
    children.push(runBtn);
    body.appendChild(scrollArea(children));
  }

  // 拆分（单文件，按范围 / 按每 N 页）
  async function renderSplit() {
    var path = SINGLE;
    var total = await getTotal(path);

    var mode = selectInput([
      { label: '按范围拆分', value: 'range' },
      { label: '按每 N 页平均拆分', value: 'every' }
    ], 'range');
    var rangeInput = textInput('页范围，如 1-3,5', '');
    var everyInput = numberInput(1, 1, total || 9999);
    everyInput.style.display = 'none';
    mode.onchange = function () {
      rangeInput.style.display = (mode.value === 'range') ? 'block' : 'none';
      everyInput.style.display = (mode.value === 'every') ? 'block' : 'none';
    };
    var prefixInput = textInput('输出文件名前缀', 'split_' + Date.now());

    var runBtn = actionButton('开始拆分');
    runBtn.onclick = async function () {
      if (!path) { banner('未指定 PDF 文件', 'err'); return; }
      var ranges;
      if (mode.value === 'every') {
        var n = parseInt(everyInput.value, 10);
        if (isNaN(n) || n < 1) { banner('每 N 页需为正整数', 'warn'); return; }
        if (!total) { banner('无法读取页数，无法按每 N 页拆分', 'warn'); return; }
        ranges = [];
        for (var s = 1; s <= total; s += n) {
          var e = Math.min(s + n - 1, total);
          ranges.push([s, e]);
        }
      } else {
        var pr = parseRanges(rangeInput.value);
        if (!pr.ok) { banner(pr.msg, 'warn'); return; }
        ranges = pr.ranges;
      }
      setRunning(runBtn, true, '开始拆分');
      try {
        var prefix = prefixInput.value.trim() || ('split_' + Date.now());
        var out = await window.pdfEditor.splitPDF(path, ranges, prefix);
        toast('拆分完成');
        renderResultList(out);
      } catch (e) {
        banner('拆分失败：' + (e.message || e), 'err');
        toast('拆分失败');
      } finally {
        setRunning(runBtn, false, '开始拆分');
      }
    };

    var children = [
      titleEl('拆分 PDF'),
      descEl('将一个 PDF 按指定范围拆成多个文件。'),
      fileNote(path),
      totalInfo(total),
      field('拆分方式', mode),
      field('页范围', rangeInput, '用逗号分隔范围，如 1-3,5 表示第 1-3 页与第 5 页各自成文件'),
      field('每 N 页', everyInput, '将文档按每 N 页切分为一段'),
      field('输出文件名前缀', prefixInput, '结果形如 prefix_1.pdf、prefix_2.pdf'),
      runBtn
    ];
    body.appendChild(scrollArea(children));
  }

  // 删除页面（单文件）
  async function renderDelete() {
    var path = SINGLE;
    var total = await getTotal(path);
    var pageInput = textInput('要删除的页码', '');
    var runBtn = actionButton('开始删除');

    runBtn.onclick = async function () {
      if (!path) { banner('未指定 PDF 文件', 'err'); return; }
      var pr = parsePages(pageInput.value, total);
      if (!pr.ok) { banner(pr.msg, 'warn'); return; }
      setRunning(runBtn, true, '开始删除');
      try {
        var out = await window.pdfEditor.deletePages(path, pr.pages);
        toast('删除完成');
        renderResult(out, baseName(out));
      } catch (e) {
        banner('删除失败：' + (e.message || e), 'err');
        toast('删除失败');
      } finally {
        setRunning(runBtn, false, '开始删除');
      }
    };

    body.appendChild(scrollArea([
      titleEl('删除页面'),
      descEl('永久删除指定页码，生成新文件（保留原件）。'),
      fileNote(path),
      totalInfo(total),
      field('要删除的页码', pageInput, '如 1,3,5 或 1-3'),
      runBtn
    ]));
  }

  // 重排页面（单文件）
  async function renderReorder() {
    var path = SINGLE;
    var total = await getTotal(path);

    var order = [];
    for (var i = 1; i <= Math.max(total, 0); i++) { order.push(i); }

    var listBox = el('div', { marginBottom: '16px' });

    function btnMini(color) {
      return {
        width: '30px', height: '30px', marginLeft: '6px', borderRadius: '6px',
        border: '1px solid #444', background: '#1f1f1f', color: color || '#cfcfcf',
        fontSize: '14px', cursor: 'pointer'
      };
    }

    function paintList() {
      while (listBox.firstChild) { listBox.removeChild(listBox.firstChild); }
      if (order.length === 0 && total > 0) { for (var k = 1; k <= total; k++) { order.push(k); } }
      order.forEach(function (pg, idx) {
        var row = el('div', {
          display: 'flex', alignItems: 'center', padding: '10px 12px', marginBottom: '8px',
          background: '#2b2b2b', borderRadius: '10px', border: '1px solid #3a3a3a'
        });
        row.appendChild(el('div', {
          width: '22px', color: '#5aa9ff', fontSize: '13px', fontWeight: '600'
        }, (idx + 1) + ''));
        row.appendChild(el('div', {
          flex: '1', color: '#f2f2f2', fontSize: '14px'
        }, '第 ' + pg + ' 页'));
        var up = el('button', btnMini(), '↑');
        up.onclick = function () {
          if (idx > 0) { var t = order[idx]; order[idx] = order[idx - 1]; order[idx - 1] = t; paintList(); }
        };
        var down = el('button', btnMini(), '↓');
        down.onclick = function () {
          if (idx < order.length - 1) { var t = order[idx]; order[idx] = order[idx + 1]; order[idx + 1] = t; paintList(); }
        };
        row.appendChild(up); row.appendChild(down);
        listBox.appendChild(row);
      });
    }

    var runBtn = actionButton('开始重排');
    runBtn.onclick = async function () {
      if (!path) { banner('未指定 PDF 文件', 'err'); return; }
      setRunning(runBtn, true, '开始重排');
      try {
        var out = await window.pdfEditor.reorderPages(path, order.slice());
        toast('重排完成');
        renderResult(out, baseName(out));
      } catch (e) {
        banner('重排失败：' + (e.message || e), 'err');
        toast('重排失败');
      } finally {
        setRunning(runBtn, false, '开始重排');
      }
    };

    paintList();
    var children = [
      titleEl('重排页面'),
      descEl('调整页面顺序后生成新文件（保留原件）。可用 ↑ ↓ 调整顺序。'),
      fileNote(path),
      totalInfo(total),
      field('新顺序（自上而下）', listBox),
      runBtn
    ];
    body.appendChild(scrollArea(children));
  }

  // 旋转页面（单文件）
  async function renderRotate() {
    var path = SINGLE;
    var total = await getTotal(path);
    var pageInput = textInput('要旋转的页码（留空=全部）', '');
    var angle = selectInput([
      { label: '顺时针 90°', value: '90' },
      { label: '顺时针 180°', value: '180' },
      { label: '顺时针 270°', value: '270' }
    ], '90');
    var runBtn = actionButton('开始旋转');

    runBtn.onclick = async function () {
      if (!path) { banner('未指定 PDF 文件', 'err'); return; }
      var pr = parsePagesOrAll(pageInput.value, total);
      if (!pr.ok) { banner(pr.msg, 'warn'); return; }
      setRunning(runBtn, true, '开始旋转');
      try {
        var out = await window.pdfEditor.rotatePages(path, pr.pages, parseInt(angle.value, 10));
        toast('旋转完成');
        renderResult(out, baseName(out));
      } catch (e) {
        banner('旋转失败：' + (e.message || e), 'err');
        toast('旋转失败');
      } finally {
        setRunning(runBtn, false, '开始旋转');
      }
    };

    body.appendChild(scrollArea([
      titleEl('旋转页面'),
      descEl('永久旋转页面（在原角度上累加），生成新文件（保留原件）。'),
      fileNote(path),
      totalInfo(total),
      field('要旋转的页码', pageInput, '如 1,3 或 1-3；留空表示旋转全部页面'),
      field('旋转角度', angle),
      runBtn
    ]));
  }

  // 插入页面（多文件：前者为目标，后者为源）
  async function renderInsert() {
    var paths = MULTI.slice();
    if (paths.length < 2) {
      banner('插入工具需要选择 2 个 PDF（前者为目标，后者为源）。请返回重新选择。', 'warn');
      return;
    }
    var targetIdx = 0, sourceIdx = 1;

    var chipBox = el('div', { marginBottom: '14px' });
    var posInput = numberInput(0, 0, 9999);
    var srcPagesInput = textInput('源文件页码（留空=全部）', '');
    var runBtn = actionButton('开始插入');

    async function refresh() {
      var targetTotal = await getTotal(paths[targetIdx]);
      var sourceTotal = await getTotal(paths[sourceIdx]);
      if (targetTotal) { posInput.max = String(targetTotal); }
      while (chipBox.firstChild) { chipBox.removeChild(chipBox.firstChild); }
      var tRow = el('div', {
        display: 'flex', alignItems: 'center', padding: '10px 12px', marginBottom: '8px',
        background: '#2b2b2b', borderRadius: '10px', border: '1px solid #5aa9ff'
      });
      tRow.appendChild(el('div', { flex: '1', color: '#f2f2f2', fontSize: '14px' }, '目标：' + baseName(paths[targetIdx])));
      var swap = el('button', miniBtn('#3a3f47'), '⇄ 交换');
      swap.onclick = async function () {
        var a = targetIdx; targetIdx = sourceIdx; sourceIdx = a;
        await refresh();
      };
      tRow.appendChild(swap);
      chipBox.appendChild(tRow);
      var sRow = el('div', {
        display: 'flex', alignItems: 'center', padding: '10px 12px', marginBottom: '8px',
        background: '#2b2b2b', borderRadius: '10px', border: '1px solid #444'
      });
      sRow.appendChild(el('div', { flex: '1', color: '#f2f2f2', fontSize: '14px' },
        '源：' + baseName(paths[sourceIdx]) + (sourceTotal ? ('（' + sourceTotal + ' 页）') : '')));
      chipBox.appendChild(sRow);
      return sourceTotal;
    }

    runBtn.onclick = async function () {
      var sourceTotal = await getTotal(paths[sourceIdx]);
      var after = parseInt(posInput.value, 10);
      if (isNaN(after) || after < 0) { after = 0; }
      var sp = parsePagesOrAll(srcPagesInput.value, sourceTotal);
      if (!sp.ok) { banner(sp.msg, 'warn'); return; }
      setRunning(runBtn, true, '开始插入');
      try {
        var out = await window.pdfEditor.insertPages(paths[targetIdx], paths[sourceIdx], after, sp.pages);
        toast('插入完成');
        renderResult(out, baseName(out));
      } catch (e) {
        banner('插入失败：' + (e.message || e), 'err');
        toast('插入失败');
      } finally {
        setRunning(runBtn, false, '开始插入');
      }
    };

    await refresh();
    body.appendChild(scrollArea([
      titleEl('插入页面'),
      descEl('将源 PDF 的指定页面插入到目标 PDF 的指定位置（生成新文件，保留原件）。'),
      chipBox,
      field('插入到目标第几页之后', posInput, '0 表示插入到文件开头；留空默认 0'),
      field('源文件页码', srcPagesInput, '如 1,3 或 1-3；留空表示插入源文件全部页面'),
      runBtn
    ]));
  }

  // 提取页面（单文件）
  async function renderExtract() {
    var path = SINGLE;
    var total = await getTotal(path);
    var pageInput = textInput('要提取的页码', '');
    var separate = checkboxInput('每页单独保存为一个文件', false);
    var prefixInput = textInput('输出文件名前缀', 'extract_' + Date.now());
    var runBtn = actionButton('开始提取');

    runBtn.onclick = async function () {
      if (!path) { banner('未指定 PDF 文件', 'err'); return; }
      var pr = parsePagesOrAll(pageInput.value, total);
      if (!pr.ok) { banner(pr.msg, 'warn'); return; }
      setRunning(runBtn, true, '开始提取');
      try {
        var prefix = prefixInput.value.trim() || ('extract_' + Date.now());
        var out = await window.pdfEditor.extractPages(path, pr.pages, separate.input.checked, prefix);
        toast('提取完成');
        if (out.length === 1) { renderResult(out[0], baseName(out[0])); }
        else { renderResultList(out); }
      } catch (e) {
        banner('提取失败：' + (e.message || e), 'err');
        toast('提取失败');
      } finally {
        setRunning(runBtn, false, '开始提取');
      }
    };

    body.appendChild(scrollArea([
      titleEl('提取页面'),
      descEl('将指定页面提取为独立 PDF。'),
      fileNote(path),
      totalInfo(total),
      field('要提取的页码', pageInput, '如 1,3,5 或 1-3；留空表示全部'),
      separate.wrap,
      field('输出文件名前缀', prefixInput, '结果形如 prefix.pdf 或 prefix_p3.pdf'),
      runBtn
    ]));
  }

  // 文字标注（单文件）
  async function renderText() {
    var path = SINGLE;
    var total = await getTotal(path);
    var pageInput = numberInput(1, 1, total || 9999);
    var textArea = textAreaInput('输入要添加的文字', '');

    // 以页面尺寸（pt）作为坐标滑杆范围；若获取失败回退到 A4
    var pageSize = { width: 595, height: 842 };
    try {
      var ps = await window.pdfEditor.getPageSize(path, 1);
      if (ps && ps.width) { pageSize = ps; }
    } catch (e) { /* 用默认 A4 尺寸 */ }

    var xCtrl = coordControl(50, Math.round(pageSize.width));
    var yCtrl = coordControl(50, Math.round(pageSize.height));
    // 页码变更时刷新滑杆范围（混合尺寸文档也能正确对应）
    pageInput.addEventListener('change', async function () {
      var pg = parseInt(pageInput.value, 10);
      if (isNaN(pg) || pg < 1) return;
      try {
        var ps2 = await window.pdfEditor.getPageSize(path, pg);
        if (ps2 && ps2.width) {
          xCtrl.setMax(Math.round(ps2.width));
          yCtrl.setMax(Math.round(ps2.height));
        }
      } catch (e) { /* 保留上一页尺寸 */ }
    });

    var sizeInput = numberInput(24, 1, 300);
    var colorCtl = colorInput('#000000');
    var chinese = checkboxInput('中文内容（使用内嵌中文字体）', true);
    var runBtn = actionButton('开始添加');

    runBtn.onclick = async function () {
      if (!path) { banner('未指定 PDF 文件', 'err'); return; }
      var pg = parseInt(pageInput.value, 10);
      if (isNaN(pg) || pg < 1) { banner('页码无效', 'warn'); return; }
      if (total && pg > total) { banner('页码超出范围（共 ' + total + ' 页）', 'warn'); return; }
      var txt = textArea.value;
      if (!txt.trim()) { banner('请填写要添加的文字', 'warn'); return; }
      setRunning(runBtn, true, '开始添加');
      try {
        var out = await window.pdfEditor.addText(path, pg, txt, {
          x: parseFloat(xCtrl.input.value) || 0,
          y: parseFloat(yCtrl.input.value) || 0,
          fontSize: parseFloat(sizeInput.value) || 24,
          color: colorCtl.value,
          isChinese: chinese.input.checked
        });
        toast('添加完成');
        renderResult(out, baseName(out));
      } catch (e) {
        banner('添加失败：' + (e.message || e), 'err');
        toast('添加失败');
      } finally {
        setRunning(runBtn, false, '开始添加');
      }
    };

    body.appendChild(scrollArea([
      titleEl('文字标注'),
      descEl('在指定页面绘制文字（生成新文件，保留原件）。坐标系原点在页面左下角。'),
      fileNote(path),
      totalInfo(total),
      field('页码', pageInput),
      field('文字内容', textArea),
      field('横坐标 X', xCtrl.wrap, '页面左下角为原点 (0,0)，拖动滑杆或输入数值定位'),
      field('纵坐标 Y', yCtrl.wrap, '拖动滑杆或输入数值定位'),
      field('字号', sizeInput),
      field('颜色', colorCtl),
      chinese.wrap,
      runBtn
    ]));
  }

  // 水印（单文件）
  async function renderWatermark() {
    var path = SINGLE;
    var textInputEl = textInput('水印文字', '机密');
    var mode = selectInput([
      { label: '平铺（铺满整页）', value: 'tile' },
      { label: '居中（单行）', value: 'center' },
      { label: '顶部居中', value: 'top' },
      { label: '底部居中', value: 'bottom' },
      { label: '对角（斜向重复）', value: 'diagonal' }
    ], 'tile');
    var sizeInput = numberInput(48, 1, 300);
    var angleInput = numberInput(45, 0, 360);
    var opacityInput = numberInput(0.3, 0, 1);
    var colorCtl = colorInput('#FF0000');
    var chinese = checkboxInput('中文内容（使用内嵌中文字体）', true);
    var runBtn = actionButton('开始添加');

    runBtn.onclick = async function () {
      if (!path) { banner('未指定 PDF 文件', 'err'); return; }
      var txt = textInputEl.value;
      if (!txt.trim()) { banner('请填写水印文字', 'warn'); return; }
      setRunning(runBtn, true, '开始添加');
      try {
        var out = await window.pdfEditor.addWatermark(path, txt, {
          position: mode.value,
          fontSize: parseFloat(sizeInput.value) || 48,
          rotation: parseFloat(angleInput.value) || 45,
          opacity: parseFloat(opacityInput.value),
          color: colorCtl.value,
          isChinese: chinese.input.checked
        });
        toast('水印完成');
        renderResult(out, baseName(out));
      } catch (e) {
        banner('水印失败：' + (e.message || e), 'err');
        toast('水印失败');
      } finally {
        setRunning(runBtn, false, '开始添加');
      }
    };

    body.appendChild(scrollArea([
      titleEl('添加水印'),
      descEl('为全部页面添加文字水印（生成新文件，保留原件）。'),
      fileNote(path),
      field('水印文字', textInputEl),
      field('水印位置', mode),
      field('字号', sizeInput),
      field('旋转角度', angleInput),
      field('不透明度（0-1）', opacityInput),
      field('颜色', colorCtl),
      chinese.wrap,
      runBtn
    ]));
  }

  // 加密（单文件）
  function renderEncrypt() {
    var path = SINGLE;
    var userInput = textInput('打开密码（必填）', '');
    userInput.type = 'password';
    var ownerInput = textInput('权限密码（可选）', '');
    ownerInput.type = 'password';
    var algo = selectInput(ALGO_OPTS, 'aes256');
    var runBtn = actionButton('开始加密');

    runBtn.onclick = async function () {
      if (!path) { banner('未指定 PDF 文件', 'err'); return; }
      var pwd = userInput.value;
      if (!pwd) { banner('请填写打开密码', 'warn'); return; }
      setRunning(runBtn, true, '开始加密');
      try {
        var out = await window.pdfEditor.encryptPDF(path, {
          userPassword: pwd,
          ownerPassword: ownerInput.value || '',
          algorithm: algo.value
        });
        toast('加密完成');
        renderResult(out, baseName(out));
      } catch (e) {
        banner('加密失败：' + (e.message || e), 'err');
        toast('加密失败');
      } finally {
        setRunning(runBtn, false, '开始加密');
      }
    };

    body.appendChild(scrollArea([
      titleEl('加密 PDF'),
      descEl('为 PDF 设置打开密码，生成新加密文件（保留原件）。'),
      fileNote(path),
      field('打开密码', userInput, '打开文件时需要输入'),
      field('权限密码（可选）', ownerInput, '用于限制打印/编辑等权限'),
      field('加密算法', algo),
      runBtn
    ]));
  }

  // 解密（单文件）
  function renderDecrypt() {
    var path = SINGLE;
    var pwdInput = textInput('打开密码', window.pdfEditor && window.pdfEditor.password ? window.pdfEditor.password : '');
    pwdInput.type = 'password';
    var runBtn = actionButton('开始解密');

    runBtn.onclick = async function () {
      if (!path) { banner('未指定 PDF 文件', 'err'); return; }
      var pwd = pwdInput.value;
      if (!pwd) { banner('请填写打开密码', 'warn'); return; }
      setRunning(runBtn, true, '开始解密');
      try {
        var out = await window.pdfEditor.decryptPDF(path, pwd);
        toast('解密完成');
        renderResult(out, baseName(out));
      } catch (e) {
        banner('解密失败：' + (e.message || e), 'err');
        toast('解密失败');
      } finally {
        setRunning(runBtn, false, '开始解密');
      }
    };

    body.appendChild(scrollArea([
      titleEl('解密 PDF'),
      descEl('移除 PDF 的打开密码，生成无密码的新文件（保留原件）。'),
      fileNote(path),
      field('打开密码', pwdInput, '当前文件的打开密码'),
      runBtn
    ]));
  }

  // 权限设置（单文件）
  function renderPermission() {
    var path = SINGLE;
    var userInput = textInput('打开密码（可选）', '');
    userInput.type = 'password';
    var ownerInput = textInput('权限密码（可选，建议填写）', '');
    ownerInput.type = 'password';
    var algo = selectInput(ALGO_OPTS, 'aes256');
    var cPrint = checkboxInput('允许打印', true);
    var cModify = checkboxInput('允许修改', true);
    var cCopy = checkboxInput('允许复制', true);
    var cAnnotate = checkboxInput('允许批注', true);
    var runBtn = actionButton('开始设置');

    runBtn.onclick = async function () {
      if (!path) { banner('未指定 PDF 文件', 'err'); return; }
      if (!userInput.value && !ownerInput.value) {
        banner('请至少填写一个密码（打开密码或权限密码）', 'warn');
        return;
      }
      setRunning(runBtn, true, '开始设置');
      try {
        var out = await window.pdfEditor.setPermissions(path, {
          userPassword: userInput.value || '',
          ownerPassword: ownerInput.value || '',
          algorithm: algo.value,
          printing: cPrint.input.checked,
          modifying: cModify.input.checked,
          copying: cCopy.input.checked,
          annotating: cAnnotate.input.checked
        });
        toast('权限设置完成');
        renderResult(out, baseName(out));
      } catch (e) {
        banner('设置失败：' + (e.message || e), 'err');
        toast('设置失败');
      } finally {
        setRunning(runBtn, false, '开始设置');
      }
    };

    body.appendChild(scrollArea([
      titleEl('权限设置'),
      descEl('加密并施加权限限制（未勾选的权限将被禁止）。'),
      fileNote(path),
      field('打开密码（可选）', userInput, '设置后打开文件需输入'),
      field('权限密码（可选）', ownerInput, '用于保护权限设置，建议填写'),
      field('加密算法', algo),
      cPrint.wrap, cModify.wrap, cCopy.wrap, cAnnotate.wrap,
      runBtn
    ]));
  }

  // 双密码（单文件）
  function renderDual() {
    var path = SINGLE;
    var userInput = textInput('打开密码（必填）', '');
    userInput.type = 'password';
    var ownerInput = textInput('权限密码（必填）', '');
    ownerInput.type = 'password';
    var algo = selectInput(ALGO_OPTS, 'aes256');
    var runBtn = actionButton('开始保护');

    runBtn.onclick = async function () {
      if (!path) { banner('未指定 PDF 文件', 'err'); return; }
      if (!userInput.value) { banner('请填写打开密码', 'warn'); return; }
      if (!ownerInput.value) { banner('请填写权限密码', 'warn'); return; }
      setRunning(runBtn, true, '开始保护');
      try {
        var out = await window.pdfEditor.protectDual(path, {
          userPassword: userInput.value,
          ownerPassword: ownerInput.value,
          algorithm: algo.value
        });
        toast('双密码保护完成');
        renderResult(out, baseName(out));
      } catch (e) {
        banner('保护失败：' + (e.message || e), 'err');
        toast('保护失败');
      } finally {
        setRunning(runBtn, false, '开始保护');
      }
    };

    body.appendChild(scrollArea([
      titleEl('双密码保护'),
      descEl('同时设置打开密码与权限密码（二者均需填写）。'),
      fileNote(path),
      field('打开密码', userInput, '打开文件时需要输入'),
      field('权限密码', ownerInput, '用于限制打印/编辑等权限'),
      field('加密算法', algo),
      runBtn
    ]));
  }

  // ============ V1.3 工具与转换面板 ============

  var IMG_FMT_OPTS = [
    { value: 'png', label: 'PNG（无损，体积较大）' },
    { value: 'jpeg', label: 'JPEG（体积小，适合照片/扫描件）' }
  ];
  var DPI_OPTS = [
    { value: '96', label: '96 DPI（屏幕预览，最快）' },
    { value: '150', label: '150 DPI（推荐）' },
    { value: '200', label: '200 DPI（清晰）' },
    { value: '300', label: '300 DPI（高清，体积大）' }
  ];

  // 页面转图片（V1.3 故事 #053）：可指定页码，导出 PNG/JPEG
  async function renderPageToImage() {
    var path = SINGLE;
    var total = await getTotal(path);
    var pagesInput = textInput('留空=全部页，如 1,3,5', '');
    var fmtSel = selectInput(IMG_FMT_OPTS, 'png');
    var dpiSel = selectInput(DPI_OPTS, '150');
    var runBtn = actionButton('导出图片');

    runBtn.onclick = async function () {
      if (!path) { banner('未指定 PDF 文件', 'err'); return; }
      var parsed = parsePagesOrAll(pagesInput.value, total);
      if (!parsed.ok) { banner(parsed.msg, 'warn'); return; }
      setRunning(runBtn, true, '导出图片');
      try {
        var out = await window.pdfEditor.pagesToImages(path, {
          pages: parsed.pages,
          format: fmtSel.value,
          dpi: parseInt(dpiSel.value, 10),
          onProgress: function (cur, tot, msg) { setRunning(runBtn, true, msg || '导出中'); }
        });
        toast('已导出 ' + out.count + ' 张');
        renderResultList(out.paths);
      } catch (e) {
        banner('导出失败：' + (e.message || e), 'err');
        toast('导出失败');
      } finally {
        setRunning(runBtn, false, '导出图片');
      }
    };

    body.appendChild(scrollArea([
      titleEl('页面转图片'),
      descEl('把指定页面渲染成图片导出到「图片」目录，可单选页码，适合插图、截图存档。'),
      fileNote(path),
      totalInfo(total),
      field('页码范围', pagesInput, '留空表示导出全部页面'),
      field('图片格式', fmtSel),
      field('渲染精度', dpiSel, '精度越高越清晰，文件也越大'),
      runBtn
    ]));
  }

  // PDF 转图片（V1.3 故事 #059）：整本逐页导出
  async function renderPdfToImage() {
    var path = SINGLE;
    var total = await getTotal(path);
    var fmtSel = selectInput(IMG_FMT_OPTS, 'jpeg');
    var dpiSel = selectInput(DPI_OPTS, '150');
    var runBtn = actionButton('整本转图片');

    runBtn.onclick = async function () {
      if (!path) { banner('未指定 PDF 文件', 'err'); return; }
      setRunning(runBtn, true, '转换中');
      try {
        var out = await window.pdfEditor.pagesToImages(path, {
          format: fmtSel.value,
          dpi: parseInt(dpiSel.value, 10),
          quality: 90,
          onProgress: function (cur, tot, msg) { setRunning(runBtn, true, msg || '转换中'); }
        });
        toast('已导出 ' + out.count + ' 张');
        renderResultList(out.paths);
      } catch (e) {
        banner('转换失败：' + (e.message || e), 'err');
        toast('转换失败');
      } finally {
        setRunning(runBtn, false, '整本转图片');
      }
    };

    body.appendChild(scrollArea([
      titleEl('PDF 转图片'),
      descEl('把整份 PDF 逐页渲染为图片，一页一张，导出到「图片」目录。原件保留。'),
      fileNote(path),
      totalInfo(total),
      field('图片格式', fmtSel),
      field('渲染精度', dpiSel, '精度越高越清晰，文件也越大'),
      runBtn
    ]));
  }

  // PDF 压缩（V1.3 故事 #054）
  async function renderCompress() {
    var path = SINGLE;
    var total = await getTotal(path);
    var modeSel = selectInput([
      { value: 'lossless', label: '无损（重建对象流，保留文本层）' },
      { value: 'lossy', label: '有损（重压为 JPEG，体积降幅大，丢失文本层）' }
    ], 'lossless');
    var dpiSel = selectInput(DPI_OPTS, '120');
    var qualityInput = textInput('70', '70');
    var runBtn = actionButton('开始压缩');

    function fmtSize(n) {
      if (!n) { return '0 B'; }
      if (n < 1024) { return n + ' B'; }
      if (n < 1024 * 1024) { return (n / 1024).toFixed(1) + ' KB'; }
      return (n / 1048576).toFixed(2) + ' MB';
    }

    runBtn.onclick = async function () {
      if (!path) { banner('未指定 PDF 文件', 'err'); return; }
      var opts = { mode: modeSel.value };
      if (modeSel.value === 'lossy') {
        opts.dpi = parseInt(dpiSel.value, 10);
        opts.quality = Math.max(10, Math.min(100, parseInt(qualityInput.value, 10) || 70));
      }
      setRunning(runBtn, true, '压缩中');
      try {
        var out = await window.pdfEditor.compressPdf(path, Object.assign(opts, {
          onProgress: function (cur, tot, msg) { setRunning(runBtn, true, msg || '压缩中'); }
        }));
        var pct = (out.ratio * 100).toFixed(1);
        banner(out.ratio > 0
          ? `压缩完成：${fmtSize(out.before)} → ${fmtSize(out.after)}（减少 ${pct}%）`
          : `处理完成：${fmtSize(out.before)} → ${fmtSize(out.after)}（体积未减小，可尝试有损模式）`, 'ok');
        toast('压缩完成');
        renderResult(out.path, baseName(out.path));
      } catch (e) {
        banner('压缩失败：' + (e.message || e), 'err');
        toast('压缩失败');
      } finally {
        setRunning(runBtn, false, '开始压缩');
      }
    };

    body.appendChild(scrollArea([
      titleEl('PDF 压缩'),
      descEl('无损模式重建对象流、去除冗余，保留文本可选中；有损模式按精度重压为 JPEG，体积降幅大但会丢失文本层。'),
      fileNote(path),
      totalInfo(total),
      field('压缩方式', modeSel),
      field('有损渲染精度', dpiSel, '仅在有损模式生效'),
      field('有损图片质量', qualityInput, '10-100，仅在有损模式生效；70 左右肉眼几乎无损'),
      runBtn
    ]));
  }

  // 缩略图批量生成（V1.3 故事 #055）
  async function renderThumbnails() {
    var path = SINGLE;
    var total = await getTotal(path);
    var widthInput = textInput('200', '200');
    var pagesInput = textInput('留空=全部页', '');
    var runBtn = actionButton('生成缩略图');

    runBtn.onclick = async function () {
      if (!path) { banner('未指定 PDF 文件', 'err'); return; }
      var parsed = parsePagesOrAll(pagesInput.value, total);
      if (!parsed.ok) { banner(parsed.msg, 'warn'); return; }
      var w = parseInt(widthInput.value, 10) || 200;
      setRunning(runBtn, true, '生成中');
      try {
        var out = await window.pdfEditor.generateThumbnails(path, {
          pages: parsed.pages,
          width: w,
          onProgress: function (cur, tot, msg) { setRunning(runBtn, true, msg || '生成中'); }
        });
        toast('已生成 ' + out.count + ' 张');
        banner('缩略图已保存到：' + out.dir + '（共 ' + out.count + ' 张）', 'ok');
        renderResultList(out.paths);
      } catch (e) {
        banner('生成失败：' + (e.message || e), 'err');
        toast('生成失败');
      } finally {
        setRunning(runBtn, false, '生成缩略图');
      }
    };

    body.appendChild(scrollArea([
      titleEl('缩略图批量生成'),
      descEl('批量导出小尺寸页面预览图，可用于目录、附件预览、快速浏览。'),
      fileNote(path),
      totalInfo(total),
      field('缩略图宽度', widthInput, '像素，高度按页面比例自动'),
      field('页码范围', pagesInput, '留空表示全部页面'),
      runBtn
    ]));
  }

  // 图片转 PDF（V1.3 故事 #058）：多张图片合成一份 PDF
  async function renderImagesToPdf() {
    var images = IMAGES.slice();
    var sizeSel = selectInput([
      { value: 'fit', label: '按图片原始尺寸（推荐，不损失清晰度）' },
      { value: 'a4', label: '统一 A4 页面（图片居中缩放）' }
    ], 'fit');
    var titleInput = textInput('可选，作为 PDF 标题', '');
    var runBtn = actionButton('合成 PDF');

    // 局部迷你按钮（与 merge 面板同款，用于列表项的上移/下移/删除）
    function imgBtnMini(color) {
      return {
        width: '30px', height: '30px', marginLeft: '6px', borderRadius: '6px',
        border: '1px solid #444', background: '#1f1f1f', color: color || '#cfcfcf',
        fontSize: '14px', cursor: 'pointer'
      };
    }

    var listBox = el('div', { marginTop: '10px' });
    function paintList() {
      while (listBox.firstChild) { listBox.removeChild(listBox.firstChild); }
      if (!images.length) {
        listBox.appendChild(el('div', {
          fontSize: '13px', color: '#9aa0a6', padding: '16px 0', textAlign: 'center'
        }, '还没有选择图片，请返回重新选择'));
        return;
      }
      images.forEach(function (p, idx) {
        var row = el('div', {
          display: 'flex', alignItems: 'center', padding: '8px 12px', marginBottom: '6px',
          background: '#2b2b2b', borderRadius: '8px', border: '1px solid #3a3a3a'
        });
        row.appendChild(el('div', { width: '22px', color: '#5aa9ff', fontSize: '13px', fontWeight: '600' }, (idx + 1) + ''));
        row.appendChild(el('div', {
          flex: '1', color: '#f2f2f2', fontSize: '13px',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginRight: '8px'
        }, baseName(p)));
        var up = el('button', imgBtnMini(), '↑');
        up.onclick = function () {
          if (idx > 0) { var t = images[idx]; images[idx] = images[idx - 1]; images[idx - 1] = t; paintList(); }
        };
        var down = el('button', imgBtnMini(), '↓');
        down.onclick = function () {
          if (idx < images.length - 1) { var t = images[idx]; images[idx] = images[idx + 1]; images[idx + 1] = t; paintList(); }
        };
        var del = el('button', imgBtnMini('#e5534b'), '✕');
        del.onclick = function () { images.splice(idx, 1); paintList(); };
        row.appendChild(up);
        row.appendChild(down);
        row.appendChild(del);
        listBox.appendChild(row);
      });
    }

    runBtn.onclick = async function () {
      if (!images.length) { banner('请先选择至少一张图片', 'warn'); return; }
      setRunning(runBtn, true, '合成中');
      try {
        var out = await window.pdfEditor.imagesToPdf(images, {
          pageSize: sizeSel.value,
          title: titleInput.value.trim(),
          onProgress: function (cur, tot, msg) { setRunning(runBtn, true, msg || '合成中'); }
        });
        toast('已生成 PDF');
        renderResult(out, baseName(out));
      } catch (e) {
        banner('合成失败：' + (e.message || e), 'err');
        toast('合成失败');
      } finally {
        setRunning(runBtn, false, '合成 PDF');
      }
    };

    body.appendChild(scrollArea([
      titleEl('图片转 PDF'),
      descEl('把多张图片按顺序合成一份 PDF，支持调整顺序。图片按原尺寸嵌入，不损失清晰度。'),
      field('页面尺寸', sizeSel),
      field('PDF 标题', titleInput, '留空则不设置'),
      el('div', { fontSize: '13px', color: '#9aa0a6', marginTop: '12px' }, '已选图片（' + images.length + ' 张，可调整顺序）：'),
      listBox,
      runBtn
    ]));
    paintList();
  }

  // 自动重命名（V1.3 故事 #057）
  async function renderAutoRename() {
    var path = SINGLE;
    var sourceSel = selectInput([
      { value: 'title', label: 'PDF 标题元数据（最快）' },
      { value: 'text', label: '首页首行文字（扫描件走 OCR）' }
    ], 'title');
    var prefixInput = textInput('可选前缀，如 2026-', '');
    var langSel = selectInput(OCR_LANG_OPTS, 'chi_sim+eng');
    var runBtn = actionButton('生成并重命名');

    runBtn.onclick = async function () {
      if (!path) { banner('未指定 PDF 文件', 'err'); return; }
      setRunning(runBtn, true, '识别中');
      try {
        var out = await window.pdfEditor.autoRename(path, {
          source: sourceSel.value,
          prefix: prefixInput.value.trim(),
          langs: langSel.value,
          onProgress: function (cur, tot, msg) { setRunning(runBtn, true, msg || '识别中'); }
        });
        banner('已重命名为：' + out.name, 'ok');
        toast('重命名完成');
      } catch (e) {
        banner('重命名失败：' + (e.message || e), 'err');
        toast('重命名失败');
      } finally {
        setRunning(runBtn, false, '生成并重命名');
      }
    };

    body.appendChild(scrollArea([
      titleEl('自动重命名'),
      descEl('根据文档内容自动生成有意义的文件名：优先取标题元数据，扫描件可取首页文字（需 OCR）。直接重命名原件。'),
      fileNote(path),
      field('命名来源', sourceSel, '标题为空时会自动回退为日期命名'),
      field('文件名前缀', prefixInput, '可选，例如 2026- 便于按年归档'),
      field('识别语言', langSel, '仅在「首页首行文字」模式生效'),
      runBtn
    ]));
  }

  // 打印（V1.3 故事 #056）：调起系统打印服务
  async function renderPrint() {
    var path = SINGLE;
    var total = await getTotal(path);
    var pagesInput = textInput('留空=全部页，如 1,3,5', '');
    var runBtn = actionButton('调起打印');

    runBtn.onclick = async function () {
      if (!path) { banner('未指定 PDF 文件', 'err'); return; }
      var parsed = parsePagesOrAll(pagesInput.value, total);
      if (!parsed.ok) { banner(parsed.msg, 'warn'); return; }
      var isAll = total > 0 && parsed.pages.length === total;
      setRunning(runBtn, true, '准备中');
      try {
        var target = path;
        if (!isAll) {
          // 选定页码：先抽出临时 PDF 再打印（系统打印服务按整个文件输出）
          var outs = await window.pdfEditor.extractPages(path, parsed.pages, false,
            'print_' + baseName(path).replace(/\.pdf$/i, ''));
          target = outs[0];
        }
        if (window.bridge && window.bridge.printFile) {
          window.bridge.printFile(target, baseName(target));
          banner(isAll ? '已调起系统打印服务' : '已按所选页码生成临时文件并调起打印', 'ok');
        } else {
          banner('当前环境不支持打印（缺少打印桥接）', 'warn');
        }
        toast('已调起打印');
      } catch (e) {
        banner('打印失败：' + (e.message || e), 'err');
        toast('打印失败');
      } finally {
        setRunning(runBtn, false, '调起打印');
      }
    };

    body.appendChild(scrollArea([
      titleEl('打印'),
      descEl('调起系统打印服务输出 PDF，可在系统打印面板选择打印机、份数与单双面。仅选部分页码时会先生成临时文件。'),
      fileNote(path),
      totalInfo(total),
      field('打印页码', pagesInput, '留空表示打印全部页面'),
      runBtn
    ]));
  }

  // 工具 id → 中文名（与 ArkTS 侧 PdfTools.ets 的 TOOL_CATEGORIES 保持一致，用于顶栏展示）
  var TOOL_NAMES = {
    merge: '合并', split: '拆分', delete: '删除页面', reorder: '重排', rotate: '旋转',
    insert: '插入', extract: '提取',
    sign: '手写签名', highlight: '高亮标注',
    text: '文字标注', watermark: '水印', stamp: '图片签章', link: '超链接',
    encrypt: '加密', decrypt: '解密', permission: '权限设置', dual: '双密码',
    ocr: '扫描件转可搜索', autorotate: '自动旋转校正', textocr: '提取文字', imgocr: '图片提取文字',
    formcreate: '创建表单字段', formfill: '填写表单', flatten: '展平表单',
    pagetoimg: '页面转图片', compress: 'PDF 压缩', thumbs: '缩略图批量生成', print: '打印',
    rename: '自动重命名', img2pdf: '图片转 PDF', pdftoimg: 'PDF 转图片',
    metadata: '元数据编辑'
  };

  // ============ 分发 ============
  var DISPATCH = {
    merge: renderMerge,
    split: renderSplit,
    delete: renderDelete,
    reorder: renderReorder,
    rotate: renderRotate,
    insert: renderInsert,
    extract: renderExtract,
    text: renderText,
    watermark: renderWatermark,
    encrypt: renderEncrypt,
    decrypt: renderDecrypt,
    permission: renderPermission,
    dual: renderDual,
    ocr: renderOcr,
    autorotate: renderAutoRotate,
    textocr: renderTextOcr,
    imgocr: renderImageOcr,
    stamp: renderStamp,
    link: renderLink,
    formcreate: renderFormCreate,
    formfill: renderFormFill,
    flatten: renderFlatten,
    pagetoimg: renderPageToImage,
    pdftoimg: renderPdfToImage,
    compress: renderCompress,
    thumbs: renderThumbnails,
    img2pdf: renderImagesToPdf,
    rename: renderAutoRename,
    print: renderPrint,
    metadata: renderMetadata
  };

  // OCR：扫描件转可搜索 PDF（V1.2 故事 #34）
  async function renderOcr() {
    var path = SINGLE;
    var total = await getTotal(path);

    var langSel = selectInput(OCR_LANG_OPTS, 'chi_sim+eng');
    var dpiSel = selectInput([
      { value: '150', label: '150 DPI（快，字小易漏）' },
      { value: '200', label: '200 DPI（推荐）' },
      { value: '300', label: '300 DPI（慢，更准）' }
    ], '200');
    var pagesInput = textInput('留空=全部页，如 1-3,5', '');
    // 置信度标注（V1.2 故事 #80）：低置信度行用半透明黄色标出
    var markLow = checkboxInput('标注低置信度文字（黄色高亮，便于人工核对）', true);
    var thrSel = selectInput([
      { value: '50', label: '低于 50%（仅标最不确定处）' },
      { value: '60', label: '低于 60%（推荐）' },
      { value: '75', label: '低于 75%（更严格）' }
    ], '60');
    var runBtn = actionButton('开始识别');
    var statusEl = el('div', {
      fontSize: '13px', color: '#9aa0a6', marginTop: '10px', minHeight: '20px'
    }, '');

    runBtn.onclick = async function () {
      if (!path) { banner('未指定 PDF 文件', 'err'); return; }
      var parsed = parsePagesOrAll(pagesInput.value, total);
      if (!parsed.ok) { banner(parsed.msg, 'warn'); return; }
      setRunning(runBtn, true, '开始识别');
      statusEl.textContent = '正在准备本地识别资源（首次使用需复制到应用目录，约需数秒）…';
      try {
        var res = await window.pdfEditor.ocrPDF(path, {
          langs: langSel.value,
          dpi: parseInt(dpiSel.value, 10) || 200,
          pages: parsed.pages,
          markLowConfidence: markLow.input.checked,
          confidenceThreshold: parseInt(thrSel.value, 10) || 60,
          onProgress: function (done, all, status) {
            statusEl.textContent = status + '（' + done + '/' + all + '）';
          }
        });
        var out = (res && res.path) ? res.path : String(res);
        var st = (res && res.stats) ? res.stats : null;
        if (st && st.lines) {
          statusEl.textContent = '完成 · 平均置信度 ' + st.avgConfidence + '% · 低置信度 ' +
            st.lowLines + ' 行（' + st.lowRatio + '%）' +
            (st.marked ? '（已高亮标出）' : '');
        } else {
          statusEl.textContent = '完成';
        }
        toast('识别完成');
        renderResult(out, baseName(out));
      } catch (e) {
        statusEl.textContent = '';
        banner('识别失败：' + (e.message || e), 'err');
        toast('识别失败');
      } finally {
        setRunning(runBtn, false, '开始识别');
      }
    };

    body.appendChild(scrollArea([
      titleEl('扫描件转可搜索 PDF'),
      descEl('对图片型/扫描件 PDF 逐页 OCR，把识别出的文字写回为不可见文本层，之后即可搜索与复制。生成新文件，保留原件。'),
      fileNote(path),
      totalInfo(total),
      field('识别语言', langSel, OCR_LANG_HINT),
      field('渲染精度', dpiSel),
      field('页码范围', pagesInput, '留空表示处理全部页面'),
      markLow.wrap,
      field('置信度阈值', thrSel, '低于该值的识别结果会被高亮标注'),
      runBtn,
      statusEl
    ]));
  }

  // 自动旋转校正（V1.2 故事 #47）
  // 不用 OSD（需 legacy 引擎 + osd 语言包，多 11.9MB）：改为四方向试识别取置信度最高者
  async function renderAutoRotate() {
    var path = SINGLE;
    var total = await getTotal(path);

    var langSel = selectInput(OCR_LANG_OPTS, 'chi_sim+eng');
    var modeCheck = checkboxInput('整本统一角度（按抽样页的众数应用到全部页）', true);
    var pagesInput = textInput('留空=前 3 页，如 1-5', '');
    var runBtn = actionButton('检测并校正');
    var statusEl = el('div', {
      fontSize: '13px', color: '#9aa0a6', marginTop: '10px', minHeight: '20px'
    }, '');

    runBtn.onclick = async function () {
      if (!path) { banner('未指定 PDF 文件', 'err'); return; }
      var parsed = parsePagesOrAll(pagesInput.value, 0);
      var pages = (parsed && parsed.ok) ? parsed.pages : null;
      if (!pages && pagesInput.value.trim()) { banner(parsed.msg || '页码范围无效', 'warn'); return; }
      setRunning(runBtn, true, '检测并校正');
      statusEl.textContent = '正在准备本地识别资源（首次使用需复制到应用目录，约需数秒）…';
      try {
        var res = await window.pdfEditor.autoRotate(path, {
          langs: langSel.value,
          dpi: 100,
          pages: pages,
          applyToAll: modeCheck.input.checked,
          onProgress: function (done, all, status) {
            statusEl.textContent = status + '（' + done + '/' + all + '）';
          }
        });
        if (!res.path) {
          statusEl.textContent = '未检测到需要校正的方向：页面方向看起来已正确';
          banner('未检测到需要校正的方向（页面方向已正确，或页面几乎没有文字）', 'ok');
          toast('方向已正确');
          return;
        }
        var detail = res.results.map(function (r) {
          return '第 ' + r.page + ' 页 ' + r.applied + '°（置信度 ' + Math.round(r.confidence) + '%）';
        }).join('；');
        statusEl.textContent = (res.perPage ? '已逐页校正：' : ('已整体校正 ' + res.appliedAngle + '°：')) + detail;
        toast('校正完成');
        renderResult(res.path, baseName(res.path));
      } catch (e) {
        statusEl.textContent = '';
        banner('校正失败：' + (e.message || e), 'err');
        toast('校正失败');
      } finally {
        setRunning(runBtn, false, '检测并校正');
      }
    };

    body.appendChild(scrollArea([
      titleEl('自动旋转校正'),
      descEl('检测扫描页的文字方向并把页面转正。默认只检测前 3 页（四方向各试识别一次，取置信度最高的角度），也可指定页码。生成新文件，保留原件。'),
      fileNote(path),
      totalInfo(total),
      field('识别语言', langSel, OCR_LANG_HINT),
      field('检测页码', pagesInput, '留空表示检测前 3 页'),
      modeCheck.wrap,
      runBtn,
      statusEl
    ]));
  }

  // 添加图片 / 签章（V1.2 故事 #100）：先选 PDF，再选图片（由 ArkTS 注入 __STAMP_IMAGE__）
  async function renderStamp() {
    var path = SINGLE;
    var imgPath = (typeof window.__STAMP_IMAGE__ !== 'undefined' && window.__STAMP_IMAGE__)
      ? window.__STAMP_IMAGE__ : '';
    var total = await getTotal(path);

    var pagesInput = textInput('留空=全部页，如 1,3,5', '');
    var xRange = coordControl(75, 100, null);   // 横向位置（% 页宽）
    var yRange = coordControl(20, 100, null);   // 纵向位置（% 页高，0 = 页底）
    var wRange = coordControl(25, 100, null);   // 宽度（% 页宽）
    var opRange = coordControl(100, 100, null); // 不透明度（%）
    var runBtn = actionButton('添加到 PDF');

    function buildFields() {
      return [
        field('横向位置', xRange.wrap, '图片中心距页面左边的百分比'),
        field('纵向位置', yRange.wrap, '图片中心距页面底边的百分比（0 = 页底）'),
        field('图片宽度', wRange.wrap, '占页面宽度的百分比，高度按比例自动'),
        field('不透明度', opRange.wrap, '100% 为完全不透明')
      ];
    }

    runBtn.onclick = async function () {
      if (!path) { banner('未指定 PDF 文件', 'err'); return; }
      if (!imgPath) { banner('未指定签章图片，请返回重新选择', 'err'); return; }
      var parsed = parsePagesOrAll(pagesInput.value, total);
      if (!parsed.ok) { banner(parsed.msg, 'warn'); return; }
      setRunning(runBtn, true, '添加到 PDF');
      try {
        var out = await window.pdfEditor.addImage(path, imgPath, {
          pages: parsed.pages,
          xRatio: (parseFloat(xRange.input.value) || 0) / 100,
          yRatio: (parseFloat(yRange.input.value) || 0) / 100,
          widthRatio: (parseFloat(wRange.input.value) || 25) / 100,
          opacity: (parseFloat(opRange.input.value) || 100) / 100
        });
        toast('已添加');
        renderResult(out, baseName(out));
      } catch (e) {
        banner('添加失败：' + (e.message || e), 'err');
        toast('添加失败');
      } finally {
        setRunning(runBtn, false, '添加到 PDF');
      }
    };

    body.appendChild(scrollArea([
      titleEl('添加图片 / 签章'),
      descEl('把 PNG / JPEG 图片（签名、公章、Logo）叠加到指定页面上。生成新文件，保留原件。'),
      fileNote(path),
      totalInfo(total),
      el('div', { fontSize: '12px', color: '#8a8a8a', marginBottom: '12px' },
        '图片：' + (imgPath ? baseName(imgPath) : '未指定（请返回重新选择）')),
      field('页码范围', pagesInput, '留空表示添加到全部页面')
    ].concat(buildFields()).concat([runBtn])));
  }

  // 添加超链接（V1.2 故事 #101）
  async function renderLink() {
    var path = SINGLE;
    var total = await getTotal(path);

    var pageInput = textInput('默认第 1 页', '1');
    var urlInput = textInput('https://example.com 或 mailto:a@b.com', '');
    var xRange = coordControl(10, 100, null);
    var yRange = coordControl(85, 100, null);
    var wRange = coordControl(30, 100, null);
    var hRange = coordControl(4, 100, null);
    var runBtn = actionButton('添加超链接');

    runBtn.onclick = async function () {
      if (!path) { banner('未指定 PDF 文件', 'err'); return; }
      var n = parseInt(pageInput.value, 10);
      if (isNaN(n) || n < 1 || (total && n > total)) {
        banner('页码无效' + (total ? '（共 ' + total + ' 页）' : ''), 'warn');
        return;
      }
      var url = urlInput.value.trim();
      if (!url) { banner('请填写链接地址', 'warn'); return; }
      setRunning(runBtn, true, '添加超链接');
      try {
        var out = await window.pdfEditor.addLink(path, {
          page: n,
          url: url,
          xRatio: (parseFloat(xRange.input.value) || 0) / 100,
          yRatio: (parseFloat(yRange.input.value) || 0) / 100,
          widthRatio: (parseFloat(wRange.input.value) || 30) / 100,
          heightRatio: (parseFloat(hRange.input.value) || 4) / 100
        });
        toast('已添加');
        renderResult(out, baseName(out));
      } catch (e) {
        banner('添加失败：' + (e.message || e), 'err');
        toast('添加失败');
      } finally {
        setRunning(runBtn, false, '添加超链接');
      }
    };

    body.appendChild(scrollArea([
      titleEl('添加超链接'),
      descEl('在页面上指定区域添加可点击的链接注释（支持 https://、http://、mailto: 等）。生成新文件，保留原件。'),
      fileNote(path),
      totalInfo(total),
      field('页码', pageInput),
      field('链接地址', urlInput, '需带协议前缀，例如 https://'),
      field('区域左边距', xRange.wrap, '占页面宽度的百分比'),
      field('区域下边距', yRange.wrap, '占页面高度的百分比（0 = 页底）'),
      field('区域宽度', wRange.wrap, '占页面宽度的百分比'),
      field('区域高度', hRange.wrap, '占页面高度的百分比'),
      runBtn
    ]));
  }

  // PDF 提取转文字（V1.2 故事 #99）：图片型 PDF → 纯文本 .txt
  async function renderTextOcr() {
    var path = SINGLE;
    var total = await getTotal(path);

    var langSel = selectInput(OCR_LANG_OPTS, 'chi_sim+eng');
    var dpiSel = selectInput([
      { value: '150', label: '150 DPI（快，字小易漏）' },
      { value: '200', label: '200 DPI（推荐）' },
      { value: '300', label: '300 DPI（慢，更准）' }
    ], '200');
    var pagesInput = textInput('留空=全部页，如 1-3,5', '');
    var sepCheck = checkboxInput('每页之间空一行分隔', true);
    var runBtn = actionButton('开始提取');
    var statusEl = el('div', {
      fontSize: '13px', color: '#9aa0a6', marginTop: '10px', minHeight: '20px'
    }, '');

    runBtn.onclick = async function () {
      if (!path) { banner('未指定 PDF 文件', 'err'); return; }
      var parsed = parsePagesOrAll(pagesInput.value, total);
      if (!parsed.ok) { banner(parsed.msg, 'warn'); return; }
      setRunning(runBtn, true, '开始提取');
      statusEl.textContent = '正在准备本地识别资源（首次使用需复制到应用目录，约需数秒）…';
      try {
        var res = await window.pdfEditor.extractText(path, {
          langs: langSel.value,
          dpi: parseInt(dpiSel.value, 10) || 200,
          pages: parsed.pages,
          pageBreak: sepCheck.input.checked,
          onProgress: function (done, all, status) {
            statusEl.textContent = status + '（' + done + '/' + all + '）';
          }
        });
        statusEl.textContent = '';
        toast('提取完成');
        renderTextResult(res.path, res.text, baseName(res.path));
      } catch (e) {
        statusEl.textContent = '';
        banner('提取失败：' + (e.message || e), 'err');
        toast('提取失败');
      } finally {
        setRunning(runBtn, false, '开始提取');
      }
    };

    body.appendChild(scrollArea([
      titleEl('PDF 提取转文字'),
      descEl('对图片型/扫描件 PDF 逐页识别，把文字合并导出为 .txt 纯文本（同时可直接复制）。生成新文件，保留原件。'),
      fileNote(path),
      totalInfo(total),
      field('识别语言', langSel, OCR_LANG_HINT),
      field('渲染精度', dpiSel),
      field('页码范围', pagesInput, '留空表示提取全部页面'),
      sepCheck.wrap,
      runBtn,
      statusEl
    ]));
  }

  // 图片提取文字（V1.2 故事 #35）：直接识别 PNG / JPEG 等图片
  function renderImageOcr() {
    var path = SINGLE;
    var langSel = selectInput(OCR_LANG_OPTS, 'chi_sim+eng');
    var runBtn = actionButton('开始识别');
    var statusEl = el('div', {
      fontSize: '13px', color: '#9aa0a6', marginTop: '10px', minHeight: '20px'
    }, '');

    runBtn.onclick = async function () {
      if (!path) { banner('未指定图片文件', 'err'); return; }
      setRunning(runBtn, true, '开始识别');
      statusEl.textContent = '正在准备本地识别资源（首次使用需复制到应用目录，约需数秒）…';
      try {
        var res = await window.pdfEditor.ocrImage(path, {
          langs: langSel.value,
          onProgress: function (status) { statusEl.textContent = status; }
        });
        statusEl.textContent = '';
        toast('识别完成');
        renderTextResult(res.path, res.text, baseName(res.path));
      } catch (e) {
        statusEl.textContent = '';
        banner('识别失败：' + (e.message || e), 'err');
        toast('识别失败');
      } finally {
        setRunning(runBtn, false, '开始识别');
      }
    };

    body.appendChild(scrollArea([
      titleEl('图片提取文字'),
      descEl('直接识别 PNG / JPEG / WebP / BMP 图片中的文字，无需先转成 PDF。结果可复制，也会导出为 .txt 文件。'),
      fileNote(path),
      field('识别语言', langSel, OCR_LANG_HINT),
      runBtn,
      statusEl
    ]));
  }

  // ============ 表单（V1.3 故事 #050 / #051 / #052） ============

  var FORM_TYPE_LABEL = { text: '文本框', checkbox: '复选框', dropdown: '下拉框' };

  function formTypeLabel(t) {
    return FORM_TYPE_LABEL[t] || t;
  }

  // 创建表单字段（故事 #050）
  async function renderFormCreate() {
    var path = SINGLE;
    var total = await getTotal(path);

    var typeSel = selectInput([
      { value: 'text', label: '单行文本框' },
      { value: 'checkbox', label: '复选框' },
      { value: 'dropdown', label: '下拉框' }
    ], 'text');
    var nameInput = textInput('如：name / 姓名 / agree', '');
    var pageInput = textInput('默认第 1 页', '1');
    var xRange = coordControl(10, 100, null);
    var yRange = coordControl(85, 100, null);
    var wRange = coordControl(40, 100, null);
    var hRange = coordControl(3, 100, null);
    var optInput = textInput('选项1,选项2,选项3', '');
    var optField = field('下拉选项', optInput, '仅下拉框需要，用逗号分隔');
    optField.style.display = 'none';
    typeSel.addEventListener('change', function () {
      optField.style.display = typeSel.value === 'dropdown' ? '' : 'none';
    });

    var fields = [];
    var listBox = el('div', { marginBottom: '10px' });

    function refreshList() {
      while (listBox.firstChild) { listBox.removeChild(listBox.firstChild); }
      if (!fields.length) {
        listBox.appendChild(el('div', { fontSize: '12px', color: '#8a8a8a' }, '（尚未添加字段）'));
        return;
      }
      fields.forEach(function (f, i) {
        var row = el('div', {
          display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 10px',
          marginBottom: '6px', borderRadius: '8px', background: '#2b2b2b',
          fontSize: '13px', color: '#e8e8e8'
        });
        row.appendChild(el('div', { flex: '1' },
          (i + 1) + '. ' + f.name + '（' + formTypeLabel(f.type) + '，第 ' + f.page + ' 页）'));
        var del = el('div', {
          color: '#e5534b', cursor: 'pointer', fontSize: '16px', padding: '0 4px'
        }, '×');
        del.onclick = function () { fields.splice(i, 1); refreshList(); };
        row.appendChild(del);
        listBox.appendChild(row);
      });
    }

    var addBtn = el('button', {
      width: '100%', height: '42px', borderRadius: '10px', border: '1px dashed #5a5a5a',
      background: 'transparent', color: '#9ecbff', fontSize: '14px', cursor: 'pointer', marginTop: '4px'
    }, '＋ 添加字段');
    addBtn.onclick = function () {
      var name = (nameInput.value || '').trim();
      if (!name) { banner('请填写字段名', 'warn'); return; }
      for (var k = 0; k < fields.length; k++) {
        if (fields[k].name === name) { banner('字段名重复：' + name, 'warn'); return; }
      }
      var pn = parseInt(pageInput.value, 10);
      if (isNaN(pn) || pn < 1) { pn = 1; }
      if (total && pn > total) { banner('页码超出范围（共 ' + total + ' 页）', 'warn'); return; }
      var item = {
        type: typeSel.value,
        name: name,
        page: pn,
        xRatio: (parseFloat(xRange.input.value) || 0) / 100,
        yRatio: (parseFloat(yRange.input.value) || 0) / 100,
        widthRatio: (parseFloat(wRange.input.value) || 40) / 100,
        heightRatio: (parseFloat(hRange.input.value) || 3) / 100
      };
      if (item.type === 'dropdown') {
        item.options = (optInput.value || '').split(/[,，]/)
          .map(function (s) { return s.trim(); }).filter(Boolean);
        if (!item.options.length) { banner('下拉框至少需要一个选项', 'warn'); return; }
      }
      fields.push(item);
      nameInput.value = '';
      optInput.value = '';
      refreshList();
    };

    var runBtn = actionButton('生成表单 PDF');
    runBtn.onclick = async function () {
      if (!path) { banner('未指定 PDF 文件', 'err'); return; }
      if (!fields.length) { banner('请先添加至少一个字段', 'warn'); return; }
      setRunning(runBtn, true, '生成表单 PDF');
      try {
        var out = await window.pdfEditor.createFormFields(path, fields);
        toast('已生成 ' + fields.length + ' 个字段');
        renderResult(out, baseName(out));
      } catch (e) {
        banner('生成失败：' + (e.message || e), 'err');
      } finally {
        setRunning(runBtn, false, '生成表单 PDF');
      }
    };

    refreshList();
    body.appendChild(scrollArea([
      titleEl('创建表单字段'),
      descEl('在指定页面上放置可填写的表单字段（文本框 / 复选框 / 下拉框）。位置按页面百分比定位，复选框自动保持正方形。生成新文件，保留原件。'),
      fileNote(path),
      totalInfo(total),
      field('字段类型', typeSel, ''),
      field('字段名', nameInput, '英文键名更通用，如 name；中文名也可用'),
      field('所在页码', pageInput, '默认第 1 页'),
      field('横向位置', xRange.wrap, '字段左边缘距页面左边的百分比'),
      field('纵向位置', yRange.wrap, '字段下边缘距页面底边的百分比（0 = 页底）'),
      field('宽度', wRange.wrap, '占页面宽度的百分比'),
      field('高度', hRange.wrap, '占页面高度的百分比；复选框取宽高中较小值'),
      optField,
      el('div', { fontSize: '13px', color: '#c8c8c8', margin: '14px 0 8px' }, '待创建字段'),
      listBox,
      addBtn,
      runBtn
    ]));
  }

  // 填写表单（故事 #051）
  async function renderFormFill() {
    var path = SINGLE;
    var list = [];
    var err = '';
    try {
      list = await window.pdfEditor.listFormFields(path);
    } catch (e) {
      err = e.message || String(e);
    }

    if (err) {
      body.appendChild(scrollArea([
        titleEl('填写表单'),
        descEl('读取 PDF 中的可填写字段并逐项填入内容。'),
        fileNote(path),
        el('div', { fontSize: '13px', color: '#e5534b' }, '读取表单字段失败：' + err)
      ]));
      return;
    }
    if (!list.length) {
      body.appendChild(scrollArea([
        titleEl('填写表单'),
        descEl('读取 PDF 中的可填写字段并逐项填入内容。'),
        fileNote(path),
        el('div', { fontSize: '13px', color: '#d29922' }, '该文档没有可填写的表单字段。可先用「创建表单字段」添加。')
      ]));
      return;
    }

    var inputs = {};
    var blocks = [];
    list.forEach(function (f) {
      if (f.type === 'checkbox') {
        var cb = checkboxInput('勾选', f.value === 'true');
        inputs[f.name] = cb.input;
        blocks.push(field(f.name + '（复选框）', cb.wrap, ''));
      } else if ((f.type === 'dropdown' || f.type === 'optionlist' || f.type === 'radio') && f.options.length) {
        var opts = [{ value: '', label: '（不选择）' }];
        f.options.forEach(function (o) { opts.push({ value: o, label: o }); });
        var sel = selectInput(opts, f.value || '');
        inputs[f.name] = sel;
        blocks.push(field(f.name + '（' + formTypeLabel(f.type) + '）', sel, ''));
      } else if (f.type === 'text') {
        var ti = textInput('', f.value || '');
        inputs[f.name] = ti;
        blocks.push(field(f.name, ti, ''));
      } else {
        blocks.push(field(f.name, textInput('该类型暂不支持填写', ''), '类型：' + f.type));
      }
    });

    var runBtn = actionButton('保存填写结果');
    runBtn.onclick = async function () {
      var values = {};
      Object.keys(inputs).forEach(function (n) {
        var e = inputs[n];
        values[n] = (e.type === 'checkbox') ? e.checked : e.value;
      });
      setRunning(runBtn, true, '保存填写结果');
      try {
        var out = await window.pdfEditor.fillForm(path, values);
        toast('填写完成');
        renderResult(out, baseName(out));
      } catch (e) {
        banner('填写失败：' + (e.message || e), 'err');
      } finally {
        setRunning(runBtn, false, '保存填写结果');
      }
    };

    body.appendChild(scrollArea([
      titleEl('填写表单'),
      descEl('共 ' + list.length + ' 个字段。填写后生成新文件，保留原件。中文内容会自动嵌入中文字体以生成正确外观。'),
      fileNote(path)
    ].concat(blocks).concat([runBtn])));
  }

  // 展平表单（故事 #052）
  async function renderFlatten() {
    var path = SINGLE;
    var list = [];
    var err = '';
    try {
      list = await window.pdfEditor.listFormFields(path);
    } catch (e) {
      err = e.message || String(e);
    }

    if (err) {
      body.appendChild(scrollArea([
        titleEl('展平表单'),
        descEl('把表单字段的值烧成静态内容，之后不可再编辑。'),
        fileNote(path),
        el('div', { fontSize: '13px', color: '#e5534b' }, '读取表单字段失败：' + err)
      ]));
      return;
    }
    if (!list.length) {
      body.appendChild(scrollArea([
        titleEl('展平表单'),
        descEl('把表单字段的值烧成静态内容，之后不可再编辑。'),
        fileNote(path),
        el('div', { fontSize: '13px', color: '#d29922' }, '该文档没有表单字段，无需展平。')
      ]));
      return;
    }

    var summary = list.map(function (f) {
      return f.name + '（' + formTypeLabel(f.type) + '）';
    }).join('、');

    var runBtn = actionButton('展平并保存');
    runBtn.onclick = async function () {
      setRunning(runBtn, true, '展平并保存');
      try {
        var out = await window.pdfEditor.flattenForm(path);
        toast('已展平');
        renderResult(out, baseName(out));
      } catch (e) {
        banner('展平失败：' + (e.message || e), 'err');
      } finally {
        setRunning(runBtn, false, '展平并保存');
      }
    };

    body.appendChild(scrollArea([
      titleEl('展平表单'),
      descEl('共 ' + list.length + ' 个字段，展平后字段值固定为页面内容，不可再编辑。生成新文件，保留原件。'),
      fileNote(path),
      el('div', {
        fontSize: '13px', color: '#c8c8c8', lineHeight: '1.6', marginBottom: '14px',
        background: '#2b2b2b', padding: '10px 12px', borderRadius: '8px'
      }, summary),
      runBtn
    ]));
  }

  async function renderMetadata() {
    var path = SINGLE;
    var cur = {};
    try {
      if (path && window.pdfEditor) {
        cur = await window.pdfEditor.getMetadata(path) || {};
      }
    } catch (e) {
      banner('读取文档信息失败：' + (e.message || e), 'warn');
    }

    function mkDate(val) {
      var i = textInput('YYYY-MM-DD', val || '');
      i.type = 'date';
      return i;
    }
    function nowHint(v) {
      return v ? ('当前：' + v) : '当前：（空）';
    }

    var titleInput = textInput('留空表示不修改', cur.title || '');
    var authorInput = textInput('留空表示不修改', cur.author || '');
    var subjectInput = textInput('留空表示不修改', cur.subject || '');
    var kwInput = textInput('多个关键词用逗号分隔', cur.keywords || '');
    var createInput = mkDate(cur.creationDate);
    var runBtn = actionButton('保存修改');

    runBtn.onclick = async function () {
      if (!path) { banner('未指定 PDF 文件', 'err'); return; }
      var meta = {
        title: titleInput.value,
        author: authorInput.value,
        subject: subjectInput.value,
        keywords: kwInput.value,
        creationDate: createInput.value
      };
      var changed = false;
      Object.keys(meta).forEach(function (k) {
        if (String(meta[k] || '').trim()) { changed = true; }
      });
      if (!changed) { banner('请至少修改一项', 'warn'); return; }
      setRunning(runBtn, true, '保存修改');
      try {
        var out = await window.pdfEditor.editMetadata(path, meta);
        toast('保存完成');
        renderResult(out, baseName(out));
      } catch (e) {
        banner('保存失败：' + (e.message || e), 'err');
        toast('保存失败');
      } finally {
        setRunning(runBtn, false, '保存修改');
      }
    };

    body.appendChild(scrollArea([
      titleEl('文档信息'),
      descEl('修改 PDF 的标题、作者、主题、关键词与创建日期；修改日期会自动更新为当前时间。留空表示保持原值。生成新文件，保留原件。'),
      fileNote(path),
      field('标题', titleInput, nowHint(cur.title)),
      field('作者', authorInput, nowHint(cur.author)),
      field('主题', subjectInput, nowHint(cur.subject)),
      field('关键词', kwInput, '多个用逗号分隔；' + nowHint(cur.keywords)),
      field('创建日期', createInput, nowHint(cur.creationDate)),
      runBtn
    ]));
  }

  // 编辑器密码弹窗：返回 Promise<密码字符串 | null(取消)>
  // reason: 1=首次需要密码，2=密码错误重试（与 pdf.js PasswordResponses 对齐）
  function promptEditorPassword(reason) {
    return new Promise(function (resolve) {
      var overlay = el('div', {
        position: 'fixed', left: '0', top: '0', right: '0', bottom: '0',
        background: 'rgba(0,0,0,0.45)', display: 'flex',
        alignItems: 'center', justifyContent: 'center', zIndex: '9999'
      });
      var box = el('div', {
        background: '#fff', borderRadius: '14px', padding: '20px',
        width: '80%', maxWidth: '320px', boxSizing: 'border-box',
        boxShadow: '0 8px 24px rgba(0,0,0,0.3)'
      });
      var title = el('div', {
        fontSize: '15px', fontWeight: '600', marginBottom: '12px', color: '#222'
      }, reason === 2 ? '密码错误，请重试' : '该文档已加密，请输入打开密码');
      var input = el('input', {
        width: '100%', boxSizing: 'border-box', padding: '10px',
        fontSize: '14px', border: '1px solid #ddd', borderRadius: '8px', outline: 'none'
      });
      input.type = 'password';
      var row = el('div', { display: 'flex', gap: '10px', marginTop: '16px' });
      var cancel = el('button', {
        flex: '1', padding: '10px', fontSize: '14px', border: 'none',
        borderRadius: '8px', background: '#f0f0f0', color: '#555'
      }, '取消');
      var ok = el('button', {
        flex: '1', padding: '10px', fontSize: '14px', border: 'none',
        borderRadius: '8px', background: '#2f6bff', color: '#fff'
      }, '确定');
      ok.onclick = function () {
        var v = input.value;
        if (overlay.parentNode) document.body.removeChild(overlay);
        resolve(v);
      };
      cancel.onclick = function () {
        if (overlay.parentNode) document.body.removeChild(overlay);
        resolve(null);
      };
      input.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') ok.onclick();
      });
      row.appendChild(cancel);
      row.appendChild(ok);
      box.appendChild(title);
      box.appendChild(input);
      box.appendChild(row);
      overlay.appendChild(box);
      document.body.appendChild(overlay);
      input.focus();
    });
  }
  // 暴露给 editor.js（_requestPassword 调用）
  window.__promptEditorPassword = promptEditorPassword;

  // 保存时「是否保留加密」弹窗：返回 Promise<'keep' | 'remove' | 'cancel'>
  //   keep  = 保留原密码加密
  //   remove= 移除密码（输出无密码文件）
  //   cancel= 取消保存
  function promptSaveEncryption() {
    return new Promise(function (resolve) {
      var overlay = el('div', {
        position: 'fixed', left: '0', top: '0', right: '0', bottom: '0',
        background: 'rgba(0,0,0,0.45)', display: 'flex',
        alignItems: 'center', justifyContent: 'center', zIndex: '9999'
      });
      var box = el('div', {
        background: '#fff', borderRadius: '14px', padding: '20px',
        width: '80%', maxWidth: '320px', boxSizing: 'border-box',
        boxShadow: '0 8px 24px rgba(0,0,0,0.3)'
      });
      box.appendChild(el('div', {
        fontSize: '15px', fontWeight: '600', marginBottom: '6px', color: '#222'
      }, '原文件已加密'));
      box.appendChild(el('div', {
        fontSize: '13px', color: '#666', marginBottom: '16px', lineHeight: '1.5'
      }, '保存时是否保留密码加密？取消将不生成新文件。'));

      function close() { if (overlay.parentNode) document.body.removeChild(overlay); }

      var cancel = el('button', {
        width: '100%', padding: '11px', fontSize: '14px', border: 'none',
        borderRadius: '8px', background: '#f0f0f0', color: '#555', marginBottom: '8px'
      }, '取消');
      var remove = el('button', {
        width: '100%', padding: '11px', fontSize: '14px', border: 'none',
        borderRadius: '8px', background: '#e5534b', color: '#fff', marginBottom: '8px'
      }, '移除密码（生成无密码文件）');
      var keep = el('button', {
        width: '100%', padding: '11px', fontSize: '14px', border: 'none',
        borderRadius: '8px', background: '#2f6bff', color: '#fff'
      }, '保留加密（沿用原密码）');

      cancel.onclick = function () { close(); resolve('cancel'); };
      remove.onclick = function () { close(); resolve('remove'); };
      keep.onclick = function () { close(); resolve('keep'); };

      box.appendChild(cancel);
      box.appendChild(remove);
      box.appendChild(keep);
      overlay.appendChild(box);
      document.body.appendChild(overlay);
    });
  }
  // 暴露给 editor.js（_askKeepEncryption 调用）
  window.__promptSaveEncryption = promptSaveEncryption;

  function boot() {
    readInjected();
    if (headerTool) { headerTool.textContent = TOOL_NAMES[TOOL] || TOOL || '未指定'; }
    if (!TOOL) {
      banner('未指定工具', 'warn');
      return;
    }
    // 进入时预检测加密并解锁（方案2：进入即弹密码，后续工具复用）
    // 输入不是 PDF 的工具（图片提字 imgocr / 图片转 PDF img2pdf）跳过预检测
    if (window.pdfEditor && SINGLE && TOOL !== 'imgocr' && TOOL !== 'img2pdf') {
      // 从阅读器跳转且已输对密码时，复用该密码，免去二次弹窗
      if (PASSWORD) { window.pdfEditor.password = PASSWORD; }
      window.pdfEditor.prepareSession(SINGLE).then(function () {
        renderTool();
      }).catch(function (e) {
        banner('无法打开文档：' + (e && e.message ? e.message : e), 'err');
      });
      return;
    }
    renderTool();

    function renderTool() {
      var fn = DISPATCH[TOOL];
      if (!fn) {
        banner('该工具尚未实现（TOOL=' + TOOL + '）', 'warn');
        return;
      }
      try {
        fn();
      } catch (e) {
        banner('工具加载失败：' + (e.message || e), 'err');
      }
    }
  }

  // 等待 pdfEditor 与注入变量就绪（editor.js 同步加载通常已就绪；兜底轮询）
  function ensureReady(cb) {
    var tries = 0;
    var iv = setInterval(function () {
      tries++;
      var editorOk = !!(window.pdfEditor && window.bridge);
      var injectedOk = (typeof window.__PDF_TOOL__ !== 'undefined');
      if (editorOk && injectedOk) {
        clearInterval(iv);
        cb();
      } else if (tries > 30) {
        clearInterval(iv);
        banner('PDF 编辑器组件或参数未就绪（tool=' + (typeof window.__PDF_TOOL__) + '）', 'err');
      }
    }, 100);
  }

  clearBody();
  ensureReady(boot);
})();
