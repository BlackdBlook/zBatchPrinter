/**
 * 拖放目录递归遍历：把 DataTransfer 的 entry 列表（文件/目录混合）
 * 展开为 PDF 文件列表，文件名带相对路径（如 "资料/2024/报告.pdf"）。
 * UMD-lite：浏览器挂到 window.BatchPrintTraverse，Node 下可 require 以便测试。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BatchPrintTraverse = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  // FileSystemDirectoryReader.readEntries 每次最多返回 100 条，需循环读到空为止
  function readAllEntries(reader) {
    return new Promise((resolve, reject) => {
      const all = [];
      const readBatch = () => reader.readEntries((batch) => {
        if (!batch.length) return resolve(all);
        all.push(...batch);
        readBatch();
      }, reject);
      readBatch();
    });
  }

  async function walkEntry(entry, prefix, out) {
    if (entry.isFile) {
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
      if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') {
        out.push({ file, name: prefix ? `${prefix}/${file.name}` : file.name });
      }
    } else if (entry.isDirectory) {
      const children = await readAllEntries(entry.createReader());
      const nextPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
      for (const child of children) await walkEntry(child, nextPrefix, out);
    }
    // 其他类型（如符号链接异常条目）忽略
  }

  /**
   * @param {FileSystemEntry[]} entries drop 事件里同步取出的 entry 列表
   * @returns {Promise<Array<{file: File, name: string}>>} 所有 PDF，name 为相对路径
   */
  async function collectPdfFiles(entries) {
    const out = [];
    for (const entry of entries) await walkEntry(entry, '', out);
    return out;
  }

  return { readAllEntries, collectPdfFiles };
});
