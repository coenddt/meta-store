'use strict';

/**
 * meta-store — 定义控制面服务（单 namespace 实例）
 *
 * 语义依据：../spec/00-protocol.md（端点 / 响应壳 / 错误映射唯一事实源）。
 * 本层零业务语义：只编排转发 `nodejs-store` 的 metadef 面（store.persistDef /
 * listDefs / loadDefs / rollbackTo）；不直接读写 DB 表。
 *
 * 零 Web 框架依赖：HTTP 用 `node:http`；首版只绑 127.0.0.1（外网暴露交部署层）。
 */

const http = require('node:http');
const { MongoClient } = require('mongodb');
const { init, store } = require('nodejs-store');
const { loadConfig } = require('./config');

/** 发送 JSON 响应（响应壳：成功 {data}，失败 {error:{code,message}}） */
function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

/** 读取请求体 → JSON 对象（空体/非法 JSON → null） */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve(null);
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(Object.assign(new Error(`请求体非法 JSON: ${e.message}`), { code: 'INVALID_BODY' }));
      }
    });
    req.on('error', reject);
  });
}

/** 错误 → {status, code, message}（spec/00 映射表；message 原样透传，不圆场） */
function mapError(err) {
  const message = err && err.message != null ? String(err.message) : null;
  const code = (err && (err.code || err.name)) || 'INTERNAL';
  if (message && message.startsWith('ERR_PERMISSION:')) {
    return { status: 403, code: 'PERMISSION', message };
  }
  if (code === 11000 || code === 'DUPLICATE_KEY' || /duplicate key|UNIQUE constraint failed/i.test(message || '')) {
    return { status: 409, code: 'CONFLICT', message };
  }
  if (code === 'INVALID_BODY') {
    return { status: 400, code: 'BAD_REQUEST', message };
  }
  if (err && err.name === 'MetaDefError') {
    return /版本不存在/.test(message || '')
      ? { status: 404, code: 'NOT_FOUND', message }
      : { status: 400, code: 'BAD_REQUEST', message };
  }
  return { status: 500, code, message };
}

/** 端点表：method + 路径正则（捕获组为路径参数）→ 处理函数 */
function buildRoutes(cfg) {
  return [
    {
      method: 'GET',
      pattern: /^\/meta\/health$/,
      handler: async () => ({ status: 200, data: { ok: true, tenant: cfg.tenant, env: cfg.env } }),
    },
    {
      method: 'GET',
      pattern: /^\/meta\/defs$/,
      handler: async ({ query }) => {
        const name = query.get('name');
        const rows = await store.listDefs({
          tenant: cfg.tenant,
          env: cfg.env,
          name: name === null ? undefined : name,
        });
        return { status: 200, data: rows };
      },
    },
    {
      method: 'POST',
      pattern: /^\/meta\/defs$/,
      handler: async ({ body }) => {
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          return { status: 400, error: { code: 'BAD_REQUEST', message: '请求体须为 JSON 对象 {defn, actor?}' } };
        }
        if (!body.defn || typeof body.defn !== 'object' || typeof body.defn.name !== 'string' || !body.defn.name) {
          return { status: 400, error: { code: 'BAD_REQUEST', message: '缺 defn 或 defn.name（非空字符串）' } };
        }
        const row = await store.persistDef(body.defn, {
          tenant: cfg.tenant,
          env: cfg.env,
          actor: body.actor,
        });
        return { status: 200, data: row };
      },
    },
    {
      method: 'POST',
      pattern: /^\/meta\/defs\/([^/]+)\/rollback$/,
      handler: async ({ params, body }) => {
        if (!body || typeof body !== 'object' || Array.isArray(body) || body.version == null) {
          return { status: 400, error: { code: 'BAD_REQUEST', message: '缺 version' } };
        }
        const version = Number(body.version);
        if (!Number.isInteger(version)) {
          return { status: 400, error: { code: 'BAD_REQUEST', message: `version 须为整数，收到 ${body.version}` } };
        }
        const row = await store.rollbackTo({
          tenant: cfg.tenant,
          env: cfg.env,
          name: decodeURIComponent(params[0]),
          version,
        });
        return { status: 200, data: row };
      },
    },
  ];
}

/** 组装未监听的 http.Server（配置注入 tenant/env；store 由 bootstrap 预先 init） */
function createServer(cfg) {
  const routes = buildRoutes(cfg);
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
      const route = routes.find((r) => r.method === req.method && r.pattern.test(url.pathname));
      if (!route) {
        return send(res, 404, { error: { code: 'NOT_FOUND', message: `未命中端点: ${req.method} ${url.pathname}` } });
      }
      const body = req.method === 'POST' ? await readJsonBody(req) : null;
      const out = await route.handler({ req, res, url, params: url.pathname.match(route.pattern).slice(1), query: url.searchParams, body });
      if (out.error) return send(res, out.status, { error: out.error });
      return send(res, out.status, { data: out.data });
    } catch (err) {
      const mapped = mapError(err);
      return send(res, mapped.status, { error: { code: mapped.code, message: mapped.message } });
    }
  });
}

/** 连接数据源 + 自举内建定义表（返回待关闭的 MongoClient） */
async function bootstrap(cfg) {
  const client = new MongoClient(cfg.mongoUri);
  await client.connect();
  await init(client.db(cfg.dbName));
  store.ensureBuiltins();
  return client;
}

async function main() {
  const cfg = loadConfig();
  const client = await bootstrap(cfg);
  const server = createServer(cfg);
  await new Promise((resolve) => server.listen(cfg.port, '127.0.0.1', resolve));
  const { port } = server.address();
  // eslint-disable-next-line no-console
  console.log(`meta-store listening on http://127.0.0.1:${port} (tenant=${cfg.tenant} env=${cfg.env})`);
  const shutdown = async () => {
    await new Promise((r) => server.close(r));
    await client.close();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return { server, client };
}

if (require.main === module) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}

module.exports = { createServer, bootstrap, mapError, loadConfig };
