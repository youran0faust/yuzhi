// 把 LoCoMo 的 locomo10.json 转成本仓库回放吃的形状。
// 为什么要有它：公开数据和我们的形状只差一层包装，但这层包装手改一次就会改错，
// 而且下一次换数据还要再来一遍。只做搬运，不做筛选、不改标点。
//
// 用法：node tools/import-locomo.mjs <locomo10.json> [输出路径] [--max-sessions=N]
//
// ★ 会跳过被截断的段落：如果文件在某个 session 中间断了，那个 session 整个丢掉并打印出来。
//   宁可少一段，不许拿半段冒充完整（半句话比没有更有害）。
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const flags = {};
const args = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--max-sessions') flags.maxSessions = Number(argv[++i]);
  else if (a.startsWith('--max-sessions=')) flags.maxSessions = Number(a.split('=')[1]);
  else args.push(a);
}
if (!args[0]) {
  console.error('用法: node tools/import-locomo.mjs <locomo10.json> [输出路径]');
  process.exit(2);
}

const raw = fs.readFileSync(args[0], 'utf8');
const outPath = args[1] || 'examples/locomo-conv0.json';
const start = raw.indexOf('[');
if (start < 0) { console.error('没找到 JSON 数组起点'); process.exit(1); }
const text = raw.slice(start);

// 从 from 之后第一个 '[' 开始，逐字符收一个平衡的数组。
// 必须跟踪字符串状态：文本里出现的方括号（哪怕成对）不能当结构。
function grabArrayAfter(pos) {
  const open = text.indexOf('[', pos);
  if (open < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) return { text: text.slice(open, i + 1), closed: true };
      if (depth < 0) return null;
    }
  }
  return null; // 文件在这里被截断
}

const qaKey = text.indexOf('"qa"');
if (qaKey < 0) { console.error('没找到 qa 段'); process.exit(1); }
const qaGrab = grabArrayAfter(qaKey);
if (!qaGrab) { console.error('qa 段被截断'); process.exit(1); }

const conv = {};
const dropped = [];
for (let n = 1; n <= 30; n++) {
  const key = text.indexOf('"session_' + n + '"');
  if (key < 0) break;
  if (flags.maxSessions && n > flags.maxSessions) break;
  const g = grabArrayAfter(key);
  if (!g) { dropped.push(n); continue; }
  conv['session_' + n] = JSON.parse(g.text);
  const dtKey = text.indexOf('"session_' + n + '_date_time"');
  if (dtKey >= 0) {
    const m = text.slice(dtKey, dtKey + 200).match(/:\s*"([^"]*)"/);
    if (m) conv['session_' + n + '_date_time'] = m[1];
  }
}

const qa = JSON.parse(qaGrab.text);
const out = [{
  sample_id: 'locomo-conv0',
  note: dropped.length ? 'session ' + dropped.join(',') + ' 因文件截断被丢弃' : '完整',
  conversation: conv,
  qa,
}];
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf8');

const sessionKeys = Object.keys(conv).filter((k) => /^session_\d+$/.test(k));
const turns = sessionKeys.reduce((a, k) => a + conv[k].length, 0);
console.log('写入 ' + outPath);
console.log('对话 ' + sessionKeys.length + ' 段 / ' + turns + ' 轮 / 问题 ' + qa.length + ' 条');
if (dropped.length) console.log('被截断丢弃的 session: ' + dropped.join(', '));
