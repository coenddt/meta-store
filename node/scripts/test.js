'use strict';

/**
 * 测试启动器
 *
 * meta-store 依赖 nodejs-store 的 Rust 原生核心，一律从 npm 依赖加载（与生产同路径）。
 * 如需从相邻 `rust-store/core-node/dist/` 的调试产物加载，请在外部显式设置 LOCAL_CORE=1
 * （本启动器不再强制注入）。对齐 nodejs-store/scripts/test.js。生产运行不经过本文件。
 */

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const root = path.join(__dirname, '..');
const env = { ...process.env }; // 透传外部环境；不再注入 LOCAL_CORE=1
const result = spawnSync(process.execPath, ['--test', 'test/**/*.js'], {
  cwd: root,
  stdio: 'inherit',
  env,
});

process.exit(result.status ?? 1);
