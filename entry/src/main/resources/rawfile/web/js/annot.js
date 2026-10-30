/**
 * annot.js — 交互式标注层（V1.3 故事 #048 手写签名 / #049 高亮标注）
 *
 * 结构：
 *   pdf.js 渲染当前页 → 透明叠加画布承接手势 → 标注以「PDF 用户空间坐标」保存
 *   → 调用 window.pdfEditor.applyAnnotations() 由 pdf-lib 烧写进 PDF
 *
 * 坐标系约定（与技术方案 4.4.1 一致）：
 *   - 屏幕坐标由 viewport.convertToPdfPoint() 换算为 PDF 坐标（原点左下、y 向上），
 *     该方法已内含 /Rotate 与 CropBox 偏移，故旋转页同样正确。
 *   - 反绘时用 convertToViewportPoint()，并取矩形对角两点，旋转页亦成立。
 *
 * 手势：
 *   - 签名：按下拖动即为笔迹，采样点密度 <1 CSS px 自动丢弃；二次贝塞尔中点平滑。
 *   - 高亮：按下拖动框出矩形（触屏比文本选区更可靠，故采用区域高亮）。
 *
 * 依赖：bridge.js（window.bridge）、editor.js（window.pdfEditor）、pdf.js（window.pdfjsLib）
 */
(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }

  var stage = $('annot-stage');
  var wrap = $('annot-pages');
  var pageCanvas = $('page-canvas');
  var overlay = $('overlay-canvas');
  var outEl = $('annot-output');
  var pctx = pageCanvas.getContext('2d');
  var octx = overlay.getContext('2d');

  var app = {
    tool: 'sign',            // 'sign' | 'highlight'
    filePath: '',
    password: '',
    doc: null,               // pdf.js PDFDocumentProxy
    page: null,
    pageNum: 1,
    numPages: 0,
    viewport: null,
    dpr: 1,
    fitScale: 1,             // 适应宽度所需的缩放
    zoom: 1,                 // 用户缩放倍率
    annots: [],              // { type, page, color, opacity, width, strokes|rects }
    color: '#1f4fd8',
    width: 3,                // 笔迹粗细（CSS px @ fitScale，保存时折算为 PDF pt）
    opacity: 0.4,
    drawing: false,
    cur: null,               // 正在绘制的签名
    startPt: null,           // 高亮拖拽起点（PDF 坐标）
    previewRect: null,
    renderTask: null
  };

  // ============ 小工具 ============

  function baseName(p) {
    if (!p) { return ''; }
    return p.split('/').pop() || p;
  }

  function toast(msg) {
    if (window.bridge && typeof window.bridge.showToast === 'function') {
      window.bridge.showToast(msg);
    }
  }

  function banner(msg, type) {
    var bg = { info: 'rgba(0,0,0,0.62)', ok: '#2ea44f', err: '#e5534b', warn: '#d29922' }[type || 'info'];
    outEl.textContent = msg;
    outEl.style.background = bg || 'rgba(0,0,0,0.62)';
    outEl.style.display = 'block';
  }

  function hideOut() { outEl.style.display = 'none'; }

  function el(tag, style, text) {
    var e = document.createElement(tag);
    if (style) { for (var k in style) { e.style[k] = style[k]; } }
    if (text !== undefined && text !== null) { e.textContent = text; }
    return e;
  }

  /** 当前 1 CSS px 对应多少 PDF pt（用于把屏显粗细折算进 PDF） */
  function cssScale() {
    if (!app.viewport) { return 1; }
    return (app.viewport.scale || 1) / (app.dpr || 1);
  }

  function toVp(p) {
    return app.viewport.convertToViewportPoint(p.x, p.y);
  }

  // ============ 坐标换算 ============

  /** 事件 → PDF 坐标（失败返回 null） */
  function ptOf(ev) {
    if (!app.viewport) { return null; }
    var cx, cy;
    if (ev.touches && ev.touches.length) {
      cx = ev.touches[0].clientX; cy = ev.touches[0].clientY;
    } else if (ev.changedTouches && ev.changedTouches.length) {
      cx = ev.changedTouches[0].clientX; cy = ev.changedTouches[0].clientY;
    } else if (ev.clientX !== undefined) {
      cx = ev.clientX; cy = ev.clientY;
    } else {
      return null;
    }
    var rect = overlay.getBoundingClientRect();
    if (!rect.width || !rect.height) { return null; }
    var bx = (cx - rect.left) * (overlay.width / rect.width);
    var by = (cy - rect.top) * (overlay.height / rect.height);
    var p = app.viewport.convertToPdfPoint(bx, by);
    return { x: p[0], y: p[1] };
  }

  // ============ 渲染 ============

  async function renderPage(n) {
    if (n < 1 || n > app.numPages) { return; }
    if (app.renderTask) {
      try { app.renderTask.cancel(); } catch (e) { /* 已结束时忽略 */ }
      app.renderTask = null;
    }
    app.pageNum = n;
    app.page = await app.doc.getPage(n);

    var base = app.page.getViewport({ scale: 1 });
    var avail = (stage.clientWidth || window.innerWidth || 360) - 24;
    app.fitScale = Math.max(0.05, avail / base.width);
    app.dpr = Math.min(window.devicePixelRatio || 1, 2);

    var vpt = app.page.getViewport({ scale: app.fitScale * app.zoom * app.dpr });
    app.viewport = vpt;

    var w = Math.max(1, Math.ceil(vpt.width));
    var h = Math.max(1, Math.ceil(vpt.height));
    var cssW = Math.round(w / app.dpr);
    var cssH = Math.round(h / app.dpr);

    // 直接改 width/height 会顺带清空画布，无需手动 clearRect
    pageCanvas.width = w; pageCanvas.height = h;
    pageCanvas.style.width = cssW + 'px';
    pageCanvas.style.height = cssH + 'px';
    overlay.width = w; overlay.height = h;
    overlay.style.width = cssW + 'px';
    overlay.style.height = cssH + 'px';
    wrap.style.width = cssW + 'px';
    wrap.style.height = cssH + 'px';

    app.renderTask = app.page.render({ canvasContext: pctx, viewport: vpt });
    try {
      await app.renderTask.promise;
    } catch (e) {
      // 快速翻页导致的 RenderingCancelledException，忽略即可
    }
    app.renderTask = null;
    updateBar();
    redraw();
  }

  function drawStroke(a) {
    var lw = Math.max(0.5, a.width * cssScale() * app.dpr);
    octx.save();
    octx.strokeStyle = a.color;
    octx.fillStyle = a.color;
    octx.lineWidth = lw;
    octx.lineCap = 'round';
    octx.lineJoin = 'round';
    for (var si = 0; si < a.strokes.length; si++) {
      var s = a.strokes[si];
      if (!s || !s.length) { continue; }
      if (s.length === 1) {
        // 单点：画个圆点，保证轻点也有痕迹
        var p = toVp(s[0]);
        octx.beginPath();
        octx.arc(p[0], p[1], lw / 2, 0, Math.PI * 2);
        octx.fill();
        continue;
      }
      octx.beginPath();
      var p0 = toVp(s[0]);
      octx.moveTo(p0[0], p0[1]);
      if (s.length === 2) {
        var p1 = toVp(s[1]);
        octx.lineTo(p1[0], p1[1]);
      } else {
        // 二次贝塞尔中点平滑：以采样点为控制点、相邻中点为端点
        for (var i = 1; i < s.length - 1; i++) {
          var c = toVp(s[i]);
          var nx = toVp(s[i + 1]);
          octx.quadraticCurveTo(c[0], c[1], (c[0] + nx[0]) / 2, (c[1] + nx[1]) / 2);
        }
        var last = toVp(s[s.length - 1]);
        octx.lineTo(last[0], last[1]);
      }
      octx.stroke();
    }
    octx.restore();
  }

  function drawHl(a) {
    octx.save();
    octx.globalAlpha = a.opacity === undefined ? 0.4 : a.opacity;
    octx.fillStyle = a.color;
    for (var i = 0; i < a.rects.length; i++) {
      var r = a.rects[i];
      // 取对角两点再换算，可自动适配页面旋转
      var tl = toVp({ x: r.x, y: r.y + r.h });
      var br = toVp({ x: r.x + r.w, y: r.y });
      var x = Math.min(tl[0], br[0]);
      var y = Math.min(tl[1], br[1]);
      octx.fillRect(x, y, Math.abs(br[0] - tl[0]), Math.abs(br[1] - tl[1]));
    }
    octx.restore();
  }

  function redraw() {
    if (!app.viewport) { return; }
    octx.clearRect(0, 0, overlay.width, overlay.height);
    for (var i = 0; i < app.annots.length; i++) {
      var a = app.annots[i];
      if (a.page !== app.pageNum) { continue; }
      if (a.type === 'sign') { drawStroke(a); } else { drawHl(a); }
    }
    if (app.cur && app.cur.type === 'sign') { drawStroke(app.cur); }
    if (app.previewRect) {
      drawHl({ rects: [app.previewRect], color: app.color, opacity: app.opacity });
    }
  }

  // ============ 手势 ============

  function onDown(ev) {
    if (!app.viewport) { return; }
    var t = ptOf(ev);
    if (!t) { return; }
    if (ev.preventDefault) { ev.preventDefault(); }
    app.drawing = true;
    if (app.tool === 'sign') {
      app.cur = {
        type: 'sign',
        page: app.pageNum,
        color: app.color,
        width: app.width / cssScale(),   // CSS px → PDF pt
        strokes: [[t]]
      };
    } else {
      app.startPt = t;
      app.previewRect = { x: t.x, y: t.y, w: 0, h: 0 };
    }
    if (overlay.setPointerCapture && ev.pointerId !== undefined) {
      try { overlay.setPointerCapture(ev.pointerId); } catch (e) { /* 忽略 */ }
    }
    redraw();
  }

  function onMove(ev) {
    if (!app.drawing || !app.viewport) { return; }
    var t = ptOf(ev);
    if (!t) { return; }
    if (ev.preventDefault) { ev.preventDefault(); }
    if (app.tool === 'sign') {
      var s = app.cur.strokes[app.cur.strokes.length - 1];
      var last = s[s.length - 1];
      // 采样去抖：屏显位移不足 1px 的点直接丢弃
      var dx = (t.x - last.x) * cssScale();
      var dy = (t.y - last.y) * cssScale();
      if (dx * dx + dy * dy < 1) { return; }
      s.push(t);
    } else {
      app.previewRect = {
        x: Math.min(app.startPt.x, t.x),
        y: Math.min(app.startPt.y, t.y),
        w: Math.abs(t.x - app.startPt.x),
        h: Math.abs(t.y - app.startPt.y)
      };
    }
    redraw();
  }

  function onUp() {
    if (!app.drawing) { return; }
    app.drawing = false;
    if (app.tool === 'sign') {
      var s = app.cur.strokes[0];
      if (s.length === 1) {
        // 单点轻触：补一个极近的点，落盘时才能画出圆头短线
        s.push({ x: s[0].x + 0.3, y: s[0].y });
      }
      app.annots.push(app.cur);
      app.cur = null;
    } else {
      var r = app.previewRect;
      // 屏显不足 4px 视为误触，丢弃
      if (r && r.w * cssScale() > 4 && r.h * cssScale() > 4) {
        app.annots.push({
          type: 'highlight',
          page: app.pageNum,
          color: app.color,
          opacity: app.opacity,
          rects: [{ x: r.x, y: r.y, w: r.w, h: r.h }]
        });
      }
      app.previewRect = null;
      app.startPt = null;
    }
    updateBar();
    redraw();
  }

  function bindPointer() {
    if ('onpointerdown' in window) {
      overlay.addEventListener('pointerdown', onDown);
      overlay.addEventListener('pointermove', onMove);
      overlay.addEventListener('pointerup', onUp);
      overlay.addEventListener('pointercancel', onUp);
    } else {
      overlay.addEventListener('touchstart', onDown, { passive: false });
      overlay.addEventListener('touchmove', onMove, { passive: false });
      overlay.addEventListener('touchend', onUp);
      overlay.addEventListener('touchcancel', onUp);
    }
  }

  // ============ UI ============

  function applyDefaults() {
    var isHl = app.tool === 'highlight';
    $('a-tool-name').textContent = isHl ? '高亮标注' : '手写签名';
    app.color = isHl ? '#ffe066' : '#1f4fd8';
    app.opacity = isHl ? 0.4 : 1;
    $('color-input').value = app.color;
    $('width-range').value = String(app.width);
    $('opacity-range').value = String(Math.round(app.opacity * 100));
    $('width-range').style.display = isHl ? 'none' : 'block';
    $('opacity-range').style.display = isHl ? 'block' : 'none';
  }

  function updateBar() {
    $('a-page-info').textContent = app.numPages ? (app.pageNum + ' / ' + app.numPages) : '-/-';
    $('btn-prev').disabled = app.pageNum <= 1;
    $('btn-next').disabled = app.numPages > 0 && app.pageNum >= app.numPages;
    $('btn-undo').disabled = app.annots.length === 0;
  }

  function bindUI() {
    $('color-input').addEventListener('input', function (e) { app.color = e.target.value; });
    $('width-range').addEventListener('input', function (e) {
      app.width = parseFloat(e.target.value) || 3;
    });
    $('opacity-range').addEventListener('input', function (e) {
      app.opacity = (parseFloat(e.target.value) || 40) / 100;
    });

    $('btn-undo').onclick = function () {
      if (!app.annots.length) { return; }
      var a = app.annots.pop();
      // 若撤销的是其它页的标注，跳转过去，避免"点了没反应"
      if (a.page !== app.pageNum) { renderPage(a.page); return; }
      updateBar();
      redraw();
    };
    $('btn-clear').onclick = function () {
      app.annots = app.annots.filter(function (a) { return a.page !== app.pageNum; });
      updateBar();
      redraw();
    };
    $('btn-prev').onclick = function () { renderPage(app.pageNum - 1); };
    $('btn-next').onclick = function () { renderPage(app.pageNum + 1); };
    $('btn-zoom-in').onclick = function () {
      app.zoom = Math.min(4, app.zoom * 1.25);
      renderPage(app.pageNum);
    };
    $('btn-zoom-out').onclick = function () {
      app.zoom = Math.max(0.4, app.zoom / 1.25);
      renderPage(app.pageNum);
    };
    $('btn-save').onclick = save;
  }

  // ============ 保存 ============

  function setBusy(btn, busy) {
    btn.disabled = busy;
    btn.style.opacity = busy ? '0.6' : '1';
    btn.textContent = busy ? '保存中…' : '保存标注';
  }

  async function save() {
    if (!app.annots.length) {
      banner('还没有任何标注，请先在页面上书写或框选', 'warn');
      return;
    }
    var btn = $('btn-save');
    setBusy(btn, true);
    try {
      var payload = app.annots.map(function (a) {
        return a.type === 'sign'
          ? { type: 'sign', page: a.page, color: a.color, width: a.width, strokes: a.strokes }
          : { type: 'highlight', page: a.page, color: a.color, opacity: a.opacity, rects: a.rects };
      });
      const outPath = await window.pdfEditor.applyAnnotations(app.filePath, payload);
      showResult(outPath);
      toast('标注已保存');
    } catch (e) {
      banner('保存失败：' + (e && e.message ? e.message : e), 'err');
    } finally {
      setBusy(btn, false);
    }
  }

  /** 结果卡片：预览 / 保存 / 分享（与 editor-ui.js 的 renderResult 保持一致） */
  function showResult(path) {
    var old = document.getElementById('annot-result');
    if (old && old.parentNode) { old.parentNode.removeChild(old); }

    var card = el('div', {
      position: 'absolute', left: '12px', right: '12px', bottom: '96px',
      background: 'rgba(38,44,52,0.97)', borderRadius: '14px', padding: '14px',
      boxShadow: '0 6px 20px rgba(0,0,0,0.35)', boxSizing: 'border-box'
    });
    card.id = 'annot-result';
    card.className = 'result-card';
    card.appendChild(el('div', {
      fontSize: '14px', fontWeight: '600', color: '#2ea44f', marginBottom: '4px', paddingRight: '28px'
    }, '✓ 处理完成'));
    var close = el('div', { cursor: 'pointer' }, '×');
    close.className = 'result-close';
    close.onclick = function () { if (card.parentNode) { card.parentNode.removeChild(card); } };
    card.appendChild(close);
    card.appendChild(el('div', {
      fontSize: '12px', color: '#c8c8c8', marginBottom: '10px',
      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
    }, baseName(path)));

    var row = el('div', { display: 'flex', gap: '8px' });
    var name = baseName(path);
    [['预览', '#2f6bff', 'openResult'], ['保存到本地', '#3a3f47', 'saveResult'], ['分享', '#3a3f47', 'shareResult']]
      .forEach(function (cfg) {
        var b = el('button', { background: cfg[1] }, cfg[0]);
        b.className = 'result-btn';
        b.onclick = function () {
          if (window.bridge && typeof window.bridge[cfg[2]] === 'function') {
            window.bridge[cfg[2]](path, name);
          }
        };
        row.appendChild(b);
      });
    card.appendChild(row);
    document.getElementById('annot-app').appendChild(card);
  }

  // ============ 弹窗（供 editor.js 回调） ============

  function overlayBox() {
    var ov = el('div', {
      position: 'fixed', left: '0', top: '0', right: '0', bottom: '0',
      background: 'rgba(0,0,0,0.45)', display: 'flex',
      alignItems: 'center', justifyContent: 'center', zIndex: '9999'
    });
    var box = el('div', {
      background: '#fff', borderRadius: '14px', padding: '20px',
      width: '80%', maxWidth: '320px', boxSizing: 'border-box',
      boxShadow: '0 8px 24px rgba(0,0,0,0.3)'
    });
    ov.appendChild(box);
    document.body.appendChild(ov);
    return { ov: ov, box: box };
  }

  function close(el2) {
    if (el2.parentNode) { el2.parentNode.removeChild(el2); }
  }

  /** 打开密码输入：Promise<密码 | null> */
  function promptPassword(reason) {
    return new Promise(function (resolve) {
      var ui = overlayBox();
      ui.box.appendChild(el('div', {
        fontSize: '15px', fontWeight: '600', marginBottom: '12px', color: '#222'
      }, reason === 2 ? '密码错误，请重试' : '该文档已加密，请输入打开密码'));
      var input = el('input', {
        width: '100%', boxSizing: 'border-box', padding: '10px', fontSize: '14px',
        border: '1px solid #ddd', borderRadius: '8px', outline: 'none'
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
      cancel.onclick = function () { close(ui.ov); resolve(null); };
      ok.onclick = function () { close(ui.ov); resolve(input.value); };
      input.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ok.onclick(); } });
      row.appendChild(cancel);
      row.appendChild(ok);
      ui.box.appendChild(input);
      ui.box.appendChild(row);
      input.focus();
    });
  }

  /** 保存时是否保留加密：Promise<'keep' | 'remove' | 'cancel'> */
  function promptSaveEncryption() {
    return new Promise(function (resolve) {
      var ui = overlayBox();
      ui.box.appendChild(el('div', {
        fontSize: '15px', fontWeight: '600', marginBottom: '6px', color: '#222'
      }, '原文件已加密'));
      ui.box.appendChild(el('div', {
        fontSize: '13px', color: '#666', marginBottom: '16px', lineHeight: '1.5'
      }, '保存时是否保留密码加密？取消将不生成新文件。'));
      function mk(text, bg, color, val) {
        var b = el('button', {
          width: '100%', padding: '11px', fontSize: '14px', border: 'none',
          borderRadius: '8px', background: bg, color: color, marginBottom: '8px'
        }, text);
        b.onclick = function () { close(ui.ov); resolve(val); };
        return b;
      }
      ui.box.appendChild(mk('取消', '#f0f0f0', '#555', 'cancel'));
      ui.box.appendChild(mk('移除密码（生成无密码文件）', '#e5534b', '#fff', 'remove'));
      ui.box.appendChild(mk('保留加密（沿用原密码）', '#2f6bff', '#fff', 'keep'));
    });
  }

  window.__promptEditorPassword = promptPassword;
  window.__promptSaveEncryption = promptSaveEncryption;

  // ============ 启动 ============

  async function boot() {
    app.tool = (window.__PDF_TOOL__ === 'highlight') ? 'highlight' : 'sign';
    app.filePath = window.__PDF_PATH__ || '';
    app.password = window.__PDF_PASSWORD__ || '';

    applyDefaults();
    bindUI();
    bindPointer();

    if (!app.filePath) { banner('未指定 PDF 文件', 'err'); return; }
    if (!window.pdfjsLib) { banner('pdf.js 未加载，无法预览页面', 'err'); return; }

    banner('正在打开文档…', 'info');

    // 先经 PdfEditor 预解锁（加密文档会弹密码），再复用该密码给 pdf.js
    if (window.pdfEditor && window.pdfEditor.prepareSession) {
      if (app.password) { window.pdfEditor.password = app.password; }
      try {
        await window.pdfEditor.prepareSession(app.filePath);
      } catch (e) {
        banner('无法打开文档：' + (e && e.message ? e.message : e), 'err');
        return;
      }
      app.password = window.pdfEditor.password || app.password;
    }

    const pdfjs = window.pdfjsLib;
    if (!pdfjs.GlobalWorkerOptions.workerSrc) {
      pdfjs.GlobalWorkerOptions.workerSrc = '../lib/pdf.worker.min.js';
    }

    let raw;
    try {
      raw = await window.bridge.readFile(app.filePath);
    } catch (e) {
      banner('读取文件失败：' + (e && e.message ? e.message : e), 'err');
      return;
    }
    const fresh = function () {
      return (raw && raw.slice) ? raw.slice() : new Uint8Array(raw || []);
    };

    try {
      app.doc = await pdfjs.getDocument({
        data: fresh(),
        password: app.password || undefined
      }).promise;
    } catch (e) {
      // pdf.js 与 @maxwbh/pdf-lib 的加密产物不兼容：用 pdf-lib 内存解密兜底（与阅读器一致）
      if (window.PDFLib && window.PDFLib.PDFDocument) {
        try {
          banner('正在解密文档…', 'info');
          const dec = await window.PDFLib.PDFDocument.load(fresh(), { password: app.password || undefined });
          if (dec.context && dec.context.trailerInfo) { dec.context.trailerInfo.Encrypt = undefined; }
          dec.isEncrypted = false;
          const plain = await dec.save();
          app.doc = await pdfjs.getDocument({
            data: plain.slice ? plain.slice() : new Uint8Array(plain)
          }).promise;
        } catch (e2) {
          banner('无法渲染文档：' + (e2 && e2.message ? e2.message : e2), 'err');
          return;
        }
      } else {
        banner('无法渲染文档：' + (e && e.message ? e.message : e), 'err');
        return;
      }
    }
    app.numPages = app.doc.numPages;
    hideOut();
    await renderPage(1);
  }

  // window.__PDF_TOOL__ 由 ArkTS 在 onPageEnd 后注入，晚于本脚本，故轮询等待
  function ensureReady(cb) {
    var tries = 0;
    var iv = setInterval(function () {
      tries++;
      var ok = !!(window.pdfEditor && window.bridge) && (typeof window.__PDF_TOOL__ !== 'undefined');
      if (ok) {
        clearInterval(iv);
        cb();
      } else if (tries > 30) {
        clearInterval(iv);
        banner('标注组件或参数未就绪', 'err');
      }
    }, 100);
  }

  ensureReady(function () {
    boot().catch(function (e) {
      banner('标注页初始化失败：' + (e && e.message ? e.message : e), 'err');
    });
  });
})();
