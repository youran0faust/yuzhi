// 鱼知 · 检索层
// 五扇门，各自独立打分，再用 RRF（k=60）融。为什么要分门：每一门错的方式不一样，
// 融合之后错法互相抵消一点；只有一门的时候，它一歪就全歪。
//
//   1) bm25      词面相似（中文用二元组，没有分词器就承认没有）
//   2) literal   字面守卫：问句里那段原话真的在库里出现过吗——精度极高，专治「看着像」
//   3) entity    实体/说话人：问句点了名，就优先给那个人的话
//   4) date      时间：问句里有日期/年/月，就按距离给分；问句没时间就不开这一门
//   5) vector    向量：本机没有 embedding 就如实标 skipped，不假装有
//
// 另有一门 neighbor（邻居）：命中段的同会话前后各一段，低权重带上。
// 这不是为了提精度，是为了让「一段话被切断」的地方还能读通。
import {
  tokenize, countTokens, extractNames, parseDateQuery, dateProximity,
  dateHeader, createdAtValue,
} from './text.mjs';
import { cosine } from './embedding.mjs';

export const RRF_K = 60;
// 新名先认、旧名兜底（未结 → 鱼知的改名，旧脚本照旧能跑）
const pickEnv = (name) => process.env['YUZHI_' + name] ?? process.env['UNCLOSED_' + name];
export const DEFAULT_BUDGET_TOKENS = Number(pickEnv('BUDGET_TOKENS') || 60000);
export const DEFAULT_TOP_K = Number(pickEnv('TOP_K') || 100);

export function buildIndex(segs) {
  const df = new Map();
  const tf = new Map();
  let totalLen = 0;
  const byId = new Map();
  const bySession = new Map();
  const speakers = new Set();
  for (const s of segs) {
    byId.set(s.id, s);
    if (!bySession.has(s.session_id)) bySession.set(s.session_id, []);
    bySession.get(s.session_id).push(s);
    if (s.speaker) speakers.add(s.speaker);
    const toks = tokenize(`${s.text}`);
    tf.set(s.id, toks);
    totalLen += toks.length;
    for (const t of new Set(toks)) df.set(t, (df.get(t) || 0) + 1);
  }
  for (const arr of bySession.values()) arr.sort((a, b) => a.seq - b.seq || a.part - b.part);
  const n = Math.max(segs.length, 1);
  const idf = new Map();
  for (const [t, d] of df) idf.set(t, Math.log(1 + (n - d + 0.5) / (d + 0.5)));
  return { segs, n, df, idf, tf, avgdl: totalLen / n, byId, bySession, speakers };
}

// —— 门 1：BM25 ——
export const BM25_K1 = 1.5;
export const BM25_B = 0.75;

export function bm25Door(idx, query) {
  const qt = [...new Set(tokenize(query))].filter((t) => idx.idf.has(t));
  if (!qt.length) return [];
  const scored = [];
  for (const s of idx.segs) {
    const toks = idx.tf.get(s.id);
    if (!toks || !toks.length) continue;
    const counts = new Map();
    for (const t of toks) counts.set(t, (counts.get(t) || 0) + 1);
    let score = 0;
    for (const t of qt) {
      const f = counts.get(t) || 0;
      if (!f) continue;
      const denom = f + BM25_K1 * (1 - BM25_B + (BM25_B * toks.length) / idx.avgdl);
      score += (idx.idf.get(t) * f * (BM25_K1 + 1)) / denom;
    }
    if (score > 0) scored.push({ id: s.id, score });
  }
  return scored.sort((a, b) => b.score - a.score);
}

// —— 门 2：字面守卫 ——
// 把问句切成「可能有实义」的片段，从长到短试它有没有原样出现在哪一段里。
// 命中长度越长，越不可能是巧合。
export function queryChunks(q) {
  const out = [];
  for (const m of q.toLowerCase().matchAll(/[a-z0-9]{3,}/g)) out.push(m[0]);
  for (const m of q.matchAll(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]{2,}/g)) {
    const run = m[0];
    for (let len = Math.min(run.length, 6); len >= 2; len -= 1) {
      for (let i = 0; i + len <= run.length; i += 1) out.push(run.slice(i, i + len));
    }
  }
  return [...new Set(out)];
}

// 片段出现在「多少段」以上就不算证据了。0.5 是保守值：一半以上的段都包含它，
// 命中它说明不了任何事（英文里是 the/to/and，中文里是「我们」「这个」）。
export const LITERAL_DF_CUTOFF = 0.5;
// 段数太少时不启用这条过滤：两段里出现一次的片段，「占一半」没有意义。
const LITERAL_DF_MIN_SEGS = 10;

// 2026-11-21 改：原来命中多少字符就按多少字符算，于是 the/to/and 和 Caroline 同权。
// 拿 LoCoMo 量出来是这样：字面门单独排第 1 占 33%，融合之后掉到 17%——因为满篇的虚词
// 给了一大堆段相近的分。现在权重按「这个词有多稀有」给，虚词在 50% 以上的段里出现，直接不计。
export function literalDoor(idx, query) {
  const chunks = queryChunks(query);
  if (!chunks.length) return [];
  const df = new Map();
  for (const c of chunks) df.set(c, 0);
  for (const s of idx.segs) {
    const low = s.text.toLowerCase();
    for (const c of chunks) if (low.includes(c)) df.set(c, df.get(c) + 1);
  }
  const useDf = idx.n >= LITERAL_DF_MIN_SEGS;
  const keep = chunks.filter((c) => !useDf || df.get(c) < idx.n * LITERAL_DF_CUTOFF);
  if (!keep.length) return [];
  let total = 0;
  const weight = new Map();
  for (const c of keep) {
    // 越稀有越重；乘长度是因为长片段更像「原话」，短片段更容易碰巧命中
    const w = Math.log(1 + idx.n / (df.get(c) + 1)) * c.length;
    weight.set(c, w);
    total += w;
  }
  const out = [];
  for (const s of idx.segs) {
    const low = s.text.toLowerCase();
    let hit = 0;
    for (const c of keep) if (low.includes(c)) hit += weight.get(c);
    if (hit > 0) out.push({ id: s.id, score: hit / total });
  }
  return out.sort((a, b) => b.score - a.score);
}

// —— 门 3：实体 / 说话人 ——
export function entityDoor(idx, query) {
  const wanted = new Set(extractNames(query));
  for (const sp of idx.speakers) if (query.includes(sp)) wanted.add(sp);
  if (!wanted.size) return [];
  const scored = [];
  for (const s of idx.segs) {
    let score = 0;
    if (s.speaker && wanted.has(s.speaker)) score += 2;
    for (const nm of s.names || []) if (wanted.has(nm)) score += 1;
    if (score > 0) scored.push({ id: s.id, score });
  }
  return scored.sort((a, b) => b.score - a.score);
}

// —— 门 4：时间 ——
export function dateDoor(idx, query) {
  const want = parseDateQuery(query);
  if (!want) return null; // null＝这门没开，不是「开了没得分」
  const scored = [];
  for (const s of idx.segs) {
    const p = dateProximity(s.ts, want);
    if (p !== null) scored.push({ id: s.id, score: p });
  }
  return scored.sort((a, b) => b.score - a.score);
}

// —— 门 5：向量 ——
// 接口是通的：调用方把 query 向量和段向量递进来，这门就真算余弦、真参与融合。
// 缺哪一样就如实标 skipped 并说清：模型没配 / 段没算 / query 没算——三种要分开，
// 不然「没开」和「开了但坏了」永远分不清。这一门补的是「换了个说法」：
// BM25 和字面门都要求字面重合，换个词就摸不到。
export function vectorDoor(idx, queryVec, vecs) {
  if (!queryVec || !queryVec.length) {
    return { skipped: true, reason: 'query vector 没给（配 YUZHI_EMBED_URL 后由 server 算（旧名 UNCLOSED_EMBED_URL 也认））' };
  }
  if (!vecs || !vecs.size) {
    return { skipped: true, reason: '库里还没有段向量（先跑 node src/embed.mjs --user <id>）' };
  }
  const scored = [];
  let dimMismatch = 0;
  for (const s of idx.segs) {
    const rec = vecs.get(s.id);
    if (!rec || !rec.v || !rec.v.length) continue;
    if (rec.v.length !== queryVec.length) {
      dimMismatch += 1;
      continue;
    }
    const sim = cosine(queryVec, rec.v);
    if (sim > 0) scored.push({ id: s.id, score: sim });
  }
  scored.sort((a, b) => b.score - a.score);
  const out = { list: scored };
  if (dimMismatch) out.dimMismatch = dimMismatch;
  return out;
}

// —— 门 6：邻居 ——
// 一个邻居会被好几个 seed 同时指到（实测 #9.1 一次拿到 3 票）。RRF 里那就是刷票：
// 得票多的不是最相关的，是邻居最多的。所以一条邻里只算一次，位置按第一次被指到算。
//
// 深度定 2（原来 1）。2026-11-21 量过：多跳题的证据常常隔一句以上，±1 够不着。
// 前 5 段调、后 5 段验，两半一致：
//   all@100   79.0→80.3 / 76.5→78.0（多跳 37.6→37.6 / 26.4→28.6）
//   ±3 只再多 0.2 个点，±5 在验证集上反而回落——取 2 就是够了，不往宽了堆。
export const NEIGHBOR_DEPTH = 2;

export function neighborDoor(idx, hitIds, depth = NEIGHBOR_DEPTH) {
  const seen = new Set();
  const out = [];
  for (const id of hitIds) {
    const s = idx.byId.get(id);
    if (!s) continue;
    for (let d = 1; d <= depth; d += 1) {
      for (const off of [-d, d]) {
        const target = (idx.bySession.get(s.session_id) || []).find((x) => x.seq === s.seq + off && x.part === 1);
        if (!target || seen.has(target.id)) continue;
        seen.add(target.id);
        out.push({ id: target.id, score: 1 / (1 + d) });
      }
    }
  }
  return out;
}

// weights：按门加权。默认 1（每扇门平权），只有两扇该降：
//   neighbor 挨着不等于相关，它是补漏的，不该跟正门投同样重的票。2026-11-21 实测：平权时它能把 top-1 顶掉。
//   entity   说话人门只认「这是谁说的话」，同一话题里那个人说的每一句都同分——它给出来的是一张
//            按语料顺序排的平表，不是排行榜。RRF 把平表的第一行当成「它最看好这一条」，
//            于是随便一句本人说的话就能压过字面完全命中的那一句。
//            2026-11-21 拿 LoCoMo 量：只有 bm25+literal+date 时排第 1 占 32.8%，
//            把 entity 平权加进去掉到 13.3%；降到 0.2 回到 33.8%、前 10 还高 2.7 个点。
//            所以它只许轻推，不许投票。
//   vector   语义门补召回、不补排序：它把「换了个说法」的证据捞进来，也把「看起来像、实际没发生」
//            的句子捞进来。2026-11-21 全量回放（bge-small-zh int8 跑英文 LoCoMo）：
//            权重 1 时多跳 all@100 33.0→38.7、全表 all@100 79.0→80.5（两半都涨），
//            但全表 any@10 70.5→70.0、对抗题 any@10 -2.2；
//            降到 0.5 时多跳 all@100 两半都 +2.8、全表 any@10 两半都不掉。
//            两半不一致的收益不许要，所以取 0.5。
//   ★ 2026-11-21 中文 CMB 714 题全量复测推翻了「0.5 最好」：0.5→1.0→1.2 单调涨，
//     1.5 起开始出现新增倒退，2.0 起崩（弄坏 3→12）。1.2 在前后两半都优于 0.5
//     （全在 +6/+3，修好 +6/+3，没有新增弄坏的题），取 1.2。
//     两个数据集结论不同：英文 LoCoMo 上 1.0 有掉点，中文 CMB 上 1.2 两半一致——
//     LoCoMo 那半要重测，本文件这行数字只算中文侧的。
//     另：fill 模式（向量只补正门没指到的段）实测全在只有 574，远低于平票融合——
//     向量真正有用的是「给已经命中但排名很后的段落抬一把」，不是只捞全新的段。
export const DOOR_WEIGHTS = { neighbor: 0.5, entity: 0.2, vector: 1.2 };

// weights：按门加权。默认 1（每扇门平权），只有 neighbor 该降——挨着不等于相关，
// 邻居门是补漏的，不该跟正门投同样重的票。2026-11-21 实测：平权时它能把 top-1 顶掉。
export function rrfFuse(lists, k = RRF_K, weights = null) {
  const fused = new Map();
  const why = new Map();
  for (const [name, list] of lists) {
    const w = weights && weights[name] !== undefined ? weights[name] : 1;
    list.forEach((row, i) => {
      const prev = fused.get(row.id) || 0;
      fused.set(row.id, prev + w / (k + i + 1));
      if (!why.has(row.id)) why.set(row.id, []);
      why.get(row.id).push(`${name}@${i + 1}`);
    });
  }
  return [...fused]
    .map(([id, score]) => ({ id, score, why: why.get(id) || [] }))
    .sort((a, b) => b.score - a.score);
}

// 拼成给人/给模型看的内容。日期 + 说话人 + 原文，整段给，绝不截断。
export function renderContent(seg) {
  const head = dateHeader(seg.ts, seg.granularity, seg.session_id);
  const who = seg.speaker || seg.role;
  const suffix = seg.total > 1 ? ` (part ${seg.part}/${seg.total})` : '';
  // 原文自己带「Alice: 」前缀时先剥掉再拼——不然会变成「Alice: Alice: ...」。
  // 剥掉的只是排版前缀，正文一字不动地跟在后面。
  let body = seg.text;
  if (seg.speaker && body.startsWith(`${seg.speaker}:`)) body = body.slice(seg.speaker.length + 1).replace(/^\s+/, '');
  return `${head} ${who}:${suffix} ${body}`;
}

// —— 交叉验证：几扇门各自独立指到同一段 ——
// 2026-11-21 拿 LoCoMo 量过：金标在前 10 里集齐 1 票时，它排第 1 的概率只有 0.3%；
// 集齐 2 票 50.4%；集齐 3 票 87.6%。一致程度是很强的信号。
// 但它不能拿进排序：试过六种（CombMNZ、先票后分、可靠性加权、只留两票……），
// 前 1/前 5/前 10 都比现在的 RRF 差——「只留两票以上」直接把前 10 从 70% 砍到 57%，
// 因为有 28% 的题金标一张票都拿不到（压在短尾里），门槛一设就等于把它们扔了。
// 所以它的位置是「信心」，不是「名次」：排序照旧，每条结果多带一个数，
// 让读的人知道这一段是几扇门同时指向它，还是一扇门孤零零地指了一下。
export const AGREEMENT_K = 10;

// 算票：每扇门的前 K 条，同一条被几扇门指到算几票。
// 邻居门不进这张票——它只是「挨着命中段」，不是独立证人。
export function doorVotes(lists, k = AGREEMENT_K) {
  const votes = new Map();
  for (const [, list] of lists) {
    for (const r of list.slice(0, k)) votes.set(r.id, (votes.get(r.id) || 0) + 1);
  }
  return votes;
}

// 票数怎么叫。刻意不用 strong / weak 这类词：量过——标三票的那条，真金标只占 28.5%
// （随机返回一条是 7.6%，高 3.7 倍）；说它「强」是在替测量下不该下的结论。
// 这里只描述「发生了几次独立指向」，有多少分量由读的人自己掂。
export function agreementLevel(votes) {
  if (votes >= 3) return 'multi';
  if (votes === 2) return 'pair';
  if (votes === 1) return 'single';
  return 'none';
}

export function pack(rows, idx, {
  topK = DEFAULT_TOP_K, budgetTokens = DEFAULT_BUDGET_TOKENS, votes = null, witnesses = 0,
} = {}) {
  const out = [];
  let used = 0;
  for (const row of rows) {
    if (out.length >= topK) break;
    const seg = idx.byId.get(row.id);
    if (!seg) continue;
    const content = renderContent(seg);
    const t = countTokens(content);
    if (used + t > budgetTokens) continue; // 整条跳过，绝不截断
    const item = { id: seg.id, content, text: content, score: Number(row.score.toFixed(6)) };
    if (votes) {
      const n = votes.get(seg.id) || 0;
      item.agreement = n;
      item.witnesses = witnesses;
      item.agreement_level = agreementLevel(n);
    }
    const ca = createdAtValue(seg.ts, seg.granularity);
    if (ca) item.created_at = ca;
    if (row.why) item.why = row.why.slice(0, 4);
    out.push(item);
    used += t;
  }
  return out;
}

// —— 悬案层：把「还没闭合的事」挂到检索结果上 ——
// 这不是排序加分（没证据的不许挤掉有证据的），是另一栏：原话归原话，悬着的事归悬着的事。
const STOP_TOKENS = new Set(['什么', '怎么', '为什么', '哪个', '如何', '是否', '吗', '呢', '的', '了', '是', '和', '在', '有', '我', '你', '他', '她', '它', '这', '那', 'the', 'a', 'an', 'is', 'are', 'was', 'were', 'what', 'when', 'where', 'why', 'how', 'did', 'do', 'does', 'and', 'or', 'of', 'to', 'in', 'on']);

export function contentTokens(text) {
  return tokenize(text || '').filter((t) => !STOP_TOKENS.has(t));
}

export function caseHooks(query, cases, { minShared = 2, minRatio = 0.12, quietShared = 3, quietRatio = 0.2 } = {}) {
  const q = new Set(contentTokens(query));
  if (!q.size) return [];
  const hits = [];
  for (const c of cases || []) {
    const state = c.state || 'unresolved';
    // 闭合的不再挂（resolved 真解决了，dissolved 前提没了）。
    // 搁下过的（abandoned）照样进得来，只是门槛更高——降级是静音，不是删除。
    if (state === 'resolved' || state === 'dissolved') continue;
    const needShared = state === 'abandoned' ? quietShared : minShared;
    const needRatio = state === 'abandoned' ? quietRatio : minRatio;
    const cText = `${c.q || ''} ${(c.subjects || []).join(' ')}`;
    const ct = new Set(contentTokens(cText));
    if (!ct.size) continue;
    let shared = 0;
    for (const t of q) if (ct.has(t)) shared += 1;
    const ratio = shared / Math.min(q.size, ct.size);
    if (shared >= needShared && ratio >= needRatio) {
      hits.push({ id: c.id, q: c.q, state: c.state || 'unresolved', shared, ratio: Number(ratio.toFixed(3)) });
    }
  }
  // 还挂着的排在前面；同为搁下过的再按贴近程度排——静音的不抢还在响的。
  const rank = (h) => (h.state === 'abandoned' ? 1 : 0);
  return hits.sort((a, b) => rank(a) - rank(b) || b.ratio - a.ratio || b.shared - a.shared);
}

// 主入口。返回 {data, meta}
export function search(index, query, {
  topK = DEFAULT_TOP_K, budgetTokens = DEFAULT_BUDGET_TOKENS, options = null, cases = null,
  queryVec = null, vecs = null,
  // 向量门的两种用法：
  //   false（默认）＝和正门平票参与融合，权重见 DOOR_WEIGHTS.vector。
  //   true＝只补位：正门已经指到的段，向量一律不再投票（不给它加权、也不让它挤掉字面命中），
  //        它只贡献「正门一门都没指到」的段，最多前 vecFillTop 条。
  vecFillOnly = false, vecFillTop = 64,
  // 二次触发（2026-11-21 CMB 714 题实测出来的第三种用法）：
  //   向量独有段（字面一门没指到的）不直接进上下文，而是当「提醒」——
  //   拿这段自己的关键词再拼一次查询，让字面门重新走一遍，补位排在前 8 条之后。
  //   平票 1.2 前 8 条打底 + 补 8 条：全在 605→636、没有 31→12、坏 0 题。
  //   2026-11-21 定的：默认开（多花一点上下文无所谓），0 才关。
  triggerFill = 8, triggerSeeds = 8, triggerTopK = 16, triggerTerms = 4,
  // 回查用哪套门。2026-11-21 实测（240 题，同一个补满 8 的循环）：
  //   只走 bm25＝217，全套字面门（bm25+literal+entity+date 融合）＝221。
  //   「补满」才是大头（只查一次＝216），门是第二位；两个都要。
  triggerDoor = 'all',
  doorWeights = null, // 只给实验/调参用；不给就按 DOOR_WEIGHTS
} = {}) {
  const opts = Array.isArray(options) ? options : [];
  const q = String(query || '').trim();
  if (!q && !opts.length) {
    return { data: [], meta: { query: q, reason: 'empty query', doors: {}, skipped: [] } };
  }

  const lists = [];
  const meta = { query: q, doors: {}, skipped: [] };

  const bm = bm25Door(index, q);
  if (bm.length) lists.push(['bm25', bm]);
  meta.doors.bm25 = bm.length;

  const lit = literalDoor(index, q);
  if (lit.length) lists.push(['literal', lit]);
  meta.doors.literal = lit.length;

  const ent = entityDoor(index, q);
  if (ent.length) lists.push(['entity', ent]);
  meta.doors.entity = ent.length;

  const dat = dateDoor(index, q);
  if (dat === null) meta.skipped.push('date: 问句里认不出时间');
  else if (dat.length) lists.push(['date', dat]);
  meta.doors.date = dat === null ? null : dat.length;

  const vec = vectorDoor(index, queryVec, vecs);
  if (vec.skipped) {
    meta.skipped.push('vector: ' + vec.reason);
    meta.doors.vector = null;
  } else {
    let vlist = vec.list;
    if (vecFillOnly) {
      // 「只补位」：正门（bm25/literal/entity/date）已经指到的段，向量不许再投票。
      // 它只贡献正门一门都没指到的段——那才是「换个说法就搜不到」的那一类。
      const posIds = new Set();
      for (const [name, list] of lists) {
        if (name === 'vector') continue;
        for (const r of list) posIds.add(r.id);
      }
      vlist = vlist.filter((r) => !posIds.has(r.id)).slice(0, vecFillTop);
      meta.doors.vectorFill = vlist.length;
    }
    if (vlist.length) lists.push(['vector', vlist]);
    meta.doors.vector = vlist.length;
    if (vec.dimMismatch) meta.skipped.push('vector: ' + vec.dimMismatch + ' 段维度对不上，已跳过');
  }

  // 票在加邻居门之前算：邻居是「挨着命中段」，不是独立证人。
  const votes = doorVotes(lists);
  const witnesses = lists.length;

  const W = doorWeights ? { ...DOOR_WEIGHTS, ...doorWeights } : DOOR_WEIGHTS;
  const fused = rrfFuse(lists, undefined, W);
  const seed = new Set(fused.slice(0, 5).map((r) => r.id));
  const nb = neighborDoor(index, [...seed]);
  if (nb.length) {
    const fusedWithNb = rrfFuse([...lists, ['neighbor', nb]], undefined, W);
    meta.doors.neighbor = nb.length;
    return finish(fusedWithNb);
  }
  meta.doors.neighbor = 0;
  return finish(fused);

  function finish(rows) {
    let ordered = rows;
    if (triggerFill > 0 && queryVec && vecs && !vec.skipped) {
      // 二次触发：向量独有段只当「提醒」，不进上下文；拿它自己的词再查一遍字面门。
      const posIds = new Set();
      for (const [name, list] of lists) {
        if (name === 'vector' || name === 'neighbor') continue;
        for (const r of list) posIds.add(r.id);
      }
      const seeds = vec.list.filter((r) => !posIds.has(r.id)).slice(0, triggerSeeds);
      const picked = new Set();
      for (const s of seeds) {
        if (picked.size >= triggerFill) break;
        const seg = index.byId.get(s.id);
        if (!seg) continue;
        const terms = [...new Set(contentTokens(seg.text))].slice(0, triggerTerms);
        if (!terms.length) continue;
        const tq = `${q} ${terms.join(' ')}`;
        const list = triggerDoor === 'bm25'
          ? bm25Door(index, tq).slice(0, triggerTopK)
          : search(index, tq, { topK: triggerTopK, triggerFill: 0, budgetTokens: DEFAULT_BUDGET_TOKENS }).data;
        for (const r of list) {
          if (picked.size >= triggerFill) break;
          picked.add(r.id);
        }
      }
      // 前 triggerSeeds 条（底子）原样占位，补位一律排它们后面。
      const head = rows.slice(0, Math.min(rows.length, triggerSeeds));
      const headIds = new Set(head.map((r) => r.id));
      const add = [...picked].filter((id) => !headIds.has(id)).slice(0, triggerFill);
      ordered = [...head, ...add.map((id) => ({ id, score: 0, why: ['trigger'] }))];
      meta.doors.trigger = add.length;
    }
    const data = pack(ordered, index, { topK, budgetTokens, votes, witnesses });
    const hooks = cases ? caseHooks(q, cases) : [];
    return {
      data,
      meta: { ...meta, returned: data.length, witnesses, agreementK: AGREEMENT_K, open_questions: hooks },
    };
  }
}
