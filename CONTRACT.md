# 来源与消费契约

## 来源

入口 `/careers/jobs`，HTML 内的 source-record JSON 节点保留了门户输出字段；rel=next 链接表示下一页。`fixtures/source.json` 的 opening 与 updated 是两个可切换的来源观察，不代表业务库必须得出某个预设结论；可添加新的来源观察验证行为。

jobId 在 employer 内稳定，cycle 表示一次开放周期。state 为来源明确 open/closed，页面缺席只证明没有观测。/careers/coverage 表示当前抓取是否完整；维护时可返回 503。重新开放可复用 jobId 但有新 cycle；推荐列表与触达记录不能把它当成任意新职位。

## 业务消费

`readOperations(repository)` 当前返回 product 和 rows，每行带 sourceId/source/observedAt/attributes。现有 CLI 和结构化导入用于本地运维；新增采集结果也需要让业务读取入口看到一致状态，必要的解释信息可扩展返回。原始来源身份与 observedAt 不是通用的业务版本、完整性或成功证明。来源接口契约是兼容边界，采集、状态管理和新业务表达由实现决定。
