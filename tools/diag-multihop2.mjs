// 鱼知 · 多跳题拆解（第二层）
// 第一层已量出：多跳 all@100 失败里 97% 是「某门召回、融合 >100」。
// 这一层问：它们在单门里本来排第几？是「本来就在后面」还是「融@合把它压下去」？
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yuzhi-mh2-'));

const rankIn = (list, id) => {
  const i = list.findIndex((x) => x.id === id);
  return i < 0 ? Infinity : i + 1;
};
const bucketOf = (r) => {
  if (r <= 10) return '<=10';
  if (r <= 50) return '11-50';
  if (r <= 100) return '51-100';
  if (r <= 200) return '101-200';
  if (r <= 500) return '201-500';
  return '>500';
};

const doorStats = {};
for (const door of ['bm25', 'literal', 'entity', 'date']) {
  doorStats[door] = { hit: 0, hitTop100: 0, hitTop10: 0 };
}
// 缺失证据：最佳单门名次 vs 融合名次
const missBuckets = { bestDoor: {}, fusedOfNoFused: {}, fusedGivenTopDoor: {} };
let missTotal = 0;
const bestDoorOf = {};
// 缺 1 条的题单独看
const oneMiss = { n: 0, door: {}, bucket: {} };

let ci = -1;
for (const conv of data) {
  ci += 1;
  const userId = 'mh2:conv-' + ci;
  const msgs = conversationMessages(conv);
  const seqToDia = new Map(msgs.map((m, i) => [i + 1, m.dia_id]));
  const diaToIds = new Map();
  const chs = chunks(msgs);
  for (let k = 0; k < chs.length; k += 1) {
    addMessages({ dir: tmp, userId, sessionId: 'mh2:s' + ci, requestId: userId + ':c' + k,
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
    if (Number(qa.category) !== 1) continue;
    const golds = (qa.evidence || []).filter((e) => typeof e === 'string');
    if (!golds.length) continue;
    const q = qa.question;
    const goldDias = new Set(golds);

    const lists = [
      ['bm25', bm25Door(idx, q)],
      ['literal', literalDoor(idx, q)],
      ['entity', entityDoor(idx, q)],
      ['date', dateDoor(idx, q) || []],
    ];
    const base = rrfFuse(lists, undefined, DOOR_WEIGHTS);
    const seeds = base.slice(0, 5).map((r) => r.id);
    const nb = neighborDoor(idx, seeds);
    const fusedRows = nb.length ? rrfFuse([...lists, ['neighbor', nb]], undefined, DOOR_WEIGHTS) : base;
    const fusedItems = pack(fusedRows, idx, { topK: 100, budgetTokens: Number.MAX_SAFE_INTEGER });
    const fusedDias = new Set(fusedItems.map((it) => seqToDia.get(idx.byId.get(it.id).seq)));
    const missing = [...goldDias].filter((d) => !fusedDias.has(d));
    if (!missing.length) continue;
    if (missing.length === 1) oneMiss.n += 1;

    for (const d of missing) {
      const ids = diaToIds.get(d) || [];
      if (!ids.length) continue;
      missTotal += 1;
      let bestFused = Infinity;
      let bestDoor = null;
      let bestDoorRank = Infinity;
      for (const id of ids) {
        const r = rankIn(fusedRows, id);
        if (r < bestFused) bestFused = r;
        for (const [name, list] of lists) {
          const ri = rankIn(list, id);
          if (ri < bestDoorRank) { bestDoorRank = ri; bestDoor = name; }
        }
      }
      if (bestDoor === null || bestDoorRank === Infinity) continue;
      doorStats[bestDoor].hit += 1;
      if (bestDoorRank <= 100) doorStats[bestDoor].hitTop100 += 1;
      if (bestDoorRank <= 10) doorStats[bestDoor].hitTop10 += 1;
      const bd = bucketOf(bestDoorRank);
      const bf = bucketOf(bestFused);
      missBuckets.bestDoor[bd] = (missBuckets.bestDoor[bd] || 0) + 1;
      missBuckets.fusedOfNoFused[bf] = (missBuckets.fusedOfNoFused[bf] || 0) + 1;
      if (bestDoorRank <= 10) missBuckets.fusedGivenTopDoor[bf] = (missBuckets.fusedGivenTopDoor[bf] || 0) + 1;
      bestDoorOf[bestDoor] = (bestDoorOf[bestDoor] || 0) + 1;
      if (missing.length === 1) {
        oneMiss.door[bestDoor] = (oneMiss.door[bestDoor] || 0) + 1;
        oneMiss.bucket[bd] = (oneMiss.bucket[bd] || 0) + 1;
      }
    }
  }
}

console.log(`缺失且在库的证据 ${missTotal} 条（多跳题）`);
console.log('');
console.log('【它们是被哪扇门召回的（单门最佳）】');
for (const [name, s] of Object.entries(doorStats)) {
  if (!s.hit) continue;
  console.log(`  ${name.padEnd(8)} 召回 ${s.hit} 条；其中单门 <=100 名 ${s.hitTop100}，<=10 名 ${s.hitTop10}`);
}
console.log('');
console.log('【这些证据在最佳单门里的名次】');
for (const b of ['<=10', '11-50', '51-100', '101-200', '201-500', '>500']) {
  console.log(`  ${b.padEnd(8)} ${missBuckets.bestDoor[b] || 0}`);
}
console.log('');
console.log('【这些证据在融合榜（不截断）里的名次】');
for (const b of ['<=10', '11-50', '51-100', '101-200', '201-500', '>500']) {
  console.log(`  ${b.padEnd(8)} ${missBuckets.fusedOfNoFused[b] || 0}`);
}
console.log('');
console.log('【重点：最佳单门 <=10 名的证据，融合之后掉到哪】');
for (const b of ['<=10', '11-50', '51-100', '101-200', '201-500', '>500']) {
  const n = missBuckets.fusedGivenTopDoor[b] || 0;
  if (n) console.log(`  融合 ${b.padEnd(8)} ${n}`);
}
console.log('');
console.log(`【缺 1 条的题：${oneMiss.n} 题】`);
for (const [name, n] of Object.entries(oneMiss.door)) console.log(`  那条由 ${name} 召回：${n} 题`);
for (const b of ['<=10', '11-50', '51-100', '101-200', '201-500', '>500']) {
  const n = oneMiss.bucket[b] || 0;
  if (n) console.log(`  它单门名次 ${b.padEnd(8)}：${n} 题`);
}

fs.rmSync(tmp, { recursive: true, force: true });
