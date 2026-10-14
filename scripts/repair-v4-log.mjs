// 修 dsh 0.2（会话格式 v4）下被旧版插件写坏的会话日志。
//
// v4 的写入不做完整校验，坏行 append 得进去，要到下一次加载才炸，而且炸法
// 有两种，都很重：
//   * 读到第一处坏行，就把日志截到那之前，补一个 interrupted——后面的内容
//     被 dsh 永久删掉（tool/result 还是 v3 形状时就是这样）；
//   * 整份拒绝加载，对话再也打不开（"request/context is outside an open turn"）。
//
// 这一代插件可能留下的坏行，以及这里的处理：
//   1. tool/result 的消息还是 v3 形状（user 角色 + 一个 tool-result 包装块）
//      → 就地提升成 v4 的一等 tool 角色消息，和 dsh 自己的迁移规则一致。
//   2. tool/code-dispatch(-start) → 改名 tool/ptc-dispatch(-start)，字段不变。
//   3. 同一轮里步号从 1 重来（补录写了 1..n，实时转录又从 1 开始）→ 在这一轮
//      里按出现顺序重新编号；步号只是数据字段，没有任何事件引用它的 seq。
//   4. 一步带着没结的调用就关掉了（并行调用被拆进了两步）→ 这条 step/end 和
//      紧跟着的 step/start 改成可忽略事件，两步合成一步，后面的步号顺延。
//   6. 同一个调用的第二条 tool/result（补录给一个未结的调用盖了「没等到结果」，
//      两分钟后真结果从 Claude 的流里到了，又写了一条，落在一个没有声明过这个
//      调用的步里）→ 同样改写成可忽略事件，原内容留在里面。dsh 的校验要的是
//      「结果所在的步声明过这个调用」，所以第二条无论内容多准都进不去。
//   5. 轮次之外的 request/context、request/header，以及结不了任何调用的
//      tool/result（读取端在半轮中间断过）→ 改写成一条「可忽略的未知事件」。
//      dsh 对标了 ignorable:true 的未知类型原样保留、不解释，所以行和 seq
//      一个都不用动（seq 必须连续，其他事件里还存着对 seq 的引用）。
//
// 用法：
//   node scripts/repair-v4-log.mjs <会话目录或 sessions 根目录> [--apply]
// 默认只报告；--apply 先把原文件备份成 .before-v4-repair 再写回。
// 改之前必须让 dsh 放手这个会话（没打开过，或重启 dsh 之前做）：dsh 内存里
// 那份会接着往旧内容后面追加。

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const DROPPED = 'claude-in-dsh/dropped'

function readLog(file) {
  return execFileSync('zstd', ['-dcq', file], { maxBuffer: 1 << 30 }).toString('utf8')
}

/** 分帧写回：header 自己一帧（dsh 单独解第一帧，要求它恰好是一行）。见 migrate-chunk-events.mjs。 */
function writeLog(file, text) {
  const cut = text.indexOf('\n')
  if (cut === -1) throw new Error('日志没有 header 行，不敢写回')
  const compress = (part) => execFileSync('zstd', ['-q', '-c'], { input: Buffer.from(part, 'utf8'), maxBuffer: 1 << 30 })
  const frames = [compress(text.slice(0, cut + 1))]
  if (cut + 1 < text.length) frames.push(compress(text.slice(cut + 1)))
  fs.writeFileSync(file, Buffer.concat(frames))
}

function liftToolResult(message) {
  const wrapper = Array.isArray(message.content) && message.content.length === 1 ? message.content[0] : undefined
  if (message.role !== 'user' || wrapper === undefined || wrapper.type !== 'tool-result') return null
  return {
    id: message.id,
    role: 'tool',
    source: message.source,
    toolCallId: wrapper.toolCallId,
    content: Array.isArray(wrapper.content) ? wrapper.content : [],
    ...(typeof wrapper.isError === 'boolean' ? { isError: wrapper.isError } : {}),
  }
}

function drop(event, why) {
  event.data = { originalType: event.type, reason: why, data: event.data }
  event.type = DROPPED
  event.ignorable = true
  delete event.surfaceOp
  delete event.sourceEventSeqs
}

export function repair(text) {
  const lines = text.split('\n')
  const header = JSON.parse(lines[0])
  if (header.version !== 4) return null
  const fixes = []
  let turnOpen = false
  let turn = null
  let stepCounter = 0
  let openStep = null // { from, to }：这一步原来的号和新号
  const advertised = new Set()
  const unresolved = new Map() // callId -> 它所在的新步号
  let mergeNextStart = false
  const out = [lines[0]]
  for (const line of lines.slice(1)) {
    if (line.trim().length === 0) { out.push(line); continue }
    const event = JSON.parse(line)
    const data = event.data
    if (event.type === 'step/end' && openStep !== null && data && data.turn === turn
      && [...unresolved.values()].includes(openStep.to)) {
      fixes.push(`seq ${event.seq} 第 ${turn} 轮第 ${openStep.to} 步带着没结的调用关掉了 → 和下一步合并`)
      drop(event, 'step closed with an unresolved call; merged with the next step')
      mergeNextStart = true
      out.push(JSON.stringify(event))
      continue
    }
    if (event.type === 'step/start' && mergeNextStart && data && data.turn === turn) {
      mergeNextStart = false
      const from = data.step
      drop(event, 'merged into the previous step')
      openStep = { from: from, to: openStep.to }
      out.push(JSON.stringify(event))
      continue
    }
    if (event.type === 'step/start' && turnOpen && data && data.turn === turn) {
      stepCounter += 1
      openStep = { from: data.step, to: stepCounter }
      if (data.step !== stepCounter) { fixes.push(`seq ${event.seq} 第 ${turn} 轮的步 ${data.step} → ${stepCounter}`); data.step = stepCounter }
    } else if (openStep !== null && data && data.turn === turn && data.step === openStep.from && event.type !== 'turn/end') {
      data.step = openStep.to
      if (event.type === 'step/end') openStep = null
    }
    if (event.type === 'turn/start') { turnOpen = true; turn = data.turn; stepCounter = 0; openStep = null; unresolved.clear(); mergeNextStart = false }
    else if (event.type === 'turn/end') { turnOpen = false; openStep = null }
    else if (event.type === 'tool/call' && event.data && typeof event.data.callId === 'string') {
      advertised.add(event.data.callId)
      unresolved.set(event.data.callId, event.data.step)
    }
    else if (event.type === 'tool/code-dispatch-start' || event.type === 'tool/code-dispatch') {
      event.type = event.type.replace('code-dispatch', 'ptc-dispatch')
      fixes.push(`seq ${event.seq} 改名 ${event.type}`)
    } else if ((event.type === 'request/context' || event.type === 'request/header') && !turnOpen) {
      fixes.push(`seq ${event.seq} 轮次外的 ${event.type} → 可忽略`)
      drop(event, 'outside an open turn')
    } else if (event.type === 'tool/result' && event.data && event.data.message) {
      const lifted = liftToolResult(event.data.message)
      if (lifted !== null) { event.data.message = lifted; fixes.push(`seq ${event.seq} tool/result 提升为 tool 角色`) }
      const callId = event.data.message.toolCallId ?? event.data.message.source?.callId
      // 这个调用此刻还开着吗？`advertised` 是整份日志累积的，所以它认不出
      // 「第二条」；`unresolved` 在 tool/call 时记上、第一条结果时划掉，正好
      // 是「还开着」的那份账。
      const stillOpen = unresolved.has(callId)
      unresolved.delete(callId)
      if (!advertised.has(callId)) {
        fixes.push(`seq ${event.seq} 结不了任何调用的 tool/result (${callId}) → 可忽略`)
        drop(event, 'settles no advertised call')
      } else if (!stillOpen) {
        fixes.push(`seq ${event.seq} 同一个调用的重复 tool/result (${callId}) → 可忽略`)
        drop(event, 'duplicate result for an already settled call')
      }
    }
    out.push(JSON.stringify(event))
  }
  return fixes.length === 0 ? null : { text: out.join('\n'), fixes }
}

/** 找到本机 dsh 自带的 v4 校验器；找不到就只做规则修复，不做终检。 */
async function loadValidator() {
  try {
    const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim()
    const lib = path.join(globalRoot, '@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js')
    if (!fs.existsSync(lib)) return null
    const { assertV4RowAdmission, assertReleasedV4Relationships } = await import(lib)
    return (text) => {
      const lines = text.split('\n').filter(Boolean)
      const header = JSON.parse(lines[0])
      const events = lines.slice(1).map((line) => JSON.parse(line))
      const known = new Set(events.map((event) => event.type))
      known.delete(DROPPED)
      for (const row of events) assertV4RowAdmission(row, known)
      assertReleasedV4Relationships({ header, events, inheritedEventCount: 0 }, known)
    }
  } catch (error) { return null }
}

function findLogs(target) {
  if (fs.statSync(target).isFile()) return [target]
  const found = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name === 'session.v4.jsonl.zstd') found.push(full)
    }
  }
  walk(target)
  return found
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const target = process.argv[2]
  const apply = process.argv.includes('--apply')
  if (target === undefined) {
    console.error('用法: node scripts/repair-v4-log.mjs <会话目录或 sessions 根目录> [--apply]')
    process.exit(2)
  }
  const validate = await loadValidator()
  if (validate === null) console.log('（没找到本机 dsh 的 v4 校验器，只按规则修，不做终检）')
  let touched = 0
  for (const file of findLogs(target)) {
    const where = path.basename(path.dirname(file))
    const original = readLog(file)
    let result
    try { result = repair(original) } catch (error) { console.error('跳过（解析失败）:', where, error.message); continue }
    if (result === null) {
      if (validate !== null) {
        try { validate(original) } catch (error) { console.log(`仍不合规（这里没有对应的修法）${where}: ${error.message}`) }
      }
      continue
    }
    touched += 1
    console.log(`${apply ? '修复' : '待修复'} ${where}:`)
    for (const fix of result.fixes) console.log('  ' + fix)
    if (validate !== null) {
      try { validate(result.text); console.log('  修复后通过 dsh 的 v4 校验') } catch (error) {
        console.log('  修复后仍不合规，不写回: ' + error.message)
        continue
      }
    }
    if (!apply) continue
    fs.copyFileSync(file, file + '.before-v4-repair')
    writeLog(file, result.text)
  }
  console.log(touched === 0 ? '没有需要修的日志。' : `共 ${touched} 份` + (apply ? '（原件已备份为 .before-v4-repair）' : '；加 --apply 落盘。'))
}
