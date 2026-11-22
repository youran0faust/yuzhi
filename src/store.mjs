// 鱼知 · 存储层
// 只追加，不覆盖。一行一条：who（文件头）/ seg（原话段）/ req（幂等回执）。
// 两个硬规矩：
//   1) 一段原话写下去以后，再也不改。要改，加一行新的、旧的作废——覆盖掉旧行，就是让过去的我不能作证。
//   2) 同一个 request_id 带不同的内容回来，不认新内容，直接拒绝（fail-closed）。
//      「内容变了但编号一样」只可能是重放或撞号，两种都不该悄悄写进去。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  countTokens, splitLong, speakerPrefix, extractNames,
  tsFromMs, looksLikeRule, SEGMENT_MAX_TOKENS_DEFAULT,
} from './text.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 改名（2026-11-22 未结 → 鱼知）只换显示名，不换旧变量：新名先认、旧名兜底，老脚本和旧 .bat 不会当场炸。
const pickEnv = (name) => process.env['YUZHI_' + name] ?? process.env['UNCLOSED_' + name];
export const DATA_DIR = pickEnv('DATA') || path.join(HERE, '..', 'data');
export const SEG_MAX_TOKENS = Number(pickEnv('SEG_TOKENS') || SEGMENT_MAX_TOKENS_DEFAULT);

const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

// user_id 不进文件名：编号可能是任意字符串，直接拼会出路径穿越。用哈希，文件头里留真名。
export function userPath(dir, userId) {
  return path.join(dir, `${sha(String(userId)).slice(0, 16)}.jsonl`);
}

function parseLines(raw, file) {
  const segs = [];
  const reqs = new Map();
  const vecs = new Map();
  const bad = [];
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      bad.push(i + 1);
      continue;
    }
    if (rec.k === 'seg') segs.push(rec);
    else if (rec.k === 'vec') vecs.set(rec.id, rec);
    else if (rec.k === 'req') reqs.set(rec.request_id, rec);
    else if (rec.k !== 'who') bad.push(i + 1);
  }
  return { segs, reqs, vecs, bad, file };
}

export function readUser(dir, userId) {
  const file = userPath(dir, userId);
  if (!fs.existsSync(file)) return { segs: [], reqs: new Map(), vecs: new Map(), bad: [], file };
  return parseLines(fs.readFileSync(file, 'utf8'), file);
}

function appendLines(file, recs) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = recs.map((r) => JSON.stringify(r)).join('\n') + '\n';
  fs.appendFileSync(file, body, 'utf8');
}

// 向量是派生数据，不是原话：同一段重算一次就多一行，读的时候后写的覆盖前面的。
// 这和「原话写下去就不改」不冲突——被覆盖的只是算出来的数，原文一个字都没动。
// 坏向量（空数组、没 id）在门口就丢掉，不让它进文件污染后面的人。
export function appendVecs(dir, userId, rows) {
  const list = Array.isArray(rows) ? rows.filter((r) => r && r.id && r.v) : [];
  if (!list.length) return 0;
  appendLines(userPath(dir, userId), list.map((r) => ({
    k: 'vec', id: r.id, model: r.model || '', dim: r.dim || 0, v: r.v, at: r.at || new Date().toISOString(),
  })));
  return list.length;
}

// 时间戳兜底：自带 → 后向借（后面有时间的往前借）→ 前向继承 → 同会话上一块末尾 → 不详。
// 绝不拿服务器当前时间顶上：那会把「不知道」写成「刚刚」，错得静默。
export function resolveTimestamps(messages, sessionLast) {
  const out = messages.map((m) => {
    const { ts, granularity } = tsFromMs(m.timestamp);
    return ts ? { ts, granularity, provenance: 'given' } : { ts: null, granularity: 'unknown', provenance: 'unknown' };
  });
  let next = null;
  for (let i = out.length - 1; i >= 0; i -= 1) {
    if (out[i].ts) next = { ts: out[i].ts, granularity: out[i].granularity };
    else if (next) out[i] = { ...next, provenance: 'inherited' };
  }
  let prev = sessionLast && sessionLast.ts ? { ts: sessionLast.ts, granularity: sessionLast.granularity } : null;
  for (let i = 0; i < out.length; i += 1) {
    if (out[i].ts) prev = { ts: out[i].ts, granularity: out[i].granularity };
    else if (prev) out[i] = { ...prev, provenance: 'inherited' };
  }
  return out;
}

export function buildSegments({ userId, sessionId, requestId, messages, startSeq, sessionLast }) {
  const times = resolveTimestamps(messages, sessionLast);
  const segs = [];
  let seq = startSeq;
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i];
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const content = String(m.content ?? '');
    const speaker = speakerPrefix(content);
    const pieces = splitLong(content, SEG_MAX_TOKENS);
    const total = pieces.length;
    for (let part = 1; part <= total; part += 1) {
      const text = pieces[part - 1];
      segs.push({
        k: 'seg',
        id: `${sessionId}#${seq}.${part}`,
        user_id: userId,
        session_id: sessionId,
        request_id: requestId,
        seq,
        part,
        total,
        role,
        speaker,
        ts: times[i].ts,
        granularity: times[i].granularity,
        provenance: times[i].provenance,
        text,
        chars: text.length,
        tokens: countTokens(text),
        sha: sha(`${role}\n${text}`).slice(0, 24),
        is_rule: looksLikeRule(text, role),
        names: extractNames(text),
      });
    }
    seq += 1;
  }
  return segs;
}

export class AddConflict extends Error {
  constructor(message) {
    super(message);
    this.code = 'REQUEST_ID_CONFLICT';
  }
}

// 主写入。返回 {response, segs, replayed}
export function addMessages({ dir = DATA_DIR, userId, sessionId = '', requestId, messages }) {
  if (!userId) throw new Error('user_id 必填');
  if (!requestId) throw new Error('request_id 必填');
  if (!dir) throw new Error('数据目录没给');
  const list = Array.isArray(messages) ? messages.filter((m) => m && typeof m === 'object') : [];
  const payloadSha = sha(JSON.stringify({ user_id: userId, session_id: sessionId, messages: list.map((m) => ({ role: m.role, content: m.content, timestamp: m.timestamp ?? null })) }));

  const { segs: existing, reqs } = readUser(dir, userId);
  const seen = reqs.get(requestId);
  if (seen) {
    if (seen.payload_sha !== payloadSha) {
      throw new AddConflict(`request_id ${requestId} 已经用过，内容和这次不一样——拒绝写入`);
    }
    return { response: { success: true, replayed: true, added: 0, request_id: requestId }, segs: [], replayed: true };
  }

  const kept = list.filter((m) => String(m.content ?? '').trim());
  const skipped = list.length - kept.length;

  const sameSession = existing.filter((s) => s.session_id === sessionId);
  const startSeq = sameSession.length ? Math.max(...sameSession.map((s) => s.seq)) + 1 : 1;
  let sessionLast = null;
  for (const s of sameSession) {
    if (s.ts && (!sessionLast || s.ts > sessionLast.ts)) sessionLast = { ts: s.ts, granularity: s.granularity };
  }

  const segs = buildSegments({ userId, sessionId, requestId, messages: kept, startSeq, sessionLast });
  const response = { success: true, added: segs.length, messages: kept.length, skipped, request_id: requestId, session_id: sessionId };
  const recs = [
    { k: 'req', request_id: requestId, user_id: userId, payload_sha: payloadSha, at: new Date().toISOString(), added: segs.length, response },
    ...segs,
  ];
  appendLines(userPath(dir, userId), recs);
  return { response, segs, replayed: false };
}

export function userStats(dir, userId) {
  const { segs, reqs, vecs, bad, file } = readUser(dir, userId);
  const sessions = new Set(segs.map((s) => s.session_id));
  const ts = segs.map((s) => s.ts).filter(Boolean).sort();
  return {
    file, segments: segs.length, vectors: vecs.size, requests: reqs.size, steps: sessions.size,
    chars: segs.reduce((a, s) => a + (s.chars || 0), 0),
    first_ts: ts[0] || null, last_ts: ts[ts.length - 1] || null,
    bad_lines: bad,
  };
}
