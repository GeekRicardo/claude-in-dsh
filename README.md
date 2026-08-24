# claude-in-dsh

把 **DeepSeek Harness (dsh web)** 的一个会话交给**本机 Claude Code CLI** 驱动。所有 agent 工作都发生在本机 `claude` 里；dsh web 只负责接收流并用它**原生的**会话渲染展示 —— 转录、工具卡片、审批、命令面板，没有任何自绘的对话 UI。

## 功能

- **引擎选择器**：输入框里一个和模型选择器同款的下拉（`DSH | Claude Code`），按会话切换。dsh 会话与 Claude 会话严格互斥 —— 一个会话跑过谁，就永远属于谁（从会话日志推断，重启不丢）。
- **原生渲染**：Claude 的流被写成 dsh 自己的持久会话事件（`assistant/chunk`、`assistant/message`、`tool/call`、`tool/result`…），所以持久化、投影、主题、其他插件（如 dsh-better-tool-ui 的工具行）全部照常工作。子 agent（Agent 工具）渲染为嵌套子调用。
- **权限档替换**：切到 Claude 后，dsh 的访问模式选择器被 Claude 的权限档（manual / acceptEdits / auto / bypassPermissions / plan）替换；权限请求（`can_use_tool`）桥接到 dsh 原生审批 UI（若你配置了 Claude 的 PermissionRequest hook，则完全遵循你的 hook）。
- **提问桥接**：Claude 的 `AskUserQuestion` 不当权限问题处理，而是交给 dsh 的提问服务——你看到的是 dsh 自己那张提问卡片（选项 / 多选 / "其他"自由文本），答案原样回到 Claude。提问一律问人，不受权限档影响。
- **计划审核桥接**：Claude 的 `ExitPlanMode` 用 dsh 自己的计划审核卡片审（和 dsh 的 `exit_plan_mode` 同一套 id/标签/intent）；批准即退出计划模式并把权限档落回监督档，选择继续规划则把你的反馈原样送回模型。
- **模型 / effort**：模型座换成 Claude 的模型清单 + reasoning effort；运行中切模型走 `set_model` 控制请求（不重启进程），重连后自动补发。
- **命令面板**：Claude 的斜杠命令并入 dsh 面板（只在 Claude 会话出现）；与 dsh 撞名的保留前缀加 `-claude` 后缀并标注归属。`/mcp` `/context` `/usage` 这类**一次性命令**带外执行 —— 不起轮次、不进转录，结果开在独立面板里（`/mcp` 按 TUI 样式画出服务器分组列表）。
- **进程与会话托管**：Claude 进程由独立 broker（`setsid`）持有 —— 插件热更新、dsh 重启都不会中断正在跑的轮次，重连后从字节偏移续读流。会话记录写进 `~/.claude`，终端里 `claude --resume` 能看到、也能继续。
- **只有真人发言才唤醒 Claude**：dsh 插件系统注入的通知消息（Cordis 运行器等）不会替你烧一轮订阅额度，内容攒到你下次发言时一并带上。
- **订阅用量**：官方订阅时输入框下方显示 5h/7d 用量与刷新倒计时（同 id 覆盖 dsh-balance 的座位，切回 DSH 自动还原）。
- **导入对话**：工作区 ⋯ 菜单 →「导入 Claude Code 对话」，列出该目录下的本机 Claude 会话，预览（dsh 原生工具卡片样式）后一键接着聊。
- **插话与排队**：跑轮次时 Ctrl/Cmd+Enter 插话直接折进 Claude 当前轮；普通 Enter 沿用 dsh 排队语义。
- **粘贴图片**：Claude 会话里粘贴的图片存成 dsh 原生附件（转录里直接显示），并以 stream-json image block 随下一条消息送给 Claude —— 不再被「当前模型不支持图片」挡下。
- **断档补播**：dsh 自己重启期间 Claude 完成的输出，会在下次打开或下一轮开始前补播进转录（不调用模型）。

## 前置

- Node.js ≥ 20、pnpm、已启动过一次的 dsh web（存在 `~/.dsh/profiles/web`）
- 本机已安装并登录 [Claude Code](https://code.claude.com) CLI（2.1.x）

## 安装

```bash
curl -fsSL https://raw.githubusercontent.com/GeekRicardo/claude-in-dsh/main/install.sh | bash
```

本地开发（用工作区目录而不是 GitHub 快照）：

```bash
bash install.sh --link /path/to/claude-in-dsh --restart
```

装完重启 dsh web（pm2：`pm2 restart dsh-web`）并硬刷新页面。

## 维护

改代码只改 `src/`，然后 `pnpm build`（或 `pnpm test`，会先 build 再跑 bundle 冒烟测试）。

重启 dsh 用 `bash scripts/safe-restart.sh`：它先确认没有进行中的 Claude 轮次再重启。直接 `pm2 restart` 会打断正在跑的轮次，在那个对话里留下 `TOOL_OUTCOME_UNKNOWN` 红卡（内容随后会被补播，但轮次已断）。

## 结构

```
src/                开发与测试所用的动态包源码（dsh-cordis-mcp 沙盒形态）
  host.dynamic.js   宿主半：pre-step 接管、转录投影、broker 运行层、审批桥、RPC
  client.dynamic.js 客户端半：composer 座位、工具行、命令、面板（全部复用 dsh 类名）
  broker.mjs        进程 broker（宿主运行时会把同一份源码写到 /tmp/ccmode）
  client-rig.mjs    离线渲染台架
scripts/build.mjs   从 src 生成 lib（正式 bundle 容器包装，引擎体逐字节一致）
scripts/safe-restart.sh  确认没有进行中的轮次后再重启 dsh-web
lib/                生成产物：index.js（host, ESM）、client.js（ModuleLoader bundle）
```

## 运行时落点

- broker 与进程：`/tmp/ccmode/<sessionId>/`（fifo `in`、追加日志 `out.log`、`meta.json`）
- 每会话持久设置（权限档/模型/effort/Claude 会话 id）：`~/.cache/ccmode/state.json`
- RPC：同源 `POST /claude-in-dsh/rpc`（仅回环 + 同源，供本插件 client 半使用）

## License

MIT
