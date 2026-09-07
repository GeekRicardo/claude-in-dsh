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
- **订阅用量**：官方订阅时输入框下方显示 5h/7d 用量与刷新倒计时（同 id 覆盖 dsh-balance 的座位，切回 DSH 自动还原）。读数缓存在内存 + localStorage，**切对话、刷页面先渲染缓存再后台校准**，请求失败也保留上一次读数（此时降透明并注明「正在刷新」）；缓存超过 6 小时不再拿来播种，窗口一过重置时刻就强制重取——过期的百分比不是旧数，是错数。用量 endpoint 被限流（429）时算取数失败而不是「这个账号没有窗口」，并退避 5 分钟。同一份用量模型也读得到，见 [`claude_usage`](#多-agent)。
- **撞上用量上限自动等待续跑**：一轮活干到一半用完订阅额度时，这一轮不结束——转录里挂一条「⏳ 已达用量上限 · 将在 HH:MM 自动继续」，输入框下方走秒级倒计时，窗口重置（或额度提前回来）后把 Claude 自己那句续跑提示发进同一个进程接着干。判定看账号真实的用量窗口而不是错误文案；等待期间插话不取消等待，那句话攒到恢复时一起发出；按停止即取消；重置超过 24 小时就不等。这是 Claude Code 的 `autoContinueAtUsageLimit`，它只在终端 TUI 里生效，这里把同一行为补到 dsh 上。
- **导入对话**：工作区 ⋯ 菜单 →「导入 Claude Code 对话」，列出该目录下的本机 Claude 会话，预览（dsh 原生工具卡片样式）后一键接着聊。
- **插话与排队**：跑轮次时 Ctrl/Cmd+Enter 插话直接折进 Claude 当前轮；普通 Enter 沿用 dsh 排队语义。
- **粘贴图片**：Claude 会话里粘贴的图片存成 dsh 原生附件（转录里直接显示），并以 stream-json image block 随下一条消息送给 Claude —— 不再被「当前模型不支持图片」挡下。
- **断档补播**：dsh 自己重启期间 Claude 完成的输出，会在下次打开或下一轮开始前补播进转录（不调用模型）。
- **多 agent**：一个对话可以像人一样新开另一个对话（dsh 引擎或 Claude 引擎）、给它发消息、读它的输出、答它的权限请求、改它的模型与权限档、打断它。见下。

## 多 agent

任何 Claude 会话都会拿到一组工具（dsh 会话在同一份工具表里）：`agent_*` 用来开一个新的对话并一直驱动它，`claude_usage` 用来看自己还剩多少额度。

| 工具 | 作用 |
| --- | --- |
| `agent_open` | 新开一个对话：选引擎（`claude` / `dsh`）、工作目录、模型、effort、权限档、**谁来答它的权限请求**、要不要在它完成时**回来叫醒你**；可以顺带带上第一句话 |
| `agent_send` | 像人在它的输入框里打字：普通消息、`steer` 折进正在跑的那一轮，或（dsh 子对话里）一条斜杠命令 |
| `agent_read` | 增量读它的转录：消息、工具调用与结果、回合边界，以及它是否正等着你答话 |
| `agent_approve` | 答它的权限请求——它此刻真的阻塞在那次工具调用里 |
| `agent_config` | 运行中改它的模型 / effort / 权限档 / 审批去向 / 通知开关 |
| `agent_stop` | `cancel` 打断这一轮（和人按停止一样），`close` 连引擎进程一起停掉并不再托管 |
| `agent_list` | 你开过的子对话、各自跑没跑、有哪些请求等着你 |
| `claude_usage` | 不驱动子对话，而是**自省**：本机 Claude 订阅每个窗口（5h / 7d / 7d Opus / 7d Sonnet）用了多少、还剩多少、还有多久重置。人在输入框下方看到的那份数字，模型也读得到，好在动手前决定是拆任务、派子对话，还是先等窗口。默认走 60 秒缓存，`refresh: true` 才重取 |

**不需要轮询**：子对话跑完一轮、或者卡在一个等你回答的审批上时，它会给你所在的这个对话投一条消息并唤醒你——所以「先扔给它，我等它」是一种可行的姿势。通知走 `steer` 而不是排队，所以**你正在跑着一轮时也会当场收到**（Claude 会话是直接折进当前轮），而不是等你这轮干完才看见。同时开出去的几个子对话同时完成时通知会合并成一次；你所在的对话已经被 dsh 卸载时不会硬把它唤起来（通知攒着，随你下次调 `agent_*` 的返回一起给你）。按会话可用 `notify: 'off'` 关掉。

子对话就是**普通对话**：出现在侧边栏、走原生渲染、正常持久化，人随时可以点进去接管；插件不再托管它，它也还在。

审批接的是 dsh 自己的 `approval/request`，不是绕过它：插件只认领自己托管的子会话的请求交给父会话，其余原样落到人手上的审批卡片，子会话日志里照样有 `approval/asked` / `approval/decided` 审计事件。每个子会话可以单独选 `parent`（默认，父会话答）/ `human`（问人）/ `allow` / `deny`（常备答案）。

> Claude 子对话只有在权限档为 **manual** 时才会问 dsh；其余档位是「明确的常备答案」，插件不会替你把它们变成提问。若你配置了 Claude 自己的 `PermissionRequest` hook，它先生效——和单开一个 Claude 会话时一样。

整套能力可以用环境变量 `CLAUDE_IN_DSH_MULTIAGENT=off` 关掉（dsh 会话里不注册工具，Claude 会话也不接 MCP）——`claude_usage` 与这些工具同属一张表，关掉时它也一起没有，输入框下方给人看的读数不受影响。

Claude 会话怎么看到这些工具：启动时多带一个 `--mcp-config`，指向 dsh web 端口上一条**按会话寻址**的 MCP 端点（回环 + Bearer + 拒绝跨站）。父会话身份因此是进程的事实，模型无法声称成别人。你自己配的 MCP server 不受影响（加载而非替换）。

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
  multiagent.dynamic.js  多 agent 半：子对话的开/驱动/读/审批/配置，dsh 工具 + MCP 端点
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
- 子对话注册表与多 agent MCP token：`~/.cache/ccmode/multiagent.json`
- RPC：同源 `POST /claude-in-dsh/rpc`（仅回环 + 同源，供本插件 client 半使用）
- 多 agent MCP：`POST /claude-in-dsh/agents/mcp/<sessionId>`（仅回环 + Bearer，供本插件启动的 Claude 进程使用）

## License

MIT
