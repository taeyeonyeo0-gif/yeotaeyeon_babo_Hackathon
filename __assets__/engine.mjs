// 웹앱과 scripts/nightpath.py는 같은 데이터·특성·탐색 후보 규칙을 사용합니다.
export const names=['보안등 근접','등록 CCTV 근접'];
export const defaults=[2,.5];
export const xy=p=>[(p[0]-127.13)*111195*Math.cos(37.54*Math.PI/180),(p[1]-37.54)*111195];
export const meters=(a,b)=>{const x=xy(a),y=xy(b);return Math.hypot(x[0]-y[0],x[1]-y[1]);};
class Heap{constructor(){this.a=[];}compare(a,b){return a.f-b.f||a.cost-b.cost||a.n-b.n;}push(v){const a=this.a;let i=a.length;a.push(v);while(i){const p=(i-1)>>1;if(this.compare(a[p],v)<=0)break;a[i]=a[p];i=p;}a[i]=v;}pop(){const a=this.a,t=a[0],v=a.pop();if(a.length){let i=0;while(i*2+1<a.length){let c=i*2+1;if(c+1<a.length&&this.compare(a[c+1],a[c])<0)c++;if(this.compare(v,a[c])<=0)break;a[i]=a[c];i=c;}a[i]=v;}return t;}get length(){return this.a.length;}}
export function makeEngine(data){
 const adj=data.nodes.map(()=>[]);data.edges.forEach(e=>{adj[e.a].push([e.b,e]);adj[e.b].push([e.a,e]);});
 function route(start,end,weights=[0,0,0],penalize=null,strength=0,useH=true){
  if(!data.nodes[start]||!data.nodes[end])throw Error('지도 안의 보행 지점을 선택해 주세요.');
  const alpha=Math.min(1,...data.edges.map(e=>e.distance/Math.max(1e-9,meters(data.nodes[e.a].p,data.nodes[e.b].p))))*.999999;
  const h=n=>useH?alpha*meters(data.nodes[n].p,data.nodes[end].p):0;
  const open=new Heap(),best=new Float64Array(data.nodes.length).fill(Infinity),prev=new Array(data.nodes.length);best[start]=0;open.push({n:start,cost:0,f:h(start)});let expanded=0;
   while(open.length){const cur=open.pop();if(cur.cost>best[cur.n]+1e-8)continue;expanded++;
   if(cur.n===end){let n=end,ids=[],ns=[end];while(n!==start){const [p,eid]=prev[n];ids.push(eid);ns.push(p);n=p;}return summarize(ids.reverse(),ns.reverse(),expanded);}
    for(const[n,e]of adj[cur.n]){const penalty=weights.reduce((s,w,i)=>s+w*(i===2?e.quality[i]:1-e.quality[i]),0);const cost=cur.cost+e.distance*Math.max(.15,1+penalty+(penalize?.has(e.id)?strength:0));if(cost+1e-8<best[n]){best[n]=cost;prev[n]=[cur.n,e.id];open.push({n,cost,f:cost+h(n)});}}
  }return null;
 }
  function summarize(edgeIds,nodes,expanded=0){const es=edgeIds.map(id=>data.edges[id]),distance=es.reduce((s,e)=>s+e.distance,0),quality=names.map((_,i)=>{const value=distance?es.reduce((s,e)=>s+e.distance*e.quality[i],0)/distance:0;return i===2?1-value:value;});return{edgeIds,nodes,distance,quality,expanded,crossings:es.filter(e=>e.crossing).length};}
 function constrained(start,end,weights,cap){
   const edgeCost=e=>e.distance*Math.max(.15,1+weights.reduce((s,w,i)=>s+w*(i===2?e.quality[i]:1-e.quality[i]),0));
  const lower=weighted=>{const d=new Float64Array(adj.length).fill(Infinity),q=new Heap();d[end]=0;q.push({n:end,cost:0,f:0});while(q.length){const c=q.pop();if(c.cost>d[c.n]+1e-8)continue;for(const[n,e]of adj[c.n]){const cost=c.cost+(weighted?edgeCost(e):e.distance);if(cost+1e-8<d[n]){d[n]=cost;q.push({n,cost,f:cost});}}}return d;};
  const hd=lower(false),hc=lower(true),labels=adj.map(()=>[]),open=new Heap(),first={n:start,distance:0,cost:0,f:hc[start],prev:null,edge:null,alive:true};labels[start].push(first);open.push(first);let expanded=0;
  while(open.length){const cur=open.pop();if(!cur.alive)continue;expanded++;
   if(cur.n===end){const ids=[],ns=[end];let p=cur;while(p.prev){ids.push(p.edge);p=p.prev;ns.push(p.n);}return summarize(ids.reverse(),ns.reverse(),expanded);}
   for(const[n,e]of adj[cur.n]){const distance=cur.distance+e.distance,cost=cur.cost+edgeCost(e);if(distance+hd[n]>cap+1e-6)continue;const old=labels[n];if(old.some(q=>q.alive&&q.distance<=distance+1e-8&&q.cost<=cost+1e-8))continue;for(const q of old){if(q.alive&&distance<=q.distance+1e-8&&cost<=q.cost+1e-8)q.alive=false;}const next={n,distance,cost,f:cost+hc[n],prev:cur,edge:e.id,alive:true};labels[n]=old.filter(q=>q.alive);labels[n].push(next);open.push(next);}
  }return null;
 }
  function recommend(start,end,weights=defaults,extra=5,speed=80){
   if(!Number.isFinite(extra)||extra<0||extra>20||!Number.isFinite(speed)||speed<40||speed>120||weights.length!==2||weights.some(x=>!Number.isFinite(x)||x<-5||x>40))throw Error('경로 조건을 확인해 주세요.');
  const shortest=route(start,end);if(!shortest)throw Error('공개 보행망에서 연결된 경로를 찾지 못했어요.');
  const cap=shortest.distance+extra*speed,best=constrained(start,end,weights,cap);if(!best)throw Error('시간 제한 안에서 경로를 찾지 못했어요.');
  const pool=new Map(),add=r=>{if(r)pool.set(r.edgeIds.join(','),r);};add(shortest);add(best);
  for(const base of[shortest,best])for(const strength of[1,3])add(route(start,end,weights,new Set(base.edgeIds),strength));
  const candidates=[...pool.values()].filter(r=>r.distance<=cap+1e-6),score=r=>r.distance*(1+weights.reduce((s,w,i)=>s+w*(1-r.quality[i]),0));candidates.sort((a,b)=>score(a)-score(b)||a.distance-b.distance);
   return{shortest,recommended:best,candidates,generated:pool.size,extra,speed,weights:[...weights],start,end,method:'resource-constrained-a-star',optimalForModel:true};
  }
  function recommendFromPoints(startPoint,endPoint,weights=defaults,extra=5,speed=80){
   const startSnap=nearest(startPoint),endSnap=nearest(endPoint),starts=startSnap.nodes||[startSnap.node],ends=endSnap.nodes||[endSnap.node],runs=[];
   const attach=(route,startNode,endNode)=>{const accessStart=meters(startSnap.p,data.nodes[startNode].p),accessEnd=meters(endSnap.p,data.nodes[endNode].p);return{...route,distance:route.distance+accessStart+accessEnd,startNode,endNode,accessStart,accessEnd};};
   for(const start of starts)for(const end of ends){if(start===end)continue;const result=recommend(start,end,weights,extra,speed);runs.push({shortest:attach(result.shortest,start,end),recommended:attach(result.recommended,start,end),candidates:result.candidates.map(route=>attach(route,start,end)),generated:result.generated});}
   if(!runs.length)throw Error('공개 보행망에서 연결된 경로를 찾지 못했어요.');
   const score=route=>route.distance*(1+weights.reduce((sum,w,i)=>sum+w*(1-route.quality[i]),0));
    const direct=[];if(startSnap.edgeId!==null&&startSnap.edgeId===endSnap.edgeId){const edge=data.edges[startSnap.edgeId],distance=Math.abs(startSnap.offsetAlong-endSnap.offset);direct.push({edgeIds:[edge.id],nodes:[edge.a,edge.b],geometry:[startSnap.p,endSnap.p],distance,quality:[edge.quality[0],edge.quality[1]],crossings:edge.crossing?1:0,startNode:startSnap.node,endNode:endSnap.node,accessStart:0,accessEnd:0});}
    const scoreWithDirect=route=>route.distance*(1+weights.reduce((sum,w,i)=>sum+w*(1-route.quality[i]),0)),shortest=[...runs.map(run=>run.shortest),...direct].sort((a,b)=>a.distance-b.distance)[0],recommended=[...runs.map(run=>run.recommended),...direct].sort((a,b)=>scoreWithDirect(a)-scoreWithDirect(b)||a.distance-b.distance)[0],pool=new Map();runs.forEach(run=>run.candidates.forEach(route=>pool.set(route.edgeIds.join(',')+`/${route.startNode}/${route.endNode}`,route)));direct.forEach(route=>pool.set(`direct/${route.edgeIds[0]}/${route.distance}`,route));return{shortest,recommended,candidates:[...pool.values()].sort((a,b)=>scoreWithDirect(a)-scoreWithDirect(b)||a.distance-b.distance),generated:[...pool.values()].length,extra,speed,weights:[...weights],start:shortest.startNode,end:shortest.endNode,method:'resource-constrained-a-star-with-segment-snap',optimalForModel:true};
  }
  function nearest(p){
   let best={node:-1,distance:Infinity,p:null,edgeId:null,segment:0,t:0,offsetAlong:0};
   const project=(point,a,b)=>{
    const pp=xy(point),aa=xy(a),bb=xy(b),dx=bb[0]-aa[0],dy=bb[1]-aa[1],length=dx*dx+dy*dy;
    const t=length?Math.max(0,Math.min(1,((pp[0]-aa[0])*dx+(pp[1]-aa[1])*dy)/length)):0;
    const qx=aa[0]+t*dx,qy=aa[1]+t*dy,lon=127.13+qx/(111195*Math.cos(37.54*Math.PI/180)),lat=37.54+qy/111195;
    return{distance:Math.hypot(pp[0]-qx,pp[1]-qy),p:[lon,lat],t};
   };
   for(const edge of data.edges){let along=0;for(let i=1;i<edge.geometry.length;i++){
    const hit=project(p,edge.geometry[i-1],edge.geometry[i]);
    if(hit.distance<best.distance){const node=hit.t<.5?edge.a:edge.b;best={node,nodes:[edge.a,edge.b],distance:hit.distance,p:hit.p,edgeId:edge.id,segment:i-1,t:hit.t,offsetAlong:along+meters(edge.geometry[i-1],hit.p)};}
    along+=meters(edge.geometry[i-1],edge.geometry[i]);
   }}
   return best;
  }
  function geometry(r){if(r.geometry)return r.geometry;const points=[];r.edgeIds.forEach((eid,i)=>{const e=data.edges[eid],part=e.a===r.nodes[i]?e.geometry:[...e.geometry].reverse();points.push(...(i?part.slice(1):part));});return points;}
  return{route,recommend,recommendFromPoints,constrained,summarize,nearest,geometry};
}
export const features=r=>[r.distance/1000,...r.quality.map(q=>r.distance/1000*(1-q))];
const sigmoid=x=>1/(1+Math.exp(-Math.max(-30,Math.min(30,x))));
export function train(samples){if(samples.length<4)throw Error('서로 다른 경로 선택 4개가 필요합니다.');const w=[1,1,1,1];for(let t=0;t<1000;t++){const g=w.map(v=>.015*(v-1));for(const s of samples){const p=sigmoid(w.reduce((a,v,i)=>a+v*s.x[i],0));w.forEach((v,i)=>g[i]+=(p-s.y)*s.x[i]/samples.length);}w.forEach((v,i)=>w[i]=Math.max(.15,Math.min(6,v-.2*g[i])));}return w;}
export function evaluate(s){if(s.length<10)return null;const cut=Math.floor(s.length*.8),w=train(s.slice(0,cut)),test=s.slice(cut);return{train:cut,total:test.length,correct:test.filter(v=>(sigmoid(w.reduce((a,x,i)=>a+x*v.x[i],0))>=.5?1:0)===v.y).length};}
