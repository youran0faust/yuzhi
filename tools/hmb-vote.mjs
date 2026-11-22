// 鱼知 · hive-memory-bench：用「逐值查章投票」当检索，桶内核对当作答
// 关键：不借灵枢明细、不用 gold 章；只用鱼知的 search 对每个元素值单独检索，投票选桶。
// 预测：值投票应把命中从 77% 抬到 96%+（公开脚本同思路是 99.28%）。
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
const items=[];for(const q of bank) for(let j=0;j<(q.points||[]).length;j++) items.push({aid:`${q.qid}#${j}`,pt:q.points[j]});
const goldBy=new Map(ret.map(r=>[r.aid,r.gold]));
const W={人物:1.0,地点:1.2,事件:1.2,情绪:1.0,物品:1.2};

function voteBucket(pt){
  const vals=pt.rubric.required.filter(r=>r.slot!=='章节').map(r=>({slot:r.slot,value:norm(r.value)}));
  const score=new Map();
  for(const {slot,value} of vals){
    if(!value) continue;
    const res=search(idx,value,{topK:5,budgetTokens:Number.MAX_SAFE_INTEGER});
    const seen=[]; let rank=0;
    for(const it of (res.data||[])){
      const c=parseInt(String(it.id).replace(/^c/,''),10);
      if(seen.includes(c)) continue; seen.push(c); rank++;
      if(rank>3) break;
      score.set(c,(score.get(c)||0)+(W[slot]||1)/(rank)); // 名次越前票越重
    }
  }
  let best=null,bestS=-1;
  for(const [n,s] of score) if(s>bestS||(s===bestS&&n<best)){best=n;bestS=s;}
  return best;
}
function check(pt,bucket){
  if(bucket==null) return false;
  const body=norm(ch.get(bucket)?.body||'');
  return pt.rubric.required.filter(r=>r.slot!=='章节').map(r=>norm(r.value)).every(v=>body.includes(v));
}
function grade(list){let tp=0,tn=0,fp=0,fn=0;for(const p of list){if(p.gold&&p.pred)tp++;else if(p.gold&&!p.pred)fn++;else if(!p.gold&&p.pred)fp++;else tn++;}const pos=tp+fn,neg=tn+fp;const tpr=pos?tp/pos:0,tnr=neg?tn/neg:0;const bal=(tpr+tnr)/2;const den=Math.sqrt((tp+fp)*(tp+fn)*(tn+fp)*(tn+fn));const phi=den?(tp*tn-fp*fn)/den:0;return {n:tp+tn+fp+fn,tp,tn,fp,fn,tpr:+tpr.toFixed(4),tnr:+tnr.toFixed(4),bal:+bal.toFixed(4),phi:+phi.toFixed(4)};}
const list=[]; let hit=0;
for(const x of items){ const pt=x.pt; const b=voteBucket(pt); if(b===goldBy.get(x.aid)) hit++; list.push({gold:!!pt.answer,pred:check(pt,b)}); }
console.log('值投票桶命中率:',(hit/items.length*100).toFixed(2)+'%');
console.log('值投票+桶内核对:',JSON.stringify(grade(list)));
