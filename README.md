# 岗位信息目录

Node.js 本地数据接入项目。来源服务和业务存储独立；`sync` 从岗位网页读取全部页面与覆盖证据，维护可投递岗位列表及其开放状态，`ingest`/`query` 保留原有结构化导入与本地运维能力。

## 运行

需要 Node.js 22，无第三方包、远程服务或账户凭据。`npm test` 运行现有行为与本地接口测试；`npm run demo` 启动临时来源、依次读取开放与关闭两个来源观察并展示业务查询，结束时自动关闭监听并清理临时数据，通常两秒内完成。`npm start -- sync <来源URL>` 读取来源并同步；`npm start -- ingest` 从 `fixtures/records.json` 导入；`npm start -- query` 只列出当前有依据可投递的岗位，`query --all` 可查看不可投递岗位；`npm start -- history [jobId]` 查看岗位身份与各开放周期；`npm start -- explain` 给出每个岗位不可投递的原因。演示数据不访问生产站点。

## 组件和数据

`source/server.js` 读取 `fixtures/source.json` 并监听随机回环端口。`startSource()` 返回 url、publish(stage)、failNext(path,status) 和 close()；publish 切换可观察来源版本而不修改业务仓库，failNext 可返回 503 或使用 disconnect 断开连接。它记录请求路径并支持来源 ETag/304。`src/source-client.js` 只接受同一回环来源；`src/adapter.js` 解析 source-record 页面并保留原始来源属性；`src/sync.js` 读取全部 rel=next 页面与 `/careers/coverage`，只有全部页面成功且来源确认覆盖完整时才算完整采集。`src/catalog.js` 维护 employer+jobId 的岗位身份、open/closed/unobserved 状态、开放周期历史与可投递判定；`src/service.js` 与 `src/repository.js` 原子保存集合与目录；`src/operations.js` 是读取该集合的业务消费入口。来源协议与状态语义见 [CONTRACT.md](CONTRACT.md)。

状态目录 `var/` 属于运行产物。`sync` 在同一状态文件中保存岗位目录与最近来源同步信息；旧版仅有 records 的状态可继续读取。测试可直接使用随机端口来源，不需要等待真实时间或接入外网。`npm run acceptance` 在临时目录中验证完整采集、重放、明确关闭、旧页面重放、重新开放与业务查询，完成后清理临时状态。
