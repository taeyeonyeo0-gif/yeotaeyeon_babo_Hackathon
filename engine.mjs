// 웹앱과 scripts/nightpath.py는 같은 데이터·특성·탐색 후보 규칙을 사용합니다.
export const names=['보안등 근접','등록 CCTV 근접'];
export const defaults=[2,.5];
export const xy=p=>[(p[0]-127.13)*111195*Math.cos(37.54*Math.PI/180),(p[1]-37.54)*111195];
export const meters=(a,b)=>{const x=xy(a),y=xy(b);return Math.hypot(x[0]-y[0],x[1]-y[1]);};
class Heap{constructor(){this.a=[];}compare(a,b){return a.f-b.f||a.cost-b.cost||a.n-b.n;}push(v){const a=this.a;let i=a.length;a.push(v);while(i){const p=(i-1)>>1;if(this.compare(a[p],v)<=0)break;a[i]=a[p];i=p;}a[i]=v;}pop(){const a=this.a,t=a[0],v=a.pop();if(a.length){let i=0;while(i*2+1<a.length){let c=i*2+1;if(c+1<a.length&&this.compare(a[c+1],a[c])<0)c++;if(this.compare(v,a[c])<=0)break;a[i]=a[c];i=c;}a[i]=v;}return t;}get length(){return this.a.length;}}
export function makeEngine(data){
  const bbox=data.meta?.bbox,lonOrigin=Array.isArray(bbox)&&bbox.length===4?(bbox[0]+bbox[2])/2:127.13,latOrigin=Array.isArray(bbox)&&bbox.length===4?(bbox[1]+bbox[3])/2:37.54;
  const graphXY=p=>[(p[0]-lonOrigin)*111195*Math.cos(latOrigin*Math.PI/180),(p[1]-latOrigin)*111195];
  const graphMeters=(a,b)=>{const x=graphXY(a),y=graphXY(b);return Math.hypot(x[0]-y[0],x[1]-y[1]);};
  const facilities=Array.isArray(data.facilities)?data.facilities:[],cellSize=100;
  const buildIndex=type=>{const grid=new Map();let count=0;for(const facility of facilities){if(facility.type!==type||!Array.isArray(facility.p)||!facility.p.every(Number.isFinite))continue;const point=graphXY(facility.p),cx=Math.floor(point[0]/cellSize),cy=Math.floor(point[1]/cellSize),key=`${cx},${cy}`;if(!grid.has(key))grid.set(key,[]);grid.get(key).push(point);count++;}return{grid,count};};
 const lampIndex=buildIndex('lamp'),cctvIndex=buildIndex('cctv');
  const covered=(point,index,radius)=>{if(!index.count)return false;const cx=Math.floor(point[0]/cellSize),cy=Math.floor(point[1]/cellSize),r2=radius*radius,reach=Math.ceil(radius/cellSize);for(let dx=-reach;dx<=reach;dx++)for(let dy=-reach;dy<=reach;dy++)for(const facility of index.grid.get(`${cx+dx},${cy+dy}`)||[]){const x=point[0]-facility[0],y=point[1]-facility[1];if(x*x+y*y<=r2)return true;}return false;};
  // Sample each displayed segment at most five meters apart so edge and access coverage share a basis.
   const coverage=(points,index,radius)=>{if(!index.count||!Array.isArray(points)||points.length<2)return null;let total=0,near=0;for(let i=1;i<points.length;i++){const a=graphXY(points[i-1]),b=graphXY(points[i]),length=Math.hypot(b[0]-a[0],b[1]-a[1]);if(!length)continue;const parts=Math.max(1,Math.ceil(length/5-1e-9)),weight=length/parts;for(let j=0;j<parts;j++){const t=(j+.5)/parts,p=[a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t];total+=weight;if(covered(p,index,radius))near+=weight;}}return total?near/total:0;};
 const qualityForGeometry=(points,fallback=[])=>[coverage(points,lampIndex,data.meta?.radiiMeters?.lamp||30)??fallback[0]??0,coverage(points,cctvIndex,data.meta?.radiiMeters?.cctv||50)??fallback[1]??0];
 const edgeQuality=edge=>{const quality=[...(edge.quality||[])];const measured=qualityForGeometry(edge.geometry,quality);quality[0]=measured[0];quality[1]=measured[1];return quality;};
 const candidates=[],seenPhysical=new Set();let duplicateReverseRecords=0;
 const physicalKey=edge=>{const[sourceA,sourceB]=String(edge.sourceId||'').split('_'),source=sourceA&&sourceB?[sourceA,sourceB].sort().join(':'):`${Math.min(edge.a,edge.b)}:${Math.max(edge.a,edge.b)}`,forward=edge.geometry.map(p=>`${p[0]},${p[1]}`).join(';'),reverse=edge.geometry.slice().reverse().map(p=>`${p[0]},${p[1]}`).join(';'),geometry=forward<reverse?forward:reverse;return`${source}|${Math.min(edge.a,edge.b)}:${Math.max(edge.a,edge.b)}|${geometry}|${edge.distance}|${edge.quality.join(',')}|${edge.crossing??false}|${edge.area??''}|${edge.code??''}`;};
   for(const sourceEdge of data.edges){if(sourceEdge.graphExcluded)continue;const key=physicalKey(sourceEdge);if(seenPhysical.has(key)){duplicateReverseRecords++;continue;}seenPhysical.add(key);candidates.push(sourceEdge);}
 const componentAdj=data.nodes.map(()=>[]);candidates.forEach(e=>{componentAdj[e.a].push(e.b);componentAdj[e.b].push(e.a);});
 const componentIds=new Int32Array(data.nodes.length).fill(-1),componentSizes=[];
 for(let i=0;i<data.nodes.length;i++)if(componentIds[i]===-1){const id=componentSizes.length,queue=[i];componentIds[i]=id;let size=0;for(let j=0;j<queue.length;j++){const n=queue[j];size++;for(const next of componentAdj[n])if(componentIds[next]===-1){componentIds[next]=id;queue.push(next);}}componentSizes.push(size);}
  const largestComponent=componentSizes.reduce((best,size,i)=>size>componentSizes[best]?i:best,0),activeNodes=Uint8Array.from(componentIds,id=>id===largestComponent?1:0),edges=candidates.filter(e=>activeNodes[e.a]&&activeNodes[e.b]).map(edge=>({...edge,quality:edgeQuality(edge)})),adj=data.nodes.map(()=>[]);
  edges.forEach(e=>{adj[e.a].push([e.b,e]);adj[e.b].push([e.a,e]);});
  const edgeById=new Map(edges.map(edge=>[edge.id,edge]));
 const graphStats={componentCount:componentSizes.length,activeNodeCount:componentSizes[largestComponent]||0,disconnectedNodeCount:data.nodes.length-(componentSizes[largestComponent]||0),activeEdgeCount:edges.length,sourceEdgeCount:data.edges.length,accessExcludedEdgeCount:data.edges.filter(e=>e.graphExcluded).length,duplicateReverseRecords,disconnectedPhysicalEdges:candidates.length-edges.length};
 function route(start,end,weights=[0,0,0],penalize=null,strength=0,useH=true){
   if(!data.nodes[start]||!data.nodes[end]||!activeNodes[start]||!activeNodes[end])throw Error('지도 안의 연결된 보행 지점을 선택해 주세요.');
    const alpha=Math.min(1,...edges.map(e=>e.distance/Math.max(1e-9,graphMeters(data.nodes[e.a].p,data.nodes[e.b].p))))*.999999;
   const h=n=>useH?alpha*graphMeters(data.nodes[n].p,data.nodes[end].p):0;
  const open=new Heap(),best=new Float64Array(data.nodes.length).fill(Infinity),prev=new Array(data.nodes.length);best[start]=0;open.push({n:start,cost:0,f:h(start)});let expanded=0;
   while(open.length){const cur=open.pop();if(cur.cost>best[cur.n]+1e-8)continue;expanded++;
   if(cur.n===end){let n=end,ids=[],ns=[end];while(n!==start){const [p,eid]=prev[n];ids.push(eid);ns.push(p);n=p;}return summarize(ids.reverse(),ns.reverse(),expanded);}
    for(const[n,e]of adj[cur.n]){const penalty=weights.reduce((s,w,i)=>s+w*(i===2?e.quality[i]:1-e.quality[i]),0);const cost=cur.cost+e.distance*Math.max(.15,1+penalty+(penalize?.has(e.id)?strength:0));if(cost+1e-8<best[n]){best[n]=cost;prev[n]=[cur.n,e.id];open.push({n,cost,f:cost+h(n)});}}
  }return null;
 }
   function summarize(edgeIds,nodes,expanded=0){const es=edgeIds.map(id=>edgeById.get(id)||data.edges[id]),distance=es.reduce((s,e)=>s+e.distance,0),quality=names.map((_,i)=>{const value=distance?es.reduce((s,e)=>s+e.distance*e.quality[i],0)/distance:0;return i===2?1-value:value;});return{edgeIds,nodes,distance,quality,expanded,crossings:es.filter(e=>e.crossing).length};}
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
    function recommendFromPoints(startPoint,endPoint,weights=defaults,extra=5,speed=80){return recommendFromSnaps(nearest(startPoint),nearest(endPoint),weights,extra,speed);}
     function validateSnap(snap){const edge=data.edges[snap?.edgeId],total=edge?pathLength(edge.geometry):0;if(!edge||!edges.some(candidate=>candidate.id===edge.id)||!Array.isArray(snap.p)||snap.p.length!==2||!snap.p.every(Number.isFinite)||!Array.isArray(snap.nodes)||snap.nodes[0]!==edge.a||snap.nodes[1]!==edge.b||!Number.isInteger(snap.segment)||snap.segment<0||snap.segment>=edge.geometry.length-1||!Number.isFinite(snap.t)||snap.t<0||snap.t>1||!Number.isFinite(snap.offsetAlong)||snap.offsetAlong<0||snap.offsetAlong>total+1e-5||snap.node!==(snap.offsetAlong<=total/2?edge.a:edge.b))throw Error('도로 스냅 정보가 현재 보행망과 일치하지 않아요. 위치를 다시 선택해 주세요.');}
     function recommendFromSnaps(startSnap,endSnap,weights=defaults,extra=5,speed=80){
      validateSnap(startSnap);validateSnap(endSnap);if(!Number.isFinite(extra)||extra<0||extra>20||!Number.isFinite(speed)||speed<40||speed>120||weights.length!==2||weights.some(x=>!Number.isFinite(x)||x<-5||x>40))throw Error('경로 조건을 확인해 주세요.');const starts=startSnap.nodes,ends=endSnap.nodes,pairs=[];
     const attach=(route,startNode,endNode)=>{
      const startAccess=snapToNode(startSnap,startNode),endAccess=snapToNode(endSnap,endNode).reverse(),middle=geometry(route);
      const routeGeometry=compact([...startAccess,...middle.slice(1),...endAccess.slice(1)]);
      const accessStart=pathLength(startAccess),accessEnd=pathLength(endAccess);
      const distance=route.distance+accessStart+accessEnd,startEdge=edgeById.get(startSnap.edgeId),endEdge=edgeById.get(endSnap.edgeId),fallback=names.map((_,i)=>distance?(route.distance*(route.quality[i]||0)+accessStart*(startEdge?.quality[i]||0)+accessEnd*(endEdge?.quality[i]||0))/distance:route.quality[i]||0);
      return{...route,distance,quality:qualityForGeometry(routeGeometry,fallback),geometry:routeGeometry,startNode,endNode,accessStart,accessEnd};
     };
     for(const start of starts)for(const end of ends){if(start===end)continue;const shortest=route(start,end);if(shortest)pairs.push({start,end,shortest:attach(shortest,start,end)});}
     const direct=[];
     const startEdge=edgeById.get(startSnap.edgeId);
     if(startSnap.edgeId===endSnap.edgeId){
      const edge=startEdge,routeGeometry=pathBetweenSnaps(edge,startSnap,endSnap),distance=pathLength(routeGeometry);
      direct.push({edgeIds:[edge.id],nodes:[edge.a,edge.b],geometry:routeGeometry,distance,quality:qualityForGeometry(routeGeometry,edge.quality),crossings:edge.crossing?1:0,startNode:startSnap.node,endNode:endSnap.node,accessStart:0,accessEnd:0});
     }
     const shortest=[...pairs.map(pair=>pair.shortest),...direct].sort((a,b)=>a.distance-b.distance)[0];
     if(!shortest)throw Error('공개 보행망에서 연결된 경로를 찾지 못했어요.');
     const cap=shortest.distance+extra*speed,pool=new Map(),add=(route,key)=>{if(route&&route.distance<=cap+1e-6)pool.set(key,route);};
     add(shortest,`${shortest.edgeIds.join(',')}/${shortest.startNode}/${shortest.endNode}`);
     direct.forEach(route=>add(route,`direct/${route.edgeIds.join(',')}/${route.distance}`));
     for(const pair of pairs){const localExtra=(cap-pair.shortest.distance)/speed;if(localExtra< -1e-8)continue;const result=recommend(pair.start,pair.end,weights,Math.max(0,localExtra),speed);result.candidates.forEach(route=>{const full=attach(route,pair.start,pair.end);add(full,`${full.edgeIds.join(',')}/${full.startNode}/${full.endNode}`);});}
     const score=route=>route.distance*(1+weights.reduce((sum,w,i)=>sum+w*(1-route.quality[i]),0)),candidates=[...pool.values()].sort((a,b)=>score(a)-score(b)||a.distance-b.distance),recommended=candidates[0]||shortest;
     return{shortest,recommended,candidates,generated:candidates.length,extra,speed,weights:[...weights],start:shortest.startNode,end:shortest.endNode,snaps:{start:startSnap,end:endSnap},method:'resource-constrained-a-star-with-global-snap-cap',optimalForModel:true};
   }
  function nearest(p){
   let best={node:-1,distance:Infinity,p:null,edgeId:null,segment:0,t:0,offsetAlong:0};
   const project=(point,a,b)=>{
     const pp=graphXY(point),aa=graphXY(a),bb=graphXY(b),dx=bb[0]-aa[0],dy=bb[1]-aa[1],length=dx*dx+dy*dy;
     const t=length?Math.max(0,Math.min(1,((pp[0]-aa[0])*dx+(pp[1]-aa[1])*dy)/length)):0;
     const qx=aa[0]+t*dx,qy=aa[1]+t*dy,lon=lonOrigin+qx/(111195*Math.cos(latOrigin*Math.PI/180)),lat=latOrigin+qy/111195;
    return{distance:Math.hypot(pp[0]-qx,pp[1]-qy),p:[lon,lat],t};
   };
    for(const edge of edges){let along=0;const total=pathLength(edge.geometry);for(let i=1;i<edge.geometry.length;i++){
     const hit=project(p,edge.geometry[i-1],edge.geometry[i]);
      const offsetAlong=along+graphMeters(edge.geometry[i-1],hit.p);
     if(hit.distance<best.distance){const node=offsetAlong<=total/2?edge.a:edge.b;best={node,nodes:[edge.a,edge.b],distance:hit.distance,p:hit.p,edgeId:edge.id,segment:i-1,t:hit.t,offsetAlong};}
      along+=graphMeters(edge.geometry[i-1],edge.geometry[i]);
   }}
   return best;
  }
   function compact(points){return points.filter((p,i)=>!i||p[0]!==points[i-1][0]||p[1]!==points[i-1][1]);}
    function pathLength(points){return points.slice(1).reduce((sum,p,i)=>sum+graphMeters(points[i],p),0);}
   function snapToNode(snap,node){
    const edge=data.edges[snap.edgeId];
    if(!edge||(node!==edge.a&&node!==edge.b))throw Error('경로 끝점을 보행 링크에 연결하지 못했어요.');
    const before=compact([...edge.geometry.slice(0,snap.segment+1),snap.p]),after=compact([snap.p,...edge.geometry.slice(snap.segment+1)]);
    return node===edge.a?before.reverse():after;
   }
   function pathBetweenSnaps(edge,startSnap,endSnap){
    const forward=startSnap.offsetAlong<=endSnap.offsetAlong,from=forward?startSnap:endSnap,to=forward?endSnap:startSnap;
    const path=compact([from.p,...edge.geometry.slice(from.segment+1,to.segment+1),to.p]);
    return forward?path:path.reverse();
   }
   function geometry(r){if(r.geometry)return r.geometry;const points=[];r.edgeIds.forEach((eid,i)=>{const e=data.edges[eid],part=e.a===r.nodes[i]?e.geometry:[...e.geometry].reverse();points.push(...(i?part.slice(1):part));});return points;}
   return{route,recommend,recommendFromPoints,recommendFromSnaps,constrained,summarize,nearest,geometry,activeEdges:edges,graphStats};
}
export const features=r=>[r.distance/1000,...r.quality.map(q=>r.distance/1000*(1-q))];
const sigmoid=x=>1/(1+Math.exp(-Math.max(-30,Math.min(30,x))));
export function train(samples){if(samples.length<4)throw Error('서로 다른 경로 선택 4개가 필요합니다.');const dimension=names.length+1;if(samples.some(s=>!Array.isArray(s.x)||s.x.length!==dimension||s.x.some(v=>!Number.isFinite(v))||!Number.isFinite(s.y)))throw Error('경로 학습 특성의 개수나 값이 올바르지 않습니다.');const w=Array(dimension).fill(1);for(let t=0;t<1000;t++){const g=w.map(v=>.015*(v-1));for(const s of samples){const p=sigmoid(w.reduce((a,v,i)=>a+v*s.x[i],0));w.forEach((v,i)=>g[i]+=(p-s.y)*s.x[i]/samples.length);}w.forEach((v,i)=>w[i]=Math.max(.15,Math.min(6,v-.2*g[i])));}return w;}
export function evaluate(s){if(s.length<10)return null;const cut=Math.floor(s.length*.8),w=train(s.slice(0,cut)),test=s.slice(cut);return{train:cut,total:test.length,correct:test.filter(v=>(sigmoid(w.reduce((a,x,i)=>a+x*v.x[i],0))>=.5?1:0)===v.y).length};}
