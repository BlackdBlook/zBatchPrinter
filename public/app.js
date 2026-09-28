/* BatchPrint 前端逻辑：文件管理 / 设置 / 预览 / 批量打印任务轮询 */
'use strict';

const $ = (id) => document.getElementById(id);

const DEFAULT_SETTINGS = {
  printer: '',
  paper: 'A4',
  orientation: 'auto',
  scaleMode: 'fit',
  scalePercent: 100,
  margin: { top: 0, right: 0, bottom: 0, left: 0 },
  halign: 'center',
  valign: 'middle',
  copies: 1,
  duplex: 'default',
  color: 'default',
};

const PREVIEW_HINT_DEFAULT = '添加文件后点击「生成预览」，或直接单击左侧列表中的文件切换预览；修改设置会自动刷新（浏览器自带 PDF 查看器渲染）。';

const state = {
  files: [],        // { id, name, pages, size, status: 'uploading'|'ready'|job状态, error }
  selectedFileId: null, // 预览目标：单击列表选中的文件，空则回退第一个
  jobId: null,
  jobRunning: false,
  pollTimer: null,
  engineTimer: null,
  previewUrl: null,
  previewOpened: false,
  previewDebounce: null,
};

const STATUS_TEXT = {
  uploading: '上传中…',
  ready: '就绪',
  queued: '排队中',
  transforming: '排版中…',
  printing: '打印中…',
  done: '✔ 已打印',
  error: '✖ 失败',
  cancelled: '已取消',
};

// ---------------- 设置读写 ----------------
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem('batchprint.settings') || 'null');
    return s ? { ...DEFAULT_SETTINGS, ...s, margin: { ...DEFAULT_SETTINGS.margin, ...(s.margin || {}) } } : { ...DEFAULT_SETTINGS };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(s) {
  localStorage.setItem('batchprint.settings', JSON.stringify(s));
}

function collectSettings() {
  const s = {
    printer: $('setPrinter').value || '',
    paper: $('setPaper').value,
    orientation: document.querySelector('input[name="orientation"]:checked').value,
    scaleMode: document.querySelector('input[name="scaleMode"]:checked').value,
    scalePercent: Number($('setScalePercent').value) || 100,
    margin: {
      top: Number($('mTop').value) || 0,
      right: Number($('mRight').value) || 0,
      bottom: Number($('mBottom').value) || 0,
      left: Number($('mLeft').value) || 0,
    },
    halign: $('setHalign').value,
    valign: $('setValign').value,
    copies: Number($('setCopies').value) || 1,
    duplex: $('setDuplex').value,
    color: $('setColor').value,
  };
  saveSettings(s);
  return s;
}

function applySettingsToDom(s) {
  $('setPaper').value = s.paper;
  document.querySelector(`input[name="orientation"][value="${s.orientation}"]`).checked = true;
  document.querySelector(`input[name="scaleMode"][value="${s.scaleMode}"]`).checked = true;
  $('setScalePercent').value = s.scalePercent;
  $('mTop').value = s.margin.top;
  $('mRight').value = s.margin.right;
  $('mBottom').value = s.margin.bottom;
  $('mLeft').value = s.margin.left;
  $('setHalign').value = s.halign;
  $('setValign').value = s.valign;
  $('setCopies').value = s.copies;
  $('setDuplex').value = s.duplex;
  $('setColor').value = s.color;
  $('setPrinter').dataset.value = s.printer || '';
  updateScalePercentVisibility();
}

// ---------------- 配置（引擎/打印机） ----------------
async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    const cfg = await res.json();
    renderPrinters(cfg.printers);
    renderEngine(cfg.engine);
  } catch {
    renderEngine({ status: 'error', error: '无法连接本地服务' });
  }
}

function renderPrinters(printers) {
  const sel = $('setPrinter');
  const prev = sel.dataset.value ?? sel.value;
  sel.innerHTML = '';
  if (!printers.length) {
    sel.innerHTML = '<option value="">（未检测到打印机）</option>';
    $('printerBadge').textContent = '未检测到打印机';
    $('printerBadge').className = 'badge badge-err';
    return;
  }
  const def = printers.find((p) => p.default);
  for (const p of printers) {
    const opt = document.createElement('option');
    opt.value = p.name;
    opt.textContent = p.name + (p.default ? '（默认）' : '') + (p.offline ? ' [脱机]' : '');
    sel.appendChild(opt);
  }
  const target = printers.find((p) => p.name === prev) || def || printers[0];
  sel.value = target.name;
  sel.dataset.value = target.name;
  const ok = !target.offline;
  $('printerBadge').textContent = `打印机：${target.name}${target.offline ? '（脱机）' : ''}`;
  $('printerBadge').className = 'badge ' + (ok ? 'badge-ok' : 'badge-warn');
  updatePrintBtn();
}

function renderEngine(engine) {
  const badge = $('engineBadge');
  const banner = $('engineBanner');
  clearInterval(state.engineTimer);
  let needPoll = false;
  if (engine.status === 'ready') {
    badge.textContent = '打印引擎就绪';
    badge.className = 'badge badge-ok';
    banner.classList.add('hidden');
  } else if (engine.status === 'downloading') {
    badge.textContent = `打印引擎下载中 ${engine.progress}%`;
    badge.className = 'badge badge-warn';
    banner.className = 'banner banner-warn';
    banner.innerHTML = '⏳ 正在下载静默打印引擎（SumatraPDF 便携版，约 7MB，仅首次需要）…';
    needPoll = true;
  } else if (engine.status === 'error') {
    badge.textContent = '打印引擎未就绪';
    badge.className = 'badge badge-err';
    banner.className = 'banner banner-err';
    banner.innerHTML = '⚠️ 打印引擎自动下载失败：' + (engine.error || '') +
      '。请手动处理：<a href="https://www.sumatrapdfreader.org/download-free-pdf-viewer" target="_blank">下载 SumatraPDF</a>' +
      '（安装，或把便携版里的 SumatraPDF.exe 放入 tools\\SumatraPDF 文件夹）后重启本服务。预览功能不受影响。';
  } else {
    badge.textContent = '打印引擎检测中…';
    badge.className = 'badge badge-muted';
    needPoll = true;
  }
  if (needPoll) {
    state.engineTimer = setInterval(async () => {
      try {
        const cfg = await (await fetch('/api/config')).json();
        renderEngine(cfg.engine);
        if (cfg.engine.status === 'ready') updatePrintBtn();
      } catch { /* 忽略瞬时错误 */ }
    }, 2000);
  }
  updatePrintBtn();
}

// ---------------- 文件 ----------------
// items: FileList / File[] / {file, name}[]（name 可为拖入目录的相对路径）
async function addFiles(items) {
  const norm = [...items].map((it) => (it instanceof File ? { file: it, name: it.name } : it));
  const pdfs = norm.filter(({ file }) => /\.pdf$/i.test(file.name) || file.type === 'application/pdf');
  const skipped = norm.length - pdfs.length;
  if (skipped > 0) toast(`已跳过 ${skipped} 个非 PDF 文件`);
  if (!pdfs.length && norm.length) toast('未找到 PDF 文件', true);
  for (const { file, name } of pdfs) await uploadFile(file, name);
  updateSummary();
  schedulePreview();
}

async function uploadFile(f, displayName) {
  const temp = { id: 'tmp-' + Math.random().toString(36).slice(2), name: displayName || f.name, pages: null, size: f.size, status: 'uploading', error: null };
  state.files.push(temp);
  renderFileList();
  try {
    const res = await fetch('/api/upload?name=' + encodeURIComponent(displayName || f.name), { method: 'POST', body: f });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '上传失败');
    Object.assign(temp, { id: data.id, pages: data.pages, size: data.size, status: 'ready', name: data.name || temp.name });
    if (!state.selectedFileId) state.selectedFileId = data.id; // 首个上传完成的文件默认选中
  } catch (err) {
    temp.status = 'error';
    temp.error = err.message;
  }
  renderFileList();
  updateSummary();
  updatePrintBtn();
}

function removeFile(id) {
  if (state.jobRunning) return;
  const f = state.files.find((x) => x.id === id);
  if (!f || f.id.startsWith('tmp-')) return;
  state.files = state.files.filter((x) => x.id !== id);
  if (state.selectedFileId === id) state.selectedFileId = null;
  fetch('/api/files/' + id, { method: 'DELETE' }).catch(() => {});
  renderFileList();
  updateSummary();
  updatePrintBtn();
  if (!state.files.some((x) => !x.id.startsWith('tmp-'))) resetPreview();
  else schedulePreview();
}

async function clearFiles() {
  if (state.jobRunning) return;
  state.files = [];
  state.selectedFileId = null;
  await fetch('/api/files/clear', { method: 'POST' }).catch(() => {});
  renderFileList();
  updateSummary();
  updatePrintBtn();
  resetPreview();
}

// 单击列表行：选中并立即切换预览
function selectFile(id) {
  const f = state.files.find((x) => x.id === id);
  if (!f || id.startsWith('tmp-') || state.selectedFileId === id) return;
  state.selectedFileId = id;
  renderFileList();
  refreshPreview();
}

function previewTarget() {
  return state.files.find((x) => x.id === state.selectedFileId && !x.id.startsWith('tmp-'))
    || state.files.find((x) => !x.id.startsWith('tmp-'));
}

function renderFileList() {
  const ul = $('fileList');
  ul.innerHTML = '';
  $('emptyHint').classList.toggle('hidden', state.files.length > 0);
  for (const f of state.files) {
    const li = document.createElement('li');
    li.className = (f.status === 'error' ? 'error' : (f.status === 'uploading' ? 'uploading' : ''))
      + (f.id === state.selectedFileId ? ' selected' : '');
    li.title = '单击切换预览到此文件';
    li.addEventListener('click', () => selectFile(f.id));

    const main = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'f-name';
    name.title = f.error || f.name;
    name.textContent = f.name;
    const meta = document.createElement('div');
    meta.className = 'f-meta';
    meta.textContent = f.pages ? `${f.pages} 页 · ${fmtSize(f.size)}` : fmtSize(f.size);
    main.append(name, meta);

    const st = document.createElement('div');
    st.className = 'f-status st-' + f.status;
    st.textContent = f.error ? `✖ ${f.error}` : (STATUS_TEXT[f.status] || f.status);

    const rm = document.createElement('button');
    rm.className = 'f-remove';
    rm.title = '移除';
    rm.textContent = '✕';
    rm.disabled = state.jobRunning;
    rm.onclick = (e) => { e.stopPropagation(); removeFile(f.id); };

    li.append(main, st, rm);
    ul.appendChild(li);
  }
}

function updateSummary() {
  const total = state.files.filter((f) => !f.id.startsWith('tmp-')).length;
  const pages = state.files.reduce((a, f) => a + (f.pages || 0), 0);
  $('fileSummary').textContent = total ? `共 ${total} 个文件 · ${pages} 页` : '';
}

function fmtSize(n) {
  if (n > 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  if (n > 1024) return (n / 1024).toFixed(0) + ' KB';
  return n + ' B';
}

// ---------------- 预览 ----------------
function schedulePreview() {
  if (!state.previewOpened) return;
  clearTimeout(state.previewDebounce);
  state.previewDebounce = setTimeout(refreshPreview, 700);
}

function resetPreview() {
  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  state.previewUrl = null;
  state.previewOpened = false;
  clearTimeout(state.previewDebounce);
  $('previewFrame').classList.add('hidden');
  $('previewHint').classList.remove('hidden');
  $('previewHint').textContent = PREVIEW_HINT_DEFAULT;
  $('previewFile').textContent = '';
}

async function refreshPreview() {
  const f = previewTarget();
  if (!f) { toast('请先添加文件', true); return; }
  state.previewOpened = true;
  $('previewFile').textContent = f.name;
  $('previewHint').textContent = '正在生成预览…';
  try {
    const res = await fetch('/api/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileId: f.id, settings: collectSettings() }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || '预览失败');
    }
    const blob = await res.blob();
    if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
    state.previewUrl = URL.createObjectURL(blob);
    $('previewFrame').src = state.previewUrl;
    $('previewFrame').classList.remove('hidden');
    $('previewHint').classList.add('hidden');
  } catch (err) {
    $('previewHint').classList.remove('hidden');
    $('previewHint').textContent = '预览失败：' + err.message;
    $('previewFrame').classList.add('hidden');
  }
}

// ---------------- 打印任务 ----------------
function updatePrintBtn() {
  const btn = $('printBtn');
  const hasFiles = state.files.some((f) => !f.id.startsWith('tmp-'));
  const engineReady = $('engineBadge').classList.contains('badge-ok');
  btn.disabled = state.jobRunning || !hasFiles || !engineReady;
  btn.textContent = state.jobRunning ? '⏳ 正在打印…'
    : !engineReady ? '🖨️ 等待打印引擎就绪…'
    : '🖨️ 开始批量打印';
}

async function startPrint() {
  const fileIds = state.files.filter((f) => !f.id.startsWith('tmp-')).map((f) => f.id);
  if (!fileIds.length) return;
  const settings = collectSettings();
  let data;
  try {
    const res = await fetch('/api/print', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileIds, settings }),
    });
    data = await res.json();
    if (!res.ok) throw new Error(data.error || '无法开始打印');
  } catch (err) {
    toast(err.message, true);
    return;
  }
  state.jobId = data.jobId;
  state.jobRunning = true;
  for (const f of state.files) if (fileIds.includes(f.id)) { f.status = 'queued'; f.error = null; }
  renderFileList();
  updatePrintBtn();
  $('jobBar').classList.remove('hidden');
  pollJob();
}

function pollJob() {
  clearTimeout(state.pollTimer);
  state.pollTimer = setTimeout(async () => {
    try {
      const res = await fetch('/api/jobs/' + state.jobId);
      if (!res.ok) throw new Error();
      const job = await res.json();
      applyJob(job);
      if (job.status === 'running') return pollJob();
      finishJob(job);
      return;
    } catch { /* 瞬时错误，继续轮询 */ }
    pollJob();
  }, 600);
}

function applyJob(job) {
  for (const item of job.items) {
    const f = state.files.find((x) => x.id === item.id);
    if (f) { f.status = item.status; f.error = item.error; }
  }
  renderFileList();
  const finished = job.items.filter((i) => i.status === 'done' || i.status === 'error' || i.status === 'cancelled').length;
  const pct = Math.round((finished / job.items.length) * 100);
  $('jobProgressFill').style.width = pct + '%';
  const printing = job.items.find((i) => i.status === 'printing');
  $('jobText').textContent = printing ? `正在打印：${printing.name}（${finished}/${job.items.length}）` : `处理中…（${finished}/${job.items.length}）`;
}

function finishJob(job) {
  state.jobRunning = false;
  state.jobId = null;
  const ok = job.items.filter((i) => i.status === 'done').length;
  const fail = job.items.filter((i) => i.status === 'error').length;
  const cancelled = job.items.filter((i) => i.status === 'cancelled').length;
  $('jobProgressFill').style.width = '100%';
  $('jobText').textContent = cancelled ? `已取消（完成 ${ok}，失败 ${fail}）` : `完成 ✔ 成功 ${ok} · 失败 ${fail}`;
  setTimeout(() => $('jobBar').classList.add('hidden'), 6000);
  updatePrintBtn();
  renderFileList();
  if (fail > 0) toast(`${fail} 个文件打印失败，详见列表`, true);
  else if (!cancelled && ok > 0) toast(`已发送全部 ${ok} 个文件到打印机 🎉`);
}

async function cancelJob() {
  if (!state.jobId) return;
  await fetch('/api/jobs/' + state.jobId + '/cancel', { method: 'POST' }).catch(() => {});
}

// ---------------- 提示 ----------------
let toastTimer = null;
function toast(msg, isErr) {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3500);
}

// 预览高度：视口减去滚动到底时占位的界面元素（吸顶头部、预览标题行、页脚、卡片内边距等），
// 使滚到页面底部时预览正好铺满剩余屏幕
function fitPreviewHeight() {
  const frame = $('previewFrame');
  const card = $('previewCard');
  const header = document.querySelector('header');
  const footer = document.querySelector('footer');
  const title = card.querySelector('.card-title');
  const cs = getComputedStyle(card);
  const chrome =
    header.offsetHeight +
    title.offsetHeight +
    parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) +
    parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth) +
    parseFloat(cs.marginBottom) +
    footer.offsetHeight;
  frame.style.height = Math.max(480, Math.floor(window.innerHeight - chrome)) + 'px';
}

// ---------------- 事件绑定 ----------------
function updateScalePercentVisibility() {
  const mode = document.querySelector('input[name="scaleMode"]:checked').value;
  $('scalePercentWrap').classList.toggle('hidden', mode !== 'custom');
}

function bindEvents() {
  const dz = $('dropZone');
  const input = $('fileInput');
  dz.addEventListener('click', () => input.click());
  dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') input.click(); });
  input.addEventListener('change', () => { addFiles(input.files); input.value = ''; });

  ;['dragenter', 'dragover'].forEach((ev) =>
    dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('dragover'); }));
  ;['dragleave', 'drop'].forEach((ev) =>
    dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('dragover'); }));
  dz.addEventListener('drop', async (e) => {
    // entry 必须在事件处理的同步阶段取出（返回后 DataTransferItemList 即失效）
    const entries = [];
    const items = e.dataTransfer.items;
    if (items && items.length && items[0].webkitGetAsEntry) {
      for (const item of items) {
        const entry = item.webkitGetAsEntry();
        if (entry) entries.push(entry);
      }
    }
    const hasDir = entries.some((en) => en.isDirectory);
    if (hasDir) {
      const found = await BatchPrintTraverse.collectPdfFiles(entries);
      addFiles(found);
      if (found.length) toast(`已从文件夹中找到 ${found.length} 个 PDF，开始上传…`);
    } else {
      addFiles(e.dataTransfer.files);
    }
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  $('clearBtn').addEventListener('click', clearFiles);
  $('resetBtn').addEventListener('click', () => { applySettingsToDom(DEFAULT_SETTINGS); collectSettings(); schedulePreview(); });
  $('refreshPrinters').addEventListener('click', async () => {
    const data = await (await fetch('/api/printers/refresh', { method: 'POST' })).json();
    renderPrinters(data.printers || []);
  });
  $('setPrinter').addEventListener('change', () => { $('setPrinter').dataset.value = $('setPrinter').value; collectSettings(); });

  // 任何设置变化 → 保存 + 刷新预览
  document.querySelectorAll('#setPaper, #setHalign, #setValign, #setCopies, #setDuplex, #setColor, input[name="orientation"], input[name="scaleMode"]')
    .forEach((el) => el.addEventListener('change', () => { collectSettings(); schedulePreview(); }));
  document.querySelectorAll('#setScalePercent, #mTop, #mRight, #mBottom, #mLeft')
    .forEach((el) => el.addEventListener('input', () => { collectSettings(); schedulePreview(); }));
  document.querySelectorAll('input[name="scaleMode"]').forEach((el) => el.addEventListener('change', updateScalePercentVisibility));

  // 页边距四边联动
  const marginInputs = ['mTop', 'mRight', 'mBottom', 'mLeft'].map($);
  marginInputs.forEach((inp) => inp.addEventListener('input', () => {
    if (!$('marginLock').classList.contains('locked')) return;
    marginInputs.forEach((other) => { if (other !== inp) other.value = inp.value; });
  }));
  $('marginLock').addEventListener('click', () => {
    const btn = $('marginLock');
    const locked = !btn.classList.contains('locked');
    btn.classList.toggle('locked', locked);
    btn.textContent = locked ? '🔗' : '🔓';
    btn.title = '四边联动：' + (locked ? '开' : '关');
    if (locked) { const v = $('mTop').value; marginInputs.forEach((i) => { i.value = v; }); collectSettings(); schedulePreview(); }
  });

  $('previewBtn').addEventListener('click', refreshPreview);
  $('printBtn').addEventListener('click', startPrint);
  $('cancelBtn').addEventListener('click', cancelJob);

  window.addEventListener('beforeunload', () => { if (state.previewUrl) URL.revokeObjectURL(state.previewUrl); });
  window.addEventListener('resize', fitPreviewHeight);
  fitPreviewHeight();
}

// ---------------- 初始化 ----------------
applySettingsToDom(loadSettings());
bindEvents();
renderFileList();
loadConfig();
