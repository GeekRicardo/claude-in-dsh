// 插件这一侧的 daemon 档：execOn / captureOn / daemonTail。
//
// cc-daemon.test.mjs 测的是 daemon 自己守不守约；这里测的是插件有没有把那份
// 约当回事——尤其是「没问出来」绝不能长得像「答案是空」。隧道不在这条测试线
// 上（那要一台真的 ssh 目标），所以 ensureDaemon 被换成一条指向本机真 daemon
// 的连接，其余全是真的：真 HTTP、真子进程、真文件。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { startDaemon } from '../src/cc-daemon.mjs'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const source = fs.readFileSync(path.join(root, 'src/host.dynamic.js'), 'utf8')
const temps = []

after(() => {
  for (const dir of temps) { try { fs.rmSync(dir, { recursive: true, force: true }) } catch (error) { /* best effort */ } }
})

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccd-hop-'))
  temps.push(dir)
  return dir
}

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

/** 把 daemon 档那几个函数切出来，接到一台真 daemon 上。 */
function build(daemon, options = {}) {
  const logged = []
  const closed = []
  const shelled = []
  const names = ['usesDaemon', 'daemonRequest', 'execOn', 'captureOn', 'daemonTail']
  const deps = {
    ensureDaemon: async (remote) => {
      if (options.unreachable === true) throw new Error('隧道起不来')
      return { base: 'http://127.0.0.1:' + daemon.port, token: daemon.token, proc: { done: Promise.resolve() } }
    },
    closeDaemon: (id) => { closed.push(id) },
    errorText: (error) => String(error && error.message ? error.message : error),
    armTimeout: (fn, ms) => { const h = setTimeout(fn, ms); return () => clearTimeout(h) },
    shellQuote: (value) => "'" + String(value).replace(/'/g, "'\\''") + "'",
    // daemon 档下这三个都不该被碰到；碰到了就是走错了路。
    // options.shell 打开时换成「记下来」，好测没有 daemon 的那条分支。
    shArgv: options.shell === true
      ? (command, remote) => ['/bin/sh', '-c', command]
      : () => { throw new Error('daemon 档不该再拼 shell argv') },
    runCapture: options.shell === true
      ? async (argv, timeoutMs) => { shelled.push({ argv: argv, timeoutMs: timeoutMs }); return 'from shell\n' }
      : () => { throw new Error('daemon 档不该再走 runCapture') },
    silenceStdin: (proc) => proc,
    subprocess: { spawn: () => { throw new Error('daemon 档不该再 spawn') } },
    console: { log: (...args) => logged.push(args.join(' ')), error: (...args) => logged.push(args.join(' ')) },
  }
  const keys = Object.keys(deps)
  const made = new Function(...keys, `${names.map(sliceFunction).join('\n')}\nreturn { ${names.join(', ')} }`)(
    ...keys.map((name) => deps[name]))
  return { ...made, logged: logged, closed: closed, shelled: shelled }
}

const REMOTE = { id: 'target', daemon: true }

async function boot() {
  return startDaemon({ stateDir: tempDir() })
}

test('daemon 档的目标不再拼任何 shell argv', async () => {
  const daemon = await boot()
  try {
    const rig = build(daemon)
    assert.equal(rig.usesDaemon(REMOTE), true)
    assert.equal(rig.usesDaemon({ id: 'plain' }), false)
    assert.equal(rig.usesDaemon(null), false)
    // rig 里的 shArgv/runCapture/spawn 都会抛；这一条能过就说明全程走的是 HTTP。
    const result = await rig.execOn('echo hi', REMOTE, 5000)
    assert.equal(result.decided, true)
    assert.equal(result.stdout, 'hi\n')
    assert.equal(result.code, 0)
  } finally { await daemon.close() }
})

test('execOn 把「跑完了」「超时了」「没问出来」分成三个答案', async () => {
  const daemon = await boot()
  try {
    const rig = build(daemon)

    const ran = await rig.execOn('true', REMOTE, 5000)
    assert.deepEqual(
      { decided: ran.decided, stdout: ran.stdout, timedOut: ran.timedOut },
      { decided: true, stdout: '', timedOut: false },
      '真的没输出：这是一个确定的答案',
    )

    const slow = await rig.execOn('sleep 5', REMOTE, 300)
    assert.equal(slow.decided, true, '超时是 daemon 给的答复，不是失联')
    assert.equal(slow.timedOut, true)
    assert.equal(slow.stdout, '', '输出同样是空——所以它必须靠 timedOut 区分')

    const lost = build(daemon, { unreachable: true })
    const nope = await lost.execOn('true', REMOTE, 5000)
    assert.equal(nope.decided, false, '连不上就是没问出来，绝不能算「答案是空」')
    assert.match(nope.reason, /隧道起不来/)
  } finally { await daemon.close() }
})

test('captureOn 仍然给回 stdout，但没问出来时会说出来', async () => {
  const daemon = await boot()
  try {
    const rig = build(daemon)
    assert.equal(await rig.captureOn('printf abc', REMOTE, 5000), 'abc')

    const quiet = await rig.captureOn('true', REMOTE, 5000)
    assert.equal(quiet, '')
    assert.equal(rig.logged.length, 0, '真的空不该有抱怨')

    const slow = await rig.captureOn('sleep 5', REMOTE, 300)
    assert.equal(slow, '', '四十处调用点写的是字符串，这里不改形状')
    assert.equal(rig.logged.some((line) => line.indexOf('超时') >= 0), true, '但它必须留下痕迹')

    const lost = build(daemon, { unreachable: true })
    assert.equal(await lost.captureOn('true', REMOTE, 5000), '')
    assert.equal(lost.logged.some((line) => line.indexOf('没问出来') >= 0), true)
  } finally { await daemon.close() }
})

test('execOn 带 stdin：插件就是这样把 broker 源码送过去的', async () => {
  const daemon = await boot()
  const dir = tempDir()
  try {
    const rig = build(daemon)
    const target = path.join(dir, 'broker.mjs')
    const result = await rig.execOn('cat > ' + JSON.stringify(target), REMOTE, 5000, { stdin: 'console.log(1)\n' })
    assert.equal(result.decided, true)
    assert.equal(result.code, 0)
    assert.equal(fs.readFileSync(target, 'utf8'), 'console.log(1)\n')
  } finally { await daemon.close() }
})

test('幂等键让「不知道发出去没有」的重发变成安全的', async () => {
  const daemon = await boot()
  const dir = tempDir()
  try {
    const rig = build(daemon)
    const fifoish = path.join(dir, 'in')
    const send = () => rig.execOn('cat >> ' + JSON.stringify(fifoish), REMOTE, 5000,
      { stdin: '{"prompt":"你好"}\n', idemKey: 'session-1:1:20' })
    const first = await send()
    const again = await send()
    assert.equal(first.duplicate, false)
    assert.equal(again.duplicate, true, '同一个键必须被认出来')
    assert.equal(fs.readFileSync(fifoish, 'utf8'), '{"prompt":"你好"}\n', 'prompt 只能进去一次')
  } finally { await daemon.close() }
})

test('daemonTail 吐的是解好码的文本，并跟着文件长', async () => {
  const daemon = await boot()
  const dir = tempDir()
  try {
    const rig = build(daemon)
    const log = path.join(dir, 'out.log')
    fs.writeFileSync(log, '{"type":"system"}\n')
    const link = { base: 'http://127.0.0.1:' + daemon.port, token: daemon.token }
    const reader = rig.daemonTail(link, log, 0)

    let text = ''
    const pump = (async () => {
      for await (const chunk of reader.stdout) {
        assert.equal(typeof chunk, 'string', 'pumpAttached 按字符串算偏移，给它 Uint8Array 会把长度算错')
        text += chunk
      }
    })()

    const deadline = Date.now() + 5000
    while (text.indexOf('system') < 0 && Date.now() < deadline) await new Promise((w) => setTimeout(w, 25))
    fs.appendFileSync(log, '{"type":"结果"}\n')
    while (text.indexOf('结果') < 0 && Date.now() < deadline) await new Promise((w) => setTimeout(w, 25))

    assert.equal(text, '{"type":"system"}\n{"type":"结果"}\n')
    reader.terminate()
    await pump
  } finally { await daemon.close() }
})

test('多字节字符跨 chunk 也不会被切坏', async () => {
  const daemon = await boot()
  const dir = tempDir()
  try {
    const rig = build(daemon)
    const log = path.join(dir, 'out.log')
    // 一行很长的中文：它一定会跨过 socket 的 chunk 边界。
    const line = '{"text":"' + '汉字'.repeat(40000) + '"}\n'
    fs.writeFileSync(log, line)
    const link = { base: 'http://127.0.0.1:' + daemon.port, token: daemon.token }
    const reader = rig.daemonTail(link, log, 0)
    let text = ''
    const pump = (async () => { for await (const chunk of reader.stdout) text += chunk })()
    const deadline = Date.now() + 8000
    while (text.length < line.length && Date.now() < deadline) await new Promise((w) => setTimeout(w, 25))
    reader.terminate()
    await pump
    assert.equal(text, line, '有一个字被切坏，这一行 JSON 就整条丢了')
    assert.equal(text.indexOf('�'), -1, '出现替换字符就说明解码是按 chunk 做的')
  } finally { await daemon.close() }
})

test('out.log 还不存在时，tail 说出来，而不是装作一条安静的流', async () => {
  const daemon = await boot()
  try {
    const rig = build(daemon)
    const link = { base: 'http://127.0.0.1:' + daemon.port, token: daemon.token }
    const reader = rig.daemonTail(link, '/no/such/out.log', 0)
    let text = ''
    for await (const chunk of reader.stdout) text += chunk
    assert.equal(text, '')
    assert.equal(rig.logged.some((line) => line.indexOf('404') >= 0), true, '一个事实，必须记下来')
  } finally { await daemon.close() }
})

test('连接断了要把这条链接丢掉，好让下一次重建', async () => {
  const daemon = await boot()
  const rig = build(daemon)
  await daemon.close()
  const result = await rig.execOn('echo hi', { id: 'target', daemon: true }, 3000)
  assert.equal(result.decided, false)
  assert.deepEqual(rig.closed, ['target'], '不丢掉的话，后面每一次都会撞在同一条死链接上')
})

// 这条不是假想的：把四十处调用点搬到 captureOn 的那次批量改写，把 execOn 自己
// 内部的 runCapture 也一起搬了，于是 captureOn → execOn → captureOn。dsh 在第一
// 轮对话之前就栈溢出，pm2 重启了二十二次。
test('没有 daemon 的目标仍然走一次 spawn，绝不能绕回 captureOn', async () => {
  const daemon = await boot()
  try {
    const rig = build(daemon, { shell: true })
    const plain = { id: 'plain' }

    const result = await rig.execOn('echo hi', plain, 7000)
    assert.equal(result.decided, true)
    assert.equal(result.stdout, 'from shell\n')
    assert.deepEqual(rig.shelled, [{ argv: ['/bin/sh', '-c', 'echo hi'], timeoutMs: 7000 }])

    // captureOn 建在 execOn 之上，所以这一条同样只能落到那一次 spawn 上。
    assert.equal(await rig.captureOn('echo hi', plain, 7000), 'from shell\n')
    assert.equal(rig.shelled.length, 2, '两次调用就是两次 spawn，不多不少')
  } finally { await daemon.close() }
})

// 这条是实测出来的血：幂等键曾经写成 `sessionId:deliverSeq:字节长度`，
// 而 deliverSeq 是 run 对象上的计数器——重新挂上一个活着的 Claude 会新建 run、
// 计数归零。权限回答是定长 JSON（{"behavior":"allow"} + 36 字符 request id），
// 于是第二个 run 的第二次写算出了和第一个 run 一模一样的键，daemon 认出「重复」、
// 返回缓存、根本没往 fifo 里写。Claude 就在那儿等一个已经批过的授权，工具永远
// 没跑，轮次一直转，哪儿都没有一行字说明原因。
test('两次不同的写入，即使内容一模一样，也必须是两次真写入', async () => {
  const daemon = await boot()
  const dir = tempDir()
  try {
    const rig = build(daemon)
    const fifoish = path.join(dir, 'in')
    // 权限回答的真实形状：同一个会话里，两次批准的字节数完全相同。
    const answer = (id) => JSON.stringify({
      type: 'control_response',
      response: { subtype: 'success', request_id: id, response: { behavior: 'allow' } },
    }) + '\n'
    const first = answer('a09f53da-2e10-4dd7-99c4-81f1b2ca5434')
    const second = answer('b17c64eb-3f21-5ee8-aa05-92c2d3ae6545')
    assert.equal(Buffer.byteLength(first), Buffer.byteLength(second), '前提：两条长度相同')

    const deliver = new Function('execOn', 'shellQuote', 'uuid', 'usesDaemon', 'BYTES',
      `${sliceFunction('deliverLineViaDaemon')}\nreturn deliverLineViaDaemon`)(
      rig.execOn,
      (v) => "'" + String(v).replace(/'/g, "'\\''") + "'",
      (() => { let n = 0; return () => 'id-' + (n += 1) })(),
      () => true,
      new TextEncoder(),
    )

    // 两个「不同的 run」——第二个的计数器从头开始，正是当初的现场。
    // （真实那一跳写的是 fifo，`cat >` 是追加；这里落在普通文件上是覆盖，
    // 所以判据是「第二条把第一条盖掉了」——它要是被当成重复吞掉，留下的会是第一条。）
    // 两个 run 都处在「刚写完 prompt，正要写第 2 条」的状态——这正是重挂之后
    // 的现场，也是旧键算出同一个值的唯一条件。
    await deliver({ sessionId: 's1', remote: REMOTE, dir: dir, deliverSeq: 1 }, first)
    assert.equal(fs.readFileSync(fifoish, 'utf8'), first, '第一条先写进去')

    await deliver({ sessionId: 's1', remote: REMOTE, dir: dir, deliverSeq: 1 }, second)
    assert.equal(fs.readFileSync(fifoish, 'utf8'), second, '第二条必须真的写进去，而不是被当成重复吞掉')
  } finally { await daemon.close() }
})
