// 照 dsh-session-format-v3-to-v4 的 relationships / tool-role 两节写的精简检查器：
// 只覆盖插件会碰到的规则。dsh 在「下一次加载」时才跑这些规则，写错的那一刻毫无
// 动静，所以测试里在 append 时就跑。

/** 一份会话的 v4 生命周期状态机；check(event) 违规就抛。 */
export function v4Lifecycle() {
  let turn = null
  let nextTurn = 1
  let step = null
  let nextStep = 1
  const tools = new Map() // callId -> settled?
  const fail = (event, why) => { throw new Error(`seq ${event.seq} ${event.type}: ${why}`) }
  return {
    get turn() { return turn },
    get nextTurn() { return nextTurn },
    check(event) {
      const data = event.data || {}
      switch (event.type) {
        case 'turn/start':
          if (turn !== null || data.turn !== nextTurn) fail(event, '没有打开预期的那一轮')
          turn = nextTurn; nextStep = 1; tools.clear(); break
        case 'turn/end':
          if (turn === null || data.turn !== turn || step !== null) fail(event, '轮次没对上，或者还有步没关')
          for (const [id, settled] of tools) if (!settled) fail(event, `调用 ${id} 悬着没结`)
          turn = null; nextTurn += 1; break
        case 'step/start':
          if (turn === null || data.turn !== turn || step !== null || data.step !== nextStep) {
            fail(event, `步号不对（本轮下一步应是 ${nextStep}，${step === null ? '没有' : '还有'}打开的步）`)
          }
          step = data.step; nextStep += 1; break
        case 'step/end':
          if (step === null || data.turn !== turn || data.step !== step) fail(event, '关的不是打开的那一步')
          // dsh 的 closeTools 在步结束时也跑：一步不能带着没结的调用关掉。
          for (const [id, settled] of tools) if (!settled) fail(event, `步结束时调用 ${id} 还没结（step/end leaves unresolved tool call）`)
          step = null; break
        case 'request/context':
        case 'request/header':
          if (turn === null) fail(event, '在轮次之外'); break
        case 'assistant/message':
        case 'assistant/attempt':
          if (step === null || data.turn !== turn || data.step !== step) fail(event, '不在打开的步里'); break
        case 'tool/call':
          if (step === null || data.turn !== turn || data.step !== step) fail(event, '不在打开的步里')
          if (tools.has(data.callId)) fail(event, '调用 id 重复')
          tools.set(data.callId, false); break
        case 'tool/result': {
          if (step === null || data.turn !== turn || data.step !== step) fail(event, '不在打开的步里')
          const message = data.message || {}
          if (message.role !== 'tool') fail(event, '不是 tool 角色的消息')
          if (message.toolCallId !== (message.source || {}).callId) fail(event, 'toolCallId 和 source.callId 不一致')
          if (tools.get(message.toolCallId) !== false) fail(event, `结不了调用 ${message.toolCallId}（没声明过或已经结了）`)
          tools.set(message.toolCallId, true); break
        }
      }
    },
  }
}

/** 一个会编 seq 的内存会话，每次 append 都过 v4 检查。 */
export function v4Session() {
  const events = []
  const lifecycle = v4Lifecycle()
  return {
    events,
    append(type, data) {
      const event = { type, seq: events.length, time: 0, data }
      lifecycle.check(event)
      events.push(event)
    },
    snapshotEvents: () => events,
    open() { this.append('turn/start', { turn: lifecycle.nextTurn }); return lifecycle.turn },
    close() { this.append('turn/end', { turn: lifecycle.turn, reason: { kind: 'blocked' } }) },
  }
}
