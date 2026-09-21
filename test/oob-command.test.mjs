// 带外命令（`/context`、`/mcp`…）是插件自己跟 Claude 说的话，不是这段对话的
// 内容。正常路径下命令循环吃掉自己的字节，并把 result 之后的偏移交给下一个
// 读取器；写超时或流断掉时它什么都交不出来，于是每条恢复路径都从命令**之前**
// 开始读 —— 真实后果是一张 `/context` 表格被当成 turn 4 的第一句话渲染进了对话。
//
// 这里跑的是真函数：按名字从源码里切出来，注入依赖单独求值。改名或删掉时响。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const source = fs.readFileSync(path.join(root, 'src/host.dynamic.js'), 'utf8')

/** 切出一个具名函数的完整源码，`async` 前缀一并带上。 */
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

/** 一段 out.log：每行一条 JSON，返回文本和「第一条 result 行结束」的字节位置。 */
function logOf(lines) {
  const text = lines.map((line) => JSON.stringify(line)).join('\n') + '\n'
  let bytes = 0
  for (const line of lines) {
    bytes += Buffer.byteLength(JSON.stringify(line)) + 1
    if (line.type === 'result') return { text: text, resultEndsAt: bytes }
  }
  return { text: text, resultEndsAt: -1 }
}

/**
 * `pastPendingCommand` 的运行环境。命令是真的通过 /bin/sh 跑的（tail | awk 的
 * 字节算术就是这个函数的全部内容），只有文件系统换成临时目录。
 */
function build(options) {
  const calls = { persisted: 0, logged: [], errors: [] }
  const state = options.state
  const deps = {
    stateOf: () => state,
    states: new Map([[options.sessionId || 's1', state]]),
    persistStates: () => { calls.persisted += 1 },
    sessionDir: () => options.dir,
    remoteOf: () => null,
    fileSize: async (file) => {
      try { return fs.statSync(file).size } catch (error) { return 0 }
    },
    shArgv: (command) => ['/bin/sh', '-c', command],
    shellQuote: (value) => "'" + String(value).replace(/'/g, "'\\''") + "'",
    runCapture: async (argv) => {
      const { execFileSync } = await import('node:child_process')
      return execFileSync(argv[0], argv.slice(1), { encoding: 'utf8' })
    },
    errorText: (error) => String(error && error.message ? error.message : error),
    console: {
      log: (...args) => { calls.logged.push(args.join(' ')) },
      error: (...args) => { calls.errors.push(args.join(' ')) },
    },
  }
  // captureOn 是插件里唯一的远端执行入口（命令串 + 目标 → stdout）。daemon 档
  // 下它走一条常驻连接，其余档下就是这里拼出来的 runCapture(shArgv(...))——
  // 断言的仍然是同一条命令串。
  deps.captureOn = (command, remote, timeoutMs) => deps.runCapture(deps.shArgv(command, remote), timeoutMs)
  const names = Object.keys(deps)
  const body = `${sliceFunction('pastPendingCommand')}\n${sliceFunction('endPendingCommand')}\n`
    + 'return { pastPendingCommand, endPendingCommand }'
  const made = new Function(...names, body)(...names.map((name) => deps[name]))
  return { ...made, calls: calls, state: state }
}

function tempDir() {
  return fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'ccmode-oob-'))
}

test('放弃的命令：跳到它自己那一轮的 result 之后', async () => {
  const dir = tempDir()
  // 标记之前是真正的对话，标记之后是插件问的 /context 和 Claude 的回答。
  const before = logOf([{ type: 'assistant', message: { content: [{ type: 'text', text: '好的' }] } }])
  const probe = logOf([
    { type: 'user', message: { content: [{ type: 'text', text: '/context' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: '## Context Usage\n中文也要按字节算' }] } },
    { type: 'result', result: '' },
    { type: 'assistant', message: { content: [{ type: 'text', text: '这行属于后面的轮次' }] } },
  ])
  fs.writeFileSync(path.join(dir, 'out.log'), before.text + probe.text)

  const from = Buffer.byteLength(before.text)
  const rig = build({
    dir: dir,
    state: { pendingCommand: { from: from, command: '/context', at: Date.now() } },
  })

  const at = await rig.pastPendingCommand('s1')
  assert.equal(at, from + probe.resultEndsAt, '恢复点应该正好落在探测那一轮的 result 之后')
  assert.equal(rig.state.pendingCommand, undefined, '标记用过就该清掉')
  assert.equal(rig.calls.persisted, 1)
})

test('那一轮还没跑完：不给恢复点，标记留着让下一个读取器再问', async () => {
  const dir = tempDir()
  const probe = logOf([
    { type: 'user', message: { content: [{ type: 'text', text: '/context' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: '## Context Usage' }] } },
  ])
  fs.writeFileSync(path.join(dir, 'out.log'), probe.text)

  const rig = build({
    dir: dir,
    state: { pendingCommand: { from: 0, command: '/context', at: Date.now() } },
  })

  assert.equal(await rig.pastPendingCommand('s1'), undefined)
  assert.notEqual(rig.state.pendingCommand, undefined, '还没结束的轮次不能把标记丢掉')
})

test('没有待处理的命令：不碰文件系统', async () => {
  const rig = build({ dir: '/nonexistent-on-purpose', state: {} })
  assert.equal(await rig.pastPendingCommand('s1'), undefined)
  assert.equal(rig.calls.persisted, 0)
})

test('日志比标记还短（重启换了日志）：丢掉过期标记', async () => {
  const dir = tempDir()
  fs.writeFileSync(path.join(dir, 'out.log'), '{}\n')
  const rig = build({
    dir: dir,
    state: { pendingCommand: { from: 999999, command: '/context', at: Date.now() } },
  })
  assert.equal(await rig.pastPendingCommand('s1'), undefined)
  assert.equal(rig.state.pendingCommand, undefined, '指向不存在的字节的标记只会误伤后面的轮次')
})

test('endPendingCommand 同时清掉运行期的开关和落盘的标记', () => {
  const state = { pendingCommand: { from: 10, command: '/context' } }
  const rig = build({ dir: '/tmp', state: state })
  const run = { sessionId: 's1', awaitingCommandResult: true }
  rig.endPendingCommand(run)
  assert.equal(run.awaitingCommandResult, false)
  assert.equal(state.pendingCommand, undefined)
})

// ── 接线：三条恢复路径都必须问过标记，泵必须能吞掉那一轮 ──
//
// 这几条是结构性的。上面的单元测试证明函数本身算得对，但真正的 bug 是「算对了
// 却没人调用」——2026-09-07 那次 `/context` 表格串进对话，就是因为恢复路径直接
// 用了旧偏移。

test('重新挂上活着的 Claude 时，偏移要越过被放弃的那一轮', () => {
  const attach = sliceFunction('ensureRun')
  assert.match(attach, /pastPendingCommand\(sessionId\)/,
    'ensureRun 的重挂分支不问标记，就会从探测之前开始读')
})

test('掉线期间的补投影也要越过被放弃的那一轮', () => {
  const drain = sliceFunction('drainDetachedOutput')
  assert.match(drain, /pastPendingCommand\(sessionId\)/,
    'drainDetachedOutput 不问标记，探测的回答就会被当成历史补进对话')
})

test('命令写进去之前先落标记，写失败就不留标记', () => {
  const oneShot = sliceFunction('runOneShotCommand')
  const markAt = oneShot.indexOf('pendingCommand = {')
  const writeAt = oneShot.indexOf('await run.write(')
  assert.notEqual(markAt, -1, '没有落标记，断流之后就没人知道那些字节是插件的')
  assert.ok(markAt < writeAt, '标记必须在写之前落，否则断在写和落之间就漏了')
  assert.match(oneShot, /commandWritten = true/, '写成功才认这个标记')
  assert.match(oneShot, /if \(commandWritten\)/,
    '没写进去的命令不该让后面的读取器吞掉一轮——那一轮是用户的')
})

test('泵在等一个被放弃的 result 时，把那一轮咽下去而不是交给读取器', () => {
  const pump = sliceFunction('pumpAttached')
  assert.match(pump, /awaitingCommandResult === true/,
    '泵不认这个开关，回答就会落进 run.queue，被下一轮当成自己的第一句话')
  const guard = pump.indexOf('awaitingCommandResult === true')
  const push = pump.indexOf('run.push(value)', guard)
  assert.ok(guard !== -1 && push !== -1 && guard < push, '开关必须挡在 run.push 前面')
  assert.match(pump.slice(guard, push), /endPendingCommand\(run\)/,
    '看见 result 就该松开，否则下一轮真的会被吃掉')
})

test('换了进程，欠着的那个命令回合要由新进程这边吞掉', () => {
  // 实测现场：一轮失败后插件重启了 Claude，而它自己发的 /context 还躺在
  // fifo 里没人答。新进程一起来就读到并回答了，可那条「我还欠一个回合」的
  // 标记挂在旧 run 上——新 run 不知道，于是把这个回合当成了用户的回答：页
  // 面上一张没人问过的「## Context Usage」表格，真正的回答被这一轮的
  // result 关在门外。连着两轮都是这样。
  const spawn = source.slice(source.indexOf('run.offset = priorLog'))
  const head = spawn.slice(0, spawn.indexOf('runs.set(sessionId, run)'))
  assert.match(head, /state\.pendingCommand\.written === true/,
    '只接手确实送出去过的命令——没送出去的回合不属于任何人')
  assert.match(head, /run\.awaitingCommandResult = true/, '新 run 要接手吞掉它')
  assert.match(head, /awaitingCommandUntil/, '要有时限，否则命令早被旧进程吃掉时会连用户的下一轮一起吞')
})

test('只有写成功的命令才算欠着一个回合', () => {
  const at = source.indexOf('marked.pendingCommand = {')
  assert.notEqual(at, -1)
  assert.match(source.slice(at, at + 400), /written: false/, '先记「打算写」')
  const after = source.slice(source.indexOf('commandWritten = true'))
  assert.match(after.slice(0, 300), /pendingCommand\.written = true/, '写成了才翻成 true')
})

test('接手的那次有时限，普通的吞噬没有', () => {
  const pump = source.slice(source.indexOf('if (run.awaitingCommandResult === true) {'))
  const body = pump.slice(0, pump.indexOf('run.push(value)'))
  assert.match(body, /typeof run\.awaitingCommandUntil === 'number'/,
    '时限只对跨进程接手的那次生效——正常的带外命令该等多久等多久')
  assert.match(body, /endPendingCommand\(run\)/)
})
