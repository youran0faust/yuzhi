// 鱼知 · 事件层（生产版）
//
// 这是 bench-cmb 里那套「三次触发」的第二、三步，从实验脚本搬进 src，服务里直接调：
//   门（不调模型、不查向量）→ 事件句 → 向量锚点 → 字面尾巴铺开 → 单独成块。
//
// 为什么分两种口径：
//   statement（调用方给事件句，通常是模型写的「以前发生过什么」）——bench 判分用的就是它；
//   probe（没有事件句时，拿问题原文当探针）——生产里不一定配得上模型，这条路不至于全哑。
//   两者产出同一种块，只是 meta.mode 不同；别把 probe 的覆盖数当 statement 的成绩。
//
// 一条硬边界：事件块是「提醒」，不是证据。它单独成块、不进主检索的 data，
// 也不参与 RRF 融合——门关掉的时候，检索结果必须和没有这一层时一模一样。
import { tokenize } from './text.mjs';
import { contentTokens, renderContent, search as recallSearch } from './recall.mjs';
import { cosine } from './embedding.mjs';

// 门用的泛词表：这些词在一段对话里到处都出现，拿它们当锚就是「每个轮次都算命中」。
const STOP = new Set(['什么','怎么','为什么','哪个','如何','是否','吗','呢','的','了','是','和','在','有','我','你','他','她','它','这','那','就','也','都','很','会','要','说','一个','不']);
// 同一轮里「彼此不重叠的命中段」≤1 → 没有锚；≥2 段才叫有落点。
// 为什么按「段」不按「词」：双字切词会重叠，「我全名」这一处就同时命中「我全」「全名」，
// 旧口径把一次连续出现算成两条命中，于是「只出现『我全名』」的轮被当成锚，门瞎了。
const MIN_SHARED = 1;

function coveredRuns(text, terms) {
  const len = text.length;
  if (!len) return 0;
  const cov = new Uint8Array(len);
  for (const term of terms) {
    if (!term) continue;
    let from = 0;
    while (true) {
      const i = text.indexOf(term, from);
      if (i < 0) break;
      for (let k = i; k < i + term.length && k < len; k++) cov[k] = 1;
      from = i + 1;
    }
  }
  let runs = 0;
  for (let i = 0; i < len; i++) if (cov[i] && (!i || !cov[i - 1])) runs++;
  return runs;
}

// 门只看问题 + 可见轮次：不调模型、不查向量、不看库。
export function gateSignal(question, visibleTexts = []) {
  const qt = [...new Set(tokenize(question || ''))].filter((t) => !STOP.has(t) && t.length > 1).slice(0, 8);
  const nm = visibleTexts.length;
  const df = new Map();
  for (const term of qt) {
    let c = 0;
    for (const v of visibleTexts) if (v.indexOf(term) >= 0) c++;
    df.set(term, c);
  }
  const generic = qt.filter((term) => nm > 0 && df.get(term) / nm > 0.2);
  const specific = qt.filter((term) => !generic.includes(term));
  let bestSpec = 0;
  let bestSpecText = null;
  for (const v of visibleTexts) {
    const runs = coveredRuns(v, specific);
    if (runs > bestSpec) { bestSpec = runs; bestSpecText = v; }
  }
  return { qTerms: qt, generic, specific, bestSpec, fire: bestSpec <= MIN_SHARED };
}

export const EVENT_DEFAULTS = {
  anchorsPer: 4,   // 每条事件句取几个锚点轮
  tailK: 8,        // 字面尾巴一次查几条
  neighbor: 1,     // 锚点前后各带一轮（事件常常跨几轮）
  take: 4,         // 一块最多几条
  probeTerms: 6,   // 从锚点原文里取几个词拼查询
  tailBudget: 4000,
  anchorHead: 3,   // 拿前几个锚点去拼字面尾巴
};

function toItems(visible) {
  if (!Array.isArray(visible)) return [];
  return visible.map((v, i) => (typeof v === 'string'
    ? { index: i, id: null, text: String(v), gateText: null }
    : {
      index: i,
      id: v && v.id != null ? String(v.id) : null,
      text: String((v && v.text) || ''),
      gateText: v && v.gateText != null ? String(v.gateText) : null,
    }));
}

function keyTerms(text) {
  return [...new Set(tokenize(text || ''))].filter((t) => !STOP.has(t) && t.length > 1).slice(0, 6);
}

// 主入口。返回 { fire, gate, mode, statements, picked, rows, meta }
// 关键：rows 是「单独一块」，不是拼进 data 的东西；调用方自己决定怎么呈现。
export async function eventRoute(index, question, {
  visible = [],
  statements = null,
  embed = null,
  embedQuery = null,
  excludeIds = [],
  cutoffId = null,
  options = {},
} = {}) {
  const opt = { ...EVENT_DEFAULTS, ...(options || {}) };
  // bge 这类模型 query 与 doc 不对称：query 加前缀、doc 不加。混着用余弦会整体抬高、排序会歪，
  // 所以两个口径分开传：事件句是「对可见轮次提问」（query），可见轮次是「被比对的段落」（doc）。
  const embedDoc = embed;
  const embedAsk = embedQuery || embed;
  const items = toItems(visible);
  const texts = items.map((x) => x.text);
  // 门看的文本可以另外给（生产里渲染文本带时间头，门用对话原文更稳）；不给就共用一个文本。
  const gateTexts = items.map((x) => (x.gateText != null ? x.gateText : x.text));
  const gate = gateSignal(String(question || ''), gateTexts);
  // 排除集统一按字符串比：调用方给数字集合（bench 的轮次是数字）也得能对上，否则会静默地一条都排不掉。
  const exclude = new Set([...(excludeIds || [])].map(String));
  const out = {
    fire: gate.fire,
    gate,
    mode: 'none',
    statements: [],
    picked: [],
    rows: [],
    meta: { anchors: [], tail: 0, skipped: [] },
  };
  if (!gate.fire) return out;

  // 可见轮次 = 锚点要落的地方。没有可见轮次就没得比：gate 本身是按它算的，这里只是防呆。
  const usable = cutoffId == null
    ? items
    : items.filter((it) => it.id == null || !/^\d+$/.test(it.id) || Number(it.id) <= Number(cutoffId));
  if (!usable.length) {
    out.meta.skipped.push('event: 可见轮次为空，锚点无从比对');
    return out;
  }
  if (!embed) {
    out.meta.skipped.push('event: 没配向量（embed 未给），锚点路线不跑');
    return out;
  }

  const stmts = (Array.isArray(statements) ? statements : statements ? [statements] : [])
    .map((s) => String(s || '').trim())
    .filter(Boolean);
  const anchorTexts = stmts.length ? stmts : [String(question || '').trim()];
  out.mode = stmts.length ? 'statement' : 'probe';
  out.statements = anchorTexts;

  const vecs = await Promise.all([
    embedAsk(anchorTexts),
    embedDoc(usable.map((it) => it.text)),
  ]);
  const stmtVecs = vecs[0];
  const turnVecs = vecs[1];
  if (!Array.isArray(stmtVecs) || stmtVecs.length !== anchorTexts.length
    || !Array.isArray(turnVecs) || turnVecs.length !== usable.length) {
    out.meta.skipped.push('event: 向量条数对不上，锚点路线不跑');
    return out;
  }

  // 1) 锚点：每条事件句对可见轮次余弦，取前 anchorsPer 个；多条取并集、每条轮取最大余弦。
  const anchorMap = new Map();
  for (const sv of stmtVecs) {
    const ranked = usable
      .map((it, i) => ({ it, c: cosine(sv, turnVecs[i]) }))
      .sort((a, b) => b.c - a.c);
    for (const r of ranked.slice(0, opt.anchorsPer)) {
      const k = r.it.id == null ? '#i' + r.it.index : r.it.id;
      const prev = anchorMap.get(k);
      if (!prev || prev.c < r.c) anchorMap.set(k, { c: r.c, it: r.it });
    }
  }
  const anchorTop = [...anchorMap.entries()].sort((a, b) => b[1].c - a[1].c);
  out.meta.anchors = anchorTop.slice(0, 8).map(([k, v]) => k + '@' + Number(v.c).toFixed(3));
  const anchorIds = new Set([...anchorMap.values()].map((v) => v.it.id).filter((x) => x != null));

  // 2) 字面尾巴：从锚点那段原文里取词，跟事件句一起再查一次；字面门比向量门可信，所以这一步几乎不提新事。
  const tail = new Map();
  const stmtText = anchorTexts.join(' ');
  for (const [, a] of anchorTop.slice(0, opt.anchorHead)) {
    const terms = keyTerms(a.it.text);
    const q2 = (stmtText + ' ' + terms.join(' ')).trim();
    const r2 = recallSearch(index, q2, { topK: opt.tailK, budgetTokens: opt.tailBudget, triggerFill: 0 });
    for (const x of r2.data) {
      const id = String(x.id);
      // 只准用「这一段现在看得到的轮次」：字面尾巴是在全库上查的，不按 cutoff 卡住就会捞进后话。
      if (cutoffId != null && /^\d+$/.test(id) && Number(id) > Number(cutoffId)) continue;
      if (exclude.has(id) || tail.has(id)) continue;
      tail.set(id, Number(x.score));
    }
    // 前后各带一轮（只在 id 是纯数字、并且库里真有那一段时才带；生产 id 是 session#seq.part，一般带不动）
    if (opt.neighbor > 0 && a.it.id && /^\d+$/.test(a.it.id)) {
      const t = Number(a.it.id);
      for (let d = -opt.neighbor; d <= opt.neighbor; d++) {
        const tt = String(t + d);
        if (d === 0 || cutoffId != null && Number(tt) > Number(cutoffId)) continue;
        if (!index.byId.has(tt) || exclude.has(tt) || tail.has(tt)) continue;
        tail.set(tt, 0.5);
      }
    }
  }
  out.meta.tail = tail.size;

  // 3) 拼块：锚点优先（按余弦），再尾巴（按字面分），排除主检索已经给出的段。
  const picked = [];
  for (const [, a] of anchorTop) {
    if (picked.length >= opt.take) break;
    const id = a.it.id;
    if (id == null || exclude.has(id) || picked.includes(id)) continue;
    picked.push(id);
  }
  const tailTop = [...tail.entries()].filter(([id]) => !anchorIds.has(id)).sort((a, b) => b[1] - a[1]);
  for (const [id] of tailTop) {
    if (picked.length >= opt.take) break;
    if (exclude.has(id) || picked.includes(id)) continue;
    picked.push(id);
  }

  out.picked = picked;
  out.rows = picked.map((id) => {
    const seg = index.byId.get(id);
    if (!seg) return null;
    return { id, content: renderContent(seg), text: renderContent(seg), source: anchorIds.has(id) ? 'anchor' : 'tail' };
  }).filter(Boolean);
  if (!out.rows.length) out.meta.skipped.push('event: 块是空的（锚点都在主检索里，或库里没有这些段）');
  return out;
}