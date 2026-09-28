// DOM 冒烟测试：jsdom 加载页面脚本，抓取运行时错误并校验初始化完成（徽标文本、预览高度内联样式）
import { JSDOM } from 'jsdom';
import fs from 'node:fs';

const html = fs.readFileSync('public/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8163/', pretendToBeVisual: true, runScripts: 'outside-only' });

const errors = [];
dom.window.addEventListener('error', (e) => errors.push(String(e.message || e.error)));

// 桩掉 fetch（config 徽标数据），避免真实网络
dom.window.fetch = async (url) => ({
  ok: true,
  json: async () => ({
    papers: ['A4'],
    printers: [{ name: '测试打印机', default: true, offline: false }],
    engine: { status: 'ready', progress: 100, error: null },
  }),
});

for (const src of ['public/traverse.js', 'public/app.js']) {
  try {
    dom.window.eval(fs.readFileSync(src, 'utf8'));
  } catch (e) {
    errors.push(`加载 ${src} 抛错: ${e.stack || e.message}`);
  }
}

// 等待微任务（loadConfig 的 async 链）
await new Promise((r) => setTimeout(r, 300));

const doc = dom.window.document;
const style = doc.getElementById('previewFrame').getAttribute('style');
const engineBadge = doc.getElementById('engineBadge').textContent;
const printerOptions = doc.querySelectorAll('#setPrinter option').length;

console.log('运行时错误:', errors.length ? errors : '无');
console.log('引擎徽标:', JSON.stringify(engineBadge));
console.log('打印机选项数:', printerOptions);
console.log('预览内联高度:', JSON.stringify(style));
console.log(errors.length || !style ? '\n❌ 初始化异常' : '\n✅ 初始化完整，预览高度已设置');
process.exit(errors.length || !style ? 1 : 0);
