'use strict';

/**
 * 映射矩阵：每档错误语义 → 控制面 /meta 响应壳 {status, code}（A3「可程序化区分」验收）。
 * 直接调纯函数 mapError（无需真实 Mongo），meta-store 仅 node 端。
 * 规范依据：spec/00-protocol.md（NoContext ⇒ 403/NO_CONTEXT；权限类同档 ⇒ 403/PERMISSION）。
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { mapError } = require('../src/index');

test('映射矩阵：NoContext 档（machine code no_context）→ 403/NO_CONTEXT', () => {
  const e = new Error('上下文缺失');
  e.code = 'no_context';
  const r = mapError(e);
  assert.equal(r.status, 403);
  assert.equal(r.code, 'NO_CONTEXT');
  assert.equal(r.message, '上下文缺失');
});

test('映射矩阵：NoContext 档（字符串通道前缀 ERR_NO_CONTEXT:）→ 403/NO_CONTEXT', () => {
  const r = mapError(new Error('ERR_NO_CONTEXT:上下文缺失'));
  assert.equal(r.status, 403);
  assert.equal(r.code, 'NO_CONTEXT');
});

test('映射矩阵：Permission 档（前缀 ERR_PERMISSION:）→ 403/PERMISSION', () => {
  const r = mapError(new Error('ERR_PERMISSION:无访问权限'));
  assert.equal(r.status, 403);
  assert.equal(r.code, 'PERMISSION');
});

test('映射矩阵：Other 档 → 500 透传原文（禁静默）', () => {
  const e = new Error('内部错误');
  e.code = 'INTERNAL';
  const r = mapError(e);
  assert.equal(r.status, 500);
  assert.equal(r.code, 'INTERNAL');
  assert.equal(r.message, '内部错误');
});