// cc-mode broker — owns one Claude Code process so the dsh plugin can come and
// go without killing it.
//
// Written to /tmp/ccmode/broker.mjs by the plugin and started detached
// (`setsid`), so it survives a plugin hot-update, a plugin stop, and a dsh
// restart. The plugin attaches by tailing `out.log` from a byte offset and
// speaks to Claude by writing lines into the `in` fifo. Nothing in the plugin
// holds the process itself.
//
// Layout of a session directory:
//   in         fifo   → Claude's stdin (held open r+ so writers never EOF it)
//   out.log    file   → every stdout line, append-only; the attach point
//   meta.json  file   → pid, child pid, claude session id, launch snapshot
//   exit.json  file   → written once the child exits

import { spawn } from 'node:child_process'
import fs from 'node:fs'

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
fs.createReadStream(null, { fd: fifo }).pipe(child.stdin)
child.stdin.on('error', () => { /* the child went away; the exit handler reports it */ })

child.on('exit', (code, signal) => {
  record({ type: 'cc-exit', exitCode: code, signal: signal })
  try { fs.writeFileSync(dir + '/exit.json', JSON.stringify({ code: code, signal: signal, at: Date.now() })) } catch (error) { /* best effort */ }
  setTimeout(() => process.exit(0), 200)
})

// A broker with no child is pointless; a broker whose parent died is the point.
process.on('SIGHUP', () => { /* survive the detaching shell */ })
