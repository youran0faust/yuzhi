// 鱼知 · 离线回放
// 形状照 khipu 的 tests/replay_locomo.py：按「20 条消息或 2000 词」分块喂进 Add，再逐题 Search，算 hit@k。
// 数据用 LoCoMo 的形状，所以等真 locomo10.json 到手，这个脚本不用改。
//
// 两种跑法：
//   默认   进程内跑（不起端口、不联网）—— 查问题用这个
//   --base 打 HTTP 服务 —— 验契约用这个
//
// 一句要紧的话：这个脚本量的是「给了对话和一道题，能不能把证据翻出来」。
// 它量不出「三个月前的事自己冒出来没有」。分数只当体检。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const KS = [10, 20, 50, 100];
const CHUNK_MSGS = 20;
const CHUNK_WORDS = 2000;
const CATEGORY = { 1: 'multi-hop', 2: 'temporal', 3: 'open-domain', 4: 'single-hop', 5: 'adversarial' };

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// "1:56 pm on 8 May, 2023"
export function parseSessionTime(s) {
  const m = /(\d{1,2}):(\d{2})\s*(am|pm)\s+on\s+(\d{1,2})\s+([A-Za-z]+),?\s+(\d{4})/i.exec(String(s || '').trim());
  if (!m) {
    const t = Date.parse(s);
    return Number.isNaN(t) ? null : t;
  }
  let hh = Number(m[1]) % 12;
  if (m[3].toLowerCase() === 'pm') hh += 12;
  const mi = m[5][0].toUpperCase() + m[5].slice(1).toLowerCase();
  const mon = MONTHS.indexOf(mi);
  if (mon < 0) return null;
  return Date.UTC(Number(m[6]), mon, Number(m[4]), hh, Number(m[2]));
}

const words = (t) => (String(t).match(/\S+/g) || []).length;

export function conversationMessages(conv) {
  const c = conv.conversation || conv;
  const sessions = Object.keys(c)
    .map((k) => (/^session_(\d+)$/.test(k) ? Number(k.split('_')[1]) : null))
    .filter((x) => x !== null)
    .sort((a, b) => a - b);
  const speakers = [];
  const out = [];
  for (const n of sessions) {
    const ts = parseSessionTime(c[`session_${n}_date_time`]);
    for (const turn of c[`session_${n}`] || []) {
      if (!speakers.includes(turn.speaker)) speakers.push(turn.speaker);
      const role = speakers.indexOf(turn.speaker) === 0 ? 'user' : 'assistant';
      let text = String(turn.text ?? '');
      if (turn.blip_caption) text += ` [shared image: ${turn.blip_caption}]`;
      out.push({ role, content: `${turn.speaker}: ${text}`, timestamp: ts, dia_id: turn.dia_id });
    }
  }
  return out;
}

export function chunks(msgs) {
  const out = [];
  let buf = [];
  let w = 0;
  for (const m of msgs) {
    const mw = words(m.content);
    if (buf.length && (buf.length >= CHUNK_MSGS || w + mw > CHUNK_WORDS)) {
      out.push(buf);
      buf = [];
      w = 0;
    }
    buf.push(m);
    w += mw;
  }
  if (buf.length) out.push(buf);
  return out;
}

function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function p50(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function summarize(rows) {
  const s = { questions: rows.length };
  for (const k of KS) s[`any@${k}`] = Number(mean(rows.map((r) => r[`any@${k}`])).toFixed(4));
  s['all@100'] = Number(mean(rows.map((r) => r['all@100'])).toFixed(4));
  s.avg_items = Number(mean(rows.map((r) => r.n)).toFixed(1));
  s.avg_chars = Math.round(mean(rows.map((r) => r.chars)));
  s.p50_ms = Number(p50(rows.map((r) => r.ms)).toFixed(2));
  s.max_ms = Math.round(Math.max(0, ...rows.map((r) => r.ms)));
  return s;
}

function argOf(argv, name, dflt) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
}

async function main() {
  const argv = process.argv.slice(2);
  const dataPath = argOf(argv, 'data', '');
  const tag = argOf(argv, 'tag', new Date().toISOString().slice(5, 16).replace(/[-:T]/g, ''));
  const convos = Number(argOf(argv, 'convos', '0')) || Infinity;
  const topK = Number(argOf(argv, 'top-k', '100'));
  const base = argOf(argv, 'base', '');
  const token = argOf(argv, 'token', '');
  const outPath = argOf(argv, 'out', '');
  const skipAdd = argv.includes('--skip-add');

  if (!dataPath) {
    console.error('用法: node src/replay.mjs --data <LoCoMo 形状的 json> [--convos N] [--top-k 100] [--base http://...] [--token X]');
    process.exit(2);
  }

  const raw = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  const data = (Array.isArray(raw) ? raw : [raw]).slice(0, convos);

  // 进程内跑时每个会话一个独立数据目录，互不污染；跑完就删。
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yuzhi-replay-'));
  let add = null;
  let searchFn = null;

  if (base) {
    const headers = token ? { authorization: `Bearer ${token}`, 'content-type': 'application/json' } : { 'content-type': 'application/json' };
    const post = async (p, body) => {
      const r = await fetch(`${base}${p}`, { method: 'POST', headers, body: JSON.stringify(body) });
      if (!r.ok) throw new Error(`${p} → HTTP ${r.status}: ${await r.text()}`);
      return r.json();
    };
    add = (userId, sessionId, requestId, msgs) => post('/add', { user_id: userId, session_id: sessionId, request_id: requestId, messages: msgs });
    searchFn = (userId, query, k) => post('/search', { query, user_id: userId, top_k: k });
  } else {
    const { addMessages, readUser } = await import('./store.mjs');
    const { buildIndex, search } = await import('./recall.mjs');
    const cache = new Map();
    add = async (userId, sessionId, requestId, msgs) => {
      const out = addMessages({ dir: tmpRoot, userId, sessionId, requestId, messages: msgs });
      if (out.response.added > 0) cache.delete(userId);
      return out.response;
    };
    searchFn = async (userId, query, k) => {
      let idx = cache.get(userId);
      if (!idx) {
        idx = buildIndex(readUser(tmpRoot, userId).segs);
        cache.set(userId, idx);
      }
      return search(idx, query, { topK: k, budgetTokens: Number.MAX_SAFE_INTEGER });
    };
  }

  const perCat = new Map();
  const allRows = [];
  let ci = -1;

  for (const conv of data) {
    ci += 1;
    const userId = `replay:${tag}:conv-${ci}`;
    const sessionId = `replay:${tag}:sample:${ci}`;
    const msgs = conversationMessages(conv);
    // 段 id 是 session#seq.part，seq 从 1 起按消息顺序递增；这里建 seq → dia_id 的映射
    const seqToDia = new Map(msgs.map((m, i) => [i + 1, m.dia_id]));

    if (!skipAdd) {
      const t0 = Date.now();
      const chs = chunks(msgs);
      for (let k = 0; k < chs.length; k += 1) {
        await add(userId, sessionId, `${userId}:chunk-${k}`, chs[k].map((m) => ({ role: m.role, content: m.content, timestamp: m.timestamp })));
      }
      console.log(`conv-${ci}: ${msgs.length} 条消息 / ${chs.length} 块，写入 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    }

    const qas = (conv.conversation ? conv.qa : conv.qa) || [];
    for (const qa of qas) {
      const evidence = (qa.evidence || []).filter((e) => typeof e === 'string');
      const cat = CATEGORY[qa.category] || String(qa.category);
      if (!evidence.length) continue; // 没有金标证据的题不算命中率

      const t0 = process.hrtime.bigint();
      const res = await searchFn(userId, qa.question, topK);
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      const items = res.data || [];
      const got = [];
      for (const it of items) {
        const m = /#(\d+)\.\d+$/.exec(it.id);
        if (m) got.push(seqToDia.get(Number(m[1])));
      }
      const ev = new Set(evidence);
      const row = { conv: ci, cat, n: items.length, ms, chars: items.reduce((a, it) => a + it.content.length, 0) };
      for (const k of KS) {
        const top = new Set(got.slice(0, k));
        row[`any@${k}`] = ev.size && [...ev].some((e) => top.has(e)) ? 1 : 0;
        row[`all@${k}`] = ev.size && [...ev].every((e) => top.has(e)) ? 1 : 0;
      }
      if (!perCat.has(cat)) perCat.set(cat, []);
      perCat.get(cat).push(row);
      allRows.push(row);
    }
  }

  const summary = {
    tag,
    convos: data.length,
    mode: base ? `http ${base}` : 'in-process',
    overall: summarize(allRows),
    by_category: Object.fromEntries([...perCat].sort().map(([c, r]) => [c, summarize(r)])),
  };
  console.log(JSON.stringify(summary, null, 2));

  if (outPath) {
    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify({ summary, rows: allRows }, null, 2), 'utf8');
    console.log(`明细写到 ${outPath}`);
  }
  if (!base && !argv.includes('--keep')) fs.rmSync(tmpRoot, { recursive: true, force: true });
  else if (!base) console.log(`现场留着: ${tmpRoot}`);
}

if (process.argv[1] && /replay\.mjs$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(e.stack || String(e));
    process.exit(1);
  });
}
