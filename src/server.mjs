// 鱼知 · HTTP 服务
// 三个口：GET /health、POST /add、POST /search。
// 字段照 khipu 那套（它是五家里唯一有官方分的，照它的口写，回放脚本才不用改）。
// 额外多给几个字段（meta / open_questions），不算破坏契约：多出来的字段接手方会忽略。
import fs from 'node:fs';
import http from 'node:http';
import { addMessages, readUser, userStats, AddConflict, DATA_DIR, userPath } from './store.mjs';
import { buildIndex, search as runSearch, DEFAULT_TOP_K, renderContent } from './recall.mjs';
import { eventRoute } from './event.mjs';
import { hookCases, defaultCaseFile } from './cases.mjs';
import { embedderFromEnv, decodeVecs } from './embedding.mjs';

// 改名（2026-11-22 未结 → 鱼知）：新名 YUZHI_* 先认，旧名 UNCLOSED_* 兜底。
const pickEnv = (name) => process.env['YUZHI_' + name] ?? process.env['UNCLOSED_' + name];
const PORT = Number(pickEnv('PORT') || 8850);
const TOKEN = pickEnv('TOKEN') || '';
// 向量门是可选的加料：没配 YUZHI_EMBED_URL（旧名 UNCLOSED_EMBED_URL）就是 null，搜索照常跑，只是如实标 skipped。
const EMBED = embedderFromEnv();
// 事件层每轮要算「事件句 ↔ 可见轮次」的余弦，同一段话会被反复问（历史轮次尤其），按文本缓存。
// 两个口径分开缓存：事件句走 query（bge 要加前缀），可见轮次走 doc（不加）——混用余弦会整体抬高、排序会歪。
const vecCacheQuery = new Map();
const vecCacheDoc = new Map();
async function embedWith(cacheMap, fn, texts) {
  const need = [];
  const hit = new Map();
  for (const t of texts) {
    if (cacheMap.has(t)) hit.set(t, cacheMap.get(t));
    else if (!need.includes(t)) need.push(t);
  }
  if (need.length) {
    const got = await fn(need);
    for (let i = 0; i < need.length; i++) {
      cacheMap.set(need[i], got[i]);
      hit.set(need[i], got[i]);
    }
    if (cacheMap.size > 50000) cacheMap.clear(); // 粗暴但有界：缓存是加速手段，不是记忆
  }
  return texts.map((t) => hit.get(t));
}
const embedDoc = (texts) => embedWith(vecCacheDoc, EMBED.embed, texts);
const embedQueryCached = (texts) => embedWith(vecCacheQuery, EMBED.embedQuery, texts);

const cache = new Map(); // user_id → { index, vecs, badVecs, at }

function indexFor(userId) {
  const file = userPath(DATA_DIR, userId);
  let mtime = 0;
  try {
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    mtime = 0;
  }
  const hit = cache.get(userId);
  if (hit && hit.mtime === mtime) return hit;
  const { segs, vecs } = readUser(DATA_DIR, userId);
  const decoded = decodeVecs(vecs);
  const entry = { index: buildIndex(segs), vecs: decoded.vecs, badVecs: decoded.bad, mtime, at: Date.now() };
  cache.set(userId, entry);
  return entry;
}

function json(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(s) });
  res.end(s);
}

function readBody(req, limit = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (e) {
        reject(new Error(`bad json: ${e.message}`));
      }
    });
    req.on('error', reject);
  });
}

function authed(req) {
  if (!TOKEN) return true;
  const h = req.headers.authorization || '';
  const k = req.headers['x-api-key'] || '';
  return h === `Bearer ${TOKEN}` || k === TOKEN;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, {
        ok: true,
        service: 'yuzhi',
        data_dir: DATA_DIR,
        embedder: EMBED ? { configured: true, model: EMBED.model, dim: EMBED.dim } : { configured: false },
      });
    }
    if (req.method === 'GET' && url.pathname === '/stats') {
      const uid = url.searchParams.get('user_id') || '';
      if (!uid) return json(res, 400, { error: 'user_id required' });
      return json(res, 200, userStats(DATA_DIR, uid));
    }
    if (!authed(req)) return json(res, 401, { error: 'unauthorized' });

    if (req.method === 'POST' && url.pathname === '/add') {
      const body = await readBody(req);
      if (!body.user_id) return json(res, 400, { error: 'user_id required' });
      if (!body.request_id) return json(res, 400, { error: 'request_id required' });
      try {
        const out = addMessages({
          userId: String(body.user_id),
          sessionId: String(body.session_id ?? ''),
          requestId: String(body.request_id),
          messages: body.messages,
        });
        if (out.response.added > 0) cache.delete(String(body.user_id));
        return json(res, 200, out.response);
      } catch (e) {
        if (e instanceof AddConflict) return json(res, 409, { error: e.message, code: e.code });
        throw e;
      }
    }

    if (req.method === 'POST' && url.pathname === '/search') {
      const body = await readBody(req);
      if (!body.user_id) return json(res, 400, { error: 'user_id required' });
      const query = String(body.query ?? '');
      const options = Array.isArray(body.options) ? body.options : body.options ? [body.options] : null;
      if (!query.trim() && !options) return json(res, 200, { data: [], meta: { query, reason: 'empty query' } });
      const topK = Number.isFinite(body.top_k) && body.top_k > 0 ? Math.floor(body.top_k) : DEFAULT_TOP_K;
      const entry = indexFor(String(body.user_id));
      // 悬案表跟着检索一起挂出来：没闭合的事不许只活在命令行里。
      const cases = hookCases(defaultCaseFile()).cases;
      // 每次搜索算一次 query 向量。失败不吞：降级成无向量，但把原因写进 meta.skipped，
      // 不然配错了的地方会安静一辈子，而安静的错比报出来的错更难查。
      let queryVec = null;
      let vecError = null;
      if (EMBED && query.trim()) {
        try {
          queryVec = (await EMBED.embedQuery([query]))[0];
        } catch (e) {
          vecError = e;
        }
      }
      const out = runSearch(entry.index, query, { topK, options, cases, queryVec, vecs: entry.vecs });
      if (vecError) out.meta.skipped.push('vector: 算 query 向量失败（' + String((vecError && vecError.message) || vecError) + '）');
      if (entry.badVecs.length) out.meta.skipped.push('vector: ' + entry.badVecs.length + ' 条段向量解不开，已跳过');

      // —— 事件层（三次触发的第二三步）：门 → 事件句 → 锚点 → 字面尾巴 → 单独一块 ——
      // 门只看问题 + 可见轮次，不调模型、不查向量。可见轮次=调用方给的这段对话现在看得到的那些轮；
      // 没给也没有 session_id 就不跑：门判的就正是「问题在可见轮次里有没有落点」，没有它无从判，
      // 所以如实写进 meta.skipped，不假装关、也不静默降级。
      let ev = null;
      if (body.event !== false) {
        let visible = body.visible;
        if (!visible && body.session_id) {
          const n = Number.isFinite(body.event_visible) ? Math.max(1, Math.floor(body.event_visible)) : 12;
          const segs = entry.index.bySession.get(String(body.session_id)) || [];
          visible = segs.slice(-n).map((s) => ({ id: s.id, text: renderContent(s) }));
        }
        if (!visible || !visible.length) {
          out.meta.skipped.push('event: 没给可见轮次（visible 或 session_id），门不跑');
        } else {
          const evOut = await eventRoute(entry.index, query, {
            visible,
            statements: body.event_statements ?? body.event_statement ?? null,
            embed: EMBED ? embedDoc : null,
            embedQuery: EMBED ? embedQueryCached : null,
            excludeIds: new Set(out.data.map((d) => String(d.id))),
          });
          ev = { fire: evOut.fire, mode: evOut.mode, picked: evOut.picked, skipped: evOut.meta.skipped };
          if (evOut.meta.anchors.length) ev.anchors = evOut.meta.anchors;
          if (evOut.rows.length) {
            ev.block = { statement: evOut.statements.join(' / '), mode: evOut.mode, rows: evOut.rows };
          }
        }
      }
      return json(res, 200, { data: out.data, meta: { ...out.meta, event: ev } });

    }

    return json(res, 404, { error: 'not found' });
  } catch (e) {
    return json(res, 500, { error: String(e && e.message ? e.message : e) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`鱼知 listening on http://127.0.0.1:${PORT}  (data: ${DATA_DIR})`);
});
