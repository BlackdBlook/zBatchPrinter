/**
 * BatchPrint — 本地 PDF 批量打印服务
 *
 * 零 Web 框架实现：
 *   - 静态页面服务（public/）
 *   - PDF 上传与文件列表管理
 *   - 打印机枚举（PowerShell CIM）
 *   - PDF 排版变换（pdf-lib）：纸张 / 方向 / 页边距 / 缩放 / 对齐
 *   - 静默打印（SumatraPDF 便携版，缺失时自动下载到 tools/）
 */
'use strict';

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { exec, spawn } = require('child_process');
const { PDFDocument, degrees } = require('pdf-lib');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const TEMP_DIR = path.join(ROOT, 'temp');
const UPLOAD_DIR = path.join(TEMP_DIR, 'uploads');
const OUT_DIR = path.join(TEMP_DIR, 'out');
const TOOLS_DIR = path.join(ROOT, 'tools');
const SUMATRA_DIR = path.join(TOOLS_DIR, 'SumatraPDF');
const SUMATRA_URL = 'https://sumatrapdfreader.org/dl/rel/3.6.1/SumatraPDF-3.6.1-64.zip';
const SUMATRA_ZIP = path.join(TOOLS_DIR, 'SumatraPDF-3.6.1-64.zip');
const PORT_PREFERRED = 8163;

const MM = 72 / 25.4; // 1mm = 72/25.4 pt
const MAX_UPLOAD = 500 * 1024 * 1024;
const MAX_JSON = 256 * 1024;

// 纸张尺寸（mm，竖放）
const PAPERS = {
  A3: [297, 420],
  A4: [210, 297],
  A5: [148, 210],
  B5: [176, 250],
  Letter: [215.9, 279.4],
  Legal: [215.9, 355.6],
};

// ---------------- 运行状态 ----------------
const files = new Map(); // id -> { id, name, path, size, pages, addedAt }
const jobs = new Map(); // id -> job
const transformCache = new Map(); // key -> { file, at }
let printChain = Promise.resolve(); // 顺序执行打印任务
let printerCache = { at: 0, data: null };
let engine = { status: 'pending', progress: 0, error: null, path: null, versionParts: null };

const log = (...a) => console.log(`[${new Date().toLocaleTimeString()}]`, ...a);

// ---------------- 通用工具 ----------------
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_JSON) return reject(new Error('请求体过大'));
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('JSON 解析失败'));
      }
    });
    req.on('error', reject);
  });
}

function sanitizeName(raw) {
  // 名称仅用于列表展示（实际存储用随机 id.pdf），保留 / 以显示拖入目录的相对路径
  let n = String(raw || '')
    .replace(/[\\:*?"<>|]/g, '_')
    .replace(/\.\.+/g, '.')
    .trim();
  if (n.length > 160) n = n.slice(-160);
  return n || 'file.pdf';
}

function streamToFile(req, dest, limit) {
  return new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(dest);
    let size = 0;
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      req.destroy();
      ws.destroy();
      fs.unlink(dest, () => {});
      reject(err);
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) return fail(Object.assign(new Error('文件超出大小限制'), { statusCode: 413 }));
      if (!ws.write(chunk)) req.pause();
    });
    ws.on('drain', () => req.resume());
    req.on('end', () => ws.end(() => { if (!settled) { settled = true; resolve(); } }));
    req.on('error', fail);
    ws.on('error', fail);
  });
}

// ---------------- 打印引擎（SumatraPDF） ----------------
function findExtractedExe(dir) {
  // 便携版 zip 解压后可能在根目录或子目录，递归找 SumatraPDF.exe
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isFile() && /^SumatraPDF(-.*)?\.exe$/i.test(e.name)) return p;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        const found = findExtractedExe(path.join(dir, e.name));
        if (found) return found;
      }
    }
  } catch { /* ignore */ }
  return null;
}

function findSystemSumatra() {
  return new Promise((resolve) => {
    exec('where SumatraPDF', { windowsHide: true }, (err, stdout) => {
      if (!err && stdout.trim()) {
        const first = stdout.trim().split(/\r?\n/)[0];
        if (fs.existsSync(first)) return resolve(first);
      }
      const candidates = [
        process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'SumatraPDF', 'SumatraPDF.exe'),
        'C:\\Program Files\\SumatraPDF\\SumatraPDF.exe',
        'C:\\Program Files (x86)\\SumatraPDF\\SumatraPDF.exe',
      ].filter(Boolean);
      for (const c of candidates) if (fs.existsSync(c)) return resolve(c);
      resolve(null);
    });
  });
}

function engineVersionAtLeast(major, minor) {
  const [ma, mi] = engine.versionParts || [0, 0];
  return ma > major || (ma === major && mi >= minor);
}

function getExeVersion(exePath) {
  return new Promise((resolve) => {
    const cmd = `[Console]::OutputEncoding=[Text.Encoding]::UTF8; (Get-Item -LiteralPath '${exePath.replace(/'/g, "''")}').VersionInfo.FileVersion`;
    exec(`powershell -NoProfile -Command "${cmd.replace(/"/g, '`"')}"`, { windowsHide: true, encoding: 'utf8' }, (err, out) => {
      const m = (out || '').trim().match(/(\d+)\.(\d+)/);
      resolve(err || !m ? null : [Number(m[1]), Number(m[2])]);
    });
  });
}

async function markEngineReady(exePath) {
  engine = { status: 'ready', progress: 100, error: null, path: exePath, versionParts: await getExeVersion(exePath) };
  log('打印引擎就绪：', exePath, engine.versionParts ? `v${engine.versionParts.join('.')}` : '(版本未知)');
}

async function ensureEngine() {
  // 1) 项目内便携版（tools/SumatraPDF/SumatraPDF.exe），也允许用户手动放入
  const local = fs.existsSync(SUMATRA_DIR) ? findExtractedExe(SUMATRA_DIR) : null;
  if (local) return markEngineReady(local);
  // 2) 系统已安装的 SumatraPDF
  const sys = await findSystemSumatra();
  if (sys) return markEngineReady(sys);
  // 3) 自动下载便携版
  downloadEngine();
}

function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'BatchPrint/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(downloadFile(res.headers.location, dest, onProgress));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`下载失败 HTTP ${res.statusCode}`));
      }
      const total = Number(res.headers['content-length']) || 0;
      let done = 0;
      const ws = fs.createWriteStream(dest);
      res.on('data', (c) => {
        done += c.length;
        ws.write(c);
        if (total) onProgress(done / total);
      });
      res.on('end', () => ws.end(() => resolve()));
      res.on('error', reject);
      ws.on('error', reject);
    });
    req.on('error', reject);
  });
}

async function downloadEngine() {
  engine = { status: 'downloading', progress: 0, error: null, path: null };
  log('正在下载打印引擎（SumatraPDF 便携版）…');
  try {
    fs.mkdirSync(TOOLS_DIR, { recursive: true });
    await downloadFile(SUMATRA_URL, SUMATRA_ZIP, (p) => { engine.progress = Math.round(p * 100); });
    log('下载完成，正在解压…');
    await new Promise((resolve, reject) => {
      const cmd = `[Console]::OutputEncoding=[Text.Encoding]::UTF8; Expand-Archive -LiteralPath '${SUMATRA_ZIP.replace(/'/g, "''")}' -DestinationPath '${SUMATRA_DIR.replace(/'/g, "''")}' -Force`;
      exec(`powershell -NoProfile -Command "${cmd.replace(/"/g, '`"')}"`, { windowsHide: true }, (err) => (err ? reject(err) : resolve()));
    });
    fs.unlink(SUMATRA_ZIP, () => {});
    const exe = findExtractedExe(SUMATRA_DIR);
    if (!exe) throw new Error('解压后未找到 SumatraPDF.exe');
    engine = { status: 'ready', progress: 100, error: null, path: exe, versionParts: await getExeVersion(exe) };
    log('打印引擎就绪：', exe);
  } catch (err) {
    engine = { status: 'error', progress: 0, error: err.message, path: null };
    log('打印引擎下载失败：', err.message);
  }
}

// ---------------- 打印机枚举 ----------------
async function getPrinters(force) {
  if (!force && printerCache.data && Date.now() - printerCache.at < 30000) return printerCache.data;
  const txt = await new Promise((resolve) => {
    const cmd = `[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-CimInstance Win32_Printer | Select-Object Name,Default,WorkOffline | ConvertTo-Json -Compress`;
    exec(`powershell -NoProfile -Command "${cmd.replace(/"/g, '`"')}"`, { windowsHide: true, encoding: 'utf8' }, (err, out) => resolve(err ? null : out));
  });
  let list = [];
  try {
    let parsed = JSON.parse((txt || '').trim() || 'null');
    if (parsed && !Array.isArray(parsed)) parsed = [parsed];
    list = (parsed || [])
      .filter((p) => p && p.Name)
      .map((p) => ({ name: String(p.Name), default: !!p.Default, offline: !!p.WorkOffline }));
  } catch { /* ignore */ }
  printerCache = { at: Date.now(), data: list };
  return list;
}

// ---------------- PDF 排版变换 ----------------
function normalizeSettings(raw) {
  const s = raw || {};
  const num = (v, def, min, max) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
  };
  const m = s.margin || {};
  return {
    printer: typeof s.printer === 'string' ? s.printer : '',
    paper: PAPERS[s.paper] ? s.paper : 'A4',
    orientation: ['auto', 'portrait', 'landscape'].includes(s.orientation) ? s.orientation : 'auto',
    scaleMode: ['fit', 'actual', 'custom'].includes(s.scaleMode) ? s.scaleMode : 'fit',
    scalePercent: num(s.scalePercent, 100, 1, 1000),
    margin: {
      top: num(m.top, 0, 0, 100),
      right: num(m.right, 0, 0, 100),
      bottom: num(m.bottom, 0, 0, 100),
      left: num(m.left, 0, 0, 100),
    },
    halign: ['left', 'center', 'right'].includes(s.halign) ? s.halign : 'center',
    valign: ['top', 'middle', 'bottom'].includes(s.valign) ? s.valign : 'middle',
    copies: Math.round(num(s.copies, 1, 1, 50)),
    duplex: ['default', 'simplex', 'duplexlong', 'duplexshort'].includes(s.duplex) ? s.duplex : 'default',
    color: ['default', 'color', 'monochrome'].includes(s.color) ? s.color : 'default',
  };
}

/**
 * 计算页面"查看器实际显示"的区域：CropBox ∩ MediaBox（无 CropBox 时为 MediaBox）。
 * pdf-lib 默认嵌入整块 MediaBox 画布（且假定原点为 0,0），会把查看器裁剪掉的
 * 隐藏内容（如发票模板在裁剪区外的残留：日期、URL 页眉等）带进预览和打印。
 */
function pageVisibleBox(p) {
  const mb = p.getMediaBox();
  let left = mb.x;
  let bottom = mb.y;
  let right = mb.x + mb.width;
  let top = mb.y + mb.height;
  try {
    const cb = p.getCropBox();
    if (cb && cb.width > 0 && cb.height > 0) {
      left = Math.max(left, cb.x);
      bottom = Math.max(bottom, cb.y);
      right = Math.min(right, cb.x + cb.width);
      top = Math.min(top, cb.y + cb.height);
    }
  } catch { /* 页面无 CropBox，直接用 MediaBox */ }
  if (!(right > left && top > bottom)) {
    left = mb.x; bottom = mb.y; right = mb.x + mb.width; top = mb.y + mb.height;
  }
  return { left, bottom, right, top };
}

/**
 * 按设置把源 PDF 重新排版为「精确等于目标纸张尺寸」的新 PDF。
 * 每页：选择纸张方向 → 计算可用区域（纸张减页边距）→ 按缩放模式缩放 → 按对齐方式放置。
 */
async function transformPdf(srcPath, settings) {
  const bytes = await fsp.readFile(srcPath);
  let src;
  try {
    src = await PDFDocument.load(bytes, { ignoreEncryption: true });
  } catch (err) {
    throw new Error('无法解析 PDF（可能已加密或损坏）');
  }
  if (src.isEncrypted) throw new Error('该 PDF 已加密，无法处理');
  const srcPages = src.getPages();
  if (!srcPages.length) throw new Error('PDF 没有页面');

  const out = await PDFDocument.create();
  const embedded = await out.embedPages(srcPages, srcPages.map(pageVisibleBox));

  const [paperW, paperH] = PAPERS[settings.paper];
  const ml = settings.margin.left * MM;
  const mr = settings.margin.right * MM;
  const mt = settings.margin.top * MM;
  const mb = settings.margin.bottom * MM;

  for (let i = 0; i < embedded.length; i++) {
    const emb = embedded[i];
    const bw = emb.width; // 未旋转的内容盒尺寸
    const bh = emb.height;
    // 页面自带的 /Rotate 旋转
    const pageRot = ((Math.round(srcPages[i].getRotation().angle) % 360) + 360) % 360;
    const visW = pageRot % 180 === 0 ? bw : bh; // 视觉尺寸
    const visH = pageRot % 180 === 0 ? bh : bw;

    // 目标方向：只决定输出纸张的横竖，内容保持正向不旋转
    // （若把内容转 90° 铺满横纸，物理输出与纵向打印完全相同，没有意义）
    let targetLandscape;
    if (settings.orientation === 'portrait') targetLandscape = false;
    else if (settings.orientation === 'landscape') targetLandscape = true;
    else targetLandscape = visW > visH;

    // 仅应用页面自带的 /Rotate，使内容方向与查看器中显示一致
    const rot = pageRot;

    const pageW = targetLandscape ? paperH * MM : paperW * MM;
    const pageH = targetLandscape ? paperW * MM : paperH * MM;

    // 旋转后内容占位尺寸（未缩放）
    const occW0 = rot % 180 === 0 ? bw : bh;
    const occH0 = rot % 180 === 0 ? bh : bw;

    // 缩放
    const availW = pageW - ml - mr;
    const availH = pageH - mt - mb;
    let s;
    if (settings.scaleMode === 'fit') s = Math.min(availW / occW0, availH / occH0);
    else if (settings.scaleMode === 'actual') s = 1;
    else s = settings.scalePercent / 100;
    if (!(s > 0)) s = 1;

    const occW = occW0 * s;
    const occH = occH0 * s;

    // 对齐基准是"页边距框"（纸张减去四边页边距），保证页边距对任何对齐方式都生效
    let tx;
    if (settings.halign === 'left') tx = ml;
    else if (settings.halign === 'right') tx = pageW - mr - occW;
    else tx = ml + (availW - occW) / 2;
    let ty;
    if (settings.valign === 'bottom') ty = mb;
    else if (settings.valign === 'top') ty = pageH - mt - occH;
    else ty = mb + (availH - occH) / 2;

    // pdf-lib 以 (x,y) 为锚点先平移后旋转，据此换算锚点
    const sw = bw * s;
    const sh = bh * s;
    let ax;
    let ay;
    if (rot === 0) { ax = tx; ay = ty; }
    else if (rot === 90) { ax = tx + sh; ay = ty; }
    else if (rot === 180) { ax = tx + sw; ay = ty + sh; }
    else { ax = tx; ay = ty + sw; }

    const page = out.addPage([pageW, pageH]);
    page.drawPage(emb, { x: ax, y: ay, xScale: s, yScale: s, rotate: degrees(rot) });
  }
  return Buffer.from(await out.save());
}

async function transformCached(fileMeta, settings) {
  const key = crypto.createHash('sha1').update(`${fileMeta.id}|${JSON.stringify(settings)}`).digest('hex');
  const cached = transformCache.get(key);
  if (cached) {
    cached.at = Date.now();
    try {
      return await fsp.readFile(cached.file);
    } catch { /* 缓存失效，重新生成 */ }
  }
  const buf = await transformPdf(fileMeta.path, settings);
  const outFile = path.join(OUT_DIR, `t_${key}.pdf`);
  await fsp.writeFile(outFile, buf);
  transformCache.set(key, { file: outFile, at: Date.now() });
  // 简单上限：最多保留 30 个缓存文件
  if (transformCache.size > 30) {
    const oldest = [...transformCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    transformCache.delete(oldest[0]);
    fs.unlink(oldest[1].file, () => {});
  }
  return buf;
}

// ---------------- 打印任务 ----------------
async function printFile(pdfPath, settings, job) {
  if (process.env.BATCHPRINT_DRY) {
    log('[DRY] 打印命令：', JSON.stringify([engine.path, '-print-to', settings.printer || '(默认打印机)', '-print-settings', buildPrintSettings(settings), pdfPath]));
    await new Promise((r) => setTimeout(r, 150));
    return;
  }
  const args = [
    '-app-name', 'BatchPrint',
    settings.printer ? '-print-to' : '-print-to-default',
    ...(settings.printer ? [settings.printer] : []),
    '-print-settings', buildPrintSettings(settings),
    '-silent',
    '-exit-when-done',
    pdfPath,
  ];
  // 说明：打印队列中的任务名 = 该文件的绝对路径（SumatraPDF 固定行为），
  // 因此用原文件名命名临时文件，队列里即可看到并搜索到原文件名
  const child = spawn(engine.path, args, { windowsHide: true });
  if (job) job.currentChild = child;
  const code = await new Promise((resolve) => {
    child.on('error', () => resolve(-1));
    child.on('close', (c) => resolve(c));
  });
  if (job && job.cancelled) { const e = new Error('已取消'); e.cancelled = true; throw e; }
  if (code === -1) throw new Error('无法启动打印引擎（SumatraPDF）');
  // 退出码语义随版本改变：≤3.6 的 2 = 打印成功（实测 3.6.1）；
  // ≥3.7 改为 0=成功、2=无法打开文件（官方文档现行表）
  const success = code === 0 || (!engineVersionAtLeast(3, 7) && code === 2);
  const msgs = engineVersionAtLeast(3, 7)
    ? { 2: '无法打开文件（不存在或格式不支持）', 3: '文档不允许打印', 4: '打印机不存在', 5: '打印驱动失败', 6: '打印被策略禁用' }
    : { 3: '打印机名称无效，请重新选择打印机', 4: '打印机不存在或未指定', 5: '打印驱动失败', 6: '未能静默打印' };
  if (!success) throw new Error(`打印失败（SumatraPDF 退出码 ${code}${msgs[code] ? '：' + msgs[code] : ''}）`);
}

function buildPrintSettings(settings) {
  // 页面尺寸已被 transformPdf 精确设置为纸张尺寸，因此 noscale + paper=auto
  const ps = ['noscale', 'paper=auto', 'ignore-pdf-print-settings'];
  if (settings.copies > 1) ps.push(`${settings.copies}x`);
  if (settings.duplex !== 'default') ps.push(settings.duplex);
  if (settings.color !== 'default') ps.push(settings.color);
  return ps.join(',');
}

function createJob(fileMetas, settings) {
  const id = crypto.randomBytes(6).toString('hex');
  const job = {
    id,
    createdAt: Date.now(),
    status: 'running',
    cancelled: false,
    currentChild: null,
    items: fileMetas.map((f) => ({ id: f.id, name: f.name, status: 'queued', error: null })),
  };
  jobs.set(id, job);
  // 最多保留 20 个历史任务
  if (jobs.size > 20) {
    for (const [jid, j] of [...jobs.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)) {
      if (jobs.size <= 20) break;
      if (j.status === 'running') continue;
      jobs.delete(jid);
    }
  }
  printChain = printChain.then(() => runJob(job, fileMetas, settings)).catch((err) => log('任务异常：', err));
  return job;
}

async function runJob(job, fileMetas, settings) {
  for (let i = 0; i < fileMetas.length; i++) {
    const meta = job.items[i];
    if (job.cancelled) { meta.status = 'cancelled'; continue; }
    try {
      meta.status = 'transforming';
      const buf = await transformCached(fileMetas[i], settings);
      if (job.cancelled) { meta.status = 'cancelled'; continue; }
      // 用原文件名命名发送给打印引擎的文件 → 打印队列里显示原名而不是 job-xxxx
      const base = (fileMetas[i].name || 'document')
        .replace(/\.pdf$/i, '')
        .replace(/[\\/:*?"<>|]/g, '_')
        .trim()
        .slice(0, 100) || 'document';
      let printName = base;
      let n = 2;
      while (fs.existsSync(path.join(OUT_DIR, `${printName}.pdf`))) printName = `${base}(${n++})`;
      const outPath = path.join(OUT_DIR, `${printName}.pdf`);
      await fsp.writeFile(outPath, buf);
      meta.status = 'printing';
      await printFile(outPath, settings, job);
      meta.status = 'done';
      fs.unlink(outPath, () => {});
    } catch (err) {
      meta.status = err.cancelled ? 'cancelled' : 'error';
      meta.error = err.message || String(err);
    }
  }
  job.status = job.cancelled ? 'cancelled' : 'done';
  job.currentChild = null;
  job.finishedAt = Date.now();
}

function cancelJob(job) {
  job.cancelled = true;
  if (job.currentChild) {
    try { job.currentChild.kill(); } catch { /* ignore */ }
  }
}

// ---------------- HTTP ----------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function serveStatic(req, res, u) {
  let p = decodeURIComponent(u.pathname);
  if (p === '/') p = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, p));
  if (!filePath.startsWith(PUBLIC_DIR)) return json(res, 403, { error: '禁止访问' });
  fs.readFile(filePath, (err, data) => {
    if (err) return json(res, 404, { error: '未找到 ' + p });
    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

async function handleApi(req, res, u) {
  const { pathname } = u;
  const method = req.method;

  // 引擎/打印机/配置
  if (method === 'GET' && pathname === '/api/config') {
    const printers = await getPrinters();
    return json(res, 200, {
      papers: Object.keys(PAPERS),
      printers,
      engine: { status: engine.status, progress: engine.progress, error: engine.error },
    });
  }
  if (method === 'POST' && pathname === '/api/printers/refresh') {
    const printers = await getPrinters(true);
    return json(res, 200, { printers });
  }

  // 文件上传（原始字节流，文件名放 query）
  if (method === 'POST' && pathname === '/api/upload') {
    const name = sanitizeName(decodeURIComponent(u.searchParams.get('name') || 'file.pdf'));
    const id = crypto.randomBytes(8).toString('hex');
    const dest = path.join(UPLOAD_DIR, `${id}.pdf`);
    try {
      await streamToFile(req, dest, MAX_UPLOAD);
    } catch (err) {
      return json(res, err.statusCode || 500, { error: err.message });
    }
    let pages = 0;
    try {
      const doc = await PDFDocument.load(await fsp.readFile(dest), { ignoreEncryption: true });
      if (doc.isEncrypted) throw new Error('该 PDF 已加密');
      pages = doc.getPageCount();
    } catch (err) {
      await fsp.unlink(dest).catch(() => {});
      return json(res, 400, { error: '无法解析 PDF：' + (err.message || err) });
    }
    const meta = { id, name, path: dest, size: fs.statSync(dest).size, pages, addedAt: Date.now() };
    files.set(id, meta);
    return json(res, 200, meta);
  }

  if (method === 'GET' && pathname === '/api/files') {
    return json(res, 200, { files: [...files.values()] });
  }
  const fileMatch = pathname.match(/^\/api\/files\/([^/]+)$/);
  if (fileMatch) {
    const f = files.get(fileMatch[1]);
    if (!f) return json(res, 404, { error: '文件不存在' });
    if (method === 'DELETE') {
      files.delete(f.id);
      await fsp.unlink(f.path).catch(() => {});
      return json(res, 200, { ok: true });
    }
    return json(res, 405, { error: '不支持的方法' });
  }
  if (method === 'POST' && pathname === '/api/files/clear') {
    for (const f of files.values()) await fsp.unlink(f.path).catch(() => {});
    files.clear();
    return json(res, 200, { ok: true });
  }

  // 预览：按当前设置变换后返回 PDF
  if (method === 'POST' && pathname === '/api/preview') {
    const body = await readJson(req);
    const f = files.get(body.fileId);
    if (!f) return json(res, 404, { error: '文件不存在' });
    const buf = await transformCached(f, normalizeSettings(body.settings));
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Length': buf.length,
      'Cache-Control': 'no-store',
    });
    return res.end(buf);
  }

  // 批量打印
  if (method === 'POST' && pathname === '/api/print') {
    const body = await readJson(req);
    const settings = normalizeSettings(body.settings);
    const ids = Array.isArray(body.fileIds) ? body.fileIds.filter((id) => files.has(id)) : [];
    if (!ids.length) return json(res, 400, { error: '没有可打印的文件' });
    if (engine.status !== 'ready') return json(res, 409, { error: '打印引擎未就绪（' + engine.status + '）' });
    const job = createJob(ids.map((id) => files.get(id)), settings);
    return json(res, 200, { jobId: job.id });
  }

  const jobMatch = pathname.match(/^\/api\/jobs\/([^/]+)$/);
  if (jobMatch && method === 'GET') {
    const job = jobs.get(jobMatch[1]);
    if (!job) return json(res, 404, { error: '任务不存在' });
    return json(res, 200, job);
  }
  const cancelMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/cancel$/);
  if (cancelMatch && method === 'POST') {
    const job = jobs.get(cancelMatch[1]);
    if (!job) return json(res, 404, { error: '任务不存在' });
    cancelJob(job);
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { error: '未知接口 ' + method + ' ' + pathname });
}

// ---------------- 启动 ----------------
async function cleanDir(dir) {
  try {
    const entries = await fsp.readdir(dir);
    for (const e of entries) await fsp.unlink(path.join(dir, e)).catch(() => {});
  } catch { /* ignore */ }
}

function listenWithFallback(server, preferred) {
  return new Promise((resolve, reject) => {
    const tryPort = (port, attemptsLeft) => {
      const onError = (err) => {
        if (err.code === 'EADDRINUSE' && attemptsLeft > 0) tryPort(port + 1, attemptsLeft - 1);
        else reject(err);
      };
      server.once('error', onError);
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', onError);
        resolve(port);
      });
    };
    tryPort(preferred, 9);
  });
}

async function main() {
  await fsp.mkdir(UPLOAD_DIR, { recursive: true });
  await fsp.mkdir(OUT_DIR, { recursive: true });
  await cleanDir(UPLOAD_DIR); // 每次启动清理上次会话的临时文件
  await cleanDir(OUT_DIR);
  transformCache.clear();

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://localhost');
    try {
      if (u.pathname.startsWith('/api/')) await handleApi(req, res, u);
      else serveStatic(req, res, u);
    } catch (err) {
      try { json(res, 500, { error: err.message || String(err) }); } catch { /* 已响应 */ }
    }
  });

  const port = await listenWithFallback(server, PORT_PREFERRED);
  const url = `http://localhost:${port}`;
  log(`PDF 批量打印服务已启动：${url}`);
  log('关闭此窗口或按 Ctrl+C 即可停止服务。');

  ensureEngine().catch((err) => log('引擎初始化异常：', err));

  if (!process.env.BATCHPRINT_NO_OPEN) {
    exec(`start "" "${url}"`, { windowsHide: true });
  }
}

main().catch((err) => {
  console.error('服务启动失败：', err);
  process.exit(1);
});
