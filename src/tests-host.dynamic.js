// cc-mode integration harness — drives real dsh sessions through the deployed
// ccmode package and prints a compact report of the session events each turn
// produced. Everything it asserts is what the browser would render, because it
// reads the same durable log the UI reads.
//
// It is a throwaway: run it, read `pm2 logs dsh-web`, stop it.

return {
  inject: ['ccmodeControl', 'timer'],
  apply(ctx) {
    const agents = ctx.get('agents')
    const control = ctx.ccmodeControl
    if (agents === undefined || control === undefined) {
      console.error('cctest: agents/ccmodeControl unavailable')
      return
    }

    const CWD = '/root/code/deepseek'
    const created = new Set(['session-05348941-d448-4eed-b1fe-daeff9d97a95','session-10f6e3f2-7ee1-4721-9337-dcc945c55daa','session-1c67e1c5-be2a-4e19-89ed-81cfba8dba38','session-21bc9693-94c7-4906-908c-223069e9362f','session-3d33bfaf-2cce-4572-86e5-3da2c8e1243d','session-606d26fb-d0fa-48ed-99cd-e77606ba667c','session-7a436c8e-ba02-46d9-a8a2-c6de35e1826a','session-810a6153-0719-49b2-948c-e9dcb2961851','session-a220665f-c301-45fb-a306-1ea8f0a819eb','session-ad363958-605f-43ba-adbf-11e39a47f7a6','session-b67d9369-91c0-4d6e-b4f9-ec6bdfdfd10f','session-ba46ea6f-9b53-4039-9b55-df5d4ba0d9f1','session-bd64d2fc-edd4-4deb-adfd-6f9aabf2280c',])
    let stopped = false
    ctx.effect(() => () => { stopped = true }, 'cctest teardown')

    function uuid() {
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
      })
    }

    function userMessage(text) {
      return { id: uuid(), role: 'user', content: [{ type: 'text', text: text }], source: { kind: 'user' } }
    }

    function log(...parts) { console.log('cctest:', ...parts) }

    function errorTextOf(error) { return error && error.message ? String(error.message) : String(error) }

    async function sleep(ms) { await ctx.timeout(ms) }

    /** Compact one turn's events into a readable trace. */
    function trace(session, fromSeq) {
      const rows = []
      let chunks = 0
      for (const event of session.events) {
        if (event.seq < fromSeq) continue
        const data = event.data || {}
        if (event.type === 'assistant/chunk') { chunks += 1; continue }
        if (chunks > 0) { rows.push('chunk×' + chunks); chunks = 0 }
        if (event.type === 'user/message') {
          const source = data.source || (data.message && data.message.source) || {}
          rows.push('user/message[' + (source.kind || '?') + (source.plugin ? ':' + source.plugin : '') + ']')
        } else if (event.type === 'assistant/message') {
          const content = (data.message && data.message.content) || []
          const kinds = content.map((block) => block.type === 'text'
            ? 'text(' + String(block.text || '').replace(/\s+/g, ' ').slice(0, 40) + ')'
            : block.type === 'tool-call' ? 'call:' + block.name : block.type)
          rows.push('assistant/message{' + kinds.join(',') + '}' + (data.usage ? ' usage:' + data.usage.inputTokens + '/' + data.usage.outputTokens : ''))
        } else if (event.type === 'tool/call') {
          rows.push('tool/call ' + data.name + ' ' + String(data.arguments || '').replace(/\s+/g, ' ').slice(0, 60))
        } else if (event.type === 'tool/result') {
          const block = data.message && data.message.content ? data.message.content[0] : {}
          const text = (block.content || []).map((part) => part.text || '').join(' ').replace(/\s+/g, ' ').slice(0, 60)
          rows.push('tool/result' + (block.isError ? '!ERR' : '') + ' ' + text)
        } else if (event.type === 'tool/code-dispatch-start') {
          rows.push('  sub/start ' + data.name + ' parent=' + String(data.parentCallId).slice(-6))
        } else if (event.type === 'tool/code-dispatch') {
          rows.push('  sub/end   ' + data.name + (data.isError ? '!ERR' : ''))
        } else if (event.type === 'request/header') {
          rows.push('request/header ' + JSON.stringify(data.header && data.header.config))
        } else if (event.type === 'turn/end') {
          rows.push('turn/end ' + JSON.stringify(data.reason))
        } else if (event.type === 'step/start' || event.type === 'step/end' || event.type === 'turn/start') {
          rows.push(event.type + ' ' + (data.step === undefined ? data.turn : data.turn + '/' + data.step))
        } else if (event.type === 'approval/asked' || event.type === 'approval/decided') {
          rows.push(event.type + ' ' + JSON.stringify(data).slice(0, 80))
        }
      }
      if (chunks > 0) rows.push('chunk×' + chunks)
      return rows
    }

    async function newSession(label) {
      const sessionId = 'session-' + uuid()
      const handle = await agents.create({
        sessionId: sessionId,
        agentOptions: {},
        meta: { cwd: CWD },
        setup: () => {},
      })
      created.add(sessionId)
      log('[' + label + '] session', sessionId)
      return handle.agent
    }

    /** Send one prompt and wait until the turn closes (or the deadline passes). */
    async function turn(agent, text, deadlineMs) {
      const from = agent.session.events.length
      agent.send(userMessage(text), 'next-turn', true)
      const limit = deadlineMs === undefined ? 180000 : deadlineMs
      let waited = 0
      while (waited < limit && !stopped) {
        await sleep(1000)
        waited += 1000
        const ended = agent.session.events.some((event) => event.seq >= from && event.type === 'turn/end')
        if (ended) break
      }
      return trace(agent.session, from)
    }

    function report(label, rows) {
      log('──── ' + label + ' ────')
      for (const row of rows) log('   ' + row)
    }

    async function scenarioTools() {
      const agent = await newSession('tools')
      control.setMode(agent.id, 'claude')
      control.setPosture(agent.id, 'acceptEdits')
      const rows = await turn(agent,
        '按顺序做三件事，不要解释：1) 用 Bash 执行 `echo cctest-ok`；2) 用 Grep 在 /root/code/deepseek/AGENTS.md 里搜 cordis；3) 用 TodoWrite 写两条待办（第一条标记 in_progress）。',
        240000)
      report('S1 tools sweep (acceptEdits)', rows)
      control.setMode(agent.id, 'dsh')
      return agent
    }

    async function scenarioSubagent() {
      const agent = await newSession('subagent')
      control.setMode(agent.id, 'claude')
      control.setPosture(agent.id, 'acceptEdits')
      const rows = await turn(agent,
        '用 Task 工具起一个 general-purpose 子 agent，让它用 Bash 列出 /tmp 下前 5 个文件名并原样返回。你自己不要直接跑 Bash。',
        300000)
      report('S2 subagent (nested sub-calls)', rows)
      control.setMode(agent.id, 'dsh')
      return agent
    }

    async function scenarioPlan() {
      const agent = await newSession('plan')
      control.setMode(agent.id, 'claude')
      control.setPosture(agent.id, 'plan')
      const rows = await turn(agent, '给 /root/code/deepseek/AGENTS.md 补一节"如何调试动态插件"，先给方案不要动手。', 240000)
      report('S3 plan posture', rows)
      control.setMode(agent.id, 'dsh')
      return agent
    }

    async function scenarioCancel() {
      const agent = await newSession('cancel')
      control.setMode(agent.id, 'claude')
      control.setPosture(agent.id, 'acceptEdits')
      const from = agent.session.events.length
      agent.send(userMessage('用 Bash 执行 `sleep 60 && echo done`，然后告诉我结果。'), 'next-turn', true)
      await sleep(12000)
      log('S4 cancelling…')
      agent.cancel('user')
      await sleep(12000)
      report('S4 cancel mid-turn', trace(agent.session, from))
      control.setMode(agent.id, 'dsh')
      return agent
    }

    async function scenarioModelSwitchAndBack() {
      const agent = await newSession('model')
      control.setMode(agent.id, 'claude')
      control.setPosture(agent.id, 'acceptEdits')
      control.setModel(agent.id, 'claude-haiku-4-5', '')
      const first = await turn(agent, '只回一个词：one', 180000)
      report('S5a first turn on haiku', first)
      control.setModel(agent.id, 'claude-sonnet-5', '')
      const second = await turn(agent, '只回一个词：two', 180000)
      report('S5b second turn after live set_model', second)
      const header = agent.session.requestHeader()
      log('S6 header after claude turns:', JSON.stringify(header && header.config))
      control.setMode(agent.id, 'dsh')
      log('S6 header after switching back:', JSON.stringify((agent.session.requestHeader() || {}).config))
      return agent
    }

    async function scenarioSteer() {
      const agent = await newSession('steer')
      control.setMode(agent.id, 'claude')
      control.setPosture(agent.id, 'acceptEdits')
      const from = agent.session.events.length
      agent.send(userMessage('数到 20，一行一个数字，中间每个数字之间停顿一下再继续。'), 'next-turn', true)
      await sleep(9000)
      log('S7 steering mid-turn…')
      agent.send(userMessage('改主意了：不用数了，直接回复 STEERED 这个词。'), 'next-step', true)
      let waited = 0
      while (waited < 120000 && !stopped) {
        await sleep(1000); waited += 1000
        if (agent.session.events.some((e) => e.seq >= from && e.type === 'turn/end')) break
      }
      report('S7 steer into the running turn', trace(agent.session, from))
      control.setMode(agent.id, 'dsh')
      return agent
    }

    async function scenarioCancelStream() {
      const agent = await newSession('cancel2')
      control.setMode(agent.id, 'claude')
      control.setPosture(agent.id, 'acceptEdits')
      const from = agent.session.events.length
      agent.send(userMessage('写一段 800 字的中文散文，讲夏天的雨，不要用工具。'), 'next-turn', true)
      await sleep(8000)
      log('S8 cancelling a streaming turn…')
      agent.cancel('user')
      await sleep(10000)
      report('S8 cancel while streaming', trace(agent.session, from))
      // the process must survive a cancel: prove it by taking another turn
      const after = await turn(agent, '只回一个词：alive', 120000)
      report('S8b turn after cancel', after)
      control.setMode(agent.id, 'dsh')
      return agent
    }

    async function scenarioPostureRelaunch() {
      const agent = await newSession('posture')
      control.setMode(agent.id, 'claude')
      control.setPosture(agent.id, 'acceptEdits')
      report('S9a first', await turn(agent, '只回一个词：before', 120000))
      log('S9 switching posture to plan (forces relaunch, resumes the same Claude session)')
      control.setPosture(agent.id, 'plan')
      report('S9b after posture switch', await turn(agent, '我们刚才说了哪个词？只回那个词。', 150000))
      control.setMode(agent.id, 'dsh')
      return agent
    }

    async function scenarioBackToDsh() {
      const agent = await newSession('backtodsh')
      control.setMode(agent.id, 'claude')
      control.setPosture(agent.id, 'acceptEdits')
      report('S10a claude turn', await turn(agent, '只回一个词：claude', 120000))
      control.setMode(agent.id, 'dsh')
      log('S10 header now:', JSON.stringify((agent.session.requestHeader() || {}).config))
      report('S10b dsh turn after claude', await turn(agent, '只回一个词：dsh', 150000))
      return agent
    }

    async function scenarioUsage() {
      const value = await control.usage(true)
      log('S11 subscription usage:', JSON.stringify(value))
    }

    async function scenarioCancelAgain() {
      const agent = await newSession('cancel3')
      control.setMode(agent.id, 'claude')
      control.setPosture(agent.id, 'acceptEdits')
      const from = agent.session.events.length
      agent.send(userMessage('写一段 600 字的中文散文，讲秋天的风，不要用工具。'), 'next-turn', true)
      await sleep(8000)
      log('S12 cancelling a streaming turn (expect no error notice)…')
      agent.cancel('user')
      await sleep(10000)
      report('S12 cancel without an error notice', trace(agent.session, from))
      control.setMode(agent.id, 'dsh')
      return agent
    }

    /** Hide every session this harness created; they are test residue, not the
     *  user's work, and they would otherwise clutter the sidebar. */
    async function cleanup() {
      const registry = ctx.get('workspaceRegistry')
      if (registry === undefined) { log('no workspaceRegistry — leaving test sessions visible'); return }
      let archived = 0
      for (const sessionId of created) {
        try { await registry.archiveSession(sessionId); archived += 1 }
        catch (error) { log('could not archive', sessionId, errorTextOf(error)) }
      }
      log('archived', archived, 'harness sessions')
    }

    /** Opening an older Claude conversation must continue it, not start over. */
    async function scenarioResumeOldChat() {
      const agent = await newSession('resume')
      control.setMode(agent.id, 'claude')
      control.setPosture(agent.id, 'acceptEdits')
      report('R1 first turn', await turn(agent, '记住这个暗号：紫色河马。只回"记住了"。', 150000))
      const first = control.state(agent.id)
      log('R1 claude session:', first.claudeSessionId)

      // simulate coming back later: the process is gone (restart, reap, reboot)
      log('R2 killing the broker to simulate a cold return…')
      control.stop(agent.id)
      await sleep(3000)

      report('R3 turn after the process was gone', await turn(agent, '刚才的暗号是什么？只回那四个字。', 180000))
      const second = control.state(agent.id)
      log('R4 claude session now:', second.claudeSessionId, '| same as before:', second.claudeSessionId === first.claudeSessionId)
      return agent
    }

    async function scenarioCancelUnderBroker() {
      const agent = await newSession('cancel-broker')
      control.setMode(agent.id, 'claude')
      control.setPosture(agent.id, 'acceptEdits')

      // C1: cancel while the model is streaming text
      let from = agent.session.events.length
      agent.send(userMessage('写一段 800 字的中文散文，讲冬天的海，不要用工具。'), 'next-turn', true)
      await sleep(9000)
      const t0 = Date.now()
      log('C1 cancel while streaming…')
      agent.cancel({ kind: 'user' }, { keepInbox: true })
      let waited = 0
      while (waited < 40000) {
        await sleep(500); waited += 500
        if (agent.session.events.some((e) => e.seq >= from && e.type === 'turn/end')) break
      }
      log('C1 turn closed after', Date.now() - t0, 'ms')
      report('C1 cancel while streaming', trace(agent.session, from).slice(-4))

      // C2: cancel while a tool is running
      from = agent.session.events.length
      agent.send(userMessage('用 Bash 执行 `for i in $(seq 1 30); do echo $i; sleep 1; done`，然后总结。'), 'next-turn', true)
      await sleep(12000)
      const t1 = Date.now()
      log('C2 cancel during a tool run…')
      agent.cancel({ kind: 'user' }, { keepInbox: true })
      waited = 0
      while (waited < 40000) {
        await sleep(500); waited += 500
        if (agent.session.events.some((e) => e.seq >= from && e.type === 'turn/end')) break
      }
      log('C2 turn closed after', Date.now() - t1, 'ms')
      report('C2 cancel during a tool run', trace(agent.session, from).slice(-4))

      // C3: the process must still be usable afterwards
      report('C3 turn after two cancels', await turn(agent, '只回一个词：alive', 120000))
      log('C4 state:', JSON.stringify(control.state(agent.id)))
      return agent
    }

    async function scenarioDetachReattach() {
      const agent = await newSession('detach')
      control.setMode(agent.id, 'claude')
      control.setPosture(agent.id, 'acceptEdits')
      const dir = control.sessionDir(agent.id)
      log('T1 session dir:', dir)

      // a turn long enough to still be running when we let go of it
      const from = agent.session.events.length
      agent.send(userMessage('用 Bash 依次执行这三条，每条都要单独调用一次工具：`echo one`、`echo two`、`echo three`，然后总结。'), 'next-turn', true)
      await sleep(9000)
      log('T2 detaching mid-turn (this is what a hot update does)…')
      log('T2 detach returned:', control.detach(agent.id))
      await sleep(8000)
      report('T2 transcript at detach', trace(agent.session, from))

      // Claude must still be alive and still working
      log('T3 asking the OS whether Claude survived the detach…')
      await sleep(6000)

      // re-attach happens on the next turn
      const second = await turn(agent, '刚才那三条命令分别输出了什么？只列结果。', 180000)
      report('T4 turn after re-attach', second)
      log('T5 state:', JSON.stringify(control.state(agent.id)))
      control.setMode(agent.id, 'dsh')
      await sleep(2000)
      log('T6 after switching back to DSH (process should be gone)')
      return agent
    }

    async function scenarioToolNames() {
      const agent = await newSession('toolnames')
      control.setMode(agent.id, 'claude')
      control.setPosture(agent.id, 'acceptEdits')
      const from = agent.session.events.length
      await turn(agent, '做两件事，不要解释：1) 用 Bash 跑 `echo cc-name-check`；2) 读 /root/code/deepseek/AGENTS.md 的前 3 行。', 240000)
      const names = []
      for (const event of agent.session.events) {
        if (event.seq < from) continue
        if (event.type === 'tool/call') names.push(event.data.name + ' ' + String(event.data.arguments).slice(0, 50))
      }
      log('S13 tool/call names as logged:', JSON.stringify(names))
      control.setMode(agent.id, 'dsh')
      return agent
    }

    async function scenarioSmoke() {
      const agent = await newSession('smoke')
      log('S0 state before:', JSON.stringify(control.state(agent.id)))
      log('S0 setMode ->', JSON.stringify(control.setMode(agent.id, 'claude')))
      control.setPosture(agent.id, 'acceptEdits')
      report('S0 smoke turn', await turn(agent, '只回一个词：ok', 120000))
      log('S0 state after:', JSON.stringify(control.state(agent.id)))
      log('S0 switch back attempt:', JSON.stringify(control.setMode(agent.id, 'dsh')))
      return agent
    }

    async function run() {
      await sleep(1500)
      log('starting integration run')
      const list = [scenarioResumeOldChat, scenarioCancelUnderBroker]
      for (const scenario of list) {
        if (stopped) return
        try { await scenario() } catch (error) {
          log('scenario failed:', error && error.message ? error.message : String(error))
          if (error && error.stack) log(String(error.stack).split('\n').slice(0, 4).join(' | '))
        }
      }
      log('integration run finished')
    }

    run()
    console.log('cctest: harness armed')
  },
}
