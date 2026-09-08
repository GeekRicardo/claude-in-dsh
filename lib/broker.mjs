// cc-mode broker — owns one Claude Code process so the dsh plugin can come and
// go without killing it.
//
// Written to /tmp/ccmode/broker.mjs by the plugin and started detached
// into its own session, so it survives a plugin hot-update, a plugin stop,
// and a dsh restart. The plugin attaches by tailing `out.log` from a byte offset and
// speaks to Claude by writing lines into the `in` fifo. Nothing in the plugin
// holds the process itself.
//
// Layout of a session directory:
//   in         fifo   → Claude's stdin (held open r+ so writers never EOF it)
//   out.log    file   → every stdout line, append-only; the attach point
//   meta.json  file   → pid, child pid, claude session id, launch snapshot
//   exit.json  file   → written once the child exits
//   mesh.json  file   → where dsh's agent-mesh endpoint is, if this conversation
//                       has one; the broker proxies to it (see below)

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'

const dir = process.argv[2]
const argv = process.argv.slice(3)
if (typeof dir !== 'string' || argv.length === 0) {
  console.error('usage: broker.mjs <dir> <argv...>')
  process.exit(2)
}

const out = fs.createWriteStream(dir + '/out.log', { flags: 'a' })

function record(value) {
  out.write(JSON.stringify(value) + '\n')
}

// ---------- the agent-mesh hop ----------
//
// Claude's `dsh-agents` tools are an HTTP MCP server served by dsh itself. Point
// Claude straight at dsh and every dsh restart — ten seconds of pm2 — becomes a
// connection error inside whatever tool call was in flight. The CLI reports that
// as the server being gone, and the model, told its mesh is dead, stops using
// the tools for the rest of its life: a conversation that was driving fourteen
// children goes back to doing everything by hand and says so.
//
// The broker outlives dsh by construction — that is the whole reason it exists —
// so the connection Claude holds should end HERE, not at dsh. This is a plain
// forwarder: the MCP transport on the other side is stateless POST-only, so a
// request is a request. When dsh is not answering, the hop RETRIES rather than
// failing, and if it still cannot get through it answers with a JSON-RPC result
// carrying isError — a tool that failed this once, which a model retries —
// instead of a transport error, which a model reads as "the server is gone".
//
// The upstream Authorization header lives in this process and in a 0600 file
// rather than in Claude's argv, where `ps` could read it.
const MESH_PLACEHOLDER = '__CCMODE_MESH__'
// Under the CLI's own per-tool timeout, so a call that cannot get through comes
// back as a tool error we WROTE rather than one the transport invented.
// Overridable only so the test can watch a real outage without waiting one out.
const MESH_RETRY_MS = Number(process.env.CCMODE_MESH_RETRY_MS || 25000)
const MESH_RETRY_STEP_MS = Number(process.env.CCMODE_MESH_RETRY_STEP_MS || 750)

function readMesh() {
  try { return JSON.parse(fs.readFileSync(dir + '/mesh.json', 'utf8')) } catch (error) { return null }
}

function meshOriginOf(mesh) {
  const origin = String((mesh && mesh.origin) || '')
  return origin.replace(/^https?:\/\//, '').replace(/\/+$/, '')
}

/** One attempt at the upstream. Resolves { status, body } or rejects (connection). */
function forwardOnce(mesh, path, headers, body) {
  return new Promise((resolve, reject) => {
    const origin = meshOriginOf(mesh)
    const colon = origin.lastIndexOf(':')
    const host = colon > 0 ? origin.slice(0, colon) : origin
    const port = colon > 0 ? Number(origin.slice(colon + 1)) : 80
    const request = http.request({
      host: host,
      port: port,
      path: path,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: headers.accept || 'application/json, text/event-stream',
        'content-length': Buffer.byteLength(body),
        ...(mesh.token ? { authorization: 'Bearer ' + mesh.token } : {}),
      },
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => resolve({ status: response.statusCode || 502, body: Buffer.concat(chunks) }))
      response.on('error', reject)
    })
    request.on('error', reject)
    // A dsh that accepted the socket and then went down mid-request looks like
    // silence; without this the hop would hold the CLI open past its own timeout.
    request.setTimeout(MESH_RETRY_MS, () => request.destroy(new Error('agent-mesh hop: upstream timed out')))
    request.end(body)
  })
}

function startMeshHop(mesh) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks = []
      req.on('data', (chunk) => chunks.push(chunk))
      req.on('end', async () => {
        const body = Buffer.concat(chunks)
        const deadline = Date.now() + MESH_RETRY_MS
        let last = ''
        while (true) {
          try {
            const answer = await forwardOnce(mesh, req.url || '/', req.headers, body)
            res.writeHead(answer.status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
            res.end(answer.body)
            return
          } catch (error) {
            last = String(error && error.message ? error.message : error)
            if (Date.now() >= deadline) break
            await new Promise((wait) => setTimeout(wait, MESH_RETRY_STEP_MS))
          }
        }
        // Still nothing. Answer as the MCP server would when a tool fails, so
        // the CLI keeps the server and the model knows to try again.
        let id = null
        try { id = JSON.parse(body.toString('utf8')).id } catch (error) { id = null }
        record({ type: 'cc-stderr', text: 'agent-mesh hop: dsh unreachable for ' + Math.round(MESH_RETRY_MS / 1000) + 's — ' + last })
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: id === undefined ? null : id,
          result: {
            content: [{ type: 'text', text: 'dsh 暂时联系不上（' + last + '）。这是这一次调用的失败，不是工具没了——过几秒重试同一个调用即可。' }],
            isError: true,
          },
        }))
      })
    })
    server.on('error', () => resolve(0))
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve(address !== null && typeof address === 'object' ? address.port : 0)
    })
  })
}

const mesh = readMesh()
if (mesh !== null && argv.some((value) => String(value).indexOf(MESH_PLACEHOLDER) !== -1)) {
  const port = await startMeshHop(mesh)
  // A hop that could not bind is not worth failing the launch over: point Claude
  // straight at dsh instead and behave exactly as this broker did before.
  const authority = port > 0 ? '127.0.0.1:' + port : meshOriginOf(mesh)
  for (let index = 0; index < argv.length; index += 1) {
    argv[index] = String(argv[index]).split(MESH_PLACEHOLDER).join(authority)
  }
  record({ type: 'cc-stderr', text: port > 0 ? 'agent-mesh hop on 127.0.0.1:' + port : 'agent-mesh hop could not bind — talking to dsh directly' })
}

const child = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] })

function patchMeta(patch) {
  let meta = {}
  try { meta = JSON.parse(fs.readFileSync(dir + '/meta.json', 'utf8')) } catch (error) { meta = {} }
  fs.writeFileSync(dir + '/meta.json', JSON.stringify({ ...meta, ...patch }))
}

patchMeta({ brokerPid: process.pid, childPid: child.pid, startedAt: Date.now() })

child.stdout.pipe(out, { end: false })
child.stderr.on('data', (chunk) => {
  const text = String(chunk).trim()
  if (text.length > 0) record({ type: 'cc-stderr', text: text })
})

// Holding the fifo open for read AND write is what keeps it from ending the
// moment a `cat > in` writer closes: there is always one writer (us).
const fifo = fs.openSync(dir + '/in', 'r+')
const fifoReader = fs.createReadStream(null, { fd: fifo })
fifoReader.pipe(child.stdin)
child.stdin.on('error', () => { /* the child went away; the exit handler reports it */ })

// A broker that dies without saying so is the worst thing this file can do.
// The plugin decides whether to attach or relaunch from `exit.json` plus a
// liveness check on our pid — and a Node process killed by an unhandled stream
// 'error' leaves NEITHER, so the plugin re-attached to a dead broker and wrote
// prompts into a fifo with no reader. The conversation simply stopped
// answering, with nothing anywhere saying why. Observed: a broker gone at
// exit code 1, its Claude gone at 0 (stdin EOF, because we were the only one
// holding the fifo), out.log cut mid-sentence, no exit.json, and a turn that
// hung until someone noticed hours later.
//
// So: nothing here is allowed to be an unhandled error, and every way out of
// this process writes the same two records first.
let farewelled = false

function farewell(reason) {
  if (farewelled) return
  farewelled = true
  try { record(Object.assign({ type: 'cc-exit', exitCode: null, signal: null }, reason)) } catch (error) { /* the log is gone too */ }
  try {
    fs.writeFileSync(dir + '/exit.json', JSON.stringify(Object.assign({ at: Date.now() }, reason)))
  } catch (error) { /* best effort */ }
}

/**
 * Leave, for good, having said why.
 *
 * `process.exit()` is not enough here and that is not a theory: with the log
 * stream failed, the call was measured entering the exit path and never coming
 * back OUT of it while the process stayed alive and running — a broker that
 * cannot die is exactly the thing this file must never leave behind. A signal
 * cannot hang. The Claude child goes first: without this process holding the
 * fifo open, nothing can drive it anyway, and the plugin relaunches it with
 * `--resume` the moment it reads the exit record.
 */
function leave(graceMs) {
  try { if (child !== undefined && child.pid) process.kill(child.pid, 'SIGKILL') } catch (error) { /* already gone */ }
  const kill = () => { try { process.kill(process.pid, 'SIGKILL') } catch (error) { process.exit(1) } }
  // A moment for the `cc-exit` line to reach the log — that line is how an
  // attached plugin learns this happened instead of waiting on a dead stream.
  if (graceMs > 0) setTimeout(kill, graceMs)
  else kill()
}

out.on('error', (error) => {
  // Nowhere left to write the reason; exit.json still gets it. No grace period:
  // there is no log left to flush.
  farewelled = true
  try {
    fs.writeFileSync(dir + '/exit.json', JSON.stringify({ at: Date.now(), brokerError: 'out.log: ' + String(error && error.message ? error.message : error) }))
  } catch (ignored) { /* best effort */ }
  leave(0)
})
fifoReader.on('error', (error) => {
  farewell({ brokerError: 'in fifo: ' + String(error && error.message ? error.message : error) })
  leave(150)
})
process.on('uncaughtException', (error) => {
  farewell({ brokerError: String(error && error.stack ? error.stack : error) })
  leave(150)
})
process.on('unhandledRejection', (error) => {
  farewell({ brokerError: 'unhandled rejection: ' + String(error && error.message ? error.message : error) })
  leave(150)
})

child.on('exit', (code, signal) => {
  farewelled = true
  record({ type: 'cc-exit', exitCode: code, signal: signal })
  try { fs.writeFileSync(dir + '/exit.json', JSON.stringify({ code: code, signal: signal, at: Date.now() })) } catch (error) { /* best effort */ }
  // Same hard exit as every other way out: the fifo this process holds open for
  // read AND write is a handle nothing closes, and `process.exit()` was measured
  // going into the exit path without coming back. A broker whose Claude is gone
  // and which will not go itself is a directory the plugin keeps re-attaching to.
  leave(200)
})

// A broker with no child is pointless; a broker whose parent died is the point.
process.on('SIGHUP', () => { /* survive the detaching shell */ })
