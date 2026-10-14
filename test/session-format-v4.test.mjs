// dsh 0.2 把会话日志升到格式 v4。写法上的差别 append 时不报错，要等下一次
// 读这份日志才炸——第二轮直接失败（"format v4 tool/result at seq N requires a
// tool-role message"），而且这个对话从此打不开。所以这里不等运行时，直接盯源码。

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
  let depth = 0
  for (let index = source.indexOf('{', start); index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    else if (source[index] === '}' && --depth === 0) return source.slice(start, index + 1)
  }
  throw new Error(`${name} 没有闭合`)
}

test('tool/result 一律是一等的 tool 角色消息，不再包 tool-result 块', () => {
  assert.doesNotMatch(source, /type: 'tool-result'/, 'v3 的包装块在 v4 里会让整份日志读不回来')
  const writes = source.match(/'tool\/result',?\s*\{[^]*?message:\s*([a-zA-Z]+)/g) || []
  assert.ok(writes.length >= 4, '找不到 tool/result 的写入点')
  for (const write of writes) assert.match(write, /message:\s*toolResultMessage$/, write.slice(0, 120))

  const toolResultMessage = new Function('uuid', sliceFunction('toolResultMessage') + '; return toolResultMessage')(() => 'id-1')
  assert.deepEqual(toolResultMessage('call-1', [{ type: 'text', text: 'ok' }], false), {
    id: 'id-1',
    role: 'tool',
    source: { kind: 'tool', callId: 'call-1' },
    toolCallId: 'call-1',
    content: [{ type: 'text', text: 'ok' }],
    isError: false,
  })
})

test('子代理的子调用用 ptc-dispatch 事件名，code-dispatch 已是退役语法', () => {
  assert.doesNotMatch(source, /'tool\/code-dispatch/)
  assert.match(source, /'tool\/ptc-dispatch-start'/)
  assert.match(source, /'tool\/ptc-dispatch'/)
})

test('消息来源不再写 { kind: "plugin", plugin }', () => {
  assert.doesNotMatch(source, /source: \{ kind: 'plugin',/)
})

test('运行时噪声的识别同时认 v4 的直接 kind、plugin: 前缀和 v3 的旧拼法', () => {
  const RUNTIME_NOISE = new Set(['user-approval', 'plan-mode', 'permission-presets', 'agent-instructions', 'skill-catalog'])
  const carriesRuntimeNoise = new Function('RUNTIME_NOISE', sliceFunction('carriesRuntimeNoise') + '; return carriesRuntimeNoise')(RUNTIME_NOISE)
  assert.equal(carriesRuntimeNoise({ source: { kind: 'user-approval' } }), true)
  assert.equal(carriesRuntimeNoise({ source: { kind: 'plugin:permission-presets' } }), true)
  assert.equal(carriesRuntimeNoise({ source: { kind: 'plugin', plugin: 'plan-mode' } }), true)
  assert.equal(carriesRuntimeNoise({ source: { kind: 'user' } }), false)
  assert.equal(carriesRuntimeNoise({ source: { kind: 'plugin:some-attachment' } }), false)
  assert.equal(carriesRuntimeNoise({}), false)
})
