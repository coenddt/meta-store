'use strict';

/**
 * meta-store 控制面 workflow 定义端点：save → list → rollback 闭环（审计 §8 N1 控制面侧）。
 *
 * 需本地 Mongo（默认 mongodb://127.0.0.1:27017；可用 MONGO_URI 覆盖）；不可达时跳过（不误报失败）。
 * 用独立库 `meta_store_wfdefs`，跑完 dropDatabase。
 */

const test = require('node:test');
const assert = require('node:assert');
const { MongoClient } = require('mongodb');
const { init, store } = require('nodejs-store');
const { createServer } = require('../src/index');

const URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017';
const DB = 'meta_store_wfdefs';
const CFG = { tenant: 't-wf', env: 'dev', dbName: DB, mongoUri: URI, reloadHook: null };

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

/** 最小合法 workflow defn（注册期白名单通过） */
function wf(name, gql = 'Item(){ _id }') {
  return { name, steps: [{ op: 'query', as: 'a', gql }] };
}

test('控制面 workflowDefs 闭环：save → list → rollback', async (t) => {
  if (!(await canConnect())) {
    t.skip('本地 Mongo 不可达，跳过');
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
    // save v1
    const r1 = await post('/meta/workflowDefs', { defn: wf('WfSmoke'), actor: 'wf' });
    assert.equal(r1.status, 200);
    assert.equal(r1.json.data.version, 1);
    assert.equal(r1.json.data.createdBy, 'wf');
    assert.equal(r1.json.data.name, 'WfSmoke');

    // 同名同形幂等：不新增
    const r1b = await post('/meta/workflowDefs', { defn: wf('WfSmoke') });
    assert.equal(r1b.json.data._id, r1.json.data._id);
    assert.equal(r1b.json.data.version, 1);

    // 异形 → version+1
    const r2 = await post('/meta/workflowDefs', { defn: wf('WfSmoke', 'Item(){ _id title }') });
    assert.equal(r2.json.data.version, 2);

    // list（version desc）
    const l = await fetch(`${base}/meta/workflowDefs?name=WfSmoke`);
    assert.equal(l.status, 200);
    assert.deepEqual((await l.json()).data.map((row) => row.version), [2, 1]);

    // rollback → v1 生效（追加式：落新版本行 version=3，并本进程重注册）
    const rb = await post('/meta/workflowDefs/WfSmoke/rollback', { version: 1 });
    assert.equal(rb.status, 200);
    assert.equal(rb.json.data.version, 3);
    assert.equal(store.getWorkflow('WfSmoke').steps[0].gql, 'Item(){ _id }');

    // 版本不存在 → 404 NOT_FOUND
    const rbm = await post('/meta/workflowDefs/WfSmoke/rollback', { version: 99 });
    assert.equal(rbm.status, 404);
    assert.equal(rbm.json.error.code, 'NOT_FOUND');

    // 缺 defn.name → 400 BAD_REQUEST
    const bad = await post('/meta/workflowDefs', { actor: 'x' });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error.code, 'BAD_REQUEST');
  } finally {
    await new Promise((r) => server.close(r));
    await db.dropDatabase();
    await client.close();
  }
});
