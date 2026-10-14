// 隧道抖一下，这一轮就被判死了：「claude 的输出流在给出 result 之前结束了」，
// 而远端 broker 和 Claude 一切正常。那一轮剩下的输出没人读，接着轮次收尾发的
// /context 探测把它当成自己的回答吞掉（实测丢了两个工具调用和收尾总结）。
//
// 现在读取流断了、broker 确认活着，就在原地从最后一个完整行接着读。

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

function rig(answers, attachWorks) {
  const calls = { attached: [], waits: 0 }
  const deps = {
    REATTACH_TRIES: 3,
    REATTACH_GAP_MS: 1,
    shuttingDown: false,
    liveness: async () => answers.shift(),
    attach: async (run) => {
      calls.attached.push(run.offset)
      if (!attachWorks.shift()) { run.readerDead = true; run.queue.push(undefined) }
    },
    armTimeout: (fn) => { calls.waits += 1; setImmediate(fn); return () => {} },
    console: { log: () => {}, error: () => {} },
  }
  const reattachReader = new Function(...Object.keys(deps), slice('reattachReader') + '; return reattachReader')(...Object.values(deps))
  const run = { sessionId: 's', brokerPid: 7, remote: null, offset: 9000, consumed: 8800, readerDead: true, queue: [], closed: false }
  return { reattachReader, run, calls }
}

test('broker 活着：从最后一个完整行（consumed）接着读，不是从读到一半的 offset', async () => {
  const { reattachReader, run, calls } = rig(['yes'], [true])
  assert.equal(await reattachReader(run), true)
  assert.deepEqual(calls.attached, [8800])
  assert.equal(run.readerDead, false)
})

test('broker 确实没了：不重连，交给原来的失败处理', async () => {
  const { reattachReader, run, calls } = rig(['no'], [])
  assert.equal(await reattachReader(run), false)
  assert.deepEqual(calls.attached, [])
})

test('问不出 broker 死活：重试，不当成活着去挂', async () => {
  const { reattachReader, run, calls } = rig(['unknown', 'unknown', 'yes'], [true])
  assert.equal(await reattachReader(run), true)
  assert.deepEqual(calls.attached, [8800], '只在确认活着之后挂一次')
  assert.equal(calls.waits, 2)
})

test('重连本身失败：它留下的结束标记不算新消息，次数用完就放弃', async () => {
  const { reattachReader, run, calls } = rig(['yes', 'yes', 'yes'], [false, false, false])
  assert.equal(await reattachReader(run), false)
  assert.equal(calls.attached.length, 3)
  assert.deepEqual(run.queue, [], '每次失败的 attach 推进来的 undefined 都要收走')
})

test('轮次读取循环和轮次间读取器都先试重连，再走原来的收尾', () => {
  const turn = source.slice(source.indexOf('async function driveTurn('))
  assert.match(turn, /message === undefined && run\.readerDead === true && !interrupted && !signal\.aborted\s*\n\s*&& await reattachReader\(run\)\) continue/)
  assert.match(slice('startIdleDrain'), /message === undefined && run\.readerDead === true && run\.idleStop !== true\s*\n\s*&& await reattachReader\(run\)\) continue/)
})
