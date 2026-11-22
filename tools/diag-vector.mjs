// 鱼知 · 向量门全量回放（补「向量门在回放里没开」这一格）
// 预测（2026-11-21 12:22，先写再跑）：
//   P4 向量门在 all@100 上能有帮助，因为多跳题的第二三条证据常与问句无字面重合、
//      但语义相近（换了个说法）；它补的就是这块召回。
//   P5 但 any@10 会很轻甚至可能掉：bge-small 512 维的中文模型在英文对话上不是强项，
//      且 20 题诊断集上「补召回不补排序」已经量过。
//   反证：若多跳 all@100 涨不到 +1 个点 → 向量门对这张表的作用可以诚实地说「没量到收益」，
//         不能写「语义检索有用」。若 any@10 掉超过 1 个点 → 默认关它是对的。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addMessages, readUser } from '../src/store.mjs';
import { buildIndex, search } from '../src/recall.mjs';
import { makeHttpEmbedder } from '../src/embedding.mjs';
import { conversationMessages, chunks } from '../src/replay.mjs';

const argv = process.argv.slice(2);
const dataPath = argv.find((a) => !a.startsWith('--')) || 'data/locomo10.json';
const convLimit = Number((argv.find((a) => a.startsWith('--convos=')) || '').split('=')[1] || 0) || Infinity;
const base = argv.find((a) => a.startsWith('--base='));
const EMB_BASE = base ? base.split('=')[1] : 'http://127.0.0.1:8898/v1';
const PREFIX = '为这个句子生成表示以用于检索相关文章：';

const raw = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
const data = (Array.isArray(raw) ? raw : [raw]).slice(0, convLimit);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yuzhi-vec-'));

const embedder = makeHttpEmbedder({ baseUrl: EMB_BASE, model: 'bge-small-zh', batchSize: 32, queryPrefix: PREFIX });

const VARIANTS = ['base', 'vec'];
const CATS = new Map();
const acc = new Map(VARIANTS.map((v) => [v, new Map()]));
function getAcc(v, cat) {
  const m = acc.get(v);
  if (!m.has(cat)) m.set(cat, { q: 0, any10: 0, any100: 0, all100: 0, chars: 0 });
  return m.get(cat);
}

let ci = -1;
for (const conv of data) {
  ci += 1;
  const userId = 'vec:conv-' + ci;
  const msgs = conversationMessages(conv);
  const seqToDia = new Map(msgs.map((m, i) => [i + 1, m.dia_id]));
  const chs = chunks(msgs);
  for (let k = 0; k < chs.length; k += 1) {
    addMessages({ dir: tmp, userId, sessionId: 'vec:s' + ci, requestId: userId + ':c' + k,
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
    if (qa.qaCount === undefined) qa.qaCount = 0;
    const goldDias = new Set(golds);
    const cat = String(qa.category);

    for (const variant of VARIANTS) {
      const opts = { topK: 100, budgetTokens: Number.MAX_SAFE_INTEGER };
      if (variant === 'vec') { opts.queryVec = qvecOut[qi]; opts.vecs = vecs; }
      const res = search(idx, qa.question, opts);
      const items = res.data || [];
      const gotDias = new Set(items.map((it) => seqToDia.get(idx.byId.get(it.id).seq)));
      const got10 = new Set(items.slice(0, 10).map((it) => seqToDia.get(idx.byId.get(it.id).seq)));
      const a = getAcc(variant, cat);
      a.q += 1;
      if ([...goldDias].some((d) => got10.has(d))) a.any10 += 1;
      if ([...goldDias].some((d) => gotDias.has(d))) a.any100 += 1;
      if ([...goldDias].every((d) => gotDias.has(d))) a.all100 += 1;
      a.chars += items.reduce((x, it) => x + it.content.length, 0);
    }
  }
  console.log(`conv-${ci}: ${segs.length} 段 / ${qas.length} 题`);
}

const pct = (x, n) => ((x / n) * 100).toFixed(1) + '%';
console.log('');
console.log('  变体   题型       题数  any@10   any@100  all@100  平均字符');
for (const v of VARIANTS) {
  const m = acc.get(v);
  let totalQ = 0; const tot = { q: 0, any10: 0, any100: 0, all100: 0, chars: 0 };
  for (const [cat, a] of [...m].sort((x, y) => Number(x[0]) - Number(y[0]))) {
    totalQ += a.q;
    tot.any10 += a.any10; tot.any100 += a.any100; tot.all100 += a.all100; tot.chars += a.chars;
    console.log('  ' + v.padEnd(6) + ('cat' + cat).padEnd(8) + String(a.q).padStart(5)
      + pct(a.any10, a.q).padStart(8) + pct(a.any100, a.q).padStart(9) + pct(a.all100, a.q).padStart(8)
      + String(Math.round(a.chars / a.q)).padStart(10));
  }
  console.log('  ' + v.padEnd(6) + '全表     ' + String(totalQ).padStart(5)
    + pct(tot.any10, totalQ).padStart(8) + pct(tot.any100, totalQ).padStart(9) + pct(tot.all100, totalQ).padStart(8)
    + String(Math.round(tot.chars / totalQ)).padStart(10));
}
fs.rmSync(tmp, { recursive: true, force: true });
