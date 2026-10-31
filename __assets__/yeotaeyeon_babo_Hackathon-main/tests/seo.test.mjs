import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const base = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, base), 'utf8');
const canonical = 'https://rtuen5ol07vsiygm.jitda.io/';

test('SEO title, description, canonical and social metadata use the current app URL', () => {
  const html = read('index.html');
  assert.match(html, /<title>안심보행맵 \| 보행 안전 경로 탐색 지도<\/title>/);
  assert.match(html, /<meta name="description" content="안심보행맵은 공개된 보안등·CCTV·안심벨/);
  assert.ok(html.includes(`<link rel="canonical" href="${canonical}">`));
  assert.match(html, /<meta name="robots" content="index,follow/);
  assert.doesNotMatch(html, /<meta[^>]+name="robots"[^>]+noindex/i);
  assert.match(html, /<meta property="og:title" content="안심보행맵 \| 보행 안전 경로 탐색 지도">/);
  assert.match(html, /<meta property="og:image" content="https:\/\/rtuen5ol07vsiygm\.jitda\.io\/safety-location-light\.png">/);
  assert.match(html, /<h1 class="brand-name" data-brand-name>안심보행맵<\/h1>/);
  assert.match(html, /class="service-summary"/);
});

test('crawler files allow the public page and list only the current canonical page', () => {
  const robots = read('robots.txt');
  const sitemap = read('sitemap.xml');
  assert.match(robots, /User-agent: \*/);
  assert.match(robots, /Allow: \/$/m);
  assert.ok(robots.includes(`Sitemap: ${canonical}sitemap.xml`));
  assert.ok(sitemap.includes(`<loc>${canonical}</loc>`));
  assert.equal((sitemap.match(/<loc>/g) || []).length, 1);
});
