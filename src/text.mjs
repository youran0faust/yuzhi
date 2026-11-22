// 鱼知 · 文字层
// 只做三件事：怎么切（切回原文能拼回去）、怎么算长度、怎么从问句里认出时间。
// 全部零依赖。任何一段切片都是原文的精确子串——这条不商量。

// 一段原话的上限（估出来的 token）。超过就按句边界切子段。
export const SEGMENT_MAX_TOKENS_DEFAULT = 400;

// —— 长度 ——
// 没有 tiktoken 可用。按「CJK 一个字算 1.5 token，其余 4 字符算 1 token」估。
// 这是估，不是量：真实 tokenizer 一定会有出入。所以它只用来做预算，不用来做结论。
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g;

export function countTokens(text) {
  if (!text) return 0;
  const cjk = (text.match(CJK) || []).length;
  return Math.ceil(cjk * 1.5 + (text.length - cjk) / 4) + 1;
}

// —— 切句 ——
// 中文句号后面没有空格，所以不能只照 khipu 的 /(?<=[.!?。！？])\s+/。
// 这里：英文标点后必须跟空白才算切；中文标点自己就断。
const SENT_END = /(?<=[。！？])(?=\S)|(?<=[.!?])(?=\s)/g;

export function sentenceSpans(text) {
  const spans = [];
  let start = 0;
  for (const m of text.matchAll(SENT_END)) {
    spans.push([start, m.index + 1]);
    start = m.index + 1;
  }
  if (start < text.length) spans.push([start, text.length]);
  return spans.length ? spans : [[0, text.length]];
}

export function splitSentences(text) {
  return sentenceSpans(text).map(([a, b]) => text.slice(a, b)).filter((s) => s.trim());
}

// 长消息按句边界切。每段是原文的精确子串（含切点处的空白），拼回去等于原文。
export function splitLong(text, maxTokens) {
  if (countTokens(text) <= maxTokens) return [text];
  const parts = [];
  let start = 0;
  let acc = 0;
  let lastCut = 0;
  for (const [a, b] of sentenceSpans(text)) {
    const t = countTokens(text.slice(a, b));
    if (lastCut > start && acc + t > maxTokens) {
      parts.push(text.slice(start, lastCut));
      start = lastCut;
      acc = 0;
    }
    acc += t;
    lastCut = b;
  }
  if (start < text.length) parts.push(text.slice(start));
  return parts.filter((p) => p.trim()).length ? parts.filter((p) => p.trim()) : [text];
}

// —— 说话人 ——
// 只认「Name: 」这种行首前缀，且必须不是「Note:」「Summary:」这类正文标签。
const NAME_PREFIX = /^([A-Z][a-zA-Z]{1,20}):\s/;
const NOT_A_SPEAKER = new Set('Note Notes Tip Tips Warning Update Summary Answer Question Step Example Task Context Reminder Hint Hints Ps Edit Result Output Input Error Info Important Remember Topic Subject Re Fyi Idea Plan Goal Status Title Description Prompt Response System User Assistant'.split(' '));

export function speakerPrefix(content) {
  const m = NAME_PREFIX.exec(content || '');
  if (!m || NOT_A_SPEAKER.has(m[1])) return null;
  return m[1];
}

// —— 分词 ——
// 英文按词；中文按二元组（bigram）。没有分词器就承认没有，用二元组是最稳的退路：
// 它不会切错，只是会产生一些无意义的组合，BM25 的 idf 会把那些压下去。
export function tokenize(text) {
  const out = [];
  if (!text) return out;
  const low = text.toLowerCase();
  for (const m of low.matchAll(/[a-z0-9_]+/g)) out.push(m[0]);
  for (const m of low.matchAll(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]+/g)) {
    const run = m[0];
    if (run.length === 1) out.push(run);
    for (let i = 0; i + 1 < run.length; i += 1) out.push(run.slice(i, i + 2));
  }
  return out;
}

// —— 实体 ——
// 宁漏勿滥：只收英文大写词（不是句首）、引号里的词、以及「Name:」里的名字。
// 中文实体没有形态标记，硬猜只会错，这里不猜。
const STOP_NAMES = new Set('I Im Ill Id Ive Is Are Was Were The A An And But Or Not No Yes Mr Mrs Ms Dr Prof Sir Madam Assistant User Human Bot English Spanish French German Chinese Japanese American British European Asian African Google Youtube Netflix Amazon Apple Facebook Instagram Twitter Reddit Tiktok Spotify Uber Airbnb Wow Haha Lol Btw Omg Anyway Actually Honestly Basically Finally First Second Third Last Next New Old Big Small Happy Sad Love Like Hope Wish Think Know Feel Got Get Went Going Come Came Let Make Made What When Where Why How Who Which'.split(' '));
const QUOTED = /[「“"]([^」”"]{2,24})[」”"]/g;

export function extractNames(text) {
  const names = new Set();
  const sp = speakerPrefix(text || '');
  if (sp) names.add(sp);
  for (const m of (text || '').matchAll(QUOTED)) names.add(m[1]);
  for (const sent of splitSentences(text || '')) {
    const toks = sent.split(/\s+/);
    for (let i = 1; i < toks.length; i += 1) {
      const tok = toks[i].replace(/[^A-Za-z]/g, '');
      if (!/^[A-Z][a-z]{1,20}$/.test(tok)) continue;
      if (STOP_NAMES.has(tok)) continue;
      names.add(tok);
    }
  }
  return [...names];
}

// —— 时间 ——
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function dateHeader(tsISO, granularity, sessionLabel) {
  if (!tsISO) return `[date unknown · ${sessionLabel || 'session ?'}]`;
  const d = new Date(tsISO);
  const head = `${d.toISOString().slice(0, 10)} (${WEEKDAYS[d.getUTCDay()]})`;
  const withTime = granularity === 'datetime' ? `${head} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}` : head;
  return `[${withTime}]`;
}

// 粒度跟来源走：源里只有日期就只给日期，有时刻就给到秒。裁判会因为粒度不一致判错。
export function createdAtValue(tsISO, granularity) {
  if (!tsISO) return null;
  const d = new Date(tsISO);
  if (granularity === 'datetime') return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  return d.toISOString().slice(0, 10);
}

// 毫秒 → { ts, granularity }。0 点是「只有日期」的判据（沿用 khipu 的做法）。
export function tsFromMs(ms) {
  if (ms === null || ms === undefined) return { ts: null, granularity: 'unknown' };
  let n = Number(ms);
  if (!Number.isFinite(n)) return { ts: null, granularity: 'unknown' };
  // 有人给秒、有人给毫秒。1e9..1e11 这一段只可能是「秒」（2001–5138 年的秒），
  // 当毫秒读会全落到 1970 年，错得还很安静，所以换一次。
  if (n >= 1e9 && n < 1e11) n *= 1000;
  // 合理区间：1973-03 到 2103。出这个范围的不认——宁可写「不详」，不写一个看着像的假日期。
  if (n < 1e11 || n > 4.2e12) return { ts: null, granularity: 'unknown' };
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return { ts: null, granularity: 'unknown' };
  const midnight = d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0;
  return { ts: d.toISOString(), granularity: midnight ? 'date' : 'datetime' };
}

const MONTHS_EN = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTHS_CN = ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月'];

// 从问句里认时间。只认得到就说认得到；认不出返回 null，不许猜。
export function parseDateQuery(q) {
  if (!q) return null;
  let m = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(q);
  if (m) return { y: +m[1], mo: +m[2], d: +m[3], precision: 'day' };
  m = /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/.exec(q);
  if (m) return { y: +m[1], mo: +m[2], d: +m[3], precision: 'day' };
  m = /(\d{4})\s*年\s*(\d{1,2})\s*月/.exec(q);
  if (m) return { y: +m[1], mo: +m[2], d: null, precision: 'month' };
  m = /(\d{4})\s*年/.exec(q);
  if (m) return { y: +m[1], mo: null, d: null, precision: 'year' };
  m = /(\d{1,2})\s*月\s*(\d{1,2})\s*日/.exec(q);
  if (m) return { y: null, mo: +m[1], d: +m[2], precision: 'monthday' };
  m = /(\d{1,2})\s*月/.exec(q);
  if (m) return { y: null, mo: +m[1], d: null, precision: 'month' };
  const low = q.toLowerCase();
  for (let i = 0; i < 12; i += 1) {
    const name = MONTHS_EN[i];
    if (!low.includes(name)) continue;
    const dm = new RegExp(`${name}\\s+(\\d{1,2})`).exec(low);
    const ym = new RegExp(`(\\d{4})\\s+${name}`).exec(low);
    return { y: ym ? +ym[1] : null, mo: i + 1, d: dm ? +dm[1] : null, precision: dm ? 'monthday' : 'month' };
  }
  for (let i = 0; i < 12; i += 1) {
    if (!q.includes(MONTHS_CN[i])) continue;
    const dm = new RegExp(`${MONTHS_CN[i]}\\s*(\\d{1,2})\\s*日`).exec(q);
    return { y: null, mo: i + 1, d: dm ? +dm[1] : null, precision: dm ? 'monthday' : 'month' };
  }
  return null;
}

// 一个段落的时间离问句里那个时间有多近（单位：天）。放回 0..1 的分。
export function dateProximity(tsISO, want) {
  if (!tsISO || !want) return null;
  const d = new Date(tsISO);
  if (Number.isNaN(d.getTime())) return null;
  let delta = 0;
  if (want.y !== null && want.y !== undefined && d.getUTCFullYear() !== want.y) {
    delta = Math.abs(d.getUTCFullYear() - want.y) * 365;
  } else if (want.mo != null && d.getUTCMonth() + 1 !== want.mo) {
    delta = Math.abs(d.getUTCMonth() + 1 - want.mo) * 30;
  } else if (want.d != null && d.getUTCDate() !== want.d) {
    delta = Math.abs(d.getUTCDate() - want.d);
  }
  return 1 / (1 + delta);
}

// —— 规则句 ——
// 短而重要的祈使句。宁漏勿滥：只认用户说的、不超过 400 字。
const RULE = /\b(always|never|from now on|going forward|in the future|please (?:don'?t|do not|stop|avoid|remember)|don'?t ever|remember to|make sure (?:to|you)|every time|whenever you|i prefer|i'?d prefer|i don'?t like it when|stop (?:using|doing|adding)|no longer)\b|以后|每次|别再|不要再|记住|从今以后|从现在起/i;

export function looksLikeRule(text, role) {
  if (role !== 'user') return false;
  if (countTokens(text) > 300) return false;
  return RULE.test(text);
}
