# 00 — meta-store 定义控制面：协议

> 唯一事实源：控制面的一切端点、请求/响应字段、错误映射一律回指本文件，不得另立口径。
> 日期：2026-10-03
> 上游：`doc/execution/2026/10/*meta-store定义控制面*`（总纲 + 分步 01/02）；响应壳对齐 `store-api/spec/03-errors.md`。

## 定位

`meta-store` 以 HTTP API 承载「定义侧治理」动作（发布 / 列表 / 回滚），把 **schema 定义**与
**workflow 定义**持久化到宿主 `nodejs-store` 的内建定义表 `__schemaDef` / `__workflowDef`（分步 01）。
**零业务语义发明**：端点只做编排与转发，定义判决（版本比对、落库、注册）全在 store 面。

三条铁律：

- **单 ns 实例**：一个进程服务一个 `(tenant, env)`（环境变量注入）；多 ns = 多进程（进程级隔离）。
- **一切经 store 面**：不直接读写 DB 表；只调 `store.persistDef / listDefs / loadDefs / rollbackTo`
  （workflow 定义对应 `store.persistWorkflowDef / listWorkflowDefs / loadWorkflowDefs / rollbackWorkflowTo`）。
- **错误不吞**：全部异常显式上浮并按本文件映射；成功响应不含任何错误语义字段。

## 环境变量（fail-fast）

| 变量 | 必填 | 缺省 | 说明 |
|---|---|---|---|
| `META_TENANT` | 是 | — | 租户标识（本实例服务的 namespace 维度之一） |
| `META_ENV` | 是 | — | 环境标识（dev/staging/prod） |
| `MONGO_URI` | 是 | — | store 数据源（首版 Mongo） |
| `META_DB` | 否 | `meta_store` | store 定位的数据库名 |
| `META_PORT` | 否 | `8600` | 监听端口 |
| `META_RELOAD_HOOK` | 否 | — | 发布成功后触发的协议重装配钩子（分步 04） |

- 缺失任一必填 → 构造期抛 `ERR_META_CONFIG`（**禁默认值兜底**）。

## 端点契约

| 方法 | 路径 | 请求 | 成功响应（200） | 失败 |
|---|---|---|---|---|
| GET | `/meta/health` | — | `{data:{ok:true,tenant,env}}` | — |
| GET | `/meta/defs?name=<n>` | 无 body | `{data:[row,...]}` | 400 |
| POST | `/meta/defs` | `{defn, actor?}` | `{data:row}` | 400 / 409 / 403 |
| POST | `/meta/defs/:name/rollback` | `{version, actor?}` | `{data:row}` | 400 / 404 |
| GET | `/meta/workflowDefs?name=<n>` | 无 body | `{data:[row,...]}` | 400 |
| POST | `/meta/workflowDefs` | `{defn, actor?}` | `{data:row}` | 400 / 409 / 403 |
| POST | `/meta/workflowDefs/:name/rollback` | `{version, actor?}` | `{data:row}` | 400 / 404 |

`row` 形状 = `__schemaDef` 行：`{_id, tenant, env, name, version, defn, status, createdBy, createdAt?, updatedAt?}`。
`workflowDefs` 的 `row` 形状与语义**完全一致**，仅落表不同（`__workflowDef`）；`defn` 为 workflow 定义（`{name, steps, read?/write?/run?}`，纯 JSON）。

`defs` 列表按 `version desc`；`name` 缺省列该 `(tenant, env)` 全部定义。

`rollback` 返回的 `row` 为**回滚后新版本行**：`version` 为追加后的新号（回滚到「当前已生效内容」时因同名同形幂等返回现最新行、不新增版本）；目标历史行不被改写（append-only）。

## 响应壳（对齐 `store-api/spec/03-errors.md`）

```jsonc
// 成功（2xx）
{ "data": <payload> }
// 失败（4xx/5xx）
{ "error": { "code": "BAD_REQUEST" | "NOT_FOUND" | "CONFLICT" | "PERMISSION", "message": "<原始信息，原样透传>" } }
```

- 成功响应**不得**含 `error` 字段或任何错误语义文案；
- `message` 取错误对象 `message` 原样，不改写、不圆场（取不到则显式 `null`，保留 `code`）。

## 错误 → 状态码映射

| 场景 | 状态码 | code |
|---|---|---|
| `POST /meta/defs` 缺 `defn` 或 `defn.name` | 400 | `BAD_REQUEST` |
| `POST .../rollback` 缺 `version` | 400 | `BAD_REQUEST` |
| 回滚目标版本不存在 | 404 | `NOT_FOUND` |
| 版本唯一键冲突（并发写同版本） | 409 | `CONFLICT` |
| 定义层权限拒绝（message 前缀 `ERR_PERMISSION:`；分步 03） | 403 | `PERMISSION` |
| 其余（数据库 / 连接 / 方言等） | 500 | 错误对象 `code`/`name` |

## 装配与生命周期

1. `bootstrap(cfg)`：`MongoClient.connect` → `init(client.db(cfg.dbName))` → `store.ensureBuiltins()`；
2. `createServer(cfg)`：基于 `node:http` 组装路由（返回未监听的 `http.Server`）；
3. `main()`：`bootstrap` + `listen(cfg.port, '127.0.0.1')`。

> 首版只绑 `127.0.0.1`；外网暴露由部署层（网关）承担。控制面不做认证（认证在分步 03 + 网关）。

## 发布闭环（publish → reload → 协议面可见）

`persistDef`（及 `persistWorkflowDef`）只把定义写入内建表 `__schemaDef` / `__workflowDef`，**不注册**（注册是协议面注册表的事）。
闭环由 `META_RELOAD_HOOK` 指向网关 `POST /-/reload` 完成：网关须配置
`reload: { tenant, env }`，在重装配前调 `store.restoreDefs({tenant, env})`（按 kind 从
`__schemaDef` / `__workflowDef` 重建 schema 与 workflow 两类注册表；详见 `store-gateway/spec/00-protocol.md`）。

- 未配置 `META_RELOAD_HOOK`：publish 仍成功，但新定义对协议面不可见 → 告警留痕（不静默）。
- 版本并发：行自然键 `_id=(tenant,env,name,version)` 在存储层保证 version 唯一，
  同版本并发写后到者显式 `409 CONFLICT`。
- **回滚闭环（同一条桥）**：`rollbackTo` 为**追加式**——以历史行 `defn` 走 `persistDef` 语义落一条
  **新版本行**（同名同形幂等 → 返回当前最新行），历史行不改写（append-only）。`loadDefs` 取
  「各 name 最新 active」故必然返回该行，网关 `restoreDefs → loadDefs` hydrate 即按回滚后的
  `defn` 装配——**回滚经一次 reload 对协议面（网关进程）可见**。
