export function boundsAround(lon, lat, radiusMeters = 1500) {
  const latDelta = radiusMeters / 111195;
  const lonDelta = radiusMeters / (111195 * Math.cos(lat * Math.PI / 180));
  return [lon - lonDelta, lat - latDelta, lon + lonDelta, lat + latDelta]
    .map(value => Number(value.toFixed(6)));
}

export async function searchRegion(query, signal) {
  const trimmed = String(query || '').trim();
  if (!trimmed) throw new Error('지역명을 입력해 주세요.');
  const url = new URL('https://photon.komoot.io/api/');
  url.searchParams.set('q', trimmed);
  url.searchParams.set('limit', '8');
  url.searchParams.set('lang', 'default');
  const response = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`지역 검색 서비스에 연결하지 못했습니다 (${response.status}).`);
  const result = await response.json();
  const place = result.features?.find(feature => {
    const [placeLon, placeLat] = feature.geometry?.coordinates || [];
    const country = feature.properties?.countrycode?.toUpperCase();
    return (country === 'KR' || feature.properties?.country === '대한민국')
      && Number.isFinite(placeLon) && Number.isFinite(placeLat)
      && placeLon >= 124 && placeLon <= 132 && placeLat >= 32 && placeLat <= 39;
  });
  if (!place) throw new Error('대한민국에서 검색 결과를 찾지 못했습니다. 지역명을 더 구체적으로 입력해 주세요.');
  return place;
}

export async function loadRegionalGraph(query, place, signal) {
  const [lon, lat] = place.geometry.coordinates;
  const bbox = boundsAround(lon, lat);
  const url = new URL('./api/region-network', globalThis.location?.href || 'http://localhost/');
  url.searchParams.set('bbox', bbox.join(','));
  url.searchParams.set('region', String(query).slice(0, 100));
  const response = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  if (!response.ok) {
    let message = `지역 보행망을 불러오지 못했습니다 (${response.status}).`;
    try { message = (await response.json()).error || message; } catch {}
    throw new Error(message);
  }
  const graph = await response.json();
  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges) || !graph.edges.length) {
    throw new Error('검색한 지역에 경로 계산용 보행망이 없습니다. 다른 지역명을 검색해 주세요.');
  }
  graph.regional = { query, place: place.properties };
  graph.meta.region = `${query} 주변`;
  graph.meta.scope = '검색 위치 주변 OpenStreetMap 보행 네트워크';
  graph.meta.facilityCoverageAvailable = false;
  return graph;
}
