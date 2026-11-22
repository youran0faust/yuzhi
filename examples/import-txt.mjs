// 鱼知 / Yuzhi · 聊天记录（txt）→ /add
// 零依赖，Node 18+。
//   node examples/import-txt.mjs --in 聊天.txt --user me --session s1 [--url http://127.0.0.1:8850] [--dry]
//
// 认的格式（一行一条，行首前缀 + 全角或半角冒号都行）：
//   Q：…   用户说的     → role: user
//   A：…   助手说的     → role: assistant
//   T：…   当时的摘要   → 丢弃（摘要不是原话；丢了才符合「摘要只是索引」）
// 没有前缀的行 = 上一条的续行。
// 没有时间 → 不传 timestamp（契约允许：写 unknown，绝不拿服务器时间冒充）。
import fs from 'node:fs';

const argv = process.argv.slice(2);
const opt = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const k = a.slice(2);
    const nx = argv[i + 1];
    if (nx && !nx.startsWith('--')) { opt[k] = nx; i++; } else opt[k] = true;
  }
}
if (!opt.in) { console.error('缺 --in（聊天记录 txt）'); process.exit(2); }
if (!fs.existsSync(opt.in)) { console.error('没有这个文件：' + opt.in); process.exit(2); }

const PREFIX = /^\s*([QATqat])\s*[：:]\s?/;
const ROLE = { q: 'user', a: 'assistant' };

const raw = fs.readFileSync(opt.in, 'utf8').split(/\r?\n/);
const messages = [];
let dropped = 0;
let pending = null;
let orphan = 0;

for (const line of raw) {
  if (!line.trim()) continue;
  const m = line.match(PREFIX);
  if (m) {
    const tag = m[1].toLowerCase();
    if (tag === 't') { dropped += 1; pending = null; continue; }
    pending = { role: ROLE[tag], content: line.slice(m[0].length).trim() };
    messages.push(pending);
  } else if (pending) {
    pending.content += '\n' + line.trim();
  } else {
    orphan += 1;
  }
}

const body = {
  user_id: opt.user || 'local',
  request_id: opt.request || ('import-' + (opt.session || 'txt') + '-' + messages.length),
  session_id: opt.session || 'txt',
  messages,
};

const head = '读出 ' + messages.length + ' 条消息；丢掉 T 摘要 ' + dropped + ' 条；'
  + (orphan ? ('前面没有归属的行 ' + orphan + ' 行；') : '')
  + '时间未知 ' + messages.length + ' 条（不传 timestamp，不拿服务器时间冒充）';
console.log(head);
console.log('第一条：' + JSON.stringify(messages[0] || null).slice(0, 200));

if (opt.dry) process.exit(0);

const url = String(opt.url || 'http://127.0.0.1:8850').replace(/\/+$/, '') + '/add';
const res = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
const text = await res.text();
console.log('POST ' + url + ' → ' + res.status + ' ' + text.slice(0, 300));
if (!res.ok) process.exit(1);
