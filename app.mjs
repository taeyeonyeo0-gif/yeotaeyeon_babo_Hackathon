import{makeEngine,defaults,names,meters,features,train,evaluate,xy}from'./engine.mjs?v=bigroad-off';
import{appendSupplementalCctv}from'./facility-data.mjs';
import{initializeSupabaseUI}from'./supabase-ui.mjs';
import{brandConfig}from'./brand-config.mjs';
const $=s=>document.querySelector(s);
const routeDebugMode=new URLSearchParams(location.search).get('debug')==='route';
const themeApi=window.nightpathTheme;
const themeStorageKey=themeApi?.storageKey||'nightpath-theme-mode';
function applyBrandConfig(){document.title=`${brandConfig.name} | ${brandConfig.title}`;document.querySelectorAll('[data-brand-name]').forEach(element=>element.textContent=brandConfig.name);document.querySelectorAll('[data-brand-english]').forEach(element=>element.textContent=brandConfig.english);document.querySelectorAll('[data-brand-slogan]').forEach(element=>element.textContent=brandConfig.slogan.replace('\n',' '));}
applyBrandConfig();

// 천호동 내부 클릭 판별 알고리즘 (Point-in-Polygon)
function insidePolygon(point, vs) {
    var x = point[0], y = point[1];
    var inside = false;
    for (var i = 0, j = vs.length - 1; i < vs.length; j = i++) {
        var xi = vs[i][0], yi = vs[i][1];
        var xj = vs[j][0], yj = vs[j][1];
        var intersect = ((yi > y) != (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}

const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let data,engine,map,tileLayer,roadLayer,testRoadLayer,testRoadLoadPromise,cityTileManifest,cityTileManifestPromise,cityTileLayers=new Map(),cityTileRequests=new Map(),cityTileFailures=new Map(),cityTilesEnabled=false,cityTileSyncSerial=0,lineLayer,pinLayer,lampLayer,cameraLayer,weights=[...defaults],last,selected,shown=[],pairRoutes=[],samples=[],pick=null,watch=null,gpsMarker,gpsCircle,worker,serial=0,requestId=0,themeMode=themeApi?.mode||'auto',themeTimer=null;const pending=new Map();let positions={start:null,end:null},placeLabels=new Map();
const status=(text,error=false)=>{$('#status').textContent=text;$('#status').classList.toggle('error',error);};
const signature=r=>r.edgeIds.join(',');
const sameSnap=(a,b)=>Boolean(a&&b&&a.edgeId===b.edgeId&&a.segment===b.segment&&a.t===b.t&&a.offsetAlong===b.offsetAlong&&a.p[0]===b.p[0]&&a.p[1]===b.p[1]&&a.nodes[0]===b.nodes[0]&&a.nodes[1]===b.nodes[1]);
function applyTheme(theme){document.documentElement.dataset.theme=theme;document.body.dataset.theme=theme;const isDark=theme==='dark',meta=document.querySelector('meta[name="theme-color"]'),favicon=document.querySelector('link[rel="icon"]');if(meta)meta.content=isDark?'#0d171b':'#F3F4F2';if(favicon)favicon.href=window.themeFaviconSources?.[isDark?'dark':'light']||(isDark?'./favicon-night.png':'./favicon-day.png');const status=$('#theme-status'),moon=$('#theme-moon'),sun=$('#theme-sun');if(status){status.textContent=isDark?'적용 중: 밤':'적용 중: 낮';status.setAttribute('aria-label',isDark?'현재 적용된 밤 테마':'현재 적용된 낮 테마');}if(moon){moon.hidden=!isDark;moon.title='현재 적용된 밤 테마';}if(sun){sun.hidden=isDark;sun.title='현재 적용된 낮 테마';}}
function refreshTheme(){applyTheme(themeApi?.resolveTheme(themeMode)||'dark');}
function scheduleThemeRefresh(){clearTimeout(themeTimer);const now=new Date(),delay=60000-now.getSeconds()*1000-now.getMilliseconds()+25;themeTimer=setTimeout(()=>{if(themeMode==='auto')refreshTheme();scheduleThemeRefresh();},delay);}
function initializeTheme(){const select=$('#theme-mode');themeMode=themeApi?.mode||'auto';if(select){const day=select.querySelector('option[value="light"]'),night=select.querySelector('option[value="dark"]');if(day)day.textContent='낮';if(night)night.textContent='밤';select.value=themeMode;select.onchange=event=>{themeMode=event.target.value;try{localStorage.setItem(themeStorageKey,themeMode);}catch{}refreshTheme();};}refreshTheme();scheduleThemeRefresh();document.addEventListener('visibilitychange',()=>{if(!document.hidden&&themeMode==='auto')refreshTheme();});}
function handleTileError(){status('배경지도 연결이 느려요. 보행망·경로·안전시설은 계속 표시됩니다.');}
async function loadTestRoadLayer(){
 if(testRoadLayer)return testRoadLayer;
 if(!testRoadLoadPromise)testRoadLoadPromise=(async()=>{
  const response=await fetch('./data/generated/changwon-walking.json',{cache:'no-cache'});
  if(!response.ok)throw Error(`창원 OSM 시험 도로 파일을 불러오지 못했어요 (${response.status}).`);
  const graph=await response.json(),edges=Array.isArray(graph.edges)?graph.edges:[],lines=edges.filter(edge=>Array.isArray(edge.geometry)&&edge.geometry.length>1&&edge.geometry.every(point=>Array.isArray(point)&&point.length===2&&point.every(Number.isFinite)));
  if(!lines.length)throw Error('시험 도로 파일에 표시할 실제 도로 좌표가 없어요.');
  testRoadLayer=L.featureGroup(lines.map(edge=>L.polyline(edge.geometry.map(point=>[point[1],point[0]]),{color:'#d85be8',weight:2,opacity:.9,smoothFactor:1.5,interactive:false})));testRoadLayer.testRoadCount=lines.length;testRoadLayer.snapshot=graph.meta?.retrieved||'시점 미상';
  return testRoadLayer;
 })();
 try{return await testRoadLoadPromise;}catch(error){testRoadLoadPromise=null;throw error;}
}
function configureTestRoadToggle(){
 const toggle=$('#show-test-roads'),label=$('#test-road-status');if(!toggle)return;
 toggle.addEventListener('change',async()=>{
  if(!toggle.checked){if(testRoadLayer&&map.hasLayer(testRoadLayer))map.removeLayer(testRoadLayer);if(label)label.textContent='숨김';return;}
  toggle.disabled=true;if(label)label.textContent='불러오는 중';
  try{const layer=await loadTestRoadLayer();if(!map.hasLayer(layer)){layer.addTo(map);if(!map.getBounds().intersects(layer.getBounds()))map.fitBounds(layer.getBounds(),{padding:[28,28],maxZoom:16});}if(label)label.textContent=`${layer.testRoadCount.toLocaleString()}개 · OSM ${layer.snapshot}`;}
  catch(error){toggle.checked=false;if(label)label.textContent='파일 오류';console.error('[안심보행맵] 창원 OSM 시험 도로 표시 실패:',error);}
  finally{toggle.disabled=false;}
 });
}
async function loadCityTileManifest(){
 if(cityTileManifest)return cityTileManifest;
 if(!cityTileManifestPromise)cityTileManifestPromise=(async()=>{
  const response=await fetch('./data/generated/changwon-city/manifest.json',{cache:'no-cache'});if(!response.ok)throw Error(`창원 타일 목록을 불러오지 못했어요 (${response.status}).`);
  const manifest=await response.json();if(manifest.schema!=='changwon-osm-road-tiles-v1'||!Array.isArray(manifest.tiles)||!manifest.tiles.length)throw Error('완료된 창원 인접 타일 목록이 비었거나 형식이 올바르지 않아요.');
  if(manifest.tiles.some(tile=>!tile.id||typeof tile.file!=='string'||!tile.file.startsWith('tiles/')||tile.file.includes('..')||!Array.isArray(tile.bbox)||tile.bbox.length!==4||!tile.bbox.every(Number.isFinite)))throw Error('타일 목록에 잘못된 범위 또는 파일 경로가 있어요.');
  cityTileManifest=manifest;return manifest;
 })();
 try{return await cityTileManifestPromise;}catch(error){cityTileManifestPromise=null;throw error;}
}
async function loadCityTile(tile){
 if(cityTileLayers.has(tile.id))return cityTileLayers.get(tile.id);
 let request=cityTileRequests.get(tile.id);
 if(!request){
  request=(async()=>{
   const url=new URL(`./data/generated/changwon-city/${tile.file}`,location.href),response=await fetch(url,{cache:'force-cache'});if(!response.ok)throw Error(`타일 파일을 불러오지 못했어요 (${response.status}): ${tile.id}`);
   const collection=await response.json();if(collection.type!=='FeatureCollection'||!Array.isArray(collection.features)||collection.features.length!==tile.featureCount||collection.meta?.coordinateCount!==tile.coordinateCount)throw Error(`타일 내용과 완료 manifest가 일치하지 않아요: ${tile.id}`);
   const layer=L.geoJSON(collection,{style:()=>({color:'#11a8c4',weight:2.4,opacity:.92,smoothFactor:1.5}),interactive:false});if(collection.features.length&&!layer.getBounds().isValid())throw Error(`타일 좌표를 검증할 수 없어요: ${tile.id}`);layer.cityTileRoadCount=collection.features.length;return layer;
  })();
  cityTileRequests.set(tile.id,request);
 }
 try{const layer=await request;cityTileLayers.set(tile.id,layer);return layer;}finally{if(cityTileRequests.get(tile.id)===request)cityTileRequests.delete(tile.id);}
}
async function syncCityTileLayer(){
 if(!cityTilesEnabled||!cityTileManifest)return;
 const serial=++cityTileSyncSerial,bounds=map.getBounds().pad(.035),visible=cityTileManifest.tiles.filter(tile=>bounds.getWest()<=tile.bbox[2]&&bounds.getEast()>=tile.bbox[0]&&bounds.getSouth()<=tile.bbox[3]&&bounds.getNorth()>=tile.bbox[1]),visibleIds=new Set(visible.map(tile=>tile.id)),label=$('#city-tile-status');
 for(const[id,layer]of cityTileLayers){if(!visibleIds.has(id)){if(map.hasLayer(layer))map.removeLayer(layer);cityTileLayers.delete(id);}}
 if(!visible.length){if(label)label.textContent='준비 타일 없음';return;}
 if(label)label.textContent='불러오는 중';
 const results=await Promise.all(visible.map(async tile=>{
  if(cityTileFailures.has(tile.id))return{tile,error:cityTileFailures.get(tile.id)};
  try{const layer=await loadCityTile(tile);if(serial!==cityTileSyncSerial||!cityTilesEnabled||!visibleIds.has(tile.id))return{tile,stale:true};if(!map.hasLayer(layer))layer.addTo(map);return{tile,layer};}
  catch(error){cityTileFailures.set(tile.id,error);console.warn('[안심보행맵] 창원 OSM 타일 로딩 실패:',tile.id,error);return{tile,error};}
 }));
 if(serial!==cityTileSyncSerial||!cityTilesEnabled)return;
 const loaded=results.filter(result=>result.layer&&map.hasLayer(result.layer)),roadCount=loaded.reduce((total,result)=>total+result.layer.cityTileRoadCount,0),failed=results.filter(result=>result.error).length;
 if(label)label.textContent=failed?`${loaded.length}/${visible.length} · 오류 ${failed}`:`${loaded.length}/${visible.length}타일 · ${roadCount.toLocaleString()}선`;
}
function configureCityTileToggle(){
 const toggle=$('#show-city-tiles'),label=$('#city-tile-status');if(!toggle)return;
 map.on('moveend zoomend',()=>{if(cityTilesEnabled)void syncCityTileLayer();});
 toggle.addEventListener('change',async()=>{
  if(!toggle.checked){cityTilesEnabled=false;cityTileSyncSerial++;for(const layer of cityTileLayers.values())if(map.hasLayer(layer))map.removeLayer(layer);cityTileLayers.clear();cityTileFailures.clear();if(label)label.textContent='숨김';return;}
  toggle.disabled=true;if(label)label.textContent='타일 목록 불러오는 중';
  try{const manifest=await loadCityTileManifest(),[west,south,east,north]=manifest.availableBounds,availableBounds=L.latLngBounds([[south,west],[north,east]]);cityTilesEnabled=true;if(!map.getBounds().intersects(availableBounds))map.fitBounds(availableBounds,{padding:[28,28],maxZoom:13});await syncCityTileLayer();}
  catch(error){cityTilesEnabled=false;toggle.checked=false;if(label)label.textContent='타일 목록 오류';console.error('[안심보행맵] 창원 타일 목록 로딩 실패:',error);}
  finally{toggle.disabled=false;}
 });
}
function updateRouteDebug(){if(!routeDebugMode||!$('#route-debug-output'))return;const start=positions.start,end=positions.end;if(!last||!start||!end){$('#route-debug-output').textContent=JSON.stringify({graphSnapshot:data?.meta?.retrieved,activeGraph:engine?.graphStats,origin:start?.raw||null,startSnap:start?.snap||null,destination:end?.raw||null,endSnap:end?.snap||null,route:'pending'},null,2);return;}const route=shown[selected]||last.shortest,geometry=route.geometry||engine.geometry(route),leafletPoints=geometry.map(p=>[p[1],p[0]]),mapRect=map.getContainer().getBoundingClientRect(),iconCenters=[...document.querySelectorAll('#map .leaflet-marker-icon.pin')].map(icon=>{const rect=icon.getBoundingClientRect();return{x:rect.left+rect.width/2-mapRect.left,y:rect.top+rect.height/2-mapRect.top};}),edges=route.edgeIds.map((id,i)=>{const edge=data.edges[id],from=route.nodes[i],to=route.nodes[i+1];return{id,sourceId:edge.sourceId,nodes:[from,to],connects:(edge.a===from&&edge.b===to)||(edge.a===to&&edge.b===from),distance:edge.distance,geometry:edge.geometry};}),segmentChecks=geometry.slice(1).map((point,i)=>{const a=geometry[i],mid=[(a[0]+point[0])/2,(a[1]+point[1])/2],hit=engine.nearest(mid);return{segment:i,nearestEdge:hit.edgeId,offsetMeters:+hit.distance.toFixed(3)};}),routeStartPixel=map.latLngToContainerPoint(leafletPoints[0]),routeEndPixel=map.latLngToContainerPoint(leafletPoints.at(-1)),startMarkerPixel=map.latLngToContainerPoint([start.snap.p[1],start.snap.p[0]]),endMarkerPixel=map.latLngToContainerPoint([end.snap.p[1],end.snap.p[0]]);$('#route-debug-output').textContent=JSON.stringify({graphSnapshot:data.meta.retrieved,activeGraph:engine.graphStats,baseTileVisible:map.hasLayer(tileLayer),walkGraphVisible:map.hasLayer(roadLayer),routeVisible:map.hasLayer(lineLayer),origin:{raw:start.raw,snap:start.snap},destination:{raw:end.raw,snap:end.snap},route:{nodes:route.nodes,edgeIds:route.edgeIds,start:geometry[0],end:geometry.at(-1),coordinatesLonLat:geometry,leafletLatLon:leafletPoints,endpointGapMeters:[meters(geometry[0],start.snap.p),meters(geometry.at(-1),end.snap.p)]},pixels:{routeStart:routeStartPixel,markerStart:startMarkerPixel,routeEnd:routeEndPixel,markerEnd:endMarkerPixel,renderedMarkerCenters:iconCenters},edges,segmentChecks},null,2);}
function clearRoute(){last=null;shown=[];selected=0;pairRoutes=[];lineLayer?.clearLayers();$('#results').innerHTML='';$('#pairs').innerHTML='';$('#route-reason').textContent='';updateRouteDebug();}
function controls(){ $('#weights').innerHTML=names.map((n,i)=>`<div class="rangehead"><label for="w${i}">${n}</label><b id="v${i}">${weights[i].toFixed(1)}</b></div><input id="w${i}" type="range" min="-5" max="5" step="0.1" value="${weights[i]}">`).join('');names.forEach((_,i)=>$('#w'+i).oninput=e=>{weights[i]=+e.target.value;$('#v'+i).textContent=weights[i].toFixed(1);$('#mode').textContent='직접 조정한 가중치';schedule();});}
let timer;function schedule(){clearTimeout(timer);timer=setTimeout(calculate,220);}
function setPoint(key,p,label){
  const n=engine.nearest(p);
  if(n.distance>45)throw Error('선택한 위치 가까이에 연결된 보행망이 없어요. 지도의 회색 보행로를 선택해 주세요.');
  clearRoute();positions[key]={node:n.node,p:n.p||p,raw:p,label,offset:n.distance,snap:n};$('#'+key).value=label;drawPins();
  updateSnapInfo();
  updateRouteDebug();
}
function updateSnapInfo(){$('#snap-info').textContent=Object.entries(positions).filter(([,v])=>v).map(([k,v])=>`${k==='start'?'출발':'도착'} 장소에서 공개 보행망 접점까지 ${Math.round(v.offset)}m`).join(' · ')+' · 접점 사이만 안내';}
function initializeWorkspaceTabs(){
  const auxiliary=$('#workspace-auxiliary'),preferences=$('#panel-preferences'),account=$('#panel-account'),dataPanel=$('#panel-data');
  if(auxiliary){const learn=auxiliary.querySelector('.learn'),cloud=auxiliary.querySelector('#cloud-panel'),details=auxiliary.querySelector('#data-details'),footer=auxiliary.querySelector('footer');if(learn)preferences.append(learn);if(cloud)account.append(cloud);if(details){details.open=true;dataPanel.append(details);}if(footer)dataPanel.append(footer);auxiliary.remove();}
  const tabs=[...document.querySelectorAll('.workspace-tabs [role="tab"]')],panels=[...document.querySelectorAll('[data-tab-panel]')];
  const activate=name=>{tabs.forEach(tab=>{const active=tab.dataset.workspaceTab===name;tab.setAttribute('aria-selected',String(active));tab.tabIndex=active?0:-1;});panels.forEach(panel=>{panel.hidden=panel.dataset.tabPanel!==name;});if(map)requestAnimationFrame(()=>map.invalidateSize({pan:false}));};
  tabs.forEach((tab,index)=>{tab.addEventListener('click',()=>activate(tab.dataset.workspaceTab));tab.addEventListener('keydown',event=>{let next;if(event.key==='ArrowRight')next=(index+1)%tabs.length;else if(event.key==='ArrowLeft')next=(index-1+tabs.length)%tabs.length;else if(event.key==='Home')next=0;else if(event.key==='End')next=tabs.length-1;else return;event.preventDefault();tabs[next].focus();tabs[next].click();});});
  document.querySelectorAll('a[data-workspace-tab]').forEach(link=>link.addEventListener('click',event=>{event.preventDefault();if(window.matchMedia?.('(max-width:720px)').matches&&$('.controls')?.classList.contains('is-collapsed'))$('#mobile-controls-toggle')?.click();activate(link.dataset.workspaceTab);}));
  const authDialog=$('#auth-dialog');
  $('#nav-account')?.addEventListener('click',()=>{if($('#nav-user-label')?.textContent.trim()==='로그인'){if(!authDialog.open)authDialog.showModal();if(!$('#cloud-auth-view').hidden)requestAnimationFrame(()=>$('#auth-email').focus());return;}if(window.matchMedia?.('(max-width:720px)').matches&&$('.controls')?.classList.contains('is-collapsed'))$('#mobile-controls-toggle')?.click();activate('account');});
  $('#auth-close')?.addEventListener('click',()=>authDialog.close());
  authDialog?.addEventListener('click',event=>{if(event.target===authDialog)authDialog.close();});
}
function initializeMobileControls(){
  const panel=$('.controls'),button=$('#mobile-controls-toggle');
  if(!panel){console.warn('[안심보행맵] 경로 설정 패널(.controls)이 없어 모바일 접이식 컨트롤을 건너뜁니다.');return;}
  if(!button){console.warn('[안심보행맵] 모바일 컨트롤 버튼(#mobile-controls-toggle)이 없어 경로 설정을 항상 표시합니다.');return;}
  const query=window.matchMedia?.('(max-width:720px)');
  if(!query){console.warn('[안심보행맵] 화면 크기 감지를 사용할 수 없어 접이식 컨트롤을 비활성화합니다.');button.hidden=true;return;}
  const label=button.querySelector('[data-drawer-label]');
  if(!label)console.warn('[안심보행맵] 모바일 컨트롤 버튼에 [data-drawer-label]이 없습니다. 접근성 이름으로 대체합니다.');
  const setLabel=text=>{if(label)label.textContent=text;button.setAttribute('aria-label',text);};
  const sync=()=>{const mobile=query.matches;button.hidden=!mobile;if(!mobile){panel.classList.remove('is-collapsed');panel.scrollTop=0;button.setAttribute('aria-expanded','true');setLabel('탭 패널');return;}if(panel.dataset.mobileExpanded!=='true')panel.classList.add('is-collapsed');const expanded=!panel.classList.contains('is-collapsed');if(!expanded)panel.scrollTop=0;button.setAttribute('aria-expanded',String(expanded));setLabel(expanded?'탭 패널 닫기':'탭 패널 열기');};
  button.addEventListener('click',()=>{panel.classList.toggle('is-collapsed');panel.dataset.mobileExpanded=String(!panel.classList.contains('is-collapsed'));sync();});
  if(query.addEventListener)query.addEventListener('change',()=>{delete panel.dataset.mobileExpanded;sync();});else query.addListener?.(()=>{delete panel.dataset.mobileExpanded;sync();});
  sync();
}
function favoriteLocation(name){const place=placeLabels.get(name);if(place)return place.p;const match=/^지도 선택 \((-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\)$/.exec(name);if(!match)return null;const lat=Number(match[1]),lon=Number(match[2]);return Number.isFinite(lat)&&Number.isFinite(lon)&&lat>=-90&&lat<=90&&lon>=-180&&lon<=180?[lon,lat]:null;}
function favoriteName(position){return placeLabels.has(position.label)?position.label:`지도 선택 (${position.raw[1].toFixed(5)}, ${position.raw[0].toFixed(5)})`;}
function resolve(key){const input=$('#'+key).value.trim();if(positions[key]?.label===input)return;let p=placeLabels.get(input);if(!p){const all=[...placeLabels.entries()].filter(([s])=>s.includes(input));if(input&&all.length===1)p=all[0][1];}if(!p)throw Error(`${key==='start'?'출발':'도착'} 장소를 목록에서 고르거나 지도에서 선택해 주세요.`);setPoint(key,p.p,p.label);}
function drawPins(){pinLayer.clearLayers();for(const[k,p]of Object.entries(positions)){if(!p)continue;const end=k==='end',snap=p.p,raw=p.raw||p.p;L.marker([snap[1],snap[0]],{icon:L.divIcon({className:'pin '+(end?'end':''),html:end?'도':'출',iconSize:[30,30],iconAnchor:[15,15]})}).bindPopup(`<b>${end?'도착':'출발'} 보행망 접점</b>${esc(p.label)}<br>선분 투영점까지 ${Math.round(p.offset)}m`).addTo(pinLayer);if(p.offset>3)L.polyline([[raw[1],raw[0]],[snap[1],snap[0]]],{color:'#73808c',weight:2,dashArray:'2 6',interactive:false}).addTo(pinLayer);}}
  function rpc(type,params){if(!worker)return Promise.resolve(engine.recommendFromSnaps(params.startSnap,params.endSnap,params.weights,params.extra,params.speed));const id=++requestId;return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});worker.postMessage({id,type,...params});});}
  async function calculate(){if(!engine)return;const ticket=++serial;try{resolve('start');resolve('end');if(positions.start.node===positions.end.node&&meters(positions.start.p,positions.end.p)<1)throw Error('출발과 도착이 같은 보행망 지점이에요. 다른 위치를 선택해 주세요.');stopFollow();$('#search').disabled=true;status('실제 보행망에서 후보 경로를 비교하고 있어요…');const result=await rpc('route',{startSnap:positions.start.snap,endSnap:positions.end.snap,weights,extra:+$('#extra').value,speed:+$('#speed').value});if(ticket!==serial)return;if(!sameSnap(result.snaps?.start,positions.start.snap)||!sameSnap(result.snaps?.end,positions.end.snap))throw Error('계산에 사용한 보행 접점이 현재 마커와 달라요. 다시 검색해 주세요.');last=result;const a=last.shortest,b=last.recommended;shown=[a];if(signature(a)!==signature(b))shown.push(b);selected=0;renderCards();drawRoute();renderPair();const same=signature(a)===signature(b);$('#route-reason').textContent=same?'시간 제한 안에서 최단 거리와 안전 우선 경로가 같습니다.':`안전 우선 경로는 최단 대비 ${((b.distance-a.distance)/last.speed).toFixed(1)}분 추가 · 보안등 근접 구간 ${Math.round((b.quality[0]-a.quality[0])*100)}%p 변화 · 등록 CCTV 근접 구간 ${Math.round((b.quality[1]-a.quality[1])*100)}%p 변화`;
  status(`${last.generated}개 중복 없는 후보 중 ${last.candidates.length}개가 추가 시간 조건을 만족합니다. 시간은 보행망 접점 사이의 추정치이며 신호 대기는 제외됩니다.`);fit();}catch(e){if(ticket!==serial)return;status(e.message,true);last=null;shown=[];lineLayer?.clearLayers();$('#results').innerHTML='';$('#pairs').innerHTML='';$('#route-reason').textContent='';}finally{if(ticket===serial)$('#search').disabled=false;}}
function overlap(r,a){const ids=new Set(a.edgeIds);return r.distance?r.edgeIds.reduce((s,id)=>s+(ids.has(id)?data.edges[id].distance:0),0)/r.distance:1;}
function metrics(r){return `<div class="metrics">${names.map((n,i)=>`<div class="metric">${n}<b>${Math.round(r.quality[i]*100)}<small>\%</small></b><div class="bar"><i style="width:${r.quality[i]*100}%"></i></div></div>`).join('')}</div>`;}
function title(i){return i===0?'최단 거리':'안전 우선';}
function renderCards(){ $('#results').innerHTML=shown.map((r,i)=>`<button class="route-card ${i===selected?'selected':''} ${signature(r)===signature(last.recommended)?'recommended':''}" data-route="${i}" aria-pressed="${i===selected}"><div class="route-top"><h2>${title(i)}</h2><span class="pill">${i?`+${((r.distance-last.shortest.distance)/last.speed).toFixed(1)}분`:'거리 우선'}</span></div><div class="time">${(r.distance/last.speed).toFixed(1)}<small> 분 · ${(r.distance/1000).toFixed(2)}km</small></div>${metrics(r)}<p class="fine">보안등 30m·CCTV 50m 내 구간 비율. 안전 확률이나 실제 밝기를 뜻하지 않습니다.</p></button>`).join('');document.querySelectorAll('[data-route]').forEach(b=>b.onclick=()=>{selected=+b.dataset.route;stopFollow();renderCards();drawRoute();});}
function routePoints(route){return(route.geometry||engine.geometry(route)).map(p=>[p[1],p[0]]);}
function drawRoute(){lineLayer.clearLayers();if(!last){updateRouteDebug();return;}const shortest=routePoints(last.shortest),r=shown[selected],points=routePoints(r);if(selected===0){L.polyline(shortest,{color:'#7f1d1d',weight:7,opacity:.45}).addTo(lineLayer);L.polyline(shortest,{color:'#ef4444',weight:3.5,opacity:1}).addTo(lineLayer);}else{L.polyline(shortest,{color:'#73808c',weight:5,opacity:.75,dashArray:'7 8'}).addTo(lineLayer);L.polyline(points,{color:'#7f1d1d',weight:7,opacity:.45}).addTo(lineLayer);L.polyline(points,{color:'#ef4444',weight:3.5,opacity:1}).addTo(lineLayer);}pinLayer.bringToFront?.();updateRouteDebug();}
function fit(){if(last){const coords=routePoints(shown[selected]);if(coords.length){map.invalidateSize({pan:false});map.fitBounds(L.latLngBounds(coords),{padding:[35,35],maxZoom:17});}}}
function directions(r){const groups=[];let group=null,heading=null;for(let i=0;i<r.edgeIds.length;i++){const e=data.edges[r.edgeIds[i]],coords=e.a===r.nodes[i]?e.geometry:[...e.geometry].reverse(),a=xy(coords[0]),b=xy(coords.at(-1)),angle=Math.atan2(b[1]-a[1],b[0]-a[0])*180/Math.PI;const turn=heading===null?0:((angle-heading+540)%360)-180;const text=e.crossing?'표시된 횡단보도 이용':`${e.area} 보행로`;if(!group||Math.abs(turn)>40||group.crossing!==e.crossing||group.area!==e.area){group={distance:0,text,turn,area:e.area,crossing:e.crossing};groups.push(group);}group.distance+=e.distance;heading=angle;}$('#steps').innerHTML=groups.map((g,i)=>`<li>${i===0?'출발':g.turn>40?'왼쪽 방향':g.turn< -40?'오른쪽 방향':'계속 이동'} · ${esc(g.text)} 약 ${Math.round(g.distance)}m</li>`).join('')+'<li>도착 보행망 접점. 마지막 진입로는 현장에서 확인해 주세요.</li>';}
function renderPair(){const a=last.shortest,b=shown.find(r=>signature(r)!==signature(a));if(!b){pairRoutes=[];$('#pairs').innerHTML='<p class="muted">비교할 서로 다른 경로가 없어요. 다른 도착지나 추가 시간을 선택해 주세요.</p>';return;}pairRoutes=[a,b];$('#pairs').innerHTML=pairRoutes.map((r,i)=>`<article class="choice"><h3>${i?'B · 안전 우선':'A · 최단 거리'}</h3><div class="time">${(r.distance/last.speed).toFixed(1)}<small> 분</small></div><dl>${names.map((n,j)=>`<dt>${n}</dt><dd>${Math.round(r.quality[j]*100)}%</dd>`).join('')}</dl><button data-choice="${i}">이 길이 좋아요</button></article>`).join('');document.querySelectorAll('[data-choice]').forEach(btn=>btn.onclick=()=>{const i=+btn.dataset.choice,fa=features(a),fb=features(b),key=[last.start,last.end].sort((x,y)=>x-y).join('-');const sample={key,x:fb.map((v,j)=>v-fa[j]),y:i===0?1:0,a,b,start:last.start,end:last.end};const idx=samples.findIndex(s=>s.key===key);if(idx<0)samples.push(sample);else samples[idx]=sample;$('#count').textContent=`서로 다른 출발·도착 ${samples.length}개`;$('#apply').disabled=samples.length<4;$('#learningStatus').textContent=`${i?'B':'A'} 선택을 기록했어요. ${samples.length<4?`다른 출발·도착으로 ${4-samples.length}번 더 선택해 주세요.`:'학습 버튼으로 추천에 적용할 수 있어요.'}`;});}
function stopFollow(){if(watch!==null){navigator.geolocation.clearWatch(watch);watch=null;}if($('#follow'))$('#follow').textContent='현재 위치로 따라가기';if($('#gps-status'))$('#gps-status').textContent='위치 추적은 버튼을 눌렀을 때만 시작하며, 위치 기록을 서버에 저장하지 않습니다.';}
function progress(p,points){let nearest=Infinity,along=0,total=0;const pp=xy(p);for(let i=1;i<points.length;i++){const a=xy(points[i-1]),b=xy(points[i]),dx=b[0]-a[0],dy=b[1]-a[1],len=Math.hypot(dx,dy),t=len?Math.max(0,Math.min(1,((pp[0]-a[0])*dx+(pp[1]-a[1])*dy)/(len*len))):0,d=Math.hypot(pp[0]-a[0]-t*dx,pp[1]-a[1]-t*dy);if(d<nearest){nearest=d;along=total+t*len;}total+=len;}return{offset:nearest,remaining:total-along};}
function gpsDraw(position){const c=position.coords,p=[c.longitude,c.latitude],latlng=[p[1],p[0]];if(!gpsMarker)gpsMarker=L.circleMarker(latlng,{radius:7,color:'#fff',weight:3,fillColor:'#3178f6',fillOpacity:1}).addTo(map);else gpsMarker.setLatLng(latlng);if(!gpsCircle)gpsCircle=L.circle(latlng,{radius:c.accuracy,color:'#3178f6',weight:1,fillOpacity:.08}).addTo(map);else gpsCircle.setLatLng(latlng).setRadius(c.accuracy);return p;}
function locate(){if(!navigator.geolocation){status('이 브라우저에서 위치 기능을 사용할 수 없어요.',true);return;}status('위치 권한을 허용하면 출발 지점을 선택해요.');navigator.geolocation.getCurrentPosition(pos=>{try{const p=gpsDraw(pos);if(pos.coords.accuracy>80)throw Error('위치 오차가 커요. 지도에서 출발 지점을 직접 선택해 주세요.');setPoint('start',p,'내 위치');map.setView([p[1],p[0]],17);calculate();}catch(e){status(e.message,true);}},()=>status('위치 권한을 사용할 수 없어요. 장소 검색 또는 지도 선택을 이용해 주세요.',true),{enableHighAccuracy:true,timeout:15000,maximumAge:10000});}
function follow(){if(watch!==null){stopFollow();return;}if(!last||!navigator.geolocation){status('경로와 위치 권한을 확인해 주세요.',true);return;}$('#follow').textContent='위치 추적 중지';watch=navigator.geolocation.watchPosition(pos=>{const p=gpsDraw(pos);if(pos.coords.accuracy>80){$('#gps-status').textContent=`GPS 오차 약 ${Math.round(pos.coords.accuracy)}m · 경로 진행을 판단하지 않습니다.`;return;}const g=progress(p,engine.geometry(shown[selected]));$('#gps-status').textContent=g.offset>Math.max(45,pos.coords.accuracy)?`경로에서 약 ${Math.round(g.offset)}m 떨어져 있어요. 내 위치를 출발로 설정해 다시 비교해 주세요.`:`선택 경로의 가까운 지점부터 약 ${Math.round(g.remaining)}m 남음 · GPS 오차 약 ${Math.round(pos.coords.accuracy)}m · ${new Date(pos.timestamp).toLocaleTimeString('ko-KR')} 갱신`;},()=>{stopFollow();status('위치 추적이 중단됐어요. 권한을 확인하거나 지도로 경로를 확인해 주세요.',true);},{enableHighAccuracy:true,timeout:15000,maximumAge:5000});}
function download(text,name,type){const url=URL.createObjectURL(new Blob([text],{type})),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
async function init(){try{
   const response=await fetch('./data.json',{cache:'no-cache'});if(!response.ok)throw Error('실제 데이터 파일을 불러오지 못했어요. 새로고침해 주세요.');data=await response.json();
   const exclusionResponse=await fetch('./data/graph-exclusions.json',{cache:'no-cache'});if(!exclusionResponse.ok)throw Error('보행망 접근 제한 자료를 불러오지 못했어요. 새로고침해 주세요.');const exclusionData=await exclusionResponse.json();if(exclusionData.graphSnapshot!==data.meta.retrieved)throw Error('보행망과 접근 제한 자료의 기준 날짜가 달라요.');const excludedSourceIds=new Set(exclusionData.ways.flatMap(way=>way.sourceIds)),matchedExclusions=new Set();for(const edge of data.edges)if(excludedSourceIds.has(edge.sourceId)){edge.graphExcluded=true;matchedExclusions.add(edge.sourceId);}if(matchedExclusions.size!==excludedSourceIds.size)throw Error('보행망 접근 제한 자료와 간선 목록이 맞지 않아요.');data.meta.audit.access_excluded_edges=matchedExclusions.size;
   // The graph is an OSM snapshot; older metadata incorrectly labeled it as Seoul city data.
   data.meta.sources.network={name:'OpenStreetMap 보행 링크',page:data.meta.sources.osm.page,date:data.meta.retrieved};
   const extraCctvResponse=await fetch('./data/cheonho-cctv.csv',{cache:'no-cache'});if(extraCctvResponse.ok){const added=appendSupplementalCctv(data,await extraCctvResponse.text());data.meta.audit.cctv=(data.meta.audit.cctv||0)+added;}
  engine=makeEngine(data);if(!globalThis.L)throw Error('지도 기능을 불러오지 못했어요. 새로고침해 주세요.');const audit=data.meta.audit;Object.assign(audit,{snapshot_nodes:audit.nodes,snapshot_links:audit.links,nodes:engine.graphStats.activeNodeCount,links:engine.graphStats.activeEdgeCount,component_count:engine.graphStats.componentCount,excluded_disconnected_nodes:engine.graphStats.disconnectedNodeCount,duplicate_reverse_edge_records:engine.graphStats.duplicateReverseRecords,disconnected_physical_edges:engine.graphStats.disconnectedPhysicalEdges});
       const mapViewBounds=L.latLngBounds([[22,101],[49,141]]),mapViewCenter=mapViewBounds.getCenter();
    map=L.map('map',{preferCanvas:true,zoomControl:true,worldCopyJump:false,maxBounds:mapViewBounds,maxBoundsViscosity:1,minZoom:3}).setView(mapViewCenter,3);const setMapRangeMinZoom=()=>{const minimum=map.getBoundsZoom(mapViewBounds,true,L.point(32,32));map.setMinZoom(minimum);if(map.getZoom()<minimum)map.fitBounds(mapViewBounds,{padding:[32,32],maxZoom:minimum,animate:false});return minimum;};const mapRangeMinZoom=setMapRangeMinZoom();map.fitBounds(mapViewBounds,{padding:[32,32],maxZoom:mapRangeMinZoom,animate:false});map.on('resize',setMapRangeMinZoom);let tileErrors=0;tileLayer=L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,noWrap:true,attribution:'© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors'}).on('tileerror',()=>{if(++tileErrors===3)handleTileError();}).addTo(map);L.control.scale({imperial:false}).addTo(map);
 
 const b=data.meta.bbox;L.rectangle([[b[1],b[0]],[b[3],b[2]]],{color:'#647a89',weight:1,dashArray:'5 8',fill:false,interactive:false}).addTo(map);

 // ★ 핵심: 천호동 경계선을 지도에 빨간색으로 그립니다.
 if (data.meta.boundary && data.meta.boundary.length > 0) {
     const latlngs = data.meta.boundary.map(p => [p[1], p[0]]);
       L.polygon(latlngs, {color: '#d47569', weight: 2, dashArray: '5 8', fill: false, interactive: false}).addTo(map);
 }
    roadLayer=L.layerGroup(engine.activeEdges.map(e=>L.polyline(e.geometry.map(p=>[p[1],p[0]]),{color:'#64748b',weight:3,opacity:.55,interactive:false}))).addTo(map);lineLayer=L.layerGroup().addTo(map);pinLayer=L.layerGroup().addTo(map);configureTestRoadToggle();configureCityTileToggle();
  if(routeDebugMode){$('#route-debug').hidden=false;$('#route-debug').open=true;$('#debug-tiles').onchange=e=>{e.target.checked?tileLayer.addTo(map):map.removeLayer(tileLayer);updateRouteDebug();};$('#debug-network').onchange=e=>{e.target.checked?roadLayer.addTo(map):map.removeLayer(roadLayer);updateRouteDebug();};$('#debug-route-line').onchange=e=>{e.target.checked?lineLayer.addTo(map):map.removeLayer(lineLayer);updateRouteDebug();};map.on('moveend zoomend',updateRouteDebug);}
 lampLayer=L.layerGroup();cameraLayer=L.layerGroup().addTo(map);for(const f of data.facilities){const color=f.type==='lamp'?'#d29413':f.type==='cctv'?'#367bb8':'#cb6545';const marker=L.circleMarker([f.p[1],f.p[0]],{radius:f.type==='lamp'?3:5,color,weight:1,fillColor:color,fillOpacity:.75}).bindPopup(`<b>${f.type==='lamp'?'등록 보안등':f.type==='cctv'?'안심귀갓길 CCTV':'안심벨'}</b>${esc(f.id)}<br>자료 기준: ${esc(f.date)}<br>현재 작동 상태 미확인`);marker.addTo(f.type==='lamp'?lampLayer:cameraLayer);}
 
 map.on('click',e=>{if(!pick)return;
 try{
  // ★ 핵심: 클릭한 위치가 빨간선 바깥이면 에러를 던져 차단합니다.
   if (data.meta.boundary && data.meta.boundary.length > 0) {
       if (!insidePolygon([e.latlng.lng, e.latlng.lat], data.meta.boundary)) {
           throw Error('천호동 밖의 위치는 선택할 수 없어요. 빨간 선 안쪽을 눌러주세요.');
       }
   }
   if(pick==='report'){$('#report-latitude').value=e.latlng.lat.toFixed(6);$('#report-longitude').value=e.latlng.lng.toFixed(6);pick=null;map.getContainer().classList.remove('pick-mode');clearPickButton();$('#map-hint').textContent='제보 위치를 선택했습니다. 출발·도착 경로에는 영향을 주지 않습니다.';status('제보 위치를 입력했어요.');return;}
   const key=pick;setPoint(key,[e.latlng.lng,e.latlng.lat],`지도 선택 (${e.latlng.lat.toFixed(5)}, ${e.latlng.lng.toFixed(5)})`);pick=null;map.getContainer().classList.remove('pick-mode');clearPickButton();$('#map-hint').textContent='출발·도착 접점 사이의 경로를 안내합니다. 점선은 장소와 접점 사이의 거리 표시이며 통행 안내가 아닙니다.';calculate();
  }catch(err){status(err.message,true);pick=null;if(map)map.getContainer().classList.remove('pick-mode');clearPickButton();}});

 const counts=new Map();for(const p of data.places){let label=p.name+(p.address?' · '+p.address:'');if(counts.has(label)){label+=` (${p.p[1].toFixed(4)}, ${p.p[0].toFixed(4)})`;}counts.set(label,true);p.label=label;placeLabels.set(label,p);}$('#places').innerHTML=[...placeLabels.keys()].map(label=>`<option value="${esc(label)}"></option>`).join('');
  const start=data.places.find(p=>p.name==='천호역 2번 출구')||data.places[0],end=data.places.find(p=>p.name==='강동경찰서 천호지구대')||data.places.at(-1);setPoint('start',start.p,start.label);setPoint('end',end.p,end.label);
  const a=data.meta.audit;$('#map-count').textContent=`보행 링크 ${a.links.toLocaleString()}개`;
  $('#source-summary').innerHTML=`<p>범위: ${esc(data.meta.region)} · 공개 보행 링크 내려받은 날짜 ${esc(data.meta.retrieved)}</p><div class="source-wrap"><table class="source-table"><thead><tr><th>출처</th><th>적용 내용</th><th>기준 시점</th></tr></thead><tbody><tr><td><a href="${data.meta.sources.osm.page}" target="_blank" rel="noopener">OpenStreetMap 보행망</a></td><td>${a.nodes.toLocaleString()}개 노드 · ${a.links.toLocaleString()}개 링크</td><td>OSM 자료 ${esc(data.meta.retrieved)} 수집</td></tr><tr><td><a href="${data.meta.sources.lamps.page}" target="_blank" rel="noopener">강동구 보안등</a></td><td>관심 영역·경계 인근 ${a.lamps.toLocaleString()}개</td><td>2024-05-16</td></tr><tr><td><a href="${data.meta.sources.facilities.page}" target="_blank" rel="noopener">안심귀갓길 시설</a></td><td>CCTV ${a.cctv}개 · 안심벨 ${a.bells}개</td><td>2022년 현장조사</td></tr><tr><td><a href="${data.meta.sources.osm.page}" target="_blank" rel="noopener">OpenStreetMap 장소 데이터</a></td><td>장소 검색 ${data.places.length.toLocaleString()}개 · 배경지도</td><td>장소 목록 ${esc(data.meta.retrieved)} 수집</td></tr></tbody></table></div><p>경로는 내려받은 OSM 보행 링크 중 최대 연결 구간에서 계산합니다. 배경지도 타일은 별도로 제공되며 갱신 시점과 표시 방식이 달라, 보행로·단지 통로가 배경지도에 나타나지 않을 수 있습니다. 지도 선에 없는 길도 경로 데이터에 포함될 수 있으므로 현장 상황을 확인해 주세요. 좌표를 임의로 도로에 옮기지는 않습니다. 유동인구·실측 조도는 확보하지 못했습니다. 원본 보안등 좌표 중복 ${a.duplicate_lamp_coordinates||0}건·범위 오류 ${a.invalid_lamp_coordinates||0}건을 제외했고, 연결 성분 ${a.component_count}개 중 최대 성분만 사용했습니다.</p>`;
   $('#source-summary').insertAdjacentHTML('beforeend',`<p>보행 접근이 확인되지 않은 OSM trunk·trunk_link·busway 간선 기록 ${a.access_excluded_edges}개를 제외했습니다. 동일한 물리 도로의 역방향 중복 레코드 ${a.duplicate_reverse_edge_records}개는 하나로 처리하고, 서로 다른 형상의 평행 간선은 유지합니다. 최대 연결 성분 ${a.nodes.toLocaleString()}개 노드만 경로·스냅·지도 선에 사용합니다.</p>`);
   controls();try{worker=new Worker('./route-worker.mjs?v=bigroad-off',{type:'module'});worker.onmessage=e=>{const p=pending.get(e.data.id);if(!p)return;pending.delete(e.data.id);e.data.error?p.reject(Error(e.data.error)):p.resolve(e.data.result||e.data);};worker.onerror=()=>{for(const p of pending.values())p.reject(Error('경로 계산을 다시 시도해 주세요.'));pending.clear();worker?.terminate();worker=null;};await rpc('init',{data});}catch{worker?.terminate();worker=null;}
   void initializeSupabaseUI({getCurrentRoute:()=>last&&positions.start&&positions.end?{startName:favoriteName(positions.start),endName:favoriteName(positions.end),restorable:Boolean(favoriteLocation(favoriteName(positions.start))&&favoriteLocation(favoriteName(positions.end)))}:null,onLoadFavorite:async favorite=>{const start=favoriteLocation(favorite.start_name),end=favoriteLocation(favorite.end_name);if(!start||!end)throw Error('즐겨찾기 장소를 현재 보행망에서 찾을 수 없어요.');setPoint('start',start,favorite.start_name);setPoint('end',end,favorite.end_name);await calculate();},onPickReportLocation:pickReportLocation});
    $('#search').disabled=false;await calculate();if(last)fit();registerTool();
 }catch(e){console.error(e);status(e.message||'지도를 불러오지 못했어요. 새로고침해 주세요.',true);}}
  function clearPickButton(){document.querySelectorAll('#pick-start,#pick-end,#pick-report-location').forEach(button=>{button.style.background='';button.style.color='';button.style.borderColor='';button.style.boxShadow='';button.style.transform='';});}
  function pickReportLocation(){if(!map)return;clearPickButton();pick='report';const button=$('#pick-report-location');button.style.background='#b8ed87';button.style.color='#0b1720';button.style.borderColor='#b8ed87';button.style.boxShadow='0 0 0 3px rgba(184,237,135,.22)';map.getContainer().classList.add('pick-mode');$('#map-hint').textContent='지도에서 제보할 보행 환경 위치를 선택해 주세요.';status('제보 위치를 선택해 주세요.');$('#map').scrollIntoView({block:'center',behavior:'smooth'});}
  $('#search').onclick=calculate;$('#swap-points').onclick=()=>{if(!positions.start||!positions.end)return;clearRoute();[positions.start,positions.end]=[positions.end,positions.start];$('#start').value=positions.start.label;$('#end').value=positions.end.label;drawPins();updateSnapInfo();calculate();};for(const key of['start','end']){$('#'+key).onkeydown=e=>{if(e.key==='Enter')calculate();};$('#pick-'+key).onclick=()=>{if(!map)return;clearPickButton();pick=key;const button=$('#pick-'+key);button.style.background='#b8ed87';button.style.color='#0b1720';button.style.borderColor='#b8ed87';button.style.boxShadow='0 0 0 3px rgba(184,237,135,.22)';button.style.transform='translateY(-1px)';map.getContainer().classList.add('pick-mode');$('#map-hint').textContent=`지도에서 ${key==='start'?'출발':'도착'}할 보행로를 눌러 주세요.`;status('회색 보행로 가까이에서 위치를 선택해 주세요.');$('#map').scrollIntoView({block:'center',behavior:'smooth'});};}
 $('#locate').onclick=()=>engine&&locate();$('#fit').onclick=fit;if($('#follow'))$('#follow').onclick=follow;$('#extra').oninput=()=>{$('#extraValue').textContent=$('#extra').value+'분';schedule();};$('#speed').onchange=schedule;$('#show-lamps').onchange=e=>{if(map)e.target.checked?lampLayer.addTo(map):map.removeLayer(lampLayer);};$('#show-cctv').onchange=e=>{if(map)e.target.checked?cameraLayer.addTo(map):map.removeLayer(cameraLayer);};
$('#reset').onclick=()=>{weights=[...defaults];controls();$('#mode').textContent='기본 가중치 · 검증된 안전 계수가 아닙니다.';calculate();};$('#apply').onclick=()=>{try{const w=train(samples);weights=w.slice(1).map(v=>v/w[0]);controls();$('#mode').textContent=`실제 경로 선택 ${samples.length}개로 학습`;const ev=evaluate(samples);$('#learningStatus').textContent=ev?`분리 평가: 앞 ${ev.train}개로 학습, 뒤 ${ev.total}개 중 ${ev.correct}개 선택 예측 일치. 추천에는 전체 기록으로 학습한 모델 적용.`:'학습을 적용했어요. 서로 다른 출발·도착 10개부터 분리 평가를 표시합니다.';calculate();}catch(e){status(e.message,true);}};$('#clear').onclick=()=>{samples=[];$('#count').textContent='선택 0개';$('#apply').disabled=true;$('#learningStatus').textContent='선택 기록을 지웠어요.';$('#reset').click();};
$('#export').onclick=()=>{if(!last){status('먼저 경로를 계산해 주세요.',true);return;}download(JSON.stringify({schema:'nightpath-real-v2',meta:data.meta,graph:data,experiment:last,choices:samples,holdout:evaluate(samples)},null,2),'nightpath-real-experiment.json','application/json');};
 if($('#gpx'))$('#gpx').onclick=()=>{if(!last)return;const points=engine.geometry(shown[selected]);download(`<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="Nightpath" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>Nightpath walking route</name><trkseg>${points.map(p=>`<trkpt lat="${p[1]}" lon="${p[0]}"/>`).join('')}</trkseg></trk></gpx>`,'nightpath-route.gpx','application/gpx+xml');};
window.addEventListener('pagehide',()=>{stopFollow();worker?.terminate();});
function registerTool(){if(!document.modelContext?.registerTool)return;const lifecycle=new AbortController();try{Promise.resolve(document.modelContext.registerTool({name:'configure_route',description:'실제 보행망 노드와 추가시간으로 경로를 설정하고 계산합니다. 범위는 get_route_state의 노드 수로 확인합니다.',inputSchema:{type:'object',properties:{start:{type:'integer',minimum:0},end:{type:'integer',minimum:0},extra:{type:'integer',minimum:0,maximum:15}},required:['start','end','extra'],additionalProperties:false},annotations:{readOnlyHint:false},async execute(v){if(!v||!Number.isInteger(v.start)||!Number.isInteger(v.end)||!data.nodes[v.start]||!data.nodes[v.end]||v.start===v.end||!Number.isInteger(v.extra)||v.extra<0||v.extra>15)throw Error('서로 다른 유효 노드와 0~15분이 필요합니다.');setPoint('start',data.nodes[v.start].p,'선택한 출발 지점',v.start);setPoint('end',data.nodes[v.end].p,'선택한 도착 지점',v.end);$('#extra').value=v.extra;$('#extraValue').textContent=v.extra+'분';await calculate();if(!last)throw Error('경로 계산 실패');return{shortestMeters:last.shortest.distance,recommendedMeters:last.recommended.distance,candidates:last.candidates.length};}},{signal:lifecycle.signal})).catch(()=>{});Promise.resolve(document.modelContext.registerTool({name:'get_route_state',description:'현재 경로와 실제 데이터 범위를 읽습니다.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true},execute(){return{region:data.meta.region,nodeCount:data.nodes.length,edgeCount:data.edges.length,current:last?{start:last.start,end:last.end,shortestMeters:last.shortest.distance,recommendedMeters:last.recommended.distance}:null};}},{signal:lifecycle.signal})).catch(()=>{});}catch{}window.addEventListener('pagehide',()=>lifecycle.abort());}
initializeTheme();
initializeWorkspaceTabs();
initializeMobileControls();
init();
