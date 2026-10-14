// 后台任务跑完，Claude 自己开了一轮；就在这时用户发了一句话。实测
// （session-50f28b0c turn 8）两处一起出错：
//
//   一、用户这轮把「Claude 自己那一轮」的 result 当成了自己的结尾——Claude
//       那时还没读到这句话（它的 replay 在后面）。真正的回答随后才来，落到
//       轮次之间的读取器手里。
//   二、读取器把它排进投影队列、发 carrier 请 dsh 开一轮来渲染，可 dsh 那时
//       还在跑：dsh 0.2 不会为「blocked 收尾的轮次里排进来的 followup」再开
//       一轮，carrier 就停在输入框上方成了 `claude-in-dsh:render-pending`，
//       carriersInFlight 一直挂着，之后这个对话的投影全堵在它后面。
//
// 结果就是「Claude 那边已经说完了，dsh 这边一个字没有」。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const source = fs.readFileSync(path.join(root, 'src/host.dynamic.js'), 'utf8')

function sliceFunction(name) {
  const start = source.indexOf(`function ${name}(`)
  assert.notEqual(start, -1, `找不到 ${name}——它被改名或删掉了`)
  const before = source.lastIndexOf('async ', start)
  const from = before !== -1 && source.slice(before + 'async '.length, start).trim() === '' ? before : start
  let depth = 0
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}' && --depth === 0) return source.slice(from, i + 1)
  }
  throw new Error(`${name} 的花括号没有配平`)
}

test('斜杠命令不会被 Claude 回显，不算欠账；其余每条都欠一个回显', () => {
  const owePromptReplay = new Function(sliceFunction('owePromptReplay') + '; return owePromptReplay')()
  const active = { owedReplays: 0 }
  assert.equal(owePromptReplay(active, '跑一下测试'), true)
  assert.equal(owePromptReplay(active, ''), true, '只有图片的一句话也会被回显')
  assert.equal(owePromptReplay(active, '  /compact'), false)
  assert.equal(active.owedReplays, 2)
})

test('还欠着回显时到来的 result 不结束这一轮', () => {
  const body = sliceFunction('driveTurn')
  const guard = body.indexOf("message.type === 'result' && active.owedReplays > 0")
  const handler = body.indexOf("if (message.type === 'result') {")
  assert.notEqual(guard, -1, '没有欠账守卫')
  assert.ok(guard < handler, '守卫必须在 result 收尾逻辑之前')
  // 回显在被当作噪声跳过之前先销账。
  const settle = body.indexOf('active.owedReplays -= 1')
  const skip = body.indexOf('if (message.isReplay === true || machineryRow(message)) continue')
  assert.ok(settle !== -1 && settle < skip)
  // 记账在写之前：回显可能比 write 的 promise 先回来。
  const owe = body.indexOf('owePromptReplay(active, prompt)')
  const write = body.indexOf("message: { role: 'user', content: promptContent }")
  assert.ok(owe !== -1 && owe < write)
  // 用户按了停止：中断后的 result 照样收尾，不能等一个不会来的回显。
  assert.match(body.slice(guard, guard + 120), /!interrupted && !signal\.aborted/)
})

test('打断轮次间读取器之后，被打断的半轮渲染进当前这轮', () => {
  const body = sliceFunction('driveTurn')
  const stop = body.indexOf('await stopIdleDrain(')
  const render = body.indexOf('renderPendingProjections(session, sessionId, turn)', stop)
  const ensure = body.indexOf('run = await ensureRun(')
  assert.ok(stop !== -1 && render > stop && render < ensure)
})

function buildWake(agent) {
  const deps = {
    agents: { get: () => agent },
    pendingProjections: new Map([['s1', [{ rows: [{}], notice: '' }]]]),
    activeTurns: new Map(),
    carriersInFlight: new Set(),
    uuid: () => 'u1',
    CARRIER_TEXT: 'carrier',
    errorText: String,
    console: { error: () => {} },
  }
  const wakeForProjection = new Function(...Object.keys(deps),
    sliceFunction('wakeForProjection') + '; return wakeForProjection')(...Object.values(deps))
  return { wakeForProjection, deps }
}

test('dsh 还在跑时不发 carrier——它会被停进队列，再也没人认领', () => {
  const sent = []
  const agent = { status: 'running', followup: (message) => sent.push(message) }
  const { wakeForProjection, deps } = buildWake(agent)
  wakeForProjection('s1')
  assert.equal(sent.length, 0)
  assert.equal(deps.carriersInFlight.size, 0, '没发出去就不能挂着「在途」')

  agent.status = 'idle'
  wakeForProjection('s1')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].source.kind, 'plugin:claude-in-dsh')
  assert.ok(deps.carriersInFlight.has('s1'))
})

test('dsh 变空闲时会回头补发', () => {
  assert.match(source, /ctx\.on\('agent\/status', \(\{ agent, status \}\) => \{[^]*?wakeForProjection\(sessionId\)/)
})

test('排队的投影渲染一次就清空', () => {
  const written = []
  const deps = {
    pendingProjections: new Map([['s1', [{ rows: ['a', 'b'], notice: '' }, { rows: ['c'], notice: 'n' }]]]),
    projectClaudeEvents: (session, rows, notice, turn) => { written.push([rows.join(''), turn]); return rows.length },
    console: { log: () => {} },
  }
  const render = new Function(...Object.keys(deps),
    sliceFunction('renderPendingProjections') + '; return renderPendingProjections')(...Object.values(deps))
  assert.equal(render({}, 's1', 8), 3)
  assert.deepEqual(written, [['ab', 8], ['c', 8]])
  assert.equal(render({}, 's1', 9), 0)
})

test('cc 轮次以 reject 收尾，dsh 0.2 不会接着跑队列——空闲时由插件唤醒，一次一条', () => {
  const logs = []
  const make = (state) => new Function('stateOf', 'console', 'errorText',
    sliceFunction('resumeQueuedTurns') + '; return resumeQueuedTurns')(() => state, { log: (...a) => logs.push(a.join(' ')), error: () => {} }, String)
  let wakes = 0
  const agent = { status: 'idle', inbox: { hasPending: true, nextTurn: [{}, {}, {}] }, wakeDriver: () => { wakes += 1 } }
  make({ mode: 'claude' })(agent, 's1')
  assert.equal(wakes, 1)

  make({ mode: 'dsh' })(agent, 's1')
  assert.equal(wakes, 1, 'DSH 引擎的会话 dsh 自己会接着跑')
  agent.status = 'running'
  make({ mode: 'claude' })(agent, 's1')
  assert.equal(wakes, 1, '还在跑就不碰')
  agent.status = 'idle'
  agent.inbox.hasPending = false
  make({ mode: 'claude' })(agent, 's1')
  assert.equal(wakes, 1, '队列空了就不唤醒')
})

test('空闲监听同时处理投影和排队消息；打开会话时也会补一次', () => {
  assert.match(source, /ctx\.on\('agent\/status'[^]*?wakeForProjection\(sessionId\)\s*\n\s*resumeQueuedTurns\(agent, sessionId\)/)
  const stateGet = source.slice(source.indexOf("harness.handle('state.get'"))
  assert.match(stateGet.slice(0, 2000), /resumeQueuedTurns\(agent, sessionId\)/)
})

test('一直等不到回显也不会把轮次挂死：跳过的 result 之后静默 60 秒就按它收尾', () => {
  const body = sliceFunction('driveTurn')
  const decl = body.indexOf('let heldTimer = null')
  const tryAt = body.indexOf('try {\n        // Terminal Claude records')
  const fin = body.indexOf('done = true\n        releaseHeld()')
  assert.ok(decl !== -1 && tryAt !== -1 && decl < tryAt, '计时器要声明在 try 之外，finally 才看得见它')
  assert.ok(fin > tryAt, 'finally 里要撤掉计时器')
  const guard = body.indexOf("message.type === 'result' && active.owedReplays > 0")
  assert.match(body.slice(guard, guard + 400), /heldResult = message\s*\n\s*armHeld\(\)/)
  assert.match(body, /if \(message === OWED_ECHO_TIMEOUT\) \{[^]*?roundEndsAt = heldResult\.ccmodeOffset\s*\n\s*return/)
  assert.match(body, /message\.isReplay === true\) heldResult = null/)
  assert.match(body, /if \(heldResult !== null\) armHeld\(\)/, '有动静就重新计时，不是只算一次')
})

test('对外报告常驻进程和后台任务数，供 agent-mesh 的内存预算判断', () => {
  const pump = sliceFunction('pumpAttached')
  assert.match(pump, /residentBrokers\.delete\(run\.sessionId\)/, '进程退出就不再常驻')
  assert.match(pump, /backgroundTaskCounts\.set\(run\.sessionId/, '每条 background_tasks_changed 都记下来，不论谁在读')
  assert.match(sliceFunction('attach'), /residentBrokers\.add\(run\.sessionId\)/)
  assert.match(sliceFunction('stopRun'), /residentBrokers\.delete\(sessionId\)/)
  assert.match(sliceFunction('reapIdleBrokersOn'), /residentBrokers\.delete\(sessionId\)/)
  const pub = sliceFunction('publicState')
  assert.match(pub, /resident: residentBrokers\.has\(sessionId\)/)
  assert.match(pub, /backgroundTasks: backgroundTaskCounts\.get\(sessionId\) \|\| 0/)
})

test('补录不以 meta.json 为前提：停掉 Claude 会删掉它，而那正是有没显示的输出被困住的时候', () => {
  const drain = sliceFunction('drainDetachedOutput')
  assert.doesNotMatch(drain, /readJsonFile\(dir \+ '\/meta\.json'/)
})
