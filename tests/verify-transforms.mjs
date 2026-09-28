// 验证 /api/preview 的排版变换：上传样本 → 请求各种设置 → 断言页面尺寸 + 渲染 PNG 目测
import fs from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { pdf } from 'pdf-to-img';
import { contentBBox } from './measure-png.mjs';

const fontDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', 'pdfjs-dist', 'standard_fonts');
const standardFontDataUrl = pathToFileURL(fontDir).href + '/';

const BASE = 'http://localhost:8163';
const MM = 72 / 25.4;
let failed = 0;

async function upload(name, path) {
  const body = await fs.readFile(path);
  const res = await fetch(`${BASE}/api/upload?name=${encodeURIComponent(name)}`, { method: 'POST', body });
  const data = await res.json();
  if (!res.ok) throw new Error(`上传失败 ${name}: ${data.error}`);
  console.log(`上传 ${name}: id=${data.id} pages=${data.pages} size=${data.size}`);
  return data;
}

async function preview(fileId, settings) {
  const res = await fetch(`${BASE}/api/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileId, settings }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(`预览失败: ${data.error || res.status}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

function approx(a, b, tol = 1) {
  return Math.abs(a - b) <= tol;
}

function check(name, cond, detail) {
  if (cond) console.log(`  ✔ ${name} ${detail || ''}`);
  else { console.error(`  ✘ ${name} ${detail || ''}`); failed++; }
}

async function pageSize(buf, pageIdx = 0) {
  const doc = await PDFDocument.load(buf);
  const p = doc.getPages()[pageIdx];
  return { w: p.getWidth(), h: p.getHeight(), count: doc.getPageCount() };
}

async function renderPng(buf, outPath) {
  const doc = await pdf(buf, { scale: 1.2, docInitParams: { standardFontDataUrl } });
  await fs.writeFile(outPath, await doc.getPage(1));
}

async function main() {
  await fs.mkdir('tests/out', { recursive: true });
  const portrait = await upload('portrait.pdf', 'tests/samples/portrait.pdf');
  const landscape = await upload('landscape.pdf', 'tests/samples/landscape.pdf');
  const rotated = await upload('rotated.pdf', 'tests/samples/rotated.pdf');
  const a5 = await upload('a5.pdf', 'tests/samples/a5.pdf');

  const A4w = 210 * MM; const A4h = 297 * MM;

  // 用例 1：A4 纵向样本 → A4 自动方向、适应页面、无边距
  {
    console.log('\n[1] portrait → A4 auto fit margin0');
    const buf = await preview(portrait.id, { paper: 'A4', orientation: 'auto', scaleMode: 'fit', margin: {} });
    const s = await pageSize(buf);
    check('页数=3', s.count === 3, `got ${s.count}`);
    check('页面尺寸=A4竖', approx(s.w, A4w) && approx(s.h, A4h), `${s.w.toFixed(1)}x${s.h.toFixed(1)}`);
    await renderPng(buf, 'tests/out/1-portrait-a4-auto.png');
  }

  // 用例 2：强制横向 —— 纸张横放，内容保持正向（缩小居中，不旋转）
  {
    console.log('\n[2] portrait → A4 landscape 强制横向（内容应正向）');
    const buf = await preview(portrait.id, { paper: 'A4', orientation: 'landscape', scaleMode: 'fit', margin: {} });
    const s = await pageSize(buf);
    check('页面尺寸=A4横', approx(s.w, A4h) && approx(s.h, A4w), `${s.w.toFixed(1)}x${s.h.toFixed(1)}`);
    await renderPng(buf, 'tests/out/2-portrait-force-landscape.png');
    const b = contentBBox('tests/out/2-portrait-force-landscape.png');
    // 纵向内容按 min(841.89/595.28, 595.28/841.89)=0.707 缩放：边框内容约 471x680px（竖长）
    check('内容保持正向（竖长不旋转）', b.contentW < b.contentH, `${b.contentW}x${b.contentH}`);
    check('内容宽约 46.6%', approx(b.contentW / b.width, 0.466, 0.03), `${(100 * b.contentW / b.width).toFixed(1)}%`);
    check('内容高接近满页', approx(b.contentH / b.height, 0.953, 0.03), `${(100 * b.contentH / b.height).toFixed(1)}%`);
    check('水平居中', Math.abs(b.left - b.right) <= 6, `左${b.left}/右${b.right}`);
  }

  // 用例 3：A5 样本 → A4 竖，不对称页边距 上20/右15/下10/左15，适应页面，居中
  // 对齐基准为页边距框：留白应反映边距不对称（上 > 下 > 左 = 右）
  {
    console.log('\n[3] a5 → A4 portrait fit margins(t20,r15,b10,l15)');
    const buf = await preview(a5.id, {
      paper: 'A4', orientation: 'portrait', scaleMode: 'fit',
      margin: { top: 20, right: 15, bottom: 10, left: 15 },
    });
    const s = await pageSize(buf);
    check('页面尺寸=A4竖', approx(s.w, A4w) && approx(s.h, A4h), `${s.w.toFixed(1)}x${s.h.toFixed(1)}`);
    await renderPng(buf, 'tests/out/3-a5-margins.png');
    const b = contentBBox('tests/out/3-a5-margins.png');
    // 理论值：边框留白 左/右 66.8pt(11.2%) 上 97.5pt(11.6%) 下 69.1pt(8.2%)
    check('左右留白对称', Math.abs(b.left - b.right) <= 6, `左${b.left}/右${b.right}`);
    check('上留白 > 下留白（不对称边距生效）', b.top > b.bottom + 15, `上${b.top}/下${b.bottom}`);
    check('上留白≈11.6%', approx(100 * b.top / b.height, 11.6, 1.2), `${(100 * b.top / b.height).toFixed(1)}%`);
    check('下留白≈8.2%', approx(100 * b.bottom / b.height, 8.2, 1.2), `${(100 * b.bottom / b.height).toFixed(1)}%`);
    check('左右留白≈11.2%', approx(100 * b.left / b.width, 11.2, 1.2), `${(100 * b.left / b.width).toFixed(1)}%`);
  }

  // 用例 4：自定义缩放 50% 居中
  {
    console.log('\n[4] portrait → A4 auto custom 50%');
    const buf = await preview(portrait.id, { paper: 'A4', orientation: 'auto', scaleMode: 'custom', scalePercent: 50, margin: {} });
    const s = await pageSize(buf);
    check('页面尺寸=A4竖', approx(s.w, A4w) && approx(s.h, A4h), `${s.w.toFixed(1)}x${s.h.toFixed(1)}`);
    await renderPng(buf, 'tests/out/4-custom50.png');
  }

  // 用例 5：/Rotate 90 的页面 → 自动方向应为横向且内容方向正确
  {
    console.log('\n[5] rotated(/Rotate 90) → A4 auto');
    const buf = await preview(rotated.id, { paper: 'A4', orientation: 'auto', scaleMode: 'fit', margin: {} });
    const s = await pageSize(buf);
    check('页面尺寸=A4横（视觉横向）', approx(s.w, A4h) && approx(s.h, A4w), `${s.w.toFixed(1)}x${s.h.toFixed(1)}`);
    await renderPng(buf, 'tests/out/5-rotated-auto.png');
  }

  // 用例 6：横向样本 → 强制纵向 —— 纸张竖放，内容保持正向（缩小居中，不旋转）
  {
    console.log('\n[6] landscape → A4 portrait 强制纵向（内容应正向）');
    const buf = await preview(landscape.id, { paper: 'A4', orientation: 'portrait', scaleMode: 'fit', margin: {} });
    const s = await pageSize(buf);
    check('页面尺寸=A4竖', approx(s.w, A4w) && approx(s.h, A4h), `${s.w.toFixed(1)}x${s.h.toFixed(1)}`);
    await renderPng(buf, 'tests/out/6-landscape-force-portrait.png');
    const b = contentBBox('tests/out/6-landscape-force-portrait.png');
    // 横向内容按 0.707 缩放：边框内容约 680x471px（横宽）
    check('内容保持正向（横宽不旋转）', b.contentW > b.contentH, `${b.contentW}x${b.contentH}`);
    check('内容高约 46.6%', approx(b.contentH / b.height, 0.466, 0.03), `${(100 * b.contentH / b.height).toFixed(1)}%`);
    check('内容宽接近满页', approx(b.contentW / b.width, 0.953, 0.03), `${(100 * b.contentW / b.width).toFixed(1)}%`);
    check('垂直居中', Math.abs(b.top - b.bottom) <= 6, `上${b.top}/下${b.bottom}`);
  }

  // 用例 7：Letter 纸张
  {
    console.log('\n[7] portrait → Letter auto');
    const buf = await preview(portrait.id, { paper: 'Letter', orientation: 'auto', scaleMode: 'fit', margin: {} });
    const s = await pageSize(buf);
    check('页面尺寸=Letter竖', approx(s.w, 215.9 * MM) && approx(s.h, 279.4 * MM), `${s.w.toFixed(1)}x${s.h.toFixed(1)}`);
  }

  console.log(failed ? `\n❌ ${failed} 项断言失败` : '\n✅ 全部尺寸断言通过（PNG 已输出到 tests/out/ 供目测）');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
