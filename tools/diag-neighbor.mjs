// 鱼知 · 邻居门到底该拉多宽
// 现状：命中段的 ±1 句。多跳题的证据常常隔得不近，量一下 ±2/±3/±5 和「整段对话」各值多少。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addMessages, readUser } from '../src/store.mjs';
import { buildIndex, bm25Door, literalDoor, entityDoor, dateDoor, rrfFuse, neighborDoor, pack } from '../src/recall.mjs';
import { conversationMessages, chunks } from '../src/replay.mjs';

const raw = JSON.parse(fs.readFileSync(process.argv[2] || 'data/locomo10.json', 'utf8'));
const data = Array.isArray(raw) ? raw : [raw];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yuzhi-nb-'));
const W = { neighbor: 0.5, entity: 0.2 };
const TOPK = 100;

// 把整段对话里离命中段最近的 n 句拉进来（不限同一「段」，只限同一 session）
function sessionWindow(idx, seeds, n) {
  const seen = new Set();
  const out = [];
  for (const id of seeds) {
    const s = idx.byId.get(id);
    if (!s) continue;
    const arr = (idx.bySession.get(s.session_id) || []).filter((x) => x.part === 1 && x.id !== s.id);
    arr.sort((a, b) => Math.abs(a.seq - s.seq) - Math.abs(b.seq - s.seq));
    for (const t of arr.slice(0, n)) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      out.push({ id: t.id, score: 1 });
    }
  }
  return out;
}

const CONFIGS = [
  ['不加邻居', (idx, seeds) => []],
  ['±1（现在）', (idx, seeds) => neighborDoor(idx, seeds, 1)],
  ['±2', (idx, seeds) => neighborDoor(idx, seeds, 2)],
  ['±3', (idx, seeds) => neighborDoor(idx, seeds, 3)],
  ['±5', (idx, seeds) => neighborDoor(idx, seeds, 5)],
  ['同段最近 6 句', (idx, seeds) => sessionWindow(idx, seeds, 6)],
  ['同段最近 12 句', (idx, seeds) => sessionWindow(idx, seeds, 12)],
];

const acc = new Map(CONFIGS.map(([n]) => [n, { any10: 0, any100: 0, all100: 0, chars: 0, cat1all: 0, cat1n: 0 }]));
let questions = 0;

let ci = -1;
for (const conv of data) {
  ci += 1;
  const userId = 'n:conv-' + ci;
  const sessionId = 'n:s' + ci;
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
    const goldDias = new Set(golds);
    const goldIds = new Set();
    for (const g of golds) for (const id of diaToIds.get(g) || []) goldIds.add(id);
    if (!goldIds.size) continue;
    const q = qa.question;
    questions += 1;

    const lists = [
      ['bm25', bm25Door(idx, q)],
      ['literal', literalDoor(idx, q)],
      ['date', dateDoor(idx, q) || []],
      ['entity', entityDoor(idx, q)],
    ];
    const base = rrfFuse(lists, undefined, W);
    const seeds = base.slice(0, 5).map((r) => r.id);

    for (const [name, makeNb] of CONFIGS) {
      const nb = makeNb(idx, seeds);
      const rows = nb.length ? rrfFuse([...lists, ['neighbor', nb]], undefined, W) : base;
      const items = pack(rows, idx, { topK: TOPK, budgetTokens: Number.MAX_SAFE_INTEGER });
      const gotDia = items.map((it) => seqToDia.get(idx.byId.get(it.id).seq));
      const top10 = new Set(gotDia.slice(0, 10));
      const top100 = new Set(gotDia);
      const a = acc.get(name);
      if ([...goldDias].some((d) => top10.has(d))) a.any10 += 1;
      if ([...goldDias].some((d) => top100.has(d))) a.any100 += 1;
      if ([...goldDias].every((d) => top100.has(d))) {
        a.all100 += 1;
        if (Number(qa.category) === 1) a.cat1all += 1;
      }
      if (Number(qa.category) === 1) a.cat1n += 1;
      a.chars += items.reduce((x, it) => x + it.content.length, 0);
    }
  }
}

const pct = (x, n) => ((x / n) * 100).toFixed(1) + '%';
console.log('题目 ' + questions + '，每题取前 ' + TOPK + ' 条\n');
console.log('  邻居宽度            any@10   any@100   all@100   多跳all@100   平均字符数');
for (const [name] of CONFIGS) {
  const a = acc.get(name);
  console.log('  ' + name.padEnd(16) + pct(a.any10, questions).padStart(7) + '  ' + pct(a.any100, questions).padStart(8) + '  '
    + pct(a.all100, questions).padStart(8) + '  ' + pct(a.cat1all, a.cat1n).padStart(10) + '  ' + String(Math.round(a.chars / questions)).padStart(10));
}
fs.rmSync(tmp, { recursive: true, force: true });
