import assert from 'node:assert/strict';
import test from 'node:test';
import { makeEngine, meters } from '../engine.mjs';
import { boundsAround, loadRegionalGraph, searchRegion } from '../regional-network.mjs';

test('region bounds cover a centered local search area at Korean latitudes', () => {
  const [west, south, east, north] = boundsAround(128.6, 35.8, 1500);
  assert.ok(Math.abs((east + west) / 2 - 128.6) < 1e-6);
  assert.ok(Math.abs((north + south) / 2 - 35.8) < 1e-6);
  assert.ok(east - west > north - south);
  assert.ok(east - west < 0.04 && north - south < 0.04);
});

test('region search rejects non-Korean results and returns Korean places', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    features: [
      { geometry: { coordinates: [139.7, 35.6] }, properties: { countrycode: 'JP' } },
      { geometry: { coordinates: [128.6, 35.8] }, properties: { countrycode: 'KR', name: '서면' } },
    ],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  try {
    const place = await searchRegion('부산 서면');
    assert.equal(place.properties.name, '서면');
    assert.deepEqual(place.geometry.coordinates, [128.6, 35.8]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('regional graph endpoint returns a routable graph and records the active area', async () => {
  const originalFetch = globalThis.fetch;
  const bbox = boundsAround(127.13, 37.54);
  const graph = {
    meta: { region: '지역', bbox, boundary: [], retrieved: '2026-10-31', audit: {}, radiiMeters: { lamp: 30, cctv: 50 } },
    nodes: [
      { id: 0, p: [127.13, 37.54] },
      { id: 1, p: [127.131, 37.54] },
    ],
    edges: [{
      id: 0, sourceId: 'way-1', a: 0, b: 1,
      geometry: [[127.13, 37.54], [127.131, 37.54]],
      distance: meters([127.13, 37.54], [127.131, 37.54]),
      quality: [0, 0, 0], crossing: false, area: '보행로',
    }],
    facilities: [], places: [],
  };
  globalThis.fetch = async url => {
    const parsed = new URL(url);
    assert.equal(parsed.pathname, '/api/region-network');
    assert.equal(parsed.searchParams.get('region'), '시험 지역');
    return new Response(JSON.stringify(graph), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const place = { geometry: { coordinates: [127.13, 37.54] }, properties: { name: '시험 지역' } };
    const loaded = await loadRegionalGraph('시험 지역', place);
    const engine = makeEngine(loaded);
    const edge = engine.activeEdges[0];
    const result = engine.recommendFromSnaps(engine.nearest(edge.geometry[0]), engine.nearest(edge.geometry[1]));
    assert.equal(loaded.regional.query, '시험 지역');
    assert.match(loaded.meta.region, /시험 지역/);
    assert.equal(loaded.meta.facilityCoverageAvailable, false);
    assert.ok(result.shortest.distance > 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
