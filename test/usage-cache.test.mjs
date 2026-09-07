// 输入框下方的用量读数：切对话、刷新页面、host 抖动的时候都不许空白，
// 但也不许把过期的百分比当成当前读数——每个窗口都带 resetsAt，过了那个时刻
// 数字不是「旧」，是「错」。这几个纯函数就是这条界线，按 quota-wait 的做法
// 从客户端半的闭包里按名字切出来单独求值。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const source = fs.readFileSync(path.join(root, 'src/client.dynamic.js'), 'utf8')

function sliceFunction(name) {
  const start = source.indexOf(`function ${name}(`)
  assert.notEqual(start, -1, `找不到 ${name}——它被改名或删掉了`)
  let depth = 0
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  throw new Error(`${name} 的花括号没有配平`)
}

// 上限跟着源码走：改了那个常量，这些用例衡量的就是新的上限。
const maxAge = new Function('return ' + /const USAGE_CACHE_MAX_MS = ([^\n]+)/.exec(source)[1])()
const rig = new Function(`
  const USAGE_CACHE_MAX_MS = ${maxAge}
  ${sliceFunction('usableUsage')}
  ${sliceFunction('seedUsage')}
  ${sliceFunction('usageExpired')}
  return { usableUsage, seedUsage, usageExpired }
`)()

const snapshot = (minutesToReset) => ({
  official: true,
  subscription: 'max',
  windows: [{ id: 'five_hour', label: '5h', utilization: 40, resetsAt: new Date(Date.now() + minutesToReset * 60000).toISOString() }],
})

test('只有真正带窗口的订阅快照才值得缓存和展示', () => {
  assert.equal(rig.usableUsage(snapshot(60)), true)
  assert.equal(rig.usableUsage({ official: false, reason: 'gateway-override' }), false, 'API key / 网关没有订阅窗口')
  assert.equal(rig.usableUsage({ official: true, error: 'usage endpoint unavailable' }), false, '取数失败不是读数')
  assert.equal(rig.usableUsage({ official: true, windows: [] }), false)
  assert.equal(rig.usableUsage(null), false)
})

test('缓存足够新才拿来先渲染，太老就宁可空着', () => {
  const fresh = JSON.stringify({ at: Date.now() - 60000, value: snapshot(60) })
  assert.notEqual(rig.seedUsage(fresh, Date.now()), null)

  const old = JSON.stringify({ at: Date.now() - maxAge - 1000, value: snapshot(60) })
  assert.equal(rig.seedUsage(old, Date.now()), null, '过了上限的缓存是错数，不是旧数')
})

test('损坏或缺失的缓存不会让读数崩掉', () => {
  assert.equal(rig.seedUsage(null, Date.now()), null, '没存过')
  assert.equal(rig.seedUsage('{ not json', Date.now()), null)
  assert.equal(rig.seedUsage(JSON.stringify({ at: Date.now(), value: { official: false } }), Date.now()), null)
})

test('窗口过了重置时刻，下一次轮询必须强制重取', () => {
  assert.equal(rig.usageExpired(snapshot(60)), false)
  assert.equal(rig.usageExpired(snapshot(-1)), true, '5h 窗口已经翻篇，host 的 60 秒缓存不能再算数')
  assert.equal(rig.usageExpired(null), false, '没有读数就没有过期一说')
})
