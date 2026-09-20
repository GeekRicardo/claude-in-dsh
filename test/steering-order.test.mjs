// 在 Claude 跑工具的时候插一句话，工具卡片被劈成了两半。
//
// steering 那一路当场就把 user/message 写进转录：那一刻 tool/call 已经落下、
// tool/result 还没回来，夹在中间的一条用户消息把「调用」和「结果」分到了两边。
// 现场：session-cfd1b43c 的 turn 19 和 turn 22，两条插话正好卡在 call 和
// result 之间（另有 3 条落在 step 内部）。
//
// 发给 Claude 的那一路不受影响——插话的意义就是立刻拐一下正在跑的那轮，
// 晚一秒都不算 steering。只有「写给人看」的这条排到工具配对齐之后。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const source = fs.readFileSync(path.join(root, 'src/host.dynamic.js'), 'utf8')

/** 造一个只有延迟逻辑的迷你转录，行为和 createTranscript 里那三个函数一致。 */
function makeDeferrer() {
  const pending = new Map()
  const written = []
  const deferred = []
  const hasOpenCalls = () => pending.size > 0
  const deferUserMessage = (write) => { if (!hasOpenCalls()) { write(); return } deferred.push(write) }
  const flush = (force) => {
    if (deferred.length === 0) return
    if (pending.size > 0 && force !== true) return
    for (const w of deferred.splice(0)) w()
  }
  return {
    written,
    call: (id) => { pending.set(id, 1); written.push('tool/call:' + id) },
    result: (id) => { pending.delete(id); written.push('tool/result:' + id); flush() },
    steer: (text) => deferUserMessage(() => written.push('user:' + text)),
    finish: () => { pending.clear(); flush(true); written.push('turn/end') },
  }
}

test('工具跑到一半时插话，不劈开调用和它的结果', () => {
  const t = makeDeferrer()
  t.call('c1')
  t.steer('确保不会出现权限问题')   // 插话到达：此刻 c1 还没有结果
  t.result('c1')
  t.finish()
  assert.deepEqual(t.written, [
    'tool/call:c1',
    'tool/result:c1',
    'user:确保不会出现权限问题',
    'turn/end',
  ], 'user 消息必须排到结果之后，不能夹在中间')
})

test('没有未完成的工具时，插话当场就写', () => {
  const t = makeDeferrer()
  t.call('c1')
  t.result('c1')
  t.steer('你早这样沟通不就好了')
  t.finish()
  assert.deepEqual(t.written, ['tool/call:c1', 'tool/result:c1', 'user:你早这样沟通不就好了', 'turn/end'])
})

test('多个工具并行时，等最后一个结果回来才写', () => {
  const t = makeDeferrer()
  t.call('a'); t.call('b')
  t.steer('插一句')
  t.result('a')
  assert.equal(t.written.includes('user:插一句'), false, 'b 还没回来，不能写')
  t.result('b')
  assert.deepEqual(t.written, ['tool/call:a', 'tool/call:b', 'tool/result:a', 'tool/result:b', 'user:插一句'])
})

test('工具结果永远不回来时，收尾也要把插话补上——不能让它消失', () => {
  const t = makeDeferrer()
  t.call('c1')
  t.steer('这条不能丢')
  t.finish()   // 轮次被打断：结果从未到达
  assert.ok(t.written.includes('user:这条不能丢'), '轮次中断不该吃掉一条人说的话')
})

test('几条插话保持它们到达的先后', () => {
  const t = makeDeferrer()
  t.call('c1')
  t.steer('第一句'); t.steer('第二句')
  t.result('c1')
  assert.deepEqual(t.written.slice(-2), ['user:第一句', 'user:第二句'])
})

test('源码里 steering 不再当场 append，而是走 writeSteered', () => {
  const at = source.indexOf("ctx.on('agent/inbox/inserted'")
  assert.notEqual(at, -1, '找不到 steering 的入口')
  const block = source.slice(at, at + 4000)
  assert.equal(/try \{ agent\.session\.append\('user\/message'/.test(block), false,
    '当场 append 就会夹在 tool/call 和 tool/result 中间')
  assert.ok(block.indexOf('writeSteered(') !== -1, 'steering 要走延迟写')
})
