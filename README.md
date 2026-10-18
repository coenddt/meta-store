# meta-store — 定义控制面（Definition Control Plane）

`meta-store` 是 common-store「一切皆数据」家族的**定义侧治理控制面服务**：以 HTTP API 承载
**schema 定义**与 **workflow 定义**的 **发布 / 列表 / 回滚**，把定义持久化到宿主 `nodejs-store`
的内建定义表 `__schemaDef` / `__workflowDef`。

- **零业务语义发明**：端点只做编排与转发，定义判决（版本比对、落库、注册）全在 store 面。
- **零 Web 框架依赖**：HTTP 用 `node:http` 实现。
- **唯一事实源**：[`spec/00-protocol.md`](spec/00-protocol.md)（端点 / 响应壳 / 错误映射以它为准）。

## 状态 / 能力矩阵

| 能力 | 状态 | 说明 |
|---|---|---|
| schema 定义发布（`POST /meta/defs`） | ✅ 已实现 | 版本自增；同名同形幂等 |
| schema 定义列表（`GET /meta/defs`） | ✅ 已实现 | 按 `version desc`，可按 `name` 过滤 |
| schema 定义回滚（`POST /meta/defs/:name/rollback`） | ✅ 已实现 | 追加式（append-only），不改写历史行 |
| workflow 定义发布 / 列表 / 回滚 | ✅ 已实现 | 落 `__workflowDef`，语义与 schema 定义完全一致 |
| 健康检查（`GET /meta/health`） | ✅ 已实现 | 返回 `{ok,tenant,env}` |
| 发布后热重载触发（`META_RELOAD_HOOK`） | ✅ 已实现 | 发布成功即 `POST` 钩子；未配则以告警留痕 |
| 错误 → 状态码映射矩阵（error-matrix） | ✅ 已实现 | 见 [`node/src/index.js`](node/src/index.js) `mapError` |
| 降级 / 拦截事件落 `__feedback` | ✅ 已实现 | 启动时按本实例 `(tenant,env)` 打标签 |
| 认证 / 鉴权 | ❌ 未实现 | 交分步 03 定义层权限 + 网关承担 |
| 多租户 UI / 审批流 | ❌ 非目标 | 见「边界与非目标」 |
| MySQL / PG 定义存储后端 | ❌ 非目标 | 首版仅 Mongo |

## 目录

- [What it is](#what-it-is)
- [When to use / When NOT to use](#when-to-use--when-not-to-use)
- [Installation / 前置条件](#installation--前置条件)
- [Quick start](#quick-start)
- [API / 配置参考](#api--配置参考)
- [场景事例](#场景事例)
- [边界与非目标](#边界与非目标)
- [FAQ](#faq)
- [Development](#development)
- [Related projects](#related-projects)
- [License](#license)

## What it is

`meta-store` 解决的是「一组 schema / workflow 定义，如何被**安全地发布、审计、回滚**，
并让协议面在不重启进程的情况下生效」这一控制面问题。

它在家族架构中的位置（对齐根 `README.md` 的分层）：

| 层 | 组件 | 与 meta-store 的关系 |
|---|---|---|
| 引擎 | `rust-store-core` | 不直接接触；定义判决最终由 core（经宿主）完成 |
| 宿主 | `nodejs-store` / `storepy` | meta-store 只调 `nodejs-store` 的 metadef 面 |
| 协议皮 | `store-api` / `store-graphql` / `store-grpc` / `store-mcp` + `store-gateway` | 通过 `META_RELOAD_HOOK` → 网关 `POST /-/reload` 让新定义对其可见 |
| **控制面** | **`meta-store`** | **本仓：定义的发布 / 列表 / 回滚** |
| 脚手架 | `create-store-app` | 生成的工程用 `scripts/publish-defs.*` 调用本服务的 `POST /meta/defs` |

三条铁律（`spec/00-protocol.md`）：

- **单 `(tenant, env)` 实例**：一个进程只服务一个隔离维度，`tenant` / `env` 由环境变量注入；
  多个 `(tenant, env)` 由部署层**起多实例**承担（进程级隔离；禁同进程多 Registry）。
- **一切经 store 面**：不直接读写 DB 表，只编排转发 `nodejs-store` 的
  `store.persistDef / listDefs / loadDefs / rollbackTo`
  （workflow 定义对应 `store.persistWorkflowDef / listWorkflowDefs / loadWorkflowDefs / rollbackWorkflowTo`）。
- **错误不吞**：全部异常显式上浮并按 `spec/00-protocol.md` 映射为状态码；成功响应不含任何错误语义字段。

设计要点：

- **维度正交（不合并）**：`(tenant, env)` 是**定义仓库**的隔离维度；`source` / `database` / `schema`
  是**数据仓库**的物理定位维度，二者正交、不合并。租户级数据隔离走运行期 `routeOverride` / 落点集合，**不动控制面**。
- **持久化定义 = 纯 JSON**：`defn` **禁止内嵌函数值**（如计算列 `computes.<k>.fn`）；需要计算列的定义
  只写 `fnRef` 字符串，回调实现由接入方在宿主 `register` 时注入（`core.setFn(fnRef, impl)`）。
  含函数值的 defn 由宿主显式拒绝，控制面映射为 **400 `BAD_REQUEST`**（message 含「不可持久化」，原样透传）。
- **回滚是追加式**：`rollbackTo` 以历史行 `defn` 走 `persistDef` 语义落一条**新版本行**，
  历史行不被改写（append-only）；同名同形幂等时返回当前最新行、不新增版本。

## When to use / When NOT to use

**When to use**

- 你有多份 schema / workflow 定义需要**集中发布**，并要能看到**版本历史**。
- 你需要在**不重启业务进程**的前提下让新定义对协议面生效（配 `META_RELOAD_HOOK`）。
- 你需要**可回滚、可审计**的定义治理：每次发布记录 `actor` / `version` / `createdAt`。
- 你要为多个 `(tenant, env)` 提供隔离的定义仓库（部署层起多实例即可）。

**When NOT to use**

- 你只要在进程内直接调 `nodejs-store` / `storepy` 的 `store.register(...)` 注册定义，
  不需要跨进程发布 / 版本 / 回滚 —— 直接用宿主库即可。
- 你要做**业务数据**的增删改查 —— 那是协议皮（`store-api` 等）的事，meta-store 只管**定义**。
- 你要做认证 / 鉴权 / 审批流 / 多租户管理 UI —— 非本仓目标（见「边界与非目标」）。

## Installation / 前置条件

- **Node.js `>=18`**（`node:http` + 全局 `fetch` 依赖）。
- **一个可连接的 MongoDB**（首版定义存储为 Mongo；默认 `mongodb://127.0.0.1:27017`）。
- npm 包名：**`meta-store-node`**（当前版本 `0.2.1`）。

```bash
cd node
npm install
```

依赖（`node/package.json`）：`mongodb ^6.21.0`、`nodejs-store ^3.3.0`。

## Quick start

```bash
cd node
npm install
# 三个必填变量缺失 → 启动即失败（禁默认值兜底）
META_TENANT=acme META_ENV=dev MONGO_URI=mongodb://127.0.0.1:27017 META_PORT=8600 npm start
# => meta-store listening on http://127.0.0.1:8600 (tenant=acme env=dev)
```

另开一个终端，走一遍「发布 → 列表 → 回滚」：

```bash
# 0) 健康检查
curl http://127.0.0.1:8600/meta/health
# => {"data":{"ok":true,"tenant":"acme","env":"dev"}}

# 1) 发布 v1（defn 为纯 JSON，name 非空）
curl -X POST http://127.0.0.1:8600/meta/defs \
  -H 'content-type: application/json' \
  -d '{"defn":{"name":"Order","fields":{"_id":{"type":"string"},"title":{"type":"string"}}},"actor":"alice"}'
# => {"data":{"_id":"acme/dev/Order/1", ... "name":"Order","version":1,"createdBy":"alice", ...}}

# 2) 再发布一个异形版本 → version+1
curl -X POST http://127.0.0.1:8600/meta/defs \
  -H 'content-type: application/json' \
  -d '{"defn":{"name":"Order","fields":{"_id":{"type":"string"},"title":{"type":"string"},"price":{"type":"number"}}}}'
# => {"data":{ "version":2, ... }}

# 3) 列表（按 version desc；可加 ?name=Order 过滤）
curl 'http://127.0.0.1:8600/meta/defs?name=Order'
# => {"data":[{"version":2,...},{"version":1,...}]}

# 4) 回滚到 v1（追加式：落新版本行，返回该行；历史行不改写）
curl -X POST http://127.0.0.1:8600/meta/defs/Order/rollback \
  -H 'content-type: application/json' -d '{"version":1}'
# => {"data":{"version":3, "defn":{ ... v1 的 fields ... }, ...}}
```

## API / 配置参考

### 环境变量（fail-fast）

来源：[`node/src/config.js`](node/src/config.js) 与 `spec/00-protocol.md`。
缺失任一**必填**项 → 构造期抛 `ERR_META_CONFIG`（**禁默认值兜底**，进程不启动）。

| 变量 | 必填 | 缺省 | 说明 |
|---|---|---|---|
| `META_TENANT` | 是 | — | 租户标识（本实例服务的隔离维度之一） |
| `META_ENV` | 是 | — | 环境标识（如 `dev` / `staging` / `prod`） |
| `MONGO_URI` | 是 | — | store 数据源（首版 Mongo） |
| `META_DB` | 否 | `meta_store` | store 定位的数据库名 |
| `META_PORT` | 否 | `8600` | 监听端口 |
| `META_RELOAD_HOOK` | 否 | — | 发布成功后触发的协议重装配钩子 URL |

`loadConfig()` 返回的配置对象形状（`node/src/config.js`）：

```js
{ tenant, env, mongoUri, dbName, port, reloadHook }
```

### 端点契约

来源：`spec/00-protocol.md` + [`node/src/index.js`](node/src/index.js)。共 **7 个端点**
（schema 定义 3 + workflow 定义 3 + health）。

| 方法 | 路径 | 请求体 | 成功响应（200） | 失败 |
|---|---|---|---|---|
| `GET` | `/meta/health` | — | `{data:{ok:true,tenant,env}}` | — |
| `GET` | `/meta/defs?name=<n>` | 无 | `{data:[row,...]}` | 400 |
| `POST` | `/meta/defs` | `{defn, actor?}` | `{data:row}` | 400 / 409 / 403 |
| `POST` | `/meta/defs/:name/rollback` | `{version, actor?}` | `{data:row}` | 400 / 404 |
| `GET` | `/meta/workflowDefs?name=<n>` | 无 | `{data:[row,...]}` | 400 |
| `POST` | `/meta/workflowDefs` | `{defn, actor?}` | `{data:row}` | 400 / 409 / 403 |
| `POST` | `/meta/workflowDefs/:name/rollback` | `{version, actor?}` | `{data:row}` | 400 / 404 |

- `row` 形状 = `__schemaDef` 行：
  `{_id, tenant, env, name, version, defn, status, createdBy, createdAt?, updatedAt?}`。
- `workflowDefs` 的 `row` 形状与语义**完全一致**，仅落表不同（`__workflowDef`）；
  `defn` 为 workflow 定义（`{name, steps, read?/write?/run?}`，纯 JSON）。
- `defs` 列表按 `version desc` 排序；`name` 缺省列该 `(tenant, env)` 全部定义。
- `rollback` 返回的 `row` 为**回滚后新版本行**（`version` 为追加后的新号）；目标历史行不被改写。

### 响应壳

```jsonc
// 成功（2xx）
{ "data": <payload> }
// 失败（4xx/5xx）
{ "error": { "code": "BAD_REQUEST" | "NOT_FOUND" | "CONFLICT" | "PERMISSION" | "NO_CONTEXT", "message": "<原始信息，原样透传>" } }
```

- 成功响应**不得**含 `error` 字段或任何错误语义文案；
- `message` 取错误对象 `message` 原样，不改写、不圆场（取不到则显式 `null`，保留 `code`）。

### 错误 → 状态码映射（error-matrix）

来源：[`node/src/index.js`](node/src/index.js) 的 `mapError`，用例见
[`node/test/error-matrix.test.js`](node/test/error-matrix.test.js)。**逐一列出真实错误码与触发条件**：

| 场景 | 状态码 | code |
|---|---|---|
| 请求体非法 JSON（`readJsonBody` 解析失败） | 400 | `BAD_REQUEST` |
| `POST .../defs` 请求体非 JSON 对象 | 400 | `BAD_REQUEST` |
| `POST .../defs` 缺 `defn` 或 `defn.name`（非空字符串） | 400 | `BAD_REQUEST` |
| `POST .../rollback` 缺 `version` | 400 | `BAD_REQUEST` |
| `POST .../rollback` 的 `version` 非整数 | 400 | `BAD_REQUEST` |
| `MetaDefError` 且 message 含「版本不存在」（回滚目标版本不存在） | 404 | `NOT_FOUND` |
| 未命中任何端点（路径 / 方法不匹配） | 404 | `NOT_FOUND` |
| 其他 `MetaDefError`（非「版本不存在」） | 400 | `BAD_REQUEST` |
| 版本唯一键冲突（`11000` / `DUPLICATE_KEY` / message 含 `duplicate key` / `UNIQUE constraint failed`） | 409 | `CONFLICT` |
| 定义层权限拒绝（message 前缀 `ERR_PERMISSION:`） | 403 | `PERMISSION` |
| 定义层上下文缺失（`err.code === 'no_context'` 或 message 前缀 `ERR_NO_CONTEXT:`） | 403 | `NO_CONTEXT` |
| 持久化定义含函数值（宿主拒绝，message 含「不可持久化」） | 400 | `BAD_REQUEST` |
| `META_RELOAD_HOOK` 返回非 2xx（`ERR_RELOAD_FAILED`） | 500 | `ERR_RELOAD_FAILED` |
| 其余（数据库 / 连接 / 方言等） | 500 | 错误对象的 `code`（取不到为 `INTERNAL`） |

> 必填环境变量缺失**不产生 HTTP 响应**：在构造期抛 `ERR_META_CONFIG`，进程启动即失败。

### 可编程接口

`node/src/index.js` 导出（供嵌入与测试）：

| 导出 | 签名 | 说明 |
|---|---|---|
| `loadConfig(env?)` | `→ cfg` | 环境变量 → 配置对象（fail-fast） |
| `mapError(err)` | `→ {status, code, message}` | 错误 → 状态码纯函数（无 IO，可单测） |
| `createServer(cfg)` | `→ http.Server` | 组装路由（返回**未监听**的 Server） |
| `bootstrap(cfg)` | `→ MongoClient` | 连接数据源 + `init(db)` + `store.ensureBuiltins()` + 接线反馈落库 |

- `main()`：`bootstrap` + `server.listen(cfg.port, '127.0.0.1')`，并挂 `SIGINT` / `SIGTERM` 优雅关闭
  （关闭前 `store.flushFeedback()` 收口在途反馈）。
- **首版只绑 `127.0.0.1`**；外网暴露由部署层（网关）承担。

### 发布 → 热重载闭环

来源：`spec/00-protocol.md`「发布闭环」。

```
POST /meta/defs ──► store.persistDef（写 __schemaDef，不注册）
                 └─► afterPublish(cfg)
                       ├─ 未配 META_RELOAD_HOOK：publish 仍成功，但 console.warn 告警留痕（不静默）
                       └─ 配了 META_RELOAD_HOOK：POST <hook>；非 2xx → 抛 ERR_RELOAD_FAILED（映射 500）
                                      └─► 网关 POST /-/reload → store.restoreDefs({tenant,env})
                                          → 从 __schemaDef / __workflowDef 重建注册表 → 协议面可见
```

- **回滚同走这条桥**：`rollbackTo` 追加式落新版本行 → 网关 `restoreDefs → loadDefs` 取「各 name 最新 active」
  → 回滚后的 `defn` 被装配 → **回滚经一次 reload 对协议面可见**。

## 场景事例

### 事例 1：集中管理多应用的定义与 workflow-defs

**业务背景**
一个团队有多套数据应用（订单、库存、结算…），每个应用有一份 schema 定义和若干 workflow 定义。
分散在各自仓库里，谁改了什么、改到第几版无从追溯。

**命令 / 调用**
把 schema 定义与 workflow 定义都发布到同一 `(tenant, env)` 的 meta-store：

```bash
# schema 定义
curl -X POST http://127.0.0.1:8600/meta/defs \
  -H 'content-type: application/json' \
  -d '{"defn":{"name":"Order","fields":{"_id":{"type":"string"},"title":{"type":"string"}}},"actor":"alice"}'

# workflow 定义（纯 JSON：{name, steps, read?/write?/run?}）
curl -X POST http://127.0.0.1:8600/meta/workflowDefs \
  -H 'content-type: application/json' \
  -d '{"defn":{"name":"WfSmoke","steps":[{"op":"query","as":"a","gql":"Order(){ _id }"}]},"actor":"bob"}'

# 分别列表
curl 'http://127.0.0.1:8600/meta/defs?name=Order'
curl 'http://127.0.0.1:8600/meta/workflowDefs?name=WfSmoke'
```

**结果**
两类定义分别落 `__schemaDef` / `__workflowDef`；列表按 `version desc` 返回，
每条带 `name` / `version` / `createdBy` / `actor`，版本历史一目了然。

**优势所在**
控制面**不发明业务语义**，只转发 store 面 —— 所以 schema 与 workflow 定义共用**同一套**版本 /
列表 / 回滚语义，团队无需为两类定义各写一套治理逻辑。

### 事例 2：配置热重载，不重启业务进程

**业务背景**
生产环境改一个字段就要重启网关 / 业务进程，代价高且会中断流量。

**命令 / 调用**
给 meta-store 配 `META_RELOAD_HOOK` 指向网关的重装配端点（如 `http://127.0.0.1:8080/-/reload`）：

```bash
META_TENANT=acme META_ENV=prod MONGO_URI=mongodb://127.0.0.1:27017 \
  META_RELOAD_HOOK=http://127.0.0.1:8080/-/reload npm start
```

之后每次发布，meta-store 会自动 `POST` 一次该钩子：

```bash
curl -X POST http://127.0.0.1:8600/meta/defs \
  -H 'content-type: application/json' \
  -d '{"defn":{"name":"Order","fields":{"_id":{"type":"string"},"status":{"type":"string"}}}}'
```

**结果**
网关收到 `POST /-/reload` → `store.restoreDefs({tenant,env})` → 从内建表重建注册表 → 新定义对协议面可见，
**业务进程 PID 不变**（对齐 `node/test/hot-reload.test.js`：发布一次 → 钩子被命中一次）。

**优势所在**
定义生效与进程生命周期解耦：发布即可见，无需重启；钩子返回非 2xx 时发布**显式 500 `ERR_RELOAD_FAILED`**
（不吞、不重试、不静默）。

### 事例 3：通过 error-matrix 快速定位配置错误

**业务背景**
定义发布失败时，如果只回一个笼统的 500，排障要靠翻日志。

**命令 / 调用**
发布一个缺 `name` 的非法定义：

```bash
curl -i -X POST http://127.0.0.1:8600/meta/defs \
  -H 'content-type: application/json' -d '{"actor":"x"}'
```

回滚一个不存在的版本：

```bash
curl -i -X POST http://127.0.0.1:8600/meta/defs/Order/rollback \
  -H 'content-type: application/json' -d '{"version":99}'
```

**结果**

```jsonc
// 缺 name → 400
{"error":{"code":"BAD_REQUEST","message":"缺 defn 或 defn.name（非空字符串）"}}
// 版本不存在 → 404
{"error":{"code":"NOT_FOUND","message":"..."}}
```

（对齐 `node/test/error-matrix.test.js` 与 `smoke.test.js`：权限类 → 403、NoContext → 403、
其余 → 500 透传原文。）

**优势所在**
错误档位可**程序化区分**（`BAD_REQUEST` / `NOT_FOUND` / `CONFLICT` / `PERMISSION` / `NO_CONTEXT`），
调用方据状态码即可分流处理；`message` 原样透传，不圆场，排障直达根因。

### 事例 4：多环境（tenant/env）配置切换

**业务背景**
同一套应用要分别在 `dev` / `staging` / `prod` 维护各自的定义仓库，互不干扰。

**命令 / 调用**
每个 `(tenant, env)` **起一个独立进程**（进程级隔离）：

```bash
# dev 实例
META_TENANT=acme META_ENV=dev  META_PORT=8600 npm start
# prod 实例
META_TENANT=acme META_ENV=prod META_PORT=8601 npm start
```

发布时按端口区分目标环境：

```bash
curl -X POST http://127.0.0.1:8600/meta/defs -H 'content-type: application/json' \
  -d '{"defn":{"name":"Order","fields":{"_id":{"type":"string"}}}}'   # → dev
curl 'http://127.0.0.1:8601/meta/health'                              # → tenant=acme env=prod
```

**结果**
`__schemaDef` 行内含 `tenant` / `env`，两套环境各自独立；`GET /meta/defs` 只列本实例维度下的定义。

**优势所在**
隔离维度由**进程边界**保证，无需在同一进程里做多 Registry 的复杂隔离；
`(tenant, env)` 与数据定位维度（`source` / `database` / `schema`）正交，互不耦合。

### 事例 5：定义发布后各协议皮自动生效

**业务背景**
一个应用同时开了 REST 和 GraphQL 皮，新加一个字段希望两边都能查。

**命令 / 调用**
先把网关的 reload 钩子接上（见事例 2），然后发布新的 `defn`；网关在重装配时按 `kind` 从
`__schemaDef` / `__workflowDef` 重建 schema 与 workflow 两类注册表。

```bash
curl -X POST http://127.0.0.1:8600/meta/defs \
  -H 'content-type: application/json' \
  -d '{"defn":{"name":"Order","fields":{"_id":{"type":"string"},"title":{"type":"string"},"price":{"type":"number"}}}}'
```

**结果**
一次发布 → 一次 reload → REST 与 GraphQL（及 gRPC / MCP 等已装配的皮）在**同一份注册表**上生效，
各皮表现一致。

**优势所在**
协议皮之间不各自注册定义，而是**共用一个注册表**；meta-store 只负责把定义落到内建表并触发一次重建，
避免了「某个皮漏更新」的一致性缺口。

### 事例 6：配置缺失时的显式报错（fail-fast）

**业务背景**
忘了设租户 / 环境，服务带着默认值悄悄跑起来，结果把定义写进了错误的维度。

**命令 / 调用**
故意少传一个必填变量：

```bash
META_TENANT=acme MONGO_URI=mongodb://127.0.0.1:27017 npm start
```

**结果**

```
Error: ERR_META_CONFIG: 缺少必填环境变量 META_ENV
（进程 exit 1，不监听端口）
```

（来源：`node/src/config.js`。）

**优势所在**
必填配置**缺一即拒启**，禁默认值兜底 —— 用「启动失败」代替「带错值静默运行」，
把配置错误暴露在部署阶段而非运行阶段。

## 边界与非目标

- **首版不做认证**：认证由分步 03 的定义层权限 + 网关承担；本服务默认只绑 `127.0.0.1`。
- **不含审批流、多租户 UI、MySQL / PG 定义存储后端**：本服务是定义侧治理的**最小闭环**。
- **不改写历史版本行**：回滚是追加式（append-only），保证版本序列可审计。
- **不内嵌函数值**：持久化定义必须是纯 JSON，计算列只写 `fnRef`。
- **不做业务数据 CRUD**：那是协议皮的职责。

## FAQ

**Q1：meta-store 和 `nodejs-store` 是什么关系？**
它只调 `nodejs-store` 的 metadef 面（`persistDef / listDefs / loadDefs / rollbackTo` 及 workflow 对应门面），
把定义持久化到内建表 `__schemaDef` / `__workflowDef`；控制面本身不直接读写 DB 表。

**Q2：为什么一个进程只服务一个 `(tenant, env)`？**
这是「单实例铁律」：隔离维度由进程边界保证，多个 `(tenant, env)` 由部署层起多实例承担，
禁止同进程多 Registry。

**Q3：`META_RELOAD_HOOK` 不配会怎样？**
publish 仍然成功，但新定义对协议面**不可见**，控制面会 `console.warn` 告警留痕（不静默）。
你需要手动让网关重装配。

**Q4：`META_RELOAD_HOOK` 配了但目标返回 5xx 呢？**
发布会显式返回 **500 `ERR_RELOAD_FAILED`**（不吞、不重试）。

**Q5：为什么回滚后 `version` 不是回退而是变大？**
因为回滚是**追加式**：以历史行的 `defn` 落一条**新版本行**，历史行不改写。
若回滚到「当前已生效内容」（同名同形），则幂等返回现最新行、不新增版本。

**Q6：定义里能写函数吗？**
不能。持久化定义必须是纯 JSON；计算列只写 `fnRef` 字符串，函数实现由宿主 `register` 时注入。
含函数值会被宿主拒绝并映射为 400 `BAD_REQUEST`（message 含「不可持久化」）。

**Q7：为什么 `message` 直接透传原文？**
遵循 `no-error-masking`：错误信息原样上浮，不改写、不圆场；成功响应不含任何错误语义字段。

**Q8：缺必填环境变量会返回什么 HTTP 状态码？**
不会返回 HTTP —— 缺失必填变量在**构造期**抛 `ERR_META_CONFIG`，进程启动即失败（exit 1）。

**Q9：怎么单独验证错误映射逻辑？**
`mapError` 是**纯函数**，`node/test/error-matrix.test.js` 直接调它，无需真实 Mongo，跑 `npm test` 即可。

**Q10：这个服务会暴露到公网吗？**
默认不会。首版只绑 `127.0.0.1`，外网暴露由部署层（网关）承担。

## Development

```bash
cd node
npm install
npm test          # = node scripts/test.js → node --test test
```

- 依赖 `nodejs-store` 的 Rust 原生核心，一律从 npm 依赖加载（与生产同路径）；如需从相邻
  `rust-store/core-node/dist/` 的调试产物加载，请显式设置 `LOCAL_CORE=1`（启动器不强制注入）。
- 测试文件：
  - `test/smoke.test.js` —— `save → list → rollback` 闭环冒烟；
  - `test/error-matrix.test.js` —— 错误 → 状态码映射矩阵（纯函数，无需 Mongo）；
  - `test/workflow-defs.test.js` —— workflow 定义 publish / list / rollback；
  - `test/hot-reload.test.js` —— `META_RELOAD_HOOK` 发布后热重装配触发链。
- **需本地 Mongo**（默认 `mongodb://127.0.0.1:27017`，可用 `MONGO_URI` 覆盖）；不可达时相关用例**跳过**
  （不误报失败）。

## Related projects

common-store 家族（分层见根 `README.md`）：

| 层 | 组件 | 关系 |
|---|---|---|
| 引擎 | `rust-store-core` | 定义判决的最终判据（经宿主调用） |
| 宿主 | `nodejs-store` / `storepy` | meta-store 依赖 `nodejs-store` 的 metadef 面 |
| 协议皮 | `store-api` / `store-graphql` / `store-grpc` / `store-mcp` + `store-gateway` | 通过 `POST /-/reload` 让新定义对其可见 |
| 控制面 | **`meta-store`（本仓）** | 定义的发布 / 列表 / 回滚 |
| 脚手架 | `create-store-app` | 生成的工程用 `scripts/publish-defs.*` 调本服务 `POST /meta/defs` |

- 宿主文档：https://github.com/coenddt/nodejs-store （npm `nodejs-store`）
- 引擎：https://coenddt.github.io/rust-store/ · 仓库 https://github.com/coenddt/rust-store

## License

MIT（见 [LICENSE](LICENSE)，Copyright (c) 2026 丁滔）。
