// cc-daemon 协议 v2 的测试：真 daemon、真 HTTP、真子进程。
//
// 每一条都盯着同一件事：**失败必须说自己失败**。这个 daemon 存在的唯一理由，
// 就是上一版里「超时」「起不来」「答案真是空」回来长得一模一样。

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { PROTOCOL_VERSION, startDaemon } from '../src/cc-daemon.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DAEMON = path.join(HERE, '..', 'src', 'cc-daemon.mjs')
const temps = []

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccd-test-'))
  temps.push(dir)
  return dir
}

after(() => {
  for (const dir of temps) { try { fs.rmSync(dir, { recursive: true, force: true }) } catch (error) { /* best effort */ } }
})

/** One request. Resolves { status, json, text } — never swallows an error. */
function call(daemon, method, route, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body))
    const request = http.request({
      host: '127.0.0.1',
      port: daemon.port,
      path: route,
      method: method,
      headers: {
        authorization: 'Bearer ' + (token === undefined ? daemon.token : token),
        ...(payload === null ? {} : { 'content-type': 'application/json', 'content-length': payload.length }),
      },
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json = null
        try { json = JSON.parse(text) } catch (error) { json = null }
        resolve({ status: response.statusCode, json: json, text: text })
      })
    })
    request.on('error', reject)
    if (payload !== null) request.write(payload)
    request.end()
  })
}

/** Open a /tail stream and hand back the chunks as they land. */
function tail(daemon, filePath, from) {
  const state = { text: '', status: 0, done: false, request: null }
  state.request = http.request({
    host: '127.0.0.1',
    port: daemon.port,
    path: '/tail?path=' + encodeURIComponent(filePath) + '&from=' + from,
    method: 'GET',
    headers: { authorization: 'Bearer ' + daemon.token },
  }, (response) => {
    state.status = response.statusCode
    response.setEncoding('utf8')
    response.on('data', (chunk) => { state.text += chunk })
    response.on('end', () => { state.done = true })
  })
  state.request.end()
  return state
}

function sleep(ms) { return new Promise((wait) => setTimeout(wait, ms)) }

/** Wait for a condition, or fail loudly with what it looked like instead. */
async function until(what, check, ms) {
  const deadline = Date.now() + (ms || 5000)
  while (Date.now() < deadline) {
    if (check()) return
    await sleep(25)
  }
  assert.fail('等不到：' + what)
}

async function boot() {
  const daemon = await startDaemon({ stateDir: tempDir() })
  return daemon
}

test('没有 token 一律 401——能起进程的端点就是 RCE 端点', async () => {
  const daemon = await boot()
  try {
    const bare = await call(daemon, 'GET', '/health', undefined, '')
    assert.equal(bare.status, 401)
    const wrong = await call(daemon, 'GET', '/health', undefined, 'x'.repeat(64))
    assert.equal(wrong.status, 401)
    const exec = await call(daemon, 'POST', '/exec', { cmd: 'touch /tmp/should-not-exist-ccd' }, 'nope')
    assert.equal(exec.status, 401)
    assert.equal(fs.existsSync('/tmp/should-not-exist-ccd'), false)
  } finally { await daemon.close() }
})

test('/health 报出协议号，插件靠它决定要不要重装 daemon', async () => {
  const daemon = await boot()
  try {
    const answer = await call(daemon, 'GET', '/health')
    assert.equal(answer.status, 200)
    assert.equal(answer.json.ok, true)
    assert.equal(answer.json.protocol, PROTOCOL_VERSION)
    assert.equal(answer.json.pid, process.pid)
  } finally { await daemon.close() }
})

test('/exec 把退出码、stdout、stderr 分开给回来', async () => {
  const daemon = await boot()
  try {
    const ok = await call(daemon, 'POST', '/exec', { cmd: 'echo hello; echo oops >&2' })
    assert.equal(ok.status, 200)
    assert.equal(ok.json.code, 0)
    assert.equal(ok.json.stdout, 'hello\n')
    assert.equal(ok.json.stderr, 'oops\n')
    assert.equal(ok.json.timedOut, false)

    const bad = await call(daemon, 'POST', '/exec', { cmd: 'exit 42' })
    assert.equal(bad.status, 200)
    assert.equal(bad.json.code, 42)
  } finally { await daemon.close() }
})

test('空输出和超时是两个不同的答案——这是整个 daemon 存在的理由', async () => {
  const daemon = await boot()
  try {
    // 真的没有输出：这是一个确定的答案。
    const empty = await call(daemon, 'POST', '/exec', { cmd: 'true' })
    assert.equal(empty.json.stdout, '')
    assert.equal(empty.json.code, 0)
    assert.equal(empty.json.timedOut, false)

    // 超时：输出也是空的，但它绝不能跟上面长得一样。
    const slow = await call(daemon, 'POST', '/exec', { cmd: 'sleep 5', timeoutMs: 300 })
    assert.equal(slow.json.stdout, '')
    assert.equal(slow.json.timedOut, true)
    assert.equal(slow.json.code, null)
  } finally { await daemon.close() }
})

test('命令根本没跑起来 → 500，而不是一个空答复', async () => {
  const daemon = await boot()
  try {
    const answer = await call(daemon, 'POST', '/exec', { cmd: 'echo hi', cwd: '/definitely/not/a/directory' })
    assert.equal(answer.status, 500)
    assert.match(String(answer.json.error), /exec:/)
  } finally { await daemon.close() }
})

test('/exec 带 stdin：插件就是这样把文件写到目标机上的', async () => {
  const daemon = await boot()
  const dir = tempDir()
  try {
    const target = path.join(dir, 'written.txt')
    const answer = await call(daemon, 'POST', '/exec', { cmd: 'cat > ' + JSON.stringify(target), stdin: 'hello from stdin\n' })
    assert.equal(answer.json.code, 0)
    assert.equal(fs.readFileSync(target, 'utf8'), 'hello from stdin\n')
  } finally { await daemon.close() }
})

test('同一个 idemKey 发两次，命令只跑一次', async () => {
  const daemon = await boot()
  const dir = tempDir()
  try {
    const counter = path.join(dir, 'count')
    const body = { cmd: 'echo x >> ' + JSON.stringify(counter), idemKey: 'key-1' }
    const first = await call(daemon, 'POST', '/exec', body)
    const second = await call(daemon, 'POST', '/exec', body)
    assert.equal(first.json.duplicate, false)
    assert.equal(second.json.duplicate, true)
    assert.equal(fs.readFileSync(counter, 'utf8'), 'x\n')
  } finally { await daemon.close() }
})

test('idemKey 台账落盘：daemon 重启之后重试仍然只跑一次', async () => {
  const stateDir = tempDir()
  const dir = tempDir()
  const counter = path.join(dir, 'count')
  const body = { cmd: 'echo x >> ' + JSON.stringify(counter), idemKey: 'survives-restart' }

  const first = await startDaemon({ stateDir: stateDir })
  try { await call(first, 'POST', '/exec', body) } finally { await first.close() }

  const second = await startDaemon({ stateDir: stateDir })
  try {
    const replay = await call(second, 'POST', '/exec', body)
    assert.equal(replay.json.duplicate, true)
    assert.equal(fs.readFileSync(counter, 'utf8'), 'x\n')
  } finally { await second.close() }
})

test('/tail 从偏移开始读，并跟着文件长', async () => {
  const daemon = await boot()
  const dir = tempDir()
  try {
    const log = path.join(dir, 'out.log')
    fs.writeFileSync(log, 'line one\n')
    const stream = tail(daemon, log, 0)
    await until('读到第一行', () => stream.text.indexOf('line one') >= 0)

    fs.appendFileSync(log, 'line two\n')
    await until('读到追加的一行', () => stream.text.indexOf('line two') >= 0)
    assert.equal(stream.text, 'line one\nline two\n')

    stream.request.destroy()
  } finally { await daemon.close() }
})

test('/tail 的文件不存在 → 404：一个事实，不是一条空流', async () => {
  const daemon = await boot()
  try {
    const answer = await call(daemon, 'GET', '/tail?path=' + encodeURIComponent('/no/such/file.log') + '&from=0')
    assert.equal(answer.status, 404)
    assert.match(String(answer.json.error), /cannot open/)
  } finally { await daemon.close() }
})

test('断线重连：拿上次的偏移再请求一次，不重不漏', async () => {
  const daemon = await boot()
  const dir = tempDir()
  try {
    const log = path.join(dir, 'out.log')
    fs.writeFileSync(log, 'alpha\n')
    const first = tail(daemon, log, 0)
    await until('第一段', () => first.text.indexOf('alpha') >= 0)
    const consumed = Buffer.byteLength(first.text)
    first.request.destroy()

    fs.appendFileSync(log, 'beta\n')
    const second = tail(daemon, log, consumed)
    await until('第二段', () => second.text.indexOf('beta') >= 0)
    assert.equal(second.text, 'beta\n')
    second.request.destroy()
  } finally { await daemon.close() }
})

test('日志被截短（轮转）时 tail 结束，而不是接着读一个不同的文件', async () => {
  const daemon = await boot()
  const dir = tempDir()
  try {
    const log = path.join(dir, 'out.log')
    fs.writeFileSync(log, 'aaaaaaaaaa\n')
    const stream = tail(daemon, log, 0)
    await until('先读到内容', () => stream.text.length > 0)
    fs.writeFileSync(log, 'b\n')
    await until('流结束了', () => stream.done === true)
  } finally { await daemon.close() }
})

test('不认识的端点 → 404', async () => {
  const daemon = await boot()
  try {
    const answer = await call(daemon, 'GET', '/conv/x/events')
    assert.equal(answer.status, 404)
  } finally { await daemon.close() }
})

test('ensure 是幂等的：第二次拿回同一个 daemon，而不是又起一个', async () => {
  const stateDir = tempDir()
  const run = (args) => new Promise((resolve) => {
    const child = spawn(process.execPath, [DAEMON, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk) => { out += chunk })
    child.stderr.on('data', (chunk) => { err += chunk })
    child.on('close', (code) => resolve({ code: code, out: out, err: err }))
  })

  const first = await run(['ensure', '--state', stateDir])
  assert.equal(first.code, 0, first.err)
  const one = JSON.parse(first.out)
  assert.equal(one.ready, true)
  assert.equal(one.reused, false)

  const second = await run(['ensure', '--state', stateDir])
  const two = JSON.parse(second.out)
  assert.equal(two.ready, true)
  assert.equal(two.reused, true)
  assert.equal(two.port, one.port)
  assert.equal(two.pid, one.pid)

  // 起出来的 daemon 是真的能用的，不只是能应答 /health。
  const probe = await call({ port: two.port, token: two.token }, 'POST', '/exec', { cmd: 'echo ensured' })
  assert.equal(probe.json.stdout, 'ensured\n')

  try { process.kill(one.pid, 'SIGKILL') } catch (error) { /* already gone */ }
})
