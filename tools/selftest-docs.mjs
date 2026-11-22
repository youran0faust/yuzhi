// 文档自查：README / SPEC 里点过名的路径，磁盘上是不是真的存在。
// 为什么要有它：上过最多的当不是代码写错，是文档写得像真的——「见 docs/」而 docs 不存在，
// 读的人没法核。它只查存在性，不查内容对不对（那是契约测试的活）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DOCS = ['README.md', 'SPEC.md'];

// 文档会举例提到仓库外面的东西。它们「不存在于本仓库」是对的，不是假账——
// 但只许白名单里这些，不许图省事把整类跳过。
const OUTSIDE_REPO = new Set(['02-墨.jsonl', 'memory-tier.mjs']);
// 运行时才出现的目录（数据落在这里，第一次之前不存在是正常的）
const RUNTIME_DIRS = new Set(['data/']);
// 纯文件名没有目录前缀时，到这些地方找
const SEARCH_PATHS = ['', 'src/', 'test/', 'tools/', 'examples/'];

const TOKEN = /`([^`\n]+)`/g;
const looksLikePath = (s) => {
  if (!s || s.includes(' ') || s.includes('>') || s.includes('|')) return false;
  if (/^(https?:|mailto:)/.test(s)) return false;
  if (s.startsWith('-') || s.startsWith('$')) return false;
  if (s.startsWith('.')) return false;                 // `.jsonl` 这种是扩展名，不是路径
  if (s.includes('*')) return false;                  // 通配符（.gitignore 规则之类）
  return /\.(mjs|json|jsonl|md|py|txt)$/.test(s) || s.endsWith('/');
};

const exists = (rel) => {
  if (rel.includes('/')) return fs.existsSync(path.join(ROOT, rel));
  // 纯文件名：先在根，再在常见子目录里找
  return SEARCH_PATHS.some((pre) => fs.existsSync(path.join(ROOT, pre + rel)));
};

const missing = [];
const checked = new Set();
const skipped = [];
for (const name of DOCS) {
  const f = path.join(ROOT, name);
  if (!fs.existsSync(f)) { missing.push({ doc: name, path: '(文档本身不存在)', line: 0 }); continue; }
  const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const m of line.matchAll(TOKEN)) {
      const raw = m[1].trim();
      if (!looksLikePath(raw)) continue;
      if (OUTSIDE_REPO.has(raw) || RUNTIME_DIRS.has(raw)) { skipped.push(raw); continue; }
      const rel = raw.replace(/^\.\//, '');
      if (checked.has(rel)) continue;
      checked.add(rel);
      if (!exists(rel)) missing.push({ doc: name, path: rel, line: i + 1 });
    }
  });
}

if (!missing.length) {
  const note = skipped.length ? '（另有 ' + [...new Set(skipped)].join(' / ') + ' 按约定不查）' : '';
  console.log('文档自查：' + checked.size + ' 个路径全部存在' + note);
  process.exit(0);
}
console.log('文档自查：' + checked.size + ' 个路径里，' + missing.length + ' 个在磁盘上不存在：');
for (const m of missing) console.log('  ' + m.doc + ':' + m.line + '  ' + m.path);
process.exit(1);
