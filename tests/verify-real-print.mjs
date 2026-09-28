// 真实打印链路验证（会向指定打印机真实发送一张测试页）：
// 1. 后台轮询打印队列抓任务名  2. 上传并打印中文文件名测试页  3. 校验任务状态（退出码 2 应判成功）
import { spawn, exec } from 'node:child_process';
import fs from 'node:fs/promises';

const BASE = 'http://localhost:8163';
const PRINTER = process.argv[2];
if (!PRINTER) {
  console.error('用法: node tests/verify-real-print.mjs <打印机名>   （会真实打印一张测试页）');
  process.exit(1);
}
const DOC = '打印链路测试页.pdf';
const queueLog = 'tests/queue-observations.txt';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 队列轮询器：单次 PowerShell 进程内循环 12 秒，记录观察到的任务
const psScript = `
[Console]::OutputEncoding=[Text.Encoding]::UTF8
$deadline=(Get-Date).AddSeconds(12)
while((Get-Date) -lt $deadline){
  try { Get-PrintJob -PrinterName '${PRINTER}' | ForEach-Object { "$(Get-Date -Format HH:mm:ss.fff) | id=$($_.Id) | name=$($_.DocumentName) | $($_.JobStatus)" } } catch {}
  Start-Sleep -Milliseconds 200
}`;
const poller = spawn('powershell', ['-NoProfile', '-Command', psScript], { windowsHide: true });
const observed = [];
poller.stdout.on('data', (c) => observed.push(c.toString()));
poller.stderr.on('data', () => {});

async function main() {
  // 稍等轮询器就绪
  await sleep(800);

  const body = await fs.readFile('tests/testpage.pdf');
  const up = await (await fetch(`${BASE}/api/upload?name=${encodeURIComponent(DOC)}`, { method: 'POST', body })).json();
  console.log('上传:', up.name, 'pages=', up.pages);

  const t0 = Date.now();
  const pr = await (await fetch(`${BASE}/api/print`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fileIds: [up.id],
      settings: { printer: PRINTER, paper: 'A4', orientation: 'auto', scaleMode: 'fit', margin: {}, copies: 1, duplex: 'default', color: 'default' },
    }),
  })).json();
  console.log('任务:', pr.jobId || JSON.stringify(pr));

  let job;
  for (;;) {
    job = await (await fetch(`${BASE}/api/jobs/${pr.jobId}`)).json();
    if (job.status !== 'running') break;
    await sleep(300);
  }
  console.log(`任务结束(${((Date.now() - t0) / 1000).toFixed(1)}s): status=${job.status}`);
  for (const it of job.items) console.log(`  文件=${it.name} 状态=${it.status}${it.error ? ' 错误=' + it.error : ''}`);

  await sleep(2500); // 等轮询器结束
  await fs.writeFile(queueLog, observed.join(''));
  const lines = observed.join('').split(/\r?\n/).filter((l) => l.includes('|'));
  console.log(`\n队列观察（${lines.length} 条）:`);
  const names = new Set(lines.map((l) => (l.match(/name=([^|]*)/) || [])[1]).filter(Boolean));
  names.forEach((n) => console.log('  队列任务名:', JSON.stringify(n)));

  const item = job.items[0];
  const ok = item.status === 'done';
  const base = DOC.replace(/\.pdf$/i, '');
  const queueHit = names.has(base) || names.has(DOC) || [...names].some((n) => n.includes(base) || base.includes(n));
  console.log('\n结论: 打印状态判定', ok ? '✔ 正确(done)' : `✘ 异常(${item.status}: ${item.error})`);
  console.log('结论: 队列任务名匹配原文件名', queueHit ? '✔' : '（未捕获到队列记录，可能已即时完成）');
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
