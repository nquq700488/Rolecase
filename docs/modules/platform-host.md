# Platform Host 模块

## 目标

隔离浏览器、Tauri 和未来其他桌面平台的差异。

## 对外提供的能力

```text
chooseDirectory()
openFile()
showNotification(input)
openExternalUrl(url)
revealInFileManager(path)
```

## 第一阶段 Web 实现

- File System Access API；
- 浏览器下载；
- Web Notification；
- 安全外链。

不保证所有浏览器都支持完整能力，必须提供降级提示。

## Tauri 实现

后续 Tauri 只负责：

- 启动本地 Server；
- 等待 `/healthz`；
- 打开 WebView；
- 注入 Local Token；
- 管理服务生命周期。

## 禁止

- PlatformHost 不参与 Role、Task 或 Run 决策；
- Domain 不依赖 PlatformHost；
- Web 业务模块不得直接导入 Tauri API；
- 不把桌面壳作为 Server 启动条件。

## 输入、输出和错误

输入是平台能力命令；输出是路径、通知结果或明确的 unsupported_platform 错误。

## 状态和不变量

PlatformHost 不保存业务状态；失败必须返回可展示的降级结果，不能阻塞核心 Session。

## 持久化

无。平台实现不能写入业务数据库。

## 事件

可发出 platform.ready、platform.capability_unavailable 等诊断事件，但不发布 Task/Run 事件。

## 安全边界

打开路径和外链前必须经过用户意图验证；Tauri 实现不能绕过 Server 权限。

## 替换和升级策略

Web 和 Tauri 实现必须遵守同一接口；新增能力先扩展接口再实现平台版本。

## 已知限制

浏览器不能可靠地提供所有文件系统和系统托盘能力，必须有降级 UI。

`openExternalUrl` 不等于认证回调或交互终端能力。产品不实现 OAuth、device-code 或 terminal 登录，因此 PlatformHost 不扩展认证回调或终端生命周期；认证只走 inherited 本地 CLI 或 isolated API key。

## 测试

为 Web 和 Tauri 分别提供实现测试，业务层使用 Fake PlatformHost。
