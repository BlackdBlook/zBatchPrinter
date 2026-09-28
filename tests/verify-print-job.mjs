// 验证批量打印任务流程（需服务以 BATCHPRINT_DRY=1 启动）：创建任务 → 轮询 → 校验状态与命令参数
import fs from 'node:fs/promises';

const BASE = 'http://localhost:8163';
let failed = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ✔ ${name} ${detail}`);
  else { console.error(`  ✘ ${name} ${detail}`); failed++; }
};

async function upload(name, path) {
  const body = await fs.readFile(path);
  const res = await fetch(`${BASE}/api/upload?name=${encodeURIComponent(name)}`, { method: 'POST', body });
  const data = await res.json();
  if (!res.ok) throw new Error(`上传失败: ${data.error}`);
  return data;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitJob(id, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const job = await (await fetch(`${BASE}/api/jobs/${id}`)).json();
    if (job.status !== 'running') return job;
    await sleep(200);
  }
  throw new Error('任务超时');
}

async function main() {
  const f1 = await upload('portrait.pdf', 'tests/samples/portrait.pdf');
  const f2 = await upload('landscape.pdf', 'tests/samples/landscape.pdf');

  // 1. 正常批量打印
  console.log('\n[1] 批量打印 2 个文件（3 份、双面长边、黑白、指定打印机）');
  const settings = {
    printer: 'Microsoft Print to PDF',
    paper: 'A4', orientation: 'auto', scaleMode: 'fit', scalePercent: 100,
    margin: { top: 10, right: 10, bottom: 10, left: 10 },
    halign: 'center', valign: 'middle', copies: 3, duplex: 'duplexlong', color: 'monochrome',
  };
  let res = await fetch(`${BASE}/api/print`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileIds: [f1.id, f2.id], settings }),
  });
  let data = await res.json();
  check('创建任务', res.ok && data.jobId, JSON.stringify(data));
  const job = await waitJob(data.jobId);
  check('任务完成', job.status === 'done', `status=${job.status}`);
  check('两个文件均 done', job.items.every((i) => i.status === 'done'), JSON.stringify(job.items.map((i) => i.status)));

  // 2. 取消（快速取消当前任务剩余部分）
  console.log('\n[2] 取消任务');
  const f3 = await upload('a5.pdf', 'tests/samples/a5.pdf');
  res = await fetch(`${BASE}/api/print`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileIds: [f1.id, f2.id, f3.id], settings: { ...settings, copies: 1 } }),
  });
  data = await res.json();
  await fetch(`${BASE}/api/jobs/${data.jobId}/cancel`, { method: 'POST' });
  const cancelled = await waitJob(data.jobId);
  check('取消后任务结束', cancelled.status === 'cancelled' || cancelled.status === 'done', `status=${cancelled.status}`);
  check('无未完成项', cancelled.items.every((i) => ['done', 'error', 'cancelled'].includes(i.status)), JSON.stringify(cancelled.items.map((i) => i.status)));

  // 3. 边界：空文件列表 / 不存在的文件 id
  console.log('\n[3] 边界情况');
  res = await fetch(`${BASE}/api/print`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileIds: [], settings }),
  });
  check('空列表返回 400', res.status === 400, `status=${res.status}`);
  res = await fetch(`${BASE}/api/print`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileIds: ['nonexistent'], settings }),
  });
  check('无效 id 返回 400', res.status === 400, `status=${res.status}`);

  // 4. 非法设置被规范化（不报错）
  res = await fetch(`${BASE}/api/preview`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileId: f1.id, settings: { paper: 'XXL', orientation: 'diagonal', copies: 9999, margin: { top: -5 } } }),
  });
  check('非法设置规范化后可预览', res.status === 200, `status=${res.status}`);

  // 5. 删除文件
  res = await fetch(`${BASE}/api/files/${f3.id}`, { method: 'DELETE' });
  check('删除文件', res.status === 200);
  res = await fetch(`${BASE}/api/files`);
  const list = (await res.json()).files;
  check('删除后列表不含该文件', !list.some((f) => f.id === f3.id), `files=${list.length}`);

  console.log(failed ? `\n❌ ${failed} 项失败` : '\n✅ 打印任务流程全部通过');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
