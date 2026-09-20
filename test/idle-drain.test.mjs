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
  const calls = { projected: [], permissions: [], timers: [], detached: [], errors: [], ccMirror: [] }
  const deps = {
    detach: (sessionId) => { calls.detached.push(sessionId) },
    IDLE_STOPPED: IDLE_STOPPED,
    IDLE_QUIET_MS: 10000,
    IDLE_TASK_QUIET_MS: 30 * 60 * 1000,
    lastBackgroundTaskCount: async () => 0,
    idleSignal: new AbortController().signal,
    shuttingDown: false,
    // 读取器把自己的异常吞进日志（一个读取器崩掉不该带走整个会话），
    // 所以测试这边把它记下来，否则少注入一个依赖只会表现成「什么都没发生」。
    errorText: (error) => {
      calls.errors.push(String(error && error.stack ? error.stack : error))
      return String(error && error.message ? error.message : error)
    },
    stateOf: () => ({ mode: 'claude' }),
    agents: { get: () => ({ id: 'agent' }) },
    // The dsh-native mirror of background tasks is wired through the idle
    // reader too; the rig stubs it and records every call.
    ccTaskStarted: (run, agent, message) => { calls.ccMirror.push(['started', message.task_id]) },
    ccTaskNotification: (run, agent, message) => { calls.ccMirror.push(['notified', message.task_id]) },
    mirrorParentedAssistant: () => {},
    mirrorParentedResult: () => {},
    armTimeout: (fn, ms) => {
      const entry = { fn: fn, ms: ms, cancelled: false }
      calls.timers.push(entry)
      return () => { entry.cancelled = true }
    },
    projectIdleStretch: async (sessionId, run, endsAt) => {
      calls.projected.push({ endsAt: endsAt })
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

/** 当前还挂着的那个静默计时——每来一条消息就换一个新的。 */
function pending(rig) {
  assert.deepEqual(rig.calls.errors, [], '读取器不该抛异常')
  const live = rig.calls.timers.filter((entry) => !entry.cancelled)
  assert.equal(live.length, 1, `应该正好挂着一个静默计时，实际 ${live.length} 个`)
  return live[0]
}

const QUIET = 10000
const TASK_QUIET = 30 * 60 * 1000

test('一条消息都没有也会自己走掉', async () => {
  const rig = build()
  const run = makeRun()
  // 一轮寻常对话：result 已经被 turn 自己消费了，读取器面对的是空队列。
  rig.startIdleDrain('s', run)
  await settle()

  const timer = pending(rig)
  assert.equal(timer.ms, QUIET, '什么都没等到，就该按短窗口走')
  timer.fn()
  await settle()
  assert.equal(run.idleTask, undefined, '否则每一轮都留下一个永不退出的读取器')
  assert.deepEqual(rig.calls.detached, ['s'], 'run 留在 runs 里的话 reaper 会一直跳过它')
})

test('接手时从日志里认出后台任务还没跑完', async () => {
  // 设置 tasksOpen 的那条事件，通常在这个读取器存在之前就滚过去了：
  // 要么被上一轮自己消费掉，要么发生在 dsh 重启之前。
  const rig = build({ lastBackgroundTaskCount: async () => 1 })
  const run = makeRun()
  rig.startIdleDrain('s', run)
  await settle()

  assert.equal(pending(rig).ms, TASK_QUIET,
    '否则一轮刚结束就按 10 秒走人，正好赶在后台的 sleep 醒来之前')
  await rig.stopIdleDrain(run)
})

test('后台任务还在跑时，静默窗口放长', async () => {
  const rig = build()
  const run = makeRun()
  rig.startIdleDrain('s', run)
  run.push({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ id: 'a' }] })
  run.push({ type: 'result', ccmodeOffset: 100 })
  await settle()

  assert.equal(rig.calls.projected.length, 1, '这一轮应该被投影出去')
  assert.equal(pending(rig).ms, TASK_QUIET,
    '后台的 sleep 期间本来就是一片安静，按 10 秒走会正好错过它醒来那一轮')
  assert.notEqual(run.idleTask, undefined)
  await rig.stopIdleDrain(run)
})

test('没有后台任务了，静默窗口到点就退出', async () => {
  const rig = build()
  const run = makeRun()
  rig.startIdleDrain('s', run)
  run.push({ type: 'system', subtype: 'background_tasks_changed', tasks: [] })
  run.push({ type: 'result', ccmodeOffset: 100 })
  await settle()

  const timer = pending(rig)
  assert.equal(timer.ms, QUIET, '没有东西能再唤醒 Claude 了')
  timer.fn()
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

test('静默窗口里又来了消息就重新计时', async () => {
  const rig = build()
  const run = makeRun()
  rig.startIdleDrain('s', run)
  run.push({ type: 'system', subtype: 'background_tasks_changed', tasks: [] })
  run.push({ type: 'result', ccmodeOffset: 100 })
  await settle()
  const armed = pending(rig)

  // 自发的下一轮开始了：init 紧跟在 result 后面一两行，静默窗口就是为了盖住
  // 这个间隙——判早了那一轮就得等用户下次打开会话才看得到。
  run.push({ type: 'system', subtype: 'init' })
  await settle()
  assert.equal(armed.cancelled, true, '有动静就不该再按原来那个点退出')
  assert.notEqual(pending(rig), armed, '应该换成一个新的计时')
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

test('后台任务通知只喂 dsh 自己的面，不写进对话', async () => {
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

  // jobs 行结算 / subagent 子会话收尾——这才是通知该去的地方。转录里不再多一条
  // 「⚙ 后台任务通知：bsd03x8rc」：同一件事在侧栏已经有原生的呈现了。
  assert.deepEqual(rig.calls.ccMirror, [['notified', 'bsd03x8rc']], '通知要同步进 cc 镜像')
  assert.deepEqual(rig.calls.projected, [{ endsAt: 64 }], '投影只带这一轮真实的消息')
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

// —— 打开会话时重新跟上一个还活着的 Claude ——

function buildFollow(world) {
  const calls = { attached: [], followed: [], detached: [], logged: [] }
  const state = { mode: 'claude', ...(world.state || {}) }
  const deps = {
    shuttingDown: false,
    errorText: String,
    followInFlight: new Set(),
    runs: world.runs || new Map(),
    activeTurns: world.activeTurns || new Map(),
    stateOf: () => state,
    // 这个会话跑在哪台机器上：null 是本机。跟随器的每一次读都要带上它，
    // 否则会去读本机同名路径——那正是 broker 明明活着却「未就位」的原因。
    remoteOf: (value) => (value && typeof value.remote === 'string' && value.remote !== '' ? { id: value.remote } : null),
    sessionDir: () => '/tmp/ccmode/session-x',
    launchSnapshot: () => 'bypassPermissions|',
    isAlive: async (pid) => world.alivePids.includes(pid),
    fileSize: async () => 9999,
    readJsonFile: async (p) => {
      if (p.endsWith('meta.json')) return world.meta
      if (p.endsWith('exit.json')) return world.exit === undefined ? null : world.exit
      if (p.endsWith('attach.json')) return world.attach === undefined ? null : world.attach
      return null
    },
    createRun: (sessionId, dir, snapshot, claudeSessionId, remote) => ({ sessionId, dir, snapshot, claudeSessionId, remote: remote === undefined ? null : remote }),
    attach: async (run) => { calls.attached.push(run.offset) },
    startIdleDrain: (sessionId, run, offset) => { calls.followed.push(offset) },
    detach: (sessionId) => { calls.detached.push(sessionId); deps.runs.delete(sessionId); return true },
    console: { log: (...args) => calls.logged.push(args.join(' ')), error: () => undefined },
  }
  const fn = new Function('deps', `
    const { ${Object.keys(deps).join(', ')} } = deps
    ${sliceFunction('hearsRun')}
    ${sliceFunction('resumeIdleFollow')}
    return resumeIdleFollow
  `)(deps)
  return { resumeIdleFollow: fn, calls: calls, runs: deps.runs }
}

const LIVE_META = { brokerPid: 4242, snapshot: 'bypassPermissions|', claudeSessionId: 'cs', cwd: '/root/code/zx' }
const SESSION = { header: { cwd: '/root/code/zx' } }

test('会话被打开时，还活着的 Claude 会被重新跟上', async () => {
  const rig = buildFollow({ meta: LIVE_META, alivePids: [4242], attach: { offset: 1411490 } })
  assert.equal(await rig.resumeIdleFollow('s', SESSION), true)
  assert.deepEqual(rig.calls.attached, [1411490], '从上次记下的位置接着读')
  assert.deepEqual(rig.calls.followed, [1411490])
  assert.equal(rig.runs.has('s'), true, 'run 要登记，否则下一轮会再起一个进程')
})

test('broker 已经死了就不跟——更不会顺手起一个新的', async () => {
  const rig = buildFollow({ meta: LIVE_META, alivePids: [] })
  assert.equal(await rig.resumeIdleFollow('s', SESSION), false)
  assert.deepEqual(rig.calls.attached, [])
  assert.equal(rig.runs.size, 0, '打开会话不该平白起一个 130 MB 的进程')
})

test('进程已经退出（exit.json 在）就不跟', async () => {
  const rig = buildFollow({ meta: LIVE_META, alivePids: [4242], exit: { exitCode: 0 } })
  assert.equal(await rig.resumeIdleFollow('s', SESSION), false)
  assert.deepEqual(rig.calls.attached, [])
})

test('启动参数变了就交给下一轮的 ensureRun', async () => {
  const rig = buildFollow({ meta: { ...LIVE_META, snapshot: 'manual|high' }, alivePids: [4242] })
  assert.equal(await rig.resumeIdleFollow('s', SESSION), false)
  assert.deepEqual(rig.calls.attached, [], '换档要退旧进程起新的，这里做不了')
})

test('已经有人在读这条流就不插一脚', async () => {
  const runs = new Map([['s', { sessionId: 's', reader: { terminate: () => undefined } }]])
  const rig = buildFollow({ meta: LIVE_META, alivePids: [4242], runs: runs })
  assert.equal(await rig.resumeIdleFollow('s', SESSION), false)
  assert.deepEqual(rig.calls.attached, [], '两个读取器抢一个队列会丢消息')
})

test('手上那个 run 已经听不见了，就放掉它重新挂——否则自愈的路也被它堵着', async () => {
  // 实测现场：一轮跑完后读取器静默释放了流，run 却留在 runs 里。下一条消息
  // 拿到这个空壳，prompt 照样写进 fifo（Claude 真的开始干活了），但回来的路
  // 是断的：Claude 在那头输出了 700KB，dsh 这边二十分钟一片空白。而 runs.has
  // 为真，resumeIdleFollow 也就不肯重新挂上去。
  for (const dead of [
    { sessionId: 's', reader: null },
    { sessionId: 's', reader: { terminate: () => undefined }, readerDead: true },
    { sessionId: 's', reader: { terminate: () => undefined }, detached: true },
  ]) {
    const runs = new Map([['s', dead]])
    const rig = buildFollow({ meta: LIVE_META, alivePids: [4242], runs: runs, attach: { offset: 77 } })
    assert.equal(await rig.resumeIdleFollow('s', SESSION), true, JSON.stringify(Object.keys(dead)) + ' 应该重新挂上')
    assert.deepEqual(rig.calls.detached, ['s'], '先把听不见的那个放掉')
    assert.deepEqual(rig.calls.attached, [77])
  }
})

test('DSH 引擎的会话不碰', async () => {
  const rig = buildFollow({ meta: LIVE_META, alivePids: [4242], state: { mode: 'dsh' } })
  assert.equal(await rig.resumeIdleFollow('s', SESSION), false)
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

test('看门狗问的是「这一轮有没有回音」，不是「这个 run 收过东西没有」', () => {
  // run.sawAnyMessage 是 run 级别的：一个被复用的 run 上一轮收过，这个标记就
  // 永远是 true，于是「提交后 120 秒毫无回应」那条守卫永远不响。空壳 run 加
  // 上哑掉的看门狗，合起来就是那个「卡住、没输出、日志里也没有」。
  const body = source.slice(source.indexOf('const submittedAt = Date.now()'))
  const watch = body.slice(0, body.indexOf('while (true)'))
  assert.match(watch, /const heardAtStart = run\.heard/, '要记下这一轮开始时的计数')
  assert.match(watch, /\(run\.heard \|\| 0\) === heardAtStart/, '比的是计数有没有变')
  assert.equal(/run\.sawAnyMessage !== true && Date\.now\(\) - submittedAt/.test(watch), false,
    '不能再用 run 级别的布尔当这一轮的判据')
  // 计数必须真的在涨，否则上面那个判据永远成立，看门狗会错杀正常的长轮次。
  const push = source.slice(source.indexOf('run.push = (value) => {'))
  assert.match(push.slice(0, 300), /run\.heard = \(run\.heard \|\| 0\) \+ 1/)
})

test('ensureRun 不复用一个听不见的 run', () => {
  const body = sliceFunction('ensureRun')
  const at = body.indexOf('live.snapshot === snapshot')
  assert.notEqual(at, -1)
  assert.match(body.slice(at, at + 120), /hearsRun\(live\)/,
    'broker 活着不等于还听得见它——拿到空壳，prompt 写得进去，回音永远等不到')
})
