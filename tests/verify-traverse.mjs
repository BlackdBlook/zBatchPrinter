// 验证拖入文件夹的递归遍历逻辑（伪造 FileSystemEntry 树，含 readEntries 每批最多 100 条的行为）
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { collectPdfFiles } = require('../public/traverse.js');

let failed = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ✔ ${name} ${detail}`);
  else { console.error(`  ✘ ${name} ${detail}`); failed++; }
};

function fakeFile(name, type = '') {
  return {
    isFile: true,
    isDirectory: false,
    name,
    file: (cb) => setTimeout(() => cb({ name, type }), 1),
  };
}

function fakeDir(name, children, { batchSize = 100 } = {}) {
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader() {
      let offset = 0;
      return {
        // 连续分批：每次返回下一段（最多 batchSize 条），读完返回空数组
        readEntries(cb) {
          const batch = children.slice(offset, offset + batchSize);
          offset += batch.length;
          setTimeout(() => cb(batch), 1);
        },
      };
    },
  };
}

async function main() {
  // 1. 嵌套目录 + 非 PDF 过滤 + 同名文件区分
  console.log('\n[1] 嵌套目录递归');
  const tree = fakeDir('dropped', [
    fakeFile('readme.txt'),
    fakeFile('a.pdf'),
    fakeDir('2024', [
      fakeFile('report.pdf'),
      fakeDir('Q1', [fakeFile('a.pdf'), fakeFile('data.xlsx')]),
      fakeDir('empty', []),
    ]),
    fakeFile('封面.PDF'), // 大小写扩展名
  ]);
  const found = await collectPdfFiles([tree]);
  check('找到 4 个 PDF', found.length === 4, JSON.stringify(found.map((f) => f.name)));
  check('相对路径正确', found.some((f) => f.name === 'dropped/2024/Q1/a.pdf'));
  check('同名文件可区分', found.filter((f) => f.name.endsWith('a.pdf')).length === 2);
  check('大写扩展名识别', found.some((f) => f.name === 'dropped/封面.PDF'));
  check('非 PDF 已过滤', !found.some((f) => /\.(txt|xlsx)$/i.test(f.name)));

  // 2. 单目录超过 100 条（readEntries 分批）
  console.log('\n[2] 超过 100 条分批读取');
  const many = [];
  for (let i = 0; i < 235; i++) many.push(fakeFile(`doc${String(i).padStart(3, '0')}.pdf`));
  many.splice(50, 0, fakeFile('skip.jpg'));
  const bigDir = fakeDir('bulk', many);
  const found2 = await collectPdfFiles([bigDir]);
  check('235 个 PDF 全部找到', found2.length === 235, `got ${found2.length}`);
  check('首个与末个都在', found2.some((f) => f.name === 'bulk/doc000.pdf') && found2.some((f) => f.name === 'bulk/doc234.pdf'));
  check('图片被过滤', !found2.some((f) => f.name.endsWith('.jpg')));

  // 3. 顶层混合：散文件 + 多个文件夹
  console.log('\n[3] 顶层混合拖入');
  const found3 = await collectPdfFiles([
    fakeFile('loose.pdf'),
    fakeDir('dirA', [fakeFile('x.pdf')]),
    fakeDir('dirB', [fakeDir('deep', [fakeFile('y.pdf')])]),
  ]);
  check('共 3 个 PDF', found3.length === 3, JSON.stringify(found3.map((f) => f.name)));
  check('散文件无前缀', found3.some((f) => f.name === 'loose.pdf'));
  check('多级前缀正确', found3.some((f) => f.name === 'dirB/deep/y.pdf'));

  // 4. 空输入与空目录
  console.log('\n[4] 空输入');
  const found4 = await collectPdfFiles([fakeDir('nothing', [])]);
  check('空目录返回空', found4.length === 0);
  const found5 = await collectPdfFiles([]);
  check('空列表返回空', found5.length === 0);

  console.log(failed ? `\n❌ ${failed} 项失败` : '\n✅ 递归遍历全部通过');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
