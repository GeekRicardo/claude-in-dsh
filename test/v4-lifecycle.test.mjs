// dsh 0.2 的会话格式 v4 在「下一次加载」时才校验生命周期，写错的那一刻毫无
// 动静；等发现时，要么日志被截掉一截，要么整个对话打不开。所以这里把插件
// 真正的写入路径（createTranscript、projectClaudeEvents，从源码按名字切出来）
// 跑一遍，写出的事件交给一个照 dsh relationships 规则写的检查器。
//
// 检查器只覆盖插件会碰到的那部分规则（dsh-session-format-v3-to-v4 的
// relationships / tool-role 两节）：
//   * turn/start 打开的必须是下一轮；turn/end 时不能有打开的步、不能有悬着的调用
//   * step/start 必须是本轮的下一个步号，且前一步已经关了
//   * assistant/message、tool/call、tool/result 必须落在打开的步里
//   * tool/result 必须结掉一个声明过、还没结的调用，消息是 tool 角色
//   * request/context、request/header 必须在打开的轮次里

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { v4Session } from './helpers/v4-checker.mjs'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const source = fs.readFileSync(path.join(root, 'src/host.dynamic.js'), 'utf8')

function slice(name) {
  const start = source.indexOf(`function ${name}(`)
  assert.notEqual(start, -1, `找不到 ${name}`)
  let depth = 0
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1)
  }
}

const deps = {
  PROVIDER: 'claude-code',
  NOTICE_MODEL: 'notice',
  PROBE_COMMANDS: new Set(['/context']),
  SURFACE_EVENT_TYPES: new Set(['user/message', 'assistant/message', 'tool/result']),
  DSH_TOOL_NAMES: {},
  ARG_RENAMES: {},
  console: { log: () => {}, error: () => {} },
  errorText: String,
}
const names = ['createTranscript', 'projectClaudeEvents', 'stepForAssistant', 'appendChunk', 'runKindOf', 'runMemberOf',
  'extendsRun', 'blockTypeOf', 'finishedBlock', 'assistantBlocksOf', 'tokenUsageOf', 'resultBlocksOf',
  'toolResultMessage', 'uuid', 'dshToolName', 'dshToolArgs', 'lastStepOf', 'sessionEvents', 'machineryRow',
  'settledCallIds']
const { createTranscript, projectClaudeEvents } = new Function(...Object.keys(deps),
  names.map(slice).join('\n') + '\nreturn { createTranscript, projectClaudeEvents }')(...Object.values(deps))

/** 一条 Claude 消息，按实时流的样子喂给转录：先流，再落成。 */
function speak(transcript, content) {
  transcript.streamEvent({ type: 'message_start' })
  content.forEach((block, index) => {
    const type = block.type === 'tool_use' ? 'tool_use' : 'text'
    transcript.streamEvent({ type: 'content_block_start', index, content_block: { type, id: block.id, name: block.name } })
    if (type === 'text') transcript.streamEvent({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } })
    transcript.streamEvent({ type: 'content_block_stop', index })
  })
  return transcript.assistantMessage({ content, model: 'claude-opus-5' })
}
const tool = (id) => ({ type: 'tool_use', id, name: 'Bash', input: { command: 'true' } })
const result = (id) => ({ content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] })

test('一轮实时转录：并行调用的结果在下一步才回来，照样合规', () => {
  const session = v4Session()
  const turn = session.open()
  const transcript = createTranscript(session, turn)
  speak(transcript, [{ type: 'text', text: '先看两处' }, tool('a'), tool('b')])
  transcript.toolResults(result('a'))
  speak(transcript, [tool('c')]) // b 还没回来，Claude 已经开了下一条消息
  transcript.toolResults(result('b'))
  transcript.toolResults(result('c'))
  speak(transcript, [{ type: 'text', text: '好了' }])
  transcript.finish()
  session.close()
})

test('同一轮里先补录、再实时：步号接着往下数，不从 1 重来', () => {
  // 实测 session-50f28b0c turn 14/15：补录写了 1..3 步，实时转录又从 1 开始。
  const session = v4Session()
  const turn = session.open()
  projectClaudeEvents(session, [
    { type: 'assistant', message: { content: [tool('p1')] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'p1', content: 'x' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: '补录的那一轮说完了' }] } },
  ], '（补录）', turn)
  const transcript = createTranscript(session, turn)
  speak(transcript, [{ type: 'text', text: '这一轮自己的回答' }])
  transcript.finish()
  session.close()
})

test('补录从半轮中间开始：找不到调用的结果不写成 tool/result', () => {
  const session = v4Session()
  const turn = session.open()
  const written = projectClaudeEvents(session, [
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'lost', content: 'WOKE-DONE 03:32:41' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: '都完成了' }] } },
  ], '', turn)
  assert.equal(written, 2, '输出不能丢，只是换个写法')
  assert.ok(session.events.some((event) => event.type === 'assistant/message'
    && event.data.message.content[0].text.includes('WOKE-DONE 03:32:41')))
  assert.equal(session.events.some((event) => event.type === 'tool/result'), false)
  session.close()
})

test('轮次被打断：没回来的调用补一个中断结果，收尾合规', () => {
  const session = v4Session()
  const turn = session.open()
  const transcript = createTranscript(session, turn)
  speak(transcript, [tool('slow')])
  transcript.finish('interrupted')
  session.close()
})

test('补录收尾：自己开了却没等到结果的调用，中断结果也写在打开的步里', () => {
  const session = v4Session()
  const turn = session.open()
  projectClaudeEvents(session, [{ type: 'assistant', message: { content: [tool('carry')] } }], '', turn)
  assert.equal(session.events.findLast((event) => event.type === 'tool/result').data.message.isError, true)
  session.close()
})

test('并行调用：CLI 把一条消息拆成多条事件（同一个 id），结果在 message_stop 之后——全在一步里', () => {
  // 实测 session-0df6d7d2「学玩模式」：两个并行调用分进了两步，第一步带着没结的调用关掉。
  const session = v4Session()
  const turn = session.open()
  const transcript = createTranscript(session, turn)
  transcript.streamEvent({ type: 'message_start' })
  transcript.assistantMessage({ id: 'msg_1', content: [{ type: 'text', text: '先看两处' }], model: 'm' })
  transcript.assistantMessage({ id: 'msg_1', content: [tool('p1')], model: 'm' })
  transcript.assistantMessage({ id: 'msg_1', content: [tool('p2')], model: 'm' })
  transcript.streamEvent({ type: 'message_stop' })
  transcript.toolResults(result('p1'))
  transcript.toolResults(result('p2'))
  transcript.streamEvent({ type: 'message_start' })
  transcript.assistantMessage({ id: 'msg_2', content: [{ type: 'text', text: '好了' }], model: 'm' })
  transcript.streamEvent({ type: 'message_stop' })
  transcript.finish()
  session.close()
  const messages = session.events.filter((event) => event.type === 'assistant/message')
  assert.equal(messages.length, 2, '一条 API 消息落成一条 assistant/message')
  assert.equal(messages[0].data.message.content.filter((block) => block.type === 'tool-call').length, 2)
})

test('没有流事件时（只有 assistant 事件）：换了 id、来了结果、收尾，都会把攒着的那条落下', () => {
  const session = v4Session()
  const turn = session.open()
  const transcript = createTranscript(session, turn)
  transcript.assistantMessage({ id: 'a', content: [tool('x1')], model: 'm' })
  transcript.assistantMessage({ id: 'a', content: [tool('x2')], model: 'm' })
  transcript.toolResults(result('x1'))
  transcript.toolResults(result('x2'))
  transcript.assistantMessage({ id: 'b', content: [{ type: 'text', text: '收尾' }], model: 'm' })
  transcript.finish()
  session.close()
  assert.equal(session.events.filter((event) => event.type === 'assistant/message').length, 2)
})

// 实测 session-e6f07687（导入的对话）：Claude 的记录一个内容块一行，并行的两个
// 调用是两行、同一个 message.id。补录每行开一步，第 100 步带着没结果的调用
// 关掉了，dsh 下次加载：step/end leaves unresolved tool call，整个对话打不开。
test('补录：同一条消息拆成多行的并行调用，合成一步写', () => {
  const session = v4Session()
  const turn = session.open()
  projectClaudeEvents(session, [
    { type: 'assistant', message: { id: 'msg_1', content: [{ type: 'text', text: '两处一起看' }] } },
    { type: 'assistant', message: { id: 'msg_1', content: [tool('A')] } },
    { type: 'assistant', message: { id: 'msg_1', content: [tool('B')] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'A', content: 'a' }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'B', content: 'b' }] } },
    { type: 'assistant', message: { id: 'msg_2', content: [tool('C')] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'C', content: 'c' }] } },
    { type: 'assistant', message: { id: 'msg_3', content: [{ type: 'text', text: '好了' }] } },
  ], '', turn)
  const messages = session.events.filter((event) => event.type === 'assistant/message')
  assert.equal(messages.length, 3, '三条 API 消息，三步')
  assert.deepEqual(messages[0].data.message.content.map((block) => block.type), ['text', 'tool-call', 'tool-call'])
  const steps = new Set(session.events.filter((event) => event.type === 'tool/call' && ['A', 'B'].includes(event.data.callId)).map((event) => event.data.step))
  assert.equal(steps.size, 1)
  session.close()
})
