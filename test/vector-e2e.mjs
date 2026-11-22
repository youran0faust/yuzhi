// 鱼知 · 向量门端到端
// 契约测试测的是「函数对不对」，这个测的是「链通不通」：
// 真的起一个 embedding HTTP 服务 → 真发请求 → 真编码 → 真落盘 → 真读回来 → 真参与融合。
// 仍然不证明「语义好不好」——服务端用的是字符哈希向量，它只能证明管道没漏。
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { addMessages, readUser, appendVecs } from '../src/store.mjs';
import { buildIndex, search } from '../src/recall.mjs';
import { encodeVec, decodeVecs, embedderFromEnv, makeHashEmbedder } from '../src/embedding.mjs';

const PORT = Number(process.env.E2E_PORT || 8899);
const hashEmb = makeHashEmbedder(64);

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.method === 'POST' && req.url === '/v1/embeddings') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        res.writeHead(400); res.end('bad json'); return;
      }
      const input = Array.isArray(body.input) ? body.input : [body.input];
      const vecs = await hashEmb.embed(input);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: vecs.map((v) => ({ embedding: v })) }));
    });
    return;
  }
  res.writeHead(404);
  res.end('no');
});

await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const base = 'http://127.0.0.1:' + PORT + '/v1';
process.env.UNCLOSED_EMBED_URL = base;
process.env.UNCLOSED_EMBED_MODEL = 'hash-e2e';

const emb = embedderFromEnv();
assert.ok(emb, 'embedderFromEnv 应该读到刚设的环境变量');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuzhi-e2e-'));
const userId = 'e2e';
addMessages({ dir, userId, sessionId: 'e2e', requestId: 'r1', messages: [
  { role: 'user', content: '第一句随便写点什么' },
  { role: 'user', content: '第二句完全另一件事' },
  { role: 'user', content: '第三句也无关' },
] });

// 模拟 embed.mjs 干的事：算出来、编码、追加。
const { segs } = readUser(dir, userId);
const vectors = await emb.embed(segs.map((s) => s.text));
appendVecs(dir, userId, segs.map((s, i) => ({ id: s.id, model: 'hash-e2e', dim: vectors[i].length, v: encodeVec(vectors[i]) })));

const again = readUser(dir, userId);
assert.equal(again.vecs.size, 3, '向量应该落盘并读得回来');
assert.equal(again.segs.length, 3, '加向量不该动原文的段数');

// 走 server 那条路：decode → buildIndex → 算 query → search。
const decoded = decodeVecs(again.vecs);
assert.equal(decoded.bad.length, 0, '落盘的向量不该解不开');
const index = buildIndex(again.segs);
const q = '第二句完全另一件事';
const qv = (await emb.embed([q]))[0];
const out = search(index, q, { topK: 5, queryVec: qv, vecs: decoded.vecs });
assert.ok(out.meta.doors.vector > 0, 'vector 门应该报出候选数');
assert.equal(out.data.length > 0, true);
assert.equal(out.data[0].id, 'e2e#2.1', '同文本的段应该排第一');
assert.equal(out.meta.skipped.some((s) => s.startsWith('vector:')), false, '真接上时不该再报 skipped');

// 不给 queryVec 时如实降级，并说清缺哪一样。
const plain = search(index, q, { topK: 5, vecs: decoded.vecs });
assert.equal(plain.meta.doors.vector, null);
assert.equal(plain.meta.skipped.some((s) => s.startsWith('vector:')), true);

// 服务连不上必须抛错，不许静默返回空——静默的空会被当成「没有结果」。
process.env.UNCLOSED_EMBED_URL = 'http://127.0.0.1:' + (PORT + 1) + '/v1';
const dead = embedderFromEnv();
let deadErr = null;
try {
  await dead.embed(['x']);
} catch (e) {
  deadErr = e;
}
assert.ok(deadErr, '连不上应该抛错');

const health = await new Promise((resolve) => {
  http.get('http://127.0.0.1:' + PORT + '/health', (res) => {
    const c = [];
    res.on('data', (d) => c.push(d));
    res.on('end', () => resolve(JSON.parse(Buffer.concat(c).toString('utf8') || '{}')));
  });
});
assert.equal(health.ok, true);

await new Promise((r) => server.close(r));
console.log('vector-e2e: PASS（HTTP 通路 / 落盘 / 读回 / 融合 / 降级 / 连不上会报错）');
