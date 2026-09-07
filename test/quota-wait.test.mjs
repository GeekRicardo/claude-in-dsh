// 用量上限：Claude 原生 TUI 会把撞上 5h/7d 限额的那一轮挂住，等窗口重置后自己
// 接着干（autoContinueAtUsageLimit）。`-p --output-format stream-json` 这条路
// 上没有那套对话框，所以这几个函数把同一件事做在插件这一侧。它们住在引擎体的
// 闭包里，照 idle-drain 的做法按名字切出源码单独求值。

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

/** 续跑提示词必须和 Claude 自己发的逐字一致——换了词就是换了行为。 */
function constant(name) {
  const match = new RegExp(`const ${name} = '([^']*)'`).exec(source)
  assert.notEqual(match, null, `找不到常量 ${name}`)
  return match[1]
}

const RESUME = constant('QUOTA_RESUME_PROMPT')
const EARLY = constant('QUOTA_EARLY_PROMPT')

function build(overrides) {
  const calls = { notes: [], writes: [], logs: [] }
  const deps = {
    QUOTA_RESUME_PROMPT: RESUME,
    QUOTA_EARLY_PROMPT: EARLY,
    QUOTA_WAIT_HORIZON_MS: 24 * 60 * 60 * 1000,
    // 真实时钟，只是把窗口压到毫秒级：等待逻辑本身不看具体数值。
    QUOTA_POLL_MS: 1000000,
    QUOTA_UNREADABLE_GIVE_UP: 3,
    QUOTA_SETTLE_MS: 0,
    QUOTA_TICK_MS: 1,
    quotaWaits: new Map(),
    shuttingDown: false,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    usageSnapshot: async () => ({ official: true, windows: [] }),
    errorText: (error) => String(error && error.message ? error.message : error),
    console: { log: (...args) => calls.logs.push(args.join(' ')), error: () => {} },
    ...overrides,
  }
  const names = ['spentWindow', 'usageAuthFailure', 'quotaWaitOf', 'cancelQuotaWait', 'clockText', 'waitOutQuota']
  const made = new Function('deps', `
    const { ${Object.keys(deps).join(', ')} } = deps
    ${names.map(sliceFunction).join('\n')}
    return { ${names.join(', ')} }
  `)(deps)
  return { ...made, deps: deps, calls: calls }
}

const transcriptOf = (calls) => ({ note: (text) => calls.notes.push(text) })
const runOf = (calls) => ({ write: async (value) => { calls.writes.push(value) } })
const textOf = (write) => write.message.content[0].text

const window = (id, label, utilization, atMs) => ({
  id: id, label: label, utilization: utilization,
  resetsAt: new Date(atMs).toISOString(),
})

test('用完的窗口里挑重置最近的那个', () => {
  const rig = build()
  const now = Date.now()
  const found = rig.spentWindow({
    official: true,
    windows: [
      window('seven_day', '7d', 100, now + 3 * 3600e3),
      window('five_hour', '5h', 100, now + 1800e3),
    ],
  })
  assert.equal(found.id, 'five_hour', '能不能干活由最近的那个重置说了算')
})

test('没到线、已经过期、或者根本不是订阅，都不算撞上限额', () => {
  const rig = build()
  const now = Date.now()
  assert.equal(rig.spentWindow({ official: true, windows: [window('five_hour', '5h', 80, now + 3600e3)] }), null,
    '八成用量只是用得多，不是被挡住了')
  assert.equal(rig.spentWindow({ official: true, windows: [window('five_hour', '5h', 100, now - 60e3)] }), null,
    '重置时间在过去，等下去就是永远不动')
  assert.equal(rig.spentWindow({ official: false, reason: 'gateway-override' }), null,
    'API key / 第三方网关没有窗口可等')
  assert.equal(rig.spentWindow({ official: true, error: 'usage endpoint unavailable' }), null,
    '读不到用量时不能假装读到了')
})

test('等到重置，然后原样发出 Claude 自己那句续跑提示', async () => {
  const rig = build()
  const at = Date.now() + 20
  const kept = await rig.waitOutQuota('s', transcriptOf(rig.calls), runOf(rig.calls),
    { id: 'five_hour', label: '5h', at: at }, new AbortController().signal)

  assert.equal(kept, true, '这一轮要继续读同一条流，而不是收尾')
  assert.equal(rig.calls.writes.length, 1)
  assert.equal(textOf(rig.calls.writes[0]), RESUME)
  assert.equal(rig.calls.writes[0].parent_tool_use_id, null, '续跑是主轮的话，不是某个工具的子轮')
  assert.ok(Date.now() >= at, '不能在窗口重置之前就把提示发出去')
  assert.equal(rig.deps.quotaWaits.size, 0, '等待结束就不该再挂在 composer 上')
  assert.match(rig.calls.notes[0], /用量上限/)
  assert.match(rig.calls.notes[1], /自动继续/)
})

test('用量提前回来就提前继续，用的是另一句提示', async () => {
  let looked = 0
  const rig = build({
    QUOTA_POLL_MS: 1,
    usageSnapshot: async () => {
      looked += 1
      return { official: true, windows: [window('five_hour', '5h', looked > 1 ? 12 : 100, Date.now() + 3600e3)] }
    },
  })
  const kept = await rig.waitOutQuota('s', transcriptOf(rig.calls), runOf(rig.calls),
    { id: 'five_hour', label: '5h', at: Date.now() + 3600e3 }, new AbortController().signal)

  assert.equal(kept, true)
  assert.equal(textOf(rig.calls.writes[0]), EARLY, '提前恢复和窗口重置是两回事，提示词也不一样')
})

test('一次抖动不算恢复，读数回来后照常走完', async () => {
  let polls = 0
  const rig = build({
    QUOTA_POLL_MS: 1,
    // 第一次读不到，之后恢复正常但额度仍然用满——等待应该继续到重置。
    usageSnapshot: async () => {
      polls += 1
      return polls === 1
        ? { official: true, error: 'usage endpoint unavailable' }
        : { official: true, windows: [window('five_hour', '5h', 100, Date.now() + 30)] }
    },
  })
  const at = Date.now() + 30
  const kept = await rig.waitOutQuota('s', transcriptOf(rig.calls), runOf(rig.calls),
    { id: 'five_hour', label: '5h', at: at }, new AbortController().signal)

  assert.equal(kept, true)
  assert.ok(Date.now() >= at, '一次网络抖动不该被当成额度回来了')
  assert.equal(textOf(rig.calls.writes[0]), RESUME)
})

// 扣住一轮的前提是「确知额度用完了」。读数一直读不到就不满足这个前提——
// 真实事故里一次瞬时认证失败让一轮被干等了三个半小时，而账号其实只用了 2%。
test('一直读不到用量就不再扣人', async () => {
  const rig = build({
    QUOTA_POLL_MS: 1,
    usageSnapshot: async () => ({ official: true, error: 'usage endpoint unavailable' }),
  })
  const at = Date.now() + 60 * 60e3          // 一小时后才重置
  const kept = await rig.waitOutQuota('s', transcriptOf(rig.calls), runOf(rig.calls),
    { id: 'five_hour', label: '5h', at: at }, new AbortController().signal)

  assert.equal(kept, false, '读不到就不该继续替用户扣着这一轮')
  assert.ok(Date.now() < at, '更不该干等到重置时间')
  assert.deepEqual(rig.calls.writes, [], '没有续跑，就不该替用户发续跑提示')
  assert.match(rig.calls.notes.join('\n'), /读不到.*用量/)
})

test('token 被拒就立刻放手，不必等满三次', async () => {
  let polls = 0
  const rig = build({
    QUOTA_POLL_MS: 1,
    usageSnapshot: async () => {
      polls += 1
      return { official: true, error: 'OAuth access token has been revoked.' }
    },
  })
  const kept = await rig.waitOutQuota('s', transcriptOf(rig.calls), runOf(rig.calls),
    { id: 'five_hour', label: '5h', at: Date.now() + 60 * 60e3 }, new AbortController().signal)

  assert.equal(kept, false)
  assert.equal(polls, 1, '等待解决不了被拒的凭据，多轮询一次都是白扣一轮')
})

test('重置在 24 小时以后就不等了', async () => {
  const rig = build()
  const kept = await rig.waitOutQuota('s', transcriptOf(rig.calls), runOf(rig.calls),
    { id: 'seven_day', label: '7d', at: Date.now() + 30 * 3600e3 }, new AbortController().signal)

  assert.equal(kept, false, '挂一整天的轮次不是等待，是卡死')
  assert.deepEqual(rig.calls.writes, [])
  assert.match(rig.calls.notes[0], /超过 24 小时/)
})

test('按停止就放手，而且不替用户发续跑提示', async () => {
  const rig = build()
  const controller = new AbortController()
  const kept = rig.waitOutQuota('s', transcriptOf(rig.calls), runOf(rig.calls),
    { id: 'five_hour', label: '5h', at: Date.now() + 3600e3 }, controller.signal)
  await new Promise((resolve) => setTimeout(resolve, 5))
  controller.abort()

  assert.equal(await kept, false)
  assert.deepEqual(rig.calls.writes, [], '用户叫停之后再替他发一句话，正是他叫停要避免的事')
  assert.equal(rig.deps.quotaWaits.size, 0)
})

test('等待期间插话不取消等待，恢复时和续跑提示一起发出', async () => {
  const rig = build()
  const at = Date.now() + 30
  const kept = rig.waitOutQuota('s', transcriptOf(rig.calls), runOf(rig.calls),
    { id: 'five_hour', label: '5h', at: at }, new AbortController().signal)
  await new Promise((resolve) => setTimeout(resolve, 5))

  // 插话通路把消息塞进这里，而不是当场写给 Claude——当场写只会让它立刻再撞一次
  // 限额，那条错误 result 又会被当成续跑那一轮的结束。
  const wait = rig.deps.quotaWaits.get('s')
  assert.equal(wait.label, '5h', 'composer 要能把这个倒计时画出来')
  wait.held.push([{ type: 'text', text: '顺便把 README 也更了' }])

  assert.equal(await kept, true)
  assert.ok(Date.now() >= at, '人说了话也照样等到重置')
  assert.equal(rig.calls.writes.length, 1, '攒着的话要和续跑提示合成一条发出去')
  const blocks = rig.calls.writes[0].message.content
  assert.equal(blocks[0].text, RESUME, '续跑提示在前——它才是那句「别重做已完成的活」')
  assert.equal(blocks[1].text, '顺便把 README 也更了')
})

test('取消等待时说清楚攒着的消息没发出去', async () => {
  const rig = build()
  const kept = rig.waitOutQuota('s', transcriptOf(rig.calls), runOf(rig.calls),
    { id: 'five_hour', label: '5h', at: Date.now() + 3600e3 }, new AbortController().signal)
  await new Promise((resolve) => setTimeout(resolve, 5))
  rig.deps.quotaWaits.get('s').held.push([{ type: 'text', text: '再看一眼日志' }])
  assert.equal(rig.cancelQuotaWait('s', 'cancelled'), true)

  assert.equal(await kept, false)
  assert.deepEqual(rig.calls.writes, [])
  assert.match(rig.calls.notes[rig.calls.notes.length - 1], /1 条消息没有发出/)
  assert.equal(rig.quotaWaitOf('s'), null)
})

test('没有等待时取消是空操作', () => {
  const rig = build()
  assert.equal(rig.cancelQuotaWait('s', 'cancelled'), false)
  assert.equal(rig.quotaWaitOf('s'), null)
})
