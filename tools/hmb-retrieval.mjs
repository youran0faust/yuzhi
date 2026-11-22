// 鱼知 · hive-memory-bench 检索层：带章号 vs 不带章号（泄漏对照）
// 早期版本把「第N章「…」」留在 query 里，等于把金标章号塞给检索器——那是假数。
// 这个脚本两行都打，以后的窗口别再信 92.4 那种数。
import fs from 'node:fs';
import { buildIndex, search } from '../src/recall.mjs';

const B = 'data/hive-memory-bench';
const CN = { 一:1,二:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9,十:10,十一:11,十二:12,十三:13,十四:14,十五:15,十六:16,十七:17,十八:18,十九:19,二十:20,二十一:21,二十二:22,二十三:23 };
const cn2int = (s) => (/^\d+$/.test(String(s).trim()) ? parseInt(s,10) : (CN[String(s).trim()] ?? null));

const lines = fs.readFileSync(B + '/corpus/语料.md','utf8').split(/\r?\n/);
const chapters = new Map(); let cur=null, title='', buf=[];
for (const ln of lines) {
  const m = /^#{1,6}\s*第([一二三四五六七八九十\d]+)章/.exec(ln);
  if (m) { if (cur!=null && buf.length) chapters.set(cur,{title,body:buf.join('\n')}); cur=cn2int(m[1]); title=ln.replace(/^#+\s*/,'').trim(); buf=[]; continue; }
  if (cur!=null) buf.push(ln);
}
if (cur!=null && buf.length) chapters.set(cur,{title,body:buf.join('\n')});
const mkSeg=(id,seq,text)=>({k:'seg',id,user_id:'h',session_id:'h',seq,part:1,total:1,role:'user',speaker:'',ts:null,granularity:'unknown',provenance:'unknown',text,chars:text.length,tokens:0,sha:'',is_rule:false,names:[]});
const segs=[]; for (const [n,c] of [...chapters].sort((a,b)=>a[0]-b[0])) segs.push(mkSeg('c'+n,n,c.title+'\n'+c.body));
const idx = buildIndex(segs);

const bank = JSON.parse(fs.readFileSync(B+'/mcq/reasoning/题目_多跳六元素_rubric92_平衡掩码.json','utf8'));
const ret  = JSON.parse(fs.readFileSync(B+'/readings/lingshu_retrieval_rubric92.json','utf8'));
const ptByAid = new Map();
for (const q of bank) for (let j=0;j<(q.points||[]).length;j++) ptByAid.set(`${q.qid}#${j}`, q.points[j]);
const chOf = (id) => parseInt(String(id).replace(/^c/,''),10);

function qLeak(stmt){ return String(stmt).replace(/·/g,' ').replace(/\s+/g,' ').trim(); }               // 带「第N章」= 泄漏
function qClean(stmt){ return String(stmt).replace(/第[一二三四五六七八九十\d]+章[「《][^」》]*[」》]/,'').replace(/·/g,' ').replace(/\s+/g,' ').trim(); }

function measure(label, qf) {
  let n=0,h1=0,h3=0,h10=0;
  for (const row of ret.rows || []) {
    const pt = ptByAid.get(row.aid); if (!pt) continue;
    const res = search(idx, qf(pt.stmt), { topK: 100, budgetTokens: Number.MAX_SAFE_INTEGER });
    const t1=[],t3=[],t10=[];
    for (const it of (res.data||[])) {
      const c=chOf(it.id);
      if (t1.length<1 && !t1.includes(c)) t1.push(c);
      if (t3.length<3 && !t3.includes(c)) t3.push(c);
      if (t10.length<10 && !t10.includes(c)) t10.push(c);
    }
    n++;
    if (t1.includes(row.gold)) h1++;
    if (t3.includes(row.gold)) h3++;
    if (t10.includes(row.gold)) h10++;
  }
  const pct=(x)=>((x/n)*100).toFixed(2)+'%';
  console.log(`${label}: n=${n} top1=${pct(h1)} top3=${pct(h3)} top10=${pct(h10)}`);
}

measure('带章号（泄漏，旧数字 92.4%）', qLeak);
measure('去掉章号（真实，无泄漏）      ', qClean);
