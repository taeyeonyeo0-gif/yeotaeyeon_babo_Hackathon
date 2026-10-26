import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  deleteFavorite,
  listFavorites,
  listReports,
  saveFavorite,
  submitReport,
  supabaseErrorDiagnostic,
  updateFavorite,
} from '../supabase-account.mjs';

class FakeQuery {
  constructor(client, table) {
    this.client = client;
    this.table = table;
    this.action = 'select';
    this.filters = [];
    this.singleResult = false;
  }

  select() { this.returning = true; return this; }
  insert(payload) { this.action = 'insert'; this.payload = payload; return this; }
  update(payload) { this.action = 'update'; this.payload = payload; return this; }
  delete() { this.action = 'delete'; return this; }
  eq(key, value) { this.filters.push(row => row[key] === value); return this; }
  neq(key, value) { this.filters.push(row => row[key] !== value); return this; }
  order(key, { ascending = true } = {}) { this.orderBy = { key, ascending }; return this; }
  limit(value) { this.limitTo = value; return this; }
  single() { this.singleResult = true; return this; }

  then(resolve, reject) {
    return Promise.resolve().then(() => this.execute()).then(resolve, reject);
  }

  execute() {
    const { db, userId } = this.client;
    if (db.failure) {
      const error = db.failure;
      db.failure = null;
      return { data: null, error };
    }
    if (!userId) return { data: null, error: { code: '42501', message: 'login required' } };
    const rows = db.tables[this.table];
    if (!rows) return { data: null, error: { code: '42P01', message: 'table not found' } };
    const visible = rows.filter(row => row.user_id === userId && this.filters.every(filter => filter(row)));

    if (this.action === 'select') {
      if (this.orderBy) {
        const { key, ascending } = this.orderBy;
        visible.sort((a, b) => (a[key] > b[key] ? 1 : a[key] < b[key] ? -1 : 0) * (ascending ? 1 : -1));
      }
      const data = visible.slice(0, this.limitTo ?? visible.length).map(row => ({ ...row }));
      return { data, error: null };
    }

    if (this.action === 'insert') {
      if (this.payload.user_id !== userId || (this.table === 'reports' && Object.hasOwn(this.payload, 'status'))) {
        return { data: null, error: { code: '42501', message: 'owner or report status cannot be supplied' } };
      }
      if (this.table === 'favorites' && rows.some(row => row.user_id === userId && row.start_name === this.payload.start_name && row.end_name === this.payload.end_name)) {
        return { data: null, error: { code: '23505', message: 'duplicate favorite' } };
      }
      const row = { ...this.payload, id: db.nextId++, user_id: userId, created_at: new Date(db.nextId * 1000).toISOString() };
      if (this.table === 'reports') row.status = 'pending';
      rows.push(row);
      return { data: this.singleResult ? { id: row.id } : [{ id: row.id }], error: null };
    }

    if (this.action === 'update') {
      if (this.table !== 'favorites' || Object.keys(this.payload).some(key => !['start_name', 'end_name'].includes(key))) {
        return { data: null, error: { code: '42501', message: 'update not allowed' } };
      }
      if (visible.some(row => rows.some(other => other.user_id === userId && other.id !== row.id && other.start_name === this.payload.start_name && other.end_name === this.payload.end_name))) {
        return { data: null, error: { code: '23505', message: 'duplicate favorite' } };
      }
      for (const row of visible) Object.assign(row, this.payload);
      return { data: this.returning ? visible.map(row => ({ id: row.id })) : null, error: null };
    }

    if (this.action === 'delete') {
      const ids = new Set(visible.map(row => row.id));
      db.tables[this.table] = rows.filter(row => !ids.has(row.id));
      return { data: this.returning ? visible.map(row => ({ id: row.id })) : null, error: null };
    }
    return { data: null, error: { code: '0A000', message: 'unsupported fake operation' } };
  }
}

function fakeDb() {
  const db = { tables: { favorites: [], reports: [] }, nextId: 1, failure: null };
  return { db, client: userId => ({ db, userId, auth: { getUser: async () => ({ data: { user: userId ? { id: userId } : null }, error: null }) }, from: table => new FakeQuery({ db, userId }, table) }) };
}

const route = (startName, endName) => ({ startName, endName, restorable: true });
const validReport = { reportType: 'sidewalk', latitude: '37.54', longitude: '127.12', description: '보행로 파손을 확인했습니다.' };

test('favorites save once, list per owner, update current route and delete', async () => {
  const { db, client } = fakeDb();
  const alice = client('alice');
  const bob = client('bob');
  const saved = await saveFavorite(alice, 'alice', route('천호역', '천호공원'));
  assert.equal(saved.status, 'saved');
  assert.equal(typeof saved.id, 'number');
  assert.equal((await saveFavorite(alice, 'alice', route('천호역', '천호공원'))).status, 'duplicate');
  assert.equal(db.tables.favorites.length, 1);
  assert.equal((await listFavorites(alice, 'alice')).length, 1);
  assert.equal((await listFavorites(bob, 'bob')).length, 0);

  await saveFavorite(alice, 'alice', route('천호역', '강동역'));
  assert.equal((await updateFavorite(alice, 'alice', saved.id, route('천호역', '강동역'))).status, 'duplicate');
  assert.equal((await updateFavorite(alice, 'alice', saved.id, route('암사역', '천호공원'))).status, 'updated');
  assert.deepEqual((await listFavorites(alice, 'alice')).map(row => row.start_name), ['천호역', '암사역']);
  assert.equal((await deleteFavorite(bob, 'bob', saved.id)).status, 'not-found');
  assert.equal((await deleteFavorite(alice, 'alice', saved.id)).status, 'deleted');
});

test('report validation, owner scoping and status defaults are enforced by the client flow', async () => {
  const { db, client } = fakeDb();
  const alice = client('alice');
  const bob = client('bob');
  const created = await submitReport(alice, 'alice', { ...validReport, user_id: 'bob', status: 'resolved' });
  assert.ok(created.id);
  const reports = await listReports(alice, 'alice');
  assert.equal(reports.length, 1);
  assert.equal(reports[0].user_id, 'alice');
  assert.equal(reports[0].status, 'pending');
  assert.equal((await listReports(bob, 'bob')).length, 0);
  assert.deepEqual(Object.keys(db.tables.reports[0]).sort(), ['created_at', 'description', 'id', 'latitude', 'longitude', 'report_type', 'status', 'user_id']);
  await assert.rejects(submitReport(alice, 'alice', { ...validReport, latitude: '' }), /위도/);
  await assert.rejects(submitReport(alice, 'alice', { ...validReport, reportType: 'made-up' }), /유형/);
});

test('failed writes propagate errors rather than reporting success', async () => {
  const { db, client } = fakeDb();
  const alice = client('alice');
  db.failure = { code: 'NETWORK', message: 'offline' };
  await assert.rejects(saveFavorite(alice, 'alice', route('천호역', '천호공원')), error => error?.code === 'NETWORK');
  db.failure = { code: 'NETWORK', message: 'offline' };
  await assert.rejects(submitReport(alice, 'alice', validReport), error => error?.code === 'NETWORK');
  assert.equal(db.tables.favorites.length, 0);
  assert.equal(db.tables.reports.length, 0);
});

test('account data operations reject calls without a user id', async () => {
  const { client } = fakeDb();
  await assert.rejects(listFavorites(client(null), null), /로그인/);
  await assert.rejects(deleteFavorite(client(null), null, 'favorite-1'), /로그인/);
  await assert.rejects(submitReport(client(null), null, validReport), /로그인/);
  await assert.rejects(saveFavorite(client('bob'), 'alice', route('천호역', '공원')), /세션과 계정/);
});

test('local SQL keeps favorites owner-scoped and reports status read-only', () => {
  const schema = readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8');
  assert.match(schema, /create table if not exists public\.favorites/);
  assert.match(schema, /grant update \(start_name, end_name\) on table public\.favorites to authenticated/);
  assert.match(schema, /create policy favorites_update_own on public\.favorites[\s\S]*?using \(auth\.uid\(\) = user_id\)[\s\S]*?with check \(auth\.uid\(\) = user_id\)/);
  assert.match(schema, /with check \(auth\.uid\(\) = user_id and status = 'pending'\)/);
  assert.doesNotMatch(schema, /create policy reports_update/i);
  assert.doesNotMatch(schema, /drop table/i);
});

test('local Storage SQL defines a private owner-folder avatars bucket', () => {
  const sql = readFileSync(new URL('../supabase/avatar-storage.sql', import.meta.url), 'utf8');
  assert.match(sql, /'avatars',[\s\S]*?false,[\s\S]*?5242880/);
  assert.match(sql, /storage\.foldername\(name\)\)\[1\] = \(select auth\.uid\(\)\)::text/);
  assert.match(sql, /as restrictive for select to anon, authenticated/);
  assert.match(sql, /as restrictive for delete to anon, authenticated/);
  assert.doesNotMatch(sql, /public\s*=\s*true/i);
});

test('Supabase diagnostics retain error fields but redact tokens and identifiers', () => {
  const diagnostic = supabaseErrorDiagnostic({
    code: '42501',
    message: 'row-level security denied 11111111-2222-4333-8444-555555555555 user@example.com',
    details: 'Bearer eyJexample.token.secret at 37.12345, 127.12345',
    hint: 'check policy',
  });
  assert.match(diagnostic, /code: 42501/);
  assert.match(diagnostic, /message: row-level security denied/);
  assert.match(diagnostic, /details: Bearer \[가림\].*\[좌표\]/);
  assert.match(diagnostic, /hint: check policy/);
  assert.doesNotMatch(diagnostic, /user@example\.com|11111111-2222|eyJexample|37\.12345/);
});
