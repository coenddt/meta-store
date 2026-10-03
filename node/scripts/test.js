'use strict';

/**
 * 测试启动器
 *
 * meta-store 依赖 nodejs-store 的 Rust 原生核心。本地开发时优先用相邻
 * `rust-store/core-node/dist/` 的调试产物，故显式开启 nodejs-store `core.js` 的开发期
 * 兜底开关（LOCAL_CORE=1）；该产物不存在时自动回落到 npm 依赖（CI 走此路径）。
 * 对齐 nodejs-store/scripts/test.js。生产运行不经过本文件。
 */

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const root = path.join(__dirname, '..');
const env = { ...process.env, LOCAL_CORE: '1' };
const result = spawnSync(process.execPath, ['--test', 'test/**/*.js'], {
  cwd: root,
  stdio: 'inherit',
  env,
});

process.exit(result.status ?? 1);
