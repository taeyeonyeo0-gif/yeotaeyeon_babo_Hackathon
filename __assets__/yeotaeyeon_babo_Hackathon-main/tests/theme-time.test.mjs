import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const context = {};
context.globalThis = context;
runInNewContext(readFileSync(new URL('../theme-bootstrap.js', import.meta.url), 'utf8'), context);
const { themeAtSeoulTime, resolveTheme } = context.nightpathTheme;

test('automatic mode uses Asia/Seoul and switches at 06:00 and 18:00', () => {
  assert.equal(themeAtSeoulTime(new Date('2026-01-01T20:59:00Z')), 'dark');
  assert.equal(themeAtSeoulTime(new Date('2026-01-01T21:00:00Z')), 'light');
  assert.equal(themeAtSeoulTime(new Date('2026-01-01T08:59:00Z')), 'light');
  assert.equal(themeAtSeoulTime(new Date('2026-01-01T09:00:00Z')), 'dark');
});

test('manual modes override the clock', () => {
  const midday = new Date('2026-01-01T03:00:00Z');
  assert.equal(resolveTheme('light', midday), 'light');
  assert.equal(resolveTheme('dark', midday), 'dark');
});
