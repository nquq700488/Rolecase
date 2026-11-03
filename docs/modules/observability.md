# Observability 模块

## 目标

提供结构化日志、运行诊断、性能信息和密钥脱敏。

## 对外提供的能力

```text
log(level, event, fields)
startSpan(name)
recordMetric(name, value)
createDiagnosticBundle(scope)
```

## 必须记录

- Workspace、Session、Run、Task、Slot ID；
- Adapter 启停和版本；
- 请求 ID；
- 状态转换；
- 失败类别和耗时；
- 重试次数。

## 禁止记录

- API Key；
- OAuth Token；
- Authorization Header；
- 完整私有对话，除非用户明确导出。

## 依赖

允许依赖：标准日志库、Event、ClockPort、SecretRedactionPort、文件导出 Port。

禁止依赖：Vue、具体 ACP 包、业务状态修改、Credential 原文。

## 输入、输出和错误

输入是结构化日志、Span、Metric 和诊断范围；输出是脱敏日志或诊断包；记录失败不能影响核心业务。

## 状态和不变量

日志字段必须可序列化；同一 request/run 使用稳定关联 ID；敏感字段经过 SecretRedactionPort。

## 持久化

日志和诊断包写入独立目录，不进入 Domain 数据库；保留周期由配置决定。

## 事件

消费状态事件用于记录，不修改业务状态；诊断包记录事件引用而不是复制全部私有内容。

## 安全边界

API Key、Token、Authorization 和私有对话必须脱敏；诊断包导出需要用户明确操作。

## 替换和升级策略

日志后端可替换，只需保持字段、级别、脱敏和关联 ID 语义。

## 已知限制

第一阶段只提供本地日志和诊断，不提供远程集中式观测。

## 测试

测试脱敏、结构化字段、日志级别、诊断包权限和异常路径不泄露敏感信息。
