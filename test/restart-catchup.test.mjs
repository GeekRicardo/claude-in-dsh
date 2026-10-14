// dsh 在一轮跑到一半时重启（实测：一轮 95 步、还没收到 result）：
//   * attach.json 只在 result 时写，这一轮一次都没写过；
//   * 重启后跟随从 out.log 末尾开始，重启到跟上之间 Claude 说的全丢；
//   * 而且只有有人打开这个对话才会去跟——放在后台的对话一直停在重启那一刻。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const source = fs.readFileSync(path.join(root, 'src/host.dynamic.js'), 'utf8')

function body(name) {
  const start = source.indexOf(`function ${name}(`)
  assert.notEqual(start, -1, `找不到 ${name}`)
  let depth = 0
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1)
  }
}

test('检查点合并而不丢：写的过程中又来的新位置，写完紧接着补写最新的', async () => {
  const writes = []
  let release
  const execOn = (cmd, remote, ms, opts) => {
    writes.push(JSON.parse(opts.stdin).offset)
    return new Promise((resolve) => { release = resolve })
  }
  const checkpointAt = new Function('execOn', 'shellQuote', body('checkpointAt') + '; return checkpointAt')(execOn, (v) => v)
  const run = { dir: '/d', remote: null }
  checkpointAt(run, 10)
  checkpointAt(run, 20)
  checkpointAt(run, 30)
  assert.deepEqual(writes, [10])
  release(); await new Promise((r) => setTimeout(r, 0))
  assert.deepEqual(writes, [10, 30], '中间的 20 可以跳过，最新的 30 必须写')
  release(); await new Promise((r) => setTimeout(r, 0))
  assert.equal(run.checkpointing, false)
  checkpointAt(run, undefined)
  assert.deepEqual(writes, [10, 30], '没有位置就不写')
})

test('轮内每写完一条顶层工具结果就记一次检查点', () => {
  const at = source.indexOf('transcript.toolResults(message.message || {})')
  const after = source.slice(at, at + 900)
  assert.match(after, /checkpointAt\(run, message\.ccmodeOffset\)/)
  assert.match(body('pumpAttached'), /if \(value\.type === 'user'\) value\.ccmodeOffset = run\.offset - BYTES\.encode\(buffer\)\.length/)
})

test('补录和跟随用同一个续读位置：没有检查点时都锚在 dsh 日志里最后一个调用上', () => {
  assert.match(body('drainDetachedOutput'), /await resumeOffsetOf\(session, dir, remote\)/)
  const follow = body('resumeIdleFollow')
  assert.match(follow, /await resumeOffsetOf\(session, dir, remote\)/)
  assert.doesNotMatch(follow, /readJsonFile\(dir \+ '\/attach\.json'/)
})

test('resumeOffsetOf：先检查点，再锚最后一个调用的结果行，都没有给 null', async () => {
  const calls = []
  const make = (attach, grepLine, bytes) => new Function('readJsonFile', 'sessionEvents', 'captureOn', 'shellQuote',
    'async ' + body('resumeOffsetOf') + '; return resumeOffsetOf')(
    async () => attach,
    (session) => session.events,
    async (cmd) => { calls.push(cmd); return cmd.startsWith('grep') ? grepLine : bytes },
    (v) => "'" + v + "'")
  const session = { events: [{ type: 'tool/call', data: { callId: 'toolu_A' } }, { type: 'tool/call', data: { callId: 'toolu_B' } }] }
  assert.equal(await make({ offset: 77 }, '', '')(session, '/d', null), 77)
  assert.equal(await make(null, '12\n', '4096\n')(session, '/d', null), 4096)
  assert.match(calls.find((c) => c.startsWith('grep')), /toolu_B/, '锚的是最后一个调用')
  assert.equal(await make(null, '', '')(session, '/d', null), null)
  assert.equal(await make(null, '12', '9')({ events: [] }, '/d', null), null, '日志里没有调用就没有锚')
})

test('启动后主动跟上还在干活的 Claude：在设置加载完之后，不等人打开', () => {
  assert.match(source, /loadPersistedStates\(\)\s*\n\s*\.then\(\(\) => armTimeout\(\(\) => \{ catchUpAfterRestart\(\)/)
  const catchUp = body('catchUpAfterRestart')
  assert.match(catchUp, /await drainDetachedOutput\(sessionId, session\)/)
  assert.match(catchUp, /await resumeIdleFollow\(sessionId, session\)/)
  assert.ok(catchUp.indexOf('drainDetachedOutput') < catchUp.indexOf('resumeIdleFollow'), '先补完整轮，再跟')
  assert.match(catchUp, /\.mode !== 'claude'\) continue/)
})
