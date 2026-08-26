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
      const missing = [
        approval === undefined ? 'approval' : '',
        userQuestions === undefined ? 'userQuestions' : '',
        attachments === undefined ? 'attachments' : '',
        agents === undefined ? 'agents' : '',
        sessionTitle === undefined ? 'sessionTitle' : '',
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
        const line = await runCapture(['/bin/sh', '-c',
          'grep -a \'"subtype":"init"\' ' + shellQuote(run.dir + '/out.log') + ' | tail -1 | head -c 4000'], 8000)
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
    // Posture, model and effort are the user's choices about a conversation, so
    // they belong to the conversation — not to this process's memory. They are
    // read back at startup, which is why an older Claude chat opens with the
    // posture it was left on instead of the default.
    // Under $HOME, not /tmp: this is what lets an older conversation be picked
    // up again — posture, model, and above all the Claude session id to resume.
    const STATE_DIR = '"$HOME"/.cache/ccmode'
    const STATE_PATH = STATE_DIR + '/state.json'
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
      for (const event of session.events) {
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
        state = { mode: 'dsh', permissionMode: 'manual', model: DEFAULT_MODEL, effort: '', route: undefined }
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
        const count = session === undefined ? 0 : session.events.length
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

    async function loadPersistedStates() {
      const raw = await runCapture(['/bin/sh', '-c', 'cat ' + STATE_PATH + ' 2>/dev/null'], 5000)
      let stored = null
      try { stored = JSON.parse(raw) } catch (error) { stored = null }
      if (stored === null || typeof stored !== 'object') return
      if (Array.isArray(stored['#commands'])) commandCache = stored['#commands']
      for (const sessionId of Object.keys(stored)) {
        if (sessionId === '#commands') continue
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
        if (typeof saved.claudeSessionId === 'string' && saved.claudeSessionId.length > 0) state.claudeSessionId = saved.claudeSessionId
      }
      console.log('cc-mode: restored settings for', Object.keys(stored).length, 'conversations')
    }

    /** Persist the per-conversation choices, coalesced to one write per tick. */
    function persistStates() {
      if (statePersistScheduled) return
      statePersistScheduled = true
      armTimeout(() => {
        statePersistScheduled = false
        const out = {}
        if (commandCache.length > 0) out['#commands'] = commandCache
        for (const [sessionId, state] of states) {
          const claudeSessionId = state.claudeSessionId === undefined ? '' : state.claudeSessionId
          if (state.mode === 'dsh' && state.permissionMode === 'manual' && state.model === DEFAULT_MODEL
            && state.effort === '' && claudeSessionId === '') continue
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
            ...(claudeSessionId === '' ? {} : { claudeSessionId: claudeSessionId }),
          }
        }
        try {
          const proc = silenceStdin(subprocess.spawn({
            argv: ['/bin/sh', '-c', 'mkdir -p ' + STATE_DIR + ' && cat > ' + STATE_PATH],
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
      for (const event of session.events) {
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
        closeStep()
      }

      function beginStep() {
        closeStep()
        stepNumber += 1
        session.append('step/start', { turn: turn, step: stepNumber })
        open = { step: stepNumber, chunkSeqs: [], blocks: new Map(), assistantLogged: false }
        return open
      }

      function currentStep() { return open === undefined ? beginStep() : open }

      function appendChunk(step, chunk) {
        const event = session.append('assistant/chunk', { turn: turn, step: step.step, chunk: chunk })
        step.chunkSeqs.push(event.seq)
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
        const step = (open === undefined || open.assistantLogged) ? beginStep() : open
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
          },
          { surfaceOp: 'append', sourceEventSeqs: step.chunkSeqs.slice() },
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
        }, { surfaceOp: 'append' })
      }

      return {
        streamEvent: streamEvent,
        assistantMessage: assistantMessage,
        hadAssistant: () => loggedAssistant,
        toolResults: toolResults,
        note: note,
        finish: finish,
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
    const BROKER_ROOT = '/tmp/ccmode'
    const BROKER_PATH = BROKER_ROOT + '/broker.mjs'
    const BROKER_SOURCE = "// cc-mode broker \u2014 owns one Claude Code process so the dsh plugin can come and\n// go without killing it.\n//\n// Written to /tmp/ccmode/broker.mjs by the plugin and started detached\n// into its own session, so it survives a plugin hot-update, a plugin stop,\n// and a dsh restart. The plugin attaches by tailing `out.log` from a byte offset and\n// speaks to Claude by writing lines into the `in` fifo. Nothing in the plugin\n// holds the process itself.\n//\n// Layout of a session directory:\n//   in         fifo   \u2192 Claude's stdin (held open r+ so writers never EOF it)\n//   out.log    file   \u2192 every stdout line, append-only; the attach point\n//   meta.json  file   \u2192 pid, child pid, claude session id, launch snapshot\n//   exit.json  file   \u2192 written once the child exits\n\nimport { spawn } from 'node:child_process'\nimport fs from 'node:fs'\n\nconst dir = process.argv[2]\nconst argv = process.argv.slice(3)\nif (typeof dir !== 'string' || argv.length === 0) {\n  console.error('usage: broker.mjs <dir> <argv...>')\n  process.exit(2)\n}\n\nconst out = fs.createWriteStream(dir + '/out.log', { flags: 'a' })\n\nfunction record(value) {\n  out.write(JSON.stringify(value) + '\\n')\n}\n\nconst child = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] })\n\nfunction patchMeta(patch) {\n  let meta = {}\n  try { meta = JSON.parse(fs.readFileSync(dir + '/meta.json', 'utf8')) } catch (error) { meta = {} }\n  fs.writeFileSync(dir + '/meta.json', JSON.stringify({ ...meta, ...patch }))\n}\n\npatchMeta({ brokerPid: process.pid, childPid: child.pid, startedAt: Date.now() })\n\nchild.stdout.pipe(out, { end: false })\nchild.stderr.on('data', (chunk) => {\n  const text = String(chunk).trim()\n  if (text.length > 0) record({ type: 'cc-stderr', text: text })\n})\n\n// Holding the fifo open for read AND write is what keeps it from ending the\n// moment a `cat > in` writer closes: there is always one writer (us).\nconst fifo = fs.openSync(dir + '/in', 'r+')\nfs.createReadStream(null, { fd: fifo }).pipe(child.stdin)\nchild.stdin.on('error', () => { /* the child went away; the exit handler reports it */ })\n\nchild.on('exit', (code, signal) => {\n  record({ type: 'cc-exit', exitCode: code, signal: signal })\n  try { fs.writeFileSync(dir + '/exit.json', JSON.stringify({ code: code, signal: signal, at: Date.now() })) } catch (error) { /* best effort */ }\n  setTimeout(() => process.exit(0), 200)\n})\n\n// A broker with no child is pointless; a broker whose parent died is the point.\nprocess.on('SIGHUP', () => { /* survive the detaching shell */ })\n"

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

    function shellQuote(value) {
      return "'" + String(value).replace(/'/g, "'\\''") + "'"
    }

    /** What forces a fresh Claude process: posture and effort are launch flags. */
    function launchSnapshot(state) {
      return state.permissionMode + '|' + state.effort
    }

    function sessionDir(sessionId) {
      return BROKER_ROOT + '/' + String(sessionId).replace(/[^A-Za-z0-9_.-]/g, '_')
    }

    /** Write the broker to disk once per process; it is tiny and idempotent. */
    let brokerReady = null
    function ensureBroker() {
      if (brokerReady !== null) return brokerReady
      brokerReady = (async () => {
        const proc = silenceStdin(subprocess.spawn({
          argv: ['/bin/sh', '-c', 'mkdir -p ' + shellQuote(BROKER_ROOT) + ' && cat > ' + shellQuote(BROKER_PATH)],
          cwd: '/',
          stdio: { stdin: 'pipe', stdout: 'ignore', stderr: 'ignore' },
          graceMs: 2000,
        }))
        if (proc.stdin !== undefined) {
          proc.stdin.write(BROKER_SOURCE)
          proc.stdin.end()
        }
        try { await proc.done } catch (error) { /* reported by the first attach */ }
      })()
      return brokerReady
    }

    async function readJsonFile(path) {
      const raw = await runCapture(['/bin/sh', '-c', 'cat ' + shellQuote(path) + ' 2>/dev/null'], 5000)
      try { return JSON.parse(raw) } catch (error) { return null }
    }

    async function isAlive(pid) {
      if (typeof pid !== 'number' || pid <= 0) return false
      const answer = await runCapture(['/bin/sh', '-c', 'kill -0 ' + pid + ' 2>/dev/null && echo yes || echo no'], 5000)
      return answer.indexOf('yes') === 0
    }

    // `stat -c` is GNU; macOS ships BSD stat (`-f`). Every stat goes through
    // the pair, first flavour that answers wins.
    async function fileSize(path) {
      const answer = await runCapture(['/bin/sh', '-c',
        'stat -c %s ' + shellQuote(path) + ' 2>/dev/null || stat -f %z ' + shellQuote(path) + ' 2>/dev/null || echo 0'], 5000)
      const size = parseInt(String(answer).trim(), 10)
      return isNaN(size) ? 0 : size
    }

    /**
     * Size of a path that is ALREADY a shell word (the transcript paths carry
     * their own quoting because "$HOME" must expand). Quoting it again with
     * shellQuote would stat a literal `"$HOME"/...` and silently answer 0 —
     * which is how an import once recorded offset 0 and re-mirrored history.
     */
    async function fileSizeOfShellWord(word) {
      const answer = await runCapture(['/bin/sh', '-c',
        'stat -c %s ' + word + ' 2>/dev/null || stat -f %z ' + word + ' 2>/dev/null || echo 0'], 5000)
      const size = parseInt(String(answer).trim(), 10)
      return isNaN(size) ? 0 : size
    }

    function createRun(sessionId, dir, snapshot, claudeSessionId) {
      const run = {
        sessionId: sessionId,
        dir: dir,
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
      }

      run.push = (value) => {
        if (value !== undefined) run.sawAnyMessage = true
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

    /** Record how far this attach has consumed, so a hard kill cannot lie. */
    function checkpointOffset(run) {
      if (run.checkpointing === true) return
      run.checkpointing = true
      const offset = typeof run.consumed === 'number' ? run.consumed : run.offset
      const writer = silenceStdin(subprocess.spawn({
        argv: ['/bin/sh', '-c', 'cat > ' + shellQuote(run.dir + '/attach.json')],
        cwd: '/',
        stdio: { stdin: 'pipe', stdout: 'ignore', stderr: 'ignore' },
        graceMs: 1000,
      }))
      if (writer === undefined || writer === null || writer.stdin === undefined) {
        run.checkpointing = false
        return
      }
      try {
        writer.stdin.write(JSON.stringify({ offset: offset }))
        writer.stdin.end()
      } catch (error) { /* the next checkpoint tries again */ }
      writer.done.then(() => { run.checkpointing = false }, () => { run.checkpointing = false })
    }

    /** Put one line into a run's fifo and wait until it is actually in. */
    async function deliverLine(run, line) {
      const writer = silenceStdin(subprocess.spawn({
        argv: ['/bin/sh', '-c', 'cat > ' + shellQuote(run.dir + '/in')],
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
      run.reader = subprocess.spawn({
        argv: ['/usr/bin/env', 'tail', '-c', '+' + (run.offset + 1), '-f', run.dir + '/out.log'],
        cwd: '/',
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' },
        graceMs: 1000,
      })
      pumpAttached(run)
    }

    /** Let go of the process without ending it. */
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
        try {
          const proc = silenceStdin(subprocess.spawn({
            argv: ['/bin/sh', '-c', 'cat > ' + shellQuote(run.dir + '/attach.json')],
            cwd: '/',
            stdio: { stdin: 'pipe', stdout: 'ignore', stderr: 'ignore' },
            graceMs: 1000,
          }))
          if (proc.stdin !== undefined) { proc.stdin.write(patch); proc.stdin.end() }
          proc.done.catch(() => undefined)
        } catch (error) { /* the offset falls back to EOF */ }
      }
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
    async function parentClaudeSession(sessionId, cwd) {
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
      if (await fileSizeOfShellWord(transcript) <= 0) {
        console.log('cc-mode:', sessionId, 'was forked from', parent,
          'but that Claude transcript is gone — starting fresh')
        return null
      }
      return parentId
    }

    async function ensureRun(sessionId, cwd, signal) {
      const state = stateOf(sessionId)
      const snapshot = launchSnapshot(state)
      const live = runs.get(sessionId)
      if (live !== undefined && !live.closed && live.snapshot === snapshot) {
        // The broker can disappear underneath a run: the reaper collects an
        // idle one, or somethingexternal kills it. The run object survives with a
        // reader tailing a deleted log and a writer whose `cat > .../in`
        // silently recreates the fifo path as an ordinary file — the prompt
        // then goes nowhere and the turn waits forever. One `kill -0` per turn
        // is cheap insurance.
        if (await isAlive(live.brokerPid)) return live
        console.log('cc-mode: the broker for', sessionId, 'is gone — starting a fresh Claude and resuming')
        detach(sessionId)
      }

      const dir = sessionDir(sessionId)
      await ensureBroker()

      // Is a broker for this session already running, from before an update or
      // a restart? Then attach instead of starting a second Claude.
      const meta = await readJsonFile(dir + '/meta.json')
      const exited = await readJsonFile(dir + '/exit.json')
      const brokerLives = meta !== null && exited === null && await isAlive(meta.brokerPid)
      const sameLaunch = meta !== null && meta.snapshot === snapshot

      if (live !== undefined) detach(sessionId)

      if (brokerLives && sameLaunch) {
        const attachState = await readJsonFile(dir + '/attach.json')
        const run = createRun(sessionId, dir, snapshot, meta.claudeSessionId)
        run.brokerPid = meta.brokerPid
        run.cwd = meta.cwd || cwd
        // A clean detach recorded where it stopped; a crash did not, and then
        // resuming at the end is right — everything before it is already in the
        // dsh transcript.
        run.offset = attachState !== null && typeof attachState.offset === 'number'
          ? attachState.offset
          : await fileSize(dir + '/out.log')
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
      if (meta !== null) await runCapture(['/bin/sh', '-c',
        'kill ' + (typeof meta.brokerPid === 'number' ? meta.brokerPid : 0) + ' 2>/dev/null; '
        + 'kill ' + (typeof meta.childPid === 'number' ? meta.childPid : 0) + ' 2>/dev/null; true'], 5000)

      const executable = await subprocess.resolveExecutable('claude')
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
        if (await fileSizeOfShellWord(transcript) <= 0) {
          console.log('cc-mode: recorded Claude session', resume, 'has no transcript on disk — starting a fresh one')
          resume = null
        }
      }
      // Nothing to resume, but dsh may have forked this conversation out of
      // one that does have a Claude behind it. Branch that instead of opening
      // a blank one under a transcript full of someone else's history.
      const forkFrom = resume === null ? await parentClaudeSession(sessionId, cwd) : null
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
      if (state.model.length > 0) argv.push('--model', state.model)
      if (state.effort.length > 0) argv.push('--effort', state.effort)
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
      const nodeBin = typeof process !== 'undefined' && typeof process.execPath === 'string' && process.execPath.length > 0
        ? process.execPath
        : 'node'
      const detachLauncher = 'const cp=require("child_process");'
        + 'cp.spawn(process.execPath,process.argv.slice(1),{detached:true,stdio:"ignore"}).unref()'
      const launch = 'set -e; '
        + 'mkdir -p ' + shellQuote(dir) + '; '
        + 'rm -f ' + shellQuote(dir + '/exit.json') + ' ' + shellQuote(dir + '/attach.json') + '; '
        + '[ -p ' + shellQuote(dir + '/in') + ' ] || mkfifo ' + shellQuote(dir + '/in') + '; '
        + 'touch ' + shellQuote(dir + '/out.log') + '; '
        + 'printf %s ' + shellQuote(metaSeed) + ' > ' + shellQuote(dir + '/meta.json') + '; '
        + 'cd ' + shellQuote(cwd) + '; '
        + shellQuote(nodeBin) + ' -e ' + shellQuote(detachLauncher) + ' ' + shellQuote(BROKER_PATH) + ' ' + shellQuote(dir) + ' '
        + argv.map(shellQuote).join(' ')
        + '; echo started'

      const started = subprocess.spawn({
        argv: ['/bin/sh', '-c', launch],
        cwd: cwd,
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
        graceMs: 3000,
        ...(env === undefined ? {} : { env: env }),
      })
      ;(async () => {
        try { for await (const chunk of started.stderr) console.error('cc-mode [launch]', String(chunk).trim()) } catch (error) { /* closed */ }
      })()
      try { await started.done } catch (error) { /* the meta poll below decides */ }

      const run = createRun(sessionId, dir, snapshot, claudeSessionId)
      run.cwd = cwd
      run.offset = 0
      const spawned = await readJsonFile(dir + '/meta.json')
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
        seeded = await readJsonFile(dir + '/meta.json')
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
      const listing = await runCapture(['/bin/sh', '-c',
        'for d in ' + shellQuote(BROKER_ROOT) + '/session-*; do '
        + '[ -d "$d" ] || continue; '
        + 'echo "$d|$(stat -c %Y "$d/out.log" 2>/dev/null || stat -f %m "$d/out.log" 2>/dev/null || echo 0)"; done'], 8000)
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
        if (parts.length !== 2 || parts[0].length === 0) continue
        const dir = parts[0]
        const touchedAt = parseInt(parts[1], 10) * 1000
        if (isNaN(touchedAt)) continue
        const idleMs = now - touchedAt
        const orphaned = alive.size > 0 && !alive.has(dir.slice(BROKER_ROOT.length + 1))
        if (idleMs < (orphaned ? 5 * 60 * 1000 : IDLE_REAP_MS)) continue
        const sessionId = dir.slice(BROKER_ROOT.length + 1)
        if (runs.has(sessionId)) continue
        if (activeTurns.has(sessionId)) continue
        const meta = await readJsonFile(dir + '/meta.json')
        if (meta !== null) {
          await runCapture(['/bin/sh', '-c',
            'kill ' + (typeof meta.childPid === 'number' ? meta.childPid : 0) + ' 2>/dev/null; '
            + 'kill ' + (typeof meta.brokerPid === 'number' ? meta.brokerPid : 0) + ' 2>/dev/null; true'], 5000)
        }
        await runCapture(['/bin/sh', '-c', 'rm -rf ' + shellQuote(dir)], 5000)
        console.log('cc-mode: reaped a Claude broker for', sessionId,
          '— idle', Math.round(idleMs / 60000), 'min' + (orphaned ? ', no live dsh session' : ''))
      }
    }

    /** End the Claude process for good — an explicit act, never a side effect. */
    async function stopRun(sessionId) {
      const dir = sessionDir(sessionId)
      detach(sessionId, false)
      const meta = await readJsonFile(dir + '/meta.json')
      if (meta === null) return false
      await runCapture(['/bin/sh', '-c',
        'kill ' + (typeof meta.childPid === 'number' ? meta.childPid : 0) + ' 2>/dev/null; '
        + 'kill ' + (typeof meta.brokerPid === 'number' ? meta.brokerPid : 0) + ' 2>/dev/null; '
        + 'rm -f ' + shellQuote(dir + '/meta.json') + '; true'], 5000)
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
    function recordPromptHistory(cwd, claudeSessionId, prompt) {
      if (typeof claudeSessionId !== 'string' || claudeSessionId.length === 0) return
      const row = JSON.stringify({
        display: prompt,
        pastedContents: {},
        timestamp: Date.now(),
        project: cwd,
        sessionId: claudeSessionId,
      })
      try {
        const proc = silenceStdin(subprocess.spawn({
          argv: ['/bin/sh', '-c', 'mkdir -p "$HOME/.claude" && cat >> "$HOME/.claude/history.jsonl"'],
          cwd: cwd,
          stdio: { stdin: 'pipe', stdout: 'ignore', stderr: 'ignore' },
          graceMs: 2000,
        }))
        if (proc.stdin !== undefined) {
          proc.stdin.write(row + '\n')
          proc.stdin.end()
        }
        proc.done.catch(() => undefined)
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

    const usage = { at: 0, value: null, inflight: null }

    async function loadUsage() {
      const credentialsRaw = await runCapture(['/bin/sh', '-c', 'cat "$HOME/.claude/.credentials.json" 2>/dev/null'], 8000)
      let credentials = null
      try { credentials = JSON.parse(credentialsRaw) } catch (error) { credentials = null }
      const oauth = credentials === null ? undefined : credentials.claudeAiOauth
      if (oauth === undefined || typeof oauth.accessToken !== 'string' || typeof oauth.subscriptionType !== 'string') {
        // API key, third-party gateway, or no login: nothing subscription-shaped to show.
        return { official: false, reason: 'no-oauth-subscription' }
      }
      const overrides = (await runCapture(['/bin/sh', '-c', 'echo "$ANTHROPIC_BASE_URL|$ANTHROPIC_AUTH_TOKEN|$ANTHROPIC_API_KEY"'], 5000)).trim()
      if (overrides.replace(/\|/g, '').length > 0) {
        return { official: false, reason: 'gateway-override' }
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
      if (parsed === null || typeof parsed !== 'object') {
        return { official: true, subscription: oauth.subscriptionType, error: 'usage endpoint unavailable' }
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

    function usageSnapshot(force) {
      const fresh = Date.now() - usage.at < 60000
      if (!force && fresh && usage.value !== null) return Promise.resolve(usage.value)
      if (usage.inflight !== null) return usage.inflight
      usage.inflight = loadUsage().then((value) => {
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
    let commandCache = []

    function rememberCommands(list) {
      if (!Array.isArray(list) || list.length === 0) return
      const names = list.filter((name) => typeof name === 'string' && name.length > 0)
      if (names.length === 0 || names.join(',') === commandCache.join(',')) return
      commandCache = names
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
      const raw = await runCapture(['/bin/sh', '-c',
        'grep -a \'"subtype":"init"\' ' + shellQuote(path) + ' 2>/dev/null | tail -1'], 8000)
      const line = String(raw).trim()
      if (line.length === 0) return undefined
      try { return JSON.parse(line) } catch (error) { return undefined }
    }

    /**
     * Where each MCP server is configured, the way the terminal groups them:
     * the project's own entry in ~/.claude.json versus the user-wide one.
     */
    async function mcpScopes(cwd) {
      const raw = await runCapture(['/bin/sh', '-c', 'cat "$HOME"/.claude.json 2>/dev/null'], 8000)
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

      const work = (async () => {
        await lock.acquired
        // A turn that held the lock before our reservation may still be the
        // reason we waited; if one is somehow open now, reading its stream
        // would split the queue — bail out instead.
        if (activeTurns.has(sessionId)) throw new Error('cc-mode: 会话正在跑一轮，这条命令没有执行')
        // This reads the stream too, so the between-turns reader steps aside.
        await stopIdleDrain(runs.get(sessionId))
        const run = await ensureRun(sessionId, cwd)
        await run.write({
          type: 'user',
          message: { role: 'user', content: [{ type: 'text', text: command }] },
          parent_tool_use_id: null,
        })
        if (run.writeError !== undefined) throw new Error(run.writeError)

        let spoken = ''
        let compacted
        const deadline = Date.now() + COMMAND_DEADLINE_MS
        while (true) {
          if (Date.now() > deadline) throw new Error('cc-mode: 命令 30 分钟没有返回结果')
          const message = await run.next()
          if (message === undefined) throw new Error('cc-mode: 与 Claude 的连接在命令返回前断开了')
          if (message.type === 'system' && message.subtype === 'init') {
            run.init = message
            rememberCommands(message.slash_commands)
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
      }).then(() => {
        job.done = true
        job.status = ''
        job.finishedAt = Date.now()
        lock.release()
        // Hand the stream back to the between-turns reader.
        startIdleDrain(sessionId, runs.get(sessionId), commandEndsAt)
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
      fileSizeOfShellWord(transcript).then((size) => {
        if (size > state.jsonlOffset) { state.jsonlOffset = size; persistStates() }
      }).catch(() => undefined)
    }

    function claudeCommands() {
      return commandCache.length > 0 ? commandCache : FALLBACK_COMMANDS
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
    async function searchClaudeConversations(cwd, query) {
      const dir = '"$HOME"/.claude/projects/' + shellQuote(projectSlug(cwd))
      const needle = String(query || '').trim()
      if (needle.length === 0) return { hits: [] }
      const matched = await runCapture(['/bin/sh', '-c',
        'cd ' + dir + ' 2>/dev/null && grep -liF -- ' + shellQuote(needle) + ' *.jsonl 2>/dev/null | head -20'], 15000)
      const hits = []
      for (const name of String(matched).split('\n')) {
        const file = name.trim()
        if (file.length === 0 || !file.endsWith('.jsonl')) continue
        const line = await runCapture(['/bin/sh', '-c',
          'grep -iF -m1 -- ' + shellQuote(needle) + ' ' + dir + '/' + shellQuote(file) + ' 2>/dev/null | head -c 200000'], 10000)
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

    async function listClaudeConversations(cwd) {
      const dir = '"$HOME"/.claude/projects/' + shellQuote(projectSlug(cwd))
      const listing = await runCapture(['/bin/sh', '-c',
        'for f in ' + dir + '/*.jsonl; do [ -f "$f" ] || continue; '
        + 'echo "$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f")|$(stat -c %s "$f" 2>/dev/null || stat -f %z "$f")|$f"; done | sort -rn | head -40'], 10000)
      const rows = []
      for (const line of String(listing).split('\n')) {
        const parts = line.trim().split('|')
        if (parts.length < 3) continue
        const path = parts.slice(2).join('|')
        const name = path.slice(path.lastIndexOf('/') + 1)
        rows.push({
          claudeSessionId: name.replace(/\.jsonl$/, ''),
          path: path,
          updatedAt: parseInt(parts[0], 10) * 1000,
          bytes: parseInt(parts[1], 10),
        })
      }
      // One pass per file for the title and the opening prompt.
      for (const row of rows) {
        const head = await runCapture(['/bin/sh', '-c',
          'grep -m 3 -E \'"type":"(ai-title|custom-title)"\' ' + shellQuote(row.path) + ' 2>/dev/null; '
          + 'grep -m 1 -F \'"type":"user"\' ' + shellQuote(row.path) + ' 2>/dev/null'], 8000)
        row.title = ''
        row.firstPrompt = ''
        for (const line of String(head).split('\n')) {
          if (line.trim().length === 0) continue
          let event = null
          try { event = JSON.parse(line) } catch (error) { continue }
          if (event.type === 'ai-title' && typeof event.aiTitle === 'string') row.title = event.aiTitle
          else if (event.type === 'custom-title' && typeof event.customTitle === 'string') row.title = event.customTitle
          else if (event.type === 'user' && row.firstPrompt === '') {
            row.firstPrompt = textOfClaudeMessage(event.message).slice(0, 120)
          }
        }
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
      const cwd = session.header ? session.header.cwd : undefined
      if (typeof cwd !== 'string' || cwd.length === 0) return Promise.resolve(0)

      const work = (async () => {
        const path = '"$HOME"/.claude/projects/' + shellQuote(projectSlug(cwd)) + '/' + shellQuote(state.claudeSessionId + '.jsonl')
        const size = await fileSizeOfShellWord(path)
        if (size <= state.jsonlOffset) return 0

        const raw = await runCapture(['/bin/sh', '-c',
          'tail -c +' + (state.jsonlOffset + 1) + ' ' + path + ' | head -c 3000000'], 20000)
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
          if (event.isSidechain === true || event.isReplay === true) continue
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
        for (const event of session.events) {
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
      for (const event of session.events) {
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
      for (const event of session.events) {
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
      for (const event of session.events) {
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
      const work = (async () => {
        const meta = await readJsonFile(dir + '/meta.json')
        if (meta === null) return 0
        const attachState = await readJsonFile(dir + '/attach.json')
        let offset = attachState !== null && typeof attachState.offset === 'number' ? attachState.offset : null
        if (offset === null) {
          // No recorded offset (the watchdog clears it on a stalled detach).
          // Anchor on the call dsh's crash recovery settled as
          // TOOL_OUTCOME_UNKNOWN: its REAL result is in the broker log, and
          // everything from that line on is the missing tail.
          let callId = ''
          for (let index = session.events.length - 1; index >= 0; index -= 1) {
            const event = session.events[index]
            if (event.type === 'tool/call' && event.data && typeof event.data.callId === 'string') {
              callId = event.data.callId
              break
            }
          }
          if (callId.length === 0) return 0
          const lineNoRaw = await runCapture(['/bin/sh', '-c',
            'grep -n -m1 -F ' + shellQuote('"tool_use_id":"' + callId + '"') + ' ' + shellQuote(dir + '/out.log') + ' | cut -d: -f1'], 15000)
          const lineNo = parseInt(String(lineNoRaw).trim(), 10)
          if (isNaN(lineNo) || lineNo < 1) return 0
          const offsetRaw = await runCapture(['/bin/sh', '-c',
            'head -n ' + (lineNo - 1) + ' ' + shellQuote(dir + '/out.log') + ' | wc -c'], 15000)
          offset = parseInt(String(offsetRaw).trim(), 10)
          if (isNaN(offset)) return 0
        }
        const size = await fileSize(dir + '/out.log')
        if (size <= offset) return 0

        const raw = await runCapture(['/bin/sh', '-c',
          'tail -c +' + (offset + 1) + ' ' + shellQuote(dir + '/out.log') + ' | head -c 3000000'], 20000)
        const rows = []
        let sawResult = false
        for (const line of String(raw).split('\n')) {
          if (line.trim().length === 0) continue
          let event = null
          try { event = JSON.parse(line) } catch (error) { continue }
          if (event.type === 'result') { sawResult = true; continue }
          if (event.type !== 'user' && event.type !== 'assistant') continue
          if (event.isSidechain === true || event.isReplay === true) continue
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
        for (const event of session.events) {
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
        await new Promise((resolve) => {
          const writer = silenceStdin(subprocess.spawn({
            argv: ['/bin/sh', '-c', 'cat > ' + shellQuote(dir + '/attach.json')],
            cwd: '/',
            stdio: { stdin: 'pipe', stdout: 'ignore', stderr: 'ignore' },
            graceMs: 1000,
          }))
          if (writer === undefined || writer.stdin === undefined) { resolve(); return }
          writer.stdin.write(JSON.stringify({ offset: size }))
          writer.stdin.end()
          writer.done.then(() => resolve(), () => resolve())
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
    async function lastBackgroundTaskCount(dir) {
      const raw = await runCapture(['/bin/sh', '-c',
        'tail -c 2000000 ' + shellQuote(dir + '/out.log')
        + ' | grep -F \'"background_tasks_changed"\' | tail -1'], 10000)
      const line = String(raw).trim()
      if (line.length === 0) return 0
      try {
        const value = JSON.parse(line)
        return Array.isArray(value.tasks) ? value.tasks.length : 0
      } catch (error) { return 0 }
    }

    /**
     * The name Claude gave this conversation, if it has gotten around to it.
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
    async function lastAiTitle(cwd, claudeSessionId) {
      if (typeof cwd !== 'string' || cwd.length === 0) return ''
      if (typeof claudeSessionId !== 'string' || claudeSessionId.length === 0) return ''
      const path = '"$HOME"/.claude/projects/' + shellQuote(projectSlug(cwd))
        + '/' + shellQuote(claudeSessionId + '.jsonl')
      const raw = await runCapture(['/bin/sh', '-c',
        'tail -c 2000000 ' + path + ' 2>/dev/null | grep -F ' + shellQuote('{"type":"ai-title"') + ' | tail -5'], 10000)
      const lines = String(raw).split('\n')
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index].trim()
        if (line.length === 0) continue
        let value = null
        try { value = JSON.parse(line) } catch (error) { continue }
        if (value === null || value.type !== 'ai-title') continue
        if (typeof value.aiTitle !== 'string') continue
        const title = value.aiTitle.trim()
        if (title.length > 0) return title
      }
      return ''
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
      const title = await lastAiTitle(cwd, state.claudeSessionId)

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
    async function projectIdleStretch(sessionId, run, notice, endsAt) {
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
      const raw = await runCapture(['/bin/sh', '-c',
        'tail -c +' + (from + 1) + ' ' + shellQuote(run.dir + '/out.log')
        + ' | head -c ' + Math.min(span, IDLE_STRETCH_MAX)], 20000)

      const rows = []
      for (const line of String(raw).split('\n')) {
        if (line.trim().length === 0) continue
        let event = null
        try { event = JSON.parse(line) } catch (error) { continue }
        if (event.type !== 'user' && event.type !== 'assistant') continue
        if (event.isSidechain === true || event.isReplay === true) continue
        if (typeof event.parent_tool_use_id === 'string' && event.parent_tool_use_id.length > 0) continue
        if (event.message === null || event.message === undefined) continue
        rows.push(event)
      }
      if (rows.length === 0) return 0

      // The live turn that just ended rendered its own tail; anything whose
      // call the transcript already holds would come back as a duplicate whose
      // result then pairs across turns, which is how a card spins forever.
      const known = new Set()
      for (const event of session.events) {
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

      const written = queueProjection(sessionId, fresh, notice)
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
        try { tasksOpen = await lastBackgroundTaskCount(run.dir) } catch (error) { tasksOpen = 0 }
        let notice = ''
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

        const handle = async (message) => {
          const parent = typeof message.parent_tool_use_id === 'string' ? message.parent_tool_use_id : null

          if (message.type === 'system') {
            if (message.subtype === 'background_tasks_changed') {
              tasksOpen = Array.isArray(message.tasks) ? message.tasks.length : 0
            } else if (message.subtype === 'task_notification' && parent === null) {
              // Same note the live loop writes, so the reply this round is
              // about to give does not read as an answer to nothing.
              const what = typeof message.description === 'string' && message.description.length > 0
                ? message.description
                : String(message.task_id || 'task')
              const summary = typeof message.summary === 'string' ? message.summary.trim() : ''
              notice += (notice.length > 0 ? '\n\n' : '') + '⚙ 后台任务通知：' + what
                + (summary.length > 0 ? '\n\n' + summary.slice(0, 4000) : '')
            }
            return
          }
          // A round nobody asked for can still need a human. Left unanswered
          // it hangs Claude on a question no one can see, holding the
          // process (and its RAM) for as long as the conversation lives.
          if (message.type === 'control_request') {
            const request = message.request || {}
            if (request.subtype === 'can_use_tool') {
              let agent
              try { agent = agents === undefined ? undefined : agents.get(sessionId) } catch (error) { agent = undefined }
              if (agent !== undefined) {
                answerPermission(run, agent, stateOf(sessionId), message, idleSignal)
              }
            }
            return
          }
          if (message.type !== 'result') return
          await projectIdleStretch(sessionId, run, notice, message.ccmodeOffset)
          notice = ''
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
            try { await projectIdleStretch(sessionId, run, notice) } catch (error) {
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
      if (runs.has(sessionId) || activeTurns.has(sessionId)) return Promise.resolve(false)
      if (followInFlight.has(sessionId)) return Promise.resolve(false)
      const state = stateOf(sessionId, session)
      if (state.mode !== 'claude') return Promise.resolve(false)

      followInFlight.add(sessionId)
      const work = (async () => {
        const dir = sessionDir(sessionId)
        const meta = await readJsonFile(dir + '/meta.json')
        if (meta === null) return false
        const exited = await readJsonFile(dir + '/exit.json')
        if (exited !== null) return false
        if (!(await isAlive(meta.brokerPid))) return false
        // Launched under different settings: leave it to the next turn's
        // ensureRun, which knows how to retire and replace a process.
        const snapshot = launchSnapshot(state)
        if (meta.snapshot !== snapshot) return false
        // Re-checked after the awaits above — a turn may have started while
        // this was reading files, and two readers on one queue lose messages.
        if (runs.has(sessionId) || activeTurns.has(sessionId)) return false

        const attachState = await readJsonFile(dir + '/attach.json')
        const offset = attachState !== null && typeof attachState.offset === 'number'
          ? attachState.offset
          : await fileSize(dir + '/out.log')
        const run = createRun(sessionId, dir, snapshot, meta.claudeSessionId)
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
      for (const event of session.events) {
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
        type === 'user/message' || type === 'assistant/message' || type === 'tool/result' ? { surfaceOp: 'append' } : undefined)
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
        } })
      }

      let written = 0
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
          if (text.indexOf('<command-name>') !== -1) {
            const name = (text.match(/<command-name>([^<]*)<\/command-name>/) || [])[1] || ''
            const argsText = (text.match(/<command-args>([^<]*)<\/command-args>/) || [])[1] || ''
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

        const blocks = assistantBlocksOf(content)
          .filter((block) => block.type !== 'tool-call' || !knownCallIds.has(block.id))
        if (blocks.length === 0) continue
        openStep()
        append('assistant/message', { turn: turn, step: step, message: {
          id: uuid(), role: 'assistant', content: blocks,
          source: { kind: 'model', provider: PROVIDER, model: message.model || 'claude-code' },
        } })
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
      for (const event of session.events) {
        if (event.type === 'assistant/message') return { backfilled: 0, skipped: 'already has content' }
      }

      const path = '"$HOME"/.claude/projects/' + shellQuote(projectSlug(cwd)) + '/' + shellQuote(claudeSessionId + '.jsonl')
      // Size BEFORE reading: whatever lands after this snapshot is the live
      // sync's business, never lost between the two.
      const sizeAtImport = await fileSizeOfShellWord(path)
      const raw = await runCapture(['/bin/sh', '-c',
        'grep -E \'"type":"(user|assistant)"\' ' + path + ' 2>/dev/null'], 120000)

      const rows = []
      for (const line of String(raw).split('\n')) {
        if (line.trim().length === 0) continue
        let event = null
        try { event = JSON.parse(line) } catch (error) { continue }
        if (event.isSidechain === true || event.isReplay === true) continue
        if (event.message === null || event.message === undefined) continue
        rows.push(event)
      }
      // The conversation's own posture and model, as the CLI recorded them.
      // Without this an imported conversation opens on the defaults (manual /
      // 「Claude 默认」) even though its transcript says otherwise — and the
      // next turn would then run under a posture the user never chose.
      const state0 = stateOf(sessionId, session)
      const settings = await runCapture(['/bin/sh', '-c',
        'grep -o \'"permissionMode":"[a-zA-Z]*"\' ' + path + ' 2>/dev/null | tail -1; '
        + 'grep -o \'"model":"[^"]*"\' ' + path + ' 2>/dev/null | tail -1'], 20000)
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
        const titled = await runCapture(['/bin/sh', '-c',
          'grep -E \'"type":"(ai-title|custom-title)"\' ' + path + ' 2>/dev/null | tail -5'], 8000)
        for (const line of String(titled).split('\n')) {
          if (line.trim().length === 0) continue
          let event = null
          try { event = JSON.parse(line) } catch (error) { continue }
          // A custom title is the user's own rename and outranks the AI one.
          if (event.type === 'custom-title' && typeof event.customTitle === 'string' && event.customTitle.trim().length > 0) {
            text = event.customTitle
            break
          }
          if (event.type === 'ai-title' && typeof event.aiTitle === 'string' && text.length === 0) text = event.aiTitle
        }
        text = text.replace(/\s+/g, ' ').trim().slice(0, 60)
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
    async function previewClaudeConversation(cwd, claudeSessionId, limit) {
      const path = '"$HOME"/.claude/projects/' + shellQuote(projectSlug(cwd)) + '/' + shellQuote(claudeSessionId + '.jsonl')
      const raw = await runCapture(['/bin/sh', '-c',
        'grep -E \'"type":"(user|assistant)"\' ' + path + ' 2>/dev/null | tail -' + (limit || 60)], 15000)

      const items = []
      const byCallId = new Map()
      for (const line of String(raw).split('\n')) {
        if (line.trim().length === 0) continue
        let event = null
        try { event = JSON.parse(line) } catch (error) { continue }
        if (event.isSidechain === true || event.isReplay === true) continue
        const message = event.message
        if (message === null || message === undefined) continue
        const content = typeof message.content === 'string'
          ? [{ type: 'text', text: message.content }]
          : (Array.isArray(message.content) ? message.content : [])

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
      const events = session.events
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
      await drainDetachedOutput(sessionId, session)
      // A one-shot command may be reading this session's stream right now;
      // the lock is the queue both sides stand in.
      const lock = acquireSessionLock(sessionId)
      let run
      try {
        await lock.acquired
        // Only one consumer of the stream at a time: the reader that has been
        // following Claude between turns has to let go — and finish handing
        // over what it saw — before this turn starts shifting the same queue.
        await stopIdleDrain(runs.get(sessionId))
        run = await ensureRun(sessionId, cwd, signal)
      } catch (error) {
        lock.release()
        throw error
      }
      const transcript = createTranscript(session, turn)
      activeTurns.set(sessionId, { turn: turn, run: run })

      let interrupted = false
      let abortedAt = 0
      let done = false
      let cancelKill = null
      // Where this turn's `result` sits in out.log, so the reader that takes
      // over between turns knows exactly where its first stretch begins.
      let roundEndsAt
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
        recordPromptHistory(cwd, run.claudeSessionId, typedTextOf(messages) || prompt)

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
        const stallWatch = ctx.interval(() => {
          safely('turn watchdog', () => {
            if (done) return
            const silentTooLong = run.sawAnyMessage !== true && Date.now() - submittedAt > 120000
            const ignoredInterrupt = interrupted && Date.now() - abortedAt > 10000
            if (!silentTooLong && !ignoredInterrupt) return
            console.error(ignoredInterrupt
              ? 'cc-mode: 中断后 10 秒没有收到 result，松开这一轮（Claude 进程保留）'
              : 'cc-mode: 提交后 120 秒没有任何回应，判定输入没有送达；保留进程并松开这一轮')
            runCapture(['/bin/sh', '-c', 'rm -f ' + shellQuote(run.dir + '/attach.json')], 3000).catch(() => undefined)
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
              rememberCommands(message.slash_commands)
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
            // waku renders these as live work items; here the transcript gets
            // an honest note — otherwise the model's later reply to a task
            // notification reads as an answer to nothing.
            if (message.subtype === 'task_started' && parent === null) {
              const what = typeof message.description === 'string' && message.description.length > 0
                ? message.description
                : String(message.subagent_type || message.task_type || 'task')
              transcript.note('⚙ 后台任务启动：' + what
                + (typeof message.task_id === 'string' && message.task_id.length > 0 ? '（' + message.task_id + '）' : ''))
            }
            if (message.subtype === 'task_notification' && parent === null) {
              const what = typeof message.description === 'string' && message.description.length > 0
                ? message.description
                : String(message.task_id || 'task')
              const summary = typeof message.summary === 'string' ? message.summary.trim() : ''
              transcript.note('⚙ 后台任务通知：' + what
                + (summary.length > 0 ? '\n\n' + summary.slice(0, 4000) : ''))
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
            } else {
              subagentAssistant(session, run, parent, message.message || {})
            }
            continue
          }
          if (message.type === 'user') {
            if (message.isReplay === true) continue
            if (parent === null) transcript.toolResults(message.message || {})
            else subagentResults(session, run, parent, message.message || {})
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
              transcript.note('⚠ Claude Code 报错：' + detail)
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
          try { agent.session.append('user/message', message, { surfaceOp: 'append' }) } catch (error) { /* best effort */ }
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
        try { agent.session.append('user/message', shown, { surfaceOp: 'append' }) } catch (error) { /* logged below */ }
        if (text.length === 0 && images.length === 0) continue
        const content = images.map((image) => ({
          type: 'image',
          source: { type: 'base64', media_type: image.mediaType, data: image.data },
        }))
        if (text.length > 0) content.push({ type: 'text', text: text })
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

    function publicState(sessionId) {
      const session = sessionOf(sessionId)
      const state = stateOf(sessionId, session)
      const run = runs.get(sessionId)
      const committed = committedEngine(session)
      return {
        mode: state.mode,
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
              const cwd = session !== undefined && session.header ? session.header.cwd : ''
              if (typeof cwd === 'string' && cwd.length > 0) {
                const path = '"$HOME"/.claude/projects/' + shellQuote(projectSlug(cwd)) + '/'
                  + shellQuote(state.claudeSessionId + '.jsonl')
                const settings = await runCapture(['/bin/sh', '-c',
                  'grep -o \'"permissionMode":"[a-zA-Z]*"\' ' + path + ' 2>/dev/null | tail -1; '
                  + 'grep -o \'"model":"[^"]*"\' ' + path + ' 2>/dev/null | tail -1'], 20000)
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
        console.log('cc-mode:', sessionId, '->', state.mode)
        return publicState(sessionId)
      }),

      harness.handle('permission.set', (args) => {
        const sessionId = String(args.sessionId || '')
        const state = stateOf(sessionId)
        const wanted = String(args.permissionMode || '')
        if (PERMISSION_MODES.some((entry) => entry.id === wanted)) state.permissionMode = wanted
        applySupervision(sessionId, state)
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
        for (const event of session.events) {
          if (event.type === 'turn/start' && typeof event.data.turn === 'number') last = event.data.turn
        }
        return { ok: true, written: written, lastTurn: last }
      }),

      harness.handle('engines', () => ({ engines: engineIndex() })),

      harness.handle('commands', () => {
        const names = claudeCommands()
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
        const scopes = await mcpScopes(cwd)
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

      harness.handle('claude.conversations', async (args) => {
        const cwd = String(args.cwd || '')
        if (cwd.length === 0) return { conversations: [] }
        return { conversations: await listClaudeConversations(cwd) }
      }),

      harness.handle('claude.search', async (args) => {
        const cwd = String(args.cwd || '')
        if (cwd.length === 0) return { hits: [] }
        return searchClaudeConversations(cwd, String(args.query || ''))
      }),

      harness.handle('claude.preview', async (args) => previewClaudeConversation(
        String(args.cwd || ''), String(args.claudeSessionId || ''), 40)),

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
        stopRun(sessionId).catch(() => undefined)
        persistStates()

        // Make the import VISIBLE: without this the adopted conversation opens
        // empty and reads as a failed import, even though resuming works.
        let backfill = { backfilled: 0, skipped: 'session not live' }
        const cwd = typeof args.cwd === 'string' && args.cwd.length > 0
          ? args.cwd
          : (session !== undefined && session.header ? session.header.cwd : '')
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

      harness.handle('usage', (args) => usageSnapshot(args !== null && args !== undefined && args.force === true)),

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
        return publicState(String(sessionId))
      },
      setPosture: (sessionId, posture) => {
        const state = stateOf(String(sessionId))
        if (PERMISSION_MODES.some((entry) => entry.id === posture)) state.permissionMode = posture
        applySupervision(String(sessionId), state)
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
        return publicState(String(sessionId))
      },
      stop: (sessionId) => { stopRun(String(sessionId)).catch(() => undefined); return true },
      // Exposed for the integration harness: the same thing a hot update does.
      detach: (sessionId) => detach(String(sessionId)),
      sessionDir: (sessionId) => sessionDir(String(sessionId)),
      usage: (force) => usageSnapshot(force === true),
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
