import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { appendSupplementalCctv } from '../facility-data.mjs';
import { features, makeEngine, meters, names, train } from '../engine.mjs';

const project = ([x, y]) => [127.13 + x / (111195 * Math.cos(37.54 * Math.PI / 180)), 37.54 + y / 111195];

function graph(localNodes, links, facilities = []) {
  const nodes = localNodes.map((point, id) => ({ id, p: project(point) }));
  const edges = links.map(({ a, b, quality }, id) => {
    const geometry = [nodes[a].p, nodes[b].p];
    return {
      id,
      sourceId: `audit-${id}`,
      a,
      b,
      geometry,
      distance: meters(...geometry),
      quality: quality.length === 3 ? [...quality] : [...quality, 0],
      crossing: false,
    };
  });
  return { nodes, edges, facilities, meta: { radiiMeters: { lamp: 30, cctv: 50 } } };
}

function snapOnEdge(data, edgeId, t) {
  const edge = data.edges[edgeId];
  const [a, b] = edge.geometry;
  const p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const offsetAlong = edge.distance * t;
  return {
    edgeId,
    nodes: [edge.a, edge.b],
    segment: 0,
    t,
    p,
    offsetAlong,
    node: offsetAlong <= edge.distance / 2 ? edge.a : edge.b,
  };
}

test('learned route coefficients match the three route features and two engine weights', () => {
  const routes = [
    { distance: 1000, quality: [0.2, 0.1] },
    { distance: 1300, quality: [0.7, 0.2] },
    { distance: 900, quality: [0.1, 0.8] },
    { distance: 1500, quality: [0.9, 0.6] },
    { distance: 1100, quality: [0.4, 0.9] },
  ];
  assert.equal(features(routes[0]).length, names.length + 1);
  const samples = routes.slice(1).map((route, i) => ({
    x: features(route).map((value, j) => value - features(routes[0])[j]),
    y: i % 2,
  }));
  const coefficients = train(samples);
  assert.equal(coefficients.length, names.length + 1);
  assert.ok(coefficients.every(Number.isFinite));
  const weights = coefficients.slice(1).map(value => value / coefficients[0]);
  assert.equal(weights.length, names.length);
  assert.ok(weights.every(Number.isFinite));
  assert.doesNotThrow(() => makeEngine(graph([[0, 0], [20, 0]], [{ a: 0, b: 1, quality: [0.5, 0.5] }])).recommend(0, 1, weights));
});

test('recommended snap route stays within extra time from the global shortest route', () => {
  const data = graph(
    [[0, 0], [1000, 0], [1100, 0], [2100, 0], [0, 100], [2100, 100]],
    [
      { a: 0, b: 1, quality: [1, 1] },
      { a: 2, b: 3, quality: [1, 1] },
      { a: 1, b: 2, quality: [0, 0] },
      { a: 0, b: 4, quality: [1, 1] },
      { a: 4, b: 5, quality: [1, 1] },
      { a: 5, b: 3, quality: [1, 1] },
    ],
  );
  const result = makeEngine(data).recommendFromSnaps(
    snapOnEdge(data, 0, 0.99),
    snapOnEdge(data, 1, 0.01),
    [40, 40],
    15,
    80,
  );
  const cap = result.shortest.distance + result.extra * result.speed;
  assert.ok(result.recommended.distance <= cap + 1e-6, `${result.recommended.distance} exceeds ${cap}`);
  assert.ok(result.candidates.every(route => route.distance <= cap + 1e-6));
  assert.equal(new Set(result.candidates.map(route => `${route.edgeIds.join(',')}/${route.startNode}/${route.endNode}`)).size, result.candidates.length);
});

test('safety percentages include both snap-to-node access segments in displayed geometry', () => {
  const data = graph(
    [[0, 0], [100, 0], [200, 0], [300, 0]],
    [
      { a: 0, b: 1, quality: [0, 0] },
      { a: 2, b: 3, quality: [1, 1] },
      { a: 1, b: 2, quality: [1, 0] },
    ],
  );
  const startSnap = snapOnEdge(data, 0, 0.9);
  const endSnap = snapOnEdge(data, 1, 0.1);
  const route = makeEngine(data).recommendFromSnaps(
    startSnap,
    endSnap,
    [0, 0],
    0,
    80,
  ).shortest;
  const total = route.distance;
  const coreDistance = total - route.accessStart - route.accessEnd;
  const expectedLamp = (coreDistance + route.accessEnd) / total;
  const expectedCctv = route.accessEnd / total;
  assert.ok(route.accessStart > 0 && route.accessEnd > 0);
  assert.deepEqual(route.geometry[0], startSnap.p);
  assert.deepEqual(route.geometry.at(-1), endSnap.p);
  assert.ok(Math.abs(route.quality[0] - expectedLamp) < 1e-9);
  assert.ok(Math.abs(route.quality[1] - expectedCctv) < 1e-9);
});

test('facility coverage percentages measure the complete snapped geometry', () => {
  const data = graph(
    [[0, 0], [100, 0], [200, 0], [300, 0]],
    [
      { a: 0, b: 1, quality: [0, 0] },
      { a: 2, b: 3, quality: [0, 0] },
      { a: 1, b: 2, quality: [0, 0] },
    ],
    [
      { id: 'lamp-center', type: 'lamp', p: project([150, 0]) },
      { id: 'camera-center', type: 'cctv', p: project([150, 0]) },
    ],
  );
  const route = makeEngine(data).recommendFromSnaps(
    snapOnEdge(data, 0, 0.9),
    snapOnEdge(data, 1, 0.1),
    [0, 0],
    0,
    80,
  ).shortest;

  assert.ok(Math.abs(route.distance - 120) < 1e-6);
  assert.ok(Math.abs(route.quality[0] - 0.5) < 1e-6, `lamp=${route.quality[0]}`);
  assert.ok(Math.abs(route.quality[1] - 20 / 24) < 1e-6, `cctv=${route.quality[1]}`);
});

test('supplemental CCTV CSV changes route coverage and the selected recommendation', () => {
  const csv = readFileSync(new URL('../data/cheonho-cctv.csv', import.meta.url), 'utf8');
  const first = csv.replace(/^\uFEFF/, '').trim().split(/\r?\n/)[1].split(',');
  const origin = [Number(first[2]), Number(first[1])];
  const local = (x, y) => [origin[0] + x / (111195 * Math.cos(origin[1] * Math.PI / 180)), origin[1] + y / 111195];
  const nodes = [local(-500, -51), local(500, -51), local(-500, -49), local(500, -49)];
  const edges = [
    { a: 0, b: 1, quality: [0, 0] },
    { a: 0, b: 2, quality: [0, 0] },
    { a: 2, b: 3, quality: [0, 0] },
    { a: 3, b: 1, quality: [0, 0] },
  ];
  const data = graph([[0, 0], [1, 0]], []);
  data.nodes = nodes.map((p, id) => ({ id, p }));
  data.edges = edges.map(({ a, b, quality }, id) => {
    const geometry = [nodes[a], nodes[b]];
    return { id, sourceId: `csv-audit-${id}`, a, b, geometry, distance: meters(...geometry), quality: [...quality, 0], crossing: false };
  });
  const before = makeEngine(data).recommend(0, 1, [0, 40], 3, 80);
  assert.deepEqual(before.recommended.edgeIds, [0]);
  const added = appendSupplementalCctv(data, csv);
  assert.ok(added > 0);
  const after = makeEngine(data).recommend(0, 1, [0, 40], 3, 80);
  assert.deepEqual(after.recommended.edgeIds, [1, 2, 3]);
  assert.ok(after.recommended.quality[1] > before.recommended.quality[1]);
});
