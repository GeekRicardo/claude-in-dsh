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

// ---- 下面驱动的是真正的 createTranscript（按名字从源码切出来），不是复刻品。

function realTranscript() {
  const slice = (name) => {
    const start = source.indexOf(`function ${name}(`)
    assert.notEqual(start, -1, `找不到 ${name}`)
    let depth = 0
    for (let i = source.indexOf('{', start); i < source.length; i += 1) {
      if (source[i] === '{') depth += 1
      else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1)
    }
  }
  const names = ['createTranscript', 'stepForAssistant', 'appendChunk', 'runKindOf', 'runMemberOf', 'extendsRun',
    'blockTypeOf', 'finishedBlock', 'assistantBlocksOf', 'tokenUsageOf', 'resultBlocksOf', 'toolResultMessage',
    'uuid', 'dshToolName', 'dshToolArgs', 'lastStepOf', 'sessionEvents', 'settledCallIds']
  // flushAssistant lives inside createTranscript, so it comes along.
  const events = []
  const session = { append: (type) => events.push(type), snapshotEvents: () => [] }
  const make = new Function('PROVIDER', 'console', 'errorText', 'DSH_TOOL_NAMES', 'ARG_RENAMES',
    names.map(slice).join('\n') + '\nreturn createTranscript')
  const transcript = make('claude-code', console, String, {}, {})(session, 1)
  const text = (value) => {
    transcript.streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text' } })
    transcript.streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: value } })
  }
  return { transcript, events, text }
}

test('正文流到一半时插话：插话排在这段正文之后，而不是跑到它上面', () => {
  // 实测：一篇 2500 字的回答写到一半来了一句插话，转录里插话排在整篇回答上面。
  const { transcript, events, text } = realTranscript()
  transcript.streamEvent({ type: 'message_start' })
  text('长连接系统里')
  transcript.deferUserMessage(() => events.push('user/message'))
  assert.equal(events.includes('user/message'), false, '这段正文还没落成，插话不能先写')
  transcript.streamEvent({ type: 'content_block_stop', index: 0 })
  transcript.assistantMessage({ content: [{ type: 'text', text: '长连接系统里……' }], model: 'm' })
  assert.equal(events.includes('user/message'), false, '消息还没收尾（message_stop 之前），插话继续等')
  transcript.streamEvent({ type: 'message_stop' })
  const at = events.indexOf('assistant/message')
  assert.ok(at !== -1 && events.indexOf('user/message') > at, events.join(' '))
})

test('正文落成时还带着工具调用：插话继续等到结果配对齐', () => {
  const { transcript, events, text } = realTranscript()
  transcript.streamEvent({ type: 'message_start' })
  text('先看一下')
  transcript.deferUserMessage(() => events.push('user/message'))
  transcript.assistantMessage({ content: [{ type: 'text', text: '先看一下' }, { type: 'tool_use', id: 'c1', name: 'Bash', input: {} }], model: 'm' })
  assert.equal(events.includes('user/message'), false, '调用还没结果')
  transcript.toolResults({ content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'ok' }] })
  assert.ok(events.indexOf('user/message') > events.indexOf('tool/result'), events.join(' '))
})

test('正文永远没落成（被打断）：收尾时插话照样补上', () => {
  const { transcript, events, text } = realTranscript()
  transcript.streamEvent({ type: 'message_start' })
  text('写到一半')
  transcript.deferUserMessage(() => events.push('user/message'))
  transcript.finish()
  assert.ok(events.includes('user/message'), '吃掉一条人说的话比顺序难看严重得多')
})
