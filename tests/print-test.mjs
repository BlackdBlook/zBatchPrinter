// 复现"打印机名称无效(退出码 2)"：用与 server.js printFile 完全一致的 spawn 方式实测各种打印机名
// 注意：成功匹配的用例会真实打印一张测试页（tests/testpage.pdf）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const exe = fs.readdirSync('tools/SumatraPDF').filter((f) => /^SumatraPDF.*\.exe$/i.test(f)).map((f) => path.join('tools', 'SumatraPDF', f))[0];
const pdf = path.resolve('tests/testpage.pdf');

function run(label, args) {
  return new Promise((resolve) => {
    const child = spawn(exe, args, { windowsHide: true });
    let err = '';
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', (e) => resolve(`${label}: spawn 失败 ${e.message}`));
    child.on('close', (code) => resolve(`${label}: 退出码 ${code}${err ? ' stderr=' + err.slice(0, 200) : ''}`));
  });
}

const settings = 'noscale,paper=auto,ignore-pdf-print-settings';
const realPrinter = process.argv[2]; // 传入本机真实打印机名才会执行 B 用例（会真实打印一张）
console.log('引擎:', exe);
console.log(await run('A 带装饰后缀的名字(无效名)          ', ['-app-name', 'BatchPrint', '-print-to', '测试打印机（默认）', '-print-settings', settings, '-silent', '-exit-when-done', pdf]));
console.log(realPrinter
  ? await run('B 真实打印机名                       ', ['-app-name', 'BatchPrint', '-print-to', realPrinter, '-print-settings', settings, '-silent', '-exit-when-done', pdf])
  : 'B 真实打印机名                       : 跳过（用法: node tests/print-test.mjs <打印机名>）');
console.log(await run('C 空字符串名                        ', ['-app-name', 'BatchPrint', '-print-to', '', '-print-settings', settings, '-silent', '-exit-when-done', pdf]));
console.log(await run('D 不存在的名字                      ', ['-app-name', 'BatchPrint', '-print-to', '不存在的打印机XYZ', '-print-settings', settings, '-silent', '-exit-when-done', pdf]));
