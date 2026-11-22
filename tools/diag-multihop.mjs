// 鱼知 · 多跳题拆解
// 回答一件事：all@100 失败的多跳题，缺的那条证据卡在哪一层——
//   A 不在库（金标 dia_id 找不到段：数据格式/映射问题）
//   B 在库但任何门都没召回到（纯粹没摸到）
//   C 召回到了但融合名次在 100 外（排序问题）
//   D 融合在 100 内却没进结果（截断/预算问题；回放预算无限，理论上不该有）
//
// 只诊断，不改检索。用法：node tools/diag-multihop.mjs [data/locomo10.json] [--convos=N]
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yuzhi-mh-'));

const rankIn = (list, id) => {
  const i = list.findIndex((x) => x.id === id);
  return i < 0 ? Infinity : i + 1;
};

const stats = {
  questions: 0,
  allOk: 0,
  fail: 0,
  missNoSeg: 0,
  missNoDoor: 0,
  missRankOut: 0,
  missTruncated: 0,
  missCount: new Map(),
  failWithNoSeg: 0,
  failAllDoorsHit: 0,
  failAllInStore: 0,
};

let ci = -1;
for (const conv of data) {
  ci += 1;
  const userId = 'mh:conv-' + ci;
  const msgs = conversationMessages(conv);
  const seqToDia = new Map(msgs.map((m, i) => [i + 1, m.dia_id]));
  const diaToIds = new Map();
  const chs = chunks(msgs);
  for (let k = 0; k < chs.length; k += 1) {
    addMessages({ dir: tmp, userId, sessionId: 'mh:s' + ci, requestId: userId + ':c' + k,
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
    stats.questions += 1;
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

    if ([...goldDias].every((d) => fusedDias.has(d))) {
      stats.allOk += 1;
      continue;
    }
    stats.fail += 1;
    const missing = [...goldDias].filter((d) => !fusedDias.has(d));
    stats.missCount.set(missing.length, (stats.missCount.get(missing.length) || 0) + 1);

    let inStore = 0;
    for (const d of missing) {
      const ids = diaToIds.get(d) || [];
      if (!ids.length) {
        stats.missNoSeg += 1;
        continue;
      }
      inStore += 1;
      let bestFused = Infinity;
      let bestAnyDoor = Infinity;
      for (const id of ids) {
        const r = rankIn(fusedRows, id);
        if (r < bestFused) bestFused = r;
        for (const [, list] of lists) {
          const ri = rankIn(list, id);
          if (ri < bestAnyDoor) bestAnyDoor = ri;
        }
      }
      if (bestAnyDoor === Infinity) stats.missNoDoor += 1;
      else if (bestFused > 100) stats.missRankOut += 1;
      else stats.missTruncated += 1;
    }
    if (inStore === missing.length) stats.failAllInStore += 1;
    const hasNoSeg = missing.some((d) => !(diaToIds.get(d) || []).length);
    if (hasNoSeg) stats.failWithNoSeg += 1;
    const allDoorHit = missing.every((d) => {
      const ids = diaToIds.get(d) || [];
      return ids.length && ids.some((id) => lists.some(([, list]) => rankIn(list, id) !== Infinity));
    });
    if (allDoorHit) stats.failAllDoorsHit += 1;
  }
}

const pct = (x, n) => ((x / n) * 100).toFixed(1) + '%';
console.log(`多跳题 ${stats.questions} 题；all@100 通过 ${stats.allOk}（${pct(stats.allOk, stats.questions)}），失败 ${stats.fail}（${pct(stats.fail, stats.questions)}）`);
console.log('');
console.log('【失败题里，每条缺失证据卡在哪】');
const totalMiss = stats.missNoSeg + stats.missNoDoor + stats.missRankOut + stats.missTruncated;
console.log(`  缺失证据共 ${totalMiss} 条（${stats.fail} 题里）`);
console.log(`  A 不在库（金标 dia_id 没有对应段）  ${stats.missNoSeg} 条  ${pct(stats.missNoSeg, totalMiss)}`);
console.log(`  B 在库但任何门都没召回到          ${stats.missNoDoor} 条  ${pct(stats.missNoDoor, totalMiss)}`);
console.log(`  C 召回到了但融合名次 >100          ${stats.missRankOut} 条  ${pct(stats.missRankOut, totalMiss)}`);
console.log(`  D 融合 <=100 却没进结果            ${stats.missTruncated} 条  ${pct(stats.missTruncated, totalMiss)}`);
console.log('');
console.log('【失败题里，每题缺几条证据】');
for (const [k, n] of [...stats.missCount].sort((a, b) => a[0] - b[0])) console.log(`  缺 ${k} 条：${n} 题（${pct(n, stats.fail)}）`);
console.log('');
console.log('【失败题的三个整题标签（可重叠）】');
console.log(`  至少一条证据不在库        ${stats.failWithNoSeg} 题  ${pct(stats.failWithNoSeg, stats.fail)}`);
console.log(`  所有缺失证据至少一门召回  ${stats.failAllDoorsHit} 题  ${pct(stats.failAllDoorsHit, stats.fail)}`);
console.log(`  所有缺失证据都在库        ${stats.failAllInStore} 题  ${pct(stats.failAllInStore, stats.fail)}`);

fs.rmSync(tmp, { recursive: true, force: true });

