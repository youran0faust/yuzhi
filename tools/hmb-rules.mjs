// 鱼知 · hive-memory-bench 规则作答（六元素共现判定）
// 自检：三条已知假断言必须判「否」，否则脚本自己就不可信。
import fs from 'node:fs';
import { buildIndex, search } from '../src/recall.mjs';

const B = 'data/hive-memory-bench';
const CN = { 一:1,二:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9,十:10,十一:11,十二:12,十三:13,十四:14,十五:15,十六:16,十七:17,十八:18,十九:19,二十:20,二十一:21,二十二:22,二十三:23 };
const cn2int = (s) => (/^\d+$/.test(String(s).trim()) ? parseInt(s,10) : (CN[String(s).trim()] ?? null));
const lines = fs.readFileSync(B + '/corpus/语料.md','utf8').split(/\r?\n/);
const chapters = new Map(); let cur=null, title='', buf=[];
for (const ln of lines) { const m = /^#{1,6}\s*第([一二三四五六七八九十\d]+)章/.exec(ln); if (m) { if (cur!=null&&buf.length) chapters.set(cur,{title,body:buf.join('\n')}); cur=cn2int(m[1]); title=ln.replace(/^#+\s*/,'').trim(); buf=[]; continue; } if (cur!=null) buf.push(ln); }
if (cur!=null&&buf.length) chapters.set(cur,{title,body:buf.join('\n')});
const mkSeg=(id,seq,text)=>({k:'seg',id,user_id:'h',session_id:'h',seq,part:1,total:1,role:'user',speaker:'',ts:null,granularity:'unknown',provenance:'unknown',text,chars:text.length,tokens:0,sha:'',is_rule:false,names:[]});
const segs=[]; for (const [n,c] of [...chapters].sort((a,b)=>a[0]-b[0])) segs.push(mkSeg('c'+n,n,c.title+'\n'+c.body));
const idx = buildIndex(segs);
const norm = (s) => String(s).replace(/\s+/g,'');

const bank = JSON.parse(fs.readFileSync(B+'/mcq/reasoning/题目_多跳六元素_rubric92_平衡掩码.json','utf8'));
const items = [];
for (const q of bank) for (let j=0;j<(q.points||[]).length;j++) items.push({ aid:`${q.qid}#${j}`, pt:q.points[j], qid:q.qid, idx:j });
const byAid = new Map(items.map(x=>[x.aid,x]));

function decide(pt, armK) {
  const vals = pt.rubric.required.filter(r=>r.slot!=='章节').map(r=>norm(r.value));
  const stmtCh = cn2int((/第([一二三四五六七八九十\d]+)章/.exec(String(pt.stmt))||[])[1]);
  const q = String(pt.stmt).replace(/第[一二三四五六七八九十\d]+章[「《][^」》]*[」》]/,'').replace(/·/g,' ').replace(/\s+/g,' ').trim();
  const res = search(idx, q, { topK: 30, budgetTokens: Number.MAX_SAFE_INTEGER });
  const got = [];
  for (const it of (res.data||[])) { const c = parseInt(String(it.id).replace(/^c/,''),10); if (!got.includes(c)) got.push(c); if (got.length>=armK) break; }
  const text = got.map(c=>norm((chapters.get(c)?.title||'')+'\n'+(chapters.get(c)?.body||''))).join('\n');
  const fiveOk = vals.every(v => text.includes(v));
  const chOk = got.includes(stmtCh);
  return { vals, got, fiveOk, chOk, pred: chOk && fiveOk };
}

// —— 自检 ——
const checks = items.filter(x=>['o001#0','o001#3','o001#4'].includes(x.aid));
for (const x of checks) {
  const d = decide(x.pt, 1);
  console.log('自检', x.aid, '答案应为否 →', d.pred ? '是' : '否', '| 缺:', d.vals.filter(v=>!norm((chapters.get(d.got[0])?.title||'')+norm((chapters.get(d.got[0])?.body||''))).includes(v)).join('、')||'无');
  if (d.pred) { console.error('自检失败：已知假断言被判是，脚本不可信'); process.exit(1); }
}
const truth = items.find(x=>x.pt.answer === true);
const dt = decide(truth.pt, 1);
console.log('自检', truth.aid, '答案应为是 →', dt.pred ? '是' : '否');
if (!dt.pred) { console.error('自检失败：已知真断言被判否'); process.exit(1); }

function grade(list){ let tp=0,tn=0,fp=0,fn=0; for (const p of list){ if (p.gold&&p.pred) tp++; else if (p.gold&&!p.pred) fn++; else if (!p.gold&&p.pred) fp++; else tn++; } const pos=tp+fn,neg=tn+fp; const tpr=pos?tp/pos:0, tnr=neg?tn/neg:0; const bal=(tpr+tnr)/2; const den=Math.sqrt((tp+fp)*(tp+fn)*(tn+fp)*(tn+fn)); const phi=den?(tp*tn-fp*fn)/den:0; return {n:tp+tn+fp+fn, tp,tn,fp,fn, tpr:+tpr.toFixed(4), tnr:+tnr.toFixed(4), bal:+bal.toFixed(4), phi:+phi.toFixed(4)}; }

for (const armK of [1,3]) {
  const list = [];
  for (const x of items) { const d = decide(x.pt, armK); list.push({ gold: !!x.pt.answer, pred: d.pred }); }
  console.log(`\n材料 arm=top${armK}:`, JSON.stringify(grade(list)));
}
