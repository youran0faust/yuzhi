// 鱼知 · hive-memory-bench 三种口径对照（全部纯规则，无模型、无网络）
// A 我们的检索 top1 + 五元素核对（已知 88.95%）
// B 槽位共现推断桶（照 scripts/bench_state_track.py 的权重）+ 五元素核对
// C 灵枢明细 top1 + 五元素核对（上限锚对照）
import fs from 'node:fs';
import { buildIndex, search } from '../src/recall.mjs';
const B='data/hive-memory-bench';
const CN={一:1,二:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9,十:10,十一:11,十二:12,十三:13,十四:14,十五:15,十六:16,十七:17,十八:18,十九:19,二十:20,二十一:21,二十二:22,二十三:23};
const cn2int=(s)=>/^\d+$/.test(String(s).trim())?parseInt(s,10):(CN[String(s).trim()]??null);
const lines=fs.readFileSync(B+'/corpus/语料.md','utf8').split(/\r?\n/);
const ch=new Map(); let cur=null,title='',buf=[];
for(const ln of lines){const m=/^#{1,6}\s*第([一二三四五六七八九十\d]+)章/.exec(ln); if(m){if(cur!=null&&buf.length)ch.set(cur,{title,body:buf.join('\n')});cur=cn2int(m[1]);title=ln.replace(/^#+\s*/,'').trim();buf=[];continue;} if(cur!=null)buf.push(ln);}
if(cur!=null&&buf.length)ch.set(cur,{title,body:buf.join('\n')});
const mkSeg=(id,seq,text)=>({k:'seg',id,user_id:'h',session_id:'h',seq,part:1,total:1,role:'user',speaker:'',ts:null,granularity:'unknown',provenance:'unknown',text,chars:text.length,tokens:0,sha:'',is_rule:false,names:[]});
const segs=[];for(const [n,c] of [...ch].sort((a,b)=>a[0]-b[0]))segs.push(mkSeg('c'+n,n,c.title+'\n'+c.body));
const idx=buildIndex(segs);
const norm=(s)=>String(s).replace(/\s+/g,'');

const bank=JSON.parse(fs.readFileSync(B+'/mcq/reasoning/题目_多跳六元素_rubric92_平衡掩码.json','utf8'));
const ret=JSON.parse(fs.readFileSync(B+'/readings/lingshu_retrieval_rubric92.json','utf8')).rows;
const items=[];
for(const q of bank) for(let j=0;j<(q.points||[]).length;j++) items.push({aid:`${q.qid}#${j}`,pt:q.points[j]});
const byAid=new Map(items.map(x=>[x.aid,x]));
const retByAid=new Map(ret.map(r=>[r.aid,r]));

const W={人物:1.0,地点:1.2,事件:1.2,情绪:1.0,物品:1.2};
function scopeBucket(pt){ // 照 bench_state_track：值→章共现打分，取最高
  const vals=pt.rubric.required.filter(r=>r.slot!=='章节').map(r=>({slot:r.slot,value:norm(r.value)}));
  const score=new Map();
  for(const {slot,value} of vals){
    for(const [n,c] of ch){
      const body=norm(c.body);
      if(body.includes(value)) score.set(n,(score.get(n)||0)+(W[slot]||1));
    }
  }
  if(!score.size) return null;
  let best=null,bestS=-1;
  for(const [n,s] of score) if(s>bestS || (s===bestS&&n<best)) {best=n;bestS=s;}
  return best;
}
function checkAll(pt,bucket){ // 桶内核对五元素
  if(bucket==null) return {pred:false,missing:[]};
  const body=norm(ch.get(bucket)?.body||'');
  const vals=pt.rubric.required.filter(r=>r.slot!=='章节').map(r=>norm(r.value));
  const missing=vals.filter(v=>!body.includes(v));
  return {pred: missing.length===0, missing};
}
function ourTop1(pt){
  const q=String(pt.stmt).replace(/第[一二三四五六七八九十\d]+章[「《][^」》]*[」》]/,'').replace(/·/g,' ').replace(/\s+/g,' ').trim();
  const res=search(idx,q,{topK:10,budgetTokens:Number.MAX_SAFE_INTEGER});
  const it=(res.data||[])[0];
  return it?parseInt(String(it.id).replace(/^c/,''),10):null;
}
function grade(list){let tp=0,tn=0,fp=0,fn=0;for(const p of list){if(p.gold&&p.pred)tp++;else if(p.gold&&!p.pred)fn++;else if(!p.gold&&p.pred)fp++;else tn++;}const pos=tp+fn,neg=tn+fp;const tpr=pos?tp/pos:0,tnr=neg?tn/neg:0;const bal=(tpr+tnr)/2;const den=Math.sqrt((tp+fp)*(tp+fn)*(tn+fp)*(tn+fn));const phi=den?(tp*tn-fp*fn)/den:0;return {n:tp+tn+fp+fn,tp,tn,fp,fn,tpr:+tpr.toFixed(4),tnr:+tnr.toFixed(4),bal:+bal.toFixed(4),phi:+phi.toFixed(4)};}

const A=[],Bk=[],C=[];
let chHit=0;
for(const x of items){ const pt=x.pt; const gold=(retByAid.get(x.aid)||{}).gold;
  const t1=ourTop1(pt); if(t1===gold) chHit++;
  A.push({gold:!!pt.answer,pred:checkAll(pt,t1).pred});
  const sb=scopeBucket(pt);
  Bk.push({gold:!!pt.answer,pred:checkAll(pt,sb).pred});
  const r=retByAid.get(x.aid); if(!r){C.push({gold:!!pt.answer,pred:false});continue;}
  C.push({gold:!!pt.answer,pred:checkAll(pt,r.top1).pred});
}
const n=items.length;
console.log('A 鱼知检索top1+核对   :', JSON.stringify(grade(A)));
console.log('B 槽位共现桶+核对     :', JSON.stringify(grade(Bk)));
console.log('C 灵枢明细top1+核对   :', JSON.stringify(grade(C)));
console.log('检索top1命中率        :', (chHit/n*100).toFixed(2)+'%', `(${chHit}/${n})`);
