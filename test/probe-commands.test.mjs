// 导入一段对话时，冒出来一条谁也没发过的 `/context`。
//
// 那是插件自己发的：probeContextWindow 每次启动、每次换模型都用 /context 去问
// 上下文窗口有多大，走的是带外通道，人从来没敲过。但 Claude Code 把它当成普通
// 用户消息写进了 transcript，于是导入时它作为「用户说的话」出现，后面还跟着一张
// 上下文表格。实时链路上插件靠 awaitingCommandResult 把整个回合吞掉，transcript
// 里没有那个标记。
//
// 现场：session 3a9c1aa9 的 transcript 第 33 行，type=user，内容就是
// <command-name>/context</command-name>。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const source = fs.readFileSync(path.join(root, 'src/host.dynamic.js'), 'utf8')

function sliceFunction(name) {
  const start = source.indexOf(`function ${name}(`)
  assert.notEqual(start, -1, `找不到 ${name}`)
  const before = source.lastIndexOf('async ', start)
  const from = before !== -1 && source.slice(before + 'async '.length, start).trim() === '' ? before : start
  let depth = 0
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') { depth -= 1; if (depth === 0) return source.slice(from, i + 1) }
  }
  throw new Error(name)
}

/** transcript 里那条探测命令的真实形状。 */
function probeCommand(name) {
  return {
    type: 'user',
    message: { role: 'user', content: '<command-name>' + name + '</command-name>\n'
      + '            <command-message>' + name.slice(1) + '</command-message>\n'
      + '            <command-args></command-args>' },
  }
}
const said = (text) => ({ type: 'user', message: { role: 'user', content: text } })
const replied = (text) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: text }] } })

/** 把 projectClaudeEvents 接到一个只记账的假 session 上。 */
function project(rows) {
  const appended = []
  const session = {
    append: (type, data) => { appended.push({ type, data }); return { seq: appended.length } },
  }
  const deps = {
    sessionEvents: () => [],
    SURFACE_EVENT_TYPES: new Set(['user/message', 'assistant/message', 'tool/result']),
    PROBE_COMMANDS: new Set(['/context', '/mcp']),
    PROVIDER: 'claude-code',
    NOTICE_MODEL: 'cc-mode/notice',
    uuid: (() => { let n = 0; return () => 'id-' + (n += 1) })(),
    assistantBlocksOf: (content) => (Array.isArray(content) ? content : [])
      .filter((b) => b && b.type === 'text')
      .map((b) => ({ type: 'text', text: b.text })),
    resultBlocksOf: () => [],
    clampValue: (v) => v,
  }
  const names = Object.keys(deps)
  const run = new Function(...names, `${sliceFunction('projectClaudeEvents')}\nreturn projectClaudeEvents`)(
    ...names.map((n) => deps[n]))
  run(session, rows, '', 1)
  return appended
}

// user/message 的 data 本身就是那条消息；assistant/message 多一层 message。
const textsOf = (events, type) => events.filter((e) => e.type === type)
  .map((e) => {
    const message = e.data.message === undefined ? e.data : e.data.message
    return ((message && message.content) || []).map((b) => b.text).join('')
  })

test('插件自己发的 /context 不出现在导入的对话里', () => {
  const events = project([said('先看看这个仓库'), probeCommand('/context'), replied('上下文表格…'), replied('好的老大')])
  const users = textsOf(events, 'user/message')
  assert.deepEqual(users, ['先看看这个仓库'], '谁也没发过 /context')
  assert.equal(users.some((t) => t.indexOf('/context') !== -1), false)
})

test('它的回答同样不进去——否则就是一张没人问过的表格', () => {
  const events = project([said('先看看这个仓库'), probeCommand('/context'), replied('上下文表格…'), replied('好的老大')])
  const assistants = textsOf(events, 'assistant/message')
  assert.equal(assistants.includes('上下文表格…'), false, '探测命令的回答不是对话')
  assert.equal(assistants.includes('好的老大'), true, '真正的回答要留着')
})

test('下一条真消息就翻篇，后面的回答照常留下', () => {
  const events = project([probeCommand('/context'), replied('表格'), said('接着说'), replied('好的')])
  assert.deepEqual(textsOf(events, 'user/message'), ['接着说'])
  assert.deepEqual(textsOf(events, 'assistant/message'), ['好的'])
})

test('/mcp 同样处理', () => {
  const events = project([probeCommand('/mcp'), replied('服务器列表'), said('继续'), replied('嗯')])
  assert.deepEqual(textsOf(events, 'user/message'), ['继续'])
  assert.equal(textsOf(events, 'assistant/message').includes('服务器列表'), false)
})

test('带语义的命令留着——它解释了后面为什么变了', () => {
  const events = project([probeCommand('/compact'), replied('已压缩'), said('继续')])
  const users = textsOf(events, 'user/message')
  assert.ok(users.includes('/compact'), '/compact 是人敲的，且改变了对话状态')
  assert.ok(textsOf(events, 'assistant/message').includes('已压缩'), '它的回答也留着')
})

test('预览和投影用同一份名单', () => {
  const preview = sliceFunction('previewClaudeConversation')
  assert.ok(preview.indexOf('PROBE_COMMANDS') !== -1,
    '预览要是不过滤，人就是照着一份和导入结果不一样的东西做决定')
})
