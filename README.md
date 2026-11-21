# my-dsh-message-search

[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com) [![开放插件市场](https://img.shields.io/endpoint?url=https%3A%2F%2Fdshopen.org%2Fbadge%2Fmy-dsh-message-search.json)](https://dshopen.org/zh/plugins/my-dsh-message-search/)

全屏消息检索面板，`Ctrl+F` 打开：按「当前会话 / 工作区 / 全部会话」检索消息正文，
命中按时间倒序列出（会话标题、工作区、角色、时间、高亮片段），`Enter` 打开所在会话。

## 安装

任选一种。`--profile` 后面换成你自己在用的 profile：桌面版通常是 `desktop`，`dsh web` 通常是 `web`。

```powershell
# 从 npm 安装（预构建，最快）
dsh plugin --profile web add my-dsh-message-search

# 从 GitHub 源码安装
dsh plugin --profile web add github:myhylijp/my-dsh-message-search
```

也可以在插件市场里直接搜索安装：dsh-market 和 [开放插件市场](https://dshopen.org/zh/plugins/my-dsh-message-search/) 都已收录。装完后如果「插件」页里没有出现，重启一次 `dsh web`。

## 为什么不用 sessionQuery

DSH 自带的内容检索基于 `session-query-sqlite` 索引。它建索引时会把历史会话日志迁移到 v4，
遇到「`step/end` 带未闭合工具调用」的旧日志会整体失败：

```
SessionQueryError: session-search persistence observation failed:
Session migration from v0 to v4 refuses the transformed artifact:
step/end leaves unresolved tool call call_00_...
```

一条坏日志就让整次检索报错。本插件改成 **Host 自己扫日志**：

- 读 `<dshHome>/sessions/<工作区分组>/<session-*>/session.*.jsonl.zstd`；
- DSH 按追加帧写 zstd，所以按帧魔数切片逐帧解压，再逐行解析 JSONL；
- 只索引 `user/message` 与 `assistant/message` 的 `text` 部分（忽略 reasoning 与 tool-call）；
- 单个会话解析失败 → 跳过并计数（页脚显示"跳过 N 个"），**不会让检索失败**；
- 解析结果按 (mtime, size) 缓存，重复检索不重读磁盘。

## 范围与数据

| 范围 | 依据 |
|---|---|
| 当前会话 | 由 `conversation.input.dock` 的探针发布当前 session id |
| 工作区 | `storages/workspace.json` 里该工作区的 `sessionIds` |
| 全部会话 | 磁盘上所有会话目录 |

命中里的标题取 `session/title` 事件（没有就退回首条用户消息），工作区名取 `workspace.json`。

## 页面

- 顶部：标题 + 用时；搜索框 + 范围分段控件 + 工作区菜单，三者同一行、同一个框线内。
- **边输边搜**：输入停顿 250ms 自动检索，不用回车；切范围、切工作区同样立即重搜。
  回车的作用变成"打开当前选中的一条"（结果还没出来时会立刻搜一次）。
- 列表：角色徽标（我 / 助手）、会话标题、工作区、时间、单条多处命中计数、两行片段 + 关键词高亮。
- 页脚：键盘提示 + 本次范围（会话数 / 消息数 / 跳过数）。
- `↑↓` 选择、`Enter` 打开、`Esc` 关闭、点击遮罩关闭。
- 点击结果会打开所在会话并**滚动定位到该段落**（文本归一化比对 + 高亮 2.6s；目标未加载时先顶上触发「加载更早」再重试）。

## 配置

```yaml
- id: message-search
  name: 'my-dsh-message-search'
  config:
    maxHits: 200      # 一次检索最多返回多少条命中
```

## 边界

- 只检索消息正文，不搜工具调用参数与工具输出；需要更细的检索维度再加字段。
- 全部会话范围会解压所有日志（当前约十几 MB，可接受）；会话量很大时应改为增量索引文件。
- Host 侧代码不热替换：升级 `host.js` 后需要重启应用。


## 在资源管理器中定位文件

「打开文件夹」按钮由 Host 的 `attachment-open` 处理：

- **不经 `cmd /c`**（路径里的 `&`、`|`、`^`、`%` 会被 cmd 二次解析），直接
  `spawn('explorer.exe', ['/select,', path])`，路径按参数传递；
- 路径中含逗号时（explorer 的 `/select,` 会误切分）退化为「打开所在目录」，返回值里 `select: false`；
- 非 Windows 平台直接报错（不静默失败）；
- explorer 成功时也可能返回退出码 1，因此不按退出码判定成败。
