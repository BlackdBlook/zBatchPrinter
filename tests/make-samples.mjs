// 生成用于验证排版变换的测试 PDF
import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib';
import fs from 'node:fs/promises';

const MM = 72 / 25.4;
const A4 = [210 * MM, 297 * MM];
const A5 = [148 * MM, 210 * MM];

async function drawContent(page, label) {
  const doc = page.doc;
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const { width: w, height: h } = page.getSize();
  const blue = rgb(0.15, 0.35, 0.85);
  // 内缩 20pt 的边框：用于目测页边距/缩放
  page.drawRectangle({ x: 20, y: 20, width: w - 40, height: h - 40, borderColor: blue, borderWidth: 2 });
  // 中十字线：用于判断方向
  page.drawLine({ start: { x: 20, y: h / 2 }, end: { x: w - 20, y: h / 2 }, thickness: 1, color: blue });
  page.drawLine({ start: { x: w / 2, y: 20 }, end: { x: w / 2, y: h - 20 }, thickness: 1, color: blue });
  // 左上角实心方块：用于判断内容是否被旋转/翻转
  page.drawRectangle({ x: 30, y: h - 140, width: 50, height: 50, color: rgb(0.85, 0.25, 0.2) });
  page.drawText(label, { x: 40, y: h - 80, size: 44, font, color: rgb(0.1, 0.1, 0.12) });
  page.drawText(`page box: ${Math.round(w)} x ${Math.round(h)} pt`, { x: 40, y: 44, size: 14, font, color: rgb(0.2, 0.2, 0.2) });
}

async function main() {
  await fs.mkdir('tests/samples', { recursive: true });

  // 1. A4 纵向 3 页
  {
    const doc = await PDFDocument.create();
    for (let i = 1; i <= 3; i++) {
      const p = doc.addPage(A4);
      await drawContent(p, `PORTRAIT P${i}`);
    }
    await fs.writeFile('tests/samples/portrait.pdf', await doc.save());
  }
  // 2. A4 横向 1 页
  {
    const doc = await PDFDocument.create();
    await drawContent(doc.addPage([A4[1], A4[0]]), 'LANDSCAPE');
    await fs.writeFile('tests/samples/landscape.pdf', await doc.save());
  }
  // 3. 页面盒为 A4 纵向、带 /Rotate 90（查看器里显示为横向）
  {
    const doc = await PDFDocument.create();
    const p = doc.addPage(A4);
    await drawContent(p, 'ROTATE90');
    p.setRotation(degrees(90));
    await fs.writeFile('tests/samples/rotated.pdf', await doc.save());
  }
  // 4. A5 纵向 1 页
  {
    const doc = await PDFDocument.create();
    await drawContent(doc.addPage(A5), 'A5 SMALL');
    await fs.writeFile('tests/samples/a5.pdf', await doc.save());
  }
  console.log('测试样本已生成: tests/samples/');
}
main();
