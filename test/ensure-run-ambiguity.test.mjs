// dsh 关闭的那一刻，一轮的收尾逻辑（它的 /context 探测）照常调了 ensureRun。
// 隧道正在关，meta.json 读回来是空——插件把「没答复」当成「没有 broker」，在
// 一个还在跑着的对话上又起了一个 Claude：两个 broker 共用一个 fifo、一个
// out.log，还 --resume 同一个 Claude 会话（session-a9525d7b 实测）。
//
// ensureRun 是唯一会杀进程、起进程的地方，它的每个「没有」都必须是问出来的。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const source = fs.readFileSync(path.join(root, 'src/host.dynamic.js'), 'utf8')

function body(name) {
  const start = source.indexOf(`function ${name}(`)
  assert.notEqual(start, -1)
  let depth = 0
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1)
  }
}

const ensureRun = body('ensureRun')

test('插件停止期间 ensureRun 什么都不启动', () => {
  const guard = ensureRun.indexOf('if (shuttingDown) throw')
  assert.notEqual(guard, -1)
  assert.ok(guard < ensureRun.indexOf('stateOf(sessionId)'), '必须是第一件事')
})

test('meta.json 读不回来时，要问清「确实不存在」才往下走', () => {
  const read = ensureRun.indexOf("readJsonFile(dir + '/meta.json'")
  const ask = ensureRun.indexOf("fileExistsOfShellWord(shellQuote(dir + '/meta.json')")
  const launch = ensureRun.indexOf('Nothing usable is running')
  assert.ok(read !== -1 && ask > read && ask < launch)
  assert.match(ensureRun.slice(ask, ask + 200), /meta === null && present !== 'no'/)
  // 问不出来先等链路恢复再问，次数用完才放弃这一轮。
  assert.match(ensureRun, /if \(attempt >= LINK_RETRY_WAITS_MS\.length \|\| shuttingDown\) \{\s*\n\s*throw/)
})

test('broker 活不活也是三态：unknown 不进「杀掉重起」那一支', () => {
  assert.match(ensureRun, /await liveness\(meta\.brokerPid, remote\)/)
  assert.match(ensureRun, /if \(alive === 'unknown'\) doubt = /)
  assert.doesNotMatch(ensureRun, /brokerLives = meta !== null && exited === null && await isAlive/)
})

test('插件不再往对话自己的 Claude 里发 /context——每次都会作为上下文留在对话里', () => {
  assert.doesNotMatch(source, /runCommandForPlugin\([^)]*'\/context'\)/)
  assert.doesNotMatch(body('driveTurn'), /probeContextWindow|\/context/)
})

// soak3 实测：链路冻结时每轮的 kill -0 探针问不出来，旧代码当成「broker 没了」，
// 拆掉好好的 run 再绕一圈启动确认，日志还写着 starting a fresh Claude。
test('已有的 run：探针问不出来就留着它，只有确认死了才拆', () => {
  const fast = ensureRun.slice(0, ensureRun.indexOf('const dir = sessionDir(sessionId)'))
  assert.match(fast, /const alive = await liveness\(live\.brokerPid, remote\)/)
  assert.match(fast, /if \(alive === 'unknown'\) \{[^}]*return live\s*\}/)
  assert.doesNotMatch(fast, /await isAlive\(live\.brokerPid/)
})
