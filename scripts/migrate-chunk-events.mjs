// 把 dsh 0.1.5-rc.1 之前写下的会话日志，迁到 rc.2 的内嵌流模型。
//
// rc.2 废掉了 `assistant/chunk` 这个事件类型：日志里只要有一条，整份日志就被
// 拒绝（"unknown to this harness … refusing to interpret the log"），那个对话
// 就再也打不开了。同一版还要求 `assistant/message` 必须带 `stream`，且不许再
// 带 `sourceEventSeqs`。
//
// 迁移不删任何一行——seq 的连续性是 dsh 校验的，删一行就要重编号，而
// surfaceOp 里还存着对 seq 的引用。改动只有三处，都是就地的：
//
//   1. 每条 assistant/chunk 的 chunk，按 (turn, step) 归到那一步的 stream 里，
//      用与插件完全相同的打包函数（从 src/host.dynamic.js 现切，防止两份实现
//      各走各的）。
//   2. 那一步的 assistant/message 收下这个 stream；没有 message 的步骤
//      （被打断的）改写成 assistant/attempt 承载它。
//   3. assistant/chunk 自己标上 ignorable:true —— rc.2 对「不认识但标了可忽略」
//      的事件是放行的，于是它们既不再挡路，也不必被抹掉。
//
// 用法：
//   node scripts/migrate-chunk-events.mjs <会话目录或 sessions 根目录> [--apply]
// 默认只报告不落盘；--apply 时先把原文件备份成 .before-chunk-migration。

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const source = fs.readFileSync(path.join(root, 'src/host.dynamic.js'), 'utf8')

/** 从插件源码里现切一个函数，确保打包规则只有一份。 */
function sliceFunction(name) {
  const start = source.indexOf(`function ${name}(`)
  if (start === -1) throw new Error(`找不到 ${name}——它被改名或删掉了`)
  let depth = 0
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  throw new Error(`${name} 的花括号没有配平`)
}

const names = ['runKindOf', 'runMemberOf', 'extendsRun', 'appendChunk']
const packer = new Function(`${names.map(sliceFunction).join('\n')}\nreturn { appendChunk }`)()

function readLog(file) {
  return execFileSync('zstd', ['-dc', file], { maxBuffer: 1 << 30 }).toString('utf8')
}

function compress(text) {
  return execFileSync('zstd', ['-q', '-c'], { input: Buffer.from(text, 'utf8'), maxBuffer: 1 << 30 })
}

/**
 * 写回时的帧结构不是小事。
 *
 * 这个日志是追加写出来的：每次 flush 一个独立的 zstd 帧，一个文件里几十帧。
 * dsh 打开它时会先单独解第一帧，并且要求那一帧**恰好是一行** header
 * （assertZstdHeaderFrame：唯一的换行必须在末尾）。把整份内容压成一个大帧，
 * 第一帧就成了整个日志，dsh 直接判定 "corrupt Zstandard session log"——
 * 于是加载 workspace 的那一步抛错，整个 dsh 起不来，侧边栏一个会话都不剩。
 * （这是实测出来的：第一版脚本就是这么写的，dsh 当场进入重启循环。）
 *
 * 所以写回同样分帧：header 自己一帧，其余内容一帧，顺序拼接就是合法的
 * 多帧 zstd 文件。
 */
function writeLog(file, text) {
  const cut = text.indexOf('\n')
  if (cut === -1) throw new Error('日志没有 header 行，不敢写回')
  const header = text.slice(0, cut + 1)
  const rest = text.slice(cut + 1)
  const frames = [compress(header)]
  if (rest.length > 0) frames.push(compress(rest))
  fs.writeFileSync(file, Buffer.concat(frames))
}

/**
 * 迁移一份日志。
 * @returns { changed, chunks, messages, attempts } 或 null（不需要动）
 */
function migrate(text) {
  const lines = text.split('\n')
  const events = []
  for (const line of lines) {
    if (line.trim().length === 0) { events.push(null); continue }
    try { events.push(JSON.parse(line)) } catch (error) { events.push({ __raw: line }) }
  }
  // 两种都要修：带 assistant/chunk 的（rc.2 整份拒绝），以及跨越版本那一刻、
  // assistant/message 还没带 stream 的（rc.2 判 "invalid settlement fields"）。
  const needsWork = events.some((e) => e !== null && (
    (e.type === 'assistant/chunk' && e.ignorable !== true)
    || ((e.type === 'assistant/message' || e.type === 'assistant/attempt')
      && !Array.isArray((e.data || {}).stream))
    || (e.type === 'assistant/message' && e.sourceEventSeqs !== undefined)))
  if (!needsWork) return null

  // 先把每一步的 chunk 攒成 stream，顺序就是日志顺序。
  const steps = new Map()
  const keyOf = (data) => String(data.turn) + '/' + String(data.step)
  let chunks = 0
  for (const event of events) {
    if (event === null || event.type !== 'assistant/chunk') continue
    const data = event.data || {}
    const key = keyOf(data)
    let step = steps.get(key)
    if (step === undefined) { step = { stream: [], streamAt: 0 }; steps.set(key, step) }
    // 时间用事件自己的，原样保留这一步的节奏。
    const at = typeof event.time === 'number' ? event.time : Date.now()
    const before = Date.now
    Date.now = () => at
    try { packer.appendChunk(step, data.chunk) } finally { Date.now = before }
    chunks += 1
  }

  let messages = 0
  let attempts = 0
  const settled = new Set()
  for (const event of events) {
    if (event === null) continue
    if (event.type === 'assistant/chunk') { event.ignorable = true; continue }
    if (event.type !== 'assistant/message') continue
    const data = event.data || {}
    const key = keyOf(data)
    const step = steps.get(key)
    if (!Array.isArray(data.stream)) data.stream = step === undefined ? [] : step.stream
    if (event.sourceEventSeqs !== undefined) delete event.sourceEventSeqs
    settled.add(key)
    messages += 1
  }

  // 有流却没有落成消息的步骤：它的 step/end 就地改写成 assistant/attempt，
  // 这样那段流仍然有主，而行数和 seq 一个都没动。
  for (const event of events) {
    if (event === null || event.type !== 'step/end') continue
    const data = event.data || {}
    const key = keyOf(data)
    if (settled.has(key)) continue
    const step = steps.get(key)
    if (step === undefined || step.stream.length === 0) continue
    event.type = 'assistant/attempt'
    event.data = { turn: data.turn, step: data.step, stream: step.stream }
    settled.add(key)
    attempts += 1
  }

  const out = events.map((e) => (e === null ? '' : (e.__raw !== undefined ? e.__raw : JSON.stringify(e)))).join('\n')
  return { text: out, chunks: chunks, messages: messages, attempts: attempts }
}

function findLogs(target) {
  const stat = fs.statSync(target)
  if (stat.isFile()) return [target]
  const found = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name === 'session.v3.jsonl.zstd') found.push(full)
    }
  }
  walk(target)
  return found
}

const target = process.argv[2]
const apply = process.argv.includes('--apply')
if (target === undefined) {
  console.error('用法: node scripts/migrate-chunk-events.mjs <会话目录或 sessions 根目录> [--apply]')
  process.exit(2)
}

let touched = 0
for (const file of findLogs(target)) {
  let result
  try { result = migrate(readLog(file)) } catch (error) {
    console.error('跳过（读不了或解析失败）:', file, String(error && error.message ? error.message : error))
    continue
  }
  if (result === null) continue
  touched += 1
  const where = path.basename(path.dirname(file))
  console.log(`${apply ? '迁移' : '待迁移'} ${where}: ${result.chunks} 条 chunk → ${result.messages} 条消息` +
    (result.attempts > 0 ? ` + ${result.attempts} 条 attempt` : ''))
  if (!apply) continue
  fs.copyFileSync(file, file + '.before-chunk-migration')
  writeLog(file, result.text)
}
console.log(touched === 0 ? '没有需要迁移的日志。' : `共 ${touched} 份` + (apply ? '（原件已备份为 .before-chunk-migration）' : '；加 --apply 落盘。'))
