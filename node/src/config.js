'use strict';

/**
 * meta-store 配置解析（环境变量 → 配置对象；fail-fast，禁默认值兜底）。
 *
 * 语义依据：../spec/00-protocol.md「环境变量」。
 * 一个进程只服务一个 `(tenant, env)` 隔离维度；多个 `(tenant, env)` 由部署层起多实例承担。
 */

/** 读取并校验环境变量 → 配置对象；缺失必填 → 抛 `ERR_META_CONFIG` */
function loadConfig(env = process.env) {
  const missing = [];
  if (!env.META_TENANT) missing.push('META_TENANT');
  if (!env.META_ENV) missing.push('META_ENV');
  if (!env.MONGO_URI) missing.push('MONGO_URI');
  if (missing.length) {
    throw new Error(`ERR_META_CONFIG: 缺少必填环境变量 ${missing.join(', ')}`);
  }

  return {
    tenant: env.META_TENANT,
    env: env.META_ENV,
    mongoUri: env.MONGO_URI,
    dbName: env.META_DB || 'meta_store',
    port: env.META_PORT ? Number(env.META_PORT) : 8600,
    reloadHook: env.META_RELOAD_HOOK || null,
  };
}

module.exports = { loadConfig };
