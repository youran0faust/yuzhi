// 鱼知 · 信心分校准：标 strong 的那条，到底有多少真是金标
// 这不是排名实验，是「把这个数给人看，人会不会被误导」的检查。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addMessages, readUser } from '../src/store.mjs';
import { buildIndex, search } from '../src/recall.mjs';
import { conversationMessages, chunks } from '../src/replay.mjs';

const raw = JSON.parse(fs.readFileSync(process.argv[2] || 'data/locomo10.json', 'utf8'));
const data = Array.isArray(raw) ? raw : [raw];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yuzhi-trust-'));
const TOP = 10;

const byLabel = new Map();
let questions = 0;
let hitByLabel = new Map();

let ci = -1;
for (const conv of data) {
  ci += 1;
  const userId = 't:conv-' + ci;
  const sessionId = 't:s' + ci;
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
    const res = search(idx, qa.question, { topK: TOP, budgetTokens: Number.MAX_SAFE_INTEGER });
    questions += 1;
    const seen = new Set();
    for (const it of res.data) {
      const c = it.agreement_level || 'none';
      if (!byLabel.has(c)) byLabel.set(c, { items: 0, gold: 0 });
      const b = byLabel.get(c);
      b.items += 1;
      if (goldIds.has(it.id)) {
        b.gold += 1;
        if (!seen.has(c)) { seen.add(c); hitByLabel.set(c, (hitByLabel.get(c) || 0) + 1); }
      }
    }
  }
}

console.log('题目 ' + questions + ' / 每题返回前 ' + TOP + ' 条\n');
console.log('  信心档      返回条目    其中是金标    精确率      多少题至少命中一条');
const order = ['multi', 'pair', 'single', 'none'];
for (const c of order) {
  const b = byLabel.get(c);
  if (!b) continue;
  const prec = ((b.gold / b.items) * 100).toFixed(1);
  const hit = hitByLabel.get(c) || 0;
  console.log('  ' + c.padEnd(10) + String(b.items).padStart(6) + ' 条  ' + String(b.gold).padStart(6) + ' 条  ' + (prec + '%').padStart(8) + '    ' + hit + ' 题（' + ((hit / questions) * 100).toFixed(1) + '%）');
}
fs.rmSync(tmp, { recursive: true, force: true });
