// 解码 PNG（8bit RGBA/RGB 非隔行）并计算非白色内容的包围盒，用于精确验证页边距/缩放/居中
// 可作为模块导入（contentBBox/decodePng），也可直接命令行运行：node measure-png.mjs <file.png>
import fs from 'node:fs';
import zlib from 'node:zlib';

export function decodePng(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not png');
  let pos = 8;
  let width = 0; let height = 0; let bitDepth; let colorType; let idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
      if (bitDepth !== 8 || ![2, 6].includes(colorType)) throw new Error(`unsupported png: depth=${bitDepth} color=${colorType}`);
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += Math.floor((a + b) / 2);
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : (pb <= pc ? b : c);
      }
      cur[i] = v & 0xff;
    }
    prev = cur;
  }
  return { width, height, channels, data: out };
}

export function contentBBox(file, threshold = 245) {
  const { width, height, channels, data } = decodePng(file);
  let minX = width; let minY = height; let maxX = -1; let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      const r = data[i]; const g = data[i + 1]; const b = data[i + 2];
      if (r < threshold || g < threshold || b < threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return {
    width, height,
    left: minX, top: minY, right: width - 1 - maxX, bottom: height - 1 - maxY,
    contentW: maxX - minX + 1, contentH: maxY - minY + 1,
  };
}

const isCli = process.argv[1] && import.meta.url === new URL('file:///' + process.argv[1].replace(/\\/g, '/')).href;
if (isCli && process.argv[2]) {
  const box = contentBBox(process.argv[2]);
  const pct = (v, total) => (100 * v / total).toFixed(1) + '%';
  console.log(`${process.argv[2]}  ${box.width}x${box.height}`);
  console.log(`  内容框: ${box.contentW}x${box.contentH}px  (占 ${(100 * box.contentW / box.width).toFixed(1)}% 宽 / ${(100 * box.contentH / box.height).toFixed(1)}% 高)`);
  console.log(`  边距: 左=${pct(box.left, box.width)} 右=${pct(box.right, box.width)} 上=${pct(box.top, box.height)} 下=${pct(box.bottom, box.height)}`);
  console.log(`  像素: 左=${box.left} 右=${box.right} 上=${box.top} 下=${box.bottom}`);
}
