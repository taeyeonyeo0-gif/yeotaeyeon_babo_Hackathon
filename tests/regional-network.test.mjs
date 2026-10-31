import assert from 'node:assert/strict';
import test from 'node:test';
import { makeEngine } from '../engine.mjs';
import { boundsAround, buildRegionalGraph, parseOSMXml } from '../regional-network.mjs';

const place = {
  geometry: { coordinates: [127.01, 37.01] },
  properties: { name: '테스트 지역', countrycode: 'KR' },
};
const bbox = [127, 37, 127.02, 37.02];
const xml = `<?xml version="1.0"?><osm version="0.6">
  <node id="1" lat="37.01" lon="127.001" />
  <node id="2" lat="37.01" lon="127.01" />
  <node id="3" lat="37.01" lon="127.019" />
  <node id="4" lat="37.015" lon="127.01" />
  <way id="10"><nd ref="1"/><nd ref="2"/><nd ref="3"/><tag k="highway" v="footway"/></way>
  <way id="11"><nd ref="2"/><nd ref="4"/><tag k="highway" v="residential"/><tag k="foot" v="no"/></way>
  <way id="12"><nd ref="1"/><nd ref="4"/><tag k="building" v="yes"/></way>
</osm>`;

test('regional OSM XML becomes a clipped walking graph and keeps access restrictions out', () => {
  const parsed = parseOSMXml(xml);
  assert.equal(parsed.nodes.size, 4);
  assert.equal(parsed.ways.length, 3);
  const graph = buildRegionalGraph(xml, { query: '테스트 지역', place, bbox });
  assert.equal(graph.edges.length, 2);
  assert.equal(graph.nodes.length, 3);
  assert.ok(graph.edges.every(edge => edge.sourceId.startsWith('10:')));
  assert.ok(graph.edges.every(edge => edge.geometry.flat().every(Number.isFinite)));
  assert.ok(graph.edges.every(edge => edge.distance > 0));

  const engine = makeEngine(graph);
  const start = engine.nearest([127.001, 37.01]);
  const end = engine.nearest([127.019, 37.01]);
  const route = engine.recommendFromSnaps(start, end);
  assert.ok(route.shortest.distance > 1500 && route.shortest.distance < 1700);
  assert.deepEqual(route.shortest.geometry[0], start.p);
  assert.deepEqual(route.shortest.geometry.at(-1), end.p);
});

test('regional segments crossing the search box are clipped to its bounds', () => {
  const crossingXml = `<osm><node id="1" lat="37.01" lon="126.99"/><node id="2" lat="37.01" lon="127.01"/><way id="20"><nd ref="1"/><nd ref="2"/><tag k="highway" v="residential"/></way></osm>`;
  const graph = buildRegionalGraph(crossingXml, { query: '테스트 지역', place, bbox });
  assert.equal(graph.edges.length, 1);
  assert.deepEqual(graph.edges[0].geometry[0], [127, 37.01]);
  assert.deepEqual(graph.edges[0].geometry[1], [127.01, 37.01]);
});

test('regional bbox is centered and sized in meters for Korean latitudes', () => {
  const [west, south, east, north] = boundsAround(128.6, 35.8, 1500);
  assert.ok(Math.abs((east + west) / 2 - 128.6) < 1e-6);
  assert.ok(Math.abs((north + south) / 2 - 35.8) < 1e-6);
  assert.ok(east - west > north - south);
});
