const ready = new Promise((resolve) => kakao.maps.load(resolve));
globalThis.kakaoReady = ready;
await ready;

// Leaflet-compatible callers pass [lat, lon]. Normalize accidental GeoJSON [lon, lat]
// input at this single boundary so every Kakao overlay shares one coordinate rule.
const ll = ([first, second]) => {
  const lat = Math.abs(first) > 90 && Math.abs(second) <= 90 ? second : first;
  const lon = Math.abs(first) > 90 && Math.abs(second) <= 90 ? first : second;
  return new kakao.maps.LatLng(lat, lon);
};
const pathOf = (points) => points.map(ll);
const apply = (object, map) => { object.setMap(map?.__kakao || map || null); return object; };

class LayerGroup {
  constructor(items = []) { this.items = items; }
  addTo(map) { this.map = map; this.items.forEach((item) => item.setMap(map.__kakao)); return this; }
  addLayer(item) { this.items.push(item); if (this.map) item.setMap(this.map.__kakao); return this; }
  clearLayers() { this.items.forEach((item) => item.setMap(null)); this.items = []; return this; }
  bringToFront() { return this; }
}

function popup(object, html) {
  object.bindPopup = () => { object.__popup = html; kakao.maps.event.addListener(object.__kakao, 'click', () => { const info = new kakao.maps.InfoWindow({ content: `<div style="padding:10px;font-size:12px">${html}</div>` }); info.open(object.__map, object.__kakao); }); return object; };
  return object;
}

const L = {
  map(id) { const instance = new kakao.maps.Map(document.getElementById(id), { center: ll([37.542, 127.128]), level: 5 }); const wrapper = { __kakao: instance, setView(coords, level) { instance.setCenter(ll(coords)); instance.setLevel(level); return wrapper; }, fitBounds(bounds) { instance.setBounds(bounds.__kakao); return wrapper; }, on(event, callback) { if (event === 'click') kakao.maps.event.addListener(instance, 'click', (e) => callback({ latlng: { lat: () => e.latLng.getLat(), lng: () => e.latLng.getLng() } })); return wrapper; }, addLayer(layer) { layer.addTo(wrapper); return wrapper; }, removeLayer(layer) { layer.items?.forEach((item) => item.setMap(null)); return wrapper; }, hasLayer(layer) { return Boolean(layer?.map); } }; return wrapper; },
  tileLayer() { return { addTo(map) { return map; }, on() { return this; } }; },
  layerGroup(items) { return new LayerGroup(items); },
  polyline(coords, options = {}) { const object = new kakao.maps.Polyline({ path: pathOf(coords), strokeWeight: options.weight || 3, strokeColor: options.color || '#567', strokeOpacity: options.opacity ?? 1, strokeStyle: options.dashArray ? 'dash' : 'solid' }); object.__kakao = object; object.addTo = (group) => { group.addLayer(object); return object; }; object.setLatLngs = (next) => { object.setPath(pathOf(next)); return object; }; return object; },
  polygon(coords, options = {}) { const object = new kakao.maps.Polygon({ path: pathOf(coords), strokeWeight: options.weight || 2, strokeColor: options.color || '#567', strokeOpacity: options.opacity ?? 1, fillOpacity: options.fill ? .05 : 0 }); object.__kakao = object; object.addTo = (map) => { object.setMap(map.__kakao || map); return object; }; return object; },
  rectangle(coords, options = {}) { return L.polygon(coords, options); },
  circleMarker(coords, options = {}) { const color = options.fillColor || options.color || '#567'; const size = Math.max(6, (options.radius || 5) * 2); const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${Math.max(2, size / 2 - 1)}" fill="${color}" fill-opacity="${options.fillOpacity ?? .75}"/></svg>`; const object = new kakao.maps.Marker({ position: ll(coords), image: new kakao.maps.MarkerImage(`data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`, new kakao.maps.Size(size, size), { offset: new kakao.maps.Point(size / 2, size / 2) }) }); object.__kakao = object; object.addTo = (map) => { if (map.addLayer) return map.addLayer(object); object.setMap(map.__kakao || map); object.__map = map.__kakao || map; return object; }; object.setLatLng = (next) => { object.setPosition(ll(next)); return object; }; return popup(object, '시설 정보'); },
  circle(coords, options = {}) { return L.circleMarker(coords, { ...options, radius: Math.max(2, (options.radius || 10) / 2) }); },
  marker(coords, options = {}) { const html = options.icon?.options?.html || '•'; const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30"><circle cx="15" cy="15" r="13" fill="#ef4444" stroke="#fff" stroke-width="2"/><text x="15" y="20" text-anchor="middle" font-size="14" fill="#fff">${html}</text></svg>`; const object = new kakao.maps.Marker({ position: ll(coords), image: new kakao.maps.MarkerImage(`data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`, new kakao.maps.Size(30, 30), { offset: new kakao.maps.Point(15, 15) }) }); object.__kakao = object; object.addTo = (group) => { group.addLayer(object); return object; }; object.setLatLng = (next) => { object.setPosition(ll(next)); return object; }; return popup(object, '보행망 접점'); },
  divIcon(options) { return { options }; },
  latLngBounds(coords) { const bounds = new kakao.maps.LatLngBounds(); coords.forEach((coord) => bounds.extend(ll(coord))); return { __kakao: bounds }; },
  control: { scale() { return { addTo() {} }; } }
};

globalThis.L = L;
