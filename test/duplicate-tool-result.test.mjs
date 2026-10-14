// 一个调用被回了两条 tool/result，整份会话日志就再也打不开。
//
// 实际现场（courtify/zhongxin 的一个对话）：
//   step 1  tool/call   call_00_sYTC…  name=bash
//   step 1  tool/result 「这次调用没有等到结果（上一次运行被中断）。」  ← 补录盖的章
//   step 1  step/end
//   step 2  tool/result 「Command did not complete within its 120s timeout…」 ← 真结果迟到 2 分钟
//
// 第二条落在 step 2，而那一步从没声明过这个调用，于是下一次加载 dsh 直接拒掉
// 整份日志：`tool/result <id> has no advertised tool lifecycle`——对话再也打不开。
//
// 一轮自己的「一个调用一条结果」记账只认得它自己写过的，而写的人不止一个：
// 补录投影盖完章就消亡，记账跟着没了；两分钟后真结果从 live 流进来，全新的
// 一轮对那个章一无所知。所以 answered 必须从日志里种，不能从空开始。

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

function build(events) {
  const deps = { sessionEvents: () => events }
  return new Function('deps', `
    const { ${Object.keys(deps).join(', ')} } = deps
    ${sliceFunction('settledCallIds')}
    return settledCallIds
  `)(deps)
}

/** v4 的 tool/result：id 在 message.toolCallId，source.callId 也带一份。 */
const result = (callId) => ({
  type: 'tool/result',
  data: { turn: 28, step: 1, message: { role: 'tool', toolCallId: callId, source: { kind: 'tool', callId: callId } } },
})

test('日志里结过的调用都被认出来', () => {
  const settledCallIds = build([
    { type: 'tool/call', data: { callId: 'toolu_a' } },
    result('toolu_a'),
    { type: 'tool/call', data: { callId: 'toolu_b' } },
    result('toolu_b'),
  ])
  const settled = settledCallIds({})
  assert.equal(settled.size, 2)
  assert.ok(settled.has('toolu_a'))
  assert.ok(settled.has('toolu_b'))
})

test('只有 source.callId 的老事件也认（v3 迁上来的形状）', () => {
  const settledCallIds = build([
    { type: 'tool/result', data: { message: { role: 'tool', source: { kind: 'tool', callId: 'call_00_x' } } } },
  ])
  assert.ok(settledCallIds({}).has('call_00_x'))
})

test('声明了但没结果的调用不算结过——它还等着真结果', () => {
  const settledCallIds = build([{ type: 'tool/call', data: { callId: 'toolu_open' } }])
  assert.equal(settledCallIds({}).size, 0, '把未结的调用算成结过，真结果就再也写不进来了')
})

test('残缺事件不会让它炸，也不会混进空 id', () => {
  const settledCallIds = build([
    { type: 'tool/result' },
    { type: 'tool/result', data: null },
    { type: 'tool/result', data: {} },
    { type: 'tool/result', data: { message: null } },
    { type: 'tool/result', data: { message: {} } },
    { type: 'tool/result', data: { message: { source: null } } },
    { type: 'tool/result', data: { message: { toolCallId: '' } } },
    { type: 'assistant/message', data: { message: { content: [] } } },
  ])
  const settled = settledCallIds({})
  assert.equal(settled.size, 0)
  assert.ok(!settled.has(''), '空 id 混进去会把下一个无 id 的结果误判成重复')
})

test('一轮的 answered 是从日志种的，不是空集合', () => {
  assert.match(source, /const answered = settledCallIds\(session\)/,
    'answered 又变回 new Set() 了——补录盖过章的调用会被再写一条结果，整份日志下次加载就被拒')
})

test('修复脚本认识「重复 tool/result」这种坏行', () => {
  const repair = fs.readFileSync(path.join(root, 'scripts/repair-v4-log.mjs'), 'utf8')
  assert.match(repair, /duplicate result for an already settled call/,
    '脚本不认这种形态时，报的是「仍不合规（这里没有对应的修法）」，对话就只能手修')
  // 全局累积的 advertised 认不出「第二条」，必须用 unresolved 那份「还开着」的账。
  assert.match(repair, /const stillOpen = unresolved\.has\(callId\)/)
})
