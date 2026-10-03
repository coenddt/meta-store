'use strict';

/**
 * A5 触发链：控制面 publish 后按 META_RELOAD_HOOK 触发协议重装配。
 * - 未配置 hook：publish 仍成功（以告警留痕，不静默）；
 * - 配置 hook：publish 触发一次 POST；hook 非 2xx → publish 500 ERR_RELOAD_FAILED（不吞）。
 *
 * 需本地 Mongo（默认 mongodb://127.0.0.1:27017；可用 MONGO_URI 覆盖），不可达则跳过。
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { MongoClient } = require('mongodb');
const { init, store } = require('nodejs-store');
const { createServer } = require('../src/index');

const URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017';
const DB = 'meta_store_hotreload';

async function canConnect() {
  const c = new MongoClient(URI, { serverSelectionTimeoutMS: 1500 });
  try {
    await c.connect();
    await c.db(DB).command({ ping: 1 });
    return true;
  } catch {
    return false;
  } finally {
    await c.close().catch(() => {});
  }
}

function listen(server) {
  return new Promise((r) => server.listen(0, '127.0.0.1', r));
}
function close(server) {
  return new Promise((r) => server.close(r));
}
async function post(base, path, payload) {
  const r = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: r.status, json: await r.json() };
}

test('A5 触发链：publish 按 META_RELOAD_HOOK 触发重装配', async (t) => {
  if (!(await canConnect())) {
    t.skip('本地 Mongo 不可达，跳过热注册触发链测试');
    return;
  }

  const client = new MongoClient(URI);
  await client.connect();
  const db = client.db(DB);
  await db.dropDatabase();
  await init(db);
  store.ensureBuiltins();

  let hits = 0;
  let failNext = false;
  const hook = http.createServer((req, res) => {
    hits += 1;
    res.writeHead(failNext ? 503 : 200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await listen(hook);
  const hookUrl = `http://127.0.0.1:${hook.address().port}/-/reload`;

  const cfg = { tenant: 't-hr', env: 'dev', dbName: DB, mongoUri: URI, reloadHook: null };
  let server = createServer(cfg);
  await listen(server);

  try {
    // 1) 未配置 hook：publish 成功，不触发（告警留痕不静默）
    const base1 = `http://127.0.0.1:${server.address().port}`;
    const r1 = await post(base1, '/meta/defs', { defn: { name: 'HrItem', fields: { _id: { type: 'string' } } } });
    assert.equal(r1.status, 200);
    assert.equal(hits, 0);

    // 2) 配置 hook：publish 触发一次 POST，返回 200
    await close(server);
    server = createServer({ ...cfg, reloadHook: hookUrl });
    await listen(server);
    const base2 = `http://127.0.0.1:${server.address().port}`;
    const r2 = await post(base2, '/meta/defs', { defn: { name: 'HrItem2', fields: { _id: { type: 'string' } } } });
    assert.equal(r2.status, 200);
    assert.equal(hits, 1);

    // 3) hook 非 2xx：publish 显式 500 ERR_RELOAD_FAILED（不吞）
    failNext = true;
    const r3 = await post(base2, '/meta/defs', { defn: { name: 'HrItem3', fields: { _id: { type: 'string' } } } });
    assert.equal(r3.status, 500);
    assert.equal(r3.json.error.code, 'ERR_RELOAD_FAILED');
    assert.equal(hits, 2);
  } finally {
    await close(server);
    await close(hook);
    await db.dropDatabase();
    await client.close();
  }
});
