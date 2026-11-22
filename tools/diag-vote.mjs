// 鱼知 · 交叉验证：五扇门的一致程度能不能当信号
// 三个问题：①排第 1 的那条，几条门同意它在前十？同意越多是不是越准？
//          ②把「同意数」放进排序（CombMNZ / 先票后分），比现在的 RRF 好还是坏？
//          ③前 5 段调、后 5 段验。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addMessages, readUser } from '../src/store.mjs';
import { buildIndex, search, bm25Door, literalDoor, entityDoor, dateDoor, rrfFuse } from '../src/recall.mjs';
import { conversationMessages, chunks } from '../src/replay.mjs';

const raw = JSON.parse(fs.readFileSync(process.argv[2] || 'data/locomo10.json', 'utf8'));
const data = Array.isArray(raw) ? raw : [raw];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yuzhi-vote-'));
const VOTE_K = 10;

const rows = [];
let ci = -1;
for (const conv of data) {
  ci += 1;
  const userId = 'v:conv-' + ci;
  const sessionId = 'v:s' + ci;
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
    const goldIds = new Set();
    for (const g of golds) for (const id of diaToIds.get(g) || []) goldIds.add(id);
    if (!goldIds.size) continue;
    const q = qa.question;

    const doors = [
      ['bm25', bm25Door(idx, q)],
      ['literal', literalDoor(idx, q)],
      ['date', dateDoor(idx, q) || []],
      ['entity', entityDoor(idx, q)],
    ];

    // 每扇门：候选名次 + 前 K 张票
    const rankOf = new Map();
    const votes = new Map();
    for (const [name, list] of doors) {
      list.forEach((r, i) => {
        if (!rankOf.has(r.id)) rankOf.set(r.id, new Map());
        rankOf.get(r.id).set(name, i + 1);
        if (i < VOTE_K) votes.set(r.id, (votes.get(r.id) || 0) + 1);
      });
    }

    const rrf = rrfFuse(doors.map(([n, l]) => [n, l]), undefined, { entity: 0.2 });
    const baseScore = new Map(rrf.map((r) => [r.id, r.score]));

    const voteOf = (id) => votes.get(id) || 0;
    const bestRank = (id) => {
      let b = Infinity;
      for (const v of (rankOf.get(id) || new Map()).values()) b = Math.min(b, v);
      return b;
    };

    const order = (cmp) => [...rankOf.keys()].sort(cmp);
    const rankIn = (list, set) => {
      let b = Infinity;
      list.forEach((id, i) => { if (set.has(id) && i + 1 < b) b = i + 1; });
      return b;
    };

    // 方案 1：现在（RRF，含邻居门）—— 直接问 search()
    const cur = search(idx, q, { topK: 1000000, budgetTokens: Number.MAX_SAFE_INTEGER }).data.map((x) => x.id);

    // 方案 2：CombMNZ —— RRF 分数 × 同意它的门数
    const mnz = order((a, b) => (baseScore.get(b) || 0) * voteOf(b) - (baseScore.get(a) || 0) * voteOf(a));

    // 方案 3：先看票数，再比分数
    const voteFirst = order((a, b) => voteOf(b) - voteOf(a) || (baseScore.get(b) || 0) - (baseScore.get(a) || 0));

    // 方案 4：按门可靠性加权（字面>bm25>时间>说话人）
    const relWeighted = rrfFuse(doors.map(([n, l]) => [n, l]), undefined, { literal: 1.6, bm25: 1.0, date: 0.5, entity: 0.2 });

    // 方案 5：只留两门以上同意的，再按 RRF 排（不够就退回全量）
    const cons = order((a, b) => voteOf(b) - voteOf(a)).filter((id) => voteOf(id) >= 2)
      .sort((a, b) => (baseScore.get(b) || 0) - (baseScore.get(a) || 0));

    // 方案 6：任一门的最高名次（单门最好），RRF 做决胜
    const bestDoor = order((a, b) => bestRank(a) - bestRank(b) || (baseScore.get(b) || 0) - (baseScore.get(a) || 0));

    // 方案 7：CombMNZ 但票只算前 3
    const v3 = new Map();
    for (const [, list] of doors) list.forEach((r, i) => { if (i < 3) v3.set(r.id, (v3.get(r.id) || 0) + 1); });
    const mnz3 = order((a, b) => (baseScore.get(b) || 0) * (v3.get(b) || 0) - (baseScore.get(a) || 0) * (v3.get(a) || 0));

    rows.push({
      dev: ci < 5,
      cur: rankIn(cur, goldIds),
      rrf: rankIn(rrf.map((r) => r.id), goldIds),
      mnz: rankIn(mnz, goldIds),
      voteFirst: rankIn(voteFirst, goldIds),
      relW: rankIn(relWeighted.map((r) => r.id), goldIds),
      cons: rankIn(cons, goldIds),
      bestDoor: rankIn(bestDoor, goldIds),
      mnz3: rankIn(mnz3, goldIds),
      topVotes: voteOf(rrf.length ? rrf[0].id : ''),
      topGoldVotes: goldIds.size ? Math.max(...[...goldIds].map((id) => voteOf(id))) : 0,
    });
  }
}

const p = (k) => (xs) => ((xs.filter((x) => x > 0 && x <= k).length / Math.max(xs.length, 1)) * 100).toFixed(1);

// ① 一致性是不是信号：按「金标拿到多少票」分组，看它排第 1 的比例
console.log('\n【金标集齐几票（前 10 张），以及它在各票数档里排第 1 的比例】');
const byVote = new Map();
for (const r of rows) {
  if (r.topGoldVotes === 0) continue;
  if (!byVote.has(r.topGoldVotes)) byVote.set(r.topGoldVotes, []);
  byVote.get(r.topGoldVotes).push(r.mnz);
}
for (const [v, xs] of [...byVote].sort((a, b) => a[0] - b[0])) {
  console.log('  金标得 ' + v + ' 票：' + String(xs.length).padStart(5) + ' 题，排第 1 ' + p(1)(xs) + '%');
}
const zeroVote = rows.filter((r) => r.topGoldVotes === 0).length;
console.log('  金标一张票都没有：' + zeroVote + ' 题（这些题交叉验证救不了）');

const V = [['现在 RRF+邻居', 'cur'], ['RRF（无邻居）', 'rrf'], ['CombMNZ', 'mnz'], ['先票后分', 'voteFirst'], ['按门可靠性加权', 'relW'], ['只留两票以上', 'cons'], ['单门最好名次', 'bestDoor'], ['CombMNZ 票只算前3', 'mnz3']];
for (const [tag, sel] of [['开发集', (r) => r.dev], ['验证集', (r) => !r.dev], ['全部', () => true]]) {
  const xs = rows.filter(sel);
  console.log('\n【' + tag + '】' + xs.length + ' 题   前1 / 前5 / 前10');
  for (const [label, k] of V) {
    const v = xs.map((r) => r[k]);
    console.log('  ' + label.padEnd(18) + p(1)(v).padStart(5) + '  ' + p(5)(v).padStart(5) + '  ' + p(10)(v).padStart(5));
  }
}
fs.rmSync(tmp, { recursive: true, force: true });
