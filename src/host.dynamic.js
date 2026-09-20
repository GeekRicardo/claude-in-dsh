// cc-mode Host half (v46) — the local Claude Code CLI drives a dsh turn, and
// every last bit of it lands in dsh's OWN durable vocabulary so the native UI
// renders it: streamed chunks, assistant messages, tool calls and results,
// subagent activity as nested sub-calls, and permission questions through
// dsh's own approval service.
//
// Seam: `agent/pre-step`, the waterfall the loop runs before each model step.
// For a session switched to the Claude engine this listener owns the whole
// turn and then returns `{kind:'reject'}`, which every other pre-step listener
// passes through untouched — the loop closes the turn as 'blocked' without ever
// building a model request.
//
// Transport, flags and control requests were taken from waku's Rust driver
// (src/driver/claude.rs), which reads them off the real CLI:
//   spawn   claude -p --input-format stream-json --output-format stream-json
//           --verbose --include-partial-messages --thinking-display summarized
//           --replay-user-messages --permission-prompt-tool stdio
//           --permission-mode M [--model M] [--effort E] (--session-id|--resume) uuid
//   stdin   user messages (prompt AND mid-turn steering), control_response
//           (permission answers), control_request: interrupt / set_model / stop_task
//   stdout  system(init|task_*|background_tasks_changed) / stream_event /
//           assistant / user / result / control_request(can_use_tool)

return {
  inject: ['timer'],
  apply(ctx) {
    const subprocess = ctx.get('subprocess')
    if (subprocess === undefined) {
      console.error('cc-mode: subprocess service unavailable — host half idle')
      return
    }
    // Optional: when present, Claude's permission questions render in dsh's own
    // approval UI instead of being auto-answered.
    let approval = ctx.get('approval')
    // Optional: when present, Claude's AskUserQuestion is answered through dsh's
    // own question card — same surface, same answer encoding as `ask_user_question`.
    let userQuestions = ctx.get('userQuestions')
    // Image attachments: pasted images become the same durable attachment
    // blocks dsh's own composer produces, so the transcript renders them
    // natively; the raw bytes ride to Claude as stream-json image blocks.
    let attachments = ctx.get('attachments')
    // Used only to reach a live session outside a turn (header repair).
    let agents = ctx.get('agents')
    // Claude names the conversation itself once a round lands. dsh's own title
    // provider seat is single-occupancy and already taken by
    // dsh-session-title-llm, so this cannot register as a provider — it hands
    // the finished name to the same service instead.
    let sessionTitle = ctx.get('sessionTitle')
    // Background work is mirrored into dsh's native surfaces: every Claude task
    // becomes a `ctx.jobs` row (the 后台任务 section), and every Agent/Task tool
    // call becomes a real subagent child session under this conversation (the
    // subagent cards). Both services are optional — a deployment without them
    // simply does not surface background work; the conversation carries none.
    let jobs = ctx.get('jobs')
    let sessionsStore = ctx.get('sessions')

    // These live in other packages and apply-order is not guaranteed: a
    // one-shot ctx.get left the approval/question bridges silently off
    // whenever this plugin loaded first, which read as "AskUserQuestion is a
    // permission card again". Re-resolve for a short while after start.
    let serviceRebinds = 0
    function rebindServices() {
      if (approval === undefined) approval = ctx.get('approval')
      if (userQuestions === undefined) userQuestions = ctx.get('userQuestions')
      if (attachments === undefined) attachments = ctx.get('attachments')
      if (agents === undefined) agents = ctx.get('agents')
      if (sessionTitle === undefined) sessionTitle = ctx.get('sessionTitle')
      if (jobs === undefined) jobs = ctx.get('jobs')
      if (sessionsStore === undefined) sessionsStore = ctx.get('sessions')
      const missing = [
        approval === undefined ? 'approval' : '',
        userQuestions === undefined ? 'userQuestions' : '',
        attachments === undefined ? 'attachments' : '',
        agents === undefined ? 'agents' : '',
        sessionTitle === undefined ? 'sessionTitle' : '',
        jobs === undefined ? 'jobs' : '',
        sessionsStore === undefined ? 'sessions' : '',
      ].filter((name) => name.length > 0)
      if (missing.length === 0) {
        if (serviceRebinds > 0) console.log('cc-mode: late-bound optional services after', serviceRebinds, 'retry/-ies')
        return
      }
      serviceRebinds += 1
      if (serviceRebinds <= 10) armTimeout(rebindServices, 2000)
      else console.log('cc-mode: optional services absent in this deployment:', missing.join(', '))
    }

    const PROVIDER = 'claude-code'
    // Messages this plugin writes itself (failure notices) carry this model id.
    // They are not product output, so they must not commit a session to the
    // Claude engine — a failed first attempt has to stay switchable.
    const NOTICE_MODEL = 'cc-mode/notice'

    // dsh's model-visible surface. `Session.append` REQUIRES a `surfaceOp`
    // marker on exactly these three types and REJECTS one on any other — an
    // event appended with the wrong side of that rule throws and never lands.
    const SURFACE_EVENT_TYPES = new Set(['user/message', 'assistant/message', 'tool/result'])

    // Claude Code exposes no model-inventory command, so the catalog is
    // maintained here the same way waku maintains its own (model_catalog.rs).
    //
    // No "follow Claude's own setting" row: the seat names the model a
    // conversation runs, and on a new one that row made it read "Claude 默认" —
    // true but useless, since which model it then meant depended on the CLI's
    // own config. A new conversation starts on DEFAULT_MODEL and says so.
    // A conversation SAVED under the old empty choice keeps it (see
    // loadPersistedStates): its process is already running on Claude's own
    // default, and quietly re-pointing an ongoing conversation at another
    // model is not a display change.
    const MODELS = [
      { id: 'claude-fable-5', name: 'Claude Fable 5', reasoning: true },
      { id: 'claude-opus-5', name: 'Claude Opus 5', reasoning: true },
      { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', reasoning: true },
      { id: 'claude-opus-4-5', name: 'Claude Opus 4.5', reasoning: true },
      { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', reasoning: true },
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', reasoning: true },
      { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', reasoning: false },
    ]
    /** What a brand-new Claude conversation runs, absent any choice. */
    const DEFAULT_MODEL = 'claude-opus-5'

    // How much context each model actually has. Claude Code advertises the 1M
    // window as a model suffix (`claude-opus-5[1m]`), which is why the route
    // string, not the chosen id, decides.
    const DEFAULT_CONTEXT_WINDOW = 200000

    /**
     * Tell dsh how big this conversation's context window is.
     *
     * dsh already ships a context meter — the ring beside the send button, with
     * the breakdown popover — and it already has the numerator: its
     * `contextPressure` projection reads the `usage` this plugin puts on every
     * `assistant/message`. The only thing missing was the denominator, which
     * comes from a `request/context` event that a Claude conversation never
     * produces (it makes no dsh model request). One event and dsh's own meter
     * lights up, so there is no reason for the plugin to draw a second ring.
     */
    function announceContextWindow(sessionId, session) {
      if (session === undefined) return
      const state = stateOf(sessionId)
      const route = String(state.route || state.model || '')
      if (route.length === 0) return
      const measured = state.contextWindowKey === contextWindowKeyOf(state) ? Number(state.contextWindow) : 0
      const contextWindow = measured > 0 ? measured : contextWindowOf(state.route)
      let known
      try { known = typeof session.requestContext === 'function' ? session.requestContext() : undefined } catch (error) { known = undefined }
      if (known !== undefined && known.model === route && known.contextWindow === contextWindow) return
      try {
        session.append('request/context', { provider: PROVIDER, model: route, contextWindow: contextWindow })
        console.log('cc-mode: context window published —', route, contextWindow)
      } catch (error) {
        console.error('cc-mode: could not publish the context window:', errorText(error))
      }
    }

    /**
     * Recover the running model's route from the broker's own log.
     *
     * The route (`claude-opus-5[1m]`) only ever arrives in the `system/init`
     * handshake, and re-attaching to a broker's live process replays nothing
     * before the read offset — so a conversation that survives a dsh restart
     * would otherwise lose it. That matters because the `[1m]` suffix is the
     * only thing distinguishing a 200k window from a 1M one, and the user's
     * chosen model id (`claude-opus-5`) never carries it: guessing from that
     * reported this conversation as 100% full at 243k when it was at 24%.
     */
    async function recoverRoute(run, state) {
      if (typeof state.route === 'string' && /\[/.test(state.route)) return
      try {
        const line = await captureOn(
          'grep -a \'"subtype":"init"\' ' + shellQuote(run.dir + '/out.log') + ' | tail -1 | head -c 4000', run.remote, 8000)
        const init = JSON.parse(String(line || '').trim())
        if (typeof init.model === 'string' && init.model.length > 0 && state.route !== init.model) {
          state.route = init.model
          persistStates()
        }
      } catch (error) { /* no handshake in the log; the next turn's init will bring it */ }
    }

    function contextWindowOf(model) {
      const name = String(model || '')
      if (/\[1m\]/i.test(name) || /-1m\b/i.test(name)) return 1000000
      return DEFAULT_CONTEXT_WINDOW
    }

    /**
     * How big this process's context window really is, asked of the CLI.
     *
     * The model string cannot answer it. Claude Code's handshake echoes the id
     * it was *given*: launched with `--model claude-opus-5` it reports exactly
     * that, while the same install left on its default reports
     * `claude-opus-5[1m]` — same process, same 1M window, two different strings.
     * Guessing from the string is what reported this conversation as 100% full
     * at 243k tokens when it was at 24%. `/context` states the denominator
     * outright ("Tokens: 19.8k / 1m"), costs no model call, and the answer is
     * cached per model choice.
     */
    const windowProbes = new Set()
    // Model choices whose `/context` answer could not be parsed: asking again
    // every turn would cost a round trip per turn for no new information.
    const windowProbeFailures = new Set()

    function parseContextWindow(text) {
      const match = String(text || '').match(/\/\s*([\d.]+)\s*([kmKM])\b/)
      if (match === null) return 0
      const value = parseFloat(match[1])
      if (!isFinite(value) || value <= 0) return 0
      return Math.round(value * (match[2].toLowerCase() === 'k' ? 1000 : 1000000))
    }

    /** "4.1k" / "167.4K" / "912" -> tokens. 0 when it is not a figure. */
    function tokensOf(text) {
      const match = String(text || '').trim().match(/^([\d.,]+)\s*([kmKM])?$/)
      if (match === null) return 0
      const value = parseFloat(match[1].replace(/,/g, ''))
      if (!isFinite(value) || value < 0) return 0
      const unit = (match[2] || '').toLowerCase()
      return Math.round(value * (unit === 'k' ? 1000 : unit === 'm' ? 1000000 : 1))
    }

    /**
     * The three figures dsh's context panel shows, taken from Claude's own
     * `/context` instead of guessed.
     *
     * dsh computes that panel from its own session log: the system-prompt and
     * tool rows come from a `request/header` event, which a Claude conversation
     * never writes (that event IS the session's model dispatch — writing one
     * bricks the composer), and the conversation row prices dsh's surface,
     * which is not what Claude actually carries (no memory files, no skills, no
     * MCP schemas, summarized thinking instead of the real blocks). So the
     * panel read "系统提示词 ~0 / 工具 ~0 / 对话消息 ~71.5K" under a ring that
     * correctly said 192K — three rows that cannot add up to their own total.
     *
     * `/context` states all of it outright, per category, for no model call.
     * Claude's categories fold onto dsh's three rows the way Claude itself
     * builds a request: memory files and skills ARE part of the system prompt
     * block, MCP schemas are tools, everything else is the conversation.
     */
    function parseContextReport(text) {
      const rows = []
      // Only the composition table. The full report carries more of them —
      // "MCP Tools" (tool | server | tokens), "Memory Files" (type | path |
      // tokens), "Skills" (skill | source | tokens) — whose second column is
      // not a figure, so scanning the whole answer happens to skip them today
      // and would silently start double-counting the day a column moves. The
      // section ends at the next heading.
      let inTable = false
      for (const line of String(text || '').split('\n')) {
        if (/^\s*#{1,6}\s/.test(line)) {
          inTable = /usage by category/i.test(line)
          continue
        }
        if (!inTable) continue
        // The markdown table `/context` prints: | Category | Tokens | % |
        const cells = line.match(/^\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/)
        if (cells === null) continue
        const label = cells[1].trim()
        if (label.length === 0 || /^-+$/.test(label) || /^category$/i.test(label)) continue
        const tokens = tokensOf(cells[2])
        if (tokens <= 0) continue
        rows.push({ label: label, tokens: tokens })
      }
      if (rows.length === 0) return undefined
      let system = 0
      let tools = 0
      let messages = 0
      let free = 0
      for (const row of rows) {
        const label = row.label.toLowerCase()
        if (label.indexOf('free space') !== -1) { free += row.tokens; continue }
        // A deferred row prices tools whose schemas are NOT loaded (they cost
        // nothing until something fetches them), so it is not part of what the
        // window holds. The report's own arithmetic says so: on this machine
        // 4.1k+15.2k+4k+1.9k+167.4k = 192.6k = 1M − the 807.5k it calls free,
        // with both deferred rows (24.4k) outside that sum.
        if (label.indexOf('deferred') !== -1) continue
        if (label.indexOf('tool') !== -1) { tools += row.tokens; continue }
        if (label.indexOf('message') !== -1) { messages += row.tokens; continue }
        // System prompt, memory files, skills, agents — everything Claude
        // injects ahead of the conversation.
        system += row.tokens
      }
      if (system + tools + messages <= 0) return undefined
      return { system: system, tools: tools, messages: messages, free: free, at: Date.now() }
    }

    function contextWindowKeyOf(state) {
      return String(state.route || '') + '|' + String(state.model || '')
    }

    // The last `/context` composition per session, for the panel. Not
    // persisted: it goes stale with every turn, and re-asking costs one round
    // trip to a process that is already running.
    const contextReports = new Map()

    /**
     * Ask the live process for its context report.
     *
     * One probe serves both readers: the window (the panel's denominator,
     * cached per model choice because it cannot change without one) and the
     * composition (which changes every turn, so it is kept fresh instead).
     * @param force - ask even when the window is already known, because the
     *   composition may have moved.
     */
    async function probeContextWindow(sessionId, cwd, force) {
      const state = stateOf(sessionId)
      const key = contextWindowKeyOf(state)
      const windowKnown = state.contextWindowKey === key && Number(state.contextWindow) > 0
      if (windowKnown && force !== true) return
      if (windowProbes.has(sessionId) || activeTurns.has(sessionId)) return
      if (windowProbeFailures.has(sessionId + '|' + key) && force !== true) return
      windowProbes.add(sessionId)
      try {
        const work = await runCommandForPlugin(sessionId, cwd, '/context')
        if (work === undefined) return
        const answer = await work
        const text = answer === undefined ? '' : answer.text
        const report = parseContextReport(text)
        if (report !== undefined) contextReports.set(sessionId, report)
        const found = parseContextWindow(text)
        if (found <= 0) { windowProbeFailures.add(sessionId + '|' + key); return }
        windowProbeFailures.delete(sessionId + '|' + key)
        if (state.contextWindow !== found || state.contextWindowKey !== key) {
          state.contextWindow = found
          state.contextWindowKey = key
          persistStates()
          announceContextWindow(sessionId, sessionOf(sessionId))
          console.log('cc-mode: context window measured —', found, 'for', sessionId)
        }
      } catch (error) {
        console.error('cc-mode: could not read the context window:', errorText(error))
      } finally {
        windowProbes.delete(sessionId)
      }
    }

    const EFFORTS = [
      { id: '', name: '默认' },
      { id: 'low', name: 'low' },
      { id: 'medium', name: 'medium' },
      { id: 'high', name: 'high' },
      { id: 'xhigh', name: 'xhigh' },
      { id: 'max', name: 'max' },
    ]
    // The CLI's own choices (2.1.x): manual/acceptEdits/auto/bypassPermissions/plan.
    const PERMISSION_MODES = [
      { id: 'manual', name: '监督 · 每个工具问我', detail: '权限问题走 dsh 原生审批卡片' },
      { id: 'acceptEdits', name: '自动接受编辑', detail: '文件编辑直接放行，其余仍问' },
      { id: 'auto', name: '自动', detail: 'Claude 自行判断' },
      { id: 'bypassPermissions', name: '完全放行', detail: '跳过所有权限检查（危险）' },
      { id: 'plan', name: '计划模式', detail: '只读研究，先给方案' },
    ]

    // Set while this package is being torn down (a hot update or a stop). An
    // in-flight turn dies with the process it was driving, and saying so beats
    // reporting it as a product crash.
    let shuttingDown = false
    const states = new Map()  // dsh sessionId -> settings

    /**
     * What a conversation starts as, when nothing has been chosen for it yet.
     *
     * These follow the last deliberate choice made anywhere: pick Claude with
     * a posture and a model in one conversation and the next new one opens the
     * same way, instead of every conversation starting on DSH and having to be
     * switched again. Only the three selectors write here — the engine picker,
     * the posture picker, the model picker — so it tracks what someone chose,
     * never what a conversation happened to inherit.
     *
     * A conversation that already has content is unaffected: `committedEngine`
     * reads the engine out of the log and always wins over this.
     */
    const defaults = { mode: 'dsh', permissionMode: 'manual', model: DEFAULT_MODEL, effort: '', remote: '' }

    function rememberDefaults(state) {
      const remote = typeof state.remote === 'string' ? state.remote : ''
      if (defaults.mode === state.mode && defaults.permissionMode === state.permissionMode
        && defaults.model === state.model && defaults.effort === state.effort
        && defaults.remote === remote) return
      defaults.mode = state.mode
      defaults.permissionMode = state.permissionMode
      defaults.model = state.model
      defaults.effort = state.effort
      defaults.remote = remote
      persistStates()
    }
    // Posture, model and effort are the user's choices about a conversation, so
    // they belong to the conversation — not to this process's memory. They are
    // read back at startup, which is why an older Claude chat opens with the
    // posture it was left on instead of the default.
    // Under $HOME, not /tmp: this is what lets an older conversation be picked
    // up again — posture, model, and above all the Claude session id to resume.
    const STATE_DIR = '"$HOME"/.cache/ccmode'
    const STATE_PATH = STATE_DIR + '/state.json'

    // ---- where Claude runs -------------------------------------------------
    //
    // A conversation drives Claude either on this machine or on a configured
    // SSH target. Everything this plugin does to the Claude side of the world
    // is already a shell command string, and the broker speaks through files
    // and a fifo rather than through its own stdio — so ONE indirection moves
    // the whole model to another host: shArgv() decides which shell runs the
    // command. The broker, its fifo, its append-only log, and the tail that
    // attaches to it then all live on the machine that actually runs `claude`.
    //
    // "Where" is a shell that is not this one, and ssh is only one way to
    // reach it: `docker exec -i <c> /bin/sh -c <cmd>` is the same contract —
    // one command string handed to one shell — so a target declares a
    // transport rather than assuming SSH.
    //
    // Targets are declared under `#remotes` in this same state file, and the
    // plugin preserves that block verbatim across its own writes:
    //
    //   "#remotes": {
    //     "devbox": { "label": "Devbox", "ssh": "devbox", "dir": "/srv/work" },
    //     "app":    { "label": "App", "docker": "myapp-1", "dir": "/workspace" },
    //     "prod":   { "docker": "api", "ssh": "prod" }
    //   }
    //
    // `ssh` is normally an ssh_config Host alias, so identity, port and jump
    // hosts stay in ~/.ssh/config where the rest of the system already reads
    // them. The explicit form (`user@host` plus `port` / `identityFile` /
    // `sshOptions`) is for a deployment with no ssh_config to speak of.
    // Declaring BOTH runs `docker exec` on the far host, which is how a
    // container on another machine is reached.
    const REMOTES = new Map()
    let remotesRaw = null

    /**
     * The directory each target was last worked in, so a new conversation on
     * it opens where the last one did — the same courtesy the engine, posture
     * and model already get.
     *
     * Per target rather than one global value, because a path is only
     * meaningful on the machine that has it: carrying `/srv/work` from one
     * container to another would open a conversation somewhere that does not
     * exist, or worse, somewhere that does and is wrong.
     */
    const lastDirs = new Map()

    /**
     * The memory is keyed by (dsh workspace, target), not by target alone.
     *
     * A person works one project at a time, and on a given target that project
     * lives in one directory. Keyed by target alone, opening a conversation in
     * project B inherited project A's directory — right machine, wrong work —
     * and every new conversation had to be re-pointed by hand. Keyed by the
     * pair, a second conversation in the same project on the same target opens
     * where the first one did, and switching projects switches the directory
     * with it.
     */
    function dirKey(workspace, remoteId) {
      return String(workspace || '') + '\u0000' + String(remoteId || '')
    }

    /** This dsh conversation's own workspace directory, when it has one. */
    function workspaceOf(sessionId) {
      const session = sessionOf(sessionId)
      const header = session === undefined || session === null ? undefined : session.header
      return header !== undefined && header !== null && typeof header.cwd === 'string' ? header.cwd : ''
    }

    /**
     * Where this (workspace, target) pair was last worked in.
     *
     * Falls back to the target's own older memory — entries written before the
     * key carried a workspace — so an upgrade does not look like every target
     * forgetting where it works.
     */
    function lookupDir(workspace, remoteId) {
      const scoped = lastDirs.get(dirKey(workspace, remoteId))
      if (typeof scoped === 'string' && scoped.length > 0) return scoped
      const legacy = lastDirs.get(String(remoteId || ''))
      return typeof legacy === 'string' ? legacy : ''
    }

    /** Record where a target was last worked in; empty values never overwrite. */
    function rememberDir(remote, cwd, workspace) {
      if (remote === null || remote === undefined) return
      if (typeof cwd !== 'string' || cwd.length === 0) return
      const key = dirKey(workspace, remote.id)
      if (lastDirs.get(key) === cwd) return
      lastDirs.set(key, cwd)
      persistStates()
    }

    /**
     * One SSH target, or null when the declaration is unusable.
     *
     * Validated field by field like every other stored choice: a half-written
     * target must not take the rest of the registry down with it, and a
     * conversation pointing at a target that no longer parses falls back to
     * this machine rather than refusing to open.
     */
    function normalizeRemote(id, raw) {
      if (raw === null || typeof raw !== 'object') return null
      const host = typeof raw.ssh === 'string' ? raw.ssh.trim() : ''
      const container = typeof raw.docker === 'string' ? raw.docker.trim() : ''
      // One transport is the minimum; both together mean a container over there.
      if (host.length === 0 && container.length === 0) return null
      if (raw.daemon === true && host.length === 0) {
        // Said out loud rather than silently downgraded: the person asked for
        // the daemon and would otherwise never learn they did not get it.
        console.error('cc-mode: 目标 ' + id + ' 写了 daemon:true 但没有 ssh —— daemon 靠 ssh 隧道才连得上（容器里跑个 sshd 即可），这次按普通档走')
      }
      return {
        id: id,
        label: typeof raw.label === 'string' && raw.label.length > 0 ? raw.label : id,
        host: host,
        container: container,
        // `docker exec -u`: a container whose default user is not the one
        // Claude is installed for.
        containerUser: typeof raw.dockerUser === 'string' ? raw.dockerUser.trim() : '',
        port: typeof raw.port === 'number' && raw.port > 0 ? String(raw.port) : '',
        identityFile: typeof raw.identityFile === 'string' ? raw.identityFile.trim() : '',
        options: Array.isArray(raw.sshOptions)
          ? raw.sshOptions.filter((entry) => typeof entry === 'string' && entry.length > 0)
          : [],
        // The working directory conversations on this target open in. Empty
        // means the remote account's home, resolved on first use — a dsh
        // workspace path is a path on THIS machine and means nothing there.
        dir: typeof raw.dir === 'string' ? raw.dir.trim() : '',
        // The target's own binaries. `node` cannot be inherited from
        // process.execPath the way the local launch does — that is a path on
        // THIS machine, and the broker is a node script that has to run over
        // there.
        claudeBin: typeof raw.claude === 'string' && raw.claude.length > 0 ? raw.claude : 'claude',
        nodeBin: typeof raw.node === 'string' && raw.node.length > 0 ? raw.node : 'node',
        // THIS machine's docker, by contrast, is resolved here — and a bare
        // name is not enough. dsh is typically started by a launcher (pm2,
        // launchd) whose PATH is not a login shell's: on macOS `docker` lives
        // in /usr/local/bin or an OrbStack/Docker Desktop directory that such
        // a PATH routinely lacks, and the spawn then fails with no output at
        // all. Resolved once at load; `dockerBin` overrides.
        dockerBin: typeof raw.dockerBin === 'string' && raw.dockerBin.length > 0 ? raw.dockerBin : '',
        // This target picks its own model, so the plugin must not push one.
        //
        // The model list here is claude.ai's. A target whose Claude Code talks
        // to a third-party Anthropic-compatible gateway has a completely
        // different one, and `--model claude-opus-5` against such a gateway
        // does not fail loudly — it comes back in zero milliseconds having
        // burned zero tokens, with `stop_reason: stop_sequence` and an empty
        // answer. A conversation that says nothing, costs nothing, and reports
        // no error is the hardest kind of broken to notice. So when the target
        // says the model is its business, `--model` and `set_model` are left
        // out entirely and whatever that machine's own settings choose stands.
        ownModel: raw.ownModel === true,
        // One connection to a daemon over there instead of a shell command
        // per question — see the cc-daemon hop. It requires ssh: the tunnel is
        // what keeps an endpoint that can start processes off the network, and
        // `docker exec` gives us no socket to tunnel through.
        daemon: raw.daemon === true && host.length > 0,
        // How this target reaches dsh's web server to call back into it.
        // Everything dsh hands a Claude process as a callback URL is built from
        // dsh's own loopback address — correct while the process runs beside
        // it, meaningless once the process runs on another machine, where
        // 127.0.0.1 is that machine. Worse than meaningless, in fact: a target
        // that happens to run its own dsh on the same port answers instead, and
        // the only symptom is a rejected token.
        dshHost: typeof raw.dshHost === 'string' ? raw.dshHost.trim() : '',
      }
    }

    /**
     * Where a Docker CLI is actually installed when PATH does not say.
     *
     * Not a guess list for its own sake: these are the locations the macOS
     * installers use, and a launcher-started dsh sees none of them.
     */
    const DOCKER_FALLBACKS = [
      '/usr/local/bin/docker',
      '/opt/homebrew/bin/docker',
      '/Applications/Docker.app/Contents/Resources/bin/docker',
    ]

    /**
     * Pin down this machine's docker binary for every container target.
     * @returns nothing; each target keeps whatever it could resolve.
     */
    async function resolveDockerBinaries() {
      const targets = [...REMOTES.values()].filter((remote) => remote.container !== '' && remote.dockerBin === '')
      if (targets.length === 0) return
      let resolved = ''
      try {
        resolved = await subprocess.resolveExecutable('docker')
      } catch (error) {
        for (const candidate of DOCKER_FALLBACKS) {
          const answer = await runCapture(['/bin/sh', '-c',
            '[ -x ' + shellQuote(candidate) + ' ] && echo yes'], 5000)
          if (String(answer).indexOf('yes') === 0) { resolved = candidate; break }
        }
      }
      if (resolved === '') {
        console.error('cc-mode: no docker binary on this machine\'s PATH — container targets ('
          + targets.map((remote) => remote.id).join(', ')
          + ') cannot start. Set "dockerBin" on the target to its full path.')
        return
      }
      for (const remote of targets) remote.dockerBin = resolved
      console.log('cc-mode: container targets use', resolved)
    }

    /**
     * The ssh command prefix for one target.
     *
     * ControlMaster is not an optimization here, it is what makes the design
     * viable: one turn issues dozens of small commands (stat the transcript,
     * poll meta.json, `kill -0` the broker), and without a shared connection
     * each would pay a fresh TCP and auth handshake. Measured against a box
     * one continent away that is 2.6s per command versus 0.47s — the master
     * turns every call after the first into a single round-trip, so what is
     * left is the network itself. BatchMode is what keeps a target that wants
     * a passphrase from hanging the plugin on a prompt nobody can see.
     */
    function sshArgvPrefix(remote) {
      const argv = ['ssh', '-T',
        '-o', 'BatchMode=yes',
        '-o', 'ConnectTimeout=10',
        '-o', 'ServerAliveInterval=15',
        '-o', 'ControlMaster=auto',
        '-o', 'ControlPath=/tmp/ccmode-cm-' + String(remote.id).replace(/[^A-Za-z0-9_.-]/g, '_'),
        '-o', 'ControlPersist=10m']
      if (remote.port !== '') argv.push('-p', remote.port)
      if (remote.identityFile !== '') argv.push('-o', 'IdentitiesOnly=yes', '-i', remote.identityFile)
      for (const option of remote.options) argv.push('-o', option)
      argv.push(remote.host)
      return argv
    }

    /**
     * `docker exec` for one target, as an argv.
     *
     * `-i` is not optional: the broker's stdin, and every `cat > fifo`, need
     * the channel open. No `-t` — the stream is JSON lines, and a pty would
     * mangle it exactly as it would over ssh.
     */
    function dockerArgv(remote, command) {
      const argv = [remote.dockerBin === '' ? 'docker' : remote.dockerBin, 'exec', '-i']
      if (remote.containerUser !== '') argv.push('-u', remote.containerUser)
      argv.push(remote.container, '/bin/sh', '-c', command)
      return argv
    }

    /**
     * Run one shell command where this conversation's Claude lives.
     *
     * Every transport ends at the same place: `/bin/sh -c <command>`. That is
     * not incidental — ssh hands its argument to the account's LOGIN shell,
     * which is whatever the user chose. A zsh login shell aborts the whole
     * command on a glob that matches nothing (a hidden-directory glob in a
     * directory that has none), and a fish one cannot read a POSIX for-loop at
     * all. Naming the shell explicitly is what makes one command string mean
     * one thing everywhere, so the cost is one quoting pass for the ssh hop.
     */
    function shArgv(command, remote) {
      if (remote === null || remote === undefined) return ['/bin/sh', '-c', command]
      const local = remote.container !== ''
        ? dockerArgv(remote, command)
        : ['/bin/sh', '-c', command]
      if (remote.host === '') return local
      return sshArgvPrefix(remote).concat([local.map(shellQuote).join(' ')])
    }

    // ---------- the cc-daemon hop ----------
    //
    // A target declared with `"daemon": true` is not reached with a shell
    // command per question. It gets ONE connection, to a small daemon this
    // plugin installs and starts over there, and every question rides that.
    //
    // Why: `shArgv` is correct and it is still the wrong shape over a slow
    // hop. One turn asks that machine dozens of small questions — stat the
    // transcript, read meta.json, is the broker's pid alive — and over
    // `docker exec` or ssh each is a fresh process and, worse, an answer that
    // cannot say how it failed. `runCapture` never rejects: a timeout, a spawn
    // that failed, and "the answer really is empty" all come back as the same
    // empty string, and the caller reads that as a definite NO. The NO branch
    // is always the destructive one. That is how a 30MB transcript was
    // declared missing and its conversation restarted with an empty Claude,
    // and how a state file became a 153-byte stub.
    //
    // The daemon ends that: every call comes back decided — an exit code, or
    // `timedOut`, or an HTTP error — and a connection is either up or down,
    // with no third state. It does NOT own Claude processes: the broker still
    // does, one per conversation, with all of its hard-won exit behaviour
    // intact. The daemon is the machine's front door, nothing more.
    const DAEMON_SOURCE = '@@DAEMON_SOURCE@@'
    /** Must match the daemon's own PROTOCOL_VERSION; a mismatch reinstalls. */
    const DAEMON_PROTOCOL = 2
    // Shell words, not quoted paths: `$HOME` has to expand over there.
    const DAEMON_DIR_WORD = '"$HOME"/.cache/cc-daemon'
    const DAEMON_FILE_WORD = DAEMON_DIR_WORD + '/cc-daemon.mjs'
    // The tunnel's local end. ssh itself says whether a port is free
    // (ExitOnForwardFailure), so this walks the range rather than guessing —
    // a bind check here would be a race against every other process anyway.
    const DAEMON_PORT_BASE = 39321
    const DAEMON_PORT_TRIES = 40
    const DAEMON_OPEN_MS = 45000

    /** remote.id → Promise<{ base, token, proc, port }>, one per target. */
    const daemons = new Map()

    /**
     * Why a tunnel at all, when the daemon could bind a public port?
     *
     * Because a port that answers is a port anyone on that network can reach,
     * and this one starts processes. The daemon binds loopback on its own
     * machine and the only way in is a connection that machine already
     * authenticates — ssh. `-N` carries no command, so the far side runs
     * nothing but the forward; ServerAlive turns a dead peer into a dead
     * process here (which the next call rebuilds) instead of a socket that
     * accepts forever and answers never.
     *
     * NO ControlMaster here, and that is the opposite of what the one-off
     * commands want. `ControlPersist` makes ssh fork a background master and
     * EXIT THE FOREGROUND PROCESS once the connection is up — so the process
     * this plugin holds resolves immediately while the forward keeps working
     * in a process nobody owns. Measured: the plugin read that exit as "the
     * tunnel died", walked all forty candidate ports, and left forty orphaned
     * masters holding them. A tunnel has to BE the process we are holding.
     */
    function tunnelArgv(remote, localPort, remotePort) {
      const argv = ['ssh', '-N',
        '-o', 'BatchMode=yes',
        '-o', 'ConnectTimeout=10',
        '-o', 'ServerAliveInterval=15',
        '-o', 'ServerAliveCountMax=4',
        '-o', 'ExitOnForwardFailure=yes',
        '-o', 'ControlMaster=no',
        '-L', '127.0.0.1:' + localPort + ':127.0.0.1:' + remotePort]
      if (remote.port !== '') argv.push('-p', remote.port)
      if (remote.identityFile !== '') argv.push('-o', 'IdentitiesOnly=yes', '-i', remote.identityFile)
      for (const option of remote.options) argv.push('-o', option)
      argv.push(remote.host)
      return argv
    }

    /** One request to a target's daemon. Rejects on anything but a reply. */
    async function daemonRequest(link, route, init, timeoutMs) {
      const controller = new AbortController()
      const timer = armTimeout(() => controller.abort(), timeoutMs || 30000)
      try {
        const response = await fetch(link.base + route, {
          ...init,
          signal: controller.signal,
          headers: { ...(init.headers || {}), authorization: 'Bearer ' + link.token },
        })
        const text = await response.text()
        let body = null
        try { body = JSON.parse(text) } catch (error) { body = null }
        if (!response.ok) {
          throw new Error('cc-daemon ' + route + ' → ' + response.status
            + (body !== null && body.error !== undefined ? ': ' + body.error : ''))
        }
        return body
      } finally { try { timer() } catch (error) { /* already fired */ } }
    }

    /** Install the daemon source over there and start it. Idempotent by design. */
    async function openDaemon(remote) {
      // The source is written through the ordinary shell hop — the ONLY time
      // this plugin talks to the target that way once a daemon exists. It is
      // one `cat`, so it is one thing that can be half-done instead of two.
      const install = silenceStdin(subprocess.spawn({
        argv: shArgv('mkdir -p ' + DAEMON_DIR_WORD + ' && cat > ' + DAEMON_FILE_WORD + '.tmp'
          + ' && mv ' + DAEMON_FILE_WORD + '.tmp ' + DAEMON_FILE_WORD, remote),
        cwd: '/',
        stdio: { stdin: 'pipe', stdout: 'ignore', stderr: 'ignore' },
        graceMs: 5000,
      }))
      if (install.stdin !== undefined) { install.stdin.write(DAEMON_SOURCE); install.stdin.end() }
      await install.done

      // `ensure` is idempotent on the target's side: a healthy daemon of this
      // protocol is reused, an older one is replaced, and either way the JSON
      // line names the port and token. Asking "is it up?" and then starting it
      // would be two round trips with a race in the middle.
      // The bootstrap runs BEFORE there is a daemon, so it goes through the
      // ordinary shell hop by hand rather than through captureOn (which would
      // try to reach the daemon this call is about to start).
      const raw = await runCapture(shArgv(
        shellQuote(remote.nodeBin) + ' ' + DAEMON_FILE_WORD + ' ensure --state ' + DAEMON_DIR_WORD, remote), 40000)
      let info = null
      try { info = JSON.parse(String(raw).trim().split('\n').pop() || '') } catch (error) { info = null }
      if (info === null || info.ready !== true) {
        throw new Error('cc-daemon 起不来 on ' + remote.id + ': ' + (String(raw).trim() || '目标机没有任何回应'))
      }
      if (info.protocol !== DAEMON_PROTOCOL) {
        throw new Error('cc-daemon 协议不匹配 on ' + remote.id + ': 目标机是 ' + info.protocol + '，插件要 ' + DAEMON_PROTOCOL)
      }

      // Walk the local port range until ssh accepts one. ExitOnForwardFailure
      // means a busy port kills the ssh immediately rather than leaving a
      // tunnel that silently forwards nothing.
      let lastComplaint = ''
      for (let step = 0; step < DAEMON_PORT_TRIES; step += 1) {
        const localPort = DAEMON_PORT_BASE + step
        const proc = silenceStdin(subprocess.spawn({
          argv: tunnelArgv(remote, localPort, info.port),
          cwd: '/',
          // ssh's stderr is the only place that says WHY a tunnel refused to
          // come up (a busy port, a rejected key, a host that moved). Throwing
          // it away left "本机 39321–39360 全都不行" as the whole diagnosis —
          // the same "we lost the reason" this daemon exists to stop.
          stdio: { stdin: 'ignore', stdout: 'ignore', stderr: 'pipe' },
          graceMs: 1000,
        }))
        let complaint = ''
        ;(async () => {
          try {
            for await (const chunk of proc.stderr) {
              const text = String(chunk).trim()
              if (text.length > 0) complaint = (complaint + ' ' + text).trim().slice(-400)
            }
          } catch (error) { /* closed with the process */ }
        })()
        let dead = false
        proc.done.then(() => { dead = true }, () => { dead = true })
        const link = { base: 'http://127.0.0.1:' + localPort, token: info.token, proc: proc, port: localPort, remotePort: info.port }
        const deadline = Date.now() + 8000
        while (Date.now() < deadline) {
          await sleep(120)
          if (dead) break
          let health = null
          try { health = await daemonRequest(link, '/health', { method: 'GET' }, 3000) } catch (error) { health = null }
          if (health !== null && health.ok === true) {
            console.log('cc-mode: cc-daemon 已连上', remote.id,
              '（目标机 127.0.0.1:' + info.port + ' ← 隧道 → 本机 ' + localPort + '，', info.reused ? '复用' : '新起', '）')
            return link
          }
        }
        try { proc.terminate() } catch (error) { /* already gone */ }
        if (complaint.length > 0) lastComplaint = complaint
      }
      throw new Error('cc-daemon 隧道建不起来 on ' + remote.id + '：本机 '
        + DAEMON_PORT_BASE + '–' + (DAEMON_PORT_BASE + DAEMON_PORT_TRIES - 1) + ' 全都不行'
        + (lastComplaint.length > 0 ? '；ssh 说：' + lastComplaint : '；ssh 一个字都没说'))
    }

    /**
     * This target's daemon connection, opening it if needed.
     *
     * A link whose tunnel died is dropped and rebuilt rather than reported as
     * an error: ssh going away is a transport event, and the caller asked a
     * question about a machine, not about a socket.
     */
    function ensureDaemon(remote) {
      const pending = daemons.get(remote.id)
      if (pending !== undefined) return pending
      const opening = openDaemon(remote).then(
        (link) => {
          // When the tunnel ends, forget it — but only if this is still the
          // link on file, or a rebuild that already happened would be undone.
          link.proc.done.then(
            () => { if (daemons.get(remote.id) === opening) daemons.delete(remote.id) },
            () => { if (daemons.get(remote.id) === opening) daemons.delete(remote.id) },
          )
          return link
        },
        (error) => { daemons.delete(remote.id); throw error },
      )
      daemons.set(remote.id, opening)
      return opening
    }

    /** Tear down a target's daemon link (the daemon over there keeps running). */
    function closeDaemon(remoteId) {
      const pending = daemons.get(remoteId)
      if (pending === undefined) return
      daemons.delete(remoteId)
      pending.then((link) => { try { link.proc.terminate() } catch (error) { /* gone */ } }, () => undefined)
    }

    function usesDaemon(remote) {
      return remote !== null && remote !== undefined && remote.daemon === true
    }

    /**
     * Run one command where this conversation's Claude lives, and come back
     * with a DECIDED outcome.
     *
     *   { decided: true,  code, stdout, stderr, timedOut }
     *   { decided: false, reason }          — we never found out
     *
     * The second shape is the whole point. A caller that cannot tell "the file
     * is not there" from "nobody answered" will eventually act on the wrong
     * one, and the wrong one is always destructive.
     *
     * Targets without a daemon keep the old behaviour exactly: one spawn, and
     * an answer that cannot distinguish those two. That is not an oversight —
     * it is the behaviour every existing deployment is running today, and this
     * change must not alter it.
     */
    async function execOn(command, remote, timeoutMs, options) {
      const settings = options === undefined || options === null ? {} : options
      if (usesDaemon(remote)) {
        let link = null
        try { link = await ensureDaemon(remote) } catch (error) {
          return { decided: false, reason: errorText(error), stdout: '', stderr: '', code: null, timedOut: false }
        }
        try {
          const body = await daemonRequest(link, '/exec', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              cmd: command,
              timeoutMs: timeoutMs || 20000,
              stdin: typeof settings.stdin === 'string' ? settings.stdin : undefined,
              idemKey: typeof settings.idemKey === 'string' ? settings.idemKey : undefined,
            }),
            // Past the command's own deadline: the daemon kills it at
            // `timeoutMs` and still answers, and that answer (timedOut: true)
            // is worth more than us giving up on the connection.
          }, (timeoutMs || 20000) + 10000)
          return {
            decided: true,
            code: body.code === undefined ? null : body.code,
            stdout: typeof body.stdout === 'string' ? body.stdout : '',
            stderr: typeof body.stderr === 'string' ? body.stderr : '',
            timedOut: body.timedOut === true,
            duplicate: body.duplicate === true,
          }
        } catch (error) {
          // The tunnel may have died under us; the next call rebuilds it.
          closeDaemon(remote.id)
          return { decided: false, reason: errorText(error), stdout: '', stderr: '', code: null, timedOut: false }
        }
      }
      // No daemon: one spawn, as before.
      if (typeof settings.stdin === 'string') {
        const proc = silenceStdin(subprocess.spawn({
          argv: shArgv(command, remote),
          cwd: '/',
          stdio: { stdin: 'pipe', stdout: 'ignore', stderr: 'ignore' },
          graceMs: 2000,
        }))
        if (proc.stdin !== undefined) { proc.stdin.write(settings.stdin); proc.stdin.end() }
        try { await proc.done } catch (error) { /* the caller's next read reports it */ }
        return { decided: true, code: null, stdout: '', stderr: '', timedOut: false }
      }
      // runCapture, never captureOn: captureOn is built ON this function, and
      // calling it here is an infinite recursion. (It was, once — the批量
      // rewrite that moved forty call sites onto captureOn moved this one too,
      // and dsh crash-looped on a stack overflow before a single turn ran.)
      const output = await runCapture(shArgv(command, remote), timeoutMs)
      return { decided: true, code: null, stdout: output, stderr: '', timedOut: false }
    }

    /**
     * `execOn`, reduced to the stdout string the old call sites expect.
     *
     * An undecided call still answers '' here, because that is what forty call
     * sites are written against and changing all of them at once would be a
     * bigger risk than the bug. What it does NOT do is stay quiet about it:
     * the failure is logged with the command that caused it, and the handful
     * of call sites where '' is genuinely destructive (does this transcript
     * exist, is this broker alive, how big is this file) ask `execOn`
     * themselves and branch on `decided`.
     */
    async function captureOn(command, remote, timeoutMs) {
      const result = await execOn(command, remote, timeoutMs)
      if (result.decided !== true) {
        console.error('cc-mode: 目标机没问出来（' + result.reason + '）：', command.slice(0, 120))
        return ''
      }
      if (result.timedOut === true) {
        console.error('cc-mode: 目标机上这条命令超时了（' + timeoutMs + 'ms）：', command.slice(0, 120))
        return ''
      }
      return result.stdout
    }

    /**
     * Follow a file on the target from a byte offset, as an object shaped like
     * the subprocess this replaces: `.stdout` is an async iterable of decoded
     * text and `.terminate()` lets go.
     *
     * The decoding is done here with a streaming decoder rather than left to
     * the consumer, because a chunk boundary lands mid-character often enough
     * to matter and a per-chunk `String(bytes)` would corrupt one silently.
     */
    function daemonTail(link, filePath, from) {
      const controller = new AbortController()
      const route = link.base + '/tail?path=' + encodeURIComponent(filePath) + '&from=' + from
      let started = false
      const stdout = {
        // `pumpAttached` asks for utf8; the decoder below always speaks it.
        setEncoding: () => undefined,
        async *[Symbol.asyncIterator]() {
          started = true
          let response
          try {
            response = await fetch(route, {
              method: 'GET',
              headers: { authorization: 'Bearer ' + link.token },
              signal: controller.signal,
            })
          } catch (error) {
            if (controller.signal.aborted !== true) console.error('cc-mode: tail 连不上 cc-daemon:', errorText(error))
            return
          }
          if (!response.ok) {
            // A 404 here is a fact about the log, not an empty stream — say it
            // out loud, because the caller's silence would look like a quiet
            // Claude rather than a missing file.
            console.error('cc-mode: cc-daemon tail', filePath, '→', response.status, (await response.text()).slice(0, 200))
            return
          }
          const decoder = new TextDecoder('utf-8')
          try {
            for await (const chunk of response.body) {
              const text = decoder.decode(chunk, { stream: true })
              if (text.length > 0) yield text
            }
            const rest = decoder.decode()
            if (rest.length > 0) yield rest
          } catch (error) {
            if (controller.signal.aborted !== true) console.error('cc-mode: tail 断了:', errorText(error))
          }
        },
      }
      return {
        stdout: stdout,
        terminate: () => { try { controller.abort() } catch (error) { /* already gone */ } },
        done: Promise.resolve(),
      }
    }

    /**
     * The remote account's home, asked once per target and remembered.
     *
     * Resolved eagerly rather than left as a literal `$HOME` in the launch
     * because the transcript path (`projectSlug`) needs a real absolute
     * directory — a slug built from an unexpanded word would never match the
     * one Claude itself writes under.
     */
    async function remoteHome(remote) {
      if (typeof remote.home !== 'string') {
        const answer = await captureOn('printf %s "$HOME"', remote, 8000)
        remote.home = String(answer).trim() || '/'
      }
      return remote.home
    }

    /** Where a conversation on `remote` opens: its own choice, the target's, else home. */
    async function remoteCwdOf(state, remote) {
      const own = typeof state.remoteCwd === 'string' ? state.remoteCwd.trim() : ''
      if (own.length > 0) return own
      if (remote.dir.length > 0) return remote.dir
      return remoteHome(remote)
    }

    /**
     * The target a browsing surface addresses. Import lists conversations for
     * a DIRECTORY, with no conversation to read a choice from, so an explicit
     * id wins and otherwise the last deliberate choice applies — the same rule
     * that already decides which engine a new conversation opens on.
     */
    function browsingRemote(args) {
      const id = args !== null && args !== undefined && typeof args.remote === 'string'
        ? args.remote
        : defaults.remote
      if (typeof id !== 'string' || id === '') return null
      const remote = REMOTES.get(id)
      return remote === undefined ? null : remote
    }

    /**
     * One level up from an absolute path, or null at the root.
     *
     * Computed from what the remote shell's own `pwd` answered, never from a
     * path the client assembled: the client cannot see that filesystem and
     * must not be the one deciding what "up" means on it.
     */
    function parentDir(path) {
      if (typeof path !== 'string' || path.indexOf('/') !== 0 || path === '/') return null
      const cut = path.replace(/\/+$/, '')
      if (cut === '') return null
      return cut.slice(0, cut.lastIndexOf('/')) || '/'
    }

    /** The target a conversation runs on, or null for this machine. */
    function remoteOf(state) {
      if (state === null || state === undefined) return null
      const id = typeof state.remote === 'string' ? state.remote : ''
      if (id === '') return null
      const remote = REMOTES.get(id)
      return remote === undefined ? null : remote
    }
    let statePersistScheduled = false
    const runs = new Map()    // dsh sessionId -> resident claude run
    const activeTurns = new Map()  // dsh sessionId -> { turn, run } while a turn is open

    /**
     * Which engine this session已经 committed to, read off its own log.
     *
     * The two engines do not share a history: Claude keeps its conversation in
     * its own transcript and never sees a dsh turn, while dsh's surface would
     * feed Claude's messages to DeepSeek as if it had produced them. A session
     * therefore belongs to exactly one engine for life, and this is the fact
     * that decides it — not a runtime flag, so a harness restart cannot hand a
     * Claude conversation back to the built-in loop.
     *
     * @returns 'claude', 'dsh', or undefined while the session has taken no turn.
     */
    function committedEngine(session) {
      if (session === undefined || session === null) return undefined
      let sawDsh = false
      for (const event of sessionEvents(session)) {
        if (event.type === 'assistant/message') {
          const source = event.data && event.data.message ? event.data.message.source : undefined
          if (source === undefined || source.provider === undefined) continue
          if (source.provider === PROVIDER) {
            if (source.model === NOTICE_MODEL) continue
            return 'claude'
          }
          sawDsh = true
        } else if (event.type === 'request/header') {
          sawDsh = true
        }
      }
      return sawDsh ? 'dsh' : undefined
    }

    function stateOf(sessionId, session) {
      let state = states.get(sessionId)
      if (state === undefined) {
        // A conversation nothing is known about opens on the last deliberate
        // choice, not on a hardcoded DSH default.
        state = {
          mode: defaults.mode,
          permissionMode: defaults.permissionMode,
          model: defaults.model,
          effort: defaults.effort,
          remote: defaults.remote,
          // The directory belongs to the target, so it is inherited from what
          // that target was last worked in rather than from the last
          // conversation, which may have been on another machine entirely.
          remoteCwd: lookupDir(workspaceOf(sessionId), defaults.remote),
          route: undefined,
        }
        states.set(sessionId, state)
      }
      // A Claude conversation stays a Claude conversation across a restart: the
      // log, not this process's memory, says which engine a session belongs to,
      // and a committed engine never changes. Seeding therefore happens on
      // EVERY lookup that can see the session, not once — the first lookup is
      // often the settings restore, which has no session to read, and a one-shot
      // seed consumed there left the conversation reading as DSH for good (its
      // Claude commands and posture then stayed hidden).
      const committed = committedEngine(session)
      if (committed !== undefined) state.mode = committed
      return state
    }

    // committedEngine walks a whole log, so the answer is memoised per session
    // against its event count — the sidebar asks for every session at once.
    const engineCache = new Map()
    // Sessions this process has driven with Claude. A row whose agent is no
    // longer live still gets its badge from here.
    const claudeSeen = new Set()

    /**
     * Which engine each live session belongs to, for the sidebar badge. A
     * session that has been switched to Claude but has not taken its first turn
     * counts too, so the badge appears the moment the choice is made.
     */
    function engineIndex() {
      const out = {}
      // Every conversation this plugin has settings for, live or cold: the
      // sidebar badge should say "this is a Claude conversation" from the list
      // itself, not only after the row has been opened once.
      for (const [sessionId, state] of states) {
        if (state.mode === 'claude') out[sessionId] = 'claude'
      }
      if (agents === undefined) return out
      let list = []
      try { list = agents.list() } catch (error) { return out }
      for (const agent of list) {
        const sessionId = String(agent.id)
        const session = agent.session
        const count = session === undefined ? 0 : sessionEvents(session).length
        const cached = engineCache.get(sessionId)
        let engine
        if (cached !== undefined && cached.count === count) engine = cached.engine
        else {
          engine = committedEngine(session)
          engineCache.set(sessionId, { count: count, engine: engine })
        }
        if (engine === undefined) {
          const state = states.get(sessionId)
          if (state !== undefined && state.mode === 'claude') engine = 'claude'
          else if (claudeSeen.has(sessionId)) engine = 'claude'
        }
        if (engine !== undefined) out[sessionId] = engine
      }
      return out
    }

    // Nothing may be written before the file has been READ.
    //
    // `persistStates()` rewrites the whole file from memory, and memory before
    // the load is EMPTY — so a single early write (a command roster, a settings
    // touch, anything) replaces the file with a two-key stub. That is how
    // `#remotes` went missing: the block whose own comment says our writes must
    // never erase the user's targets, erased by our own write, one tick before
    // the load that would have populated it. Every conversation's engine choice
    // and this dsh's identity went with it, which is why a restart came up with
    // no targets and a brand-new instance id.
    let statesLoaded = false
    let persistWaiting = false

    async function loadPersistedStates() {
      // The read has to say WHICH empty it means.
      //
      // `runCapture` never rejects: a spawn that failed, a command that timed
      // out and one that legitimately found nothing all come back as ''. Read
      // with a bare `cat` and those are the same answer — and "" was taken to
      // mean "no state yet", so a five-second timeout on a loaded machine
      // (this Mac sat at load 80 under a rust build) turned into "there is
      // nothing to restore", which was then WRITTEN BACK over everything. That
      // is how the restored file went from 11671 bytes to 153 twice in an hour.
      // So the shell says the file is absent, in words, and every other empty
      // is a failure: this run persists nothing rather than overwrite settings
      // it never managed to see.
      const ABSENT = '@@ccmode-absent@@'
      const raw = await runCapture(['/bin/sh', '-c',
        'if [ -f ' + STATE_PATH + ' ]; then cat ' + STATE_PATH + '; else printf %s ' + ABSENT + '; fi'], 20000)
      const text = String(raw).trim()
      let stored = null
      if (text !== ABSENT) {
        try {
          stored = JSON.parse(text)
        } catch (error) {
          console.error('cc-mode: could not read ' + STATE_PATH + ' (' + text.length + ' bytes back)'
            + ' — nothing will be persisted this run, so nothing can be lost.'
            + ' A loaded machine timing out this read is the usual cause.')
          return
        }
      }
      try {
        if (stored !== null && typeof stored === 'object') await applyPersistedStates(stored)
      } finally {
        statesLoaded = true
        mintInstanceId()
        if (persistWaiting) { persistWaiting = false; persistStates() }
      }
    }

    /**
     * Name this dsh, once and durably. A brand-new deployment gets its id here;
     * every launch from then on stamps its broker directories with it, so the
     * sweep can tell its own work from another dsh's on the same machine.
     */
    function mintInstanceId() {
      if (instanceId.length > 0) return
      instanceId = uuid()
      persistStates()
      console.log('cc-mode: this dsh is', instanceId, '— broker directories are stamped with it')
    }

    async function applyPersistedStates(stored) {
      // Written as a bare array before targets existed — that roster is this
      // machine's, so it loads under the empty key rather than being dropped.
      const savedCommands = stored['#commands']
      if (Array.isArray(savedCommands)) commandCache.set('', savedCommands)
      else if (savedCommands !== null && typeof savedCommands === 'object') {
        for (const key of Object.keys(savedCommands)) {
          if (Array.isArray(savedCommands[key])) commandCache.set(key, savedCommands[key])
        }
      }
      const savedDefaults = stored['#defaults']
      if (savedDefaults !== null && typeof savedDefaults === 'object') {
        // Validated one field at a time: a menu that dropped an option must
        // not leave every new conversation starting on something the picker
        // can no longer show.
        if (savedDefaults.mode === 'claude' || savedDefaults.mode === 'dsh') defaults.mode = savedDefaults.mode
        if (PERMISSION_MODES.some((entry) => entry.id === savedDefaults.permissionMode)) {
          defaults.permissionMode = savedDefaults.permissionMode
        }
        if (savedDefaults.model === '' || MODELS.some((entry) => entry.id === savedDefaults.model)) {
          defaults.model = savedDefaults.model
        }
        if (EFFORTS.some((entry) => entry.id === savedDefaults.effort)) defaults.effort = savedDefaults.effort
        if (typeof savedDefaults.remote === 'string') defaults.remote = savedDefaults.remote
      }
      if (typeof stored['#instance'] === 'string' && stored['#instance'].length > 0) {
        instanceId = stored['#instance']
      }
      const savedDirs = stored['#lastDirs']
      if (savedDirs !== null && typeof savedDirs === 'object' && !Array.isArray(savedDirs)) {
        for (const id of Object.keys(savedDirs)) {
          if (typeof savedDirs[id] === 'string' && savedDirs[id].length > 0) lastDirs.set(id, savedDirs[id])
        }
      }
      // Declared by hand, rewritten by nobody: keep the raw block so our own
      // writes cannot erase the user's targets, and register what parses.
      const savedRemotes = stored['#remotes']
      if (savedRemotes !== null && typeof savedRemotes === 'object' && !Array.isArray(savedRemotes)) {
        remotesRaw = savedRemotes
        REMOTES.clear()
        for (const id of Object.keys(savedRemotes)) {
          const remote = normalizeRemote(id, savedRemotes[id])
          if (remote === null) {
            console.error('cc-mode: ignoring unusable remote "' + id + '" — it needs at least an "ssh" host')
            continue
          }
          REMOTES.set(id, remote)
        }
        if (REMOTES.size > 0) console.log('cc-mode: ' + REMOTES.size + ' target(s):', [...REMOTES.keys()].join(', '))
        await resolveDockerBinaries()
      }
      for (const sessionId of Object.keys(stored)) {
        if (sessionId === '#commands' || sessionId === '#defaults' || sessionId === '#remotes'
          || sessionId === '#lastDirs' || sessionId === '#instance') continue
        const saved = stored[sessionId]
        if (saved === null || typeof saved !== 'object') continue
        const state = stateOf(sessionId)
        // A conversation switched to Claude but not yet committed by a turn
        // would otherwise come back as DSH after a restart.
        if (saved.mode === 'claude' || saved.mode === 'dsh') state.mode = saved.mode
        if (typeof saved.route === 'string' && saved.route.length > 0) state.route = saved.route
        if (typeof saved.jsonlOffset === 'number') state.jsonlOffset = saved.jsonlOffset
        if (typeof saved.titleWritten === 'string') state.titleWritten = saved.titleWritten
        if (typeof saved.contextWindow === 'number') state.contextWindow = saved.contextWindow
        if (typeof saved.contextWindowKey === 'string') state.contextWindowKey = saved.contextWindowKey
        if (saved.bandRepaired === true) state.bandRepaired = true
        if (typeof saved.permissionMode === 'string' && PERMISSION_MODES.some((entry) => entry.id === saved.permissionMode)) {
          state.permissionMode = saved.permissionMode
        }
        // '' is no longer offered, but a conversation saved under it stays on
        // it: it is already running on whatever Claude's own config says, and
        // that is not something a menu change should silently switch.
        if (typeof saved.model === 'string'
          && (saved.model === '' || MODELS.some((entry) => entry.id === saved.model))) state.model = saved.model
        if (typeof saved.effort === 'string' && EFFORTS.some((entry) => entry.id === saved.effort)) state.effort = saved.effort
        // Not validated against the registry: a conversation that ran on a
        // target keeps naming it even while that declaration is temporarily
        // gone, so restoring the block puts the conversation back where it
        // was instead of silently re-homing it onto this machine.
        if (typeof saved.remote === 'string') state.remote = saved.remote
        if (typeof saved.remoteCwd === 'string') state.remoteCwd = saved.remoteCwd
        if (typeof saved.launchCwd === 'string') state.launchCwd = saved.launchCwd
        if (typeof saved.claudeSessionId === 'string' && saved.claudeSessionId.length > 0) state.claudeSessionId = saved.claudeSessionId
      }
      console.log('cc-mode: restored settings for', Object.keys(stored).length, 'conversations')
    }

    /** Persist the per-conversation choices, coalesced to one write per tick. */
    function persistStates() {
      // Before the load, memory is not the truth — the file is. See statesLoaded.
      if (!statesLoaded) { persistWaiting = true; return }
      if (statePersistScheduled) return
      statePersistScheduled = true
      armTimeout(() => {
        statePersistScheduled = false
        const out = {}
        if (commandCache.size > 0) out['#commands'] = Object.fromEntries(commandCache)
        out['#defaults'] = {
          mode: defaults.mode,
          permissionMode: defaults.permissionMode,
          model: defaults.model,
          effort: defaults.effort,
          remote: defaults.remote,
        }
        // Hand-authored config living in a file we rewrite: without this the
        // first persist after boot would delete every target the user declared.
        if (remotesRaw !== null) out['#remotes'] = remotesRaw
        if (lastDirs.size > 0) out['#lastDirs'] = Object.fromEntries(lastDirs)
        if (instanceId.length > 0) out['#instance'] = instanceId
        for (const [sessionId, state] of states) {
          const claudeSessionId = state.claudeSessionId === undefined ? '' : state.claudeSessionId
          const remote = typeof state.remote === 'string' ? state.remote : ''
          if (state.mode === 'dsh' && state.permissionMode === 'manual' && state.model === DEFAULT_MODEL
            && state.effort === '' && claudeSessionId === '' && remote === ''
            && (typeof state.remoteCwd !== 'string' || state.remoteCwd === '')) continue
          out[sessionId] = {
            mode: state.mode,
            permissionMode: state.permissionMode,
            model: state.model,
            ...(state.route === undefined ? {} : { route: state.route }),
            ...(state.jsonlOffset === undefined ? {} : { jsonlOffset: state.jsonlOffset }),
            ...(state.titleWritten === undefined ? {} : { titleWritten: state.titleWritten }),
            ...(state.contextWindow === undefined ? {} : { contextWindow: state.contextWindow }),
            ...(state.contextWindowKey === undefined ? {} : { contextWindowKey: state.contextWindowKey }),
            ...(state.bandRepaired === true ? { bandRepaired: true } : {}),
            effort: state.effort,
            // Written even when empty. '' means "this machine" — a DELIBERATE
            // choice — while an absent key means "never chose", which seeds from
            // the deployment default. Omitting the empty value made the two
            // indistinguishable, so a local conversation silently migrated to
            // whatever target was default the next time dsh restarted: its
            // transcript stayed on one machine while its process reopened on
            // another.
            remote: remote,
            ...(typeof state.remoteCwd !== 'string' || state.remoteCwd === '' ? {} : { remoteCwd: state.remoteCwd }),
            ...(typeof state.launchCwd !== 'string' || state.launchCwd === '' ? {} : { launchCwd: state.launchCwd }),
            ...(claudeSessionId === '' ? {} : { claudeSessionId: claudeSessionId }),
          }
        }
        try {
          const proc = silenceStdin(subprocess.spawn({
            // Written to a temp file and MOVED into place, never straight into
            // the real one. `cat > file` truncates the moment it opens, and this
            // plugin activates more than once per dsh start (three activations
            // in one restart, by the log): activation B read the file during
            // activation A's truncation, saw an empty file, concluded there was
            // nothing to restore, and wrote that conclusion back. The user's
            // targets and every conversation's settings went with it — twice.
            // `mv` within one directory is atomic, so a reader sees either the
            // old file or the new one and never the gap between them.
            argv: ['/bin/sh', '-c', 'mkdir -p ' + STATE_DIR
              + ' && cat > ' + STATE_PATH + '.tmp.$$'
              + ' && mv ' + STATE_PATH + '.tmp.$$ ' + STATE_PATH],
            cwd: '/',
            stdio: { stdin: 'pipe', stdout: 'ignore', stderr: 'ignore' },
            graceMs: 2000,
          }))
          if (proc.stdin !== undefined) { proc.stdin.write(JSON.stringify(out)); proc.stdin.end() }
          proc.done.catch(() => undefined)
        } catch (error) {
          console.error('cc-mode: could not persist conversation settings:', errorText(error))
        }
      }, 500)
    }

    /**
     * Repair a conversation whose surface still carries an unanswered tool call
     * from an interrupted Claude turn. Without this the session is permanently
     * unusable: every later request rebuilds the same invalid history.
     */
    function repairDanglingToolCalls(session) {
      if (session === undefined || session === null) return 0
      const answered = new Set()
      const pending = new Map()
      // Only calls this plugin logged are ours to close: a dsh tool call that is
      // still running belongs to the built-in loop and must be left alone.
      const claudeCalls = new Set()
      for (const event of sessionEvents(session)) {
        if (event.type === 'assistant/message') {
          const message = event.data ? event.data.message : undefined
          const source = message === undefined ? undefined : message.source
          if (source !== undefined && source.provider === PROVIDER) {
            for (const block of (message.content || [])) {
              if (block.type === 'tool-call') claudeCalls.add(String(block.id))
            }
          }
        } else if (event.type === 'tool/result') {
          const source = event.data && event.data.message ? event.data.message.source : undefined
          if (source !== undefined && source.callId !== undefined) answered.add(String(source.callId))
        } else if (event.type === 'tool/call') {
          pending.set(String(event.data.callId), { turn: event.data.turn, step: event.data.step })
        }
      }
      let repaired = 0
      for (const [callId, at] of pending) {
        if (answered.has(callId) || !claudeCalls.has(callId)) continue
        try {
          session.append('tool/result', {
            turn: at.turn,
            step: at.step,
            message: {
              id: uuid(),
              role: 'user',
              source: { kind: 'tool', callId: callId },
              content: [{
                type: 'tool-result',
                toolCallId: callId,
                content: [{ type: 'text', text: '这次调用没有等到结果（上一次运行被中断）。' }],
                isError: true,
              }],
            },
          }, { surfaceOp: 'append' })
          repaired += 1
        } catch (error) {
          console.error('cc-mode: could not close a dangling tool call:', errorText(error))
        }
      }
      if (repaired > 0) console.log('cc-mode: closed', repaired, 'dangling tool call(s) left by an interrupted turn')
      return repaired
    }

    /** Resolve a live session for a session id, for calls that only carry the id. */
    function sessionOf(sessionId) {
      if (agents === undefined) return undefined
      try {
        const agent = agents.get(sessionId)
        return agent === undefined ? undefined : agent.session
      } catch (error) { return undefined }
    }

    // ---------- helpers (the sandbox has no node builtins) ----------

    function uuid() {
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
      })
    }

    function errorText(error) {
      return error && error.message ? String(error.message) : String(error)
    }

    /**
     * Run something that must never take the runtime down.
     *
     * Anything invoked from a HOST callback — an AbortSignal listener, a stream
     * handler, a cordis disposer — throws into the runtime, not into us: an
     * `EPIPE` from a dead child's stdin and a `cannot create effect on inactive
     * context` from `ctx.timeout` have each crashed dsh-web once. Callbacks go
     * through here, and they never create fiber effects (timers are armed while
     * the turn's own context is still active).
     */
    function safely(label, fn) {
      try { return fn() } catch (error) {
        console.error('cc-mode: contained a failure in', label + ':', errorText(error))
        return undefined
      }
    }

    /**
     * Arm a timer that cannot take a turn down with it.
     *
     * `ctx.timeout` belongs to a cordis fiber, and once that fiber is gone —
     * a plugin reload, a hot update, a disposed context — touching it throws
     * ("cannot get property \"timeout\" without inject", observed in the wild
     * as three `写入 Claude 失败` in a row followed by a dead turn). The timer
     * itself is not the interesting part of any of those code paths: a turn
     * that is mid-flight should keep running on a plain host timer rather than
     * die because the plugin's context moved underneath it.
     * @returns a canceller, whichever timer ended up being used.
     */
    function armTimeout(fn, ms) {
      try {
        const cancel = ctx.timeout(fn, ms)
        if (typeof cancel === 'function') return cancel
      } catch (error) { /* the fiber is gone; the host's own timer still works */ }
      const handle = setTimeout(fn, ms)
      return () => clearTimeout(handle)
    }

    /** Wait, without letting a disposed fiber turn the wait into a failure. */
    function sleep(ms) {
      return new Promise((resolve) => { armTimeout(resolve, ms) })
    }

    /**
     * Claude's tool names mapped onto dsh's own.
     *
     * `tool.call.toolview` is a keyed slot matched on the exact tool name, so a
     * call logged as "Bash" misses every renderer the deployment already has for
     * "bash" — dsh's built-in row, and third-party ones like dsh-better-tool-ui.
     * The two vocabularies share their argument shapes almost exactly
     * (`command`, `file_path`, `old_string`/`new_string`, `pattern`, `url`,
     * `query`, `todos`), so logging dsh's name is a rename, not a lie about what
     * ran — and it also lets dsh's own presenters produce the rich terminal /
     * diff / read / search cards for Claude's calls.
     *
     * Tools with no dsh counterpart keep Claude's name and this plugin's row.
     */
    const DSH_TOOL_NAMES = {
      Bash: 'bash',
      Read: 'read',
      Write: 'write',
      Edit: 'edit',
      Grep: 'grep',
      Glob: 'glob',
      WebFetch: 'web_fetch',
      WebSearch: 'web_search',
      TodoWrite: 'todo_write',
      Skill: 'skill',
    }
    /** The only argument key that differs between the two vocabularies. */
    const ARG_RENAMES = { Grep: { glob: 'include' } }

    function dshToolName(name) {
      const mapped = DSH_TOOL_NAMES[name]
      return mapped === undefined ? name : mapped
    }

    function dshToolArgs(name, args) {
      const renames = ARG_RENAMES[name]
      if (renames === undefined || args === null || typeof args !== 'object') return args
      const out = {}
      for (const key of Object.keys(args)) out[renames[key] === undefined ? key : renames[key]] = args[key]
      return out
    }

    // ---------- projection: product stream -> dsh session events ----------

    function blockTypeOf(type) {
      if (type === 'text') return 'text'
      if (type === 'thinking' || type === 'redacted_thinking') return 'reasoning'
      if (type === 'tool_use' || type === 'server_tool_use' || type === 'mcp_tool_use') return 'tool-call'
      return undefined
    }

    function assistantBlocksOf(content) {
      const blocks = []
      for (const block of content || []) {
        const kind = blockTypeOf(block.type)
        if (kind === 'text') blocks.push({ type: 'text', text: typeof block.text === 'string' ? block.text : '' })
        else if (kind === 'reasoning') blocks.push({ type: 'reasoning', text: typeof block.thinking === 'string' ? block.thinking : '' })
        else if (kind === 'tool-call') {
          const productName = typeof block.name === 'string' ? block.name : ''
          blocks.push({
            type: 'tool-call',
            id: typeof block.id === 'string' ? block.id : '',
            name: dshToolName(productName),
            arguments: JSON.stringify(dshToolArgs(productName, block.input === undefined ? {} : block.input)),
          })
        }
      }
      return blocks
    }

    function resultBlocksOf(content) {
      if (typeof content === 'string') return [{ type: 'text', text: content }]
      if (!Array.isArray(content)) return [{ type: 'text', text: '' }]
      return content.map((block) => {
        if (block !== null && typeof block === 'object' && typeof block.type === 'string') {
          if (block.type === 'text' && typeof block.text === 'string') return { type: 'text', text: block.text }
          return { type: 'text', text: '[' + block.type + ']' }
        }
        return { type: 'text', text: '' }
      })
    }

    function tokenUsageOf(usage) {
      if (usage === null || typeof usage !== 'object') return undefined
      const out = { inputTokens: usage.input_tokens || 0, outputTokens: usage.output_tokens || 0 }
      if (usage.cache_read_input_tokens != null) out.cacheReadTokens = usage.cache_read_input_tokens
      if (usage.cache_creation_input_tokens != null) out.cacheWriteTokens = usage.cache_creation_input_tokens
      return out
    }

    function finishedBlock(block) {
      if (block.blockType === 'reasoning') return { type: 'reasoning', text: block.text }
      if (block.blockType === 'tool-call') return { type: 'tool-call', id: block.callId, name: block.name, arguments: block.argumentsJson }
      return { type: 'text', text: block.text }
    }

    // One turn's steps. A dsh step = one product assistant message plus the
    // results of the tools it asked for — the built-in loop's own bracket.
    function createTranscript(session, turn) {
      let stepNumber = 0
      let open
      // Every call id this turn has already answered. Parallel tool calls make
      // the CLI emit the first finished result on its own and then again inside
      // the complete tool_result array it sends to the API, so the same id
      // arrives twice. dsh's chat node treats a second result for one call as a
      // protocol error — the card breaks and the transcript stops rendering
      // from there. One result per call, whoever writes it.
      const answered = new Set()
      // Calls announced but not yet answered, and the step each was announced
      // in — so a result that arrives after its step closed still lands on the
      // card it belongs to instead of the step that happens to be open.
      const pending = new Map()
      // Whether this turn put any model text on screen. A one-shot command that
      // answers in its `result` alone must not leave an empty turn behind.
      let loggedAssistant = false

      /**
       * Close the current step. A tool call still running is NOT settled here.
       *
       * It used to be, and that quietly lost results: Claude starts the next
       * assistant message — a new step — while an earlier call is still
       * running, which is ordinary for parallel calls. Settling on the step
       * boundary stamped that live call "这次调用没有等到结果", and the real
       * result, arriving a second later, was then dropped as a duplicate. A
       * call belongs to the turn, not to the step it was announced in.
       */
      function closeStep() {
        if (open === undefined) return
        // A step that streamed but never settled into an assistant/message —
        // interrupted, failed, retried — still has to put its stream somewhere,
        // or those bytes leave no trace at all. That is what `assistant/attempt`
        // is: a settled attempt that committed no surface message.
        if (open.assistantLogged !== true && open.stream.length > 0) {
          session.append('assistant/attempt', { turn: turn, step: open.step, stream: open.stream })
        }
        session.append('step/end', { turn: turn, step: open.step })
        open = undefined
      }

      /**
       * End the turn, and never leave a tool call unanswered.
       *
       * The model-visible surface pairs every assistant tool call with its
       * result; DeepSeek rejects a history where one is missing
       * ("An assistant message with 'tool_calls' must be followed by tool
       * messages"). A turn cut short between `tool/call` and `tool/result` —
       * a cancel, a plugin reload, a crash — used to leave exactly that, and
       * it poisoned the conversation for good. So a call that really is never
       * going to be answered gets a result saying it was interrupted — but
       * only once the turn is over, when that is actually true.
       */
      function finish(reason) {
        for (const entry of pending) {
          const call = entry[0]
          if (answered.has(call)) continue
          answered.add(call)
          session.append('tool/result', {
            turn: turn,
            step: entry[1],
            message: {
              id: uuid(),
              role: 'user',
              source: { kind: 'tool', callId: call },
              content: [{
                type: 'tool-result',
                toolCallId: call,
                content: [{ type: 'text', text: reason || '这次调用没有等到结果（轮次被中断）。Claude 侧可能已经执行完成。' }],
                isError: true,
              }],
            },
          }, { surfaceOp: 'append' })
        }
        pending.clear()
        // 轮次收尾：压着的插话必须落地。工具结果可能永远不回来（轮次被打断、
        // 进程没了），那时 pending 是被上面强行补齐的，这条消息不能跟着消失。
        flushDeferredUserMessages(true)
        closeStep()
      }

      function beginStep() {
        closeStep()
        stepNumber += 1
        session.append('step/start', { turn: turn, step: stepNumber })
        open = { step: stepNumber, blocks: new Map(), assistantLogged: false, stream: [], streamAt: 0 }
        return open
      }

      function currentStep() { return open === undefined ? beginStep() : open }

      // ---- the step's embedded model stream ----
      //
      // Up to dsh 0.1.5-rc.1 each chunk was its own `assistant/chunk` event.
      // rc.2 removed that type outright: a step's stream is now EMBEDDED in the
      // `assistant/message` it settles into (or in an `assistant/attempt` when
      // it settles into nothing). A log still carrying `assistant/chunk` is
      // refused wholesale — "unknown to this harness … refusing to interpret
      // the log" — which is why every Claude turn stopped the day dsh updated.
      //
      // The embedded form is compacted: consecutive deltas of the SAME block
      // pack into one run that stores the first chunk's absolute time and then
      // only the gaps between the rest. Everything else rides as a raw record.
      // dsh validates this on read (`expandAssistantStream`), so the shapes
      // below are exact: `dt` is one shorter than its members, a run's keys are
      // exactly the ones listed, and a raw record carries only type/time/chunk.

      /**
       * 这条 assistant 消息该落在哪一步，并且让它的流跟着它走。
       *
       * 一步只落一条消息，所以上一步已经落过时这条要开新的一步。但此刻攒着的
       * 流还在旧的那一步里：`currentStep()` 只问「有没有开着的步」，不问那一步
       * 是不是已经落过消息，于是第二条消息的增量全进了第一条的兜里。结果是
       * 第一条带着不属于它的流，第二条 `stream` 为空——回放时正文一个字的逐字
       * 过程都没有。实测过：reasoning 那条 stream=2，正文那条 stream=0。
       *
       * 所以开新的一步时把攒着的流交接过去；它本来就属于将要写的这条消息。
       * 交接用 splice 清空旧的那一步，这样 closeStep 也不会再为它补一条
       * assistant/attempt。
       */
      function stepForAssistant(open, beginStep) {
        if (open !== undefined && open.assistantLogged !== true) return open
        const carried = open === undefined ? [] : open.stream.splice(0)
        const carriedAt = open === undefined ? 0 : open.streamAt
        const step = beginStep()
        step.stream = carried
        step.streamAt = carriedAt
        return step
      }

      /** Which run a delta belongs in, or '' when the chunk is not a delta. */
      function runKindOf(chunk) {
        if (chunk.type === 'text-delta') return 'text-chunks'
        if (chunk.type === 'reasoning-delta') return 'reasoning-chunks'
        if (chunk.type === 'tool-call-delta') return 'tool-call-chunks'
        return ''
      }

      /** The string this delta contributes to its run. */
      function runMemberOf(chunk) {
        const value = chunk.type === 'tool-call-delta' ? chunk.argumentsDelta : chunk.text
        return typeof value === 'string' ? value : ''
      }

      /**
       * May this chunk extend that run?
       *
       * Only when it is the same kind and the same block. A tool call also has
       * to be the same call: `name` arrives on the opening delta and is absent
       * from the rest, so its absence is not a mismatch.
       */
      function extendsRun(record, chunk, kind) {
        if (record === undefined || record.type !== kind || record.index !== chunk.index) return false
        if (kind !== 'tool-call-chunks') return true
        if (record.id !== chunk.id) return false
        return chunk.name === undefined || record.name === chunk.name
      }

      function appendChunk(step, chunk) {
        const time = Date.now()
        const kind = runKindOf(chunk)
        const last = step.stream.length > 0 ? step.stream[step.stream.length - 1] : undefined
        if (kind !== '' && extendsRun(last, chunk, kind)) {
          last.dt.push(time - step.streamAt)
          ;(kind === 'tool-call-chunks' ? last.args : last.texts).push(runMemberOf(chunk))
        } else if (kind === 'text-chunks' || kind === 'reasoning-chunks') {
          step.stream.push({ type: kind, time0: time, index: chunk.index, dt: [], texts: [runMemberOf(chunk)] })
        } else if (kind === 'tool-call-chunks') {
          step.stream.push({
            type: kind,
            time0: time,
            index: chunk.index,
            dt: [],
            id: chunk.id,
            ...(typeof chunk.name === 'string' && chunk.name.length > 0 ? { name: chunk.name } : {}),
            args: [runMemberOf(chunk)],
          })
        } else {
          step.stream.push({ type: 'chunk', time: time, chunk: chunk })
        }
        step.streamAt = time
      }

      function streamEvent(event) {
        if (event === null || typeof event !== 'object') return
        if (event.type === 'message_start') { beginStep(); return }
        if (event.type === 'content_block_start') {
          const blockType = blockTypeOf(event.content_block ? event.content_block.type : '')
          if (blockType === undefined) return
          const step = currentStep()
          const start = event.content_block
          step.blocks.set(event.index, {
            blockType: blockType,
            text: '',
            callId: typeof start.id === 'string' ? start.id : '',
            name: dshToolName(typeof start.name === 'string' ? start.name : ''),
            argumentsJson: '',
          })
          appendChunk(step, { type: 'block-start', index: event.index, blockType: blockType })
          return
        }
        if (event.type === 'content_block_delta') {
          const step = currentStep()
          const block = step.blocks.get(event.index)
          if (block === undefined) return
          const delta = event.delta || {}
          if (delta.type === 'text_delta') {
            block.text += delta.text
            appendChunk(step, { type: 'text-delta', index: event.index, text: delta.text })
          } else if (delta.type === 'thinking_delta') {
            block.text += delta.thinking
            appendChunk(step, { type: 'reasoning-delta', index: event.index, text: delta.thinking })
          } else if (delta.type === 'input_json_delta') {
            block.argumentsJson += delta.partial_json
            appendChunk(step, {
              type: 'tool-call-delta',
              index: event.index,
              id: block.callId,
              name: block.name,
              argumentsDelta: delta.partial_json,
            })
          }
          return
        }
        if (event.type === 'content_block_stop') {
          const step = currentStep()
          const block = step.blocks.get(event.index)
          if (block === undefined) return
          step.blocks.delete(event.index)
          appendChunk(step, { type: 'block-end', index: event.index, block: finishedBlock(block) })
        }
      }

      function assistantMessage(message) {
        const step = stepForAssistant(open, beginStep)
        step.assistantLogged = true
        loggedAssistant = true
        const content = assistantBlocksOf(message.content)
        const usage = tokenUsageOf(message.usage)
        session.append(
          'assistant/message',
          {
            turn: turn,
            step: step.step,
            message: {
              id: uuid(),
              role: 'assistant',
              content: content,
              source: { kind: 'model', provider: PROVIDER, model: message.model || 'claude-code' },
            },
            ...(usage === undefined ? {} : { usage: usage }),
            // 写入时就把流从这一步里取走，而不是把数组借给它。
            // 借的话有两处会咬人：这条事件和这一步共用同一个数组，之后任何一次
            // 追加或清空都会改到已经写下去的历史；而且这一步之后新来的增量属于
            // 下一条消息，留在同一个数组里就成了这条的。取走之后，这一步归零，
            // 新增量自然是下一条的（由 stepForAssistant 交接过去）。
            stream: step.stream.splice(0),
          },
          // No `sourceEventSeqs` here, deliberately. It only ever means
          // something for a `replace` op — it declares which surface nodes the
          // replacement shadows — and this is an `append`, which shadows
          // nothing. dsh 0.1.5-rc.2 made that explicit and now REJECTS the
          // pair outright ("assistant/message embeds its source stream and
          // cannot carry sourceEventSeqs"), which took every Claude turn down,
          // local and remote alike, the moment dsh updated itself.
          { surfaceOp: 'append' },
        )
        const calls = []
        for (const block of content) {
          if (block.type !== 'tool-call') continue
          session.append('tool/call', {
            turn: turn,
            step: step.step,
            callId: block.id,
            name: block.name,
            arguments: block.arguments,
          })
          pending.set(block.id, step.step)
          calls.push(block)
        }
        return calls
      }

      // 插话（steering）在工具跑到一半时到达，就不能当场写进转录：那一刻
      // tool/call 已经写下、tool/result 还没回来，夹在中间的 user/message 会把
      // 工具卡片和它的结果劈成两半。所以有未配对的调用时先存着，等配对齐了再写。
      const deferredUserMessages = []

      function hasOpenCalls() { return pending.size > 0 }

      function deferUserMessage(write) {
        if (!hasOpenCalls()) { write(); return }
        deferredUserMessages.push(write)
      }

      function flushDeferredUserMessages(force) {
        if (deferredUserMessages.length === 0) return
        if (pending.size > 0 && force !== true) return
        for (const write of deferredUserMessages.splice(0)) {
          try { write() } catch (error) { console.error('cc-mode: 补写插话失败:', errorText(error)) }
        }
      }

      function toolResults(message) {
        if (typeof message.content === 'string') return
        for (const block of message.content || []) {
          if (block.type !== 'tool_result') continue
          const announcedIn = pending.get(block.tool_use_id)
          pending.delete(block.tool_use_id)
          if (answered.has(block.tool_use_id)) continue
          answered.add(block.tool_use_id)
          // The step number is bookkeeping — dsh pairs a result to its call by
          // callId — so this keeps writing into whatever step is open, which is
          // the arrangement every rendered conversation so far was built on.
          const step = open !== undefined ? open.step : (announcedIn === undefined ? stepNumber : announcedIn)
          session.append(
            'tool/result',
            {
              turn: turn,
              step: step,
              message: {
                id: uuid(),
                role: 'user',
                source: { kind: 'tool', callId: block.tool_use_id },
                content: [{
                  type: 'tool-result',
                  toolCallId: block.tool_use_id,
                  content: resultBlocksOf(block.content),
                  isError: block.is_error === true,
                }],
              },
            },
            { surfaceOp: 'append' },
          )
        }
      
        // 工具配对齐了，之前压着的插话现在补写出来——它仍在结果之后，
        // 但不会再把工具卡片和结果劈成两半。
        flushDeferredUserMessages()
      }

      function note(text) {
        const step = currentStep()
        session.append('assistant/message', {
          turn: turn,
          step: step.step,
          message: {
            id: uuid(),
            role: 'assistant',
            content: [{ type: 'text', text: text }],
            source: { kind: 'model', provider: PROVIDER, model: NOTICE_MODEL },
          },
          // 这条消息不是模型产出的，没有流；但 dsh 0.1.5-rc.2 要求每条
          // assistant/message 都带 stream，缺了就判整份日志损坏。
          stream: [],
        }, { surfaceOp: 'append' })
      }

      return {
        streamEvent: streamEvent,
        assistantMessage: assistantMessage,
        hadAssistant: () => loggedAssistant,
        toolResults: toolResults,
        hasOpenCalls: hasOpenCalls,
        deferUserMessage: deferUserMessage,
        flushDeferredUserMessages: flushDeferredUserMessages,
        note: note,
        finish: finish,
      }
    }

    /**
     * The `--mcp-config` value that gives one conversation the `agent_*` tools,
     * or null when the multi-agent half is not composed. Added, never strict:
     * the user's own MCP servers must keep working.
     */
    /**
     * Point a callback URL at an address the target can actually reach.
     * @param url - the URL dsh built from its own loopback address.
     * @param remote - the target the process runs on, or null for this machine.
     * @returns the URL with its origin replaced when the target declares one.
     */
    function reachableFromTarget(url, remote) {
      if (remote === null || remote === undefined || remote.dshHost === '') return url
      const schemeAt = url.indexOf('://')
      if (schemeAt < 0) return url
      const pathAt = url.indexOf('/', schemeAt + 3)
      if (pathAt < 0) return url
      const origin = remote.dshHost.indexOf('://') >= 0 ? remote.dshHost : 'http://' + remote.dshHost
      return origin.replace(/\/+$/, '') + url.slice(pathAt)
    }

    async function multiagentMcpConfig(sessionId, remote) {
      const control = ctx.get('multiagentControl')
      if (control === undefined || typeof control.endpoint !== 'function') return null
      let endpoint
      try { endpoint = await control.endpoint(sessionId) } catch (error) { return null }
      if (endpoint === null || endpoint === undefined || typeof endpoint.url !== 'string') return null
      if (remote !== null && remote !== undefined && remote.dshHost === '') {
        console.error('cc-mode: target "' + remote.id + '" declares no dshHost, so the agent-mesh endpoint handed to'
          + ' Claude over there is dsh\'s own loopback address — which on that machine is that machine.'
          + ' The mesh tools will fail to connect (or reach whatever else listens on that port).'
          + ' Set "dshHost": "<host:port reachable from ' + remote.id + '>" on the target.')
      }
      // Claude is pointed at the broker's own hop, not at dsh: the placeholder
      // becomes 127.0.0.1:<port> when the broker binds it. dsh restarts then
      // stop being connection errors inside a tool call — which the CLI reports
      // as the server being gone, after which the model stops using the mesh
      // for the rest of its life. See the hop in broker.mjs.
      //
      // dsh's own bearer stays in mesh.json (0600); the hop adds it upstream.
      // What travels in argv is a DIFFERENT, per-launch secret that only the
      // hop accepts — and it has to be there. A server configured with no
      // `headers.Authorization` sends the CLI down its OAuth path instead:
      // "No token data found", once a second, 1565 times in twenty-six minutes,
      // with the model told its mesh is unreachable the whole while. An
      // explicit header is what turns that off.
      const url = reachableFromTarget(endpoint.url, remote)
      const authority = originOf(url)
      if (authority === '') return { config: JSON.stringify(directMeshConfig(url, endpoint.token)), seed: null }
      const hopToken = uuid().replace(/-/g, '')
      return {
        config: JSON.stringify({
          mcpServers: {
            'dsh-agents': {
              type: 'http',
              url: url.replace(authority, MESH_PLACEHOLDER),
              headers: { Authorization: 'Bearer ' + hopToken },
            },
          },
        }),
        // What the broker needs: where dsh is, dsh's bearer, and the local
        // secret this launch's Claude will present at the hop.
        seed: { origin: authority, token: endpoint.token, local: hopToken },
      }
    }

    /** `http://host:port/path` → `host:port`, or '' when it is not shaped like that. */
    function originOf(url) {
      const schemeAt = String(url).indexOf('://')
      if (schemeAt < 0) return ''
      const rest = String(url).slice(schemeAt + 3)
      const slashAt = rest.indexOf('/')
      return slashAt < 0 ? rest : rest.slice(0, slashAt)
    }

    /** What the config looked like before the hop existed; also the fallback. */
    function directMeshConfig(url, token) {
      return {
        mcpServers: {
          'dsh-agents': { type: 'http', url: url, headers: { Authorization: 'Bearer ' + token } },
        },
      }
    }


    // ---------- the Claude process, owned by a detached broker ----------
    //
    // The plugin never owns the Claude process. A broker does: started
    // detached into its own session, holding Claude's stdin fifo open
    // and appending every stdout line to `out.log`. The plugin ATTACHES by
    // tailing that log from a byte offset and DETACHES by killing only its own
    // reader/writer. So a plugin hot-update, a plugin stop, or a whole dsh
    // restart leaves the turn running, and the next attach picks the stream up
    // exactly where this one stopped reading.
    //
    // Killing Claude is then an explicit act (switching the session back to
    // DSH, or stopping the engine), never a side effect of the plugin's own
    // lifecycle.

    const BYTES = new TextEncoder()
    // Stands in for dsh's host:port in the `--mcp-config` the broker is handed;
    // the broker swaps in its own hop's address before it starts Claude.
    const MESH_PLACEHOLDER = '__CCMODE_MESH__'
    const BROKER_ROOT = '/tmp/ccmode'
    const BROKER_PATH = BROKER_ROOT + '/broker.mjs'
    // How long another dsh's broker directory may sit untouched before this one
    // sweeps it anyway. Long enough that it can only mean that dsh is gone.
    const FOREIGN_REAP_MS = 24 * 60 * 60 * 1000

    // Which dsh this deployment is. Broker directories live in a shared /tmp on
    // the target machine, and more than one dsh can drive that machine: this
    // laptop's dsh reaches into the container over `docker exec`, and the
    // container runs a dsh of its own. To the second one every directory the
    // first created is a conversation it has never heard of — "orphaned" — and
    // its reaper killed those Claudes after five idle minutes and rm -rf'd
    // their directories. The symptom was a conversation that hung the moment
    // you came back to it after a few minutes away: the process it was talking
    // to had been collected by a dsh that had nothing to do with it, eleven
    // times over in one afternoon by the log. So each launch stamps the
    // directory with its owner, and a sweep leaves other people's alone.
    let instanceId = ''
    // Filled in at build time from src/broker.mjs. This used to be a hand-pasted
    // copy of that file, and it did exactly what a hand-pasted copy does: it went
    // stale. Broker fixes were written, built, committed — and never reached a
    // machine, because THIS is the text the plugin actually ships to /tmp/ccmode.
    // The build now generates it, and a test fails if the two ever differ.
    const BROKER_SOURCE = '@@BROKER_SOURCE@@'

    /**
     * A child's stdin raises EPIPE ASYNCHRONOUSLY when the far end is gone, so a
     * try/catch around `.write()` or `.end()` cannot contain it: the unhandled
     * 'error' event takes the whole dsh process down. Every stdin this plugin
     * touches goes through here first. (This is not hypothetical — it crashed
     * dsh-web once, in `detach`.)
     */
    function silenceStdin(proc) {
      if (proc !== undefined && proc !== null && proc.stdin !== undefined && proc.stdin !== null) {
        try { proc.stdin.on('error', () => undefined) } catch (error) { /* not a stream */ }
      }
      return proc
    }

    /**
     * A row the CLI logged as its own bookkeeping rather than as conversation.
     *
     * Two flags because the two sources spell it differently: a transcript row
     * carries `isMeta`, the same message on the stream carries `isSynthetic`.
     * Both are checked everywhere, since a real conversation row carries
     * neither and getting the pairing wrong would be silent.
     *
     * What makes this worth a check of its own: after a turn that printed no
     * text, the CLI injects "[Your previous response had no visible output…]"
     * as a USER message. Projected like any other, it shows up in dsh as
     * something the person said — and it fires precisely when they asked for
     * no output, so it contradicts them in their own voice.
     */
    /**
     * This Session's event log, across the dsh versions that expose it
     * differently.
     *
     * Up to dsh 0.1.1-rc the log was a public array (`session.events`). 0.1.2
     * made it private and serves immutable snapshots instead — a full snapshot
     * is cached until the next append, so asking per read costs nothing. The
     * old shape is still accepted because one deployment upgrading does not
     * upgrade every machine this plugin runs on.
     */
    function sessionEvents(session) {
      if (session === null || session === undefined) return []
      if (typeof session.snapshotEvents === 'function') return session.snapshotEvents()
      return Array.isArray(session.events) ? session.events : []
    }

    function machineryRow(event) {
      return event !== null && event !== undefined
        && (event.isMeta === true || event.isSynthetic === true)
    }

    function shellQuote(value) {
      return "'" + String(value).replace(/'/g, "'\\''") + "'"
    }

    /** What forces a fresh Claude process: posture and effort are launch flags. */
    /**
     * What a running process was launched WITH — a live broker is reused only
     * while this still matches, and relaunched (resuming the same Claude
     * conversation) when it does not.
     *
     * The multi-agent wiring belongs here because it is a launch flag: a
     * process started before that half was composed has no `agent_*` tools and
     * can never gain them, so without this an upgrade would leave every
     * already-running conversation silently without them.
     */
    function launchSnapshot(state) {
      return state.permissionMode + '|' + state.effort
        + (ctx.get('multiagentControl') === undefined ? '' : '|agents')
    }

    /**
     * The directory this conversation's Claude actually runs in.
     *
     * For a local conversation that is the dsh workspace. For one on a target
     * it is a directory over THERE, and the difference decides every
     * `~/.claude/projects/<slug>` path: Claude files its transcript — and the
     * `claude --resume` index row — under the directory the process opened,
     * not under the workspace path dsh happens to display. Getting this wrong
     * writes a well-formed index row that `--resume` can never match.
     *
     * Read from the live run first, then the launch directory recorded on the
     * conversation (a cold one has no run), then the dsh workspace.
     */
    function projectCwd(sessionId, session) {
      const run = runs.get(sessionId)
      if (run !== undefined && typeof run.cwd === 'string' && run.cwd.length > 0) return run.cwd
      const state = states.get(sessionId)
      if (state !== undefined && typeof state.launchCwd === 'string' && state.launchCwd.length > 0) {
        return state.launchCwd
      }
      return session !== undefined && session !== null && session.header ? session.header.cwd : undefined
    }

    /**
     * Warn when the user's own MCP config shadows the per-session mesh endpoint.
     *
     * `--mcp-config` ADDS to the user's servers rather than replacing them, and
     * that is deliberate: a conversation should keep the servers its owner
     * configured. But a `dsh-agent-mesh` entry of their own points at a FIXED
     * handle, exposes the same tool names, and silently wins — so every child
     * this conversation opens is filed under that handle instead of under the
     * conversation. Nothing fails: the children run, and only the notices go
     * nowhere, because a handle names no dsh session to wake. That is a very
     * quiet way to lose a feature, so it is worth one line in the log.
     *
     * Checked once per machine, out of band: a launch must not wait on it.
     */
    const shadowChecked = new Set()
    function warnShadowedMeshConfig(remote) {
      const key = remote === null || remote === undefined ? '' : remote.id
      if (shadowChecked.has(key)) return
      // A hand-written mesh server is the ONLY way to reach dsh from a target
      // that declares no dshHost — telling someone to remove their only working
      // route is worse than saying nothing. Speak up once the injected endpoint
      // is actually usable there.
      if (remote !== null && remote !== undefined && remote.dshHost === '') return
      shadowChecked.add(key)
      const where = key === '' ? 'this machine' : key
      captureOn('cat "$HOME"/.claude.json 2>/dev/null', remote, 8000).then((raw) => {
        let config = null
        try { config = JSON.parse(String(raw)) } catch (error) { return }
        const found = []
        const walk = (node) => {
          if (node === null || typeof node !== 'object') return
          const servers = node.mcpServers
          if (servers !== null && typeof servers === 'object') {
            for (const name of Object.keys(servers)) {
              const entry = servers[name]
              const url = entry !== null && typeof entry === 'object' ? entry.url : undefined
              if (typeof url === 'string' && url.indexOf('/dsh-agent-mesh/mcp/') >= 0) found.push(name + ' -> ' + url)
            }
          }
          for (const value of Object.values(node)) if (value !== servers) walk(value)
        }
        walk(config)
        if (found.length === 0) return
        console.error('cc-mode: an mcpServers entry on ' + where + ' points at the agent-mesh endpoint'
          + ' and will shadow the per-conversation one this plugin injects — children opened from a Claude'
          + ' conversation are then filed under that fixed handle, and their completion notices never reach'
          + ' the conversation. The injected endpoint now reaches dsh from here on its own, so this entry can'
          + ' go (or be renamed so the tool names do not collide): ' + found.join(', '))
      }, () => undefined)
    }

    function sessionDir(sessionId) {
      return BROKER_ROOT + '/' + String(sessionId).replace(/[^A-Za-z0-9_.-]/g, '_')
    }

    /**
     * Write the broker once per machine we drive — it is tiny and idempotent.
     * Keyed by target because a remote needs its own copy over there, and the
     * empty key is this machine.
     */
    const brokerReady = new Map()
    function ensureBroker(remote) {
      const key = remote === null || remote === undefined ? '' : remote.id
      const done = brokerReady.get(key)
      if (done !== undefined) return done
      const started = (async () => {
        const result = await execOn('mkdir -p ' + shellQuote(BROKER_ROOT) + ' && cat > ' + shellQuote(BROKER_PATH),
          remote, 20000, { stdin: BROKER_SOURCE })
        // A broker source that did not land means every launch after this one
        // fails with "the broker never showed up". Say which it was.
        if (result.decided !== true) console.error('cc-mode: broker 源码没写过去（' + result.reason + '）')
        else if (result.code !== null && result.code !== 0) {
          console.error('cc-mode: broker 源码写入失败，退出码', result.code, result.stderr.trim())
        }
      })()
      brokerReady.set(key, started)
      return started
    }

    async function readJsonFile(path, remote) {
      const raw = await captureOn('cat ' + shellQuote(path) + ' 2>/dev/null', remote, 5000)
      try { return JSON.parse(raw) } catch (error) { return null }
    }

    /**
     * Is that pid a process that can still do something?
     *
     * `kill -0` answers "does this pid exist", and a ZOMBIE exists: it has
     * exited, but nobody has reaped it — which in a container whose pid 1 is
     * `sleep infinity` means forever. A broker that died left exactly that
     * behind, `kill -0` said yes, and the plugin re-attached to it and wrote
     * every prompt into a fifo with no reader. The conversation went quiet and
     * stayed quiet. So the STATE matters, not the existence.
     *
     * `ps -o stat=` is the portable spelling (BSD and GNU both take it); a
     * machine without `ps` at all falls back to the existence test, which is
     * the behaviour this had before.
     */
    async function isAlive(pid, remote) {
      if (typeof pid !== 'number' || pid <= 0) return false
      const answer = await captureOn(
        'state=$(ps -o stat= -p ' + pid + ' 2>/dev/null | head -1 | tr -d " "); '
        + 'if [ -n "$state" ]; then case "$state" in Z*) echo no;; *) echo yes;; esac; '
        + 'else kill -0 ' + pid + ' 2>/dev/null && echo yes || echo no; fi', remote, 5000)
      return String(answer).trim().indexOf('yes') === 0
    }

    // `stat -c` is GNU; macOS ships BSD stat (`-f`). Every stat goes through
    // the pair, first flavour that answers wins.
    async function fileSize(path, remote) {
      const answer = await captureOn(
        'stat -c %s ' + shellQuote(path) + ' 2>/dev/null || stat -f %z ' + shellQuote(path) + ' 2>/dev/null || echo 0', remote, 5000)
      const size = parseInt(String(answer).trim(), 10)
      return isNaN(size) ? 0 : size
    }

    /**
     * Size of a path that is ALREADY a shell word (the transcript paths carry
     * their own quoting because "$HOME" must expand). Quoting it again with
     * shellQuote would stat a literal `"$HOME"/...` and silently answer 0 —
     * which is how an import once recorded offset 0 and re-mirrored history.
     */
    async function fileSizeOfShellWord(word, remote) {
      const answer = await captureOn(
        'stat -c %s ' + word + ' 2>/dev/null || stat -f %z ' + word + ' 2>/dev/null || echo 0', remote, 5000)
      const size = parseInt(String(answer).trim(), 10)
      return isNaN(size) ? 0 : size
    }

    /**
     * Does that file exist? 'yes', 'no', or 'unknown' — and 'unknown' is the
     * whole point.
     *
     * `runCapture` never rejects: a command that timed out and one that found
     * nothing both come back as ''. Reading that as "the file is not there" is
     * how a conversation lost its history — the 30MB transcript behind it was
     * sitting right where it always was, a `stat` on a machine at load 80 took
     * longer than its five seconds, and the answer came back empty. The plugin
     * read that as "nothing to resume" and started the conversation over with a
     * brand-new, empty Claude session. So the shell says which it means, in
     * words, and anything else is 'unknown' — never 'no'.
     */
    async function fileExistsOfShellWord(word, remote) {
      const answer = await captureOn(
        'if [ -f ' + word + ' ]; then echo yes; else echo no; fi', remote, 20000)
      const text = String(answer).trim()
      if (text === 'yes') return 'yes'
      if (text === 'no') return 'no'
      return 'unknown'
    }

    function createRun(sessionId, dir, snapshot, claudeSessionId, remote) {
      const run = {
        sessionId: sessionId,
        dir: dir,
        // Where this conversation's Claude lives; null is this machine. Every
        // command the run issues is routed through it.
        remote: remote === undefined ? null : remote,
        snapshot: snapshot,
        claudeSessionId: claudeSessionId,
        cwd: null,
        offset: 0,          // bytes of out.log already consumed
        reader: null,       // our `tail -f`
        queue: [],
        waiter: null,
        closed: false,
        exit: null,
        requestSeq: 0,
        subCallParent: new Map(),
        subCallInfo: new Map(),
        mainCalls: new Set(),
        // The dsh-native mirror of Claude Code background work for THIS run:
        //   ccSubagents  parent_tool_use_id (the Agent/Task tool call id) → the
        //                child-session record mirroring that subagent;
        //   ccTasks      task_id → { job, settle, label } for plain background
        //                tasks, or { child } when the task is an Agent child.
        ccSubagents: new Map(),
        ccTasks: new Map(),
      }

      run.push = (value) => {
        // 计数而不是布尔：看门狗要分辨「这一轮有没有回音」，而不是「这个 run
        // 这辈子收过东西没有」。
        if (value !== undefined) { run.sawAnyMessage = true; run.heard = (run.heard || 0) + 1 }
        run.queue.push(value)
        const waiter = run.waiter
        run.waiter = null
        if (waiter !== null) waiter()
      }

      run.next = async () => {
        while (true) {
          if (run.queue.length > 0) return run.queue.shift()
          if (run.closed) return undefined
          await new Promise((resolve) => {
            let settled = false
            run.waiter = () => { if (settled) return; settled = true; resolve() }
          })
        }
      }

      // One short-lived `cat > in` per message, awaited to completion, chained so
      // order is preserved.
      //
      // A long-lived writer was the earlier design and it lost prompts: when
      // that one child died (a torn-down attach, a reaped process tree) the
      // next `write` went into a dead pipe and the turn simply waited for an
      // answer to a question Claude never heard. A process per message cannot
      // outlive its message, and `cat` exiting is the proof the bytes reached
      // the fifo — the broker holds the read end open, so a small write is
      // atomic and never blocks.
      let writeChain = Promise.resolve()
      run.write = (value) => {
        const line = JSON.stringify(value) + '\n'
        // Most callers (control requests, approval answers) do not await this,
        // so a rejection must never escape as an unhandled one — it is recorded
        // instead, and the turn that cares checks it.
        writeChain = writeChain.then(() => deliverLine(run, line)).catch((error) => {
          run.writeError = errorText(error)
          console.error('cc-mode: 写入 Claude 失败:', run.writeError)
        })
        return writeChain
      }

      run.control = (request) => {
        run.requestSeq += 1
        run.write({ type: 'control_request', request_id: 'ccmode-' + run.requestSeq, request: request })
      }

      return run
    }

    /**
     * Push the conversation's model choice into a live process, once per
     * distinct choice. waku does the same bookkeeping (`current_model` in its
     * writer loop): without it, a re-attach — plugin update, dsh restart —
     * would keep the process on whatever model it launched with and silently
     * ignore what the selector says.
     */
    function applyModel(run, state) {
      // Same reason as the launch flag: on a target that owns its model, a
      // `set_model` would re-point a working conversation at a model its
      // gateway has never heard of.
      if (run.remote !== null && run.remote !== undefined && run.remote.ownModel === true) return
      if (state.model.length === 0 || run.appliedModel === state.model) return
      run.appliedModel = state.model
      try { run.control({ subtype: 'set_model', model: state.model }) } catch (error) {
        console.error('cc-mode: set_model failed:', errorText(error))
      }
    }

    /** Consume the broker's log from `run.offset`, forever, until detached. */
    function pumpAttached(run) {
      const reader = run.reader
      if (reader === null || reader.stdout === undefined) return
      // `tail -c` counts bytes, so the offset must too — and the stream has to
      // decode whole characters or a chunk boundary would corrupt one.
      if (typeof reader.stdout.setEncoding === 'function') reader.stdout.setEncoding('utf8')
      let buffer = ''
      ;(async () => {
        try {
          for await (const chunk of reader.stdout) {
            const text = String(chunk)
            run.offset += BYTES.encode(text).length
            buffer += text
            let index = buffer.indexOf('\n')
            while (index >= 0) {
              const line = buffer.slice(0, index).trim()
              buffer = buffer.slice(index + 1)
              index = buffer.indexOf('\n')
              if (line.length === 0) continue
              let value = null
              try { value = JSON.parse(line) } catch (error) { continue }
              if (value.type === 'cc-stderr') { console.error('cc-mode [claude stderr]', value.text); continue }
              if (value.type === 'cc-exit') {
                run.closed = true
                run.exit = { exitCode: value.exitCode, signal: value.signal }
                run.push(undefined)
                continue
              }
              // Checkpoint at every turn boundary. attach.json used to be
              // written only by a clean detach, so a killed dsh left a stale
              // offset and the next drain replayed a stretch that had already
              // been rendered live — duplicate tool calls whose results then
              // paired across turns, leaving cards spinning forever.
              if (value.type === 'result') {
                run.consumed = run.offset - BYTES.encode(buffer).length
                // Where this round ends, carried on the message itself. The
                // reader between turns projects byte ranges out of out.log, and
                // `run.consumed` is no good to it by the time the message is
                // delivered: the pump drains a whole chunk synchronously, so it
                // has usually run past this round's end — and past the start of
                // the next one — before anyone awaiting `next()` wakes up.
                value.ccmodeOffset = run.consumed
                checkpointOffset(run)
              }
              // An out-of-band command this plugin issued (`/context`, `/mcp`,
              // …) can lose its reader before its answer lands — a write that
              // timed out, a stream that dropped. Those bytes are the plugin's,
              // not the conversation's, and whoever reads next renders them:
              // this is how a `/context` table ended up as turn 4's opening
              // message in a conversation nobody asked it in. The flag is only
              // ever set for a command that was demonstrably written, so the
              // round swallowed here is that command's own.
              if (run.awaitingCommandResult === true) {
                if (value.type === 'result') endPendingCommand(run)
                continue
              }
              run.push(value)
            }
            // What a checkpoint or a detach may record is the last COMPLETE
            // line: run.offset can sit mid-line at a chunk boundary, and an
            // offset that includes half a line makes the next attach resume
            // mid-line — the fragment fails to parse and the whole line
            // (an assistant message, a result) is silently lost.
            run.consumed = run.offset - BYTES.encode(buffer).length
          }
        } catch (error) { /* the reader was detached */ }
        // `tail` ending is not "no more output" — it means this plugin lost its
        // ear on a Claude that is very likely still talking. Waking the turn is
        // what turns a silent hang into one honest failure it can report.
        if (run.detached !== true && !run.closed) {
          run.readerDead = true
          console.error('cc-mode: 读取端断开了（tail 结束），松开这一轮；Claude 进程保留')
          run.push(undefined)
        }
      })()
    }

    /** Forget the out-of-band command a run was still owing an answer for. */
    function endPendingCommand(run) {
      run.awaitingCommandResult = false
      const state = states.get(run.sessionId)
      if (state === undefined || state.pendingCommand === undefined) return
      state.pendingCommand = undefined
      persistStates()
    }

    /**
     * Where the log resumes being the conversation, after an out-of-band
     * command this plugin issued but never saw the end of.
     *
     * A probe (`/context`, `/mcp`, …) is a real exchange in the broker log —
     * the command line and Claude's answer — and the command loop normally
     * hands the next reader an offset past it. When the stream drops the loop
     * hands back nothing, so every recovery path starts in FRONT of the probe
     * and projects its answer as conversation. That is why the command's start
     * is persisted before it is written: this reads forward from the mark to
     * the end of the first `result` line, which is where its round ended.
     *
     * Undefined when nothing is pending, or when the round has not finished —
     * then the mark stays and the next reader asks again.
     */
    async function pastPendingCommand(sessionId) {
      const state = stateOf(sessionId)
      const pending = state.pendingCommand
      if (pending === null || pending === undefined || typeof pending.from !== 'number') return undefined
      const dir = sessionDir(sessionId)
      const remote = remoteOf(state)
      try {
        // A relaunch appends to a log this mark predates, or the log was
        // cleared: the bytes it points at are not the ones it meant.
        const size = await fileSize(dir + '/out.log', remote)
        if (size < pending.from) {
          state.pendingCommand = undefined
          persistStates()
          return undefined
        }
        // Bytes from the mark through the end of the first `result` line.
        // LC_ALL=C because awk's `length` counts characters otherwise, and a
        // Chinese answer would then measure shorter than it is on disk.
        const raw = await captureOn(
          'tail -c +' + (pending.from + 1) + ' ' + shellQuote(dir + '/out.log')
          + ' | LC_ALL=C awk \'{ n += length($0) + 1 } /"type":"result"/ { print n; exit }\'', remote, 15000)
        const span = parseInt(String(raw).trim(), 10)
        if (isNaN(span) || span <= 0) return undefined
        state.pendingCommand = undefined
        persistStates()
        console.log('cc-mode:', sessionId, 'skipped', span, 'bytes of',
          pending.command, 'output that never reached this plugin')
        return pending.from + span
      } catch (error) {
        console.error('cc-mode: could not measure an abandoned command:', errorText(error))
        return undefined
      }
    }

    /** Record how far this attach has consumed, so a hard kill cannot lie. */
    function checkpointOffset(run) {
      if (run.checkpointing === true) return
      run.checkpointing = true
      const offset = typeof run.consumed === 'number' ? run.consumed : run.offset
      execOn('cat > ' + shellQuote(run.dir + '/attach.json'), run.remote, 10000,
        { stdin: JSON.stringify({ offset: offset }) })
        .then(() => { run.checkpointing = false }, () => { run.checkpointing = false })
    }

    /**
     * `deliverLine` over a daemon.
     *
     * The one hop that can fail ambiguously is this one: the connection drops
     * and we cannot know whether the line reached the fifo. Retrying blind
     * would risk sending the same prompt twice; not retrying turns a blip in
     * the tunnel into a turn the person has to notice and redo. So the write
     * carries an idempotency key, the daemon records it before answering, and
     * the retry is free — a second attempt either performs the write or is
     * told the first one already did.
     *
     * The key is minted PER CALL and means nothing outside it. That is not
     * laziness — a derived key is what broke this the first time. The key was
     * `sessionId:deliverSeq:byteLength`, and `deliverSeq` is a counter on the
     * run object: re-attaching to a live Claude builds a new run and resets it
     * to zero. A permission answer is a fixed-shape JSON whose length is always
     * the same (`{"behavior":"allow"}` plus a 36-character request id), so the
     * second run's second write computed the SAME key as the first run's —
     * the daemon recognised a duplicate, returned the cached result, and never
     * wrote to the fifo. Claude sat waiting for an approval that had been
     * granted, the tool never ran, and the turn span forever with nothing in
     * any log saying why.
     *
     * A fresh id per call cannot collide, and a retry inside this call reuses
     * it — which is the entire scope the guarantee was ever needed for.
     */
    async function deliverLineViaDaemon(run, line) {
      const key = 'deliver-' + uuid()
      const payload = run.pipeDirty === true ? '\n' + line : line
      let last = ''
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const result = await execOn('cat > ' + shellQuote(run.dir + '/in'), run.remote, 10000,
          { stdin: payload, idemKey: key })
        if (result.decided === true && result.timedOut !== true) {
          if (result.code !== null && result.code !== 0) {
            run.pipeDirty = true
            throw new Error('cc-mode: 写入 Claude 的输入管道失败（退出码 ' + result.code + '）' + result.stderr.trim())
          }
          run.pipeDirty = false
          return
        }
        // A write that timed out may have left half a line in the fifo; the
        // next one prefixes a newline so the stump dies as its own unparseable
        // line instead of corrupting the front of the next message.
        if (result.timedOut === true) { run.pipeDirty = true; break }
        last = result.reason
      }
      run.pipeDirty = true
      throw new Error('cc-mode: 写入 Claude 的输入管道没成功' + (last.length > 0 ? '（' + last + '）' : '（10 秒超时）'))
    }

    /** Put one line into a run's fifo and wait until it is actually in. */
    async function deliverLine(run, line) {
      if (usesDaemon(run.remote)) return deliverLineViaDaemon(run, line)
      const writer = silenceStdin(subprocess.spawn({
        argv: shArgv('cat > ' + shellQuote(run.dir + '/in'), run.remote),
        cwd: '/',
        stdio: { stdin: 'pipe', stdout: 'ignore', stderr: 'ignore' },
        graceMs: 1000,
      }))
      if (writer === null || writer === undefined || writer.stdin === undefined) {
        throw new Error('cc-mode: 没有连上 Claude 的输入管道')
      }
      // A writer terminated on timeout may have left half a line in the fifo
      // (a multi-megabyte image message writes in many chunks). A leading
      // newline turns that stump into one unparseable line the CLI drops,
      // instead of letting it corrupt the front of THIS message.
      writer.stdin.write(run.pipeDirty === true ? '\n' + line : line)
      writer.stdin.end()
      let timer = null
      const expired = new Promise((resolve) => { timer = armTimeout(() => resolve('timeout'), 10000) })
      const outcome = await Promise.race([writer.done.then(() => 'done', () => 'done'), expired])
      try { timer() } catch (error) { /* already fired */ }
      if (outcome === 'timeout') {
        run.pipeDirty = true
        writer.terminate()
        throw new Error('cc-mode: 写入 Claude 的输入管道超时（10 秒）')
      }
      run.pipeDirty = false
    }

    /** Attach this plugin to a live broker: one tail in, one cat out. */
    async function attach(run) {
      run.consumed = run.offset
      if (usesDaemon(run.remote)) {
        // One long response instead of a `tail -f` at the end of a shell hop.
        // The offset is the same number either way — `tail -c +N` counts from
        // one, the daemon counts from zero, and this is the zero.
        let link = null
        try { link = await ensureDaemon(run.remote) } catch (error) {
          console.error('cc-mode: 连不上 cc-daemon，这一轮没有读取端:', errorText(error))
          run.readerDead = true
          run.push(undefined)
          return
        }
        run.reader = daemonTail(link, run.dir + '/out.log', run.offset)
      } else {
        run.reader = subprocess.spawn({
          // `exec` so no shell lingers around the tail for the life of the run.
          argv: shArgv('exec tail -c +' + (run.offset + 1) + ' -f ' + shellQuote(run.dir + '/out.log'), run.remote),
          cwd: '/',
          stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' },
          graceMs: 1000,
        })
      }
      pumpAttached(run)
    }

    /** Let go of the process without ending it. */
    /**
     * 还听得见这个 run 吗。
     *
     * broker 活着不等于我们还听得见它：读取器会单独死掉——隧道断了、daemon 那
     * 头关了连接、轮次之间的读取器静默超时后主动把流放掉——而 run 对象还留在
     * `runs` 里。拿到这样一个空壳，prompt 照样写得进 fifo（Claude 真的开始干
     * 活了），但回来的路是断的：这一轮永远等不到 result，页面上一个字都没有，
     * 日志里也没有，因为什么都没出错。
     *
     * 实测现场：一轮跑完后读取器静默释放了流，下一条消息拿到空壳 run，Claude
     * 在那头输出了 700KB，dsh 这边二十分钟一片空白。`runs.has` 还会因此挡住
     * `resumeIdleFollow`，连自愈的路也堵上。
     */
    function hearsRun(run) {
      if (run === undefined || run === null) return false
      if (run.detached === true || run.readerDead === true) return false
      return run.reader !== null && run.reader !== undefined
    }

    function detach(sessionId, remember) {
      return safely('detach', () => detachInner(sessionId, remember)) === true
    }

    function detachInner(sessionId, remember) {
      const run = runs.get(sessionId)
      if (run === undefined) return false
      // Teardown runs inside a cordis disposer: anything thrown here escapes
      // into the runtime, so nothing in this function may throw.
      runs.delete(sessionId)
      const reader = run.reader
      run.reader = null
      run.detached = true
      if (reader !== null) reader.terminate()
      run.push(undefined)
      if (remember !== false && shuttingDown !== true) {
        // Where to resume reading next time, so a detach loses nothing. The
        // consumed mark, not run.offset: the raw offset can include half a
        // line still sitting in the pump's buffer.
        const patch = JSON.stringify({ offset: typeof run.consumed === 'number' ? run.consumed : run.offset })
        // Not awaited and never allowed to throw: this runs inside a cordis
        // disposer, where anything thrown escapes into the runtime.
        try {
          execOn('cat > ' + shellQuote(run.dir + '/attach.json'), run.remote, 10000, { stdin: patch })
            .catch(() => undefined)
        } catch (error) { /* the offset falls back to EOF */ }
      }
      // The mirror follows the run: pending subagent children are persisted as
      // settled (their partial log stands), open job rows are left to the jobs
      // registry's owner cleanup.
      cleanupCcMirror(run)
      return true
    }

    /**
     * The Claude session this conversation was forked from, if any.
     *
     * dsh's fork copies the transcript events and records `parentSession` in
     * the header — it knows nothing about this plugin, so the Claude behind
     * the conversation is not branched with it. Left alone, the new
     * conversation displays a complete history to a model that has never seen
     * a line of it; asked about the conversation above it, the fork answers
     * 「我这边没有任何上下文」 while the screen says otherwise.
     *
     * Returns null whenever branching is not possible, which always degrades
     * to today's behaviour (a fresh Claude) rather than a broken launch.
     */
    async function parentClaudeSession(sessionId, cwd, remote) {
      const session = sessionOf(sessionId)
      const header = session === undefined ? undefined : session.header
      const parent = header === undefined ? undefined : header.parentSession
      if (typeof parent !== 'string' || parent.length === 0) return null
      const parentState = states.get(parent)
      const parentId = parentState === undefined ? undefined : parentState.claudeSessionId
      if (typeof parentId !== 'string' || parentId.length === 0) return null
      // `--resume` is fatal against a transcript that is not on disk, and this
      // one belongs to another conversation — it may have been cleaned up.
      const transcript = '"$HOME"/.claude/projects/' + shellQuote(projectSlug(cwd))
        + '/' + shellQuote(parentId + '.jsonl')
      if (await fileSizeOfShellWord(transcript, remote) <= 0) {
        console.log('cc-mode:', sessionId, 'was forked from', parent,
          'but that Claude transcript is gone — starting fresh')
        return null
      }
      return parentId
    }

    async function ensureRun(sessionId, cwd, signal) {
      const state = stateOf(sessionId)
      const remote = remoteOf(state)
      // The dsh workspace path names a directory on THIS machine, so a remote
      // conversation cannot open in it. Everything downstream — the transcript
      // slug, the launch's `cd`, run.cwd — follows from this one substitution.
      if (remote !== null) cwd = await remoteCwdOf(state, remote)
      const snapshot = launchSnapshot(state)
      const live = runs.get(sessionId)
      if (live !== undefined && !live.closed && live.snapshot === snapshot && hearsRun(live)) {
        // The broker can disappear underneath a run: the reaper collects an
        // idle one, or somethingexternal kills it. The run object survives with a
        // reader tailing a deleted log and a writer whose `cat > .../in`
        // silently recreates the fifo path as an ordinary file — the prompt
        // then goes nowhere and the turn waits forever. One `kill -0` per turn
        // is cheap insurance.
        if (await isAlive(live.brokerPid, remote)) return live
        console.log('cc-mode: the broker for', sessionId, 'is gone — starting a fresh Claude and resuming')
        detach(sessionId)
      }

      const dir = sessionDir(sessionId)
      await ensureBroker(remote)

      // Is a broker for this session already running, from before an update or
      // a restart? Then attach instead of starting a second Claude.
      const meta = await readJsonFile(dir + '/meta.json', remote)
      const exited = await readJsonFile(dir + '/exit.json', remote)
      const brokerLives = meta !== null && exited === null && await isAlive(meta.brokerPid, remote)
      const sameLaunch = meta !== null && meta.snapshot === snapshot

      if (live !== undefined) detach(sessionId)

      if (brokerLives && sameLaunch) {
        const attachState = await readJsonFile(dir + '/attach.json', remote)
        const run = createRun(sessionId, dir, snapshot, meta.claudeSessionId, remote)
        run.brokerPid = meta.brokerPid
        run.cwd = meta.cwd || cwd
        // A clean detach recorded where it stopped; a crash did not, and then
        // resuming at the end is right — everything before it is already in the
        // dsh transcript.
        run.offset = attachState !== null && typeof attachState.offset === 'number'
          ? attachState.offset
          : await fileSize(dir + '/out.log', remote)
        // A probe that lost its reader left its own round in the log ahead of
        // this offset. Resuming in front of it is what renders a `/context`
        // table as the first thing the next turn says.
        const pastCommand = await pastPendingCommand(sessionId)
        if (typeof pastCommand === 'number' && pastCommand > run.offset) run.offset = pastCommand
        runs.set(sessionId, run)
        await attach(run)
        // The broker's process launched under some earlier model choice; the
        // durable per-conversation choice wins over whatever that was.
        applyModel(run, state)
        if (typeof run.claudeSessionId === 'string' && run.claudeSessionId.length > 0) {
          state.claudeSessionId = run.claudeSessionId
          persistStates()
        }
        await recoverRoute(run, state)
        console.log('cc-mode: re-attached to the live Claude for', sessionId, '(session ' + run.claudeSessionId + ')')
        return run
      }

      // Nothing usable is running: retire whatever is left and start fresh.
      if (meta !== null) await captureOn(
        'kill ' + (typeof meta.brokerPid === 'number' ? meta.brokerPid : 0) + ' 2>/dev/null; '
        + 'kill ' + (typeof meta.childPid === 'number' ? meta.childPid : 0) + ' 2>/dev/null; true', remote, 5000)

      // A remote's `claude` is resolved by ITS login shell, not by our PATH —
      // resolveExecutable would answer with a path on this machine.
      const executable = remote === null ? await subprocess.resolveExecutable('claude') : remote.claudeBin
      if (signal !== undefined) signal.throwIfAborted()

      // Resuming is what makes an older conversation continue where it left
      // off: prefer the id the dead broker recorded, else the durable one.
      let resume = meta !== null && typeof meta.claudeSessionId === 'string' && meta.claudeSessionId.length > 0
        ? meta.claudeSessionId
        : (typeof state.claudeSessionId === 'string' && state.claudeSessionId.length > 0 ? state.claudeSessionId : null)
      // `--resume` is fatal when that transcript is not on disk: the CLI says
      // "No conversation found with session ID …" and exits, which surfaces
      // as error_during_execution on the first turn — forever, since the id
      // stays recorded. And a recorded id without a transcript is a real
      // state: pre-1.5.1 macOS launches persisted the id before the broker
      // ever ran. Resume only what exists; otherwise start FRESH under a new
      // id (re-using the dead id with --session-id could collide with a
      // same-id transcript under some other project directory).
      if (resume !== null) {
        const transcript = '"$HOME"/.claude/projects/' + shellQuote(projectSlug(cwd)) + '/' + shellQuote(resume + '.jsonl')
        // Only a definite "no" may cost a conversation its history. If the
        // check cannot answer, RESUME: `--resume` against a missing transcript
        // is one loud failed turn that the operator can see and retry, while
        // not resuming silently replaces the conversation's Claude with an
        // empty one — and the transcript, if it was there, stays orphaned.
        const exists = await fileExistsOfShellWord(transcript, remote)
        if (exists === 'no') {
          console.log('cc-mode: recorded Claude session', resume, 'has no transcript on disk — starting a fresh one')
          resume = null
        } else if (exists === 'unknown') {
          console.error('cc-mode: could not tell whether the transcript for', resume, 'exists —'
            + ' resuming anyway rather than starting this conversation over with an empty Claude.'
            + ' A loaded machine timing out that check is the usual cause.')
        }
      }
      // Nothing to resume, but dsh may have forked this conversation out of
      // one that does have a Claude behind it. Branch that instead of opening
      // a blank one under a transcript full of someone else's history.
      const forkFrom = resume === null ? await parentClaudeSession(sessionId, cwd, remote) : null
      const claudeSessionId = resume === null ? uuid() : resume
      const argv = [
        executable, '-p',
        '--input-format', 'stream-json',
        '--output-format', 'stream-json',
        '--verbose',
        '--include-partial-messages',
        '--thinking-display', 'summarized',
        '--replay-user-messages',
        '--permission-prompt-tool', 'stdio',
        '--permission-mode', state.permissionMode,
      ]
      if (state.model.length > 0 && !(remote !== null && remote !== undefined && remote.ownModel === true)) {
        argv.push('--model', state.model)
      }
      if (state.effort.length > 0) argv.push('--effort', state.effort)
      // Multi-agent: hand this conversation the tools that open and drive OTHER
      // dsh conversations. The endpoint is addressed per conversation, so the
      // process cannot act as anyone but itself — which is why this is wired at
      // launch rather than left to the user's global MCP config.
      // `--mcp-config` is VARIADIC: it keeps eating arguments until the next
      // flag, so it must never sit immediately before a positional. Here it is
      // followed by `--session-id`/`--resume`, which stops it.
      const agents = await multiagentMcpConfig(sessionId, remote)
      if (agents !== null) warnShadowedMeshConfig(remote)
      if (agents !== null) argv.push('--mcp-config', agents.config)
      // A direct config (no origin to stand in for) must not leave a stale seed
      // behind that a later launch would read.
      const meshSeedJson = agents === null || agents.seed === null ? null : JSON.stringify(agents.seed)
      if (forkFrom !== null) {
        // The three compose, verified against the CLI: it resumes the parent,
        // branches instead of writing back into it, and takes the id we hand
        // it — so meta.json and the durable state can record the child up
        // front rather than waiting for the init handshake to reveal it.
        argv.push('--resume', forkFrom, '--fork-session', '--session-id', claudeSessionId)
        console.log('cc-mode:', sessionId, 'branches Claude session', forkFrom, 'into', claudeSessionId)
      } else {
        argv.push(resume === null ? '--session-id' : '--resume', claudeSessionId)
      }

      const env = state.permissionMode === 'bypassPermissions' ? { IS_SANDBOX: '1' } : undefined
      const metaSeed = JSON.stringify({
        claudeSessionId: claudeSessionId,
        snapshot: snapshot,
        cwd: cwd,
        model: state.model,
        seededAt: Date.now(),
      })
      // `setsid(1)` is util-linux — macOS does not ship it, and the old
      // `setsid nohup node …` therefore never started the broker there: the
      // fifo had no reader and every prompt died as a 10s pipe-write timeout.
      // Node's own `detached: true` IS setsid(2) on every POSIX platform, so a
      // one-line launcher puts the broker in its own session portably. The
      // node binary is dsh's own (`process.execPath`), not whatever PATH has —
      // a pm2/GUI environment on macOS often has no `node` on PATH at all.
      const nodeBin = remote !== null
        ? remote.nodeBin
        : (typeof process !== 'undefined' && typeof process.execPath === 'string' && process.execPath.length > 0
          ? process.execPath
          : 'node')
      const detachLauncher = 'const cp=require("child_process");'
        + 'cp.spawn(process.execPath,process.argv.slice(1),{detached:true,stdio:"ignore"}).unref()'
      const launch = 'set -e; '
        + 'mkdir -p ' + shellQuote(dir) + '; '
        + 'rm -f ' + shellQuote(dir + '/exit.json') + ' ' + shellQuote(dir + '/attach.json') + '; '
        + '[ -p ' + shellQuote(dir + '/in') + ' ] || mkfifo ' + shellQuote(dir + '/in') + '; '
        + 'touch ' + shellQuote(dir + '/out.log') + '; '
        // Whose broker this is. Written every launch (not just the first) so a
        // directory adopted from an older build gets a name too.
        + 'printf %s ' + shellQuote(instanceId) + ' > ' + shellQuote(dir + '/owner') + '; '
        // The broker's hop reads this; nobody else should. Written before the
        // broker starts, because it decides there whether to bind a hop at all.
        + (meshSeedJson === null ? 'rm -f ' + shellQuote(dir + '/mesh.json') + '; '
          : 'printf %s ' + shellQuote(meshSeedJson) + ' > ' + shellQuote(dir + '/mesh.json') + '; '
            + 'chmod 600 ' + shellQuote(dir + '/mesh.json') + '; ')
        + 'printf %s ' + shellQuote(metaSeed) + ' > ' + shellQuote(dir + '/meta.json') + '; '
        + 'mkdir -p ' + shellQuote(cwd) + '; cd ' + shellQuote(cwd) + '; '
        + shellQuote(nodeBin) + ' -e ' + shellQuote(detachLauncher) + ' ' + shellQuote(BROKER_PATH) + ' ' + shellQuote(dir) + ' '
        + argv.map(shellQuote).join(' ')
        + '; echo started'

      // A remote launch cannot carry `env` through the local spawn (that would
      // set it on the ssh client) and cannot start in `cwd` (that directory is
      // over there) — the script already cd's, so the assignment rides in it.
      // Where THIS process's output will begin. `out.log` is append-only and
      // survives a relaunch, so a fresh run that started reading at 0 would
      // re-project the previous process's whole conversation. Measured BEFORE
      // the spawn on purpose: taking it afterwards races the child's own
      // `init` line, and losing that line loses the model and session binding.
      const priorLog = await fileSize(dir + '/out.log', remote)
      const launchCommand = remote === null || env === undefined
        ? launch
        : Object.keys(env).map((name) => name + '=' + shellQuote(env[name])).join(' ') + ' ' + launch
      if (usesDaemon(remote)) {
        // The script detaches the broker and returns; one exec is the whole of
        // it, and — unlike the spawn below — a launch that never ran says so
        // with a reason instead of an empty stream.
        const result = await execOn(launchCommand, remote, 60000)
        if (result.decided !== true) {
          console.error('cc-mode [launch] 目标机没答复:', result.reason)
        } else {
          const noise = result.stderr.trim()
          if (noise.length > 0) console.error('cc-mode [launch]', noise)
          if (result.timedOut === true) console.error('cc-mode [launch] 启动脚本超时了（60 秒）')
          else if (result.code !== null && result.code !== 0) console.error('cc-mode [launch] 启动脚本退出码', result.code)
        }
      } else {
        const started = subprocess.spawn({
          argv: shArgv(launchCommand, remote),
          cwd: remote === null ? cwd : '/',
          stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
          graceMs: 3000,
          ...(env === undefined || remote !== null ? {} : { env: env }),
        })
        ;(async () => {
          try { for await (const chunk of started.stderr) console.error('cc-mode [launch]', String(chunk).trim()) } catch (error) { /* closed */ }
        })()
        // A launch that never started at all — argv[0] missing, most often —
        // fails HERE, asynchronously and with nothing on stderr. Swallowing it
        // left the operator with only "the broker never showed up", which names
        // the symptom and hides the cause.
        try {
          await started.done
        } catch (error) {
          console.error('cc-mode [launch] could not start ' + shArgv('…', remote)[0] + ':', errorText(error))
        }
      }

      const run = createRun(sessionId, dir, snapshot, claudeSessionId, remote)
      run.cwd = cwd
      // Durable, because a cold conversation has no run to ask and still needs
      // to find its own transcript.
      state.launchCwd = cwd
      rememberDir(remote, cwd, workspaceOf(sessionId))
      run.offset = priorLog
      // A fresh Claude starts reading at the end of the log, which is already
      // past anything an abandoned probe left behind.
      state.pendingCommand = undefined
      const spawned = await readJsonFile(dir + '/meta.json', remote)
      run.brokerPid = spawned === null ? undefined : spawned.brokerPid
      // The launch flags already carry this model; only later changes need a
      // live set_model.
      run.appliedModel = state.model
      state.claudeSessionId = claudeSessionId
      persistStates()
      runs.set(sessionId, run)
      await attach(run)

      // The broker writes its pid into meta as soon as it has a child. If it
      // never does, the launch failed — say so NOW, with the launch stderr in
      // the log to read, instead of letting the first fifo write time out ten
      // opaque seconds later (which is how the missing-setsid failure on macOS
      // read: "写入 Claude 的输入管道超时").
      let waited = 0
      let seeded = null
      while (waited < 5000) {
        seeded = await readJsonFile(dir + '/meta.json', remote)
        if (seeded !== null && typeof seeded.childPid === 'number') break
        await sleep(200)
        waited += 200
      }
      if (seeded === null || typeof seeded.childPid !== 'number') {
        detach(sessionId, false)
        throw new Error('cc-mode: Claude 没有启动起来（5 秒内 broker 未就位）。'
          + '看 dsh 日志里的 "cc-mode [launch]" 行；常见原因是 node/claude 不在 dsh 进程的 PATH 里。')
      }
      run.brokerPid = typeof seeded.brokerPid === 'number' ? seeded.brokerPid : run.brokerPid
      console.log('cc-mode: claude started for', sessionId, '[' + snapshot + (state.model ? '|' + state.model : '') + ']', 'in', cwd)
      return run
    }

    /**
     * Reap brokers nobody is coming back to.
     *
     * Surviving a detach is the point, but a session committed to Claude can
     * never be switched back to DSH, so without this a broker would outlive
     * every reason to exist. A directory whose log has not moved for hours and
     * which this process is not attached to is done.
     */
    // An idle Claude is a whole Node process (hundreds of MB). Six hours was
    // far too generous on a small machine: brokers for conversations nobody
    // had touched in hours sat in RAM and swap. Forty-five minutes still
    // survives a lunch break, a dsh restart, and any plugin update, and the
    // conversation resumes from ~/.claude with --resume anyway — the cost of
    // reaping is one process start on the next message, not lost context.
    const IDLE_REAP_MS = 45 * 60 * 1000

    async function reapIdleBrokers() {
      // Brokers accumulate on every machine this deployment drives, so the
      // sweep visits each target as well as this one. A target that is
      // unreachable right now simply reports nothing and is retried next time.
      for (const remote of [null, ...REMOTES.values()]) {
        try { await reapIdleBrokersOn(remote) } catch (error) {
          console.error('cc-mode: broker sweep failed on '
            + (remote === null ? 'this machine' : remote.id) + ':', errorText(error))
        }
      }
    }

    async function reapIdleBrokersOn(remote) {
      const listing = await captureOn(
        'for d in ' + shellQuote(BROKER_ROOT) + '/session-*; do '
        + '[ -d "$d" ] || continue; '
        + 'echo "$d|$(stat -c %Y "$d/out.log" 2>/dev/null || stat -f %m "$d/out.log" 2>/dev/null || echo 0)'
        + '|$(cat "$d/owner" 2>/dev/null)"; done', remote, 8000)
      const now = Date.now()
      // Sessions dsh still knows about. A broker for a conversation that no
      // longer exists (deleted, or from an older dsh state) is pure waste and
      // goes as soon as it is idle at all.
      const alive = new Set()
      if (agents !== undefined) {
        try { for (const agent of agents.list()) alive.add(String(agent.id)) } catch (error) { /* keep the age rule */ }
      }
      for (const line of String(listing).split('\n')) {
        const parts = line.trim().split('|')
        if (parts.length < 2 || parts[0].length === 0) continue
        const dir = parts[0]
        const touchedAt = parseInt(parts[1], 10) * 1000
        if (isNaN(touchedAt)) continue
        const owner = parts.length > 2 ? parts[2].trim() : ''
        const idleMs = now - touchedAt
        // Another dsh's broker. Not ours to judge: the conversation behind it
        // is live on a screen we cannot see, and the age rules below would read
        // it as an orphan and collect it after five minutes. Only a directory
        // that has been silent for a day is swept regardless of owner, so a dsh
        // that was uninstalled cannot leave /tmp growing forever.
        if (owner.length > 0 && owner !== instanceId) {
          if (idleMs < FOREIGN_REAP_MS) continue
          console.log('cc-mode: sweeping a broker left by another dsh (' + owner + ') —',
            'idle', Math.round(idleMs / 3600000), 'h')
        }
        // "Orphaned" must mean the conversation is GONE, not that nobody is
        // looking at it. `agents.list()` answers the second question: dsh
        // unloads an idle agent, so a conversation you simply left alone drops
        // out of it within minutes. Judging orphanhood by attachment therefore
        // collected the broker of every conversation not on screen after five
        // minutes instead of the intended forty-five — the process behind a
        // conversation kept vanishing while its owner was reading something
        // else. The durable per-conversation state is the honest existence
        // test: it is restored from disk at startup and holds every
        // conversation this plugin has ever driven.
        const dirSessionId = dir.slice(BROKER_ROOT.length + 1)
        const known = states.has(dirSessionId) || alive.has(dirSessionId)
        const orphaned = !known
        if (idleMs < (orphaned ? 5 * 60 * 1000 : IDLE_REAP_MS)) continue
        const sessionId = dir.slice(BROKER_ROOT.length + 1)
        if (runs.has(sessionId)) continue
        if (activeTurns.has(sessionId)) continue
        const meta = await readJsonFile(dir + '/meta.json', remote)
        if (meta !== null) {
          await captureOn(
            'kill ' + (typeof meta.childPid === 'number' ? meta.childPid : 0) + ' 2>/dev/null; '
            + 'kill ' + (typeof meta.brokerPid === 'number' ? meta.brokerPid : 0) + ' 2>/dev/null; true', remote, 5000)
        }
        await captureOn('rm -rf ' + shellQuote(dir), remote, 5000)
        console.log('cc-mode: reaped a Claude broker for', sessionId,
          '— idle', Math.round(idleMs / 60000), 'min'
          + (orphaned ? ', no live dsh session' : '') + (remote === null ? '' : ' @ ' + remote.id))
      }
    }

    /** End the Claude process for good — an explicit act, never a side effect. */
    async function stopRun(sessionId) {
      const dir = sessionDir(sessionId)
      const remote = remoteOf(stateOf(sessionId))
      detach(sessionId, false)
      const meta = await readJsonFile(dir + '/meta.json', remote)
      if (meta === null) return false
      await captureOn(
        'kill ' + (typeof meta.childPid === 'number' ? meta.childPid : 0) + ' 2>/dev/null; '
        + 'kill ' + (typeof meta.brokerPid === 'number' ? meta.brokerPid : 0) + ' 2>/dev/null; '
        + 'rm -f ' + shellQuote(dir + '/meta.json') + '; true', remote, 5000)
      console.log('cc-mode: stopped Claude for', sessionId)
      return true
    }

    /** Run a command and collect its stdout. Used for the two files/APIs that
     *  the cordis services cannot reach: Claude's own credential file and the
     *  OAuth usage endpoint (the web capability cannot send an Authorization
     *  header, so `curl` carries it instead). */
    function runCapture(argv, timeoutMs) {
      return new Promise((resolve) => {
        let output = ''
        let settled = false
        const finish = (value) => { if (!settled) { settled = true; resolve(value) } }
        let proc
        try {
          proc = subprocess.spawn({
            argv: argv,
            cwd: '/',
            stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' },
            graceMs: 2000,
          })
        } catch (error) { finish(''); return }
        ;(async () => {
          try { for await (const chunk of proc.stdout) output += String(chunk) } catch (error) { /* closed */ }
        })()
        proc.done.then(() => finish(output), () => finish(output))
        armTimeout(() => { try { proc.terminate() } catch (error) { /* gone */ } finish(output) }, timeoutMs || 20000)
      })
    }

    /**
     * `claude --resume` lists the prompt index at `~/.claude/history.jsonl`, not
     * the transcripts — a `-p` session writes the transcript but never that row,
     * which is why a dsh-driven conversation was invisible in the terminal. The
     * row is appended through `sh -c 'cat >>'` because that file is appended
     * concurrently by every other live Claude process: a single short line
     * through O_APPEND cannot interleave, while a read-modify-write would drop
     * their rows.
     */
    function recordPromptHistory(cwd, claudeSessionId, prompt, remote) {
      if (typeof claudeSessionId !== 'string' || claudeSessionId.length === 0) return
      const row = JSON.stringify({
        display: prompt,
        pastedContents: {},
        timestamp: Date.now(),
        project: cwd,
        sessionId: claudeSessionId,
      })
      try {
        execOn('mkdir -p "$HOME/.claude" && cat >> "$HOME/.claude/history.jsonl"', remote, 10000, { stdin: row + '\n' })
          .catch(() => undefined)
      } catch (error) {
        console.error('cc-mode: could not record the prompt in Claude history:', errorText(error))
      }
    }

    // Claude's usage windows, in the order the readout shows them.
    const USAGE_WINDOWS = [
      { id: 'five_hour', label: '5h' },
      { id: 'seven_day', label: '7d' },
      { id: 'seven_day_opus', label: '7d Opus' },
      { id: 'seven_day_sonnet', label: '7d Sonnet' },
    ]

    // One reading per machine: the subscription belongs to the account that
    // machine is logged into, so a conversation on a target must not be shown
    // this host's windows — nor wait out this host's reset.
    const usageByTarget = new Map()
    function usageCellOf(remote) {
      const key = remote === null || remote === undefined ? '' : remote.id
      let cell = usageByTarget.get(key)
      if (cell === undefined) {
        cell = { at: 0, value: null, inflight: null }
        usageByTarget.set(key, cell)
      }
      return cell
    }

    /**
     * The probe that runs ON a target.
     *
     * Deliberately the whole thing — credentials, gateway check, and the HTTP
     * call — rather than reading the credential file back and calling from
     * here: the access token then never leaves the machine it belongs to. Node
     * is already a requirement over there (the broker is a node script), so
     * this costs no new dependency and one round trip instead of three.
     */
    const REMOTE_USAGE_PROBE = '(async()=>{const fs=require("fs");const out=(v)=>process.stdout.write(JSON.stringify(v));let c=null;try{c=JSON.parse(fs.readFileSync(process.env.HOME+"/.claude/.credentials.json","utf8"))}catch(e){}const o=c&&c.claudeAiOauth;if(!o||typeof o.accessToken!=="string"||typeof o.subscriptionType!=="string")return out({skip:"no-oauth-subscription"});if(((process.env.ANTHROPIC_BASE_URL||"")+(process.env.ANTHROPIC_AUTH_TOKEN||"")+(process.env.ANTHROPIC_API_KEY||"")).length>0)return out({skip:"gateway-override"});try{const r=await fetch("https://api.anthropic.com/api/oauth/usage",{headers:{Authorization:"Bearer "+o.accessToken,"anthropic-beta":"oauth-2025-04-20",Accept:"application/json"}});out({subscription:o.subscriptionType,tier:typeof o.rateLimitTier==="string"?o.rateLimitTier:null,body:await r.text()})}catch(e){out({subscription:o.subscriptionType,tier:null,error:String((e&&e.message)||e)})}})()'

    async function remoteUsageSource(remote) {
      const raw = await captureOn(
        shellQuote(remote.nodeBin) + ' -e ' + shellQuote(REMOTE_USAGE_PROBE), remote, 25000)
      let answer = null
      try { answer = JSON.parse(String(raw).trim()) } catch (error) { answer = null }
      if (answer === null) {
        return { done: { official: true, error: '在 ' + remote.id + ' 上读用量没有返回结果' } }
      }
      if (typeof answer.skip === 'string') return { done: { official: false, reason: answer.skip } }
      if (typeof answer.error === 'string') {
        return { done: { official: true, subscription: answer.subscription, error: answer.error } }
      }
      let parsed = null
      try { parsed = JSON.parse(answer.body) } catch (error) { parsed = null }
      return { oauth: { subscriptionType: answer.subscription, rateLimitTier: answer.tier }, parsed: parsed }
    }

    async function localUsageSource() {
      const credentialsRaw = await runCapture(['/bin/sh', '-c', 'cat "$HOME/.claude/.credentials.json" 2>/dev/null'], 8000)
      let credentials = null
      try { credentials = JSON.parse(credentialsRaw) } catch (error) { credentials = null }
      const oauth = credentials === null ? undefined : credentials.claudeAiOauth
      if (oauth === undefined || typeof oauth.accessToken !== 'string' || typeof oauth.subscriptionType !== 'string') {
        // API key, third-party gateway, or no login: nothing subscription-shaped to show.
        return { done: { official: false, reason: 'no-oauth-subscription' } }
      }
      const overrides = (await runCapture(['/bin/sh', '-c', 'echo "$ANTHROPIC_BASE_URL|$ANTHROPIC_AUTH_TOKEN|$ANTHROPIC_API_KEY"'], 5000)).trim()
      if (overrides.replace(/\|/g, '').length > 0) {
        return { done: { official: false, reason: 'gateway-override' } }
      }
      const body = await runCapture([
        '/usr/bin/env', 'curl', '-s', '--max-time', '15',
        '-H', 'Authorization: Bearer ' + oauth.accessToken,
        '-H', 'anthropic-beta: oauth-2025-04-20',
        '-H', 'Accept: application/json',
        'https://api.anthropic.com/api/oauth/usage',
      ], 20000)
      let parsed = null
      try { parsed = JSON.parse(body) } catch (error) { parsed = null }
      return { oauth: oauth, parsed: parsed }
    }

    async function loadUsage(remote) {
      const source = remote === null || remote === undefined
        ? await localUsageSource()
        : await remoteUsageSource(remote)
      if (source.done !== undefined) return source.done
      const oauth = source.oauth
      const parsed = source.parsed
      // A refusal is JSON too: `{"error":{"type":"rate_limit_error",...}}` parses
      // fine and then yields zero windows, which downstream reads as "this
      // account has no windows" rather than "ask again later". Say which it is.
      if (parsed === null || typeof parsed !== 'object' || parsed.error !== undefined) {
        const failure = parsed !== null && typeof parsed === 'object' && parsed.error !== null
          && typeof parsed.error === 'object' ? parsed.error : {}
        const message = typeof failure.message === 'string' ? failure.message : 'usage endpoint unavailable'
        // An auth failure is not "ask again later": no amount of waiting fixes
        // it, so the caller needs to tell it apart from a flaky endpoint.
        const kind = failure.type === 'authentication_error' || failure.type === 'permission_error'
          ? 'auth'
          : undefined
        return {
          official: true,
          subscription: oauth.subscriptionType,
          error: message,
          ...(kind === undefined ? {} : { errorKind: kind }),
        }
      }
      const windows = []
      for (const window of USAGE_WINDOWS) {
        const entry = parsed[window.id]
        if (entry === null || entry === undefined || typeof entry.utilization !== 'number') continue
        windows.push({
          id: window.id,
          label: window.label,
          utilization: entry.utilization,
          resetsAt: typeof entry.resets_at === 'string' ? entry.resets_at : null,
        })
      }
      // An official subscription always reports at least the 5h window; none at
      // all means the response was not a usage reading, whatever its shape.
      if (windows.length === 0) {
        return { official: true, subscription: oauth.subscriptionType, error: 'usage endpoint returned no windows' }
      }
      const extra = parsed.extra_usage
      return {
        official: true,
        subscription: oauth.subscriptionType,
        rateLimitTier: typeof oauth.rateLimitTier === 'string' ? oauth.rateLimitTier : null,
        windows: windows,
        ...(extra && extra.is_enabled === true && typeof extra.utilization === 'number'
          ? { extra: { utilization: extra.utilization, currency: extra.currency || null } }
          : {}),
        fetchedAt: Date.now(),
      }
    }

    /**
     * Whether a failed reading is one that waiting cannot fix.
     *
     * A flaky endpoint is worth another poll; a rejected token is not — it
     * stays rejected until someone logs in again, and a quota wait that keeps
     * polling it holds the turn for the whole window for nothing.
     */
    function usageAuthFailure(value) {
      if (value === null || typeof value !== 'object') return false
      if (value.errorKind === 'auth') return true
      const text = typeof value.error === 'string' ? value.error.toLowerCase() : ''
      return text.indexOf('revoked') >= 0 || text.indexOf('unauthorized') >= 0
        || text.indexOf('authentication') >= 0
    }

    /** A reading, as opposed to "ask again later". */
    function usageReadable(value) {
      return value !== null && typeof value === 'object' && value.error === undefined
    }

    function usageSnapshot(force, remote) {
      const usage = usageCellOf(remote)
      // The endpoint rate-limits, and Claude Code's own TUI is hitting it from
      // the same account. Backing off for five minutes after a refusal keeps a
      // 20s client poll from turning one 429 into a stream of them; a good
      // reading still ages out in a minute.
      const ttl = usageReadable(usage.value) ? 60000 : 5 * 60000
      const fresh = Date.now() - usage.at < ttl
      if (!force && fresh && usage.value !== null) return Promise.resolve(usage.value)
      // Even a forced refetch honours a recent refusal: a model calling
      // `claude_usage(refresh: true)` in a loop must not become the reason the
      // endpoint keeps refusing.
      if (force && usage.value !== null && !usageReadable(usage.value) && Date.now() - usage.at < 60000) {
        return Promise.resolve(usage.value)
      }
      if (usage.inflight !== null) return usage.inflight
      usage.inflight = loadUsage(remote).then((value) => {
        usage.at = Date.now()
        usage.value = value
        usage.inflight = null
        return value
      }, (error) => {
        usage.inflight = null
        const value = { official: true, error: errorText(error) }
        usage.value = value
        usage.at = Date.now()
        return value
      })
      return usage.inflight
    }

    // ---------- the usage limit, waited out instead of reported ----------
    //
    // Claude Code's own TUI holds a turn that ran out of subscription quota and
    // picks the task back up by itself once the window resets — the
    // `autoContinueAtUsageLimit` setting, "Usage limit reached · continuing
    // automatically". That behaviour lives entirely in its interactive app
    // layer: the `-p --output-format stream-json` process this plugin drives
    // has no dialog to show, so the turn simply ended with an error result and
    // the work sat there until someone noticed and retyped.
    //
    // The same behaviour, rebuilt on the seam this plugin already owns: the dsh
    // turn stays open (so cancel, the composer's running state and the broker's
    // idle reaper all keep meaning exactly what they mean), the wait is a state
    // the composer reports, and what resumes the work is the very prompt
    // Claude's TUI hands itself.

    /** Claude Code's own continuation prompts, verbatim. */
    const QUOTA_RESUME_PROMPT = 'Your claude.ai usage limit has reset. Continue the task you were working on when the limit was reached; do not repeat work that is already complete.'
    const QUOTA_EARLY_PROMPT = 'Your claude.ai usage is available again before the usage-limit reset. Continue the task you were working on when the limit was reached; do not repeat work that is already complete.'
    // Past a day out a wait stops being a wait; the TUI refuses that one too.
    const QUOTA_WAIT_HORIZON_MS = 24 * 60 * 60 * 1000
    // Quota can come back before the window resets. Cheap to look: the reading
    // is one HTTP call every few minutes against a wait measured in hours.
    const QUOTA_POLL_MS = 5 * 60 * 1000
    // Resume a beat AFTER the stated reset — the window is not always free on
    // the exact second, and a resume that fails re-enters this wait for nothing.
    const QUOTA_SETTLE_MS = 20 * 1000
    // Cancel has to feel like a button, not like a poll.
    const QUOTA_TICK_MS = 2000
    // A turn that keeps landing on the limit is not making progress; stop
    // rather than ping-pong against the window for a day.
    const QUOTA_MAX_CONTINUES = 3
    // Holding a turn is only defensible while we KNOW the quota is spent. Three
    // consecutive unreadable polls (a quarter hour) is long enough to call it:
    // let the turn go and hit the real limit itself, which at least reports
    // something true, instead of sitting out a window on a guess.
    const QUOTA_UNREADABLE_GIVE_UP = 3

    // sessionId -> the wait the composer is showing.
    const quotaWaits = new Map()

    /**
     * The window to wait on: spent, and with a reset still ahead of us. When
     * several are spent the nearest reset wins — it is the one that decides
     * when work can start again.
     */
    function spentWindow(snapshot) {
      if (snapshot === null || snapshot === undefined) return null
      if (snapshot.official !== true || !Array.isArray(snapshot.windows)) return null
      const now = Date.now()
      let found = null
      for (const window of snapshot.windows) {
        if (typeof window.utilization !== 'number' || window.utilization < 99) continue
        const at = typeof window.resetsAt === 'string' ? Date.parse(window.resetsAt) : NaN
        if (!isFinite(at) || at <= now) continue
        if (found === null || at < found.at) found = { id: window.id, label: window.label, at: at }
      }
      return found
    }

    /**
     * Did this failed turn fail for want of quota?
     *
     * The account's own usage windows answer that — not the wording of the
     * error. A window at the line with a reset time is the one failure worth
     * sitting out, and it stays a fact when a future CLI release phrases its
     * error differently. Forced, because the cached reading is precisely the
     * one taken before the turn spent the window.
     */
    async function quotaLimitHit(remote) {
      let snapshot
      try { snapshot = await usageSnapshot(true, remote) } catch (error) { return null }
      return spentWindow(snapshot)
    }

    /** What the composer shows while a turn is held. */
    function quotaWaitOf(sessionId) {
      const wait = quotaWaits.get(sessionId)
      if (wait === undefined) return null
      return { label: wait.label, resetsAt: new Date(wait.at).toISOString(), since: wait.since }
    }

    /** Let go of a wait — the user asked, or spoke for themselves instead. */
    function cancelQuotaWait(sessionId, reason) {
      const wait = quotaWaits.get(sessionId)
      if (wait === undefined) return false
      wait.settle(reason)
      console.log('cc-mode: quota wait on', sessionId, 'cancelled —', reason)
      return true
    }

    /** A reset time as it is actually read: local wall clock. */
    function clockText(at) {
      const date = new Date(at)
      try { return date.toLocaleString(undefined, { hour: '2-digit', minute: '2-digit' }) }
      catch (error) { return date.toISOString() }
    }

    /**
     * Hold this turn until the quota is back, then hand Claude the prompt its
     * own TUI would have handed it.
     *
     * Returns true when the turn should keep reading the stream — a
     * continuation went in, or the user interjected one of their own. The turn
     * is never re-opened later and never started on the plugin's own account:
     * this is the turn the person started, still running, still cancellable.
     */
    async function waitOutQuota(sessionId, transcript, run, hit, signal) {
      if (hit.at - Date.now() > QUOTA_WAIT_HORIZON_MS) {
        transcript.note('⚠ 已达 Claude 用量上限（' + hit.label + '）· 重置在 ' + clockText(hit.at)
          + '，超过 24 小时 —— 这一轮不会自动继续')
        return false
      }

      let settled = null
      const wait = {
        label: hit.label,
        at: hit.at,
        since: Date.now(),
        // What the user typed while the turn was held. Speaking is NOT a
        // cancel: the task was already given, and a message added while
        // waiting is more of the same task — it rides the continuation
        // instead of racing Claude into the limit a second time.
        held: [],
        note: transcript.note,
        settle: (reason) => { if (settled === null) settled = reason },
      }
      quotaWaits.set(sessionId, wait)
      const onAbort = () => wait.settle('cancelled')
      signal.addEventListener('abort', onAbort)
      transcript.note('⏳ 已达 Claude 用量上限（' + hit.label + '）· 将在 ' + clockText(hit.at)
        + ' 自动继续（按停止可取消）')

      try {
        let polledAt = Date.now()
        let unreadable = 0
        while (settled === null) {
          if (signal.aborted || shuttingDown) { wait.settle('cancelled'); break }
          const now = Date.now()
          if (now >= wait.at + QUOTA_SETTLE_MS) { wait.settle('reset'); break }
          if (now - polledAt >= QUOTA_POLL_MS) {
            polledAt = now
            const snapshot = await usageSnapshot(true, run.remote)
            // An unreachable usage endpoint is not quota coming back: only a
            // reading that actually carries windows may end the wait early.
            const readable = snapshot !== null && snapshot.official === true
              && Array.isArray(snapshot.windows) && snapshot.windows.length > 0
            if (readable) {
              unreadable = 0
              const still = spentWindow(snapshot)
              if (still === null) { wait.settle('early'); break }
              // The nearest reset can move to another window (7d behind 5h).
              wait.at = still.at
              wait.label = still.label
            } else if (usageAuthFailure(snapshot)) {
              // Waiting cannot fix a rejected token, and every further poll is
              // another five minutes of holding a turn for no reason.
              wait.settle('unreadable')
              break
            } else {
              // A reading that carries no windows says nothing about the quota.
              // Before this, such a poll was simply skipped — so one transient
              // failure could pin the wait on its ORIGINAL reset time forever,
              // because the only code that moves `wait.at` lives in the branch
              // that was skipped. A run of them now ends the wait instead.
              unreadable += 1
              if (unreadable >= QUOTA_UNREADABLE_GIVE_UP) { wait.settle('unreadable'); break }
            }
          }
          await sleep(QUOTA_TICK_MS)
        }
      } finally {
        signal.removeEventListener('abort', onAbort)
        quotaWaits.delete(sessionId)
      }

      if (settled !== 'reset' && settled !== 'early') {
        if (settled === 'unreadable') {
          transcript.note('■ 读不到这台机器的 Claude 用量，不再干等 —— 这一轮没有自动继续。'
            + '（用量读数失败不等于额度用完；直接再发一次，撞上真的上限会如实报错。）'
            + (wait.held.length > 0 ? '等待期间的 ' + wait.held.length + ' 条消息没有发出。' : ''))
        } else if (!signal.aborted && !shuttingDown) {
          transcript.note('■ 已取消等待用量恢复'
            + (wait.held.length > 0 ? '（等待期间的 ' + wait.held.length + ' 条消息没有发出）' : ''))
        }
        return false
      }

      transcript.note((settled === 'early' ? '▶ 用量提前恢复 · 自动继续' : '▶ 用量已恢复 · 自动继续')
        + (wait.held.length > 0 ? '（带上等待期间你说的 ' + wait.held.length + ' 条）' : ''))
      // Claude's own prompt first — it is what tells the model not to redo
      // finished work — then whatever the user added while waiting.
      let content = [{ type: 'text', text: settled === 'early' ? QUOTA_EARLY_PROMPT : QUOTA_RESUME_PROMPT }]
      for (const blocks of wait.held) content = content.concat(blocks)
      try {
        await run.write({
          type: 'user',
          message: { role: 'user', content: content },
          parent_tool_use_id: null,
        })
        if (run.writeError !== undefined) throw new Error(run.writeError)
      } catch (error) {
        transcript.note('⚠ 用量恢复了，但这一轮没能续上：' + errorText(error))
        return false
      }
      console.log('cc-mode: quota back on', sessionId, '— continued the held turn with',
        wait.held.length, 'message(s) typed during the wait')
      return true
    }

    // ---------- Claude's own slash commands ----------
    //
    // The authoritative list arrives in the init handshake, which only happens
    // once a session actually starts — so it is cached durably and served to
    // brand-new conversations too. Until this machine has run Claude once, the
    // built-in set below stands in.
    // Only names the CLI actually serves over stream-json. Its TUI-only
    // commands (`btw`, `status`, `resume`, `login`, `theme`, … — every
    // `local-jsx` definition) are not advertised in the init handshake and
    // answer "isn't available in this environment" when sent, so offering them
    // would be offering rows that cannot work.
    const FALLBACK_COMMANDS = [
      'agents', 'clear', 'compact', 'config', 'context', 'doctor', 'effort',
      'init', 'mcp', 'model', 'usage',
    ]
    // Slash commands are whatever the CLI on THAT machine reports in its init
    // handshake, and a machine can have custom ones the others do not — so the
    // roster is remembered per machine instead of the last handshake winning.
    // The empty key is this machine, which is also the shape the pre-target
    // state file stored.
    let commandCache = new Map()

    function rememberCommands(list, remote) {
      if (!Array.isArray(list) || list.length === 0) return
      const names = list.filter((name) => typeof name === 'string' && name.length > 0)
      const key = remote === null || remote === undefined ? '' : remote.id
      if (names.length === 0 || names.join(',') === (commandCache.get(key) || []).join(',')) return
      commandCache.set(key, names)
      persistStates()
    }

    // Images pasted into a Claude conversation's composer, waiting for the
    // next prompt. dsh's own prompt RPC refuses images when the session's dsh
    // model lacks vision — a gate that knows nothing about the Claude engine —
    // so the client stashes pasted images here and the next turn carries them.
    const pendingImages = new Map()

    async function stashImage(sessionId, mediaType, data) {
      if (attachments === undefined || typeof attachments.saveImage !== 'function') {
        throw new Error('cc-mode: 附件服务不可用，无法暂存图片')
      }
      const bytes = Buffer.from(String(data), 'base64')
      if (bytes.length === 0) throw new Error('cc-mode: 空图片')
      const ref = await attachments.saveImage({ data: new Uint8Array(bytes), mediaType: String(mediaType || 'image/png') })
      const list = pendingImages.get(sessionId) || []
      list.push({ attachment: ref, mediaType: String(mediaType || 'image/png'), data: String(data) })
      pendingImages.set(sessionId, list)
      return list.length
    }

    // Claude's own built-ins that answer immediately, with no model call: the
    // terminal renders these as a panel, not as something the assistant said.
    // Everything else — the `prompt` built-ins and the markdown/plugin commands
    // under ~/.claude — really is a conversation opener and goes through a turn.
    // (Taken from the CLI bundle's own command table, `type:"local"`.)
    /**
     * 插件自己发给 Claude 的探测命令。
     *
     * `/context` 由 probeContextWindow 自动发（每次启动、每次换模型），`/mcp`
     * 由握手读取发——都走带外通道，人从来没敲过。Claude Code 仍然把它们当成
     * 普通的用户消息写进 transcript，于是导入一段对话时，这些问和答会作为
     * 「用户说的话」冒出来：一条谁也没发过的 /context，后面跟一张上下文表格。
     *
     * 实时链路上插件靠 awaitingCommandResult 把整个回合吞掉；transcript 里没有
     * 那个标记，所以投影时按命令名认。带语义的命令（/compact、/clear 之类）
     * 留着——它们解释了后面的内容为什么变了。
     */
    const PROBE_COMMANDS = new Set(['/context', '/mcp'])

    const ONE_SHOT_COMMANDS = new Set([
      '__remote-workflow', 'agents', 'auto-mode-setup', 'autocompact', 'clear', 'color', 'compact',
      'config', 'context', 'design', 'design-consent', 'design-revoke', 'effort', 'extra-usage',
      'fast', 'goal', 'heapdump', 'import', 'list-agents', 'mcp', 'model', 'recap', 'reload-skills',
      'rename', 'ultrareview', 'usage', 'usage-credits', 'workflow-launch-exec',
    ])

    // One consumer of a run's stream at a time. `activeTurns` plus a borrowed
    // map used to be the only guards, but both were set AFTER an await — a
    // turn starting right as the previous turn's /context probe kicked off
    // could pass the probe's checks in that gap (and vice versa), and the two
    // then split one queue between them: the probe loop even swallows
    // control_request lines it was never meant to see. This lock is taken
    // SYNCHRONOUSLY, so queue position is settled before anything yields.
    const sessionLocks = new Map()

    function acquireSessionLock(sessionId) {
      const prev = (sessionLocks.get(sessionId) || Promise.resolve()).catch(() => undefined)
      let release
      const held = new Promise((resolve) => { release = resolve })
      sessionLocks.set(sessionId, prev.then(() => held))
      return { acquired: prev, release: release }
    }

    /** The last handshake this session's Claude sent, from memory or its log. */
    async function lastHandshake(sessionId) {
      const run = runs.get(sessionId)
      if (run !== undefined && run.init !== undefined) return run.init
      const path = sessionDir(sessionId) + '/out.log'
      const raw = await captureOn(
        'grep -a \'"subtype":"init"\' ' + shellQuote(path) + ' 2>/dev/null | tail -1', remoteOf(stateOf(sessionId)), 8000)
      const line = String(raw).trim()
      if (line.length === 0) return undefined
      try { return JSON.parse(line) } catch (error) { return undefined }
    }

    /**
     * Where each MCP server is configured, the way the terminal groups them:
     * the project's own entry in ~/.claude.json versus the user-wide one.
     */
    async function mcpScopes(cwd, remote) {
      const raw = await captureOn('cat "$HOME"/.claude.json 2>/dev/null', remote, 8000)
      let config = null
      try { config = JSON.parse(raw) } catch (error) { config = null }
      const scopes = {}
      if (config === null || typeof config !== 'object') return scopes
      const project = config.projects && config.projects[cwd] ? config.projects[cwd].mcpServers : undefined
      for (const name of Object.keys(project || {})) scopes[name] = { scope: 'project', cwd: cwd }
      for (const name of Object.keys(config.mcpServers || {})) {
        if (scopes[name] === undefined) scopes[name] = { scope: 'user' }
      }
      return scopes
    }

    /**
     * Run one of Claude's own one-shot commands on the session's live process
     * and hand the answer back to the caller — no dsh turn, no assistant
     * message, nothing in the transcript. This is how the terminal treats them:
     * `/mcp` or `/context` is a panel you open, not a thing you said.
     */
    // A one-shot command runs on the live process, which the caller does not
    // hold open: `/compact` on a long conversation spends minutes inside the
    // model (measured: 44s on a 23k-token context — this conversation's is two
    // orders larger), and the CLI reports no progress but its own status line.
    // So the RPC starts a job and returns; the panel polls it and shows what
    // Claude is doing. The old design awaited the whole thing behind one fetch
    // with a 90-second cap, which made every `/compact` "fail" in the UI while
    // it went right on compacting in the background.
    const commandJobs = new Map()
    let commandJobSeq = 0
    const COMMAND_DEADLINE_MS = 30 * 60 * 1000

    /** Human wording for the CLI's own status line, when it emits one. */
    function commandStatusText(status) {
      if (status === 'compacting') return '正在压缩上下文…'
      if (typeof status === 'string' && status.length > 0) return status + '…'
      return ''
    }

    /**
     * Run one of Claude's own one-shot commands on the session's live process —
     * no dsh turn, no assistant message, nothing in the transcript. This is how
     * the terminal treats them: `/mcp` or `/context` is a panel you open, not a
     * thing you said. Returns the job handle; poll it with `commandJobState`.
     */
    async function runOneShotCommand(sessionId, cwd, command) {
      if (activeTurns.has(sessionId)) return { busy: true }
      // Reserved synchronously — a turn arriving one microtask later queues
      // behind this command instead of interleaving with it.
      const lock = acquireSessionLock(sessionId)

      commandJobSeq += 1
      const jobId = 'cmd-' + commandJobSeq
      const job = { jobId: jobId, sessionId: sessionId, command: command, startedAt: Date.now(), status: '', done: false, text: '', isError: false }
      commandJobs.set(jobId, job)
      lastCommandWork.delete(sessionId)

      // Where this command's `result` sits, handed to the between-turns reader
      // below: a slash command can leave background work behind too.
      let commandEndsAt
      // Whether the command reached Claude at all, and the run it went to —
      // both only knowable inside the work below, both needed after it.
      let commandWritten = false
      let commandRun

      const work = (async () => {
        await lock.acquired
        // A turn that held the lock before our reservation may still be the
        // reason we waited; if one is somehow open now, reading its stream
        // would split the queue — bail out instead.
        if (activeTurns.has(sessionId)) throw new Error('cc-mode: 会话正在跑一轮，这条命令没有执行')
        // This reads the stream too, so the between-turns reader steps aside.
        await stopIdleDrain(runs.get(sessionId))
        const run = await ensureRun(sessionId, cwd)
        commandRun = run
        // Where this command's own bytes begin, recorded BEFORE it is written.
        // If nothing ever comes back the log still holds the command and its
        // answer, and the mark is the only thing that tells a later reader
        // those bytes were never the conversation's.
        const marked = stateOf(sessionId)
        marked.pendingCommand = {
          from: typeof run.consumed === 'number' ? run.consumed : run.offset,
          command: command,
          at: Date.now(),
        }
        persistStates()
        await run.write({
          type: 'user',
          message: { role: 'user', content: [{ type: 'text', text: command }] },
          parent_tool_use_id: null,
        })
        if (run.writeError !== undefined) throw new Error(run.writeError)
        // Only now is there anything to skip. A write that failed left the
        // command undelivered, so the mark would only make a later reader
        // swallow a round that belongs to the user.
        commandWritten = true

        let spoken = ''
        let compacted
        const deadline = Date.now() + COMMAND_DEADLINE_MS
        while (true) {
          if (Date.now() > deadline) throw new Error('cc-mode: 命令 30 分钟没有返回结果')
          const message = await run.next()
          if (message === undefined) throw new Error('cc-mode: 与 Claude 的连接在命令返回前断开了')
          if (message.type === 'system' && message.subtype === 'init') {
            run.init = message
            rememberCommands(message.slash_commands, run.remote)
            // `/clear` hands the process a NEW session id; without recording
            // it here the durable resume mapping keeps pointing at the
            // pre-clear conversation.
            if (typeof message.session_id === 'string' && message.session_id.length > 0
              && message.session_id !== run.claudeSessionId) {
              run.claudeSessionId = message.session_id
              const state = stateOf(sessionId)
              state.claudeSessionId = message.session_id
              persistStates()
            }
            continue
          }
          if (message.type === 'system' && message.subtype === 'status') {
            job.status = typeof message.status === 'string' ? message.status : ''
            continue
          }
          // `/compact` answers with an empty `result` — everything worth
          // reporting rides this boundary event instead.
          if (message.type === 'system' && message.subtype === 'compact_boundary') {
            compacted = message.compact_metadata || {}
            continue
          }
          if (message.type === 'assistant') {
            for (const block of (message.message && message.message.content) || []) {
              if (block.type === 'text' && typeof block.text === 'string') spoken += block.text
            }
            continue
          }
          if (message.type !== 'result') continue
          commandEndsAt = message.ccmodeOffset
          endPendingCommand(run)
          const resultText = typeof message.result === 'string' ? message.result : ''
          let text = spoken.trim().length > 0 ? spoken : resultText
          if (compacted !== undefined) {
            const before = Number(compacted.pre_tokens) || 0
            const after = Number(compacted.post_tokens) || 0
            const seconds = Math.round((Number(compacted.duration_ms) || 0) / 100) / 10
            text = '上下文已压缩：' + before.toLocaleString('en-US') + ' → ' + after.toLocaleString('en-US')
              + ' tokens（省下 ' + Math.max(0, before - after).toLocaleString('en-US') + '），用时 ' + seconds + 's。'
              + (text.trim().length > 0 ? '\n\n' + text : '')
            const state = stateOf(sessionId)
          }
          return { text: text, isError: message.is_error === true }
        }
      })()

      work.then((answer) => {
        job.text = String((answer && answer.text) || '')
        job.isError = Boolean(answer && answer.isError)
      }, (error) => {
        job.text = errorText(error)
        job.isError = true
      }).then(async () => {
        job.done = true
        job.status = ''
        job.finishedAt = Date.now()
        lock.release()
        let resumeAt = commandEndsAt
        if (resumeAt === undefined) {
          // No `result` reached this side. If the command was written, its
          // round is still coming (or already in the log) and belongs to
          // nobody: tell the live stream to swallow it, and resume the readers
          // past it. If it was never written there is nothing to skip.
          if (commandWritten) {
            if (commandRun !== undefined) commandRun.awaitingCommandResult = true
            resumeAt = await pastPendingCommand(sessionId)
          } else {
            const marked = stateOf(sessionId)
            marked.pendingCommand = undefined
            persistStates()
          }
        }
        // Hand the stream back to the between-turns reader.
        startIdleDrain(sessionId, runs.get(sessionId), resumeAt)
        // A command that rewrites the session (`/compact` replaces the whole
        // history with a summary) grows the transcript without a dsh turn. The
        // mirror measures growth against this offset, so leaving it behind
        // would make it project Claude's compaction summary into the chat.
        skipTranscriptGrowth(sessionId)
        // Panels are transient; the job list must not be.
        setTimeout(() => commandJobs.delete(jobId), 10 * 60 * 1000)
      })

      lastCommandWork.set(sessionId, work)
      return { jobId: jobId }
    }

    // The promise behind the most recent job per session, for the plugin's own
    // out-of-band commands (the context-window probe) which need the answer
    // rather than a handle to poll.
    const lastCommandWork = new Map()

    async function runCommandForPlugin(sessionId, cwd, command) {
      const started = await runOneShotCommand(sessionId, cwd, command)
      if (started === null || started === undefined || started.busy === true) return undefined
      const work = lastCommandWork.get(sessionId)
      return work === undefined ? undefined : work
    }

    function commandJobState(jobId) {
      const job = commandJobs.get(jobId)
      if (job === undefined) return { missing: true }
      return {
        done: job.done,
        text: job.text,
        isError: job.isError,
        status: commandStatusText(job.status),
        elapsedMs: (job.finishedAt || Date.now()) - job.startedAt,
      }
    }

    /**
     * Move the transcript mirror past whatever is on disk right now. Anything
     * this side wrote is already rendered (or deliberately not shown); only what
     * arrives after this point counts as another writer's work.
     */
    function skipTranscriptGrowth(sessionId) {
      const state = stateOf(sessionId)
      const run = runs.get(sessionId)
      const cwd = run !== undefined && typeof run.cwd === 'string' ? run.cwd : ''
      if (typeof state.jsonlOffset !== 'number' || cwd.length === 0) return
      if (typeof state.claudeSessionId !== 'string' || state.claudeSessionId.length === 0) return
      const transcript = '"$HOME"/.claude/projects/' + shellQuote(projectSlug(cwd)) + '/'
        + shellQuote(state.claudeSessionId + '.jsonl')
      fileSizeOfShellWord(transcript, remoteOf(state)).then((size) => {
        if (size > state.jsonlOffset) { state.jsonlOffset = size; persistStates() }
      }).catch(() => undefined)
    }

    function claudeCommands(remote) {
      const key = remote === null || remote === undefined ? '' : remote.id
      const names = commandCache.get(key)
      return names !== undefined && names.length > 0 ? names : FALLBACK_COMMANDS
    }

    // ---------- adopting an existing Claude conversation ----------

    /** Claude stores a project's transcripts under a slug of its path. */
    function projectSlug(cwd) {
      return String(cwd).replace(/[^A-Za-z0-9]/g, '-')
    }

    /**
     * The conversations Claude Code已经 has for this directory, newest first.
     * Read straight from its own transcripts — the same files `claude --resume`
     * lists from.
     */
    /**
     * Full-text search over this directory's Claude transcripts, for the
     * import panel: which conversations mention the query, and a short snippet
     * around the first hit so the row can show WHY it matched. Fixed-string,
     * case-insensitive, done by grep — the transcripts are plain UTF-8 jsonl.
     */
    async function searchClaudeConversations(cwd, query, remote) {
      const dir = '"$HOME"/.claude/projects/' + shellQuote(projectSlug(cwd))
      const needle = String(query || '').trim()
      if (needle.length === 0) return { hits: [] }
      const matched = await captureOn(
        'cd ' + dir + ' 2>/dev/null && grep -liF -- ' + shellQuote(needle) + ' *.jsonl 2>/dev/null | head -20', remote, 15000)
      const hits = []
      for (const name of String(matched).split('\n')) {
        const file = name.trim()
        if (file.length === 0 || !file.endsWith('.jsonl')) continue
        const line = await captureOn(
          'grep -iF -m1 -- ' + shellQuote(needle) + ' ' + dir + '/' + shellQuote(file) + ' 2>/dev/null | head -c 200000', remote, 10000)
        hits.push({
          claudeSessionId: file.replace(/\.jsonl$/, ''),
          snippet: snippetAround(String(line), needle),
        })
      }
      return { hits: hits }
    }

    /** ±60 characters of readable context around the first hit in a raw jsonl line. */
    function snippetAround(line, needle) {
      const at = line.toLowerCase().indexOf(needle.toLowerCase())
      if (at === -1) return ''
      const slice = line.slice(Math.max(0, at - 60), at + needle.length + 60)
      return slice
        .replace(/\\n/g, ' ')
        .replace(/\\"/g, '"')
        .replace(/["{}\[\]]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 140)
    }

    /** 一次列多少份对话。40 曾经把一个只有 49 份的目录切掉了 9 份。 */
    const CONVERSATION_LIST_LIMIT = 120

    /**
     * 列出一个目录下的 Claude 对话。
     *
     * 标题这件事上有两个坑，都踩过：
     *
     * 1. **人工改的名要赢**。`ai-title` 是 Claude 自己起的，每轮都可能重写一条；
     *    `custom-title` 是人用 /rename 定的。两者在文件里交替出现，谁在最后纯属
     *    巧合——所以不能按出现顺序覆盖，必须让 custom-title 优先。
     * 2. **要看最后一条，不是最前**。这里曾经写的是 `grep -m 3`（取最前三条），
     *    于是一份 109MB 的对话在列表里顶着它最早的自动名字，而人在终端里
     *    `claude --resume` 看到的是自己改的那个名字。同一份对话，两个名字，
     *    找不到的人只会以为它没被列出来。
     *
     * 取标题用一趟 awk 而不是 grep：awk 顺序扫完 109MB 只要 ~90ms，比 `tail -n`
     * 从尾部回溯还快（这种日志行很长，tail 找 N 个换行反而吃亏）。
     * 而且一条命令把所有文件都扫了——之前是每个文件一次 captureOn，一个目录
     * 就是四十次 docker exec 往返。
     */
    async function listClaudeConversations(cwd, remote) {
      const dir = '"$HOME"/.claude/projects/' + shellQuote(projectSlug(cwd))
      const listing = await captureOn(
        'for f in ' + dir + '/*.jsonl; do [ -f "$f" ] || continue; '
        + 'echo "$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f")|$(stat -c %s "$f" 2>/dev/null || stat -f %z "$f")|$f"; done '
        + '| sort -rn | head -' + CONVERSATION_LIST_LIMIT, remote, 15000)
      const rows = []
      const byPath = new Map()
      for (const line of String(listing).split('\n')) {
        const parts = line.trim().split('|')
        if (parts.length < 3) continue
        const path = parts.slice(2).join('|')
        const name = path.slice(path.lastIndexOf('/') + 1)
        const row = {
          claudeSessionId: name.replace(/\.jsonl$/, ''),
          path: path,
          updatedAt: parseInt(parts[0], 10) * 1000,
          bytes: parseInt(parts[1], 10),
          title: '',
          firstPrompt: '',
        }
        rows.push(row)
        byPath.set(path, row)
      }
      if (rows.length === 0) return rows

      // 每个文件吐三行，各带一个前缀字母：F=路径、T=最终标题那条 JSON、
      // U=第一条用户消息。不用「一行三列」是因为这些日志里混着控制字符，
      // 一列里带个换行就会把整行撑开、后面按位置解析全部串位；前缀行则怎么
      // 撑都只会多出几行认不出的杂行，跳过即可。
      const awkProgram = 'awk \'' + TITLE_RULES
        + '/"type":"user"/{if(u=="" && length($0)<4000){u=$0}} '
        + 'END{' + TITLE_PICK + 'gsub(/[[:cntrl:]]/," ",u); '
        + 'print "F " FILENAME; if(t!="") print "T " t; if(u!="") print "U " u}\' '
      const script = rows.map((row) => awkProgram + shellQuote(row.path) + ' 2>/dev/null').join('; ')
      const answer = await captureOn(script, remote, 60000)

      let current = null
      for (const line of String(answer).split('\n')) {
        const tag = line.slice(0, 2)
        const body = line.slice(2)
        if (tag === 'F ') { current = byPath.get(body) || null; continue }
        if (current === null) continue
        if (tag === 'T ') { current.title = titleOfLine(body); continue }
        if (tag !== 'U ') continue
        let event = null
        try { event = JSON.parse(body) } catch (error) { continue }
        if (event.type === 'user') current.firstPrompt = textOfClaudeMessage(event.message).slice(0, 120)
      }
      for (const row of rows) {
        if (row.title === '') row.title = row.firstPrompt || row.claudeSessionId.slice(0, 8)
      }
      return rows
    }

    function textOfClaudeMessage(message) {
      if (message === null || message === undefined) return ''
      const content = message.content
      if (typeof content === 'string') return content
      if (!Array.isArray(content)) return ''
      const parts = []
      for (const block of content) {
        if (block === null || typeof block !== 'object') continue
        if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
        else if (block.type === 'thinking') parts.push('[thinking]')
        else if (block.type === 'tool_use') parts.push('› ' + String(block.name || 'tool'))
        else if (block.type === 'tool_result') parts.push('⤶ ' + String(typeof block.content === 'string' ? block.content : '').slice(0, 80))
      }
      return parts.join('\n').trim()
    }

    /**
     * A deep copy with long strings clipped. Clipping the *serialised* form
     * instead would hand the client invalid JSON, and the card would lose its
     * summary — which is exactly what a truncated tool input looked like.
     */
    function clampValue(value, depth) {
      if (typeof value === 'string') return value.length > 4000 ? value.slice(0, 4000) + '…' : value
      if (Array.isArray(value)) return depth > 4 ? [] : value.slice(0, 40).map((item) => clampValue(item, depth + 1))
      if (value !== null && typeof value === 'object') {
        if (depth > 4) return {}
        const copy = {}
        for (const key of Object.keys(value)) copy[key] = clampValue(value[key], depth + 1)
        return copy
      }
      return value
    }

    /**
     * Mirror the terminal side of an imported conversation. While the dsh side
     * has not spoken yet, the import is a pure mirror: whatever the terminal
     * appends to the Claude transcript is projected in as history. The moment
     * the dsh side takes its own turn the Claude session tree forks — two
     * branches cannot merge into one linear transcript — so from then on new
     * terminal messages only produce a one-line notice, never a merge.
     */
    const syncInFlight = new Map()

    function syncImportedTranscript(sessionId, session) {
      if (session === undefined || syncInFlight.has(sessionId)) return Promise.resolve(0)
      const state = stateOf(sessionId, session)
      if (state.mode !== 'claude' || typeof state.jsonlOffset !== 'number') return Promise.resolve(0)
      if (typeof state.claudeSessionId !== 'string' || state.claudeSessionId.length === 0) return Promise.resolve(0)
      if (activeTurns.has(sessionId)) return Promise.resolve(0)
      const cwd = projectCwd(sessionId, session)
      if (typeof cwd !== 'string' || cwd.length === 0) return Promise.resolve(0)

      const work = (async () => {
        const path = '"$HOME"/.claude/projects/' + shellQuote(projectSlug(cwd)) + '/' + shellQuote(state.claudeSessionId + '.jsonl')
        const size = await fileSizeOfShellWord(path, remoteOf(state))
        if (size <= state.jsonlOffset) return 0

        const raw = await captureOn(
          'tail -c +' + (state.jsonlOffset + 1) + ' ' + path + ' | head -c 3000000', remoteOf(state), 20000)
        const text = String(raw)
        // Only whole lines advance the offset — a line the terminal is mid-way
        // through writing stays for the next pass.
        const lastNewline = text.lastIndexOf('\n')
        if (lastNewline === -1) return 0
        const consumed = text.slice(0, lastNewline + 1)
        const newOffset = state.jsonlOffset + BYTES.encode(consumed).length

        const rows = []
        for (const line of consumed.split('\n')) {
          if (line.trim().length === 0) continue
          let event = null
          try { event = JSON.parse(line) } catch (error) { continue }
          if (event.type !== 'user' && event.type !== 'assistant') continue
          if (event.isSidechain === true || event.isReplay === true || machineryRow(event)) continue
          if (event.message === null || event.message === undefined) continue
          rows.push(event)
        }
        state.jsonlOffset = newOffset
        persistStates()
        if (rows.length === 0) return 0

        // Whatever is left after the offset is genuinely someone else's
        // writing — the terminal side, while dsh was idle. Mirror it. The old
        // "forked, notice only" branch keyed on turn numbers below the import
        // band, which dense numbering made true for every conversation, so it
        // fired on the plugin's own output.
        //
        // Belt and braces: even with a stale offset, anything whose tool call
        // is already in the transcript was rendered live and is skipped.
        const seenCalls = new Set()
        for (const event of sessionEvents(session)) {
          if (event.type === 'tool/call' && event.data && typeof event.data.callId === 'string') {
            seenCalls.add(event.data.callId)
          }
        }
        const unseen = rows.filter((event) => {
          const content = event.message.content
          if (!Array.isArray(content)) return true
          for (const block of content) {
            if (block === null || typeof block !== 'object') continue
            const id = block.type === 'tool_use' ? block.id : (block.type === 'tool_result' ? block.tool_use_id : undefined)
            if (typeof id === 'string' && seenCalls.has(id)) return false
          }
          return true
        })
        if (unseen.length === 0) {
          console.log('cc-mode:', sessionId, 'transcript grew by', rows.length, 'row(s) this side already rendered')
          return 0
        }
        const written = queueProjection(sessionId, unseen, '')
        console.log('cc-mode:', sessionId, 'mirrored', written, 'terminal message(s) into the imported conversation')
        return written
      })()

      syncInFlight.set(sessionId, work)
      return work.catch((error) => {
        console.error('cc-mode: transcript sync failed:', errorText(error))
        return 0
      }).finally(() => { syncInFlight.delete(sessionId) })
    }

    /**
     * Repair a conversation poisoned by the old high-band numbering.
     *
     * Turns numbered at 1000000+ do not survive a reload once they carry live
     * streaming (the chunks and the message that supersedes them stop being
     * assembled from the history page), so their content is invisible even
     * though the log holds it. A log is append-only, so the repair re-emits
     * the stranded assistant text as a fresh DENSE turn — visible again, and
     * it also drops the log's last turn number back into the normal range so
     * dsh's own loop leaves the band behind on its next construction.
     */
    async function repairBandTurns(sessionId, session) {
      if (session === undefined) return 0
      const BAND = 1000000
      const state = stateOf(sessionId, session)
      if (state.bandRepaired === true) return 0

      let lastBandTurn = 0
      let lastDenseTurn = 0
      for (const event of sessionEvents(session)) {
        if (event.type !== 'turn/start' || typeof event.data.turn !== 'number') continue
        if (event.data.turn >= BAND) lastBandTurn = Math.max(lastBandTurn, event.data.turn)
        else lastDenseTurn = Math.max(lastDenseTurn, event.data.turn)
      }
      state.bandRepaired = true
      if (lastBandTurn === 0) { persistStates(); return 0 }

      // Appending only helps when the highest-numbered turn is also the last
      // one written. A log whose turn numbers jump backwards several times
      // (the worst of the old band behaviour) cannot be repaired in place —
      // it is append-only — and the honest fix is to re-import the Claude
      // conversation, whose own transcript is intact.
      let lastTurnWritten
      for (const event of sessionEvents(session)) {
        if (event.type === 'turn/start' && typeof event.data.turn === 'number') lastTurnWritten = event.data.turn
      }
      if (lastTurnWritten !== lastBandTurn) {
        persistStates()
        console.log('cc-mode:', sessionId, 'has a scrambled turn sequence from the old numbering —',
          'its tail cannot be re-rendered in place; re-import the Claude conversation to get a clean copy')
        return 0
      }

      // Only the stranded stretch: assistant text logged under the LAST band
      // turn, which is the one a live agent wrote and the reload cannot show.
      const stranded = []
      for (const event of sessionEvents(session)) {
        if (event.type !== 'assistant/message') continue
        if (event.data.turn !== lastBandTurn) continue
        const message = event.data.message || {}
        const source = message.source || {}
        if (source.model === NOTICE_MODEL) continue
        const text = (message.content || [])
          .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text).join('\n\n').trim()
        if (text.length > 0) stranded.push({ type: 'assistant', message: { model: message.source && message.source.model, content: [{ type: 'text', text: text }] } })
      }
      persistStates()
      if (stranded.length === 0) return 0

      const written = queueProjection(sessionId, stranded,
        '（这段回复此前因为轮次编号问题没能显示出来，这里补回；插件已改为与 dsh 一致的编号方式。）')
      console.log('cc-mode:', sessionId, 'recovered', written, 'message(s) stranded by the old turn numbering')
      return written
    }

    /**
     * Catch up a conversation whose Claude kept talking while nothing was
     * attached — the dsh-restart case: dsh's own crash recovery closes the
     * open turn (tool calls settle as TOOL_OUTCOME_UNKNOWN), but the broker
     * held the process, and everything it produced since the recorded attach
     * offset is sitting in out.log. That tail is projected into the transcript
     * as history — no model call, no quota — and the offset advanced so the
     * next live attach does not replay it.
     */
    const drainInFlight = new Map()

    function drainDetachedOutput(sessionId, session) {
      if (session === undefined) return Promise.resolve(0)
      if (activeTurns.has(sessionId) || runs.has(sessionId) || drainInFlight.has(sessionId)) return Promise.resolve(0)
      const state = stateOf(sessionId, session)
      if (state.mode !== 'claude') return Promise.resolve(0)

      const dir = sessionDir(sessionId)
      const remote = remoteOf(state)
      const work = (async () => {
        const meta = await readJsonFile(dir + '/meta.json', remote)
        if (meta === null) return 0
        const attachState = await readJsonFile(dir + '/attach.json', remote)
        let offset = attachState !== null && typeof attachState.offset === 'number' ? attachState.offset : null
        if (offset === null) {
          // No recorded offset (the watchdog clears it on a stalled detach).
          // Anchor on the call dsh's crash recovery settled as
          // TOOL_OUTCOME_UNKNOWN: its REAL result is in the broker log, and
          // everything from that line on is the missing tail.
          let callId = ''
          const logged = sessionEvents(session)
          for (let index = logged.length - 1; index >= 0; index -= 1) {
            const event = logged[index]
            if (event.type === 'tool/call' && event.data && typeof event.data.callId === 'string') {
              callId = event.data.callId
              break
            }
          }
          if (callId.length === 0) return 0
          const lineNoRaw = await captureOn(
            'grep -n -m1 -F ' + shellQuote('"tool_use_id":"' + callId + '"') + ' ' + shellQuote(dir + '/out.log') + ' | cut -d: -f1', remote, 15000)
          const lineNo = parseInt(String(lineNoRaw).trim(), 10)
          if (isNaN(lineNo) || lineNo < 1) return 0
          const offsetRaw = await captureOn(
            'head -n ' + (lineNo - 1) + ' ' + shellQuote(dir + '/out.log') + ' | wc -c', remote, 15000)
          offset = parseInt(String(offsetRaw).trim(), 10)
          if (isNaN(offset)) return 0
        }
        // Same as the live attach: an abandoned probe's round is not history.
        const pastCommand = await pastPendingCommand(sessionId)
        if (typeof pastCommand === 'number' && pastCommand > offset) offset = pastCommand

        const size = await fileSize(dir + '/out.log', remote)
        if (size <= offset) return 0

        // 断线期间攒下的东西可以很大——实测一轮 6.6MB（一个跑了二十多分钟、
        // 四十多次工具调用的回合）。这里原本固定读 3MB，而后果不是「少读一
        // 点」：读不到 result 就整段判成「还在流，不算历史」，于是一个字都不
        // 补，offset 又被别处推到了末尾，那段内容再没人来读。所以先问清楚
        // 「不超过 DRAIN_MAX 的最后一个完整轮次结束在哪个字节」，按那个边界
        // 读。剩下的留给下一趟——每趟都补到一个 result 上，多补几次就补完。
        const spanRaw = await captureOn(
          'tail -c +' + (offset + 1) + ' ' + shellQuote(dir + '/out.log')
          + ' | LC_ALL=C awk -v LIMIT=' + DRAIN_MAX
          + ' \'{ n += length($0) + 1 } /"type":"result"/ { if (n <= LIMIT) last = n } END { print last + 0 }\'',
          remote, 30000)
        const span = parseInt(String(spanRaw).trim(), 10)
        // 没有一个完整轮次躺在这儿，就没有历史可补：还在流的那部分归实时读取器。
        if (isNaN(span) || span <= 0) return 0
        const raw = await captureOn(
          'tail -c +' + (offset + 1) + ' ' + shellQuote(dir + '/out.log')
          + ' | head -c ' + span, remote, 30000)
        const rows = []
        let sawResult = false
        for (const line of String(raw).split('\n')) {
          if (line.trim().length === 0) continue
          let event = null
          try { event = JSON.parse(line) } catch (error) { continue }
          if (event.type === 'result') { sawResult = true; continue }
          if (event.type !== 'user' && event.type !== 'assistant') continue
          if (event.isSidechain === true || event.isReplay === true || machineryRow(event)) continue
          if (typeof event.parent_tool_use_id === 'string' && event.parent_tool_use_id.length > 0) continue
          if (event.message === null || event.message === undefined) continue
          rows.push(event)
        }
        // Only a COMPLETED stretch is history. A turn still streaming keeps
        // its bytes for the live attach that will carry it on.
        if (!sawResult || rows.length === 0) return 0

        // Anchor against what the transcript already holds. Tool-use ids are
        // the reliable seam: if this stretch overlaps content that was already
        // rendered live, everything up to the last id dsh knows is a replay,
        // and projecting it would duplicate calls whose results then pair
        // across turns — which is exactly how a card ends up spinning forever.
        const known = new Set()
        for (const event of sessionEvents(session)) {
          if (event.type === 'tool/call' && event.data && typeof event.data.callId === 'string') known.add(event.data.callId)
        }
        let lastKnown = -1
        for (let index = 0; index < rows.length; index += 1) {
          const content = rows[index].message.content
          if (!Array.isArray(content)) continue
          for (const block of content) {
            if (block === null || typeof block !== 'object') continue
            const id = block.type === 'tool_use' ? block.id : (block.type === 'tool_result' ? block.tool_use_id : undefined)
            if (typeof id === 'string' && known.has(id)) lastKnown = index
          }
        }
        const fresh = lastKnown === -1 ? rows : rows.slice(lastKnown + 1)
        if (fresh.length === 0) {
          console.log('cc-mode:', sessionId, 'drain found nothing new (already rendered live)')
          return 0
        }

        const written = queueProjection(sessionId, fresh,
          '（dsh 重启期间 Claude 继续完成了这一轮，以下是断档期间的内容。）')
        // 记的是「补到哪儿」，不是文件末尾：这一趟只补到了最后一个 result，
        // 后面若还有内容，下一趟才好接着补。记成 size 等于宣布那段不存在。
        await new Promise((resolve) => {
          execOn('cat > ' + shellQuote(dir + '/attach.json'), remote, 10000,
            { stdin: JSON.stringify({ offset: offset + span }) })
            .then(() => resolve(), () => resolve())
        })
        console.log('cc-mode:', sessionId, 'drained', written, 'message(s) Claude produced while detached')
        return written
      })()

      drainInFlight.set(sessionId, work)
      return work.catch((error) => {
        console.error('cc-mode: drain failed:', errorText(error))
        return 0
      }).finally(() => { drainInFlight.delete(sessionId) })
    }

    /**
     * Keep reading after `result` — Claude's turn is over, Claude is not.
     *
     * A finished background task makes the CLI open a round nobody asked for
     * (`task_notification` → `init` → assistant → `result`), and dsh has no
     * turn open to render it. The old loop returned on the first `result` and
     * left the stream unread, which cost twice: the messages piled up in
     * `run.queue` forever — 345 of them, 169 KB and climbing, in the
     * conversation that surfaced this — and the next real turn shifted that
     * backlog out as if it were its own answer, ending early on the stale
     * `result` and pushing the true reply into the round after it.
     *
     * So the reader stays. It holds NOTHING: every message is classified and
     * dropped, and a completed round is projected straight out of `out.log` by
     * byte range. Per conversation that is one suspended closure and two
     * numbers — which is the point on a machine where each attached Claude is
     * already ~130 MB resident.
     *
     * It ends itself when Claude has no background task left to wake it, so an
     * idle conversation goes back to being detachable and reapable.
     */
    const IDLE_STOPPED = { idleStopped: true }
    // How long to keep listening after a round ends with no background task
    // outstanding. `init` follows `result` within a line or two when another
    // round is coming, so this only has to outlast that gap — it is not a
    // guess at how long Claude might think.
    const IDLE_QUIET_MS = 10000
    // With background work outstanding, silence is expected — a backgrounded
    // `sleep` says nothing until it finishes. Stay through it, but not
    // indefinitely: this stops short of the reaper's 45 minutes, so a
    // conversation everyone has forgotten still becomes collectable.
    const IDLE_TASK_QUIET_MS = 30 * 60 * 1000
    // One stretch of out.log per projection, matching the drain path's cap.
    const IDLE_STRETCH_MAX = 3000000

    // 一趟断线补录最多读这么多，并且只读到边界上的最后一个 result。
    const DRAIN_MAX = 8000000
    // A permission asked between turns has no turn to be cancelled with; it
    // stands until answered, or until the reader lets go of the run.
    const idleSignal = new AbortController().signal

    /**
     * How many background tasks the log last reported outstanding.
     *
     * The reader cannot start this at zero and wait to be told. It attaches
     * either after a turn — when a backgrounded `sleep` is typically already
     * running, and its `background_tasks_changed` scrolled by while the turn
     * owned the stream — or after a restart, where that event is simply
     * history. Starting blind means picking the ten-second window in exactly
     * the case the long one exists for, and letting go minutes before the task
     * wakes Claude up.
     */
    async function lastBackgroundTaskCount(dir, remote) {
      const raw = await captureOn(
        'tail -c 2000000 ' + shellQuote(dir + '/out.log')
        + ' | grep -F \'"background_tasks_changed"\' | tail -1', remote, 10000)
      const line = String(raw).trim()
      if (line.length === 0) return 0
      try {
        const value = JSON.parse(line)
        return Array.isArray(value.tasks) ? value.tasks.length : 0
      } catch (error) { return 0 }
    }

    /**
     * 从一份 Claude transcript 里挑出「这个对话叫什么」的那一行 JSON。
     *
     * 用整趟 awk 而不是 `grep | tail -n`：改名事件是追加的，用户很早改过名、
     * 之后 Claude 又写了几十条 ai-title 的对话，在「最后几条」里根本看不见
     * custom-title——实测 zhongxin 那个 109MB 的对话就是这样，列表里一直显示
     * 着它最早的自动名字。整趟扫 109MB 实测 ~90ms，比 `tail -n 4000`（297ms）
     * 还快，因为这些日志的行特别长。
     */
    // 锚在行首：一个讨论标题同步的对话，会把 {"type":"ai-title"…} 原样写进自己
    // 的正文和工具输出里，而这些 title 事件本身永远是独立的一行（实测这批日志
    // 6635 条无一例外）。不锚定的话，最后留下的是对话里的那句闲聊。
    const TITLE_RULES = '/^\\{"type":"custom-title"/{c=$0} /^\\{"type":"ai-title"/{if(c==""){a=$0}} '
    const TITLE_PICK = 't=(c!=""?c:a); gsub(/[[:cntrl:]]/," ",t); '
    const TITLE_AWK = 'awk \'' + TITLE_RULES + 'END{' + TITLE_PICK + 'if(t!="") print t}\' '

    /** 一行 title JSON → 标题文本。认不出来就是空串。 */
    function titleOfLine(line) {
      let event = null
      try { event = JSON.parse(String(line).trim()) } catch (error) { return '' }
      if (event === null || typeof event !== 'object') return ''
      if (event.type === 'custom-title' && typeof event.customTitle === 'string') return event.customTitle.trim()
      if (event.type === 'ai-title' && typeof event.aiTitle === 'string') return event.aiTitle.trim()
      return ''
    }

    /**
     * 这个对话的名字：用户改过的优先，否则用 Claude 自己起的。
     *
     * Claude records it in its OWN transcript as an `ai-title` row. It is not
     * in the stream — verified across the brokers' logs, which hold zero
     * `ai-title` events — so reading the file is the only way to see it. The
     * rows are appended and never rewritten, so the last one wins.
     *
     * Every candidate is parsed and type-checked rather than trusted from the
     * grep: a conversation that merely discusses `ai-title` puts that text in
     * its own transcript, inside tool output and assistant prose. Matching on
     * the string alone reads a conversation's chatter as its title.
     */
    async function lastClaudeTitle(cwd, claudeSessionId, remote) {
      if (typeof cwd !== 'string' || cwd.length === 0) return ''
      if (typeof claudeSessionId !== 'string' || claudeSessionId.length === 0) return ''
      const path = '"$HOME"/.claude/projects/' + shellQuote(projectSlug(cwd))
        + '/' + shellQuote(claudeSessionId + '.jsonl')
      const raw = await captureOn(TITLE_AWK + path + ' 2>/dev/null', remote, 15000)
      return titleOfLine(raw)
    }

    /**
     * Carry Claude's own name for the conversation over to dsh.
     *
     * dsh's title-provider seat is single-occupancy and dsh-session-title-llm
     * already holds it ("provider … is already registered"), with no priority
     * to shadow it by — so this cannot be a provider. `rename` is the way in.
     * It records the title as user-set, which also calls off dsh's own title
     * generation: right, since Claude has already named the thing and a second
     * model call would spend money to say it again.
     *
     * A title a person typed is never overwritten. Whatever this last wrote is
     * remembered, so anything else sitting in the seat means someone else put
     * it there — and from then on this keeps its hands off.
     */
    // Conversations already asked to name themselves. In-process only: a
    // restart may ask once more, which is one short call, while persisting it
    // would silence the ask for good if the first one failed.
    const titleRefreshed = new Set()

    async function syncClaudeTitle(sessionId, session) {
      if (sessionTitle === undefined || session === undefined) return false
      const state = stateOf(sessionId, session)
      if (state.mode !== 'claude') return false
      const run = runs.get(sessionId)
      const cwd = run !== undefined && typeof run.cwd === 'string' && run.cwd.length > 0
        ? run.cwd
        : (session.header ? session.header.cwd : '')
      const title = await lastClaudeTitle(cwd, state.claudeSessionId, remoteOf(state))

      let snapshot
      try { snapshot = sessionTitle.get(session) } catch (error) { return false }
      const current = snapshot === undefined ? '' : String(snapshot.title || '')
      const source = snapshot === undefined ? undefined : snapshot.source
      // Renamed since this last spoke, so a human chose it. Theirs, for good.
      if (source !== undefined && source.kind === 'user' && current !== state.titleWritten) {
        state.titleWritten = current
        persistStates()
        return false
      }

      // Claude did not name it — which is the common case, since it only
      // writes `ai-title` from its interactive UI. Left alone the conversation
      // keeps dsh's fallback, a truncated first sentence, forever: dsh's own
      // title provider marks the work pending on a user message but starts it
      // from `request/header` or its own loop request, and a Claude-driven
      // conversation produces neither. `refresh` is the service's deliberate
      // entry point for exactly this — ask, and dsh names it with its own
      // model. Once a provider title lands the seat is no longer `fallback`,
      // so this asks once and stops.
      if (title.length === 0) {
        if (source !== undefined && source.kind !== 'fallback') return false
        if (titleRefreshed.has(sessionId)) return false
        titleRefreshed.add(sessionId)
        try {
          await sessionTitle.refresh(session)
          console.log('cc-mode:', sessionId, 'asked dsh to name itself — Claude had not')
        } catch (error) {
          console.error('cc-mode: title refresh failed:', errorText(error))
        }
        return false
      }

      if (title === state.titleWritten) return false
      if (current === title) { state.titleWritten = title; persistStates(); return false }

      try { sessionTitle.rename(session, title) } catch (error) {
        console.error('cc-mode: could not carry Claude\'s title over:', errorText(error))
        return false
      }
      state.titleWritten = title
      persistStates()
      console.log('cc-mode:', sessionId, 'took its title from Claude:', title)
      return true
    }

    /** `run.next`, plus the stop check that lets the idle reader be relieved. */
    async function idleNext(run) {
      while (true) {
        if (run.idleStop === true) return IDLE_STOPPED
        if (run.queue.length > 0) return run.queue.shift()
        if (run.closed) return undefined
        await new Promise((resolve) => {
          let settled = false
          run.waiter = () => { if (settled) return; settled = true; resolve() }
        })
      }
    }

    /**
     * Project everything the broker logged between `run.idleFrom` and what the
     * pump has consumed. Byte ranges, not buffered messages: the bytes are on
     * disk already, and reading them back costs nothing until a round actually
     * completes.
     */
    async function projectIdleStretch(sessionId, run, endsAt) {
      const from = typeof run.idleFrom === 'number' ? run.idleFrom : 0
      const to = typeof endsAt === 'number' ? endsAt
        : (typeof run.consumed === 'number' ? run.consumed : run.offset)
      if (to <= from) return 0
      run.idleFrom = to
      const session = sessionOf(sessionId)
      if (session === undefined) return 0

      const span = to - from
      if (span > IDLE_STRETCH_MAX) {
        console.error('cc-mode:', sessionId, 'idle stretch is', Math.round(span / 1024),
          'KB — projecting the first', Math.round(IDLE_STRETCH_MAX / 1024), 'KB of it')
      }
      const raw = await captureOn(
        'tail -c +' + (from + 1) + ' ' + shellQuote(run.dir + '/out.log')
        + ' | head -c ' + Math.min(span, IDLE_STRETCH_MAX), run.remote, 20000)

      const rows = []
      for (const line of String(raw).split('\n')) {
        if (line.trim().length === 0) continue
        let event = null
        try { event = JSON.parse(line) } catch (error) { continue }
        if (event.type !== 'user' && event.type !== 'assistant') continue
        if (event.isSidechain === true || event.isReplay === true || machineryRow(event)) continue
        if (typeof event.parent_tool_use_id === 'string' && event.parent_tool_use_id.length > 0) continue
        if (event.message === null || event.message === undefined) continue
        rows.push(event)
      }
      if (rows.length === 0) return 0

      // The live turn that just ended rendered its own tail; anything whose
      // call the transcript already holds would come back as a duplicate whose
      // result then pairs across turns, which is how a card spins forever.
      const known = new Set()
      for (const event of sessionEvents(session)) {
        if (event.type === 'tool/call' && event.data && typeof event.data.callId === 'string') known.add(event.data.callId)
      }
      const fresh = rows.filter((event) => {
        const content = event.message.content
        if (!Array.isArray(content)) return true
        for (const block of content) {
          if (block === null || typeof block !== 'object') continue
          const id = block.type === 'tool_use' ? block.id : (block.type === 'tool_result' ? block.tool_use_id : undefined)
          if (typeof id === 'string' && known.has(id)) return false
        }
        return true
      })
      if (fresh.length === 0) return 0

      const written = queueProjection(sessionId, fresh, '')
      console.log('cc-mode:', sessionId, 'projected', written, 'message(s) from a round Claude opened on its own')
      return written
    }

    /**
     * Start reading the stream between turns. No-op if one is already reading,
     * or if there is nothing left to read from.
     */
    function startIdleDrain(sessionId, run, startsAt) {
      if (run === undefined || run === null) return
      if (run.idleTask !== undefined) return
      if (run.detached === true || run.closed === true || shuttingDown) return
      run.idleStop = false
      run.idleExpired = false
      run.idleFrom = typeof startsAt === 'number' ? startsAt
        : (typeof run.consumed === 'number' ? run.consumed : run.offset)

      run.idleTask = (async () => {
        // The last count `background_tasks_changed` reported. It does not
        // decide whether to stay — silence does — it decides how long silence
        // has to last: a `sleep 600` in the background is minutes of nothing
        // followed by a whole round, and letting go at ten seconds would miss
        // exactly the round this reader exists for. Seeded from the log,
        // because the event that set it usually scrolled by before this
        // reader existed.
        let tasksOpen = 0
        try { tasksOpen = await lastBackgroundTaskCount(run.dir, run.remote) } catch (error) { tasksOpen = 0 }
        let quiet = null
        let relieved = false
        const disarm = () => {
          if (quiet === null) return
          try { quiet() } catch (error) { /* already fired */ }
          quiet = null
        }
        // Silence is the only exit. Arming this up front matters as much as
        // re-arming it: this reader starts AFTER the turn consumed the round's
        // `result`, so an ordinary conversation with no background work leaves
        // it facing an empty queue — waiting for a message that is never coming
        // would pin the run in `runs`, where the reaper skips it forever.
        const armQuiet = () => {
          disarm()
          quiet = armTimeout(() => {
            quiet = null
            run.idleExpired = true
            run.idleStop = true
            const waiter = run.waiter
            run.waiter = null
            if (waiter !== null && waiter !== undefined) waiter()
          }, tasksOpen > 0 ? IDLE_TASK_QUIET_MS : IDLE_QUIET_MS)
        }

        // The live agent for this session, when one is still registered (jobs
        // rows need it as their owner).
        const idleAgent = () => {
          try { return agents === undefined ? undefined : agents.get(sessionId) } catch (error) { return undefined }
        }

        const handle = async (message) => {
          const parent = typeof message.parent_tool_use_id === 'string' ? message.parent_tool_use_id : null

          if (message.type === 'system') {
            if (message.subtype === 'background_tasks_changed') {
              tasksOpen = Array.isArray(message.tasks) ? message.tasks.length : 0
            } else if (message.subtype === 'task_started' && parent === null) {
              // Booked into dsh's own surfaces only — same as the live loop,
              // and for the same reason: no ⚙ note in the conversation.
              ccTaskStarted(run, idleAgent(), message)
            } else if (message.subtype === 'task_notification' && parent === null) {
              ccTaskNotification(run, idleAgent(), message)
            }
            return
          }
          // A round nobody asked for can still need a human. Left unanswered
          // it hangs Claude on a question no one can see, holding the
          // process (and its RAM) for as long as the conversation lives.
          if (message.type === 'control_request') {
            const request = message.request || {}
            if (request.subtype === 'can_use_tool') {
              const agent = idleAgent()
              if (agent !== undefined) {
                answerPermission(run, agent, stateOf(sessionId), message, idleSignal)
              }
            }
            return
          }
          // Parented stream (a subagent working while the main agent is idle)
          // feeds the mirror children just as it does inside a turn.
          if (message.type === 'assistant' && parent !== null) {
            mirrorParentedAssistant(run, parent, message.message || {})
            return
          }
          if (message.type === 'user' && parent !== null) {
            mirrorParentedResult(run, parent, message.message || {})
            return
          }
          if (message.type !== 'result') return
          await projectIdleStretch(sessionId, run, message.ccmodeOffset)
        }

        try {
          armQuiet()
          while (true) {
            const message = await idleNext(run)
            if (message === undefined) break
            if (message === IDLE_STOPPED) { relieved = true; break }
            if (message !== null && typeof message === 'object') await handle(message)
            // Something arrived, so the conversation is not quiet after all —
            // and `tasksOpen` may have just changed what quiet is worth.
            armQuiet()
          }
        } catch (error) {
          console.error('cc-mode: idle reader stopped:', errorText(error))
        } finally {
          disarm()
          // Relieved mid-round: a user typed while Claude was still talking to
          // itself. That half round happened, and the turn taking over must not
          // inherit its messages — a result whose call was dropped here would
          // land in the new turn as an orphan. So it is projected as it stands
          // (the projection answers its own unanswered calls) and the queue is
          // cleared, leaving the incoming turn a clean stream.
          if (relieved && run.idleExpired !== true) {
            try { await projectIdleStretch(sessionId, run) } catch (error) {
              console.error('cc-mode: could not project the interrupted round:', errorText(error))
            }
            run.queue.length = 0
          }
          run.idleTask = undefined
          // Nothing left that could wake Claude. Letting go of the stream is
          // what makes the conversation collectable again: the reaper skips
          // any session this plugin is still attached to, and drainDetachedOutput
          // picks up from the offset recorded here if Claude does speak again.
          if (run.idleExpired === true) {
            console.log('cc-mode:', sessionId, 'went quiet — releasing the stream')
            detach(sessionId)
          }
        }
      })()
    }

    /**
     * Pick a conversation back up when it is opened: if its Claude is still
     * running and nothing here is listening, attach and follow it again.
     *
     * The reader above only survives as long as this plugin does. A dsh
     * restart, a plugin update, or its own quiet timeout all leave the broker
     * holding a live Claude that no one is reading — and `drainDetachedOutput`
     * alone is not enough, because it projects the rounds that have already
     * finished and then stops. Anything Claude says *after* that moment needs
     * someone attached to hear it, and opening the conversation is exactly when
     * a person is there to see it.
     *
     * It never starts a process: no broker alive, nothing to follow. And it
     * costs nothing to be wrong — with no traffic the reader times out and
     * detaches on its own.
     */
    const followInFlight = new Set()

    function resumeIdleFollow(sessionId, session) {
      if (session === undefined || shuttingDown) return Promise.resolve(false)
      // 一个听不见的 run 不算「已经有人在跟了」——否则它会把自愈的路也堵上。
      if (activeTurns.has(sessionId)) return Promise.resolve(false)
      const held = runs.get(sessionId)
      if (held !== undefined) {
        if (hearsRun(held)) return Promise.resolve(false)
        console.log('cc-mode:', sessionId, '手上那个 run 已经听不见了 — 放掉它，重新挂上去')
        detach(sessionId)
      }
      if (followInFlight.has(sessionId)) return Promise.resolve(false)
      const state = stateOf(sessionId, session)
      if (state.mode !== 'claude') return Promise.resolve(false)

      followInFlight.add(sessionId)
      const work = (async () => {
        const dir = sessionDir(sessionId)
        const remote = remoteOf(state)
        const meta = await readJsonFile(dir + '/meta.json', remote)
        if (meta === null) return false
        const exited = await readJsonFile(dir + '/exit.json', remote)
        if (exited !== null) return false
        if (!(await isAlive(meta.brokerPid, remote))) return false
        // Launched under different settings: leave it to the next turn's
        // ensureRun, which knows how to retire and replace a process.
        const snapshot = launchSnapshot(state)
        if (meta.snapshot !== snapshot) return false
        // Re-checked after the awaits above — a turn may have started while
        // this was reading files, and two readers on one queue lose messages.
        if (runs.has(sessionId) || activeTurns.has(sessionId)) return false

        const attachState = await readJsonFile(dir + '/attach.json', remote)
        const offset = attachState !== null && typeof attachState.offset === 'number'
          ? attachState.offset
          : await fileSize(dir + '/out.log', remote)
        const run = createRun(sessionId, dir, snapshot, meta.claudeSessionId, remote)
        run.brokerPid = meta.brokerPid
        run.cwd = meta.cwd || (session.header ? session.header.cwd : '')
        run.offset = offset
        runs.set(sessionId, run)
        await attach(run)
        startIdleDrain(sessionId, run, offset)
        console.log('cc-mode: following', sessionId, 'again from', offset, '— its Claude is still running')
        return true
      })()

      return work.catch((error) => {
        console.error('cc-mode: could not follow the live Claude again:', errorText(error))
        return false
      }).finally(() => { followInFlight.delete(sessionId) })
    }

    /** Relieve the idle reader and wait until it has actually let go. */
    function stopIdleDrain(run) {
      if (run === undefined || run === null) return Promise.resolve()
      const task = run.idleTask
      run.idleStop = true
      if (task === undefined) return Promise.resolve()
      const waiter = run.waiter
      run.waiter = null
      if (waiter !== null && waiter !== undefined) waiter()
      return task.catch(() => undefined)
    }

    /**
     * Project Claude conversation events (transcript jsonl rows and broker
     * stream lines share the shape) into a dsh session as durable history:
     * proper boundaries in the high-numbered import band, one turn per human
     * prompt, tools through the live mapping. Returns messages written.
     */
    // Content waiting for a turn of its own. A projection cannot invent a turn
    // number safely, so it queues here and the agent is woken with a carrier
    // message: dsh opens the next turn, the pre-step seam sees the carrier, and
    // the content is written into that turn. No model call is made.
    const pendingProjections = new Map()

    function queueProjection(sessionId, rows, notice) {
      if ((rows === undefined || rows.length === 0) && (notice === undefined || notice.length === 0)) return 0
      const queued = pendingProjections.get(sessionId) || []
      queued.push({ rows: rows || [], notice: notice || '' })
      pendingProjections.set(sessionId, queued)
      wakeForProjection(sessionId)
      return rows === undefined ? 0 : rows.length
    }

    // Sessions with a carrier already in flight. Without this the plugin sends
    // one carrier per queued batch, and any carrier that arrives while a turn is
    // running is claimed by nobody: dsh parks it in the next-turn queue, where
    // it sits in the composer as a visible `claude-in-dsh:render-pending` row
    // until the user happens to send something. The queue already carries the
    // content, so one wake is all that is ever needed.
    const carriersInFlight = new Set()

    /**
     * Ask dsh to open a turn this plugin can render into — but only when it can
     * actually be claimed. A turn already running will render the queue itself
     * when it starts the next one, and its own end re-checks.
     */
    function wakeForProjection(sessionId) {
      if (agents === undefined) return
      const queued = pendingProjections.get(sessionId)
      if (queued === undefined || queued.length === 0) return
      if (activeTurns.has(sessionId) || carriersInFlight.has(sessionId)) return
      let agent
      try { agent = agents.get(sessionId) } catch (error) { agent = undefined }
      if (agent === undefined || typeof agent.followup !== 'function') return
      carriersInFlight.add(sessionId)
      try {
        agent.followup({
          id: uuid(),
          role: 'user',
          content: [{ type: 'text', text: CARRIER_TEXT }],
          source: { kind: 'plugin', plugin: 'claude-in-dsh' },
        })
      } catch (error) {
        carriersInFlight.delete(sessionId)
        console.error('cc-mode: could not wake the agent to render projected content:', errorText(error))
      }
    }

    /** Marker text of the carrier message; never shown, never sent to Claude. */
    const CARRIER_TEXT = '\u0000claude-in-dsh:render-pending\u0000'

    function isCarrier(message) {
      const content = message === undefined ? undefined : message.content
      if (!Array.isArray(content)) return false
      return content.some((block) => block && block.type === 'text' && block.text === CARRIER_TEXT)
    }

    /**
     * The highest step number already recorded for `turn`.
     *
     * A projection numbers its own steps, and starting from 1 was fine while a
     * turn held exactly one projection. It does not: a turn opened for a carrier
     * renders every batch that queued up, and a second batch restarted at step 1
     * — so `turn 3` ended up with two `step/start … step 1` events and the
     * client dropped everything after the collision. Observed as a drain notice
     * with nothing under it.
     */
    function projectClaudeEvents(session, kept, notice, turn) {
      // Content projected outside a live turn used to invent its own turn
      // number, and every scheme was wrong in a different way: a high band left
      // dsh's later turns non-monotonic (they vanished on reload), and
      // appending into an existing turn produced updates whose `turn/start` sat
      // outside the loaded history window ("received an update before its
      // start Match").
      //
      // So a projection numbers nothing. The caller hands it the turn dsh
      // itself opened — the plugin wakes the agent with a carrier message and
      // dsh assigns the next number — and this writes into that turn with its
      // own step numbering. Every start is in the window with its updates, and
      // the turn sequence stays entirely dsh's.
      const knownCallIds = new Set()
      const answeredCallIds = new Set()
      let lastStep = 0
      for (const event of sessionEvents(session)) {
        const data = event.data
        if (data !== undefined && data !== null && data.turn === turn
          && typeof data.step === 'number' && data.step > lastStep) lastStep = data.step
        if (event.type === 'tool/call' && data && typeof data.callId === 'string') {
          knownCallIds.add(data.callId)
        } else if (event.type === 'tool/result') {
          const source = data && data.message ? data.message.source : undefined
          if (source !== undefined && source.callId !== undefined) answeredCallIds.add(String(source.callId))
        }
      }

      const openedHere = []
      let step = lastStep
      let stepOpen = false
      const append = (type, data) => session.append(type, data,
        SURFACE_EVENT_TYPES.has(type) ? { surfaceOp: 'append' } : undefined)
      const closeStep = () => { if (stepOpen) { append('step/end', { turn: turn, step: step }); stepOpen = false } }
      const openStep = () => {
        closeStep()
        step += 1
        append('step/start', { turn: turn, step: step })
        stepOpen = true
      }

      if (typeof notice === 'string' && notice.length > 0) {
        openStep()
        append('assistant/message', { turn: turn, step: step, message: {
          id: uuid(), role: 'assistant',
          content: [{ type: 'text', text: notice }],
          source: { kind: 'model', provider: PROVIDER, model: NOTICE_MODEL },
        }, stream: [] })
      }

      let written = 0
      // 跳过一条探测命令之后，紧跟着的那一条回答也一起吞掉（探测是一问一答）。
      let skippingProbe = false
      for (const event of kept) {
        const message = event.message
        const content = typeof message.content === 'string'
          ? [{ type: 'text', text: message.content }]
          : (Array.isArray(message.content) ? message.content : [])

        if (event.type === 'user') {
          const results = content.filter((block) => block && block.type === 'tool_result')
          if (results.length > 0) {
            for (const block of results) {
              // Skip only a result the transcript already has; a call that is
              // logged but still unanswered needs exactly this result.
              const resultFor = String(block.tool_use_id || '')
              if (answeredCallIds.has(resultFor)) continue
              answeredCallIds.add(resultFor)
              if (!stepOpen) openStep()
              append('tool/result', { turn: turn, step: step, message: {
                id: uuid(), role: 'user',
                source: { kind: 'tool', callId: resultFor },
                content: [{
                  type: 'tool-result',
                  toolCallId: resultFor,
                  content: resultBlocksOf(block.content),
                  isError: block.is_error === true,
                }],
              } })
              written += 1
            }
            continue
          }
          let text = content.filter((block) => block && block.type === 'text' && typeof block.text === 'string')
            .map((block) => block.text).join('\n\n').trim()
          // Terminal bookkeeping the CLI logs as user messages: a slash command
          // becomes the line the user typed; stdout echoes and caveat wrappers
          // are not conversation.
          // 到了一条真正的用户消息，上一条探测命令的回合就翻篇了。
          skippingProbe = false
          if (text.indexOf('<command-name>') !== -1) {
            const name = (text.match(/<command-name>([^<]*)<\/command-name>/) || [])[1] || ''
            const argsText = (text.match(/<command-args>([^<]*)<\/command-args>/) || [])[1] || ''
            if (PROBE_COMMANDS.has(name.trim())) { skippingProbe = true; continue }
            text = name.length > 0 ? (name + (argsText.length > 0 ? ' ' + argsText : '')).trim() : ''
          } else if (text.indexOf('<local-command-stdout>') !== -1 || text.indexOf('<local-command-caveat>') !== -1
            || text.indexOf('<system-reminder>') === 0) {
            text = ''
          }
          if (text.length === 0) continue
          if (!stepOpen) openStep()
          append('user/message', { id: uuid(), role: 'user', content: [{ type: 'text', text: text }], source: { kind: 'user' } })
          written += 1
          continue
        }

        // 探测命令的回答同样不是对话——留下它就是一张没人问过的上下文表格。
        // 只吞紧跟着的那一条：探测是一问一答，跳过头会把后面真正的回答也吃掉。
        if (skippingProbe) { skippingProbe = false; continue }
        const blocks = assistantBlocksOf(content)
          .filter((block) => block.type !== 'tool-call' || !knownCallIds.has(block.id))
        if (blocks.length === 0) continue
        openStep()
        // 这些是从 out.log 的字节区间补投出来的消息，原始流没有留在手边。
        append('assistant/message', { turn: turn, step: step, message: {
          id: uuid(), role: 'assistant', content: blocks,
          source: { kind: 'model', provider: PROVIDER, model: message.model || 'claude-code' },
        }, stream: [] })
        written += 1
        for (const block of blocks) {
          if (block.type !== 'tool-call') continue
          knownCallIds.add(block.id)
          openedHere.push(block.id)
          append('tool/call', { turn: turn, step: step, callId: block.id, name: block.name, arguments: block.arguments })
        }
      }

      closeStep()
      // Only calls this projection opened and could not answer; the session-wide
      // teardown would stamp every older unanswered call red.
      for (const callId of openedHere) {
        if (answeredCallIds.has(callId)) continue
        append('tool/result', { turn: turn, step: step, message: {
          id: uuid(), role: 'user',
          source: { kind: 'tool', callId: callId },
          content: [{
            type: 'tool-result',
            toolCallId: callId,
            content: [{ type: 'text', text: '这次调用没有等到结果（上一次运行被中断）。' }],
            isError: true,
          }],
        } })
      }
      return written
    }

    /**
     * Project an adopted Claude transcript into the dsh session it now lives
     * in, as ordinary durable events — the same vocabulary a live turn writes,
     * so the native transcript UI (and every plugin on it) renders the history.
     *
     * Everything is written under turn 0. The agent's own counter starts real
     * turns at 1 (and, on a reload, resumes from the last `turn/start` in the
     * log), so the imported history can never collide with a lived turn.
     */
    async function backfillClaudeTranscript(sessionId, session, cwd, claudeSessionId) {
      // Idempotent: importing into a conversation that already shows content
      // must not duplicate it.
      for (const event of sessionEvents(session)) {
        if (event.type === 'assistant/message') return { backfilled: 0, skipped: 'already has content' }
      }

      const path = '"$HOME"/.claude/projects/' + shellQuote(projectSlug(cwd)) + '/' + shellQuote(claudeSessionId + '.jsonl')
      // Size BEFORE reading: whatever lands after this snapshot is the live
      // sync's business, never lost between the two.
      const remote = remoteOf(stateOf(sessionId))
      const sizeAtImport = await fileSizeOfShellWord(path, remote)
      const raw = await captureOn(
        'grep -E \'"type":"(user|assistant)"\' ' + path + ' 2>/dev/null', remote, 120000)

      const rows = []
      for (const line of String(raw).split('\n')) {
        if (line.trim().length === 0) continue
        let event = null
        try { event = JSON.parse(line) } catch (error) { continue }
        if (event.isSidechain === true || event.isReplay === true || machineryRow(event)) continue
        if (event.message === null || event.message === undefined) continue
        rows.push(event)
      }
      // The conversation's own posture and model, as the CLI recorded them.
      // Without this an imported conversation opens on the defaults (manual /
      // 「Claude 默认」) even though its transcript says otherwise — and the
      // next turn would then run under a posture the user never chose.
      const state0 = stateOf(sessionId, session)
      const settings = await captureOn(
        'grep -o \'"permissionMode":"[a-zA-Z]*"\' ' + path + ' 2>/dev/null | tail -1; '
        + 'grep -o \'"model":"[^"]*"\' ' + path + ' 2>/dev/null | tail -1', remote, 20000)
      const posture = (String(settings).match(/"permissionMode":"([a-zA-Z]+)"/) || [])[1]
      const model = (String(settings).match(/"model":"([^"]+)"/) || [])[1]
      if (posture !== undefined && PERMISSION_MODES.some((entry) => entry.id === posture)) {
        state0.permissionMode = posture
      }
      if (model !== undefined && model.length > 0) {
        state0.route = model
        const bare = model.replace(/\[[^\]]*\]$/, '')
        if (MODELS.some((entry) => entry.id === bare)) state0.model = bare
      }
      persistStates()

      // No window: a truncated import is a lie about the conversation.
      const written = queueProjection(sessionId, rows, '')
      const state = stateOf(sessionId, session)
      state.jsonlOffset = sizeAtImport
      persistStates()

      // The list row must carry the Claude conversation's OWN title — the same
      // name `claude --resume` and the terminal show (its custom-title, or the
      // ai-title). Written UNCONDITIONALLY: the moment the backfilled first
      // prompt lands, dsh's title service auto-names the session from it, so a
      // presence check always loses that race. A user-sourced title supersedes
      // the automatic one by dsh's own rename semantics. A transcript that was
      // never titled keeps dsh's automatic name (the first prompt) — same
      // outcome the fallback used to produce.
      try {
        let text = ''
        const titled = await captureOn(TITLE_AWK + path + ' 2>/dev/null', remote, 15000)
        text = titleOfLine(titled).replace(/\s+/g, ' ').slice(0, 60)
        if (text.length > 0) {
          // Through the title service, not a bare append: dsh names sessions
          // asynchronously with an LLM, and a raw session/title event written
          // now simply loses to that later result (latest event wins). rename()
          // pins the title and supersedes the pending automatic generation.
          const titleService = ctx.get('sessionTitle')
          if (titleService !== undefined && typeof titleService.rename === 'function') {
            titleService.rename(session, text)
          } else {
            session.append('session/title', { title: text, messageSeqs: [], source: { kind: 'user' } })
          }
        }
      } catch (error) {
        console.error('cc-mode: could not title the imported conversation:', errorText(error))
      }
      return { backfilled: written, dropped: 0 }
    }

    /**
     * A readable slice of one Claude transcript, for the preview pane.
     *
     * Structured rather than flattened: a tool call keeps its name, input and
     * result so the panel can draw it with dsh's own tool-card chrome instead of
     * a line of text (and so a tool result stops being labelled as something the
     * user said). Names stay as Claude reports them — the same title a live tool
     * row carries.
     */
    async function previewClaudeConversation(cwd, claudeSessionId, limit, remote) {
      const path = '"$HOME"/.claude/projects/' + shellQuote(projectSlug(cwd)) + '/' + shellQuote(claudeSessionId + '.jsonl')
      const raw = await captureOn(
        'grep -E \'"type":"(user|assistant)"\' ' + path + ' 2>/dev/null | tail -' + (limit || 60), remote, 15000)

      const items = []
      const byCallId = new Map()
      // 和投影同一条规矩：插件自己发的探测命令，问和答都不进预览——预览要像
      // 导入之后的样子，否则人是照着一份和结果不一样的东西做决定。
      let skippingProbe = false
      for (const line of String(raw).split('\n')) {
        if (line.trim().length === 0) continue
        let event = null
        try { event = JSON.parse(line) } catch (error) { continue }
        if (event.isSidechain === true || event.isReplay === true || machineryRow(event)) continue
        const message = event.message
        if (message === null || message === undefined) continue
        const content = typeof message.content === 'string'
          ? [{ type: 'text', text: message.content }]
          : (Array.isArray(message.content) ? message.content : [])

        if (event.type === 'user') {
          skippingProbe = false
          const whole = content.filter((block) => block && block.type === 'text' && typeof block.text === 'string')
            .map((block) => block.text).join('\n')
          const name = (whole.match(/<command-name>([^<]*)<\/command-name>/) || [])[1]
          if (name !== undefined && PROBE_COMMANDS.has(name.trim())) { skippingProbe = true; continue }
        } else if (skippingProbe) { skippingProbe = false; continue }

        for (const block of content) {
          if (block === null || typeof block !== 'object') continue
          if (block.type === 'text') {
            const text = String(block.text || '').trim()
            if (text.length > 0) items.push({ kind: 'text', role: event.type, text: text.slice(0, 1600) })
          } else if (block.type === 'tool_use') {
            const productName = String(block.name || 'tool')
            const item = {
              kind: 'tool',
              name: productName,
              args: JSON.stringify(clampValue(block.input === undefined ? {} : block.input, 0)),
              output: '',
              isError: false,
              settled: false,
            }
            byCallId.set(String(block.id || ''), item)
            items.push(item)
          } else if (block.type === 'tool_result') {
            const item = byCallId.get(String(block.tool_use_id || ''))
            const text = typeof block.content === 'string'
              ? block.content
              : (Array.isArray(block.content)
                  ? block.content.map((part) => (part && part.type === 'text' ? String(part.text || '') : '[' + String(part && part.type) + ']')).join('\n')
                  : '')
            if (item !== undefined) {
              item.output = text.slice(0, 2000)
              item.isError = block.is_error === true
              item.settled = true
            }
          }
        }
      }
      return { claudeSessionId: claudeSessionId, items: items }
    }

    // ---------- user questions ----------

    /**
     * Claude 的 AskUserQuestion 走的是权限通道（`can_use_tool` +
     * `requires_user_interaction`），但它不是权限问题——它就是 dsh 的
     * `ask_user_question`。识别它靠工具名加上「入参里有 questions 数组」两条，
     * 单看工具名会把同名的 MCP 工具也吞掉。
     * @param request 控制请求的 request 体。
     * @returns 是不是一次该交给人回答的提问。
     */
    function isUserQuestion(request) {
      return request.tool_name === 'AskUserQuestion'
        && request.input !== null
        && typeof request.input === 'object'
        && Array.isArray(request.input.questions)
        && request.input.questions.length > 0
    }

    /**
     * Claude 的问题 → dsh 的 AskUserQuestionItem。dsh 要求每题有稳定 id 而
     * Claude 不给，所以按下标造一个，回收答案时再按 id 映射回题面文本。
     * @param input `can_use_tool` 的 input（含 questions）。
     * @returns dsh 提问服务要的题目数组。
     */
    function dshQuestionsOf(input) {
      const items = []
      const questions = Array.isArray(input.questions) ? input.questions : []
      for (let index = 0; index < questions.length; index += 1) {
        const source = questions[index] || {}
        const question = typeof source.question === 'string' ? source.question.trim() : ''
        if (question === '') continue
        const item = { id: 'q' + index, question: question }
        if (typeof source.header === 'string' && source.header.trim() !== '') item.header = source.header.trim()
        if (Array.isArray(source.options)) {
          const options = []
          for (const raw of source.options) {
            const label = raw !== null && typeof raw === 'object' && typeof raw.label === 'string' ? raw.label : ''
            if (label === '') continue
            const option = { label: label }
            if (typeof raw.description === 'string' && raw.description !== '') option.description = raw.description
            options.push(option)
          }
          if (options.length > 0) item.options = options
        }
        if (source.multiSelect === true) item.multiSelect = true
        items.push(item)
      }
      return items
    }

    /**
     * Route a supervised Claude child's question to its parent conversation
     * through the agent-mesh control, when this session is a managed child. The
     * mesh parks the question for the parent (the same surface a parent answers
     * an approval on) and resolves with the chosen answers keyed by question
     * text. Returns `{ answered, answers }`, or null when the mesh is not
     * composed — in which case the caller falls back to the human question card.
     * @param agent 发起这次 AskUserQuestion 的 dsh agent。
     * @param items dsh 题目数组（含稳定 id 与题面）。
     * @param signal 本轮的中断信号。
     */
    async function meshRouteQuestion(agent, items, signal) {
      const control = ctx.get('multiagentControl')
      if (control === undefined || typeof control.answerQuestion !== 'function') return null
      const childId = agent === undefined || agent.session === undefined ? '' : agent.session.id
      if (childId === '') return null
      try {
        return await control.answerQuestion(childId, items, signal)
      } catch (error) {
        console.error('cc-mode: routing a question to the parent failed:', errorText(error))
        return null
      }
    }

    /**
     * dsh 的答案 → Claude 的 `updatedInput.answers`。Claude 按**题面文本**取键、
     * 值是一个字符串，所以多选把选中的标签连起来，「其他」的自由文本也拼在后面
     * ——实测自由文本能原样送达（CLI 会说 "The user answered ..."）。
     * @param items 发出去的 dsh 题目（带 id 与题面）。
     * @param answer `userQuestions.ask` 的返回值。
     * @returns Claude 要的 answers 映射；没人答的题不出现在里面。
     */
    function ccAnswersOf(items, answer) {
      const questionOf = new Map(items.map((item) => [item.id, item.question]))
      const answers = {}
      const list = answer !== null && typeof answer === 'object' && Array.isArray(answer.answers) ? answer.answers : []
      for (const entry of list) {
        const question = questionOf.get(entry && entry.id)
        if (question === undefined) continue
        const parts = []
        for (const label of Array.isArray(entry.selected) ? entry.selected : []) {
          if (typeof label === 'string' && label.trim() !== '') parts.push(label.trim())
        }
        if (typeof entry.custom === 'string' && entry.custom.trim() !== '') parts.push(entry.custom.trim())
        if (parts.length > 0) answers[question] = parts.join(', ')
      }
      return answers
    }

    /**
     * 把一次 AskUserQuestion 交给 dsh 的提问服务，用 dsh 自己的提问卡片问、
     * 自己的答案编码收，再翻译回 Claude 的控制响应。
     *
     * 一律问人，不看 permissionMode：权限姿态说的是「工具要不要拦」，
     * 而提问在 dsh 里从来不是可以替人代答的东西——完全放行模式下自动允许，
     * 换来的只是 CLI 回一句 "The user did not answer the questions."。
     * @param respond 控制响应写回函数。
     * @param request 控制请求的 request 体。
     * @param agent 发起这次调用的 dsh agent。
     * @param signal 本轮的中断信号。
     */
    async function answerUserQuestion(respond, request, agent, signal) {
      const items = dshQuestionsOf(request.input)
      if (items.length === 0) { respond('allow'); return }
      // If this Claude conversation is a supervised child of another
      // conversation, its question belongs to that PARENT, not the human at
      // this UI — the parent opened it and is the one waiting to hear from it.
      // The mesh returns answers already keyed by question text (the shape the
      // CLI wants back); a child nobody supervises resolves `answered:false`
      // and falls through to dsh's own question card below.
      const routed = await meshRouteQuestion(agent, items, signal)
      if (routed !== null && routed.answered === true) {
        console.log('cc-mode: a supervised child\'s question was answered by its parent')
        respond('allow', undefined, { ...request.input, answers: routed.answers })
        return
      }
      console.log('cc-mode: asking dsh to answer', items.length, 'question(s)')
      let answers = {}
      try {
        const answer = await userQuestions.ask({
          questions: items,
          agent: agent,
          ...(signal === undefined ? {} : { signal: signal }),
        })
        answers = ccAnswersOf(items, answer)
      } catch (error) {
        // 中断、没有应答者、被委派的子 agent……都归到同一个结果：没人回答。
        // 这正是 Claude 自己在没人回答时的语义（"The user did not answer the
        // questions."），模型会照常继续，而不是把这一轮吊死在这里。
        console.error('cc-mode: user question failed:', errorText(error))
      }
      // answers 留空也要带上 updatedInput：CLI 用它区分「答了」和「没答」。
      respond('allow', undefined, { ...request.input, answers: answers })
    }

    // ---------- plan review ----------

    // dsh 自己的 exit_plan_mode 用的就是这三个常量（@deepseek-ai/dsh-plan-mode）。
    // 逐字沿用是有意的：题目 id、选项标签、intent 一模一样，客户端才会渲染成
    // 同一张计划审核卡片，而不是一张长得像的普通提问卡。
    const PLAN_REVIEW_ID = 'plan-review'
    const PLAN_APPROVE_LABEL = 'Approve'
    const PLAN_KEEP_LABEL = 'Keep planning'

    /**
     * Claude 的 ExitPlanMode 同样从权限通道来（`input.plan` 是计划正文，
     * `input.planFilePath` 是 CLI 自己存的副本）。它对应 dsh 的计划审核，
     * 不是"要不要放行一个工具"。
     * @param request 控制请求的 request 体。
     * @returns 是不是一次计划审核。
     */
    function isPlanReview(request) {
      return request.tool_name === 'ExitPlanMode'
        && request.input !== null
        && typeof request.input === 'object'
        && typeof request.input.plan === 'string'
        && request.input.plan.trim() !== ''
    }

    /**
     * 把一次 ExitPlanMode 交给 dsh 的计划审核卡片。
     *
     * 批准的判定逐字照抄 dsh 的 exit_plan_mode：**只有**恰好选中 Approve 且没有
     * 附带自由文本才算批准；用户但凡写了字，那就是反馈，等于「继续规划」。
     *
     * 两端的落点也对得上：批准 → `allow`，CLI 自己退出计划模式并回一句
     * "User has approved your plan."（实测之后的 Write 就走普通权限通道了）；
     * 继续规划 → `deny` 带上反馈，反馈会成为工具结果送进模型，而 CLI 因为工具
     * 没放行仍留在计划模式里——正是 dsh 那边「反馈回模型、留在计划模式」的语义。
     * @param respond 控制响应写回函数。
     * @param request 控制请求的 request 体。
     * @param run 这次运行（用来取 sessionId）。
     * @param agent 发起调用的 dsh agent。
     * @param state 该会话的插件状态。
     * @param signal 本轮的中断信号。
     */
    async function answerPlanReview(respond, request, run, agent, state, signal) {
      // A supervised child's plan review is the parent's call, not the human's.
      // Route it as one question carrying the plan; the parent picks Approve or
      // sends feedback, which maps to leave-plan-mode / keep-planning exactly as
      // the human card does. A child nobody supervises falls through to the
      // native plan-review card below.
      const routed = await meshRouteQuestion(agent, [{
        id: PLAN_REVIEW_ID,
        header: 'Plan review',
        question: 'Approve this plan and leave plan mode? Pick “' + PLAN_APPROVE_LABEL
          + '” to approve, or reply with feedback to keep planning.\n\n--- PLAN ---\n' + String(request.input.plan),
        options: [
          { label: PLAN_APPROVE_LABEL, description: 'Leave plan mode; the plan is carried out from the next step.' },
          { label: PLAN_KEEP_LABEL, description: 'Stay in plan mode; feedback goes back to the model.' },
        ],
        multiSelect: false,
      }], signal)
      if (routed !== null && routed.answered === true) {
        const chosen = String((routed.answers && routed.answers[Object.keys(routed.answers)[0]]) || '').trim()
        const approvedByParent = chosen === PLAN_APPROVE_LABEL
        if (!approvedByParent) {
          respond('deny', chosen === '' || chosen === PLAN_KEEP_LABEL
            ? 'The parent chose to keep planning; revise the plan and present it again.'
            : 'The parent chose to keep planning; their feedback: ' + chosen)
          return
        }
        if (state.permissionMode === 'plan') {
          state.permissionMode = 'manual'
          applySupervision(run.sessionId, state)
          persistStates()
          console.log('cc-mode: plan approved by parent — posture plan -> manual')
        }
        respond('allow')
        return
      }
      console.log('cc-mode: asking dsh to review the plan')
      let answer
      try {
        answer = await userQuestions.ask({
          questions: [{
            id: PLAN_REVIEW_ID,
            header: 'Plan review',
            question: 'Approve this plan and leave plan mode?',
            detail: String(request.input.plan),
            options: [
              { label: PLAN_APPROVE_LABEL, description: 'Leave plan mode; the plan is carried out from the next step.' },
              { label: PLAN_KEEP_LABEL, description: 'Stay in plan mode; feedback goes back to the model.' },
            ],
            intent: { kind: 'plan-review', approve: PLAN_APPROVE_LABEL },
          }],
          agent: agent,
          ...(signal === undefined ? {} : { signal: signal }),
        })
      } catch (error) {
        // 用户把卡片撤掉改成直接说话，或是没有应答者：留在计划模式、停在这里，
        // 别自作主张替他批准。dsh 的 exit_plan_mode 在 ASK_CANCELLED 上说的就是这句。
        console.error('cc-mode: plan review failed:', errorText(error))
        respond('deny', 'The user dismissed the plan review to speak instead; stay in plan mode, stop here, and wait for their message.')
        return
      }
      const entries = (answer !== null && typeof answer === 'object' && Array.isArray(answer.answers) ? answer.answers : [])
        .filter((entry) => entry && entry.id === PLAN_REVIEW_ID)
      const item = entries.length === 1 ? entries[0] : undefined
      const feedback = item !== undefined && typeof item.custom === 'string' ? item.custom.trim() : ''
      const approved = item !== undefined
        && Array.isArray(item.selected)
        && item.selected.length === 1
        && item.selected[0] === PLAN_APPROVE_LABEL
        && feedback === ''
      if (!approved) {
        respond('deny', feedback === ''
          ? 'The user chose to keep planning; revise the plan and present it again.'
          : 'The user chose to keep planning; their feedback: ' + feedback)
        return
      }
      // CLI 在本进程里已经退出计划模式，但姿态在这边是**启动参数**：不落到状态里，
      // broker 换进程（dsh 重启、进程被回收）后 `--permission-mode plan` 会把这个
      // 已经批准过的会话又按回计划模式。落到监督档，等于 dsh 那边「退出计划模式、
      // 工具照常逐个审批」。
      if (state.permissionMode === 'plan') {
        state.permissionMode = 'manual'
        applySupervision(run.sessionId, state)
        persistStates()
        console.log('cc-mode: plan approved — posture plan -> manual')
      }
      respond('allow')
    }

    // ---------- permission questions ----------

    async function answerPermission(run, agent, state, value, signal) {
      const requestId = value.request_id
      const request = value.request || {}
      const toolName = dshToolName(request.tool_name || request.display_name || 'tool')
      const callId = request.tool_use_id

      function respond(behavior, message, updatedInput) {
        try {
          run.write({
            type: 'control_response',
            response: {
              subtype: 'success',
              request_id: String(requestId),
              response: behavior === 'deny'
                ? { behavior: 'deny', message: message || 'The user denied this tool call.' }
                : (updatedInput === undefined ? { behavior: 'allow' } : { behavior: 'allow', updatedInput: updatedInput }),
            },
          })
        } catch (error) {
          console.error('cc-mode: answering a permission request failed:', errorText(error))
        }
      }

      // 提问与计划审核先于权限判定：它们不是「要不要放行这个工具」，而是
      // 「人怎么答」「人批不批」。没有提问服务时退回原路（当权限问题问一下），
      // 至少不会静默吞掉。
      if (userQuestions !== undefined && isUserQuestion(request)) {
        await answerUserQuestion(respond, request, agent, signal)
        return
      }
      if (userQuestions !== undefined && isPlanReview(request)) {
        await answerPlanReview(respond, request, run, agent, state, signal)
        return
      }

      // Only the supervised posture asks a human; every other mode is a
      // deliberate standing answer (waku does the same).
      if (state.permissionMode !== 'manual') {
        console.log('cc-mode: auto-allow', toolName, '(posture ' + state.permissionMode + ')')
        respond('allow')
        return
      }
      if (approval === undefined) { respond('allow'); return }
      // A session on the full-access preset logs policy 'never', which makes the
      // service auto-reject without ever reaching an answerer. Supervision was
      // asked for explicitly, so `permission.set` lifts that override to 'ask'
      // while the posture holds; if something else put it back, allow rather
      // than silently deny a full-access session.
      let policy
      try { policy = approval.overrideOf(agent.session) } catch (error) { policy = undefined }
      if (policy === 'never') {
        console.log('cc-mode: session approval policy is "never" — allowing', toolName, 'without asking')
        respond('allow')
        return
      }
      console.log('cc-mode: asking dsh to approve', toolName, 'callId=' + String(callId))

      const reason = request.description
        || (request.blocked_path ? 'Claude Code 想访问 ' + request.blocked_path : undefined)
        || ('Claude Code 想运行 ' + toolName)
      try {
        const outcome = await approval.request({
          agent: agent,
          toolName: toolName,
          ...(typeof callId === 'string' && callId.length > 0 ? { callId: callId } : {}),
          reason: reason,
          ...(signal === undefined ? {} : { signal: signal }),
        })
        console.log('cc-mode: approval outcome for', toolName, '=', outcome)
        if (outcome === 'allowed-once') respond('allow')
        else if (outcome === 'unavailable') {
          // Fail closed, but say why: no answerer could take the question.
          respond('deny', 'dsh 没有可用的审批应答者；换一个权限模式再试。')
        } else respond('deny')
      } catch (error) {
        console.error('cc-mode: approval failed:', errorText(error))
        respond('deny', 'dsh 审批失败: ' + errorText(error))
      }
    }

    /**
     * Supervision only means something if the session is willing to ask: a
     * full-access session logs approval policy 'never', which auto-rejects every
     * question before an answerer sees it. Lift it to 'ask' while the supervised
     * posture holds and put the session's own override back when it is dropped.
     */
    function applySupervision(sessionId, state) {
      if (approval === undefined || agents === undefined) return
      let agent
      try { agent = agents.get(sessionId) } catch (error) { agent = undefined }
      if (agent === undefined) return
      try {
        const override = approval.overrideOf(agent.session)
        if (state.permissionMode === 'manual') {
          if (override === 'ask') return
          if (state.restorePolicy === undefined) state.restorePolicy = override === undefined ? null : override
          approval.setPolicy(agent, 'ask')
          console.log('cc-mode: session approval policy -> ask (supervised posture)')
          return
        }
        if (state.restorePolicy === undefined) return
        const previous = state.restorePolicy
        state.restorePolicy = undefined
        if (previous !== null) {
          approval.setPolicy(agent, previous)
          console.log('cc-mode: session approval policy restored ->', previous)
        }
      } catch (error) {
        console.error('cc-mode: adjusting the approval policy failed:', errorText(error))
      }
    }

    // ---------- subagent activity as nested sub-calls ----------

    function rootCallOf(run, parentCallId) {
      let cursor = parentCallId
      const seen = new Set()
      while (cursor !== undefined && !run.mainCalls.has(cursor) && !seen.has(cursor)) {
        seen.add(cursor)
        cursor = run.subCallParent.get(cursor)
      }
      return cursor === undefined ? parentCallId : cursor
    }

    function subagentAssistant(session, run, parentCallId, message) {
      for (const block of (message.content || [])) {
        if (block.type !== 'tool_use' && block.type !== 'server_tool_use' && block.type !== 'mcp_tool_use') continue
        const subCallId = String(block.id || uuid())
        const productName = block.name || 'tool'
        const name = dshToolName(productName)
        const args = dshToolArgs(productName, block.input === undefined ? {} : block.input)
        run.subCallParent.set(subCallId, parentCallId)
        run.subCallInfo.set(subCallId, { name: name, arguments: args })
        session.append('tool/code-dispatch-start', {
          rootCallId: rootCallOf(run, parentCallId),
          parentCallId: parentCallId,
          subCallId: subCallId,
          name: name,
          arguments: args,
        })
      }
    }

    function subagentResults(session, run, parentCallId, message) {
      if (typeof message.content === 'string') return
      for (const block of (message.content || [])) {
        if (block.type !== 'tool_result') continue
        const subCallId = String(block.tool_use_id || '')
        const info = run.subCallInfo.get(subCallId) || { name: 'tool', arguments: {} }
        run.subCallInfo.delete(subCallId)
        session.append('tool/code-dispatch', {
          rootCallId: rootCallOf(run, parentCallId),
          parentCallId: parentCallId,
          subCallId: subCallId,
          name: info.name,
          arguments: info.arguments,
          isError: block.is_error === true,
          content: resultBlocksOf(block.content),
        })
      }
    }

    // ---------- dsh-native mirror of Claude Code background work ----------
    //
    // Claude Code reports background work (the Agent/Task tools, detached Bash,
    // Monitor) through `task_started` / `task_notification` system events. This
    // mirror publishes those facts in dsh's native vocabulary, so the jobs list
    // and the subagent catalog that dsh-better-sidebar and the native UI draw
    // from show them the way they show dsh's own:
    //
    //   * every task becomes a `ctx.jobs` row (kind `claude-task`), settled by
    //     its notification — the 后台任务 section;
    //   * an Agent/Task tool call additionally becomes a real subagent child
    //     session (header origin `subagent` under this conversation), fed the
    //     parented stream and finalized by the task notification — the
    //     subagent cards.
    //
    // Nothing about a task is written into the conversation itself. It used to
    // be — ⚙ notes, from before this mirror existed — and with both native
    // surfaces live that was a third copy of the same fact, interrupting the
    // transcript with ids nobody reads. A child mirrors the parented stream
    // event for event (`step/start` → `assistant/message` → `tool/call` →
    // `tool/result` → `step/end`), because that is what dsh's tool cards are
    // built from: the card node starts at a `tool/call`, and a result without
    // one cannot even name its tool, let alone pick a renderer for it.

    /** First line of a possibly multi-line description — the jobs label. */
    function firstLineOf(text) {
      const cut = text.indexOf('\n')
      return cut < 0 ? text : text.slice(0, cut)
    }

    /** One-line job label for a task event, truncated for the row. */
    function ccTaskLabel(message, fallback) {
      const text = typeof message.description === 'string' && message.description.length > 0
        ? message.description
        : String(fallback || message.task_id || message.subagent_type || message.task_type || 'claude task')
      return firstLineOf(text).slice(0, 200)
    }

    /**
     * Create the subagent child session mirroring one Agent/Task tool call.
     * The child is a real dsh session with `origin: 'subagent'` under this
     * conversation, stamped with a one-shot descriptor, so the subagent
     * catalog (native header popover and the sidebar Subagent page) lists it
     * and its transcript can be opened. Returns the record or null on any
     * failure — the mirror must never take the turn down with it.
     */
    function spawnCcSubagent(run, mainSession, toolCallId, description) {
      if (sessionsStore === undefined) return null
      if (toolCallId.length === 0 || run.ccSubagents.has(toolCallId)) return null
      let child = null
      let detach = null
      try {
        const header = mainSession.header || {}
        child = sessionsStore.prepare('session-' + uuid(), {
          meta: {
            origin: 'subagent',
            parentSession: String(mainSession.id),
            ...(typeof header.cwd === 'string' ? { cwd: header.cwd } : {}),
            delegationDepth: 1,
          },
        })
        detach = sessionsStore.enter(child)
        sessionsStore.announce(child)
      } catch (error) {
        console.error('cc-mode: 子会话镜像建立失败:', errorText(error))
        return null
      }
      // Durable identity: a terminal one-shot child, labeled by the delegation
      // description (the text the subagent cards show).
      try {
        child.append('subagent/descriptor', {
          version: 2,
          mode: 'one-shot',
          provider: 'claude-code',
          ...(description.length > 0 ? { label: description.slice(0, 200) } : {}),
        })
      } catch (error) {
        console.error('cc-mode: 子会话 descriptor 写入失败:', errorText(error))
      }
      // Open one turn so the session is not perceived as blank (a session with
      // no turn/start is hidden from some list baselines and never shown as a
      // real conversation); the closing edge lands in finalizeCcSubagent.
      try {
        child.append('turn/start', { turn: 1 })
      } catch (error) { /* best effort */ }
      const record = {
        parentCallId: toolCallId,
        child: child,
        detach: detach,
        label: firstLineOf(description).slice(0, 200),
        step: 0,
        stepOpen: false,
        // Calls announced in this child and the step each was announced in, so
        // finalize can answer whatever the run never got a result for — an
        // unanswered tool/call leaves its card spinning forever.
        pending: new Map(),
        answered: new Set(),
        // The last text the subagent itself produced. The task notification
        // repeats it verbatim as the report, and appending it again gave every
        // finished child two identical final messages.
        lastText: '',
        finalized: false,
      }
      run.ccSubagents.set(toolCallId, record)
      return record
    }

    /** Scan a main-level assistant message for Agent/Task tool calls to mirror. */
    function spawnCcSubagentsFrom(run, mainSession, message) {
      for (const block of (message.content || [])) {
        if (block.type !== 'tool_use' && block.type !== 'server_tool_use' && block.type !== 'mcp_tool_use') continue
        const name = block.name || ''
        if (name !== 'Agent' && name !== 'Task') continue
        const description = block.input !== null && typeof block.input === 'object'
          && typeof block.input.description === 'string'
          ? block.input.description
          : ''
        spawnCcSubagent(run, mainSession, String(block.id || ''), description)
      }
    }

    /**
     * Append one event to a mirror child, never throwing into the turn.
     *
     * The surface marker is not decoration and not optional: dsh requires it on
     * the three message-producing events and REJECTS it on every other type
     * ("is not surface-eligible and cannot carry surfaceOp"). Stamping it on
     * everything is why `tool/call` and `turn/end` never reached a single child
     * — every one of them threw in here and was swallowed, leaving the
     * subagent transcripts with results whose call was unknown, so no tool card
     * could be built for them at all.
     */
    function ccChildAppend(record, type, data) {
      try {
        record.child.append(type, data, SURFACE_EVENT_TYPES.has(type) ? { surfaceOp: 'append' } : undefined)
      } catch (error) {
        console.error('cc-mode: 子会话写入失败 (' + type + '):', errorText(error))
      }
    }

    /** Close the child's open step, if one is open. */
    function ccChildCloseStep(record) {
      if (!record.stepOpen) return
      ccChildAppend(record, 'step/end', { turn: 1, step: record.step })
      record.stepOpen = false
    }

    /** Open the next step of the child's single turn — the main transcript's bracket. */
    function ccChildStep(record) {
      ccChildCloseStep(record)
      record.step += 1
      ccChildAppend(record, 'step/start', { turn: 1, step: record.step })
      record.stepOpen = true
      return record.step
    }

    /** Mirror one parented assistant message (text + tool calls) into its child. */
    function mirrorParentedAssistant(run, parent, message) {
      const record = run.ccSubagents.get(parent)
      if (record === undefined || record.finalized) return
      const blocks = assistantBlocksOf(message.content)
      if (blocks.length === 0) return
      const step = ccChildStep(record)
      ccChildAppend(record, 'assistant/message', {
        turn: 1,
        step: step,
        message: {
          id: uuid(),
          role: 'assistant',
          content: blocks,
          source: { kind: 'model', provider: PROVIDER, model: typeof message.model === 'string' ? message.model : 'claude-code' },
        },
        // 子 agent 的镜像会话是按消息重放的，它这一侧没有独立的流。
        stream: [],
      })
      const text = blocks.filter((block) => block.type === 'text').map((block) => block.text).join('\n\n').trim()
      if (text.length > 0) record.lastText = text
      for (const block of blocks) {
        if (block.type !== 'tool-call') continue
        ccChildAppend(record, 'tool/call', {
          turn: 1,
          step: step,
          callId: block.id,
          name: block.name,
          arguments: block.arguments,
        })
        record.pending.set(block.id, step)
      }
    }

    /** Mirror one parented tool-result message into its child. */
    function mirrorParentedResult(run, parent, message) {
      const record = run.ccSubagents.get(parent)
      if (record === undefined || record.finalized) return
      if (typeof message.content === 'string') return
      for (const block of (message.content || [])) {
        if (block.type !== 'tool_result') continue
        const subCallId = String(block.tool_use_id || '')
        // One result per call, whoever writes it: the CLI re-sends a finished
        // result inside the complete tool_result array, and dsh's chat node
        // treats a second result for one call as a protocol error.
        if (record.answered.has(subCallId)) continue
        record.answered.add(subCallId)
        record.pending.delete(subCallId)
        ccChildAppend(record, 'tool/result', {
          turn: 1,
          step: record.stepOpen ? record.step : ccChildStep(record),
          message: {
            id: uuid(),
            role: 'user',
            source: { kind: 'tool', callId: subCallId },
            content: [{
              type: 'tool-result',
              toolCallId: subCallId,
              content: resultBlocksOf(block.content),
              isError: block.is_error === true,
            }],
          },
        })
      }
    }

    /**
     * The single pending subagent child whose label equals the task's, or
     * undefined when none or several match. The label is the delegation
     * description, which `task_started` echoes for Agent/Task tasks.
     */
    function findCcSubagentByLabel(run, label) {
      if (label.length === 0) return undefined
      let found = undefined
      for (const record of run.ccSubagents.values()) {
        if (record.finalized) continue
        if (record.label !== label) continue
        if (found !== undefined) return undefined
        found = record
      }
      return found
    }

    /** Record one `task_started`: link an Agent child, or open a jobs row. */
    function ccTaskStarted(run, agent, message) {
      // The Agent/Task tool call is already mirrored as a pending child: this
      // task IS that subagent. Link it by task id so its notification can
      // finalize the child, and open no job row — the subagent card covers it.
      const linked = findCcSubagentByLabel(run, ccTaskLabel(message, message.subagent_type || 'agent'))
      if (linked !== undefined) {
        run.ccTasks.set(String(message.task_id || ''), { child: linked })
        return
      }
      if (jobs === undefined || agent === undefined) return
      const taskId = typeof message.task_id === 'string' && message.task_id.length > 0 ? message.task_id : null
      if (taskId === null) return
      // One entry object shared by the job hooks and the notification settle
      // path, so readOutput sees the latest summary (it is never a bare local).
      const entry = {
        job: null,
        settle: null,
        label: ccTaskLabel(message, 'claude task'),
        summary: '',
      }
      const done = new Promise((resolve) => { entry.settle = resolve })
      try {
        entry.job = jobs.start({
          kind: 'claude-task',
          label: entry.label,
          owner: agent,
          run: () => ({
            cancel: () => {
              // Best-effort: ask the running CLI to stop the task. The broker
              // is per-session, so this resolves through the live run.
              const live = runs.get(String(agent.id))
              if (live !== undefined) {
                try { live.control({ subtype: 'stop_task', task_id: taskId }) } catch (error) { /* best effort */ }
              }
            },
            done: done,
            readOutput: () => entry.summary,
          }),
        })
      } catch (error) {
        console.error('cc-mode: 后台任务入账失败:', errorText(error))
        return
      }
      // Park a waiter so the settlement snapshot arrives `reported` and the
      // shared tool-jobs completion notice stays away: the task_notification
      // already wakes Claude's own round, and a second, dsh-side "job
      // finished" user message would steer a duplicate turn into the product.
      try { void jobs.wait(entry.job, 24 * 3600 * 1000, agent).catch(() => undefined) } catch (error) { /* best effort */ }
      run.ccTasks.set(taskId, entry)
    }

    /**
     * Close one subagent child: answer whatever is still open, append the
     * report, close the turn, then release the session. `reason` is how the
     * turn ended — a task notification completes it, a dying run interrupts it.
     */
    function finalizeCcSubagent(run, record, summary, reason) {
      if (record.finalized) return
      record.finalized = true
      // A call with no result keeps its card spinning for good, and the child
      // is durable — so the same interrupted result the main transcript writes.
      for (const entry of record.pending) {
        const callId = entry[0]
        record.answered.add(callId)
        ccChildAppend(record, 'tool/result', {
          turn: 1,
          step: record.stepOpen ? record.step : entry[1],
          message: {
            id: uuid(),
            role: 'user',
            source: { kind: 'tool', callId: callId },
            content: [{
              type: 'tool-result',
              toolCallId: callId,
              content: [{ type: 'text', text: '这次调用没有等到结果（子代理的这一轮被中断）。' }],
              isError: true,
            }],
          },
        })
      }
      record.pending.clear()
      // The notification's summary IS the subagent's last message; appending it
      // again is how every finished child ended with the report printed twice.
      if (summary.length > 0 && summary !== record.lastText) {
        ccChildAppend(record, 'assistant/message', {
          turn: 1,
          step: ccChildStep(record),
          message: {
            id: uuid(),
            role: 'assistant',
            content: [{ type: 'text', text: summary.slice(0, 4000) }],
            source: { kind: 'model', provider: PROVIDER, model: '<synthetic>' },
          },
          stream: [],
        })
      }
      ccChildCloseStep(record)
      ccChildAppend(record, 'turn/end', { turn: 1, reason: reason || { kind: 'completed' } })
      try { record.detach() } catch (error) {
        console.error('cc-mode: 子会话收尾失败:', errorText(error))
      }
      run.ccSubagents.delete(record.parentCallId)
    }

    /** Settle one `task_notification`: close the linked job and/or child. */
    function ccTaskNotification(run, agent, message) {
      const taskId = typeof message.task_id === 'string' ? message.task_id : ''
      const summary = typeof message.summary === 'string' ? message.summary.trim() : ''
      const entry = taskId.length > 0 ? run.ccTasks.get(taskId) : undefined
      if (entry !== undefined) {
        if (entry.summary !== undefined) entry.summary = summary
        if (entry.settle !== undefined) {
          try {
            entry.settle({
              status: 'completed',
              detail: 'exit code 0',
              ...(summary.length > 0 ? { output: summary } : {}),
            })
          } catch (error) { /* best effort */ }
        }
        if (entry.child !== undefined) finalizeCcSubagent(run, entry.child, summary)
        run.ccTasks.delete(taskId)
        return
      }
      // A notification whose task_started was missed (re-attach, replay): fold
      // the report into the sole pending child, if exactly one is running.
      if (summary.length > 0) {
        let pending = 0
        let only = undefined
        for (const record of run.ccSubagents.values()) {
          if (record.finalized) continue
          pending += 1
          only = record
        }
        if (pending === 1 && only !== undefined) finalizeCcSubagent(run, only, summary)
      }
    }

    /**
     * Release the mirror when its run ends (see detachInner). A child left
     * mid-turn stays that way on disk — it is a durable session — so each one
     * is closed as interrupted rather than merely detached.
     */
    function cleanupCcMirror(run) {
      for (const record of Array.from(run.ccSubagents.values())) {
        if (record.finalized) continue
        finalizeCcSubagent(run, record, '', { kind: 'interrupted' })
      }
      run.ccSubagents.clear()
      run.ccTasks.clear()
    }

    // ---------- one hijacked turn ----------

    // dsh plugins that narrate dsh's own machinery. Their notices are addressed
    // to the built-in loop; Claude Code owns its runtime and reading "the
    // approval policy changed" only confuses it (and it leaked into the terminal
    // history line, which is how this was noticed). Content-bearing injections
    // (attachments, file references) are not on this list and still ride along.
    const RUNTIME_NOISE = new Set(['user-approval', 'plan-mode', 'permission-presets', 'agent-instructions', 'skill-catalog'])

    function textOf(message) {
      const parts = []
      for (const block of message.content || []) {
        if (block.type === 'text' && block.text.length > 0) parts.push(block.text)
      }
      return parts.join('\n\n')
    }

    function carriesRuntimeNoise(message) {
      const source = message.source
      return source !== undefined && source.kind === 'plugin' && RUNTIME_NOISE.has(source.plugin)
    }

    /**
     * Whether a human actually said something this turn.
     *
     * dsh wakes an agent for plugin-injected messages too — the Cordis runner
     * posts one into the conversation that owns a dynamic plugin on every
     * stop/run/update, and approval and context plugins inject their own. Those
     * are addressed to dsh's own loop, not to Claude: driving a Claude turn for
     * them starts a conversation the user never asked for (and spends their
     * subscription on it). A message with no source, or one whose source is a
     * person, is what makes a turn worth waking Claude for.
     */
    function hasHumanMessage(messages) {
      for (const message of messages || []) {
        if (isCarrier(message)) continue
        const source = message.source
        if (source === undefined || source.kind === 'user') return true
      }
      return false
    }

    // What plugin injections said while Claude was not driven. Not dropped —
    // handed to Claude in front of the next thing the user actually types, so
    // "the update succeeded" still reaches it without costing a turn.
    const carriedContext = new Map()

    function carryContext(sessionId, messages) {
      const carried = carriedContext.get(sessionId) || []
      for (const message of messages || []) {
        if (carriesRuntimeNoise(message) || isCarrier(message)) continue
        const text = textOf(message)
        if (text.length > 0) carried.push(text.slice(0, 2000))
      }
      while (carried.length > 8) carried.shift()
      if (carried.length === 0) carriedContext.delete(sessionId)
      else carriedContext.set(sessionId, carried)
    }

    function takeCarriedContext(sessionId) {
      const carried = carriedContext.get(sessionId)
      carriedContext.delete(sessionId)
      return carried === undefined ? '' : carried.join('\n\n')
    }

    function promptTextOf(messages) {
      const parts = []
      for (const message of messages || []) {
        if (carriesRuntimeNoise(message) || isCarrier(message)) continue
        const text = textOf(message)
        if (text.length > 0) parts.push(text)
      }
      return parts.join('\n\n')
    }

    /** What the user actually typed — the terminal history line shows this. */
    function typedTextOf(messages) {
      const parts = []
      for (const message of messages || []) {
        const source = message.source
        if (source === undefined || source.kind !== 'user') continue
        const text = textOf(message)
        if (text.length > 0) parts.push(text)
      }
      return parts.join('\n\n')
    }

    // NO `request/header` is ever written for Claude. That event IS the session's
    // model selection: `session.prompt` resolves the folded header and refuses
    // with `model-unavailable` when no registered adapter serves the provider.
    // Logging provider "claude-code" therefore bricked the composer after the
    // first turn. The route still reaches the transcript through each assistant
    // message's own `source`, which nothing dispatches on.

    /**
     * Undo a header this plugin wrote before that was understood: re-log the last
     * header naming a provider dsh can actually serve, so the session can prompt
     * again. A no-op for sessions that were never poisoned.
     */
    function repairHeader(session) {
      const current = session.requestHeader()
      if (current === undefined || current.config === undefined) return false
      if (current.config.provider !== PROVIDER) return false
      const events = sessionEvents(session)
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index]
        if (event.type !== 'request/header') continue
        const config = event.data && event.data.header ? event.data.header.config : undefined
        if (config === undefined || config.provider === PROVIDER) continue
        session.append('request/header', { header: event.data.header, reason: 'change' })
        console.log('cc-mode: restored the session model selection to', config.provider + '/' + config.model)
        return true
      }
      console.error('cc-mode: this session has no pre-Claude model header to restore — pick a model in DSH mode')
      return false
    }

    /** Whether this run has produced anything at all since it was attached. */
    function acknowledgedAtLeastOnce(run) {
      return run.sawAnyMessage === true
    }

    async function driveTurn(agent, messages, turn, signal) {
      const session = agent.session
      const sessionId = String(agent.id)
      const state = stateOf(sessionId)

      repairDanglingToolCalls(session)

      // A turn dsh opened for the plugin's own carrier: render the queued
      // projection into THIS turn (dsh numbered it, so every start sits in the
      // window with its updates) and end the turn without touching Claude.
      if (messages.some((message) => isCarrier(message))) carriersInFlight.delete(sessionId)
      const queued = pendingProjections.get(sessionId)
      if (queued !== undefined && queued.length > 0) {
        pendingProjections.delete(sessionId)
        let total = 0
        for (const batch of queued) total += projectClaudeEvents(session, batch.rows, batch.notice, turn)
        console.log('cc-mode: rendered', total, 'projected message(s) into turn', turn, 'on', sessionId)
        // Anything the user actually said in the same wake still deserves a
        // real turn: fall through only when there is nothing human here.
        if (!hasHumanMessage(messages)) return
      }

      // Pasted images ride the last human message of this turn. dsh's
      // UserMessage objects are FROZEN, so the images go onto a copy — pushing
      // into the original throws "object is not extensible" and kills the turn.
      // Images arrive by two routes: still in the session stash (typed and sent
      // in one go) or already bound to a message that waited in dsh's queue.
      // The queued ones already carry their attachment blocks, so only the
      // stash needs attaching to something when this turn is logged.
      const stashed = pendingImages.get(sessionId) || []
      pendingImages.delete(sessionId)
      const adopted = []
      for (const message of messages) {
        const carried = queuedImages.get(message.id)
        if (carried === undefined) continue
        queuedImages.delete(message.id)
        adopted.push.apply(adopted, carried)
      }
      const images = adopted.concat(stashed)
      let imageTarget = -1
      if (stashed.length > 0) {
        for (let index = messages.length - 1; index >= 0; index -= 1) {
          const source = messages[index].source
          if (source === undefined || source.kind === 'user') { imageTarget = index; break }
        }
      }
      messages.filter((message) => !isCarrier(message)).forEach((message, index) => {
        const logged = index === imageTarget
          ? Object.assign({}, message, {
              content: (message.content || []).concat(stashed.map((image) => ({ type: 'image', attachment: image.attachment }))),
            })
          : message
        session.append('user/message', logged, { surfaceOp: 'append' })
      })

      // A turn dsh woke for plugin traffic alone is not a conversation: keep the
      // injections in the transcript, remember what they said, and leave Claude
      // (and the user's quota) alone until a person speaks.
      if (!hasHumanMessage(messages)) {
        carryContext(sessionId, messages)
        console.log('cc-mode: turn', turn, 'carried', messages.length, 'injected message(s) on', sessionId, '— no Claude call')
        return
      }

      const carried = takeCarriedContext(sessionId)
      const spoken = promptTextOf(messages)
      const prompt = carried.length > 0 && spoken.length > 0 ? carried + '\n\n' + spoken : (spoken || carried)
      if (prompt.length === 0 && images.length === 0) return

      const cwd = session.header ? session.header.cwd : undefined
      if (typeof cwd !== 'string' || cwd.length === 0) {
        throw new Error('cc-mode: 这个会话没有工作目录 — Claude Code 必须在某个 cwd 里跑')
      }

      claudeSeen.add(sessionId)
      // Not only on the init handshake: a dsh restart re-attaches to the broker's
      // live Claude, so no handshake arrives and the window would never be
      // published for exactly the conversations that have one.
      announceContextWindow(sessionId, session)
      // Whatever Claude finished while nothing was attached belongs in the
      // transcript BEFORE this turn's content. Opening the conversation
      // usually does this through state.get, but a user who reopens and types
      // immediately never gives it that chance — and the live attach below
      // starts at EOF, silently skipping the tail forever.
      // 这一段每一步都在 await，而第一条日志要到 ensureRun 之后才打。一个停在
      // 这里的 turn 于是完全没有痕迹：页面等着，日志空白，连「它在等谁」都无从
      // 说起——实测有过一轮在这里停了二十多分钟，除了「卡着没动」什么线索都
      // 没有。所以先记下走到了哪一步，超时就把它喊出来。
      let stage = 'drain'
      const stuckWatch = armTimeout(() => {
        console.error('cc-mode: turn', turn, 'on', sessionId, '在', stage, '这一步停了 60 秒以上——'
          + '这一轮不会有任何输出，除非它自己醒过来')
      }, 60000)
      try {
        await drainDetachedOutput(sessionId, session)
        // A one-shot command may be reading this session's stream right now;
        // the lock is the queue both sides stand in.
        stage = 'lock'
        var lock = acquireSessionLock(sessionId)
        var run
        try {
          await lock.acquired
          // Only one consumer of the stream at a time: the reader that has been
          // following Claude between turns has to let go — and finish handing
          // over what it saw — before this turn starts shifting the same queue.
          stage = 'stop-idle-drain'
          await stopIdleDrain(runs.get(sessionId))
          stage = 'ensure-run'
          run = await ensureRun(sessionId, cwd, signal)
        } catch (error) {
          lock.release()
          throw error
        }
      } finally { try { stuckWatch() } catch (error) { /* already fired */ } }
      const transcript = createTranscript(session, turn)
      activeTurns.set(sessionId, { turn: turn, run: run, transcript: transcript })

      let interrupted = false
      let abortedAt = 0
      let done = false
      let cancelKill = null
      // Where this turn's `result` sits in out.log, so the reader that takes
      // over between turns knows exactly where its first stretch begins.
      let roundEndsAt
      // How many times this turn was resumed after waiting out a usage limit.
      let continues = 0
      const onAbort = () => {
        if (interrupted) return
        interrupted = true
        abortedAt = Date.now()
        // dsh going down is NOT the user pressing stop. dsh aborts every
        // in-flight turn as it shuts down, and answering that by interrupting
        // Claude defeats the entire point of the broker: the turn dies, the
        // transcript fills with "[Request interrupted by user for tool use]",
        // and the drain afterwards has nothing to recover because there is
        // nothing left to produce. Leave it running; the broker holds it and
        // the next attach picks the output up.
        if (shuttingDown) {
          console.log('cc-mode: dsh is going down — leaving turn', turn, 'running on', sessionId)
          return
        }
        try { run.control({ subtype: 'interrupt' }) } catch (error) { /* gone */ }
        cancelKill = armTimeout(() => { if (!done) stopRun(sessionId).catch(() => undefined) }, 8000)
      }
      if (signal.aborted) onAbort()
      else {
        signal.addEventListener('abort', onAbort, { once: true })
        console.log('cc-mode: turn', turn, 'armed for cancel on', sessionId)
      }

      try {
        // Terminal Claude records every typed prompt here; a -p session does not,
        // and that index is exactly what `claude --resume` lists.
        // The index row must name the directory the PROCESS opened; the dsh
        // workspace path would be a row `--resume` can never match.
        recordPromptHistory(run.cwd || cwd, run.claudeSessionId, typedTextOf(messages) || prompt, run.remote)

        const promptContent = []
        if (prompt.length > 0) promptContent.push({ type: 'text', text: prompt })
        for (const image of images) {
          promptContent.push({ type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } })
        }
        await run.write({
          type: 'user',
          message: { role: 'user', content: promptContent },
          parent_tool_use_id: null,
        })
        if (run.writeError !== undefined) throw new Error(run.writeError)

        // A submitted prompt that produces nothing is the one failure that used
        // to hang forever. Everything after the first event is unbounded on
        // purpose — a long tool run is silent by nature.
        // One watchdog, armed here where the context is certainly active, for
        // the two ways a turn can fail to end on its own:
        //   * nothing at all comes back after submitting (the input never landed)
        //   * the product ignores an interrupt (cancel would hang)
        // Neither may kill Claude: detaching lets go of the turn and keeps the
        // process. Dropping attach.json first makes the next attach resume at
        // the end of the log, so an abandoned tail is skipped, not replayed.
        const submittedAt = Date.now()
        // 这一轮开始时它已经收过多少条。看门狗要问的是「这一轮有没有回音」，
        // 而 run.sawAnyMessage 记的是「这个 run 有没有收过」——一个被复用的
        // run 上一轮收过，这个标记就永远是 true，于是「提交后 120 秒毫无回
        // 应」这条守卫永远不会响。空壳 run 加上哑掉的看门狗，合起来就是实测
        // 里那个「卡住、没输出、日志里也没有」：Claude 在那头输出了 700KB，
        // dsh 这边二十分钟一片空白，而没有任何一处认为出了错。
        const heardAtStart = run.heard || 0
        const stallWatch = ctx.interval(() => {
          safely('turn watchdog', () => {
            if (done) return
            const silentTooLong = (run.heard || 0) === heardAtStart && Date.now() - submittedAt > 120000
            const ignoredInterrupt = interrupted && Date.now() - abortedAt > 10000
            if (!silentTooLong && !ignoredInterrupt) return
            console.error(ignoredInterrupt
              ? 'cc-mode: 中断后 10 秒没有收到 result，松开这一轮（Claude 进程保留）'
              : 'cc-mode: 提交后 120 秒没有任何回应，判定输入没有送达；保留进程并松开这一轮')
            captureOn('rm -f ' + shellQuote(run.dir + '/attach.json'), run.remote, 3000).catch(() => undefined)
            detach(sessionId, false)
          })
        }, 2000)

        while (true) {
          const message = await run.next()
          if (message === undefined) {
            if (!acknowledgedAtLeastOnce(run) && !shuttingDown) {
              throw new Error(run.readerDead === true
                ? 'cc-mode: 与 Claude 的输出流断开了（进程还在，回答可能已经产生）。重发一次即可。'
                : 'cc-mode: 输入没有送达 Claude（120 秒内没有任何回应）。进程还在，重发一次即可；如果反复如此，用下拉里的「结束 Claude 进程」重来。')
            }
            if (shuttingDown) throw new Error('cc-mode: 插件正在更新/停止，这一轮被中断了 — 重发一次即可，Claude 的会话上下文还在')
            throw new Error('cc-mode: claude 的输出流在给出 result 之前结束了'
              + (run.exit && run.exit.error ? ' (' + run.exit.error + ')' : '')
              + (run.exit && run.exit.exitCode != null ? ' (exit ' + run.exit.exitCode + ')' : ''))
          }
          const parent = typeof message.parent_tool_use_id === 'string' ? message.parent_tool_use_id : null

          if (message.type === 'system') {
            if (message.subtype === 'init') {
              run.init = message
              rememberCommands(message.slash_commands, run.remote)
              run.claudeSessionId = message.session_id || run.claudeSessionId
              if (state.claudeSessionId !== run.claudeSessionId) {
                state.claudeSessionId = run.claudeSessionId
                persistStates()
              }
              if (state.route !== (message.model || 'claude-code')) {
                state.route = message.model || 'claude-code'
                persistStates()
              }
              announceContextWindow(sessionId, session)
            }
            // Background work (the Agent tool runs in the background by
            // default now; detached Bash and Monitor report the same way).
            // These used to also leave ⚙ notes in the transcript, from before
            // the mirror existed. They do not any more: a task is a `ctx.jobs`
            // row and an Agent task is a subagent child session, and both have
            // their own native surface (the jobs list, the subagent catalog,
            // and dsh-better-sidebar's pages over them). The note was a third
            // copy of the same fact, sitting in the middle of the conversation.
            if (message.subtype === 'task_started' && parent === null) {
              ccTaskStarted(run, agent, message)
            }
            if (message.subtype === 'task_notification' && parent === null) {
              ccTaskNotification(run, agent, message)
            }
            // Auto-compaction happens mid-turn and takes tens of seconds. The
            // terminal says so; without this dsh just went quiet and then
            // carried on as if nothing had happened.
            if (message.subtype === 'compact_boundary' && parent === null) {
              const meta = message.compact_metadata || {}
              const before = Number(meta.pre_tokens) || 0
              const after = Number(meta.post_tokens) || 0
              const auto = String(meta.trigger || '') !== 'manual'
              if (before > 0 || after > 0) {
                transcript.note('◆ 上下文' + (auto ? '已自动压缩' : '已压缩') + '：'
                  + before.toLocaleString('en-US') + ' → ' + after.toLocaleString('en-US') + ' tokens')
              }
            }
            continue
          }
          if (message.type === 'control_request') {
            const request = message.request || {}
            if (request.subtype === 'can_use_tool') {
              // Answered concurrently: the product keeps streaming while a
              // human decides, and the turn's signal withdraws the question.
              answerPermission(run, agent, state, message, signal)
            }
            continue
          }
          if (message.type === 'stream_event') {
            if (parent === null) transcript.streamEvent(message.event)
            continue
          }
          if (message.type === 'assistant') {
            if (parent === null) {
              const calls = transcript.assistantMessage(message.message || {})
              for (const call of calls) run.mainCalls.add(call.id)
              spawnCcSubagentsFrom(run, session, message.message || {})
            } else {
              subagentAssistant(session, run, parent, message.message || {})
              mirrorParentedAssistant(run, parent, message.message || {})
            }
            continue
          }
          if (message.type === 'user') {
            if (message.isReplay === true || machineryRow(message)) continue
            if (parent === null) transcript.toolResults(message.message || {})
            else {
              subagentResults(session, run, parent, message.message || {})
              mirrorParentedResult(run, parent, message.message || {})
            }
            continue
          }
          if (message.type === 'result') {
            // Some slash commands answer in the result alone. Nothing rendered
            // plus a result carrying text is exactly that case — show it rather
            // than closing a turn that looks like it did nothing.
            const resultText = typeof message.result === 'string' ? message.result : ''
            if (message.is_error !== true && resultText.length > 0 && !transcript.hadAssistant()) {
              transcript.assistantMessage({ content: [{ type: 'text', text: resultText }], model: 'claude-code' })
            }
            // An interrupt makes the product report an error result; that is the
            // cancel the user asked for, not a failure worth a transcript notice.
            if (message.is_error === true && !interrupted && !signal.aborted) {
              const detail = typeof message.result === 'string' && message.result.length > 0
                ? message.result
                : String(message.subtype || 'error')
              // Running out of subscription quota is not an error to report and
              // forget — Claude's own TUI waits the window out and picks the
              // task back up. So does this, in the same turn. Everything else
              // still reads as the error it is.
              const spent = await quotaLimitHit(run.remote)
              if (spent !== null && continues >= QUOTA_MAX_CONTINUES) {
                transcript.note('⚠ 又一次撞上用量上限（' + spent.label + '）· 这一轮已自动续跑 '
                  + continues + ' 次，到此为止')
              } else if (spent !== null) {
                continues += 1
                console.log('cc-mode: quota limit on', sessionId, '— holding turn', turn,
                  'until', new Date(spent.at).toISOString())
                // The wait leaves its own note either way; a turn that resumes
                // keeps reading this very stream.
                if (await waitOutQuota(sessionId, transcript, run, spent, signal)) continue
              } else {
                transcript.note('⚠ Claude Code 报错：' + detail)
              }
            }
            roundEndsAt = message.ccmodeOffset
            return
          }
        }
      } finally {
        done = true
        // Claude appends this turn to its own transcript too. The mirror
        // compares that file against a recorded offset, so without advancing
        // it here the plugin reads its OWN output back and reports it as
        // "the terminal side advanced" — which is exactly what it did.
        skipTranscriptGrowth(sessionId)
        try { stallWatch() } catch (error) { /* already fired */ }
        activeTurns.delete(sessionId)
        // Content that queued while this turn was running has nobody to render
        // it: ask for a turn now that one can start.
        wakeForProjection(sessionId)
        // Claude's turn is over; Claude may not be. A finished background task
        // opens a round of its own, and from here on this is what reads it.
        startIdleDrain(sessionId, run, roundEndsAt)
        // Claude names the conversation a beat AFTER the round lands — the
        // title costs it a model call of its own, so it is not on disk when
        // `result` arrives. Look once the dust has settled; `state.get` picks
        // up anything still unnamed when this looked.
        armTimeout(() => { syncClaudeTitle(sessionId, session).catch(() => undefined) }, 5000)
        // `force`: the window is cached per model choice, but the composition
        // moved with this very turn — the panel should not open on last turn's.
        if (run.cwd) probeContextWindow(sessionId, run.cwd, true).catch(() => undefined)
        if (cancelKill !== null) { try { cancelKill() } catch (error) { /* fired */ } }
        signal.removeEventListener('abort', onAbort)
        transcript.finish()
        lock.release()
      }
    }

    // Images that belong to a message waiting in dsh's queue, by message id.
    // The stash is per session, but a queued message can sit there for minutes
    // while other things happen; binding the images to the message is what lets
    // dsh's own queue row show them and what keeps them from riding some other
    // message out the door.
    const queuedImages = new Map()

    /**
     * Move the pending images onto a message that dsh has queued for the next
     * turn, so the composer's rail empties immediately and dsh's own queue row
     * previews them (`previewOf` renders a non-text block as `[image]`, which is
     * exactly what a queued dsh message with images looks like).
     */
    function adoptQueuedImages(agent, sessionId, message) {
      if (message === undefined || message === null || isCarrier(message)) return
      if (carriesRuntimeNoise(message)) return
      const content = Array.isArray(message.content) ? message.content : []
      if (content.some((block) => block && block.type === 'image')) return
      const images = pendingImages.get(sessionId) || []
      if (images.length === 0) return
      let located
      try {
        located = typeof agent.inbox.locate === 'function' ? agent.inbox.locate(message.id) : undefined
      } catch (error) { return }
      if (located === undefined) return
      pendingImages.delete(sessionId)
      queuedImages.set(message.id, images)
      const next = Object.assign({}, message, {
        content: images.map((image) => ({ type: 'image', attachment: image.attachment })).concat(content),
      })
      try {
        agent.inbox.replace(message.id, next)
        console.log('cc-mode: moved', images.length, 'pending image(s) onto the queued message on', sessionId)
      } catch (error) {
        queuedImages.delete(message.id)
        pendingImages.set(sessionId, images)
        console.error('cc-mode: could not attach images to the queued message:', errorText(error))
      }
    }

    /**
     * 把一条插话写进转录——如果此刻有工具调用还没等到结果，就压到配对之后。
     *
     * 只推迟「写给人看」这一步。发给 Claude 的那一路不受影响：插话的意义就是
     * 立刻拐一下正在跑的那一轮，晚一秒都不算 steering。
     */
    function writeSteered(active, write) {
      const transcript = active === undefined ? undefined : active.transcript
      if (transcript === undefined || typeof transcript.deferUserMessage !== 'function') {
        try { write() } catch (error) { console.error('cc-mode: 写插话失败:', errorText(error)) }
        return
      }
      try { transcript.deferUserMessage(write) } catch (error) { console.error('cc-mode: 写插话失败:', errorText(error)) }
    }

    /**
     * Steering: a message that arrives while a turn is running is written
     * straight into the product's stdin, which folds it into the turn already in
     * flight (verified against the CLI by waku). Without this the message would
     * sit in the inbox until the next turn — the queue behaviour, which dsh
     * offers separately through the `next-turn` target.
     */
    ctx.on('agent/inbox/inserted', (payload) => {
      const agent = payload.agent
      if (agent === undefined) return
      const sessionId = String(agent.id)
      if (stateOf(sessionId).mode !== 'claude') return
      const active = activeTurns.get(sessionId)
      if (active === undefined) return
      let claimed
      try { claimed = agent.inbox.claim('next-step', active.turn) } catch (error) { return }
      // Nothing to steer means the message went to the queue instead (plain
      // Enter while a turn runs). Its images belong to it, not to whoever runs
      // next — see adoptQueuedImages.
      if (claimed.length === 0) { adoptQueuedImages(agent, sessionId, payload.message); return }
      for (const message of claimed) {
        // A carrier that raced into a running turn must neither reach Claude
        // nor stay marked in-flight forever (that would block every later
        // projection wake); its queued content renders on the next turn.
        if (isCarrier(message)) { carriersInFlight.delete(sessionId); continue }
        if (carriesRuntimeNoise(message)) {
          writeSteered(active, () => agent.session.append('user/message', message, { surfaceOp: 'append' }))
          continue
        }
        const text = textOf(message)
        // Images pasted before a mid-turn interjection belong to it: the
        // steering path used to drop them on the floor, so a screenshot sent
        // while Claude was working simply never arrived and the pending rail
        // never emptied.
        const images = pendingImages.get(sessionId) || []
        if (images.length > 0) pendingImages.delete(sessionId)
        // The transcript shows what was actually sent, images included. dsh's
        // UserMessage is frozen, so the attachments ride a copy.
        const shown = images.length === 0 ? message : Object.assign({}, message, {
          content: (message.content || []).concat(images.map((image) => ({ type: 'image', attachment: image.attachment }))),
        })
        // 写进转录的时机要避开「工具跑到一半」：那一刻 tool/call 已经落下、
        // tool/result 还没回来，夹在中间的一条 user/message 会把工具卡片和它的
        // 结果劈成两半。发给 Claude 不用等（下面那句 run.write 立刻走），只有
        // 写给人看的这条排在工具配对齐之后。
        writeSteered(active, () => agent.session.append('user/message', shown, { surfaceOp: 'append' }))
        if (text.length === 0 && images.length === 0) continue
        const content = images.map((image) => ({
          type: 'image',
          source: { type: 'base64', media_type: image.mediaType, data: image.data },
        }))
        if (text.length > 0) content.push({ type: 'text', text: text })
        // A turn held for the usage limit keeps waiting. Writing this now would
        // send Claude straight back into the limit, and its error result would
        // then be read as the end of the resumed round — so the message waits
        // with the turn and rides the continuation out.
        const waiting = quotaWaits.get(sessionId)
        if (waiting !== undefined) {
          waiting.held.push(content)
          safely('quota wait note', () => waiting.note('⏸ 正在等用量重置 —— 这条消息会在恢复后一起发给 Claude'))
          console.log('cc-mode: held a message on', sessionId, 'until the usage limit resets')
          continue
        }
        try {
          active.run.write({
            type: 'user',
            message: { role: 'user', content: content },
            parent_tool_use_id: null,
          })
          console.log('cc-mode: steered the running turn' + (images.length > 0 ? ' with ' + images.length + ' image(s)' : ''))
        } catch (error) {
          console.error('cc-mode: steering failed:', errorText(error))
        }
      }
    })

    // ---------- the seam ----------

    ctx.on('agent/pre-step', async (payload, next) => {
      const agent = payload.agent
      const sessionId = agent === undefined ? '' : String(agent.id)
      if (stateOf(sessionId, agent === undefined ? undefined : agent.session).mode !== 'claude') return next()

      try {
        await driveTurn(agent, payload.messages || [], payload.turn, payload.signal)
      } catch (error) {
        if (!payload.signal.aborted) {
          try {
            const step = 900
            agent.session.append('step/start', { turn: payload.turn, step: step })
            agent.session.append('assistant/message', {
              turn: payload.turn,
              step: step,
              message: {
                id: uuid(),
                role: 'assistant',
                content: [{ type: 'text', text: '⚠ Claude Code 这一轮失败了：' + errorText(error) }],
                source: { kind: 'model', provider: PROVIDER, model: NOTICE_MODEL },
              },
              stream: [],
            }, { surfaceOp: 'append' })
            agent.session.append('step/end', { turn: payload.turn, step: step })
          } catch (appendError) {
            console.error('cc-mode: 记录失败信息时又失败了:', errorText(appendError))
          }
        }
        console.error('cc-mode: turn failed:', errorText(error))
      }
      // REJECT, not an empty `enter`: `agent/pre-step` is a nest of wrappers and
      // the outer ones (agent-instructions, skill-catalog, …) append their context
      // messages to whatever comes back from next(). An empty enter therefore came
      // back non-empty and the loop ran a real DeepSeek step after Claude's turn.
      // Every wrapper passes a rejection through untouched, so this is the only
      // decision that reliably ends the turn without a model request.
      return { kind: 'reject' }
    })

    // ---------- Package-private RPC for the Client half ----------

    /**
     * Whether this conversation is pinned to the machine it already ran on.
     *
     * A Claude conversation is its transcript, and that file lives on ONE
     * machine — the same reason the engine itself cannot be switched after a
     * turn. Moving the target afterwards would open a blank conversation
     * behind an unchanged dsh transcript, so once there is a Claude session
     * id the target is fixed.
     */
    function remoteLockedFor(state) {
      return typeof state.claudeSessionId === 'string' && state.claudeSessionId.length > 0
    }

    /** The targets a picker offers: this machine first, then each declared one. */
    function remoteIndex() {
      return [{ id: '', label: '本机' }].concat(
        [...REMOTES.values()].map((remote) => ({ id: remote.id, label: remote.label, host: remote.host })))
    }

    function publicState(sessionId) {
      const session = sessionOf(sessionId)
      const state = stateOf(sessionId, session)
      const run = runs.get(sessionId)
      const committed = committedEngine(session)
      return {
        mode: state.mode,
        // '' is this machine. Paired with `remoteLocked`, which says the
        // conversation can no longer move: its Claude transcript and broker
        // live on one machine, so re-homing it would strand both.
        remote: typeof state.remote === 'string' ? state.remote : '',
        remoteCwd: typeof state.remoteCwd === 'string' ? state.remoteCwd : '',
        remoteLocked: remoteLockedFor(state),
        permissionMode: state.permissionMode,
        model: state.model,
        // What the process actually runs (from its init handshake) — shown
        // when no explicit model is chosen, instead of a vague "default".
        route: state.route === undefined ? null : state.route,
        effort: state.effort,
        running: run !== undefined && run.reader !== null && !run.closed,
        // A cold conversation still has one — the sidebar's "copy the resume id"
        // entry asks for exactly the sessions that are not running.
        claudeSessionId: run !== undefined && run.claudeSessionId
          ? run.claudeSessionId
          : (state.claudeSessionId || null),
        approvalAvailable: approval !== undefined,
        // Set while a turn is held waiting for the subscription window to
        // reset; the composer counts it down and offers the cancel.
        quotaWait: quotaWaitOf(sessionId),
        // Once a session has taken a turn it belongs to that engine for good.
        committed: committed === undefined ? null : committed,
        locked: committed !== undefined,
      }
    }

    const disposers = [
      harness.handle('catalog', () => ({
        models: MODELS,
        efforts: EFFORTS,
        permissionModes: PERMISSION_MODES,
        defaultModel: DEFAULT_MODEL,
      })),

      // dsh's attachment store rejects an image bigger than these; the client
      // half shrinks a paste to fit rather than letting the store refuse it.
      harness.handle('image.limits', () => {
        const limits = attachments === undefined ? undefined : attachments.imageLimits
        return {
          maxImageBytes: Number(limits && limits.maxImageBytes) || 3670016,
          maxImageDimension: Number(limits && limits.maxImageDimension) || 2000,
          maxImagePixels: Number(limits && limits.maxImagePixels) || 40000000,
          mediaTypes: (limits && limits.mediaTypes) || ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
        }
      }),

      harness.handle('state.get', async (args) => {
        const sessionId = String(args.sessionId || '')
        const session = sessionOf(sessionId)
        const state = stateOf(sessionId, session)
        // Fire-and-forget: content Claude produced across a dsh restart lands
        // in the transcript as soon as it is read, without blocking the UI.
        // Then follow it live, so whatever it says NEXT arrives too — the drain
        // only covers rounds that already finished. Ordered, not parallel: both
        // read the same offset, and following from a pre-drain one would replay
        // what the drain just projected.
        drainDetachedOutput(sessionId, session)
          .then(() => resumeIdleFollow(sessionId, session))
          .catch(() => undefined)
        // A round whose title was not on disk yet when the turn looked.
        syncClaudeTitle(sessionId, session).catch(() => undefined)
        // Likewise for an imported conversation's terminal side.
        syncImportedTranscript(sessionId, session)
        // And recover anything the old high-band numbering stranded.
        repairBandTurns(sessionId, session).catch(() => undefined)
        // A conversation that ran before this plugin version knows its Claude
        // session but not the model the process reported; the broker's logged
        // init handshake still does.
        if (state.route === undefined && state.mode === 'claude'
          && typeof state.claudeSessionId === 'string' && state.claudeSessionId.length > 0) {
          try {
            const init = await lastHandshake(sessionId)
            if (init !== undefined && typeof init.model === 'string' && init.model.length > 0) {
              state.route = init.model
              persistStates()
            } else {
              // No broker log (a conversation imported but never run here):
              // the Claude transcript records both the model and the posture.
              const cwd = projectCwd(sessionId, session) || ''
              if (typeof cwd === 'string' && cwd.length > 0) {
                const path = '"$HOME"/.claude/projects/' + shellQuote(projectSlug(cwd)) + '/'
                  + shellQuote(state.claudeSessionId + '.jsonl')
                const settings = await captureOn(
                  'grep -o \'"permissionMode":"[a-zA-Z]*"\' ' + path + ' 2>/dev/null | tail -1; '
                  + 'grep -o \'"model":"[^"]*"\' ' + path + ' 2>/dev/null | tail -1', remoteOf(state), 20000)
                const posture = (String(settings).match(/"permissionMode":"([a-zA-Z]+)"/) || [])[1]
                const model = (String(settings).match(/"model":"([^"]+)"/) || [])[1]
                let changed = false
                if (posture !== undefined && PERMISSION_MODES.some((entry) => entry.id === posture)
                  && state.permissionMode === 'manual') {
                  state.permissionMode = posture
                  changed = true
                }
                if (model !== undefined && model.length > 0) {
                  state.route = model
                  const bare = model.replace(/\[[^\]]*\]$/, '')
                  // "Untouched" now means the default rather than empty: an
                  // imported conversation adopts the model its transcript
                  // records, but a model the user picked here still wins.
                  if ((state.model.length === 0 || state.model === DEFAULT_MODEL)
                    && MODELS.some((entry) => entry.id === bare)) state.model = bare
                  changed = true
                }
                if (changed) persistStates()
              }
            }
          } catch (error) { /* the chip falls back to "Claude 默认" */ }
        }
        return publicState(sessionId)
      }),

      // Cheap enough for the composer to ask on a short beat: a map lookup,
      // no process, no network. `state.get` cannot serve this — it drains and
      // repairs, and a Claude session stops polling it once it is locked.
      harness.handle('quota.state', (args) => ({
        wait: quotaWaitOf(String(args.sessionId || '')),
      })),

      // The composer's own cancel on the waiting chip. Stop works too — this
      // one only lets go of the wait and keeps the Claude process.
      harness.handle('quota.cancel', (args) => ({
        cancelled: cancelQuotaWait(String(args.sessionId || ''), 'cancelled'),
      })),

      harness.handle('mode.set', (args) => {
        const sessionId = String(args.sessionId || '')
        const session = sessionOf(sessionId)
        const state = stateOf(sessionId, session)
        const wanted = args.mode === 'claude' ? 'claude' : 'dsh'
        const committed = committedEngine(session)
        if (committed !== undefined && committed !== wanted) {
          // Refusing is the whole point: a mixed transcript is a conversation
          // neither engine actually had.
          console.log('cc-mode: refusing to switch', sessionId, 'to', wanted, '— already a', committed, 'conversation')
          state.mode = committed
          return publicState(sessionId)
        }
        // Applied before the mode so a switch to DSH still stops the broker on
        // the machine it is actually running on.
        if (typeof args.remote === 'string' && args.remote !== (state.remote || '')) {
          if (remoteLockedFor(state)) {
            console.log('cc-mode: refusing to move', sessionId, 'to', args.remote || 'this machine',
              '— it already has a Claude conversation on', state.remote || 'this machine')
          } else if (args.remote !== '' && REMOTES.get(args.remote) === undefined) {
            console.error('cc-mode: no SSH target named "' + args.remote + '"')
          } else if (state.mode === 'claude') {
            // Not yet committed, but a broker may already be up on the old
            // machine from a conversation that never took a turn.
            stopRun(sessionId).catch(() => undefined)
            state.remote = args.remote
          } else {
            state.remote = args.remote
          }
        }
        // Same lock as the target itself: the conversation's transcript is
        // filed under its project directory, so moving it strands the history.
        if (typeof args.remoteCwd === 'string' && !remoteLockedFor(state)) {
          state.remoteCwd = args.remoteCwd.trim()
        }
        state.mode = wanted
        if (state.mode === 'dsh') {
          stopRun(sessionId).catch(() => undefined)
          const posture = state.permissionMode
          state.permissionMode = 'dsh-off'
          applySupervision(sessionId, state)
          state.permissionMode = posture
        } else {
          applySupervision(sessionId, state)
        }
        if (agents !== undefined) {
          try {
            const agent = agents.get(sessionId)
            if (agent !== undefined) repairHeader(agent.session)
          } catch (error) {
            console.error('cc-mode: header repair failed:', errorText(error))
          }
        }
        rememberDefaults(state)
        console.log('cc-mode:', sessionId, '->', state.mode)
        return publicState(sessionId)
      }),

      harness.handle('permission.set', (args) => {
        const sessionId = String(args.sessionId || '')
        const state = stateOf(sessionId)
        const wanted = String(args.permissionMode || '')
        if (PERMISSION_MODES.some((entry) => entry.id === wanted)) state.permissionMode = wanted
        applySupervision(sessionId, state)
        rememberDefaults(state)
        persistStates()
        // The posture is a launch flag: the next turn relaunches, resuming the
        // same Claude session so the conversation survives the switch.
        return publicState(sessionId)
      }),

      harness.handle('model.set', (args) => {
        const sessionId = String(args.sessionId || '')
        const state = stateOf(sessionId)
        const wanted = String(args.model === undefined ? state.model : args.model)
        if (MODELS.some((entry) => entry.id === wanted)) state.model = wanted
        if (typeof args.effort === 'string' && EFFORTS.some((entry) => entry.id === args.effort)) {
          state.effort = args.effort
        }
        rememberDefaults(state)
        const run = runs.get(sessionId)
        if (run !== undefined && !run.closed) {
          // Live setter — no relaunch, the conversation keeps going. An empty
          // model means "follow Claude's own default", which the CLI spells
          // as its literal default model name only at launch; live we can only
          // set an explicit model, so an empty choice waits for the next turn.
          applyModel(run, state)
        }
        return publicState(sessionId)
      }),

      // What a deploy must check before restarting dsh: restarting while a
      // Claude turn is live interrupts it, and dsh's crash recovery then
      // settles its open tool call as TOOL_OUTCOME_UNKNOWN.
      harness.handle('busy', () => {
        const live = []
        for (const [sessionId, active] of activeTurns) live.push({ sessionId: sessionId, turn: active.turn })
        return { busy: live.length > 0, turns: live }
      }),

      // TEMPORARY: project one synthetic message the way the drain does, to
      // find out whether projected turns render at all.
      harness.handle('debug.project', (args) => {
        const sessionId = String(args.sessionId || '')
        const session = sessionOf(sessionId)
        if (session === undefined) return { ok: false, reason: 'session not live' }
        const rows = [{ type: 'assistant', message: { model: 'claude-code', content: [{ type: 'text', text: String(args.text || 'PROJECTION-PROBE') }] } }]
        const written = queueProjection(sessionId, rows, '')
        let last = 0
        for (const event of sessionEvents(session)) {
          if (event.type === 'turn/start' && typeof event.data.turn === 'number') last = event.data.turn
        }
        return { ok: true, written: written, lastTurn: last }
      }),

      harness.handle('engines', () => ({ engines: engineIndex() })),

      harness.handle('remotes', () => ({ remotes: remoteIndex() })),

      /**
       * One level of directories on a target, for the working-directory
       * picker. `pwd` comes back with the listing because the shell is what
       * canonicalises the path — the client must never join or normalise a
       * path itself, least of all for a filesystem it cannot see.
       */
      /**
       * Point one conversation at a directory on its target.
       *
       * Its own verb rather than a `mode.set` with an extra field: changing a
       * directory must not drag along a posture re-apply and a header repair.
       * Pinned once the conversation has a Claude session, for the same reason
       * the target itself is — the transcript is filed under the project dir.
       */
      harness.handle('remote.cwd.set', (args) => {
        const sessionId = String((args && args.sessionId) || '')
        const state = stateOf(sessionId, sessionOf(sessionId))
        const wanted = String((args && args.remoteCwd) || '').trim()
        if (remoteLockedFor(state)) {
          console.log('cc-mode: refusing to move', sessionId, '— it already has a Claude conversation in',
            state.remoteCwd || '（目标的默认目录）')
        } else if (wanted !== (state.remoteCwd || '')) {
          state.remoteCwd = wanted
          rememberDir(remoteOf(state), wanted, workspaceOf(sessionId))
          persistStates()
          console.log('cc-mode:', sessionId, 'works in', wanted || '（目标的默认目录）')
        }
        return publicState(sessionId)
      }),

      harness.handle('remote.dirs', async (args) => {
        const remote = REMOTES.get(String((args && args.remote) || ''))
        if (remote === undefined) return { ok: false, reason: 'no-remote' }
        const asked = String((args && args.path) || '').trim()
        const base = asked.length > 0 ? asked : await remoteCwdOf({}, remote)
        const raw = await captureOn(
          'cd ' + shellQuote(base) + ' 2>/dev/null || exit 0; pwd; '
          + 'for d in */ .*/; do case "$d" in ./|../) continue;; esac; '
          + '[ -d "$d" ] || continue; printf "%s\\n" "${d%/}"; done', remote, 15000)
        const lines = String(raw).split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
        if (lines.length === 0) return { ok: false, reason: 'unreadable', path: base }
        const path = lines[0]
        return { ok: true, path: path, parent: parentDir(path), dirs: lines.slice(1).sort() }
      }),

      /**
       * Create one directory on a target — "新建项目到远端目录" without
       * leaving the picker. `mkdir -p` so re-picking an existing name is a
       * no-op rather than an error.
       */
      harness.handle('remote.mkdir', async (args) => {
        const remote = REMOTES.get(String((args && args.remote) || ''))
        if (remote === undefined) return { ok: false, reason: 'no-remote' }
        const at = String((args && args.path) || '').trim()
        const name = String((args && args.name) || '').trim()
        if (at.length === 0 || name.length === 0 || name.indexOf('/') >= 0 || name === '.' || name === '..') {
          return { ok: false, reason: 'bad-name' }
        }
        const full = (at === '/' ? '' : at) + '/' + name
        const raw = await captureOn(
          'mkdir -p ' + shellQuote(full) + ' 2>&1 && cd ' + shellQuote(full) + ' && pwd', remote, 15000)
        const path = String(raw).trim().split('\n').pop()
        if (typeof path !== 'string' || path.indexOf('/') !== 0) return { ok: false, reason: 'mkdir-failed' }
        return { ok: true, path: path }
      }),

      harness.handle('commands', (args) => {
        const names = claudeCommands(
          args !== null && args !== undefined && typeof args.sessionId === 'string' && args.sessionId.length > 0
            ? remoteOf(stateOf(args.sessionId))
            : browsingRemote(args))
        return { commands: names, oneShot: names.filter((name) => ONE_SHOT_COMMANDS.has(name)) }
      }),

      harness.handle('claude.info', async (args) => {
        const sessionId = String(args.sessionId || '')
        const session = sessionOf(sessionId)
        const cwd = typeof args.cwd === 'string' && args.cwd.length > 0
          ? args.cwd
          : (session !== undefined && session.header ? session.header.cwd : '')
        const init = await lastHandshake(sessionId)
        if (init === undefined) return { known: false }
        const scopes = await mcpScopes(cwd, remoteOf(stateOf(sessionId)))
        return {
          known: true,
          cwd: init.cwd || cwd,
          model: init.model || '',
          version: init.claude_code_version || '',
          permissionMode: init.permissionMode || '',
          outputStyle: init.output_style || '',
          toolCount: Array.isArray(init.tools) ? init.tools.length : 0,
          agents: Array.isArray(init.agents) ? init.agents : [],
          skills: Array.isArray(init.skills) ? init.skills.map((entry) => (typeof entry === 'string' ? entry : entry.name)) : [],
          plugins: Array.isArray(init.plugins) ? init.plugins.map((entry) => (typeof entry === 'string' ? entry : entry.name)) : [],
          memoryPaths: Array.isArray(init.memory_paths) ? init.memory_paths : [],
          mcpServers: (Array.isArray(init.mcp_servers) ? init.mcp_servers : []).map((entry) => ({
            name: String(entry.name || ''),
            status: String(entry.status || ''),
            scope: (scopes[String(entry.name || '')] || {}).scope || 'unknown',
          })),
        }
      }),

      harness.handle('claude.command', async (args) => {
        const sessionId = String(args.sessionId || '')
        const command = String(args.command || '')
        if (command.length === 0) throw new Error('cc-mode: 没有给出要执行的命令')
        const session = sessionOf(sessionId)
        const cwd = typeof args.cwd === 'string' && args.cwd.length > 0
          ? args.cwd
          : (session !== undefined && session.header ? session.header.cwd : '')
        if (typeof cwd !== 'string' || cwd.length === 0) {
          throw new Error('cc-mode: 这个会话没有工作目录 — Claude Code 必须在某个 cwd 里跑')
        }
        return runOneShotCommand(sessionId, cwd, command)
      }),

      harness.handle('claude.command.poll', (args) => commandJobState(String(args.jobId || ''))),

      /**
       * Claude's own context composition, for dsh's context panel.
       *
       * Serves the cached report immediately and refreshes behind it when it
       * has gone stale, so opening the panel never waits on a round trip and
       * the second open shows the newer figures. A running turn owns the
       * stream, so a refresh simply does not happen then — the panel keeps the
       * last honest answer instead of blocking or lying.
       */
      harness.handle('context.breakdown', (args) => {
        const sessionId = String(args.sessionId || '')
        const state = stateOf(sessionId, sessionOf(sessionId))
        if (state.mode !== 'claude') return { known: false }
        const report = contextReports.get(sessionId)
        const stale = report === undefined || Date.now() - report.at > 30000
        if (stale && args.refresh !== false) {
          const session = sessionOf(sessionId)
          const run = runs.get(sessionId)
          const cwd = run !== undefined && typeof run.cwd === 'string' && run.cwd.length > 0
            ? run.cwd
            : (session !== undefined && session.header ? session.header.cwd : '')
          if (typeof cwd === 'string' && cwd.length > 0) {
            probeContextWindow(sessionId, cwd, true).catch(() => undefined)
          }
        }
        if (report === undefined) return { known: false }
        return {
          known: true,
          systemTokens: report.system,
          toolsTokens: report.tools,
          messageTokens: report.messages,
          at: report.at,
        }
      }),

      // The client half reports here when a DOM-injected surface cannot find
      // what it expects; there is no other way to see inside the page.
      harness.handle('debug', (args) => {
        console.log('cc-mode [client]', JSON.stringify(args).slice(0, 700))
        return { ok: true }
      }),

      /**
       * 可以从哪些地方导入 Claude 对话：本机，加上每一个已声明的目标。
       *
       * 每个源都自带 cwd，而且必须是**那台机器上的**路径——transcript 的目录名
       * 是 cwd 算出来的 slug，拿 dsh 工作区的本机路径去问远端，只会找到一个空
       * 目录，然后「这个目录下没有 Claude 对话」。目标的 cwd 优先用这个项目在
       * 它上面记着的工作目录（见 lookupDir），其次是目标自己声明的 dir，最后
       * 才去问它的 home。
       */
      harness.handle('claude.sources', async (args) => {
        const sessionId = String(args.sessionId || '')
        const workspace = workspaceOf(sessionId)
        const here = String(args.cwd || workspace || '')
        const targets = [...REMOTES.values()]
        // 并行问，否则几个目标的 home 查询会一个接一个地串起来等。
        const resolved = await Promise.all(targets.map(async (remote) => {
          let cwd = lookupDir(workspace, remote.id) || remote.dir
          if (cwd.length === 0) {
            try { cwd = await remoteHome(remote) } catch (error) { cwd = '' }
          }
          return { id: remote.id, label: remote.label, cwd: cwd }
        }))
        return { sources: [{ id: '', label: '本机', cwd: here }].concat(resolved) }
      }),

      harness.handle('claude.conversations', async (args) => {
        const cwd = String(args.cwd || '')
        if (cwd.length === 0) return { conversations: [] }
        return { conversations: await listClaudeConversations(cwd, browsingRemote(args)) }
      }),

      harness.handle('claude.search', async (args) => {
        const cwd = String(args.cwd || '')
        if (cwd.length === 0) return { hits: [] }
        return searchClaudeConversations(cwd, String(args.query || ''), browsingRemote(args))
      }),

      harness.handle('claude.preview', async (args) => previewClaudeConversation(
        String(args.cwd || ''), String(args.claudeSessionId || ''), 40, browsingRemote(args))),

      /** Adopt an existing Claude conversation into this (blank) dsh session. */
      harness.handle('claude.adopt', async (args) => {
        const sessionId = String(args.sessionId || '')
        const claudeSessionId = String(args.claudeSessionId || '')
        const session = sessionOf(sessionId)
        const committed = committedEngine(session)
        if (committed === 'dsh') return { ok: false, reason: 'this conversation already belongs to the DSH engine' }
        const state = stateOf(sessionId, session)
        state.mode = 'claude'
        state.claudeSessionId = claudeSessionId
        // 从哪台机器导来的，这个会话就钉在哪台机器上。少了这一步，导入一条远端
        // 对话之后会话仍然指着本机：--resume 会去本机找一个根本不在那儿的
        // transcript，而那正是「重开一个空 Claude」的入口。
        if (typeof args.remote === 'string' && REMOTES.get(args.remote) !== undefined) {
          state.remote = args.remote
        } else if (typeof args.remote === 'string' && args.remote === '') {
          state.remote = ''
        }
        // 远端对话的工作目录也是那边的路径，一并记下——它既是 transcript 的
        // slug 来源，也是这个会话之后开工的地方。
        const remoteNow = remoteOf(state)
        if (remoteNow !== null && typeof args.cwd === 'string' && args.cwd.length > 0) {
          state.remoteCwd = args.cwd
          rememberDir(remoteNow, args.cwd, workspaceOf(sessionId))
        }
        stopRun(sessionId).catch(() => undefined)
        persistStates()

        // Make the import VISIBLE: without this the adopted conversation opens
        // empty and reads as a failed import, even though resuming works.
        let backfill = { backfilled: 0, skipped: 'session not live' }
        const cwd = typeof args.cwd === 'string' && args.cwd.length > 0
          ? args.cwd
          : (projectCwd(sessionId, session) || '')
        if (session !== undefined && typeof cwd === 'string' && cwd.length > 0) {
          try {
            backfill = await backfillClaudeTranscript(sessionId, session, cwd, claudeSessionId)
          } catch (error) {
            backfill = { backfilled: 0, skipped: errorText(error) }
            console.error('cc-mode: transcript backfill failed:', errorText(error))
          }
        }
        console.log('cc-mode:', sessionId, 'adopted Claude conversation', claudeSessionId,
          '— backfilled', backfill.backfilled, 'message(s)', backfill.skipped ? '(' + backfill.skipped + ')' : '')
        return { ok: true, state: publicState(sessionId), backfill: backfill }
      }),

      harness.handle('image.stash', async (args) => {
        const sessionId = String(args.sessionId || '')
        if (sessionId.length === 0) throw new Error('cc-mode: image.stash 需要 sessionId')
        const count = await stashImage(sessionId, args.mediaType, args.data)
        return { count: count }
      }),

      harness.handle('image.pending', (args) => {
        const list = pendingImages.get(String(args.sessionId || '')) || []
        return { count: list.length }
      }),

      harness.handle('image.clear', (args) => {
        pendingImages.delete(String(args.sessionId || ''))
        return { count: 0 }
      }),

      // One card's ✕ removes one image. The rail used to wire every card to
      // image.clear, so dropping one of two dropped both.
      harness.handle('image.remove', (args) => {
        const sessionId = String(args.sessionId || '')
        const list = pendingImages.get(sessionId) || []
        const index = Number(args.index)
        if (!Number.isInteger(index) || index < 0 || index >= list.length) return { count: list.length }
        list.splice(index, 1)
        if (list.length === 0) pendingImages.delete(sessionId)
        else pendingImages.set(sessionId, list)
        return { count: list.length }
      }),

      harness.handle('usage', (args) => usageSnapshot(
        args !== null && args !== undefined && args.force === true,
        args !== null && args !== undefined && typeof args.sessionId === 'string' && args.sessionId.length > 0
          ? remoteOf(stateOf(args.sessionId))
          : browsingRemote(args))),

      // The engine seat locks, but ending the process must stay possible.
      harness.handle('claude.stop', async (args) => {
        const sessionId = String(args.sessionId || '')
        await stopRun(sessionId)
        return publicState(sessionId)
      }),

      harness.handle('restart', async (args) => {
        const sessionId = String(args.sessionId || '')
        await stopRun(sessionId)
        return publicState(sessionId)
      }),
    ]

    // A控制面 for other packages (the integration-test harness uses it, and it
    // is the seam any future dsh-side automation would drive the engine through).
    // Automation, unlike a human, must not move the DEFAULTS: `rememberDefaults`
    // records "what the user last chose" for the next new conversation, and a
    // parent agent configuring one child is not the user changing their mind.
    // The choice still has to be DURABLE, though — a child switched to Claude
    // before its first turn has nothing in its log to infer the engine from, so
    // a restart would hand it back to dsh.
    ctx.provide('ccmodeControl', {
      state: (sessionId) => publicState(String(sessionId)),
      setMode: (sessionId, mode) => {
        const session = sessionOf(String(sessionId))
        const state = stateOf(String(sessionId), session)
        const committed = committedEngine(session)
        const wanted = mode === 'claude' ? 'claude' : 'dsh'
        if (committed !== undefined && committed !== wanted) return publicState(String(sessionId))
        state.mode = wanted
        if (state.mode === 'dsh') stopRun(String(sessionId)).catch(() => undefined)
        applySupervision(String(sessionId), state)
        persistStates()
        return publicState(String(sessionId))
      },
      /**
       * Put one conversation on a target, and optionally in a directory there.
       *
       * Without this a conversation opened by automation could only inherit
       * whatever target the last human choice left behind — fine for one
       * machine, useless for "this child on the container, that one here".
       * Pinned once the conversation has a Claude session, for the same reason
       * the chip locks: the transcript lives on one machine.
       */
      setRemote: (sessionId, remoteId, remoteCwd) => {
        const id = String(sessionId)
        const state = stateOf(id)
        const wanted = typeof remoteId === 'string' ? remoteId : ''
        if (remoteLockedFor(state)) return publicState(id)
        if (wanted !== '' && REMOTES.get(wanted) === undefined) {
          throw new Error('cc-mode: no SSH/container target named "' + wanted + '"')
        }
        if (wanted !== (state.remote || '')) {
          stopRun(id).catch(() => undefined)
          state.remote = wanted
          // A directory on the old machine means nothing on the new one.
          state.remoteCwd = lookupDir(workspaceOf(id), wanted)
        }
        if (typeof remoteCwd === 'string' && remoteCwd.trim().length > 0) {
          state.remoteCwd = remoteCwd.trim()
          rememberDir(remoteOf(state), state.remoteCwd, workspaceOf(id))
        }
        persistStates()
        return publicState(id)
      },
      /** The targets this deployment can drive, for a picker that is not the chip. */
      remotes: () => remoteIndex(),
      setPosture: (sessionId, posture) => {
        const state = stateOf(String(sessionId))
        if (PERMISSION_MODES.some((entry) => entry.id === posture)) state.permissionMode = posture
        applySupervision(String(sessionId), state)
        persistStates()
        return publicState(String(sessionId))
      },
      setModel: (sessionId, model, effort) => {
        const state = stateOf(String(sessionId))
        if (typeof model === 'string' && MODELS.some((entry) => entry.id === model)) state.model = model
        if (typeof effort === 'string' && EFFORTS.some((entry) => entry.id === effort)) state.effort = effort
        const run = runs.get(String(sessionId))
        if (run !== undefined && run.proc !== null && !run.closed && state.model.length > 0) {
          try { run.control({ subtype: 'set_model', model: state.model }) } catch (error) { /* dead */ }
        }
        persistStates()
        return publicState(String(sessionId))
      },
      stop: (sessionId) => { stopRun(String(sessionId)).catch(() => undefined); return true },
      // Exposed for the integration harness: the same thing a hot update does.
      detach: (sessionId) => detach(String(sessionId)),
      sessionDir: (sessionId) => sessionDir(String(sessionId)),
      usage: (force, sessionId) => usageSnapshot(force === true,
        typeof sessionId === 'string' && sessionId.length > 0 ? remoteOf(stateOf(sessionId)) : null),
    })

    // The teardown below sets `shuttingDown` too late to help: dsh aborts the
    // in-flight turns inside the same dispose that eventually reaches this
    // plugin, so the abort handler runs first and — before this — interrupted
    // Claude. The signal arrives before any of it. dsh installs its own
    // SIGTERM/SIGINT handlers, so adding these changes no termination
    // behaviour; they only make the plugin hear the news first.
    ctx.effect(() => {
      const noteShutdown = () => { shuttingDown = true }
      process.on('SIGTERM', noteShutdown)
      process.on('SIGINT', noteShutdown)
      return () => {
        process.removeListener('SIGTERM', noteShutdown)
        process.removeListener('SIGINT', noteShutdown)
      }
    }, 'cc-mode: hear about shutdown before the turns are aborted')

    ctx.effect(() => () => {
      shuttingDown = true
      // Detach, never stop: a hot update or a stop must not end a turn that is
      // still running. The broker keeps Claude alive and the next attach
      // resumes the stream from where this one stopped reading.
      for (const sessionId of Array.from(runs.keys())) detach(sessionId)
      for (const dispose of disposers) dispose()
    }, 'cc-mode teardown')

    // Hygiene on start and every half hour; detaching keeps Claude alive, this
    // keeps that from meaning forever.
    loadPersistedStates().catch((error) => console.error('cc-mode: could not restore settings:', errorText(error)))
    armTimeout(rebindServices, 2000)

    // A conversation left with an unanswered Claude tool call rejects every
    // later model request ("assistant message with 'tool_calls' must be followed
    // by tool messages"), including DSH ones — it cannot recover on its own.
    safely('startup repair', () => {
      if (agents === undefined) return
      let total = 0
      for (const agent of agents.list()) total += repairDanglingToolCalls(agent.session)
      if (total > 0) console.log('cc-mode: repaired', total, 'interrupted tool call(s) across live conversations')
    })
    reapIdleBrokers().catch((error) => console.error('cc-mode: reap failed:', errorText(error)))
    ctx.interval(() => { reapIdleBrokers().catch(() => undefined) }, 10 * 60 * 1000)

    console.log('cc-mode: host v100 ready — approval bridge', approval === undefined ? 'off' : 'on')
  },
}
