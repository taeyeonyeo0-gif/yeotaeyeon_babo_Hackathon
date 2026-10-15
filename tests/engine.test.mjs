import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { makeEngine, meters } from '../engine.mjs';

const data = JSON.parse(readFileSync(new URL('../data.json', import.meta.url), 'utf8'));
const exclusions = JSON.parse(readFileSync(new URL('../data/graph-exclusions.json', import.meta.url), 'utf8'));
const excludedSourceIds = new Set(exclusions.ways.flatMap(way => way.sourceIds));
for (const edge of data.edges) edge.graphExcluded = excludedSourceIds.has(edge.sourceId);
const engine = makeEngine(data);

test('nearest chooses the nearer endpoint over the complete multi-segment edge', () => {
  const edge = data.edges.find(value => value.sourceId === '414683226_2280430218_0');
  assert.ok(edge.geometry.length > 2);

  const samples = [
    [0, 0.9, edge.a],
    [edge.geometry.length - 2, 0.1, edge.b],
  ];
  for (const [segment, t, expectedNode] of samples) {
    const a = edge.geometry[segment];
    const b = edge.geometry[segment + 1];
    const point = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    const snap = engine.nearest(point);

    assert.equal(snap.edgeId, edge.id);
    assert.ok(snap.distance < 1e-6);
    assert.equal(snap.node, expectedNode);
    assert.equal(snap.node, snap.offsetAlong <= edge.distance / 2 ? edge.a : edge.b);
  }
});

test('A-to-B and B-to-A routes follow the same active graph in reverse', () => {
  const start = data.places.find(place => place.name === '천호역 2번 출구');
  const end = data.places.find(place => place.name === '강동경찰서 천호지구대');
  const startSnap = engine.nearest(start.p);
  const endSnap = engine.nearest(end.p);
  const ab = engine.recommendFromPoints(startSnap.p, endSnap.p);
  const ba = engine.recommendFromPoints(endSnap.p, startSnap.p);

  assert.deepEqual(ab.shortest.edgeIds, ba.shortest.edgeIds.slice().reverse());
  assert.equal(Math.abs(ab.shortest.distance - ba.shortest.distance) < 1e-6, true);
  for (const [route, from, to] of [[ab.shortest, startSnap.p, endSnap.p], [ba.shortest, endSnap.p, startSnap.p]]) {
    assert.ok(meters(route.geometry[0], from) < 1e-7);
    assert.ok(meters(route.geometry.at(-1), to) < 1e-7);
    assert.equal(route.edgeIds.some(id => data.edges[id].graphExcluded), false);
    for (let i = 0; i < route.edgeIds.length; i++) {
      const edge = data.edges[route.edgeIds[i]];
      const fromNode = route.nodes[i];
      const toNode = route.nodes[i + 1];
      assert.ok((edge.a === fromNode && edge.b === toNode) || (edge.a === toNode && edge.b === fromNode));
    }
  }
});

test('a trunk-link pair excluded from the walk graph is not routable', () => {
  assert.throws(() => engine.route(1380, 1383), /연결된 보행 지점/);
  assert.throws(() => engine.route(1383, 1380), /연결된 보행 지점/);
});
