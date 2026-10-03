# meta-store — 定义控制面

`meta-store` 是 common-store「一切皆数据」**定义侧治理**的控制面服务：以 HTTP API 承载
schema 定义的 **发布 / 列表 / 回滚**，把定义持久化到 `nodejs-store` 的内建定义表
`__schemaDef`（分步 01 提供）。

## 形态

- **单 namespace 实例**：一个进程只服务一个 `(tenant, env)`；`tenant`/`env` 由环境变量注入。
  多 namespace 由部署层**起多实例**承担（进程级隔离；禁同进程多 Registry）。
- **零 Web 框架依赖**：HTTP 服务用 `node:http` 实现（`fastify` 等留待后续评审）。
- **一切经 store 面**：控制面不直接读写 DB 表，只编排转发 `nodejs-store` 的
  `store.persistDef / listDefs / loadDefs / rollbackTo`。
- **错误不吞**：定义层权限拒绝（`ERR_PERMISSION:`）、版本唯一键冲突等**原样上浮**并按
  `spec/00-protocol.md` 映射为状态码（遵 `no-error-masking`）。

## 目录

```
meta-store/
├── README.md
├── spec/00-protocol.md      # 端点契约 + 响应壳 + 错误映射（唯一事实源）
└── node/                    # Node 控制面实现
    ├── package.json
    ├── src/config.js        # 环境变量解析（fail-fast）
    ├── src/index.js         # node:http 服务 + 4 端点
    └── test/smoke.test.js   # save → list → rollback 闭环冒烟
```

## 运行

```
cd node
npm install
META_TENANT=acme META_ENV=dev MONGO_URI=mongodb://127.0.0.1:27017 META_PORT=8600 npm start
```

必填环境变量缺失 → 启动即失败（禁默认值兜底），详见 `spec/00-protocol.md`。

## 边界

- 首版**不做认证**：认证由分步 03 的定义层权限 + 网关承担；本服务默认只绑 `127.0.0.1`。
- 本服务是定义侧治理的**最小闭环**；不含审批流、多租户 UI、MySQL/PG 定义存储后端。
