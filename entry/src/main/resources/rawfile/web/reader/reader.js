/**
 * reader.js — 鸿蒙 PDF 阅读器核心（承载 pdf.js）
 *
 * 功能：渲染 / 缩放 / 平移(滚动) / 翻页 / 查看级旋转 /
 *      连续-单页-双页 三态切换 / 缩略图侧栏(懒渲染+当前页高亮) /
 *      目录大纲 / 全文搜索 + 高亮 / 文本层选择复制 / 阅读进度上报 /
 *      沉浸式工具栏(点击唤出+自动隐藏) / 页码跳转 / 底部状态胶囊 /
 *      手势缩放(捏合+双击)。
 *
 * 与 ArkTS 通信：
 *  - 读文件：window.nativeBridge.readFile(path) -> base64
 *  - 上报页码：window.nativeBridge.onReaderPage(path, page)
 *  - 复制文本：window.nativeBridge.copyToClipboard(text)
 */
(function () {
  'use strict';

  const DPR = Math.min(window.devicePixelRatio || 1, 2.5);
  const MIN_SCALE = 0.3;
  const MAX_SCALE = 4.0;
  const TOOLBAR_AUTO_HIDE_MS = 3200;
  const TOP_ZONE_PX = 80; // 顶部触发区高度：点击屏幕顶部该范围内任意位置即可淡入工具栏

  const state = {
    pdfDoc: null,
    path: '',
    numPages: 0,
    scale: 1.0,
    fitScale: 1.0,
    rotation: 0,
    mode: 'continuous', // 'continuous' | 'single' | 'double'
    pages: [],          // { wrap, canvas, ctx, textLayer, num, rendered, ph }
    searchTerm: '',
    searchMatches: [],  // { page, count, text }
    searchCursor: -1,
    currentPage: 1,
    renderToken: 0,
    toolbarTimer: 0,
    touch: { pinchActive: false, startDist: 0, startScale: 1, swipeStart: null, lastSwipeAt: 0 },
    lastTap: null
  };

  const dom = {};

  function $(id) { return document.getElementById(id); }
  function clampScale(s) { return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s)); }

  function showToast(msg) {
    const t = dom.toast;
    t.textContent = msg;
    t.style.display = 'block';
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => { t.style.display = 'none'; }, 1600);
  }

  function setLoading(show, msg) {
    dom.loading.style.display = show ? 'flex' : 'none';
    if (msg) dom.loading.textContent = msg;
  }

  // ============ 加密 PDF 密码弹窗 ============
  let pwdResolve = null;
  function showPasswordModal(reason) {
    if (!dom.pwdOverlay) return;
    const isRetry = reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD;
    dom.pwdTitle.textContent = isRetry ? '密码错误' : '请输入打开密码';
    dom.pwdHint.textContent = isRetry ? '密码不正确，请重新输入' : '该 PDF 已加密，需要密码才能查看';
    dom.pwdInput.value = '';
    dom.pwdOverlay.style.display = 'flex';
    dom.pwdInput.focus();
  }
  function hidePasswordModal() {
    if (dom.pwdOverlay) dom.pwdOverlay.style.display = 'none';
  }
  function promptPassword(reason) {
    return new Promise((resolve) => {
      pwdResolve = resolve;
      showPasswordModal(reason);
    });
  }
  function setupPasswordModal() {
    if (!dom.pwdOverlay) return;
    const submit = () => {
      const pwd = dom.pwdInput.value || '';
      hidePasswordModal();
      if (pwdResolve) { pwdResolve(pwd); pwdResolve = null; }
    };
    const cancel = () => {
      hidePasswordModal();
      if (pwdResolve) { pwdResolve(null); pwdResolve = null; }
    };
    dom.pwdConfirm.addEventListener('click', submit);
    dom.pwdCancel.addEventListener('click', cancel);
    dom.pwdInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
      if (e.key === 'Escape') cancel();
    });
  }

  // ============ 沉浸式工具栏（点击唤出 + 自动隐藏）============
  function showToolbar() {
    dom.toolbar.classList.add('visible');
    resetAutoHide();
  }
  function hideToolbar() {
    dom.toolbar.classList.remove('visible');
    clearTimeout(state.toolbarTimer);
  }
  function resetAutoHide() {
    clearTimeout(state.toolbarTimer);
    state.toolbarTimer = setTimeout(hideToolbar, TOOLBAR_AUTO_HIDE_MS);
  }

  // ============ 路径就绪等待 ============
  function waitForPath(retry) {
    retry = retry || 0;
    if (window.__PDF_PATH__ && window.__PDF_PATH__.length > 0) {
      openDocument(window.__PDF_PATH__);
    } else if (retry < 100) {
      setTimeout(() => waitForPath(retry + 1), 50);
    } else {
      setLoading(true, '未收到文件路径');
    }
  }

  // 深拷贝字节数组，防止 ArkWeb/pdf.js detached 原 buffer
  function cloneBytes(uint8) {
    if (!uint8) return uint8;
    if (uint8.slice) return uint8.slice();
    return new Uint8Array(uint8);
  }

  // 用 pdf.js 加载；支持传入密码
  async function tryLoadWithPdfjs(uint8, password) {
    const opts = { data: cloneBytes(uint8) };
    if (password !== undefined && password !== null) opts.password = password;
    const task = pdfjsLib.getDocument(opts);
    return await task.promise;
  }

  // 用 pdf-lib 解密后再用 pdf.js 加载（兼容 @maxwbh/pdf-lib 加密输出）
  async function tryLoadWithPdfLibDecrypt(uint8, password) {
    if (!window.PDFLib || !window.PDFLib.PDFDocument) {
      throw new Error('PDFLib 未加载，无法解密');
    }
    setLoading(true, '正在解密 PDF…');
    // 复制一份全新字节数组，避免 pdf.js 之前失败时 detached 掉原 buffer
    const safeBytes = uint8.slice ? uint8.slice() : new Uint8Array(uint8);
    const doc = await window.PDFLib.PDFDocument.load(safeBytes, { password });
    // 清除加密字典，得到明文 PDF
    if (doc.context && doc.context.trailerInfo) {
      doc.context.trailerInfo.Encrypt = undefined;
    }
    doc.isEncrypted = false;
    const plainBytes = await doc.save();
    // 再次复制，确保交给 pdf.js 的 buffer 未被任何库 detached
    const outBytes = plainBytes.slice ? plainBytes.slice() : new Uint8Array(plainBytes);
    return await tryLoadWithPdfjs(outBytes, undefined);
  }

  function isPasswordError(e) {
    return e && (e.name === 'PasswordException' ||
      /password/i.test(e.message) ||
      /Incorrect Password|Need password|password required|加密|密码/i.test(e.message) ||
      // @maxwbh/pdf-lib 加密产出在 pdf.js 3.11.174 下会报此错误，需识别为需要密码
      /Invalid argument for stringToBytes/i.test(e.message) ||
      // pdf-lib 用错误密码加载加密文档时抛此错误
      /is encrypted/i.test(e.message));
  }

  // ============ 打开文档 ============
  async function openDocument(path) {
    state.path = path;
    dom.loading.onclick = null; // 清除上次失败遗留的重试绑定
    try {
      setLoading(true, '正在读取文件…');
      const fileBytes = await bridge.readFile(path);
      // 复制一份独立 buffer，避免 pdf.js/pdf-lib 失败时 detached 原 buffer
      const uint8 = fileBytes.slice ? fileBytes.slice() : new Uint8Array(fileBytes);
      setLoading(true, '正在解析 PDF…');

      let pdf = null;
      let usedPassword = null; // 成功打开加密 PDF 时使用的密码（用于回传 ArkTS，供跳转工具页复用）
      try {
        pdf = await tryLoadWithPdfjs(uint8, undefined);
      } catch (e) {
        if (!isPasswordError(e)) throw e;
        // 需要密码，弹窗让用户输入
        let reason = pdfjsLib.PasswordResponses.NEED_PASSWORD;
        while (!pdf) {
          const pwd = await promptPassword(reason);
          if (pwd === null) {
            setLoading(true, '已取消打开加密文档');
            return;
          }
          try {
            pdf = await tryLoadWithPdfjs(uint8, pwd);
            usedPassword = pwd;
          } catch (err) {
            if (!isPasswordError(err)) throw err;
            // pdf.js 直接解密失败，尝试用 pdf-lib 解密（本应用加密工具产出的 PDF 需此兜底）
            try {
              pdf = await tryLoadWithPdfLibDecrypt(uint8, pwd);
              usedPassword = pwd;
            } catch (decErr) {
              if (!isPasswordError(decErr)) throw decErr;
              reason = pdfjsLib.PasswordResponses.INCORRECT_PASSWORD;
            }
          }
        }
      }

      // 加密文档成功打开后，把正确密码回传给 ArkTS，供从阅读器跳转工具页时复用（避免二次输入）
      if (usedPassword && window.nativeBridge && window.nativeBridge.reportPassword) {
        try { window.nativeBridge.reportPassword(state.path, usedPassword); } catch (re) { /* 忽略上报失败 */ }
      }

      state.pdfDoc = pdf;
      state.numPages = pdf.numPages;
      setLoading(false);
      buildPages();
      // 初始自适应缩放（让 A4 页宽适配屏幕）
      const cw = (dom.scroll.clientWidth || 400) - 32;
      state.fitScale = clampScale(Math.max(MIN_SCALE, Math.min(1.4, cw / 595)));
      state.scale = state.fitScale;
      const initPage = (window.__INIT_PAGE__ && window.__INIT_PAGE__ > 0) ? window.__INIT_PAGE__ : 1;
      gotoPage(initPage, true);
      updateIndicator();
      // 上报一次初始页码（含总页数），让原生顶栏立即显示「第 p / N 页」
      if (window.nativeBridge && window.nativeBridge.onReaderPage) {
        try { window.nativeBridge.onReaderPage(state.path, initPage, state.numPages); } catch (re) { /* 忽略 */ }
      }
    } catch (e) {
      console.error('openDocument error', e);
      // 失败时给出可操作的出口：点击加载层重试（原生顶栏的返回键也始终可用）
      setLoading(true, '打开失败：' + (e && e.message ? e.message : e) + '（点击重试）');
      dom.loading.onclick = () => { dom.loading.onclick = null; openDocument(path); };
    }
  }

  // ============ 构建页面占位 ============
  function buildPages() {
    dom.pages.innerHTML = '';
    state.pages = [];
    for (let i = 1; i <= state.numPages; i++) {
      const wrap = document.createElement('div');
      wrap.className = 'page-wrap';
      wrap.dataset.page = i;
      const ph = document.createElement('div');
      ph.className = 'page-ph';
      ph.style.width = '300px';
      ph.style.height = '400px';
      ph.textContent = '第 ' + i + ' 页';
      wrap.appendChild(ph);
      dom.pages.appendChild(wrap);
      state.pages.push({ wrap, canvas: null, ctx: null, textLayer: null, num: i, rendered: false, ph });
    }
    layoutPlaceholders();
    setupLazyRender();
  }

  // 根据当前 scale/rotation 计算每页占位尺寸
  function layoutPlaceholders() {
    for (const p of state.pages) {
      if (p.rendered && p.canvas) continue;
      const ph = p.ph;
      if (!ph) continue;
      const size = estimatePageSize(p.num);
      ph.style.width = Math.round(size.w) + 'px';
      ph.style.height = Math.round(size.h) + 'px';
    }
  }

  let cachedRatio = 1.294; // 默认 A4 比例
  function estimatePageSize(num) {
    if (state.mode === 'double') {
      // 双页：高度填满可视区，宽度按比例
      const availH = (dom.scroll.clientHeight || 600) - 32;
      const h = Math.min(availH, 1200) * state.scale;
      const w = h / cachedRatio;
      return { w, h };
    }
    const baseW = Math.min(dom.scroll.clientWidth - 32, 900);
    const w = baseW * state.scale;
    const h = w * cachedRatio;
    return { w, h };
  }

  // ============ 懒渲染（可见才渲染）============
  let io = null;
  function setupLazyRender() {
    if (io) io.disconnect();
    const isDouble = state.mode === 'double';
    io = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          const num = parseInt(entry.target.dataset.page, 10);
          renderPage(num);
        }
      }
    }, { root: dom.scroll, rootMargin: isDouble ? '0px 400px 0px' : '400px 0px' });
    for (const p of state.pages) {
      if (p.wrap) io.observe(p.wrap);
    }
  }

  // ============ 渲染单页 ============
  async function renderPage(num) {
    const p = state.pages[num - 1];
    if (!p || p.rendered || !state.pdfDoc) return;
    const token = state.renderToken;
    try {
      const page = await state.pdfDoc.getPage(num);
      if (token !== state.renderToken) return;
      const viewport = page.getViewport({ scale: state.scale * DPR, rotation: state.rotation });
      const cssW = viewport.width / DPR;
      const cssH = viewport.height / DPR;
      if (num === 1) cachedRatio = cssH / cssW;

      if (p.ph && p.ph.parentNode) p.ph.parentNode.removeChild(p.ph);
      p.ph = null;

      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.width = cssW + 'px';
      canvas.style.height = cssH + 'px';
      const ctx = canvas.getContext('2d');
      p.wrap.appendChild(canvas);
      p.canvas = canvas;
      p.ctx = ctx;

      const textLayer = document.createElement('div');
      textLayer.className = 'text-layer';
      textLayer.style.width = cssW + 'px';
      textLayer.style.height = cssH + 'px';
      p.wrap.appendChild(textLayer);
      p.textLayer = textLayer;

      const renderTask = page.render({ canvasContext: ctx, viewport });
      await renderTask.promise;
      if (token !== state.renderToken) return;

      const textContent = await page.getTextContent();
      if (token !== state.renderToken) return;
      buildTextLayer(textLayer, textContent, viewport, num);

      p.rendered = true;
    } catch (e) {
      console.error('renderPage error', num, e);
    }
  }

  // ============ 文本层（可选中 + 搜索高亮）============
  function buildTextLayer(container, textContent, viewport, num) {
    container.innerHTML = '';
    const scale = viewport.scale;
    const transformer = pdfjsLib.Util.transform;
    for (const item of textContent.items) {
      if (!item.str) continue;
      const tx = transformer(viewport.transform, item.transform);
      const fontHeight = Math.hypot(tx[2], tx[3]);
      const left = tx[4];
      const top = tx[5] - fontHeight;
      const span = document.createElement('span');
      span.textContent = item.str;
      span.style.left = left + 'px';
      span.style.top = top + 'px';
      span.style.fontSize = fontHeight + 'px';
      span.style.transform = 'matrix(' + tx[0] + ',' + tx[1] + ',' + tx[2] + ',' + tx[3] + ',0,0)';
      span.dataset.text = item.str;
      if (state.searchTerm && item.str.toLowerCase().indexOf(state.searchTerm.toLowerCase()) >= 0) {
        span.classList.add('hl');
      }
      container.appendChild(span);
    }
  }

  // ============ 缩放 ============
  function zoom(delta) {
    const ns = clampScale(state.scale + delta);
    if (ns === state.scale) return;
    state.scale = ns;
    rerenderAll();
    updateStatusBar();
  }

  function rerenderAll() {
    state.renderToken++;
    for (const p of state.pages) {
      if (p.rendered) {
        if (p.canvas && p.canvas.parentNode) p.canvas.parentNode.removeChild(p.canvas);
        if (p.textLayer && p.textLayer.parentNode) p.textLayer.parentNode.removeChild(p.textLayer);
        const ph = document.createElement('div');
        ph.className = 'page-ph';
        ph.textContent = '第 ' + p.num + ' 页';
        p.wrap.appendChild(ph);
        p.ph = ph; p.canvas = null; p.textLayer = null; p.rendered = false;
      }
    }
    layoutPlaceholders();
    renderVisible();
  }

  // 仅重渲当前视口内的页面（供缩放/模式切换调用，避免全量遍历渲染）
  function renderVisible() {
    const isDouble = state.mode === 'double';
    for (const p of state.pages) {
      const rect = p.wrap.getBoundingClientRect();
      const sr = dom.scroll.getBoundingClientRect();
      const visible = isDouble
        ? (rect.right > sr.left - 200 && rect.left < sr.right + 200)
        : (rect.bottom > sr.top - 400 && rect.top < sr.bottom + 400);
      if (visible) renderPage(p.num);
    }
  }

  // ============ 旋转 ============
  function rotate() {
    state.rotation = (state.rotation + 90) % 360;
    rerenderAll();
    updateStatusBar();
  }

  // ============ 翻页 / 定位 ============
  function gotoPage(num, smooth) {
    num = Math.max(1, Math.min(state.numPages, num));
    const p = state.pages[num - 1];
    if (p && p.wrap) {
      if (state.mode === 'double') {
        dom.scroll.scrollTo({ left: p.wrap.offsetLeft - 8, behavior: smooth ? 'smooth' : 'auto' });
      } else {
        const top = p.wrap.offsetTop - 8;
        dom.scroll.scrollTo({ top: top, behavior: smooth ? 'smooth' : 'auto' });
      }
      renderPage(num);
    }
  }

  function prevPage() { gotoPage(state.currentPage - 1, true); }
  function nextPage() { gotoPage(state.currentPage + 1, true); }

  // ============ 当前页计算 + 进度上报 ============
  function updateCurrentPage() {
    const sr = dom.scroll.getBoundingClientRect();
    let best = 1, bestDist = Infinity;
    if (state.mode === 'double') {
      const mid = sr.left + sr.width / 2;
      for (const p of state.pages) {
        const r = p.wrap.getBoundingClientRect();
        const c = r.left + r.width / 2;
        const d = Math.abs(c - mid);
        if (d < bestDist) { bestDist = d; best = p.num; }
      }
    } else {
      const mid = sr.top + sr.height / 2;
      for (const p of state.pages) {
        const r = p.wrap.getBoundingClientRect();
        const c = r.top + r.height / 2;
        const d = Math.abs(c - mid);
        if (d < bestDist) { bestDist = d; best = p.num; }
      }
    }
    if (best !== state.currentPage) {
      state.currentPage = best;
      updateIndicator();
      if (window.nativeBridge && window.nativeBridge.onReaderPage) {
        // 第三参数携带总页数，供原生侧展示「第 p / N 页」
        window.nativeBridge.onReaderPage(state.path, best, state.numPages);
      }
    }
    updateThumbHighlight(best);
  }

  function updateIndicator() {
    dom.indicator.textContent = state.currentPage + ' / ' + state.numPages;
    dom.pageJump.value = '';
    updateStatusBar();
  }

  function updateStatusBar() {
    if (dom.sbPage) dom.sbPage.textContent = '第 ' + state.currentPage + ' / ' + state.numPages + ' 页';
    if (dom.sbZoom) dom.sbZoom.textContent = Math.round(state.scale * 100) + '%';
  }

  // ============ 模式切换（连续 / 单页 / 双页）============
  function toggleMode() {
    // 循环：连续 -> 单页 -> 双页 -> 连续
    if (state.mode === 'continuous') state.mode = 'single';
    else if (state.mode === 'single') state.mode = 'double';
    else state.mode = 'continuous';

    // 重置布局类
    dom.scroll.classList.remove('single-snap', 'double');
    dom.pages.classList.remove('double');
    if (state.mode === 'single') dom.scroll.classList.add('single-snap');
    if (state.mode === 'double') {
      dom.scroll.classList.add('double');
      dom.pages.classList.add('double');
    }
    dom.btnMode.textContent = state.mode === 'single' ? '单页' : (state.mode === 'double' ? '双页' : '连续');
    rerenderAll();
    setupLazyRender();
    updateStatusBar();
    gotoPage(state.currentPage, false); // 切换模式后停留在当前页
  }

  // ============ 侧栏（目录/缩略图）与工具栏显隐协调 ============
  // 任一面板打开时，工具栏+小尾巴完全让位移出屏幕，避免 z-index 更高而遮挡面板顶部条目
  function syncPanelChrome() {
    const anyPanel = dom.panelLeft.classList.contains('open') || dom.panelRight.classList.contains('open');
    if (anyPanel) {
      dom.toolbar.classList.add('panel-open');
    } else {
      dom.toolbar.classList.remove('panel-open');
      showToolbar(); // 关闭面板后工具栏淡入（数秒后自动淡出留小尾巴）
    }
  }

  // 统一关闭两个侧栏面板，并回收工具栏让位状态。
  // 注意：跳转/点空白关闭面板后【不】主动唤出工具栏——保持沉浸阅读，
  // 只移除 panel-open 让位类并隐藏整条工具栏，让右端小尾巴保留、可供随时重新唤出。
  function closePanels() {
    dom.panelLeft.classList.remove('open');
    dom.panelRight.classList.remove('open');
    dom.toolbar.classList.remove('panel-open');
    hideToolbar();
  }

  // ============ 目录大纲 ============
  async function toggleOutline() {
    dom.panelRight.classList.remove('open');
    const open = dom.panelLeft.classList.toggle('open');
    syncPanelChrome();
    if (open && state.pdfDoc && dom.outlineList.children.length === 0) {
      try {
        const outline = await state.pdfDoc.getOutline();
        renderOutline(outline, 0);
      } catch (e) {
        dom.outlineList.innerHTML = '<div class="outline-item">无目录</div>';
      }
    }
  }

  function renderOutline(items, level) {
    if (!items) { dom.outlineList.innerHTML = '<div class="outline-item">无目录</div>'; return; }
    for (const it of items) {
      const div = document.createElement('div');
      div.className = 'outline-item lv' + (level + 1);
      div.textContent = it.title || '(无标题)';
      div.onclick = () => { goToOutlineDest(it); closePanels(); };
      dom.outlineList.appendChild(div);
      if (it.items && it.items.length) renderOutline(it.items, level + 1);
    }
  }

  async function goToOutlineDest(item) {
    try {
      let dest = item.dest;
      if (typeof dest === 'string') dest = await state.pdfDoc.getDestination(dest);
      if (Array.isArray(dest)) {
        const ref = dest[0];
        const pageIndex = await state.pdfDoc.getPageIndex(ref);
        gotoPage(pageIndex + 1, true);
      }
    } catch (e) {
      showToast('无法跳转到该目录项');
    }
  }

  // ============ 缩略图（懒渲染 + 当前页高亮）============
  function toggleThumbnails() {
    dom.panelLeft.classList.remove('open');
    const open = dom.panelRight.classList.toggle('open');
    syncPanelChrome();
    if (open) buildThumbnails();
  }

  let thumbBuilt = false;
  let thumbIO = null;
  function buildThumbnails() {
    if (thumbBuilt) {
      updateThumbHighlight(state.currentPage);
      return;
    }
    thumbBuilt = true;
    const tscale = 0.18;
    for (let i = 1; i <= state.numPages; i++) {
      const item = document.createElement('div');
      item.className = 'thumb-item';
      item.dataset.page = i;
      const cv = document.createElement('canvas');
      item.appendChild(cv);
      const num = document.createElement('div');
      num.className = 'tnum';
      num.textContent = '第 ' + i + ' 页';
      item.appendChild(num);
      item.onclick = () => { gotoPage(i, true); closePanels(); };
      dom.thumbList.appendChild(item);
    }
    // 懒渲染：仅在缩略图面板可见时渲染对应 canvas
    if (thumbIO) thumbIO.disconnect();
    thumbIO = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          const num = parseInt(entry.target.dataset.page, 10);
          const cv = entry.target.querySelector('canvas');
          if (cv && !cv.dataset.done) {
            cv.dataset.done = '1';
            renderThumb(num, cv, tscale);
          }
          thumbIO.unobserve(entry.target);
        }
      }
    }, { root: dom.panelRight, rootMargin: '200px 0px' });
    for (const item of dom.thumbList.children) thumbIO.observe(item);
    updateThumbHighlight(state.currentPage);
  }

  function updateThumbHighlight(page) {
    if (!dom.thumbList) return;
    const active = dom.thumbList.querySelector('.thumb-item.active');
    if (active && active.dataset.page !== String(page)) active.classList.remove('active');
    const cur = dom.thumbList.querySelector('.thumb-item[data-page="' + page + '"]');
    if (cur) cur.classList.add('active');
  }

  async function renderThumb(num, canvas, tscale) {
    try {
      const page = await state.pdfDoc.getPage(num);
      const vp = page.getViewport({ scale: tscale * DPR });
      canvas.width = Math.floor(vp.width);
      canvas.height = Math.floor(vp.height);
      canvas.style.width = (vp.width / DPR) + 'px';
      canvas.style.height = (vp.height / DPR) + 'px';
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
    } catch (e) { /* ignore */ }
  }

  // ============ 全文搜索 ============
  function toggleSearch() {
    const open = dom.searchPanel.classList.toggle('open');
    if (open) {
      // 搜索栏与工具栏互斥占用顶部：搜索开启时给工具栏加 searching 类，
      // 让它连同右端小尾巴一起完全移出屏幕顶端，由搜索栏独占顶部，避免两者在 top:0 重叠
      dom.toolbar.classList.add('searching');
      hideToolbar();
      setTimeout(() => dom.searchInput.focus(), 50);
    } else {
      dom.toolbar.classList.remove('searching');
      dom.searchResults.classList.remove('open');
      clearHighlights();
      showToolbar(); // 关闭搜索后恢复工具栏（数秒后自动淡出回小尾巴）
    }
  }

  async function doSearch(keyword) {
    state.searchTerm = keyword.trim();
    state.searchMatches = [];
    state.searchCursor = -1;
    dom.searchResults.innerHTML = '';
    if (!state.searchTerm) {
      dom.searchCount.textContent = '';
      clearHighlights();
      rerenderTextLayers();
      return;
    }
    setLoading(true, '搜索中…');
    const kw = state.searchTerm.toLowerCase();
    for (let i = 1; i <= state.numPages; i++) {
      try {
        const page = await state.pdfDoc.getPage(i);
        const tc = await page.getTextContent();
        let buffer = '';
        let matchCount = 0;
        for (const it of tc.items) {
          if (!it.str) continue;
          buffer += it.str + ' ';
          if (it.str.toLowerCase().indexOf(kw) >= 0) matchCount++;
        }
        if (matchCount > 0) {
          state.searchMatches.push({ page: i, count: matchCount, text: buffer });
        }
      } catch (e) { /* ignore */ }
    }
    setLoading(false);
    dom.searchCount.textContent = state.searchMatches.length + ' 页';
    renderSearchResults();
    rerenderTextLayers();
  }

  function renderSearchResults() {
    dom.searchResults.innerHTML = '';
    if (state.searchMatches.length === 0) {
      const d = document.createElement('div');
      d.className = 'search-res';
      d.textContent = '未找到匹配';
      dom.searchResults.appendChild(d);
      dom.searchResults.classList.add('open');
      return;
    }
    state.searchMatches.forEach((m) => {
      const d = document.createElement('div');
      d.className = 'search-res';
      const snippet = makeSnippet(m.text, state.searchTerm);
      d.innerHTML = '<span class="sn">第' + m.page + '页</span>' + snippet;
      d.onclick = () => {
        gotoPage(m.page, true);
        dom.searchResults.classList.remove('open');
      };
      dom.searchResults.appendChild(d);
    });
    dom.searchResults.classList.add('open');
  }

  function makeSnippet(text, kw) {
    const lower = text.toLowerCase();
    const idx = lower.indexOf(kw.toLowerCase());
    if (idx < 0) return escapeHtml(text.substring(0, 40));
    const start = Math.max(0, idx - 15);
    const end = Math.min(text.length, idx + kw.length + 25);
    const before = escapeHtml(text.substring(start, idx));
    const hit = escapeHtml(text.substring(idx, idx + kw.length));
    const after = escapeHtml(text.substring(idx + kw.length, end));
    return (start > 0 ? '…' : '') + before + '<mark>' + hit + '</mark>' + after + (end < text.length ? '…' : '');
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function clearHighlights() {
    state.searchTerm = '';
  }

  async function rerenderTextLayers() {
    for (const p of state.pages) {
      if (p.rendered && p.textLayer && state.pdfDoc) {
        const page = await state.pdfDoc.getPage(p.num);
        const vp = page.getViewport({ scale: state.scale * DPR, rotation: state.rotation });
        const tc = await page.getTextContent();
        buildTextLayer(p.textLayer, tc, vp, p.num);
      }
    }
  }

  // ============ 文本选择复制 ============
  function onSelectionEnd() {
    const sel = window.getSelection();
    if (sel && sel.toString().trim().length > 0) {
      const text = sel.toString();
      if (window.nativeBridge && window.nativeBridge.copyToClipboard) {
        window.nativeBridge.copyToClipboard(text);
        showToast('已复制 ' + text.length + ' 字');
      }
    }
  }

  // ============ 手势缩放（捏合 + 双击 + 中部横滑抽屉）============
  function touchDist(t) {
    const dx = t[0].clientX - t[1].clientX;
    const dy = t[0].clientY - t[1].clientY;
    return Math.hypot(dx, dy);
  }

  // 中部触发区：水平 20%~80%、垂直 20%~80%（占屏 60%×60%，足够大），
  // 以此避开左右边缘的系统返回手势与顶部工具栏触发区 / 底部状态胶囊。
  function inMiddleZone(x, y) {
    const w = dom.scroll.clientWidth || window.innerWidth;
    const h = dom.scroll.clientHeight || window.innerHeight;
    return x > w * 0.2 && x < w * 0.8 && y > h * 0.2 && y < h * 0.8;
  }

  // 判定是否为「中部横向快滑」：用于唤起侧栏抽屉。
  // 排除双页模式（其横向滑动用于原生翻页）与搜索态；要求水平位移够大且明显大于垂直、且够快。
  function trySwipePanel(dx, dy, dt, sx, sy) {
    if (state.mode === 'double') return false;
    if (dom.searchPanel.classList.contains('open')) return false;
    if (!inMiddleZone(sx, sy)) return false;
    const SWIPE_MIN = 60;     // 最小水平位移（px），阈值放宽、不苛刻
    const SWIPE_RATIO = 1.5;  // 水平必须明显大于垂直
    const SWIPE_MAXDT = 700;  // 快速手势上限（ms）
    if (dt > SWIPE_MAXDT) return false;
    if (Math.abs(dx) < SWIPE_MIN) return false;
    if (Math.abs(dx) <= Math.abs(dy) * SWIPE_RATIO) return false;
    return true;
  }

  // 中部横滑专用：打开指定侧栏（并切到对侧关闭）。左滑→右抽屉(缩略图)，右滑→左抽屉(目录)。
  function showPanel(side) {
    if (dom.searchPanel.classList.contains('open')) return;
    if (side === 'left') {
      if (dom.panelLeft.classList.contains('open')) return; // 已开，不重复
      dom.panelRight.classList.remove('open');
      dom.panelLeft.classList.add('open');
      syncPanelChrome();
      if (state.pdfDoc && dom.outlineList.children.length === 0) {
        state.pdfDoc.getOutline().then((o) => renderOutline(o, 0)).catch(() => {
          dom.outlineList.innerHTML = '<div class="outline-item">无目录</div>';
        });
      }
    } else {
      if (dom.panelRight.classList.contains('open')) return;
      dom.panelLeft.classList.remove('open');
      dom.panelRight.classList.add('open');
      syncPanelChrome();
      if (!thumbBuilt) buildThumbnails();
    }
  }

  function onTouchStart(e) {
    if (e.touches.length === 2) {
      state.touch.pinchActive = true;
      state.touch.startDist = touchDist(e.touches);
      state.touch.startScale = state.scale;
      state.touch.swipeStart = null; // 进入捏合，作废单指滑动记录
    } else if (e.touches.length === 1) {
      state.touch.pinchActive = false;
      const t = e.touches[0];
      state.touch.swipeStart = { x: t.clientX, y: t.clientY, t: Date.now() };
    }
  }

  function onTouchMove(e) {
    if (e.touches.length === 2 && state.touch.pinchActive && state.touch.startDist > 0) {
      e.preventDefault();
      const ratio = touchDist(e.touches) / state.touch.startDist;
      const ns = clampScale(state.touch.startScale * ratio);
      // 捏合期间只记录目标缩放，用 CSS transform 做视觉预览；
      // 不逐帧 rerenderAll（逐帧重建 canvas 会明显卡顿），松手后才正式重渲。
      state.scale = ns;
      const live = ns / state.touch.startScale;
      dom.pages.style.transformOrigin = '50% 0';
      dom.pages.style.transform = 'scale(' + live + ')';
      updateStatusBar();
    }
  }

  function onTouchEnd(e) {
    if (state.touch.pinchActive) {
      if (e.touches.length < 2) {
        state.touch.pinchActive = false;
        // 捏合结束：撤掉预览 transform，按新缩放正式重渲
        dom.pages.style.transform = '';
        rerenderAll();
        updateStatusBar();
      }
      return; // 捏合过程不触发选择复制
    }
    const t = e.changedTouches[0];
    const sw = state.touch.swipeStart;
    state.touch.swipeStart = null;
    if (sw) {
      const dx = t.clientX - sw.x;
      const dy = t.clientY - sw.y;
      const dt = Date.now() - sw.t;
      if (trySwipePanel(dx, dy, dt, sw.x, sw.y)) {
        // 右滑(dx>0)→左抽屉(目录)；左滑(dx<0)→右抽屉(缩略图)
        showPanel(dx > 0 ? 'left' : 'right');
        state.touch.lastSwipeAt = Date.now(); // 标记，防止合成 click 把刚开的面板又关掉
        return; // 手势已消费，不再走双击/选择逻辑
      }
    }
    const now = Date.now();
    if (state.lastTap && (now - state.lastTap.time) < 300 &&
        Math.hypot(t.clientX - state.lastTap.x, t.clientY - state.lastTap.y) < 30) {
      handleDoubleTap();
      state.lastTap = null;
      return;
    }
    state.lastTap = { time: now, x: t.clientX, y: t.clientY };
    setTimeout(onSelectionEnd, 0);
  }

  function handleDoubleTap() {
    const target = (Math.abs(state.scale - state.fitScale) < 0.05 * state.fitScale)
      ? Math.min(MAX_SCALE, state.fitScale * 2)
      : state.fitScale;
    state.scale = target;
    rerenderAll();
    updateStatusBar();
  }

  // ============ 绑定 UI ============
  function bindUI() {
    dom.btnZoomIn.onclick = () => { zoom(0.2); showToolbar(); };
    dom.btnZoomOut.onclick = () => { zoom(-0.2); showToolbar(); };
    dom.btnPrev.onclick = () => { prevPage(); showToolbar(); };
    dom.btnNext.onclick = () => { nextPage(); showToolbar(); };
    dom.btnRotate.onclick = () => { rotate(); showToolbar(); };
    dom.btnMode.onclick = () => { toggleMode(); showToolbar(); };
    dom.btnToc.onclick = () => { toggleOutline(); };
    dom.btnThumb.onclick = () => { toggleThumbnails(); };
    dom.btnSearch.onclick = () => { toggleSearch(); };
    dom.btnSearchClose.onclick = () => { toggleSearch(); };
    dom.btnHide.onclick = (e) => { e.stopPropagation(); hideToolbar(); };
    // 全文搜索：300ms 防抖，避免每个按键都全量提取文本（大文档会卡）
    let searchTimer = 0;
    dom.searchInput.oninput = (e) => {
      clearTimeout(searchTimer);
      const kw = e.target.value;
      searchTimer = setTimeout(() => doSearch(kw), 300);
    };
    dom.btnSearchPrev.onclick = () => jumpSearch(-1);
    dom.btnSearchNext.onclick = () => jumpSearch(1);

    // 页码跳转
    dom.pageJump.onkeydown = (e) => {
      if (e.key === 'Enter') { jumpToPageInput(); dom.pageJump.blur(); }
    };
    dom.pageJump.onchange = () => jumpToPageInput();

    // 底部状态胶囊：点击唤出工具栏
    dom.statusBar.onclick = (e) => { e.stopPropagation(); showToolbar(); };
    // 右上角小尾巴：切换开关（工具栏显示态点→关闭；隐藏态点→唤出）
    if (dom.toolbarHandle) dom.toolbarHandle.onclick = (e) => {
      e.stopPropagation();
      if (dom.toolbar.classList.contains('visible')) hideToolbar();
      else showToolbar();
    };

    dom.scroll.addEventListener('scroll', () => {
      updateCurrentPage();
      if (dom.toolbar.classList.contains('visible')) resetAutoHide();
    }, { passive: true });

    // 手势缩放
    dom.scroll.addEventListener('touchstart', onTouchStart, { passive: true });
    dom.scroll.addEventListener('touchmove', onTouchMove, { passive: false });
    dom.scroll.addEventListener('touchend', onTouchEnd, { passive: true });
    dom.scroll.addEventListener('mouseup', onSelectionEnd);

    // 点击：工具栏显示态下点页面/空白即关闭；隐藏态点顶部唤出；小尾巴自带 toggle
    dom.body.addEventListener('click', (e) => {
      // 横滑手势结束后浏览器可能合成一次 click（落在中部触发区、恰好在面板外），
      // 若直接走“面板外点击关闭”会把刚滑出的面板又关掉。滑动后 500ms 内的 click 一律忽略。
      if (Date.now() - state.touch.lastSwipeAt < 500) return;
      // 工具栏内部：交给工具栏自身 onclick 处理（含目录/缩略图按钮的开关面板）。
      // 必须先于“面板关闭”逻辑，否则点目录/缩略图按钮会被误判为“关闭面板”而刚开即关
      if (dom.toolbar.contains(e.target)) {
        if (e.target.closest('button, input')) resetAutoHide();
        else hideToolbar();
        return;
      }
      // 侧栏：点击落在面板之外（且当时有面板打开）时统一关闭并回收工具栏
      const wasPanel = dom.panelLeft.classList.contains('open') || dom.panelRight.classList.contains('open');
      if (wasPanel && !dom.panelLeft.contains(e.target) && !dom.panelRight.contains(e.target)) {
        closePanels();
      }
      // 点击落在侧栏面板内部（目录/缩略图条目）：交给条目自身 onclick 处理跳转与关闭，工具栏逻辑不介入
      if (dom.panelLeft.contains(e.target) || dom.panelRight.contains(e.target)) return;
      // 搜索面板内不处理（由搜索自身逻辑接管）
      if (dom.searchPanel.contains(e.target)) return;
      // 搜索开启时顶部由搜索栏接管，禁止工具栏任何显隐逻辑介入
      if (dom.searchPanel.classList.contains('open')) return;
      // 工具栏显示态：点击页面任意处（外部）→ 立即关闭（沉浸阅读）
      if (dom.toolbar.classList.contains('visible')) {
        hideToolbar();
        return;
      }
      // 工具栏隐藏态：点击屏幕顶部触发区 → 淡入工具栏
      if (e.clientY <= TOP_ZONE_PX) showToolbar();
    });

    window.__onPathReady = () => { if (window.__PDF_PATH__) openDocument(window.__PDF_PATH__); };
  }

  function jumpToPageInput() {
    const n = parseInt(dom.pageJump.value, 10);
    if (!isNaN(n) && n >= 1 && n <= state.numPages) {
      gotoPage(n, true);
    }
    dom.pageJump.value = '';
  }

  function jumpSearch(dir) {
    if (state.searchMatches.length === 0) return;
    state.searchCursor = (state.searchCursor + dir + state.searchMatches.length) % state.searchMatches.length;
    const m = state.searchMatches[state.searchCursor];
    gotoPage(m.page, true);
    dom.searchCount.textContent = (state.searchCursor + 1) + '/' + state.searchMatches.length;
  }

  // ============ 初始化 ============
  function init() {
    dom.loading = $('loading');
    dom.toast = $('toast');
    dom.pages = $('pages');
    dom.scroll = $('scroll');
    dom.body = $('body');
    dom.indicator = $('page-indicator');
    dom.toolbar = $('toolbar');
    dom.statusBar = $('status-bar');
    dom.sbPage = $('sb-page');
    dom.sbZoom = $('sb-zoom');
    dom.pageJump = $('page-jump');
    dom.btnZoomIn = $('btn-zoom-in');
    dom.btnZoomOut = $('btn-zoom-out');
    dom.btnPrev = $('btn-prev');
    dom.btnNext = $('btn-next');
    dom.btnRotate = $('btn-rotate');
    dom.btnMode = $('btn-mode');
    dom.btnToc = $('btn-toc');
    dom.btnThumb = $('btn-thumb');
    dom.btnSearch = $('btn-search');
    dom.btnSearchClose = $('btn-search-close');
    dom.btnHide = $('btn-hide');
    dom.toolbarHandle = $('toolbar-handle');
    dom.searchPanel = $('search-panel');
    dom.searchInput = $('search-input');
    dom.searchCount = $('search-count');
    dom.searchResults = $('search-results');
    dom.btnSearchPrev = $('btn-search-prev');
    dom.btnSearchNext = $('btn-search-next');
    dom.panelLeft = $('panel-left');
    dom.panelRight = $('panel-right');
    dom.outlineList = $('outline-list');
    dom.thumbList = $('thumb-list');
    dom.pwdOverlay = $('pwd-overlay');
    dom.pwdBox = $('pwd-box');
    dom.pwdTitle = $('pwd-title');
    dom.pwdHint = $('pwd-hint');
    dom.pwdInput = $('pwd-input');
    dom.pwdConfirm = $('pwd-confirm');
    dom.pwdCancel = $('pwd-cancel');

    setupPasswordModal();

    if (typeof pdfjsLib === 'undefined') {
      setLoading(true, 'pdf.js 未加载');
      return;
    }
    pdfjsLib.GlobalWorkerOptions.workerSrc = '../lib/pdf.worker.min.js';

    bindUI();
    // 用工具栏真实高度作为收起位移，确保收起时整条上移、只露右端小尾巴
    dom.toolbar.style.setProperty('--collapse', dom.toolbar.offsetHeight + 'px');
    showToolbar(); // 进入阅读器默认显示顶部工具栏，数秒后自动淡出并留右端小尾巴
    waitForPath();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
