// 鱼知 · 线索层
// 从原话里捞出「可能还没闭合」的候选，附上原文，等我（或人）去认。
//
// 要紧的一句：**它不是判官。**
// 没有判别模型的时候硬判，只会造出一堆假悬案；假悬案比没有更坏，因为它看起来像账。
// 所以这里只做召回：给证据（原话段 id + 逐字原文）、给信号（为什么觉得它没完）、给一句
// 模板生成的「它闭合时长什么样」。**模板不是推断**，字段里写死 provenance='template'。
//
// 两个动作：
//   extractCandidates(segs)       → 还没闭合的候选
//   proposeCloses(segs, cases)    → 可能已经闭合的旧案（拿闭合信号去撞已有的悬案）
import fs from 'node:fs';
import path from 'node:path';
import { contentTokens } from './recall.mjs';
import { splitSentences } from './text.mjs';
import { readUser, DATA_DIR } from './store.mjs';

// —— 信号表 ——
// 每条都要能被指着念出来：「这里用了『还没』」。不是模糊的『感觉没完』。
export const SIGNALS = [
  { id: 'pending', w: 0.5, re: /还没|没有做|没做|未完成|待办|回头|以后再说|明天再|下次再|先记着|先放着|挂着|搁着|搁置|暂缓|暂不|还得|得等|等着|等到|要等|先等|TODO|pending|later on/i, why: '明确悬置/待办' },
  { id: 'blocked', w: 0.6, re: /卡在|卡住|不行|没成|失败|报错|跑不通|走不通|打不开|连不上|对不上|没接上|没跑通|没走通|没对[上下]|没打通|还没通|failed|blocked|doesn'?t work/i, why: '撞墙（撞了墙的事通常没闭合）' },
  { id: 'unverified', w: 0.6, re: /没验|没测|没试过|应该能|大概行|不确定|说不准|不知道行不行|尚未验证|待核|unverified|untested|not verified/i, why: '没验过（说了但没量）' },
  { id: 'promise', w: 0.4, re: /(回头|下次|明天|待会|晚点)我|我来(做|改|写|接|试)|我去(做|改|写|接|试)|我会(去)?(做|改|写|接|试)/, why: '承诺未兑现' },
  { id: 'question', w: 0.3, re: /[?？]\s*$/, why: '问句（问完没人答就是悬的）' },
];

// 闭合信号：看见它，说明「这事可能刚被了结」，用来撞已有的悬案。
export const CLOSING = {
  re: /已经?(好了|搞定|完成|解决|通[了啦]|接上[了啦]|跑通|验过|通过)|搞定|修好了|通了|跑通了|验过[了啦]|不再(报错|卡)|fixed|it works|resolved|done/i,
  why: '闭合信号',
};

// 回顾语气：账本里写下的「失败」「报错」，绝大多数是在复述一条**已经处理掉**的失败
//（「改成…」「事故…」「复核…」「定稿」）。不认这一层，召回器就会把每一次复盘都当成悬案。
// 判断法：出现回顾词、又没有明确的「还没/待/下次」语气 → 当已闭合，不产候选。
export const RETRO = /曾|当时|原来|后来|改成|换成|已改|已经|事故|复盘|复核|审计|收尾|定稿|落成|这一轮|那次|修好了|救回/i;

const short = (t) => (t || '').replace(/\s+/g, ' ').trim();

// 取含信号的那一小句，作为「这件事叫什么」。取不到就取第一句。
export function subjectOf(text, signalIds = []) {
  const body = short(text);
  if (!body) return '';
  // 「对了，」「顺便」「另外」是连接词，不是这件事的一部分——带着它们算指纹，同一件事会算成两件。
  const t = body
    .replace(/^[A-Z][a-zA-Z]{1,20}:\s*/, '')
    .replace(/^(对了|顺便|另外|然后|还有|话说|接着说)[，,、\s]*/, '');
  const sents = splitSentences(t);
  const res = signalIds.map((id) => SIGNALS.find((s) => s.id === id)).filter(Boolean);
  for (const s of res) {
    const m = s.re.exec(t);
    // 围绕信号词取一个窗口，不取整句：整句常常一百多字，标题会变成半截话。
    if (m) return windowAround(t, m.index, m[0].length);
  }
  return clip(sents[0] || t);
}

// 从信号词往两边扩到最近的标点，最多往前 24 字、往后 40 字。
const STOP_CH = /[，。；：！？、,.;:!?（）()「」\n]/;
function windowAround(body, at, len) {
  let a = at;
  while (a > 0 && !STOP_CH.test(body[a - 1]) && at - a < 24) a -= 1;
  let b = at + len;
  while (b < body.length && !STOP_CH.test(body[b]) && b - at < 40) b += 1;
  let w = body.slice(a, b).replace(/^[，。；：、\s]+/, '').trim();
  // 总结体文书里标点密（引号、括号、顿号），窗口常常只剩三四个字的碎片。
  // 太短就往外扩，扩到 8 字以上或撞上句号为止——宁可长一点，别给一个看不懂的标题。
  let guard = 0;
  while (w.length < 8 && guard < 8 && (a > 0 || b < body.length)) {
    a = Math.max(0, a - 4);
    b = Math.min(body.length, b + 4);
    w = body.slice(a, b).replace(/^[，。；：、\s]+/, '').trim();
    guard += 1;
  }
  return w ? clip(w) : clip(body);
}

function clip(s, n = 70) {
  const t = short(s).replace(/^[，。、；：\s]+/, '');
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

// 指纹：这一小句的实词。同一件事在两段里各说一遍，指纹应该撞上，只算一条。
export function fingerprint(subject) {
  const toks = [...new Set(contentTokens(subject))].sort();
  return toks.slice(0, 10).join('|') || short(subject).slice(0, 24);
}

export function scoreSegment(text) {
  const body = text || '';
  const hits = [];
  let score = 0;
  for (const s of SIGNALS) {
    if (s.re.test(body)) { hits.push(s.id); score += s.w; }
  }
  const closing = CLOSING.re.test(body);
  return { hits, score: Math.min(1, score), closing };
}

// 太短的、纯语气的一律不看：那里面不会有「没闭合的事」。
function worthLooking(text) {
  const t = short(text);
  if (t.length < 6) return false;
  if (/^[哈嗯哦啊呀吧呢吗的了,\s.。!！?？]+$/.test(t)) return false;
  return true;
}

// —— 召回：还没闭合的候选 ——
// 同一件事在两段里各说一遍，只算一条（指纹撞上就合并，两处出处都记着）。
export function extractCandidates(segs, { minScore = 0.5, limit = 0 } = {}) {
  const byFp = new Map();
  for (const seg of segs || []) {
    if (!worthLooking(seg.text)) continue;
    const r = scoreSegment(seg.text);
    if (!r.hits.length) continue;
    const strong = r.hits.some((id) => id === 'pending' || id === 'blocked' || id === 'unverified');
    if (r.closing && !strong) continue;
    // 复盘/已改的叙述里带「失败」「报错」，但它写的是**过去**。除非同时有「还没/待」这种现在是未完成的语气，
    // 否则一律当已闭合——宁可漏，不可把每一次复盘都变成假悬案。
    if (RETRO.test(seg.text) && !r.hits.includes('pending')) continue;
    if (r.score < minScore) continue;
    const subject = subjectOf(seg.text, r.hits);
    if (!subject) continue;
    const fp = fingerprint(subject);
    const prev = byFp.get(fp);
    if (prev) {
      prev.mentions.push(seg.id);
      prev.score = Math.max(prev.score, r.score);
      for (const h of r.hits) if (!prev.signals.includes(h)) prev.signals.push(h);
      continue;
    }
    byFp.set(fp, {
      k: 'cand',
      seg_id: seg.id,
      session: seg.session_id,
      ts: seg.ts || null,
      signals: [...r.hits],
      why: r.hits.map((id) => SIGNALS.find((s) => s.id === id)?.why || id),
      quote: seg.text,
      subject,
      q: '「' + subject + '」到底结了没有？',
      synth: '当「' + subject + '」有了可复现的结果（谁做的、做了什么、结果如何），这条才算闭合。',
      synth_provenance: 'template',
      fp,
      score: r.score,
      mentions: [seg.id],
    });
  }
  let out = [...byFp.values()].sort((a, b) => b.score - a.score);
  if (limit > 0) out = out.slice(0, limit);
  return out;
}

// —— 撞车：这些旧案可能刚被了结 ——
// 只提「可能」，不许自己关。关案子要写 why，那是人的事。
export function proposeCloses(segs, cases, { minShared = 2 } = {}) {
  const out = [];
  const open = (cases || []).filter((c) => !c.state || c.state === 'unresolved' || c.state === 'abandoned');
  for (const seg of segs || []) {
    if (!worthLooking(seg.text)) continue;
    if (!CLOSING.re.test(seg.text)) continue;
    const st = new Set(contentTokens(seg.text));
    for (const c of open) {
      const ct = new Set(contentTokens((c.open || c.q || '') + ' ' + (c.subjects || []).join(' ')));
      let shared = 0;
      for (const t of st) if (ct.has(t)) shared += 1;
      if (shared >= minShared) {
        out.push({ k: 'close_cand', case_id: c.id, seg_id: seg.id, quote: seg.text, shared, why: CLOSING.why });
      }
    }
  }
  return out;
}

// —— 自测 ——
export function selftest() {
  let pass = 0; let fail = 0; const bad = [];
  const ok = (cond, name) => { if (cond) pass += 1; else { fail += 1; bad.push(name); } };
  const seg = (id, text) => ({ id, text, session_id: 's', ts: null, speaker: null });

  const a = extractCandidates([seg('s#1.1', 'Alice: 重采样那道钩子还没接上，先放着。')]);
  ok(a.length === 1, '捞出一条未闭合候选');
  ok(a[0].signals.includes('pending'), '认出 pending');
  ok(a[0].quote.includes('还没接上'), '带逐字原话');
  ok(a[0].seg_id === 's#1.1', '带原文指针');
  ok(a[0].synth_provenance === 'template', '合成句标明是模板');

  ok(extractCandidates([seg('s#2.1', '今天天气不错，出门走了走。')]).length === 0, '普通陈述不产候选');
  const c = extractCandidates([seg('s#3.1', '这个接口跑不通，直接报 409。')]);
  ok(c.length === 1 && c[0].signals.includes('blocked'), '认出 blocked');

  const d = extractCandidates([seg('s#4.1', 'Alice: 重采样那道钩子还没接上。'), seg('s#4.2', '对了，重采样那道钩子还没接上。')]);
  ok(d.length === 1, '同一件事说两遍只算一条');
  ok(d[0].mentions.length === 2, '两处出处都记着');

  ok(extractCandidates([seg('s#5.1', '好了，重采样接上了，跑通了。')]).length === 0, '闭合信号不产候选');
  ok(extractCandidates([seg('s#6.1', '嗯。'), seg('s#6.2', '哈')]).length === 0, '语气词不产候选');

  const cases = [{ id: 'X-001', state: 'unresolved', open: '重采样接没接上' }];
  const cl = proposeCloses([seg('s#7.1', '重采样接上了，跑通了。')], cases);
  ok(cl.length === 1 && cl[0].case_id === 'X-001', '闭合信号撞上旧案，给候选');
  ok(!('state' in cl[0]), '只提可能，不许自己关');
  ok(proposeCloses([seg('s#8.1', '晚饭吃了面。')], cases).length === 0, '不相干的话不撞案');

  // 真实材料教的一条：账本里的「失败」多半是复述一条已经处理掉的事。
  ok(extractCandidates([seg('s#9.1', '当时跑不通，后来改成用 pwsh 写了。')]).length === 0, '复盘语气当已闭合（当时/后来/改成）');
  ok(extractCandidates([seg('s#9.2', '这个接口还是跑不通，明天再看。')]).length === 1, '同一个信号，带「明天再看」就还算未闭合');

  return { pass, fail, bad, total: pass + fail };
}

// —— CLI ——
function parseArgv(argv) {
  const opt = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v === undefined) {
        const nx = argv[i + 1];
        if (nx && !nx.startsWith('-')) { opt[k] = nx; i += 1; } else opt[k] = true;
      } else opt[k] = v;
    } else opt._.push(a);
  }
  return opt;
}

function readCases(file) {
  if (!file || !fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if (o.k === 'case') out.push({ id: o.id, open: o.open, state: o.state || 'unresolved' });
    } catch { /* 坏行跳过；这不是账本本体 */ }
  }
  return out;
}

function main() {
  const opt = parseArgv(process.argv.slice(2));
  if (opt.selftest) {
    const r = selftest();
    console.log(`线索层自测：${r.pass}/${r.total} PASS`);
    if (r.fail) { console.log('失败项：'); for (const b of r.bad) console.log('  - ' + b); process.exit(1); }
    return;
  }
  if (!opt.user) {
    console.error('用法: node threads.mjs --user <user_id> [--dir data] [--out 候选.jsonl] [--min 0.5] [--cases 悬案表.jsonl]');
    process.exit(2);
  }
  const dir = opt.dir || DATA_DIR;
  const { segs } = readUser(dir, opt.user);
  const cands = extractCandidates(segs, { minScore: Number(opt.min || 0.5), limit: Number(opt.limit || 0) });
  console.log(`扫了 ${segs.length} 段，捞出 ${cands.length} 条可能没闭合的：`);
  for (const c of cands) {
    console.log(`  [${c.score.toFixed(2)}] ${c.signals.join('+')}  ${c.q}`);
    console.log(`         原话(${c.mentions.length}处)：${c.quote.slice(0, 90)}`);
  }
  if (opt.cases) {
    const closes = proposeCloses(segs, readCases(opt.cases));
    console.log(`\n可能已闭合的旧案 ${closes.length} 条（只是候选，关案要写 why）：`);
    for (const x of closes) console.log(`  ${x.case_id}  ← ${x.seg_id}  ${x.quote.slice(0, 70)}`);
  }
  if (opt.out) {
    fs.mkdirSync(path.dirname(path.resolve(opt.out)), { recursive: true });
    fs.writeFileSync(opt.out, cands.map((c) => JSON.stringify(c)).join('\n') + (cands.length ? '\n' : ''), 'utf8');
    console.log(`\n候选写到 ${opt.out}（看完再 import，别直接灌账本）`);
  }
}

if (process.argv[1] && /threads\.mjs$/.test(process.argv[1])) main();
