// 鱼知 · 契约自测
// 只测「写对了没有」，不测「好不好用」。
// 每条断言都要能改成一个会失败的版本，否则它只是安慰。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { addMessages, readUser, AddConflict, userStats } from '../src/store.mjs';
import { buildIndex, search, bm25Door, literalDoor, dateDoor, neighborDoor, rrfFuse, caseHooks, pack, vectorDoor } from '../src/recall.mjs';
import { encodeVec, decodeVec, cosine, embedderFromEnv } from '../src/embedding.mjs';
import { countTokens, splitLong, sentenceSpans, tokenize, parseDateQuery, speakerPrefix, tsFromMs, dateHeader } from '../src/text.mjs';

let pass = 0;
let fail = 0;
const failed = [];
function ok(name, fn) {
  try { fn(); pass += 1; } catch (e) { fail += 1; failed.push(`${name} -> ${String(e.message).split('\n')[0]}`); }
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'yuzhi-test-'));

ok('切句切回去等于原文', () => {
  const s = '第一句。第二句！Third one. Fourth one? 第五句';
  assert.equal(sentenceSpans(s).map(([a, b]) => s.slice(a, b)).join(''), s);
});
ok('中文句号后面没空格也能切开', () => {
  assert.equal(sentenceSpans('甲。乙。丙。').length, 3);
});
ok('长文本切子段：拼回去是原文', () => {
  const body = Array.from({ length: 40 }, (_, i) => `第${i}句，内容是这样的。`).join('');
  const parts = splitLong(body, 30);
  assert.ok(parts.length > 1);
  assert.equal(parts.join(''), body);
});
ok('短文本不切', () => { assert.deepEqual(splitLong('一句话。', 400), ['一句话。']); });
ok('token 估计随长度增长', () => {
  assert.ok(countTokens('hello') > 0);
  assert.ok(countTokens('中文很长很长很长') > countTokens('中文'));
});
ok('分词：中文按二元组', () => {
  const t = tokenize('记忆系统');
  assert.ok(t.includes('记忆') && t.includes('忆系') && t.includes('系统'));
});
ok('说话人前缀：认 Name:，不认 Note:，也不瞎认中文名', () => {
  assert.equal(speakerPrefix('Alice: hi'), 'Alice');
  assert.equal(speakerPrefix('Note: hi'), null);
  assert.equal(speakerPrefix('阿肥: 早'), null);
});
ok('时间：0 点算只有日期', () => {
  assert.equal(tsFromMs(Date.UTC(2026, 10, 21, 0, 0, 0)).granularity, 'date');
  assert.equal(tsFromMs(Date.UTC(2026, 10, 21, 7, 5, 0)).granularity, 'datetime');
  assert.equal(tsFromMs(null).granularity, 'unknown');
});
ok('时间：秒和毫秒都认，离谱的不认', () => {
  assert.equal(tsFromMs(1763555400000).ts, tsFromMs(1763555400).ts);
  assert.equal(tsFromMs(1e16).ts, null);
});
ok('问句认时间', () => {
  assert.deepEqual(parseDateQuery('2026-11-19 那天'), { y: 2026, mo: 11, d: 19, precision: 'day' });
  assert.equal(parseDateQuery('11月19号晚上').mo, 11);
  assert.equal(parseDateQuery('2026年').precision, 'year');
  assert.equal(parseDateQuery('端口是多少'), null);
});
ok('日期头', () => {
  assert.equal(dateHeader('2026-11-19T14:15:00.000Z', 'datetime', 's1'), '[2026-11-19 (Thu) 14:15]');
  assert.match(dateHeader(null, 'unknown', 's1'), /date unknown/);
});

// —— 存储层 ——
ok('写入：id 形如 session#seq.part', () => {
  const dir = tmp();
  const out = addMessages({ dir, userId: 'u1', sessionId: 's1', requestId: 'r1', messages: [
    { role: 'user', content: 'Alice: 早上好' },
    { role: 'assistant', content: '早' },
  ] });
  assert.equal(out.response.added, 2);
  const { segs } = readUser(dir, 'u1');
  assert.equal(segs[0].id, 's1#1.1');
  assert.equal(segs[1].id, 's1#2.1');
});
ok('写入：同一 request_id 同一内容不重复写', () => {
  const dir = tmp();
  const args = { dir, userId: 'u2', sessionId: 's', requestId: 'r', messages: [{ role: 'user', content: '甲' }] };
  addMessages(args);
  assert.equal(addMessages(args).replayed, true);
  assert.equal(readUser(dir, 'u2').segs.length, 1);
});
ok('写入：同一 request_id 换了内容就拒绝', () => {
  const dir = tmp();
  addMessages({ dir, userId: 'u3', sessionId: 's', requestId: 'r', messages: [{ role: 'user', content: '甲' }] });
  assert.throws(() => addMessages({ dir, userId: 'u3', sessionId: 's', requestId: 'r', messages: [{ role: 'user', content: '乙' }] }), AddConflict);
  assert.equal(readUser(dir, 'u3').segs.length, 1);
});
ok('写入：空内容跳过并报数', () => {
  const dir = tmp();
  const out = addMessages({ dir, userId: 'u4', sessionId: 's', requestId: 'r', messages: [
    { role: 'user', content: '有内容' }, { role: 'user', content: '   ' },
  ] });
  assert.equal(out.response.added, 1);
  assert.equal(out.response.skipped, 1);
});
ok('写入：seq 接着走不重号', () => {
  const dir = tmp();
  addMessages({ dir, userId: 'u5', sessionId: 's', requestId: 'r1', messages: [{ role: 'user', content: 'a' }] });
  addMessages({ dir, userId: 'u5', sessionId: 's', requestId: 'r2', messages: [{ role: 'user', content: 'b' }] });
  assert.deepEqual(readUser(dir, 'u5').segs.map((x) => x.seq), [1, 2]);
});
ok('时间：缺的向后借；整包没有就留 null', () => {
  const dir = tmp();
  const t = Date.UTC(2026, 10, 19, 14, 15);
  addMessages({ dir, userId: 'u6', sessionId: 's', requestId: 'r1', messages: [
    { role: 'user', content: 'a', timestamp: t },
    { role: 'user', content: 'b' },
  ] });
  const segs = readUser(dir, 'u6').segs;
  assert.equal(segs[1].ts, segs[0].ts);
  assert.equal(segs[1].provenance, 'inherited');
  const dir2 = tmp();
  addMessages({ dir: dir2, userId: 'u7', sessionId: 's', requestId: 'r1', messages: [{ role: 'user', content: 'a' }] });
  assert.equal(readUser(dir2, 'u7').segs[0].ts, null);
});
ok('用户文件用哈希命名，user_id 不进路径', () => {
  const dir = tmp();
  addMessages({ dir, userId: '../../evil', sessionId: 's', requestId: 'r', messages: [{ role: 'user', content: 'x' }] });
  const files = fs.readdirSync(dir);
  assert.equal(files.length, 1);
  assert.match(files[0], /^[0-9a-f]{16}\.jsonl$/);
});
ok('坏行不丢，数出来', () => {
  const dir = tmp();
  addMessages({ dir, userId: 'u8', sessionId: 's', requestId: 'r', messages: [{ role: 'user', content: 'x' }] });
  fs.appendFileSync(path.join(dir, fs.readdirSync(dir)[0]), '{不是 json}\n');
  assert.equal(readUser(dir, 'u8').bad.length, 1);
  assert.equal(userStats(dir, 'u8').segments, 1);
});

// —— 检索层 ——
function seed(dir, userId, msgs, sessionId = 's1', requestId = 'r1') {
  addMessages({ dir, userId, sessionId, requestId, messages: msgs });
}

ok('BM25：命中关键词的那段排第一', () => {
  const dir = tmp();
  seed(dir, 'q1', [
    { role: 'user', content: 'VoiceStudio 起在 3900 端口' },
    { role: 'user', content: '今天天气不错' },
  ]);
  const idx = buildIndex(readUser(dir, 'q1').segs);
  assert.equal(bm25Door(idx, '端口是多少')[0].id, 's1#1.1');
});
ok('字面守卫：原话出现过才给分', () => {
  const dir = tmp();
  seed(dir, 'q2', [
    { role: 'user', content: '工程只认 48 kHz，那还得过一道重采样。' },
    { role: 'user', content: '完全不相干的一句话。' },
  ]);
  const idx = buildIndex(readUser(dir, 'q2').segs);
  assert.equal(literalDoor(idx, '工程只认 48 kHz 吗')[0].id, 's1#1.1');
});
ok('时间门：问句没时间就返回 null（不是空数组）', () => {
  const dir = tmp();
  seed(dir, 'q3', [{ role: 'user', content: '随便', timestamp: Date.UTC(2026, 10, 19) }]);
  const idx = buildIndex(readUser(dir, 'q3').segs);
  assert.equal(dateDoor(idx, '端口是多少'), null);
  assert.ok(Array.isArray(dateDoor(idx, '11月19号那天')));
});
ok('融合：多门命中的那段会往前排', () => {
  const dir = tmp();
  seed(dir, 'q4', [
    { role: 'user', content: 'Alice: 重采样那件事先做，48 kHz 才对。' },
    { role: 'user', content: '重采样以外的事都往后放。' },
  ]);
  const idx = buildIndex(readUser(dir, 'q4').segs);
  const out = search(idx, 'Alice 说的重采样', { topK: 10 });
  assert.ok(out.data.length > 0);
  assert.ok(out.data[0].why.some((w) => w.startsWith('bm25')));
});
ok('预算装不下就整条跳过，不给半条', () => {
  const dir = tmp();
  seed(dir, 'q5', [{ role: 'user', content: '这是一段比较长的内容，'.repeat(50) }]);
  const idx = buildIndex(readUser(dir, 'q5').segs);
  assert.equal(pack(bm25Door(idx, '内容'), idx, { topK: 10, budgetTokens: 5 }).length, 0);
});
ok('空问句给空结果，不报错', () => {
  const dir = tmp();
  seed(dir, 'q6', [{ role: 'user', content: 'x' }]);
  assert.equal(search(buildIndex(readUser(dir, 'q6').segs), '   ').data.length, 0);
});
ok('content 形如 [日期] 说话人: 正文，且不重复说话人', () => {
  const dir = tmp();
  seed(dir, 'q7', [{ role: 'user', content: 'Alice: 收到', timestamp: Date.UTC(2026, 10, 19, 14, 15) }]);
  const idx = buildIndex(readUser(dir, 'q7').segs);
  const it = search(idx, '收到', { topK: 5 }).data[0];
  assert.match(it.content, /^\[[^\]]+\]\s+[^:]+:\s*/);
  assert.equal(it.content, '[2026-11-19 (Thu) 14:15] Alice: 收到');
  assert.ok(it.created_at, '应该带 created_at');
});

// —— 邻居门 ——
ok('邻居门：同一个邻居只算一票（多个 seed 指到它时不许刷票）', () => {
  const rows = [1, 2, 3].map((seq) => ({ id: 'nb#3.' + seq, session_id: 'nb', seq, part: 1, text: 'x' }));
  const idx = { byId: new Map(rows.map((r) => [r.id, r])), bySession: new Map([['nb', rows]]) };
  // #1 和 #3 的邻居都是 #2：没去重时它一次拿两票，排到最相关的前面去。
  const nb1 = neighborDoor(idx, ['nb#3.1', 'nb#3.3'], 1);
  assert.equal(nb1.length, 1);
  assert.equal(nb1[0].id, 'nb#3.2');
  // 深度 2 时邻居会变多（±2 把两头也拉进来），但同一段仍然只出现一次。
  const ids2 = neighborDoor(idx, ['nb#3.1', 'nb#3.3'], 2).map((r) => r.id);
  assert.equal(ids2.length, 3);
  assert.equal(new Set(ids2).size, ids2.length, '同一段被多个 seed 指到时不许重复出现');
});
ok('RRF 加权：邻居门降权后，只挨着的票不再顶掉正门第 10 名', () => {
  const bm = Array.from({ length: 10 }, (_, i) => ({ id: 'S' + i }));
  const nb = [{ id: 'x' }, { id: 'n' }]; // n 落在邻居门第 2 位
  const scoreOf = (list, id) => list.find((r) => r.id === id).score;
  const flat = rrfFuse([['bm25', bm], ['neighbor', nb]]);
  const half = rrfFuse([['bm25', bm], ['neighbor', nb]], undefined, { neighbor: 0.5 });
  assert.ok(scoreOf(flat, 'n') > scoreOf(flat, 'S9'), '平权时邻居第 2 名赢过正门第 10 名');
  assert.ok(scoreOf(half, 'n') < scoreOf(half, 'S9'), '降权后正门第 10 名反而赢');
});

// —— 向量门 ——
// 只测「接缝通没通、断了说不说得清」，不测「排序好不好」——那是语义模型的事，
// 拿一个按字符哈希造出来的向量证明不了任何语义结论。
ok('向量门：没给 query 向量就如实标 skipped，并说清缺的是哪一样', () => {
  const idx = { segs: [{ id: 'a', text: 'x' }] };
  const r = vectorDoor(idx, null, new Map([['a', { model: 'm', dim: 2, v: [1, 0] }]]));
  assert.equal(r.skipped, true);
  assert.match(r.reason, /query vector 没给/);
});
ok('向量门：有 query 但库里的段没算过向量 → 提示先跑 embed.mjs', () => {
  const idx = { segs: [{ id: 'a', text: 'x' }] };
  const r = vectorDoor(idx, [1, 0], new Map());
  assert.equal(r.skipped, true);
  assert.match(r.reason, /embed\.mjs/);
});
ok('向量门：同一方向的段排第一（余弦真的在算）', () => {
  const idx = { segs: [{ id: 'a' }, { id: 'b' }] };
  const vecs = new Map([
    ['a', { model: 'm', dim: 2, v: [1, 0] }],
    ['b', { model: 'm', dim: 2, v: [0, 1] }],
  ]);
  const r = vectorDoor(idx, [1, 0], vecs);
  assert.equal(r.list[0].id, 'a');
  assert.equal(r.list[0].score, 1);
  assert.equal(r.list.length, 1, '正交的段余弦是 0，不该进榜');
});
ok('向量门：维度对不上的段跳过并报数，不拿错的数糊排序', () => {
  const idx = { segs: [{ id: 'a' }, { id: 'b' }] };
  const vecs = new Map([
    ['a', { model: 'm', dim: 2, v: [1, 0] }],
    ['b', { model: 'm', dim: 3, v: [1, 0, 0] }],
  ]);
  const r = vectorDoor(idx, [1, 0], vecs);
  assert.equal(r.list.length, 1);
  assert.equal(r.dimMismatch, 1);
});
ok('向量编码：base64 往返回来还是那串数（float32 精度内）', () => {
  const arr = [0.5, -1.25, 3.75];
  const back = decodeVec(encodeVec(arr), 3);
  assert.deepEqual(back.map((x) => Number(x.toFixed(5))), arr);
});
ok('余弦：同向 1、正交 0、零向量 0（零向量不许除出 NaN）', () => {
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.equal(cosine([0, 0], [1, 0]), 0);
});
ok('没配 UNCLOSED_EMBED_URL 时返回 null：没配不等于配错', () => {
  assert.equal(embedderFromEnv({}), null);
  assert.ok(embedderFromEnv({ UNCLOSED_EMBED_URL: 'http://127.0.0.1:9/v1' }));
});
ok('融合：字面一个字都不重合的段，靠向量门也能捞上来', () => {
  const dir = tmp();
  seed(dir, 'v1', [
    { role: 'user', content: '完全不相干的一句话，一个词都不重合' },
    { role: 'user', content: '另一句毫不相关的话' },
  ]);
  const idx = buildIndex(readUser(dir, 'v1').segs);
  const vecs = new Map([
    ['s1#1.1', { model: 'm', dim: 2, v: [1, 0] }],
    ['s1#2.1', { model: 'm', dim: 2, v: [0, 1] }],
  ]);
  // 问句和两段没有共享 token，BM25 / 字面门都拿不到分；只有向量门有话说。
  const out = search(idx, '那是怎样的感受', { topK: 5, queryVec: [1, 0], vecs });
  assert.equal(out.data.length > 0, true);
  assert.equal(out.data[0].id, 's1#1.1');
  assert.ok(out.meta.doors.vector > 0);
});
ok('向量门真接上时，meta 里不再把它列进 skipped', () => {
  const dir = tmp();
  seed(dir, 'v2', [{ role: 'user', content: '随便一句' }]);
  const idx = buildIndex(readUser(dir, 'v2').segs);
  const vecs = new Map([['s1#1.1', { model: 'm', dim: 2, v: [1, 0] }]]);
  const out = search(idx, '随便一句', { topK: 5, queryVec: [1, 0], vecs });
  assert.equal(out.meta.doors.vector, 1);
  assert.equal(out.meta.skipped.some((s) => s.startsWith('vector:')), false);
});

// —— 悬案层 ——
ok('悬案挂载：碰到还没闭合的事会挂出来', () => {
  const cases = [
    { id: 'X-001', state: 'unresolved', q: '配音能不能真的进工程，重采样接没接上', subjects: ['重采样', '配音'] },
    { id: 'X-002', state: 'resolved', q: '重采样已经接上了', subjects: ['重采样'] },
  ];
  const hooks = caseHooks('那个重采样接上了没有', cases);
  assert.equal(hooks.length, 1);
  assert.equal(hooks[0].id, 'X-001');
});
ok('悬案挂载：已闭合的不挂', () => {
  const cases = [{ id: 'X-9', state: 'resolved', q: '重采样已经接上了', subjects: ['重采样'] }];
  assert.equal(caseHooks('重采样接上了没有', cases).length, 0);
});
ok('悬案挂载：不相干的问句不挂', () => {
  const cases = [{ id: 'X-1', state: 'unresolved', q: '重采样接没接上', subjects: [] }];
  assert.equal(caseHooks('今天吃什么', cases).length, 0);
});
ok('悬案挂载：搁下过的照样挂得出来（abandoned 是静音，不是删除）', () => {
  const cases = [{ id: 'X-3', state: 'abandoned', q: '配音进不进工程，重采样接没接上', subjects: [] }];
  const hooks = caseHooks('重采样接没接上，配音进工程', cases);
  assert.equal(hooks.length, 1);
  assert.equal(hooks[0].state, 'abandoned');
});
ok('悬案挂载：abandoned 的门槛比 unresolved 高（沾边的句子不许把搁下的事吵醒）', () => {
  const q = '重采样这种';
  const open = [{ id: 'X-1', state: 'unresolved', q: '重采样接没接上', subjects: [] }];
  const shut = [{ id: 'X-1', state: 'abandoned', q: '重采样接没接上', subjects: [] }];
  assert.equal(caseHooks(q, open).length, 1);
  assert.equal(caseHooks(q, shut).length, 0);
});
ok('悬案挂载：还挂着的排在搁下过的前面', () => {
  const cases = [
    { id: 'X-9', state: 'abandoned', q: '配音进不进工程，重采样接没接上', subjects: [] },
    { id: 'X-1', state: 'unresolved', q: '重采样接没接上', subjects: [] },
  ];
  const hooks = caseHooks('重采样接没接上，配音进工程', cases);
  assert.equal(hooks.length, 2);
  assert.equal(hooks[0].state, 'unresolved');
});

ok('交叉验证：多门同指的那段带票数，不是只给一个名次', () => {
  const dir = tmp();
  seed(dir, 'q6', [
    { role: 'user', content: '重采样那件事先做，48 kHz 才对' },
    { role: 'user', content: '重采样以外的事都往后放' },
    { role: 'user', content: '今天天气不错' },
  ]);
  const idx = buildIndex(readUser(dir, 'q6').segs);
  const out = search(idx, '重采样要过 48 kHz 吗', { topK: 10 });
  assert.ok(out.data.length > 0);
  assert.ok(out.meta.witnesses >= 2);
  assert.equal(out.meta.agreementK, 10);
  assert.ok(out.data[0].agreement >= 2);
  assert.ok(['multi', 'pair', 'single', 'none'].includes(out.data[0].agreement_level));
});

// —— 汇总 ——
const total = pass + fail;
console.log(`${pass}/${total} PASS`);
if (fail) {
  console.log('失败项：');
  for (const f of failed) console.log(`  - ${f}`);
  process.exit(1);
}
