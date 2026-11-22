// 鱼知 · hive-memory-bench 选择题 150（只跑有原文的 70 题：蜂巢 38 + 对话 32）
// 作答＝规则：question 检索材料 + 每个选项查「最长原样命中」；正解选项的连续命中更长。
// 反证条件：若总准确率 <25%，说明规则/材料有错；若 25–50%，说明这只够「认出」但不稳。
import fs from 'node:fs';
import { buildIndex, search } from '../src/recall.mjs';

const B = 'data/hive-memory-bench';
const CN = { 一:1,二:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9,十:10,十一:11,十二:12,十三:13,十四:14,十五:15,十六:16,十七:17,十八:18,十九:19,二十:20,二十一:21,二十二:22,二十三:23 };
const cn2int = (s) => (/^\d+$/.test(String(s).trim()) ? parseInt(s,10) : (CN[String(s).trim()] ?? null));
const norm = (s) => String(s).replace(/[\s\p{P}]/g,'');

const mkSeg=(id,seq,text)=>({k:'seg',id,user_id:'h',session_id:'h',seq,part:1,total:1,role:'user',speaker:'',ts:null,granularity:'unknown',provenance:'unknown',text,chars:text.length,tokens:0,sha:'',is_rule:false,names:[]});

// —— 蜂巢章级 ——
const lines = fs.readFileSync(B + '/corpus/语料.md','utf8').split(/\r?\n/);
const chap = new Map(); let cur=null, title='', buf=[];
for (const ln of lines) {
  const m = /^#{1,6}\s*第([一二三四五六七八九十\d]+)章/.exec(ln);
  if (m) { if (cur!=null && buf.length) chap.set(cur,{title,body:buf.join('\n')}); cur=cn2int(m[1]); title=ln.replace(/^#+\s*/,'').trim(); buf=[]; continue; }
  if (cur!=null) buf.push(ln);
}
if (cur!=null && buf.length) chap.set(cur,{title,body:buf.join('\n')});
const hiveSegs=[]; for (const [n,c] of [...chap].sort((a,b)=>a[0]-b[0])) hiveSegs.push(mkSeg('c'+n,n,c.title+'\n'+c.body));

// —— 对话段级（20 个 md 按 --- 切块，合并到 ~900 字） ——
const dir = B + '/e2e/corpus';
const files = fs.readdirSync(dir).filter(f=>f.endsWith('.md'));
const dlgSegs = []; let dseq = 0;
for (let fi=0; fi<files.length; fi++) {
  const text = fs.readFileSync(dir + '/' + files[fi], 'utf8');
  const blocks = text.split(/\r?\n-{3,}\r?\n/).map(b=>b.trim()).filter(Boolean);
  let acc='', si=0;
  const flush=()=>{ if(acc.length>80){ dlgSegs.push(mkSeg('d'+fi+'.'+si, ++dseq, acc)); acc=''; si++; } };
  for (const b of blocks) { if (acc.length + b.length > 900) flush(); acc += (acc?'\n\n':'') + b; }
  flush();
}
const hiveIdx = buildIndex(hiveSegs);
const dlgIdx = buildIndex(dlgSegs);
console.log('蜂巢段', hiveSegs.length, '｜对话段', dlgSegs.length, '（来自', files.length, '个文件）');

const qs = JSON.parse(fs.readFileSync(B + '/mcq/e2e-simple/题目_选择题_150.json','utf8'));

function poolFor(q) {
  const idx = q.material === '蜂巢指南' ? hiveIdx : dlgIdx;
  const parts = [];
  const r1 = search(idx, q.question, { topK: 8, budgetTokens: Number.MAX_SAFE_INTEGER });
  for (const it of (r1.data||[])) parts.push(it);
  for (const [, opt] of Object.entries(q.options)) {
    const r2 = search(idx, opt, { topK: 4, budgetTokens: Number.MAX_SAFE_INTEGER });
    for (const it of (r2.data||[])) parts.push(it);
  }
  // 去重、拼材料、限长
  const seen = new Set(); let out = '';
  for (const it of parts) { if (seen.has(it.id)) continue; seen.add(it.id); out += '\n' + norm(it.text); if (out.length > 14000) break; }
  return out;
}

function longestHit(opt, pool) {
  const o = norm(opt);
  const floor = Math.min(6, o.length);
  for (let L = o.length; L >= floor; L--) {
    for (let i = 0; i + L <= o.length; i++) if (pool.includes(o.slice(i, i+L))) return L;
  }
  return 0;
}
function bigramCov(opt, pool){ const o=norm(opt); let hit=0,tot=0; for(let i=0;i+1<o.length;i++){tot++; if(pool.includes(o.slice(i,i+2))) hit++;} return tot?hit/tot:0; }

function answer(q) {
  const pool = poolFor(q);
  let best=null, bestScore=-1, bestCov=-1;
  for (const [k, opt] of Object.entries(q.options)) {
    const hit = longestHit(opt, pool);
    const cov = bigramCov(opt, pool);
    const score = hit + 0.001 * cov * opt.length;
    if (score > bestScore) { bestScore=score; best=k; bestCov=cov; }
    else if (score === bestScore && cov > bestCov) { best=k; bestCov=cov; }
  }
  return best;
}

// 只跑有原文的：蜂巢指南 38 + 对话 32
const runnable = qs.filter(q=>q.material==='蜂巢指南' || q.material==='对话');
const groups = { '蜂巢指南': [], '对话': [] };
let right=0;
for (const q of runnable) {
  const pick = answer(q);
  const ok = pick === q.answer;
  if (ok) right++;
  groups[q.material].push(ok ? 1 : 0);
}
function binomP(k, n, p) { // 单尾 P(X>=k)
  let s=0; const logC=(a,b)=> { let r=0; for(let i=1;i<=b;i++) r+=Math.log(a-b+i)-Math.log(i); return r; };
  for (let i=k;i<=n;i++) s += Math.exp(logC(n,i) + i*Math.log(p) + (n-i)*Math.log(1-p));
  return s;
}
const n = runnable.length;
console.log('\n总体', right + '/' + n, (right/n*100).toFixed(1)+'%', '| 25% 基线期望', (n*0.25).toFixed(1), '| 单尾 p', binomP(right,n,0.25).toExponential(2));
for (const [g, arr] of Object.entries(groups)) {
  const k = arr.reduce((a,b)=>a+b,0);
  console.log(g, k + '/' + arr.length, (k/arr.length*100).toFixed(1)+'%', 'p', binomP(k,arr.length,0.25).toExponential(2));
}
const skipped = qs.length - n;
console.log('未跑', skipped, '题（秦吏 39 + 毛选 41：原文不随题公开，无可查材料）');
// 抽样看错题形态（只打印前 6 题错题）
let shown=0;
for (const q of runnable) {
  const pick = answer(q);
  if (pick !== q.answer && shown < 6) {
    shown++;
    console.log('\n[错]', q.qid, q.material, '真解', q.answer, '判', pick);
    console.log('  Q:', q.question);
    console.log('  真选项:', q.options[q.answer], '| 我选:', q.options[pick]);
  }
}
