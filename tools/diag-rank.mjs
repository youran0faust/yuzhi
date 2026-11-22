// 鱼知 · 排序诊断
// 回答三件事：金标排第几、每扇门单独排能排多准、哪扇门是拖后腿的那扇。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addMessages, readUser } from '../src/store.mjs';
import { buildIndex, search, bm25Door, literalDoor, entityDoor, dateDoor } from '../src/recall.mjs';
import { conversationMessages, chunks } from '../src/replay.mjs';

const argv = process.argv.slice(2);
const dataPath = argv[0] || 'data/locomo10.json';
const convLimit = Number((argv.find((a) => a.startsWith('--convos=')) || '').split('=')[1] || 0) || Infinity;
const raw = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
const data = (Array.isArray(raw) ? raw : [raw]).slice(0, convLimit);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yuzhi-diag-'));

const BUCKETS = [
  ['第1', 1, 1], ['2-5', 2, 5], ['6-10', 6, 10], ['11-20', 11, 20],
  ['21-50', 21, 50], ['51-100', 51, 100], ['>100', 101, Infinity], ['不在榜', 0, 0],
];
const bucketOf = (r) => {
  if (r === Infinity || r === 0) return '不在榜';
  for (const [name, lo, hi] of BUCKETS) if (r >= lo && r <= hi) return name;
  return '>100';
};
const rankIn = (list, ids) => {
  let best = Infinity;
  for (const id of ids) {
    const i = list.findIndex((x) => x.id === id);
    if (i >= 0 && i + 1 < best) best = i + 1;
  }
  return best;
};

const rows = [];
let ci = -1;
for (const conv of data) {
  ci += 1;
  const userId = 'diag:conv-' + ci;
  const sessionId = 'diag:s' + ci;
  const msgs = conversationMessages(conv);
  const seqToDia = new Map(msgs.map((m, i) => [i + 1, m.dia_id]));
  const diaToIds = new Map();
  const chs = chunks(msgs);
  for (let k = 0; k < chs.length; k += 1) {
    addMessages({ dir: tmp, userId, sessionId, requestId: userId + ':c' + k,
      messages: chs[k].map((m) => ({ role: m.role, content: m.content, timestamp: m.timestamp })) });
  }
  const segs = readUser(tmp, userId).segs;
  const idx = buildIndex(segs);
  for (const s of segs) {
    const dia = seqToDia.get(s.seq);
    if (!dia) continue;
    if (!diaToIds.has(dia)) diaToIds.set(dia, []);
    diaToIds.get(dia).push(s.id);
  }

  for (const qa of conv.qa || []) {
    const golds = (qa.evidence || []).filter((e) => typeof e === 'string');
    if (!golds.length) continue;
    const goldIds = [];
    for (const g of golds) for (const id of diaToIds.get(g) || []) goldIds.push(id);
    const q = qa.question;
    const fused = search(idx, q, { topK: 1000000, budgetTokens: Number.MAX_SAFE_INTEGER }).data;
    const bm = bm25Door(idx, q);
    const lit = literalDoor(idx, q);
    const ent = entityDoor(idx, q);
    const dat = dateDoor(idx, q) || [];
    rows.push({
      cat: qa.category, q, goldIds: goldIds.length,
      fused: rankIn(fused, goldIds), bm: rankIn(bm, goldIds), lit: rankIn(lit, goldIds),
      ent: rankIn(ent, goldIds), dat: rankIn(dat, goldIds),
      n: fused.length,
    });
  }
}

const p = (k) => (xs) => ((xs.filter((x) => x > 0 && x <= k).length / xs.length) * 100).toFixed(1);
console.log('题目 ' + rows.length + ' / 对话 ' + data.length + ' / 平均库容 ' + (rows.reduce((a, r) => a + r.n, 0) / rows.length).toFixed(0));

console.log('\n【每题金标最好名次分布（融合后）】');
const hist = {};
for (const r of rows) hist[bucketOf(r.fused)] = (hist[bucketOf(r.fused)] || 0) + 1;
for (const [name] of BUCKETS) console.log('  ' + name.padEnd(6) + String(hist[name] || 0).padStart(5) + '  ' + ((hist[name] || 0) / rows.length * 100).toFixed(1) + '%');

console.log('\n【单门 vs 融合：前1 / 前5 / 前10】');
const doors = [['bm25', 'bm'], ['literal', 'lit'], ['entity', 'ent'], ['date', 'dat'], ['融合', 'fused']];
for (const [name, k] of doors) {
  const xs = rows.map((r) => r[k]);
  console.log('  ' + name.padEnd(8) + ' 前1 ' + p(1)(xs).padStart(5) + '  前5 ' + p(5)(xs).padStart(5) + '  前10 ' + p(10)(xs).padStart(5));
}
const oracle = rows.map((r) => Math.min(r.bm, r.lit, r.ent, r.dat));
console.log('  ' + '任一门'.padEnd(8) + ' 前1 ' + p(1)(oracle).padStart(5) + '  前5 ' + p(5)(oracle).padStart(5) + '  前10 ' + p(10)(oracle).padStart(5) + '  ← 融合的天花板');

console.log('\n【按题型：融合前1 / 前10】');
const byCat = new Map();
for (const r of rows) { if (!byCat.has(r.cat)) byCat.set(r.cat, []); byCat.get(r.cat).push(r.fused); }
for (const [c, xs] of [...byCat].sort()) {
  console.log('  cat' + String(c).padEnd(3) + String(xs.length).padStart(5) + ' 题   前1 ' + p(1)(xs).padStart(5) + '   前10 ' + p(10)(xs).padStart(5));
}

console.log('\n【金标在第 6-10 名的例子（差一点就第1）】');
for (const r of rows.filter((x) => x.fused >= 6 && x.fused <= 10).slice(0, 8)) {
  console.log('  [' + r.cat + '] 融合' + r.fused + ' 门:bm' + (r.bm === Infinity ? '-' : r.bm) + ' lit' + (r.lit === Infinity ? '-' : r.lit) + ' ent' + (r.ent === Infinity ? '-' : r.ent) + '  ' + r.q.slice(0, 95));
}

fs.rmSync(tmp, { recursive: true, force: true });
