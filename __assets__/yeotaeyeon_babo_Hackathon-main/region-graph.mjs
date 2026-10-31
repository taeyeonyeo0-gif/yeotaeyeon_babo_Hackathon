// 검색 지역 주변의 OSM 보행 가능 도로를 기존 엔진 형식으로 변환합니다.
// 안전시설 데이터는 제공되지 않으므로 다른 지역의 안전 점수는 검증되지 않습니다.
export async function fetchRegionGraph(query) {
  const geoUrl=new URL('https://nominatim.openstreetmap.org/search');
  geoUrl.search=new URLSearchParams({q:query,format:'json',limit:'1',countrycodes:'kr'}).toString();
  const geoResponse=await fetch(geoUrl,{headers:{Accept:'application/json'}});
  if(!geoResponse.ok)throw Error('지역 검색 서버에 연결할 수 없습니다.');
  const found=await geoResponse.json();
  if(!found.length)throw Error('검색한 국내 지역을 찾을 수 없습니다.');
  const lat=Number(found[0].lat),lon=Number(found[0].lon);
  const radius=1100,deltaLat=radius/111195,deltaLon=radius/(111195*Math.cos(lat*Math.PI/180));
  const bbox=[lat-deltaLat,lon-deltaLon,lat+deltaLat,lon+deltaLon];
  const q=`[out:json][timeout:35];(way["highway"~"^(footway|pedestrian|path|steps|living_street|residential|service|tertiary|secondary|primary|unclassified|track|cycleway)$"]["access"!~"^(private|no)$"]["foot"!~"^(private|no)$"](${bbox.join(',')}););out geom;`;
  const response=await fetch('https://overpass.kumi.systems/api/interpreter',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({data:q})});
  if(!response.ok)throw Error('보행망 서버가 응답하지 않습니다. 잠시 후 다시 검색해 주세요.');
  const osm=await response.json(),nodes=[],edges=[],ids=new Map();
  const node=(point)=>{const key=`${point.lon.toFixed(7)},${point.lat.toFixed(7)}`;if(!ids.has(key)){ids.set(key,nodes.length);nodes.push({id:nodes.length,sourceId:key,p:[point.lon,point.lat]});}return ids.get(key);};
  const distance=(a,b)=>{const dy=(a.lat-b.lat)*111195,dx=(a.lon-b.lon)*111195*Math.cos((a.lat+b.lat)*Math.PI/360);return Math.hypot(dx,dy);};
  for(const way of osm.elements||[]){
    if(!Array.isArray(way.geometry))continue;
    for(let i=1;i<way.geometry.length;i++){
      const a=way.geometry[i-1],b=way.geometry[i],meters=distance(a,b);
      if(meters<0.05)continue;
      const ai=node(a),bi=node(b),id=edges.length;
      edges.push({id,sourceId:`${way.id}_${i}`,a:ai,b:bi,geometry:[[a.lon,a.lat],[b.lon,b.lat]],distance:meters,quality:[0,0,0],code:way.tags?.highway||'',crossing:way.tags?.highway==='steps',area:query});
    }
  }
  if(edges.length<2)throw Error('검색 지역의 보행로를 찾지 못했습니다.');
  return {center:[lat,lon],data:{meta:{region:found[0].display_name,retrieved:new Date().toISOString().slice(0,10),bbox:[bbox[1],bbox[0],bbox[3],bbox[2]],boundary:[],radiiMeters:{lamp:30,cctv:50},audit:{nodes:nodes.length,links:edges.length,lamps:0,cctv:0,bells:0},sources:{osm:{page:'https://www.openstreetmap.org'},lamps:{page:'https://www.openstreetmap.org'},facilities:{page:'https://www.openstreetmap.org'}}},nodes,edges,facilities:[],places:[]}};
}
