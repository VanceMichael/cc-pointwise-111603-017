# 来源与消费契约

## 来源

入口 `/careers/jobs`，HTML 内的 source-record JSON 节点保留了门户输出字段；rel=next 链接表示下一页。`fixtures/source.json` 的 opening 与 updated 是两个可切换的来源观察，不代表业务库必须得出某个预设结论；可添加新的来源观察验证行为。

jobId 在 employer 内稳定，cycle 表示一次开放周期。state 为来源明确 open/closed，页面缺席只证明没有观测。/careers/coverage 表示当前抓取是否完整；维护时可返回 503。重新开放可复用 jobId 但有新 cycle；推荐列表与触达记录不能把它当成任意新职位。

## 业务消费

`readOperations(repository)` 当前返回 product 和 rows，每行带 sourceId/source/observedAt/attributes。现有 CLI 和结构化导入用于本地运维；新增采集结果也需要让业务读取入口看到一致状态，必要的解释信息可扩展返回。原始来源身份与 observedAt 不是通用的业务版本、完整性或成功证明。来源接口契约是兼容边界，采集、状态管理和新业务表达由实现决定。

## 采集与状态同步（实现约定）

采集一次读取入口页与全部 rel=next 页，并读取 `/careers/coverage`。只有当所有页面都成功读取、没有未处理的 next、且来源明确回答 `complete: true` 时，本次采集才算**完整**。页面失败、翻页循环、覆盖端点失败或回答不完整，都使采集不完整。

岗位身份是 employer + jobId，cycle 是一次开放周期。状态分开保存：

- `open`：来源明确说明开放，且在有效期内 → 可投递。
- `closed`：来源明确撤回 → 不可投递，且**不会**因为后续页面缺席或覆盖不完整被改写。
- `unobserved`：完整采集中未出现 → 暂未观察到，不等于撤回，不提供投递，但仍保留岗位与历史。

只有完整采集才可以标记 `unobserved`；不完整采集保留每个岗位原有的明确状态。比较新旧一律使用来源的 `modifiedAt`/观察时间：旧页面重放不能推翻更新的明确关闭，时间相同的明确关闭优先于开放。`observedAt` 表示最近一次来源观察；`statusObservedAt` 是当前 open/closed 证据的来源时间；`lastConfirmedAt` 是本地最近一次接受该明确状态的时间；`lastCheckedAt` 是最近一次完整扫描到该岗位的时间。

重新开放复用同一 jobId（因此不会给老候选人新建重复职位），新 cycle 作为新的开放周期追加到岗位历史中；旧 cycle 的关闭记录保留。

查询入口只返回当前可投递岗位（`rows`），并把已关闭、暂未观察到、已过有效期和覆盖不足的岗位放在 `excluded` 中并给出原因（`source-closed` / `not-observed` / `expired`），同时返回来源同步信息 `source.lastAttemptAt`、`source.lastCompletedAt`、`source.lastCoverage`、`source.lastError`。
