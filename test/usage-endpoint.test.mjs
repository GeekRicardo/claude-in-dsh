// 用量读数的取数半边：`api/oauth/usage` 会限流（429），而它的拒绝体也是一份
// 合法 JSON——解析得动，只是里面一个窗口都没有。分不清「这个账号没有窗口」和
// 「等会儿再问」，读数就会在限流期间静静变成空白。这几个用例把那条界线钉住，
// 顺带钉住失败之后的退避。函数住在引擎体的闭包里，照 quota-wait 的做法按名字
// 切出源码单独求值。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
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
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(from, i + 1)
    }
  }
  throw new Error(`${name} 的花括号没有配平`)
}

const windowsConst = /const USAGE_WINDOWS = \[[\s\S]*?\n {4}\]/.exec(source)[0]

/** loadUsage，接上一个假的 runCapture：凭据、环境覆盖、curl 各答一句。 */
function loadRig(answers) {
  return new Function('answers', `
    ${windowsConst}
    function runCapture(argv) {
      const joined = argv.join(' ')
      if (joined.indexOf('.credentials.json') >= 0) return Promise.resolve(answers.credentials)
      if (joined.indexOf('ANTHROPIC_BASE_URL') >= 0) return Promise.resolve(answers.env ?? '||')
      return Promise.resolve(answers.body)
    }
    ${sliceFunction('localUsageSource')}
    function remoteUsageSource() { throw new Error('这几个用例只走本机取数') }
    ${sliceFunction('loadUsage')}
    return (remote) => loadUsage(remote)
  `)(answers)
}

const CREDENTIALS = JSON.stringify({ claudeAiOauth: { accessToken: 'tok', subscriptionType: 'max', rateLimitTier: 'default' } })

test('限流的拒绝体是「等会儿再问」，不是「这个账号没有窗口」', async () => {
  const load = loadRig({
    credentials: CREDENTIALS,
    body: JSON.stringify({ error: { type: 'rate_limit_error', message: 'Rate limited. Please try again later.' } }),
  })
  const value = await load()
  assert.equal(value.official, true)
  assert.equal(value.error, 'Rate limited. Please try again later.', '原样带上服务端的说法')
  assert.equal(value.windows, undefined, '不能给出一份空窗口冒充读数')
})

test('一个窗口都没有的响应同样算取数失败', async () => {
  const load = loadRig({ credentials: CREDENTIALS, body: JSON.stringify({ something_else: true }) })
  const value = await load()
  assert.match(value.error, /no windows/)
})

test('正常响应照旧解析成窗口', async () => {
  const load = loadRig({
    credentials: CREDENTIALS,
    body: JSON.stringify({
      five_hour: { utilization: 42, resets_at: '2026-08-28T12:00:00Z' },
      seven_day: { utilization: 61 },
    }),
  })
  const value = await load()
  assert.equal(value.error, undefined)
  assert.deepEqual(value.windows.map(w => w.id), ['five_hour', 'seven_day'])
  assert.equal(value.windows[0].resetsAt, '2026-08-28T12:00:00Z')
  assert.equal(value.windows[1].resetsAt, null, '没有 resets_at 就是 null，不是 undefined')
})

/** usageSnapshot，接上一个数着自己被叫了几次的 loadUsage。 */
function snapshotRig(sequence) {
  return new Function('sequence', `
    const calls = []
    const usageByTarget = new Map()
    function errorText(error) { return String(error && error.message ? error.message : error) }
    function loadUsage() {
      calls.push(1)
      return Promise.resolve(sequence[Math.min(calls.length - 1, sequence.length - 1)])
    }
    ${sliceFunction('usageReadable')}
    ${sliceFunction('usageCellOf')}
    ${sliceFunction('usageSnapshot')}
    return { usageSnapshot, calls }
  `)(sequence)
}

const READING = { official: true, subscription: 'max', windows: [{ id: 'five_hour', label: '5h', utilization: 10, resetsAt: null }] }
const REFUSAL = { official: true, subscription: 'max', error: 'Rate limited. Please try again later.' }

test('拿到读数后一分钟内的普通询问都由缓存回答', async () => {
  const rig = snapshotRig([READING])
  await rig.usageSnapshot(false)
  await rig.usageSnapshot(false)
  assert.equal(rig.calls.length, 1)
})

test('强制刷新会绕开缓存——但绕不开刚刚那次限流', async () => {
  const good = snapshotRig([READING, READING])
  await good.usageSnapshot(false)
  await good.usageSnapshot(true)
  assert.equal(good.calls.length, 2, '读数是好的，强制刷新就该真的去取')

  const refused = snapshotRig([REFUSAL, READING])
  await refused.usageSnapshot(false)
  const again = await refused.usageSnapshot(true)
  assert.equal(refused.calls.length, 1, '刚被拒绝过，强制刷新也要等一分钟')
  assert.equal(again.error, REFUSAL.error, '这期间答的是那次拒绝本身')
})
