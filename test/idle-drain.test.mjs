// 轮次之间的读取器：Claude 的 result 之后，Claude 自己还可能再开一轮
// （后台任务跑完 → task_notification → init → …）。这些函数住在引擎体的
// 闭包里，所以照 user-questions 的做法按名字切出源码单独求值——改名或删掉
// 时这个测试会响，而不是静默失效。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const source = fs.readFileSync(path.join(root, 'src/host.dynamic.js'), 'utf8')

/** 切出一个具名函数的完整源码，`async` 前缀一并带上。 */
function sliceFunction(name) {
  const start = source.indexOf(`function ${name}(`)
  assert.notEqual(start, -1, `找不到 ${name}——它被改名或删掉了`)
  const before = source.lastIndexOf('async ', start)
  const from = before !== -1 && source.slice(before + 'async '.length, start).trim() === '' ? before : start
  let depth = 0
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(from, i + 1)
    }
  }
  throw new Error(`${name} 的花括号没有配平`)
}

const IDLE_STOPPED = { idleStopped: true }

/** 引擎体的一小块，依赖全部从外面注入。 */
function build(overrides) {
  const calls = { projected: [], permissions: [], timers: [], detached: [] }
  const deps = {
    detach: (sessionId) => { calls.detached.push(sessionId) },
    IDLE_STOPPED: IDLE_STOPPED,
    IDLE_QUIET_MS: 10000,
    idleSignal: new AbortController().signal,
    shuttingDown: false,
    errorText: (error) => String(error && error.message ? error.message : error),
    stateOf: () => ({ mode: 'claude' }),
    agents: { get: () => ({ id: 'agent' }) },
    armTimeout: (fn) => {
      const entry = { fn: fn, cancelled: false }
      calls.timers.push(entry)
      return () => { entry.cancelled = true }
    },
    projectIdleStretch: async (sessionId, run, notice, endsAt) => {
      calls.projected.push({ notice: notice, endsAt: endsAt })
      return 1
    },
    answerPermission: (run, agent, state, message) => { calls.permissions.push(message) },
    ...overrides,
  }
  const names = ['idleNext', 'startIdleDrain', 'stopIdleDrain']
  const made = new Function('deps', `
    const { ${Object.keys(deps).join(', ')} } = deps
    ${names.map(sliceFunction).join('\n')}
    return { ${names.join(', ')} }
  `)(deps)
  return { ...made, calls: calls }
}

function makeRun() {
  const run = { queue: [], waiter: null, closed: false, offset: 0, consumed: 0, dir: '/tmp/ccmode/test' }
  run.push = (value) => {
    run.queue.push(value)
    const waiter = run.waiter
    run.waiter = null
    if (waiter !== null && waiter !== undefined) waiter()
  }
  return run
}

/** 让被挂起的读取器跑到下一个 await。 */
const settle = () => new Promise((resolve) => setImmediate(resolve))

test('后台任务还在跑时，读取器不退出', async () => {
  const rig = build()
  const run = makeRun()
  rig.startIdleDrain('s', run)
  run.push({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ id: 'a' }] })
  run.push({ type: 'result', ccmodeOffset: 100 })
  await settle()

  assert.equal(rig.calls.projected.length, 1, '这一轮应该被投影出去')
  assert.equal(rig.calls.timers.length, 0, '还有任务在跑，不该起静默计时')
  assert.notEqual(run.idleTask, undefined, '读取器应该继续等下一轮')
  await rig.stopIdleDrain(run)
})

test('没有后台任务了，静默窗口到点就退出', async () => {
  const rig = build()
  const run = makeRun()
  rig.startIdleDrain('s', run)
  run.push({ type: 'system', subtype: 'background_tasks_changed', tasks: [] })
  run.push({ type: 'result', ccmodeOffset: 100 })
  await settle()

  assert.equal(rig.calls.timers.length, 1, '任务清空后应该起静默计时')
  rig.calls.timers[0].fn()
  await settle()
  assert.equal(run.idleTask, undefined, '静默到点，读取器应该让出')
  assert.deepEqual(rig.calls.detached, ['s'],
    '不 detach 的话进程还挂在 runs 里，reaper 永远收不掉它')
})

test('被叫停不等于没事干了，不该 detach', async () => {
  const rig = build()
  const run = makeRun()
  rig.startIdleDrain('s', run)
  await rig.stopIdleDrain(run)
  assert.deepEqual(rig.calls.detached, [], '这一轮马上就要用这个进程')
})

test('静默窗口里又来了消息就取消退出', async () => {
  const rig = build()
  const run = makeRun()
  rig.startIdleDrain('s', run)
  run.push({ type: 'system', subtype: 'background_tasks_changed', tasks: [] })
  run.push({ type: 'result', ccmodeOffset: 100 })
  await settle()
  assert.equal(rig.calls.timers.length, 1)

  // 自发的下一轮开始了。
  run.push({ type: 'system', subtype: 'init' })
  await settle()
  assert.equal(rig.calls.timers[0].cancelled, true, '有动静就不该再退出')
  assert.notEqual(run.idleTask, undefined)
  await rig.stopIdleDrain(run)
})

test('轮次的投影终点取自 result 自带的位置', async () => {
  const rig = build()
  const run = makeRun()
  rig.startIdleDrain('s', run, 40)
  assert.equal(run.idleFrom, 40, '起点应该是上一轮 result 的位置')

  run.push({ type: 'result', ccmodeOffset: 512 })
  await settle()
  assert.equal(rig.calls.projected[0].endsAt, 512,
    '终点必须是 result 那一行的位置，不是 pump 已经读到哪')
  await rig.stopIdleDrain(run)
})

test('后台任务通知作为附言随这一轮投影出去', async () => {
  const rig = build()
  const run = makeRun()
  rig.startIdleDrain('s', run)
  run.push({
    type: 'system',
    subtype: 'task_notification',
    task_id: 'bsd03x8rc',
    description: '等 3 分钟',
    summary: 'Background command 完成 (exit code 0)',
  })
  run.push({ type: 'result', ccmodeOffset: 64 })
  await settle()

  const notice = rig.calls.projected[0].notice
  assert.match(notice, /后台任务通知/)
  assert.match(notice, /等 3 分钟/)
  assert.match(notice, /exit code 0/)
  await rig.stopIdleDrain(run)
})

test('自发轮次里的权限请求照样送去审批', async () => {
  const rig = build()
  const run = makeRun()
  rig.startIdleDrain('s', run)
  run.push({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Bash' } })
  await settle()

  assert.equal(rig.calls.permissions.length, 1, '否则 Claude 会卡在没人看得见的问题上')
  await rig.stopIdleDrain(run)
})

test('被叫停时交出半截轮次并清空队列', async () => {
  const rig = build()
  const run = makeRun()
  rig.startIdleDrain('s', run)
  // 一轮开到一半，用户插话了。
  run.push({ type: 'assistant', message: { content: [] } })
  await settle()
  run.push({ type: 'user', message: { content: [] } })

  await rig.stopIdleDrain(run)
  assert.equal(rig.calls.projected.length, 1, '半截也得交出去，否则这段永远看不到')
  assert.equal(run.queue.length, 0, '留在队列里的消息会被下一轮当成自己的回答')
  assert.equal(run.idleTask, undefined)
})

test('流断了就干净退出，不去动队列', async () => {
  const rig = build()
  const run = makeRun()
  rig.startIdleDrain('s', run)
  run.push(undefined)
  await settle()

  assert.equal(run.idleTask, undefined)
  assert.equal(rig.calls.projected.length, 0, 'detach 之后由 drainDetachedOutput 从 attach.json 接手')
})

test('同一个 run 不会有两个读取器', async () => {
  const rig = build()
  const run = makeRun()
  rig.startIdleDrain('s', run)
  const first = run.idleTask
  rig.startIdleDrain('s', run)
  assert.equal(run.idleTask, first, '两个消费者会抢同一个队列')
  await rig.stopIdleDrain(run)
})
