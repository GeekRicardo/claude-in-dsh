// 终端侧同步：一个对话在 dsh 里开着，之后被 `claude --resume <uuid>` 在终端
// 接着聊——两边写的是同一个 transcript 文件。镜像本来就实现了，但它第一道门
// 是 `typeof state.jsonlOffset !== 'number'`，而那个游标**只有导入来的对话**
// 才有（导入时记下文件大小）。于是在 dsh 里原生建的对话永远不同步，而且没有
// 任何手动入口。
//
// 游标也不能凭空造：从 0 开始会把 dsh 自己渲染过的历史整个重投一遍，从文件
// 末尾开始又恰好丢掉要同步的那段终端输出。所以 bootstrap 这条路读尾部、按
// 「tool call id 或正文已经在 dsh 日志里」去重，然后把游标落在文件末尾——
// 之后这个对话就走和导入对话一样的增量路径了。
//
// 这几个函数住在引擎体闭包里，照 quota-wait 的做法按名字切出源码单独求值。

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

const row = (type, content, extra) => JSON.stringify({
  type: type, message: { role: type, content: content }, ...(extra || {}),
})

function build(overrides) {
  const calls = { projected: [], persisted: 0, reads: [] }
  const state = {
    mode: 'claude', claudeSessionId: 'abc-123',
    ...(overrides && overrides.state ? overrides.state : {}),
  }
  const file = (overrides && overrides.file !== undefined) ? overrides.file : ''
  const bytes = Buffer.byteLength(file, 'utf8')
  const deps = {
    syncInFlight: new Map(),
    activeTurns: overrides && overrides.activeTurns ? overrides.activeTurns : new Map(),
    stateOf: () => state,
    projectCwd: () => (overrides && overrides.cwd !== undefined ? overrides.cwd : '/work/zx'),
    projectSlug: (cwd) => String(cwd).replace(/\//g, '-'),
    shellQuote: (value) => "'" + String(value) + "'",
    remoteOf: () => null,
    fileSizeOfShellWord: async () => bytes,
    captureOn: async (command) => {
      calls.reads.push(command)
      // `tail -c +N` is 1-based on bytes.
      const match = /tail -c \+(\d+)/.exec(command)
      const from = match === null ? 1 : Number(match[1])
      return Buffer.from(file, 'utf8').slice(from - 1).toString('utf8')
    },
    BYTES: { encode: (text) => Buffer.from(text, 'utf8') },
    machineryRow: (event) => event.isMeta === true || event.isSynthetic === true,
    sessionEvents: () => (overrides && overrides.events ? overrides.events : []),
    queueProjection: (sessionId, rows) => { calls.projected.push(...rows); return rows.length },
    persistStates: () => { calls.persisted += 1 },
    errorText: (error) => String(error && error.message ? error.message : error),
    console: { log: () => {}, error: () => {} },
    SYNC_BOOTSTRAP_TAIL: 2000000,
  }
  const names = ['renderedTexts', 'syncTranscript', 'syncImportedTranscript']
  const made = new Function('deps', `
    const { ${Object.keys(deps).join(', ')} } = deps
    ${names.map(sliceFunction).join('\n')}
    return { ${names.join(', ')} }
  `)(deps)
  return { ...made, state: state, calls: calls, bytes: bytes }
}

const session = { id: 'session-main' }

test('没有游标时，自动那条路什么都不做——不去扫文件尾', async () => {
  const rig = build({ file: row('assistant', [{ type: 'text', text: '终端说的话' }]) + '\n' })
  const result = await rig.syncImportedTranscript('s1', session)
  assert.equal(result.reason, 'no-cursor', '原生对话每次被打开都去读 transcript 尾部是另一个 bug')
  assert.deepEqual(rig.calls.reads, [], '它连文件都不该读')
  assert.equal(rig.calls.projected.length, 0)
})

test('手动 bootstrap 会把终端那边的新消息补进来，并把游标留在文件末尾', async () => {
  const file = row('assistant', [{ type: 'text', text: '终端说的话' }]) + '\n'
  const rig = build({ file: file })
  const result = await rig.syncTranscript('s1', session, true)
  assert.equal(result.written, 1)
  assert.equal(result.bootstrapped, true)
  assert.equal(rig.state.jsonlOffset, rig.bytes, '游标要落在文件末尾，下一轮才能走增量')
  assert.equal(rig.calls.projected.length, 1)
})

test('bootstrap 不会把 dsh 自己已经渲染过的正文再投一遍', async () => {
  // 尾部里既有这一侧说过的话，也有终端新说的。只有后者该进来。
  const file = row('assistant', [{ type: 'text', text: '这句 dsh 已经显示过了' }]) + '\n'
    + row('assistant', [{ type: 'text', text: '这句只有终端有' }]) + '\n'
  const rig = build({
    file: file,
    events: [{
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: '这句 dsh 已经显示过了' }] } },
    }],
  })
  const result = await rig.syncTranscript('s1', session, true)
  assert.equal(result.written, 1, '重复的那条必须被认出来')
  const texts = rig.calls.projected.map((event) => event.message.content[0].text)
  assert.deepEqual(texts, ['这句只有终端有'])
})

test('bootstrap 也认 tool call id——只说过话的轮次靠正文，调过工具的靠 id', async () => {
  const file = row('assistant', [{ type: 'tool_use', id: 'toolu_01', name: 'Bash', input: {} }]) + '\n'
    + row('user', [{ type: 'tool_result', tool_use_id: 'toolu_01', content: 'ok' }]) + '\n'
    + row('assistant', [{ type: 'tool_use', id: 'toolu_02', name: 'Bash', input: {} }]) + '\n'
  const rig = build({
    file: file,
    events: [{ type: 'tool/call', data: { callId: 'toolu_01' } }],
  })
  const result = await rig.syncTranscript('s1', session, true)
  assert.equal(result.written, 1, 'toolu_01 的两行都该跳过，只剩 toolu_02')
  assert.equal(rig.calls.projected[0].message.content[0].id, 'toolu_02')
})

test('有游标时走增量：只读游标之后，游标按消费的字节前进', async () => {
  const head = row('assistant', [{ type: 'text', text: '旧的' }]) + '\n'
  const tail = row('assistant', [{ type: 'text', text: '新的' }]) + '\n'
  const rig = build({ file: head + tail, state: { jsonlOffset: Buffer.byteLength(head, 'utf8') } })
  const result = await rig.syncTranscript('s1', session, false)
  assert.equal(result.written, 1)
  assert.equal(result.bootstrapped, false)
  assert.equal(rig.state.jsonlOffset, rig.bytes)
  const texts = rig.calls.projected.map((event) => event.message.content[0].text)
  assert.deepEqual(texts, ['新的'], '游标之前的内容不该再出现')
})

test('正在跑一轮时不同步，并且说得出原因', async () => {
  const rig = build({
    file: row('assistant', [{ type: 'text', text: 'x' }]) + '\n',
    activeTurns: new Map([['s1', {}]]),
  })
  const result = await rig.syncTranscript('s1', session, true)
  assert.equal(result.reason, 'turn-running')
  assert.equal(result.written, 0)
})

test('同步的理由都在客户端有话可说', () => {
  const client = fs.readFileSync(path.join(root, 'src/client.dynamic.js'), 'utf8')
  const start = client.indexOf('const SYNC_REASONS = {')
  assert.ok(start > 0, 'SYNC_REASONS 不见了')
  const spoken = new Set()
  const block = client.slice(start, client.indexOf('}', start))
  for (const match of block.matchAll(/^\s*'?([a-z-]+)'?:/gm)) spoken.add(match[1])
  // host 侧每个「写了 0 条」的理由，菜单里都该有一句人话；mirrored / up-to-date
  // / already-rendered / nothing-to-mirror 走「没有新消息」那条兜底。
  for (const reason of ['turn-running', 'not-claude', 'no-claude-session', 'no-transcript', 'no-cwd']) {
    assert.ok(spoken.has(reason), reason + ' 在菜单里没有对应的说法')
    assert.ok(source.includes("'" + reason + "'"), reason + ' 在 host 侧并不存在')
  }
})
