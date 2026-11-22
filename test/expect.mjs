// 期望结果对照：给一段合成对话 + 一张「应该取回哪几条」的固定答案，真跑一遍比对。
// 期望是先指着对话读出来、写死的。跑不中就是没中——不许回头改期望去迁就结果。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSegments } from '../src/store.mjs';
import { buildIndex, search } from '../src/recall.mjs';
import { conversationMessages } from '../src/replay.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const exp = JSON.parse(fs.readFileSync(path.join(root, 'examples', 'expected-demo.json'), 'utf8'));
const convs = JSON.parse(fs.readFileSync(path.join(root, 'examples', exp.conversation), 'utf8'));
const conv = Array.isArray(convs) ? convs[0] : convs;
const msgs = conversationMessages(conv);
const seqToDia = new Map(msgs.map((m, i) => [i + 1, m.dia_id || 'msg#' + (i + 1)]));
const segs = buildSegments({ userId: exp.user, sessionId: 'demo', requestId: 'expect', messages: msgs, startSeq: 1, sessionLast: null });
const index = buildIndex(segs);

function diaOf(segId) {
  const m = /#(\d+)\./.exec(segId);
  return m ? (seqToDia.get(Number(m[1])) || segId) : segId;
}

let pass = 0;
let fail = 0;
for (const c of exp.cases) {
  const r = search(index, c.q, { topK: 100, budgetTokens: 200000 });
  const got = r.data.map((d) => diaOf(d.id));
  // ★ 必须看名次，不能只看「在不在」：预算给大了会把整段对话全装进结果，那种「在」什么也证明不了。
  const top = got.slice(0, 3);
  const hit = (c.must || []).every((m) => top.includes(m));
  if (hit) pass += 1; else fail += 1;
  console.log((hit ? 'PASS ' : 'MISS ') + c.q);
  console.log('     必须进前三 ' + (c.must || []).join(',') + ' · 实际前三 ' + (top.join(',') || '(空)'));
  if (!hit) console.log('     —— 没中。原因写在上面两行里，不改期望。');
}
console.log('');
console.log('对照表 ' + pass + '/' + (pass + fail) + ' 进前三（对话共 ' + segs.length + ' 段）');
if (fail) process.exit(1);

