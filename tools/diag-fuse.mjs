// 鱼知 · 融合保底实验
// 预测（2026-11-21 12:15，先写再跑，跑完先看这些条件对不对）：
//   P1 每门 top10 保底能把多跳 all@100 抬起来，但幅度不会大：缺失证据里单门 <=10 只有 21/362 条，
//      剩下的大多单门 50-200 名——保底救得回「本来排前面却被融合压掉」那一小撮。
//   P2 any@10 会掉：实体门是平表，保底把「这个人随口说的话」塞到前面，会挤掉字面更准的条目。
//   反证：若多跳 all@100 涨不到 +1 个点 → 保底不是对的方向，换「问句拆子问题」。
//         若 any@10 掉超过 1.5 个点 → 否决保底。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addMessages, readUser } from '../src/store.mjs';
import { buildIndex, bm25Door, literalDoor, entityDoor, dateDoor, rrfFuse, neighborDoor, pack, DOOR_WEIGHTS } from '../src/recall.mjs';
import { conversationMessages, chunks } from '../src/replay.mjs';

const argv = process.argv.slice(2);
const dataPath = argv.find((a) => !a.startsWith('--')) || 'data/locomo10.json';
const convLimit = Number((argv.find((a) => a.startsWith('--convos=')) || '').split('=')[1] || 0) || Infinity;
const raw = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
const data = (Array.isArray(raw) ? raw : [raw]).slice(0, convLimit);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yuzhi-fuse-'));

const VARIANTS = [
  ['现在', null],
  ['每门top10保底', { doors: ['bm25', 'literal', 'entity', 'date'], n: 10 }],
  ['每门top20保底', { doors: ['bm25', 'literal', 'entity', 'date'], n: 20 }],
  ['entity门top10保底', { doors: ['entity'], n: 10 }],
  ['entity门top20保底', { doors: ['entity'], n: 20 }],
  ['literal门top10保底', { doors: ['literal'], n: 10 }],
];
const acc = new Map(VARIANTS.map(([n]) => [n, { any10: 0, any100: 0, all100: 0, cat1any10: 0, cat1any100: 0, cat1all: 0, cat1n: 0, chars: 0, q: 0 }]));
const halves = [new Set(), new Set()]; // 前半 / 后半：conv 0-4 / 5-9

function applyGuard(rows, lists, n) {
  // 取每门 top n 的条目；把「总量」条保底整体塞进前 100 的尾部。
  // 关键：抬到第 (100 - 保底条数) 名的分数，这样它们加进来正好占满 100 的尾部，
  // 而不是只顶掉第 100 名一条（第一版就错在这）。
  const add = new Map();
  for (const [name, list] of lists) {
    if (!n.doors.includes(name)) continue;
    list.slice(0, n.n).forEach((r, i) => {
      if (!add.has(r.id)) add.set(r.id, { door: name, rank: i + 1 });
    });
  }
  const total = add.size;
  const safeIdx = Math.max(0, Math.min(rows.length - 1, 100 - total));
  const base = rows.length ? rows[safeIdx].score : 0;
  const out = rows.filter((r) => !add.has(r.id)).map((r) => ({ ...r }));
  for (const [id, g] of add) {
    const row = rows.find((r) => r.id === id);
    if (!row) continue;
    const boosted = row.score > base ? row.score : base + 1e-6 * (n.n - g.rank + 1) / 100;
    out.push({ ...row, score: boosted });
  }
  return out.sort((a, b) => b.score - a.score);
}

let ci = -1;
for (const conv of data) {
  ci += 1;
  const userId = 'fuse:conv-' + ci;
  const msgs = conversationMessages(conv);
  const seqToDia = new Map(msgs.map((m, i) => [i + 1, m.dia_id]));
  const chs = chunks(msgs);
  for (let k = 0; k < chs.length; k += 1) {
    addMessages({ dir: tmp, userId, sessionId: 'fuse:s' + ci, requestId: userId + ':c' + k,
      messages: chs[k].map((m) => ({ role: m.role, content: m.content, timestamp: m.timestamp })) });
  }
  const segs = readUser(tmp, userId).segs;
  const idx = buildIndex(segs);

  for (const qa of conv.qa || []) {
    const golds = (qa.evidence || []).filter((e) => typeof e === 'string');
    if (!golds.length) continue;
    const q = qa.question;
    const goldDias = new Set(golds);
    const cat1 = Number(qa.category) === 1;

    const lists = [
      ['bm25', bm25Door(idx, q)],
      ['literal', literalDoor(idx, q)],
      ['entity', entityDoor(idx, q)],
      ['date', dateDoor(idx, q) || []],
    ];
    const base = rrfFuse(lists, undefined, DOOR_WEIGHTS);
    const seeds = base.slice(0, 5).map((r) => r.id);
    const nb = neighborDoor(idx, seeds);
    const withNb = nb.length ? rrfFuse([...lists, ['neighbor', nb]], undefined, DOOR_WEIGHTS) : base;

    for (const [name, guard] of VARIANTS) {
      const rows = guard ? applyGuard(withNb, lists, guard) : withNb;
      const items = pack(rows, idx, { topK: 100, budgetTokens: Number.MAX_SAFE_INTEGER });
      const gotDias = new Set(items.map((it) => seqToDia.get(idx.byId.get(it.id).seq)));
      const got10 = new Set(items.slice(0, 10).map((it) => seqToDia.get(idx.byId.get(it.id).seq)));
      const a = acc.get(name);
      a.q += 1;
      if ([...goldDias].some((d) => got10.has(d))) a.any10 += 1;
      if ([...goldDias].some((d) => gotDias.has(d))) a.any100 += 1;
      if ([...goldDias].every((d) => gotDias.has(d))) a.all100 += 1;
      if (cat1) {
        a.cat1n += 1;
        if ([...goldDias].some((d) => got10.has(d))) a.cat1any10 += 1;
        if ([...goldDias].some((d) => gotDias.has(d))) a.cat1any100 += 1;
        if ([...goldDias].every((d) => gotDias.has(d))) a.cat1all += 1;
      }
      a.chars += items.reduce((x, it) => x + it.content.length, 0);
    }
  }
}

const pct = (x, n) => ((x / n) * 100).toFixed(1) + '%';
console.log('题目 ' + acc.get(VARIANTS[0][0]).q + '，每题取前 100 条\n');
console.log('  方案                  any@10   any@20   any@100  all@100   多跳any@10  多跳all@100  平均字符');
for (const [name] of VARIANTS) {
  const a = acc.get(name);
  console.log('  ' + name.padEnd(18)
    + pct(a.any10, a.q).padStart(8)
    + pct(a.any100, a.q).padStart(8)
    + pct(a.any100, a.q).padStart(9)
    + pct(a.all100, a.q).padStart(9)
    + pct(a.cat1any10, a.cat1n).padStart(12)
    + pct(a.cat1all, a.cat1n).padStart(12)
    + String(Math.round(a.chars / a.q)).padStart(10));
}
fs.rmSync(tmp, { recursive: true, force: true });

