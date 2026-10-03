'use strict';

/**
 * meta-store 控制面冒烟：save → list → rollback 闭环（A1/A2 控制面侧）。
 *
 * 需本地 Mongo（默认 mongodb://127.0.0.1:27017；可用 MONGO_URI 覆盖）；
 * 不可达时跳过（不误报失败）。用独立库 `meta_store_smoke`，跑完 dropDatabase。
 */

const test = require('node:test');
const assert = require('node:assert');
const { MongoClient } = require('mongodb');
const { init, store } = require('nodejs-store');
const { createServer } = require('../src/index');

const URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017';
const DB = 'meta_store_smoke';
const CFG = { tenant: 't-smoke', env: 'dev', dbName: DB, mongoUri: URI, reloadHook: null };

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

test('meta-store 定义治理闭环：save → list → rollback', async (t) => {
  if (!(await canConnect())) {
    t.skip('本地 Mongo 不可达，跳过冒烟');
    return;
  }

  const client = new MongoClient(URI);
  await client.connect();
  const db = client.db(DB);
  await db.dropDatabase();
  await init(db);
  store.ensureBuiltins();

  const server = createServer(CFG);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const post = async (path, payload) => {
    const r = await fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return { status: r.status, json: await r.json() };
  };

  try {
    // health
    const h = await fetch(`${base}/meta/health`);
    assert.equal(h.status, 200);
    assert.deepEqual((await h.json()).data, { ok: true, tenant: 't-smoke', env: 'dev' });

    // save v1
    const v1 = { name: 'SmokeItem', fields: { _id: { type: 'string' }, title: { type: 'string' } } };
    const r1 = await post('/meta/defs', { defn: v1, actor: 'smoke' });
    assert.equal(r1.status, 200);
    assert.equal(r1.json.data.version, 1);
    assert.equal(r1.json.data.createdBy, 'smoke');

    // 同名同形幂等：不新增
    const r1b = await post('/meta/defs', { defn: v1 });
    assert.equal(r1b.json.data._id, r1.json.data._id);
    assert.equal(r1b.json.data.version, 1);

    // 异形 → version+1
    const v2 = { name: 'SmokeItem', fields: { _id: { type: 'string' }, title: { type: 'string' }, price: { type: 'number' } } };
    const r2 = await post('/meta/defs', { defn: v2 });
    assert.equal(r2.json.data.version, 2);

    // list（version desc）
    const l = await fetch(`${base}/meta/defs?name=SmokeItem`);
    assert.equal(l.status, 200);
    assert.deepEqual((await l.json()).data.map((r) => r.version), [2, 1]);

    // rollback → v1 生效（追加式：以 v1 defn 落新版本行，返回该行 version=3）
    const rb = await post('/meta/defs/SmokeItem/rollback', { version: 1 });
    assert.equal(rb.status, 200);
    assert.equal(rb.json.data.version, 3);
    assert.deepEqual(rb.json.data.defn.fields, v1.fields);
    assert.deepEqual(store.get('SmokeItem').fields, v1.fields);

    // 版本不存在 → 404 NOT_FOUND
    const rbm = await post('/meta/defs/SmokeItem/rollback', { version: 99 });
    assert.equal(rbm.status, 404);
    assert.equal(rbm.json.error.code, 'NOT_FOUND');

    // 缺 defn.name → 400 BAD_REQUEST
    const bad = await post('/meta/defs', { actor: 'x' });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error.code, 'BAD_REQUEST');
  } finally {
    await new Promise((r) => server.close(r));
    await db.dropDatabase();
    await client.close();
  }
});
