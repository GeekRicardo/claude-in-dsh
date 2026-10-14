// 对账：Claude 实际说了什么（broker 的 out.log） vs dsh 会话日志里呈现了什么。
//
// 「前端没输出，但 Claude 那边已经干了很多」时第一件该做的事：逐个比对工具调用
// id 和每段正文，告诉你缺了哪几样、落在哪一轮。
//
// 用法（在跑 dsh 的机器上）：
//   node scripts/audit-session.mjs <session-id> [ssh-host]
// 给了 ssh-host 就从那台机器取 out.log（远端档），不给就读本机的。
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const id = process.argv[2]
const host = process.argv[3]
if (id === undefined) { console.error('用法: node scripts/audit-session.mjs <session-id> [ssh-host]'); process.exit(2) }
const raw = host === undefined
  ? fs.readFileSync(`/tmp/ccmode/${id}/out.log`, 'utf8')
  : execFileSync('ssh', [host, `cat /tmp/ccmode/${id}/out.log`], { maxBuffer: 1 << 30 }).toString()

// ---- 远端：主线程（parent 为空）上 Claude 产出的东西
const remoteCalls = []
const remoteTexts = []
let results = 0
for (const line of raw.split('\n')) {
  if (!line.trim()) continue
  let e; try { e = JSON.parse(line) } catch { continue }
  if (e.type === 'result') results += 1
  if (e.type !== 'assistant' || e.parent_tool_use_id) continue
  if (e.message?.model === '<synthetic>') continue // /context 之类插件自己的带外命令
  for (const b of e.message?.content || []) {
    if (b.type === 'tool_use') remoteCalls.push(b.id)
    if (b.type === 'text' && b.text.trim()) remoteTexts.push(b.text.trim())
  }
}

// ---- dsh：会话日志
const root = path.join(process.env.HOME, '.dsh/sessions')
const find = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) { if (e.name === id) return path.join(f, 'session.v4.jsonl.zstd'); const r = find(f); if (r) return r } } }
const file = find(root)
const rows = execFileSync('zstd', ['-dcq', file], { maxBuffer: 1 << 30 }).toString().split('\n').filter(Boolean).slice(1).map((l) => JSON.parse(l))
const dshCalls = new Set(rows.filter((r) => r.type === 'tool/call').map((r) => r.data.callId))
const dshResults = new Set(rows.filter((r) => r.type === 'tool/result').map((r) => r.data.message.toolCallId ?? r.data.message.source?.callId))
const dshText = rows.filter((r) => r.type === 'assistant/message').flatMap((r) => r.data.message.content).filter((b) => b.type === 'text').map((b) => b.text).join('\n')

const missingCalls = remoteCalls.filter((c) => !dshCalls.has(c))
const unanswered = [...dshCalls].filter((c) => !dshResults.has(c))
const missingTexts = remoteTexts.filter((t) => !dshText.includes(t.slice(0, 60)))
const turns = rows.filter((r) => r.type === 'turn/start').length
const badEnds = rows.filter((r) => r.type === 'turn/end' && !['completed', 'blocked'].includes(r.data.reason?.kind)).map((r) => r.data.turn + ':' + r.data.reason?.kind)

console.log(`远端: ${raw.length} 字节, ${results} 个 result, ${remoteCalls.length} 次工具调用, ${remoteTexts.length} 段文字`)
console.log(`dsh : ${turns} 轮, ${dshCalls.size} 次工具调用, ${dshResults.size} 个结果`)
console.log(`缺失的工具调用: ${missingCalls.length}${missingCalls.length ? ' ' + missingCalls.join(',') : ''}`)
console.log(`没有结果的调用: ${unanswered.length}${unanswered.length ? ' ' + unanswered.join(',') : ''}`)
console.log(`缺失的文字段: ${missingTexts.length}`)
for (const t of missingTexts) console.log('  - ' + t.slice(0, 100).replace(/\n/g, ' '))
console.log(`非正常收尾的轮次: ${badEnds.length ? badEnds.join(' ') : '无'}`)
