// cc-daemon — one per target machine. The plugin's ONE connection to it.
//
// Why this exists
// ---------------
// The plugin used to reach a target machine with a stream of one-off shell
// commands: `docker exec` to stat a file, cat a json, `kill -0` a pid, tail a
// log. On the local machine those are microseconds and never fail ambiguously.
// Over `docker exec` on a busy machine they take seconds — and the helper
// carrying them (`runCapture`) never threw: a timeout, a spawn that failed,
// and "the answer really is empty" all came back as the same empty string.
// Callers read that as a definite NO, and the NO branch is always the
// destructive one. That is how a 30MB transcript got declared missing and a
// conversation was restarted with an empty Claude, and how a state file became
// a 153-byte stub.
//
// This daemon collapses all of it into ONE connection. A connection is either
// up or down; there is no third state. Every call comes back as a decided
// outcome — an exit code, or an explicit `timedOut`, or an HTTP error — and
// never as an empty string standing in for all three.
//
// What it does NOT do
// -------------------
// It does not own Claude processes. The broker already does that, and it does
// it with a long list of hard-won behaviours (the fifo held open r+, the
// farewell record on every exit path, the agent-mesh hop). Re-implementing
// those here would be a second place to get them wrong. The broker stays a
// process per conversation; this daemon is the machine's single front door.
//
// So the surface is three endpoints and no business logic:
//   GET  /health                              is anyone home, and which protocol
//   POST /exec    {cmd,stdin,timeoutMs,idemKey}  run one command, decided outcome
//   GET  /tail?path=&from=                    follow a file from a byte offset
//
// See PROTOCOL.md for the wire contract.

import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

export const DAEMON_VERSION = '0.2.0'
/** Bumped only when the wire contract changes. The plugin refuses a mismatch. */
export const PROTOCOL_VERSION = 2

/** Cap on what one /exec may return, so a `cat` of a huge file cannot OOM us. */
const EXEC_OUTPUT_LIMIT = 8 * 1024 * 1024
/** Cap on a request body (an /exec stdin payload). */
const BODY_LIMIT = 16 * 1024 * 1024
/** How many idempotency entries to keep. Enough for any plausible replay. */
const IDEM_KEEP = 2000

function readBody(req, limit = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) { reject(new Error('request body too large')); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(text)
}

/**
 * Collect a stream up to a cap.
 *
 * Past the cap the bytes are dropped rather than buffered, and the caller is
 * TOLD (`truncated`). Silently returning a prefix would be the same lie this
 * whole daemon exists to stop telling.
 */
function collect(stream, limit) {
  const state = { text: '', truncated: false, bytes: 0 }
  stream.setEncoding('utf8')
  stream.on('data', (chunk) => {
    state.bytes += Buffer.byteLength(chunk)
    if (state.bytes > limit) { state.truncated = true; return }
    state.text += chunk
  })
  stream.on('error', () => { /* the exit handler reports what happened */ })
  return state
}

/**
 * The idempotency ledger.
 *
 * Only ONE hop can fail ambiguously — plugin → daemon: the connection drops
 * and the caller cannot know whether the command ran. Everything past that is
 * local to this machine. So the key lives on this hop and nowhere else, and it
 * is written to disk BEFORE the reply goes out, so a daemon that crashes
 * between the two still refuses the replay.
 *
 * This is dsh's own rpcId trick: the first claimant wins, and a settled id is
 * no longer claimable, which makes double-settlement unreachable rather than
 * merely unlikely.
 */
class Ledger {
  constructor(file) {
    this.file = file
    this.entries = new Map()
    this.load()
  }

  load() {
    let raw = ''
    try { raw = fs.readFileSync(this.file, 'utf8') } catch (error) { return }
    for (const line of raw.split('\n')) {
      if (line.trim().length === 0) continue
      try {
        const row = JSON.parse(line)
        if (typeof row.k === 'string') this.entries.set(row.k, row.r)
      } catch (error) { /* a torn last line; the rest stands */ }
    }
  }

  has(key) { return this.entries.has(key) }

  get(key) { return this.entries.get(key) }

  /** Record the outcome, durably, before the caller is told anything. */
  record(key, result) {
    this.entries.set(key, result)
    try { fs.appendFileSync(this.file, JSON.stringify({ k: key, r: result, at: Date.now() }) + '\n') } catch (error) { /* best effort */ }
    if (this.entries.size > IDEM_KEEP * 2) this.compact()
  }

  compact() {
    const keep = [...this.entries.entries()].slice(-IDEM_KEEP)
    this.entries = new Map(keep)
    const text = keep.map(([k, r]) => JSON.stringify({ k: k, r: r, at: Date.now() })).join('\n') + '\n'
    try { fs.writeFileSync(this.file, text) } catch (error) { /* best effort */ }
  }
}

/**
 * Run one command and come back with a DECIDED outcome.
 *
 * The three ways this can end are three different answers, never the same one:
 *   - it ran        → { code, signal, stdout, stderr }
 *   - it timed out  → { timedOut: true, ... whatever it had printed }
 *   - it never ran  → rejects, and the caller answers 500
 */
function execCommand(cmd, options) {
  const timeoutMs = typeof options.timeoutMs === 'number' && options.timeoutMs > 0
    ? Math.min(options.timeoutMs, 10 * 60 * 1000)
    : 20000
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn('/bin/sh', ['-c', cmd], {
        cwd: typeof options.cwd === 'string' && options.cwd.length > 0 ? options.cwd : '/',
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error) { reject(error); return }
    // A spawn that fails asynchronously (no /bin/sh, EAGAIN) must reject too,
    // or it would resolve as a command that produced nothing.
    let settled = false
    child.on('error', (error) => { if (!settled) { settled = true; clearTimeout(timer); reject(error) } })

    const out = collect(child.stdout, EXEC_OUTPUT_LIMIT)
    const err = collect(child.stderr, EXEC_OUTPUT_LIMIT)

    if (typeof options.stdin === 'string' && options.stdin.length > 0) {
      child.stdin.on('error', () => { /* the child closed it; the exit tells the story */ })
      child.stdin.end(options.stdin)
    } else {
      child.stdin.end()
    }

    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGKILL') } catch (error) { /* already gone */ }
    }, timeoutMs)

    child.on('close', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        code: timedOut ? null : code,
        signal: signal === undefined ? null : signal,
        stdout: out.text,
        stderr: err.text,
        truncated: out.truncated || err.truncated,
        timedOut: timedOut,
      })
    })
  })
}

/**
 * Stream a file from a byte offset and keep streaming as it grows.
 *
 * This replaces `tail -c +N -f` over a shell hop. The difference that matters
 * is the opening: a file that is not there answers 404 — a fact — where the
 * shell version answered with an empty stream indistinguishable from a file
 * that simply had nothing new yet.
 *
 * Follow is a poll rather than fs.watch: the file is appended by a process
 * that may be in another mount namespace (the broker in a container writing
 * through an overlay), where inotify is not reliably delivered. 120ms is below
 * human perception for streamed tokens and costs one fstat.
 */
function startTail(res, filePath, from) {
  let fd
  try { fd = fs.openSync(filePath, 'r') } catch (error) {
    sendJson(res, 404, { error: 'tail: cannot open ' + filePath + ': ' + String(error && error.message ? error.message : error) })
    return null
  }
  res.writeHead(200, {
    'content-type': 'application/octet-stream',
    'cache-control': 'no-store',
    // Nothing between us and the plugin should hold bytes back.
    'x-accel-buffering': 'no',
  })
  let offset = from
  let closed = false
  let pumping = false

  const pump = () => {
    if (closed || pumping) return
    pumping = true
    try {
      while (true) {
        const size = fs.fstatSync(fd).size
        // A log that got shorter was rotated or replaced. Reading on from the
        // old offset would hand the plugin bytes from a different file.
        if (size < offset) { finish('truncated'); return }
        if (size === offset) break
        const length = Math.min(size - offset, 1024 * 1024)
        const buffer = Buffer.allocUnsafe(length)
        const read = fs.readSync(fd, buffer, 0, length, offset)
        if (read <= 0) break
        offset += read
        if (!res.write(buffer.subarray(0, read))) break
      }
    } catch (error) { finish('read error: ' + String(error && error.message ? error.message : error)); return }
    finally { pumping = false }
  }

  const finish = (reason) => {
    if (closed) return
    closed = true
    clearInterval(timer)
    try { fs.closeSync(fd) } catch (error) { /* already closed */ }
    try { res.end() } catch (error) { /* already ended */ }
  }

  const timer = setInterval(pump, 120)
  res.on('drain', pump)
  res.on('close', () => finish('client gone'))
  pump()
  return { stop: () => finish('stopped') }
}

/**
 * Start the daemon.
 * @returns { port, token, stateDir, close }
 */
export async function startDaemon(options) {
  const stateDir = options.stateDir
  fs.mkdirSync(stateDir, { recursive: true })

  const tokenPath = path.join(stateDir, 'token')
  let token = ''
  try { token = fs.readFileSync(tokenPath, 'utf8').trim() } catch (error) { token = '' }
  if (token.length === 0) {
    token = crypto.randomBytes(32).toString('hex')
    fs.writeFileSync(tokenPath, token + '\n', { mode: 0o600 })
  }

  const ledger = new Ledger(path.join(stateDir, 'idem.jsonl'))
  const startedAt = Date.now()
  const tails = new Set()

  const server = http.createServer(async (req, res) => {
    // A daemon that can start processes IS an RCE endpoint. There is no
    // "internal, so it doesn't need auth" here — it binds loopback AND checks
    // the bearer, because loopback on a shared box is not a boundary.
    const expected = 'Bearer ' + token
    const given = req.headers.authorization || ''
    // Constant-time so the token cannot be discovered a byte at a time.
    const ok = given.length === expected.length
      && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected))
    if (!ok) { sendJson(res, 401, { error: 'bad or missing bearer token' }); return }

    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const route = url.pathname.replace(/\/+$/, '') || '/'

    try {
      if (req.method === 'GET' && route === '/health') {
        sendJson(res, 200, {
          ok: true,
          daemon: DAEMON_VERSION,
          protocol: PROTOCOL_VERSION,
          pid: process.pid,
          uptimeMs: Date.now() - startedAt,
          tails: tails.size,
          stateDir: stateDir,
        })
        return
      }

      if (req.method === 'POST' && route === '/exec') {
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
        const cmd = typeof body.cmd === 'string' ? body.cmd : ''
        if (cmd.length === 0) { sendJson(res, 400, { error: 'exec: cmd is required' }); return }
        const key = typeof body.idemKey === 'string' && body.idemKey.length > 0 ? body.idemKey : ''
        if (key.length > 0 && ledger.has(key)) {
          sendJson(res, 200, { ...ledger.get(key), duplicate: true })
          return
        }
        let result
        try {
          result = await execCommand(cmd, { timeoutMs: body.timeoutMs, stdin: body.stdin, cwd: body.cwd })
        } catch (error) {
          // It never ran. This is NOT an empty answer — say so with a status
          // the caller cannot mistake for a result.
          sendJson(res, 500, { error: 'exec: ' + String(error && error.message ? error.message : error) })
          return
        }
        // Durable before the reply: a crash in this gap costs a re-run at
        // worst, while replying first would let a replay run it twice.
        if (key.length > 0) ledger.record(key, result)
        sendJson(res, 200, { ...result, duplicate: false })
        return
      }

      if (req.method === 'GET' && route === '/tail') {
        const filePath = url.searchParams.get('path') || ''
        const from = Number(url.searchParams.get('from') || '0')
        if (filePath.length === 0 || !path.isAbsolute(filePath)) {
          sendJson(res, 400, { error: 'tail: absolute path is required' })
          return
        }
        const handle = startTail(res, filePath, Number.isFinite(from) && from >= 0 ? from : 0)
        if (handle !== null) {
          tails.add(handle)
          res.on('close', () => tails.delete(handle))
        }
        return
      }

      sendJson(res, 404, { error: 'no such endpoint: ' + req.method + ' ' + route })
    } catch (error) {
      sendJson(res, 500, { error: String(error && error.message ? error.message : error) })
    }
  })

  // A tail is a long-lived response; the default 2min header timeout and any
  // idle timeout would cut a quiet conversation's stream for no reason.
  server.timeout = 0
  server.headersTimeout = 0
  server.requestTimeout = 0
  server.keepAliveTimeout = 0

  const host = typeof options.host === 'string' && options.host.length > 0 ? options.host : '127.0.0.1'
  await new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(options.port || 0, host, resolve)
  })
  const address = server.address()
  const port = address !== null && typeof address === 'object' ? address.port : 0

  fs.writeFileSync(path.join(stateDir, 'port'), String(port) + '\n')
  fs.writeFileSync(path.join(stateDir, 'pid'), String(process.pid) + '\n')

  return {
    port: port,
    token: token,
    stateDir: stateDir,
    close: () => new Promise((resolve) => {
      for (const handle of tails) handle.stop()
      tails.clear()
      server.close(() => resolve())
      server.closeAllConnections()
    }),
  }
}

// ---------------------------------------------------------------------------
// CLI
//
// One self-contained file on purpose: the plugin installs this daemon by
// piping THIS source into a file on the target and running it. One file is one
// `cat`, which is one thing that can go half-done instead of two.
//
//   node cc-daemon.mjs run    --state <dir> [--port N]   run in the foreground
//   node cc-daemon.mjs ensure --state <dir>              idempotent; prints JSON
//
// `ensure` is what the plugin calls. It is idempotent because the alternative
// — "is it running? no? start it" as two round trips from the other side of a
// slow hop — is a race that ends with two daemons on one state directory.
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { command: 'run', stateDir: '', port: 0 }
  const rest = []
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i]
    if (value === '--state') { args.stateDir = argv[i + 1] || ''; i += 1; continue }
    if (value === '--port') { args.port = Number(argv[i + 1] || '0'); i += 1; continue }
    rest.push(value)
  }
  if (rest.length > 0) args.command = rest[0]
  return args
}

function healthOf(port, token, timeoutMs) {
  return new Promise((resolve) => {
    const request = http.request({
      host: '127.0.0.1',
      port: port,
      path: '/health',
      method: 'GET',
      headers: { authorization: 'Bearer ' + token },
      timeout: timeoutMs || 2000,
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch (error) { resolve(null) }
      })
    })
    request.on('error', () => resolve(null))
    request.on('timeout', () => { request.destroy(); resolve(null) })
    request.end()
  })
}

function readTrimmed(file) {
  try { return fs.readFileSync(file, 'utf8').trim() } catch (error) { return '' }
}

/**
 * Is a healthy daemon of THIS protocol already on this state directory?
 *
 * A protocol mismatch is not "unhealthy" — it is an older daemon doing its job
 * correctly. Saying so lets the plugin replace it deliberately rather than
 * starting a second one beside it.
 */
async function existing(stateDir) {
  const port = Number(readTrimmed(path.join(stateDir, 'port')))
  const token = readTrimmed(path.join(stateDir, 'token'))
  if (!Number.isFinite(port) || port <= 0 || token.length === 0) return null
  const health = await healthOf(port, token, 2000)
  if (health === null || health.ok !== true) return null
  return { port: port, token: token, protocol: health.protocol, pid: health.pid }
}

async function ensure(stateDir) {
  fs.mkdirSync(stateDir, { recursive: true })
  const found = await existing(stateDir)
  if (found !== null) {
    if (found.protocol === PROTOCOL_VERSION) {
      return { ready: true, reused: true, port: found.port, token: found.token, stateDir: stateDir, protocol: found.protocol, pid: found.pid }
    }
    // Wrong protocol: stop it, then take its place. Leaving it up would mean
    // two daemons fighting over one state directory.
    try { process.kill(found.pid, 'SIGTERM') } catch (error) { /* already gone */ }
    await new Promise((wait) => setTimeout(wait, 300))
  }

  const self = new URL(import.meta.url).pathname
  const log = fs.openSync(path.join(stateDir, 'daemon.log'), 'a')
  const child = spawn(process.execPath, [self, 'run', '--state', stateDir], {
    detached: true,
    stdio: ['ignore', log, log],
  })
  child.unref()

  // Wait for it to be actually answering, not merely spawned. A pid is not a
  // service, and the caller is about to depend on this being true.
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    await new Promise((wait) => setTimeout(wait, 150))
    const up = await existing(stateDir)
    if (up !== null && up.protocol === PROTOCOL_VERSION) {
      return { ready: true, reused: false, port: up.port, token: up.token, stateDir: stateDir, protocol: up.protocol, pid: up.pid }
    }
  }
  const tail = (() => {
    try { return fs.readFileSync(path.join(stateDir, 'daemon.log'), 'utf8').split('\n').slice(-20).join('\n') } catch (error) { return '' }
  })()
  throw new Error('cc-daemon did not come up within 15s\n' + tail)
}

if (process.argv[1] !== undefined && import.meta.url === new URL('file://' + path.resolve(process.argv[1])).href) {
  const args = parseArgs(process.argv.slice(2))
  if (args.stateDir.length === 0) {
    console.error('usage: cc-daemon.mjs <run|ensure> --state <dir> [--port N]')
    process.exit(2)
  }
  if (args.command === 'ensure') {
    ensure(args.stateDir).then(
      (info) => { process.stdout.write(JSON.stringify(info) + '\n') },
      (error) => { process.stdout.write(JSON.stringify({ ready: false, error: String(error && error.message ? error.message : error) }) + '\n'); process.exit(1) },
    )
  } else {
    const info = await startDaemon({ stateDir: args.stateDir, port: args.port })
    process.stdout.write(JSON.stringify({ ready: true, port: info.port, token: info.token, stateDir: info.stateDir, protocol: PROTOCOL_VERSION }) + '\n')
    // Nothing else to do; the server holds the loop open.
  }
}
