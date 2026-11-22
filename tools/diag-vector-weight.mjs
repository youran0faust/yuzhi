// 鱼知 · 向量门权重 × 前后两半
// 全量已量出（vec 权重 1）：多跳 all@100 33.0→38.7，全表 all@100 79.0→80.5，any@10 -0.5。
// 这里再问两个问题：①前 5 段 / 后 5 段方向一致吗；②把向量门降到 0.5/0.3，能不能保住 any@10、留住多跳。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addMessages, readUser } from '../src/store.mjs';
import { buildIndex, bm25Door, literalDoor, entityDoor, dateDoor, vectorDoor, rrfFuse, neighborDoor, pack, DOOR_WEIGHTS } from '../src/recall.mjs';
import { makeHttpEmbedder } from '../src/embedding.mjs';
import { conversationMessages, chunks } from '../src/replay.mjs';

const argv = process.argv.slice(2);
const dataPath = argv.find((a) => !a.startsWith('--')) || 'data/locomo10.json';
const convLimit = Number((argv.find((a) => a.startsWith('--convos=')) || '').split('=')[1] || 0) || Infinity;
const baseIdx = argv.findIndex((a) => a.startsWith('--base='));
const EMB_BASE = baseIdx >= 0 ? argv[baseIdx].split('=')[1] : 'http://127.0.0.1:8898/v1';
const PREFIX = '为这个句子生成表示以用于检索相关文章：';

const raw = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
const data = (Array.isArray(raw) ? raw : [raw]).slice(0, convLimit);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yuzhi-vw-'));
const embedder = makeHttpEmbedder({ baseUrl: EMB_BASE, model: 'bge-small-zh', batchSize: 32, queryPrefix: PREFIX });

const VARIANTS = [
  ['base', null],
  ['vec1', 1], ['vec05', 0.5], ['vec03', 0.3], ['vec02', 0.2],
];
// half: dev = conv 0-4, test = conv 5-9
const acc = new Map(VARIANTS.map(([name]) => [name, { dev: new Map(), test: new Map(), all: new Map() }]));
function getA(name, half, cat) {
  const m = acc.get(name)[half];
  if (!m.has(cat)) m.set(cat, { q: 0, any10: 0, any100: 0, all100: 0 });
  return m.get(cat);
}

let ci = -1;
for (const conv of data) {
  ci += 1;
  const userId = 'vw:conv-' + ci;
  const msgs = conversationMessages(conv);
  const seqToDia = new Map(msgs.map((m, i) => [i + 1, m.dia_id]));
  const chs = chunks(msgs);
  for (let k = 0; k < chs.length; k += 1) {
    addMessages({ dir: tmp, userId, sessionId: 'vw:s' + ci, requestId: userId + ':c' + k,
      messages: chs[k].map((m) => ({ role: m.role, content: m.content, timestamp: m.timestamp })) });
  }
  const segs = readUser(tmp, userId).segs;
  const vecOut = await embedder.embed(segs.map((s) => s.text));
  const vecs = new Map(segs.map((s, i) => [s.id, { v: vecOut[i] }]));
  const idx = buildIndex(segs);

  const qas = (conv.qa || []).filter((qa) => (qa.evidence || []).filter((e) => typeof e === 'string').length > 0);
  const qvecOut = await embedder.embedQuery(qas.map((qa) => qa.question));

  for (let qi = 0; qi < qas.length; qi += 1) {
    const qa = qas[qi];
    const golds = (qa.evidence || []).filter((e) => typeof e === 'string');
    const goldDias = new Set(golds);
    const cat = String(qa.category);
    const half = ci < 5 ? 'dev' : 'test';

    const baseLists = [
      ['bm25', bm25Door(idx, qa.question)],
      ['literal', literalDoor(idx, qa.question)],
      ['entity', entityDoor(idx, qa.question)],
      ['date', dateDoor(idx, qa.question) || []],
    ];
    const vd = vectorDoor(idx, qvecOut[qi], vecs);
    const vecList = vd.list || [];

    for (const [name, w] of VARIANTS) {
      const lists = w == null
        ? baseLists
        : [...baseLists, ['vector', vecList]];
      const weights = w == null ? DOOR_WEIGHTS : { ...DOOR_WEIGHTS, vector: w };
      const fused = rrfFuse(lists, undefined, weights);
      const seed = fused.slice(0, 5).map((r) => r.id);
      const nb = neighborDoor(idx, seed);
      const rows = nb.length ? rrfFuse([...lists, ['neighbor', nb]], undefined, weights) : fused;
      const items = pack(rows, idx, { topK: 100, budgetTokens: Number.MAX_SAFE_INTEGER });
      const gotDias = new Set(items.map((it) => seqToDia.get(idx.byId.get(it.id).seq)));
      const got10 = new Set(items.slice(0, 10).map((it) => seqToDia.get(idx.byId.get(it.id).seq)));
      for (const h of [half, 'all']) {
        const a = getA(name, h, cat);
        a.q += 1;
        if ([...goldDias].some((d) => got10.has(d))) a.any10 += 1;
        if ([...goldDias].some((d) => gotDias.has(d))) a.any100 += 1;
        if ([...goldDias].every((d) => gotDias.has(d))) a.all100 += 1;
      }
    }
  }
  console.log(`conv-${ci}: ${segs.length} 段 / ${qas.length} 题`);
}

const pct = (x, n) => ((x / n) * 100).toFixed(1) + '%';
function printHalf(name, halfName) {
  const m = acc.get(name)[halfName];
  for (const [cat, a] of [...m].sort((x, y) => x[0].localeCompare(y[0]))){
    if (cat !== '1' && cat !== '5') continue;
    console.log('  ' + name.padEnd(7) + halfName.padEnd(5) + ('cat' + cat).padEnd(6)
      + String(a.q).padStart(5) + pct(a.any10, a.q).padStart(8) + pct(a.all100, a.q).padStart(8));
  }
  let q = 0, a10 = 0, a100 = 0, all = 0;
  for (const a of m.values()) { q += a.q; a10 += a.any10; a100 += a.any100; all += a.all100; }
  console.log('  ' + name.padEnd(7) + halfName.padEnd(5) + '全表'.padEnd(6)
    + String(q).padStart(5) + pct(a10, q).padStart(8) + pct(a100, q).padStart(8) + pct(all, q).padStart(8));
}
console.log('\n  方案/半场   题型   题数  any@10   any@100  all@100');
for (const [name] of VARIANTS) { printHalf(name, 'dev'); printHalf(name, 'test'); }
