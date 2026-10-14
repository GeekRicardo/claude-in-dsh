// 上下文窗口和面板明细不再靠往对话自己的 Claude 里发 /context 来问：Claude Code
// 把本地命令「作为后续消息的上下文」记下来，每次探测都把一张 ~5KB 的表格塞进
// 对话，此后每一轮都跟着请求一起发给模型（实测一个对话攒了 27 次、132KB）。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const source = fs.readFileSync(path.join(root, 'src/host.dynamic.js'), 'utf8')

function slice(name) {
  const start = source.indexOf(`function ${name}(`)
  assert.notEqual(start, -1, `找不到 ${name}`)
  const before = source.lastIndexOf('async ', start)
  const from = source.slice(before + 6, start).trim() === '' ? before : start
  let depth = 0
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}' && --depth === 0) return source.slice(from, i + 1)
  }
}

test('窗口大小取自 result.modelUsage，优先对话自己的模型', () => {
  const fromResult = new Function(slice('contextWindowFromResult') + '; return contextWindowFromResult')()
  const result = { modelUsage: {
    'claude-haiku-4-5': { contextWindow: 200000 },
    'claude-sonnet-5': { contextWindow: 1000000 },
  } }
  assert.equal(fromResult(result, { route: 'claude-sonnet-5', model: '' }), 1000000)
  assert.equal(fromResult(result, { route: '', model: 'claude-haiku-4-5' }), 200000)
  assert.equal(fromResult(result, { route: 'unknown', model: '' }), 1000000, '对不上名字时取最大的那个')
  assert.equal(fromResult({}, { route: 'x', model: '' }), 0)
})

// 重启后到下一轮之前，内存里的用量是空的，面板就退回 dsh 的盲猜（系统 0、工具 0）。
// 用量改成从日志读，和 dsh 自己的圆环同源。
test('上下文用量从日志里最近一条带 usage 的主线程消息读：输入 + 缓存读写 + 输出', () => {
  const sessionEvents = (session) => session.events
  const of = new Function('sessionEvents', slice('contextTokensOf') + '; return contextTokensOf')(sessionEvents)
  const events = [
    { type: 'assistant/message', data: { usage: { inputTokens: 1, cacheReadTokens: 10, outputTokens: 1 } } },
    { type: 'assistant/message', data: { usage: { inputTokens: 5, cacheReadTokens: 40000, cacheWriteTokens: 2000, outputTokens: 300 } } },
    { type: 'assistant/message', data: {} }, // 子代理镜像：不带 usage，不能盖掉主线程的
    { type: 'tool/result', data: {} },
  ]
  assert.equal(of({ events }), 42305)
  assert.equal(of({ events: [] }), 0)
})

test('面板明细不依赖内存里的 run：重启后第一轮之前也能算', () => {
  const handler = source.slice(source.indexOf("harness.handle('context.breakdown'"), source.indexOf("harness.handle('debug'"))
  assert.match(handler, /const total = contextTokensOf\(session\)/)
  assert.match(handler, /await remoteCwdOf\(state, remote\)/)
  assert.doesNotMatch(source, /contextTokens\.get|noteContextTokens/)
})

test('明细由一次性旁路进程测：不续接、不落盘、不碰对话', async () => {
  let command = ''
  const deps = {
    stateOf: () => ({ model: 'claude-sonnet-5' }),
    remoteOf: () => ({ id: 'worker', claudeBin: 'claude', ownModel: false }),
    subprocess: {},
    shellQuote: (value) => "'" + value + "'",
    captureOn: async (cmd) => { command = cmd; return JSON.stringify({ result: '## Context Usage\n### Estimated usage by category\n| Category | Tokens | % |\n|---|---|---|\n| System prompt | 8.9k | 1% |\n| System tools | 10.2k | 1% |\n| MCP tools (deferred) | 16.2k | 2% |\n| Messages | 8 | 0% |\n' }) },
    parseContextReport: (text) => (/System prompt/.test(text) ? { system: 8900, tools: 10200, messages: 8 } : undefined),
    compositions: new Map(),
    compositionProbes: new Map(),
    COMPOSITION_TTL_MS: 600000,
    console: { error: () => {} },
  }
  const probe = new Function(...Object.keys(deps), slice('probeComposition') + '; return probeComposition')(...Object.values(deps))
  const measured = await probe('s', '/home/ricardo/cc-soak')
  assert.equal(measured.system, 8900)
  assert.equal(measured.tools, 10200)
  assert.match(command, /'--no-session-persistence' '\/context'/)
  assert.doesNotMatch(command, /--resume|--session-id|--input-format/, '不能挂到对话自己的会话上')
  // 缓存：同一模型和目录十分钟内不再起进程。
  command = ''
  await probe('s', '/home/ricardo/cc-soak')
  assert.equal(command, '')
})

test('面板接口：消息 = 实际总量 − 系统 − 工具', () => {
  const handler = source.slice(source.indexOf("harness.handle('context.breakdown'"), source.indexOf("harness.handle('context.breakdown'") + 1400)
  assert.match(handler, /messageTokens: Math\.max\(0, total - composition\.system - composition\.tools\)/)
  assert.doesNotMatch(handler, /runCommandForPlugin|probeContextWindow/)
})

test('自动压缩预留的空间不算系统提示词', () => {
  const parse = new Function(slice('tokensOf') + slice('parseContextReport') + '; return parseContextReport')()
  const report = parse(['### Estimated usage by category', '| Category | Tokens | Percentage |', '|---|---|---|',
    '| System prompt | 8.9k | 0.9% |', '| System tools | 10.2k | 1.0% |', '| MCP tools (deferred) | 16.2k | 1.6% |',
    '| Memory files | 944 | 0.1% |', '| Skills | 5.4k | 0.5% |', '| Messages | 8 | 0.0% |',
    '| Free space | 941.6k | 94.2% |', '| Autocompact buffer | 33k | 3.3% |'].join('\n'))
  assert.equal(report.system, 8900 + 944 + 5400)
  assert.equal(report.tools, 10200)
})
