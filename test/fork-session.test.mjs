// dsh 的「在新对话中分支」只复制转录事件，并在 header 里记下 parentSession；
// 它不认识这个插件，所以底下那个 Claude 不会跟着分支。实测过的后果是：新会话
// 屏幕上留着完整历史，接手的 Claude 却说「我这边没有任何上下文」。
//
// parentClaudeSession 负责找出该从哪个 Claude 会话分支出去，并且在任何一个
// 条件不成立时退回 null——退回今天的行为（起一个全新的 Claude），而不是让
// 启动参数指向一个不存在的 transcript（--resume 对不存在的会话是致命的）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const source = fs.readFileSync(path.join(root, 'src/host.dynamic.js'), 'utf8')

/** 按花括号配平切函数，跳过字符串与注释里的花括号。 */
function sliceFunction(name) {
  const start = source.indexOf(`function ${name}(`)
  assert.notEqual(start, -1, `找不到 ${name}——它被改名或删掉了`)
  const before = source.lastIndexOf('async ', start)
  const from = before !== -1 && source.slice(before + 'async '.length, start).trim() === '' ? before : start
  let depth = 0
  let i = source.indexOf('{', start)
  while (i < source.length) {
    const c = source[i]
    if (c === '"' || c === "'" || c === '`') {
      i += 1
      while (i < source.length && source[i] !== c) i += source[i] === '\\' ? 2 : 1
      i += 1
      continue
    }
    if (c === '/' && source[i + 1] === '/') {
      i = source.indexOf('\n', i)
      if (i === -1) break
      continue
    }
    if (c === '/' && source[i + 1] === '*') {
      i = source.indexOf('*/', i) + 2
      continue
    }
    if (c === '{') depth += 1
    else if (c === '}') {
      depth -= 1
      if (depth === 0) return source.slice(from, i + 1)
    }
    i += 1
  }
  throw new Error(`${name} 的花括号没有配平`)
}

const PARENT = 'session-f156d596-7342-4fba-a995-ee6094ddcd80'
const PARENT_CLAUDE = '69b95e55-f334-4485-99b0-191f82d63a03'
const CWD = '/root/code/deepseek'

function build(world) {
  const looked = []
  const deps = {
    shellQuote: (v) => "'" + String(v).replace(/'/g, "'\\''") + "'",
    projectSlug: (cwd) => String(cwd).replace(/[^A-Za-z0-9]/g, '-'),
    states: new Map(world.states || []),
    sessionOf: () => world.session,
    fileSizeOfShellWord: async (word) => {
      looked.push(word)
      return world.transcriptMissing === true ? 0 : 4096
    },
  }
  const fn = new Function('deps', `
    const { ${Object.keys(deps).join(', ')} } = deps
    ${sliceFunction('parentClaudeSession')}
    return parentClaudeSession
  `)(deps)
  return { parentClaudeSession: fn, looked: looked }
}

const FORKED = { header: { cwd: CWD, parentSession: PARENT, seedLength: 24 } }

test('fork 出来的会话，认出该从父会话的 Claude 分支', async () => {
  const rig = build({
    session: FORKED,
    states: [[PARENT, { mode: 'claude', claudeSessionId: PARENT_CLAUDE }]],
  })
  assert.equal(await rig.parentClaudeSession('s', CWD), PARENT_CLAUDE)
  assert.match(rig.looked[0], /69b95e55.*\.jsonl/, '分支前要确认父 transcript 真在磁盘上')
})

test('不是 fork 出来的会话，照旧全新开始', async () => {
  const rig = build({ session: { header: { cwd: CWD } } })
  assert.equal(await rig.parentClaudeSession('s', CWD), null)
  assert.deepEqual(rig.looked, [], '没有父会话就不必查磁盘')
})

test('父会话本身不是 Claude 驱动的，就没得分支', async () => {
  const rig = build({
    session: FORKED,
    states: [[PARENT, { mode: 'dsh' }]],
  })
  assert.equal(await rig.parentClaudeSession('s', CWD), null)
})

test('父会话的 transcript 已经不在了，退回全新开始', async () => {
  const rig = build({
    session: FORKED,
    states: [[PARENT, { mode: 'claude', claudeSessionId: PARENT_CLAUDE }]],
    transcriptMissing: true,
  })
  assert.equal(await rig.parentClaudeSession('s', CWD), null,
    '--resume 一个不存在的会话会让 CLI 直接退出，而 id 是持久化的——那一轮会永远死在这里')
})

test('会话拿不到（agents 服务还没就绪）也不炸', async () => {
  const rig = build({ session: undefined })
  assert.equal(await rig.parentClaudeSession('s', CWD), null)
})

// 启动参数那一行是这次修复的落点，钉住它：三个开关必须一起出现，
// 而且 --session-id 用的是我们自己分配的新 id（实测三者可以同用，
// 子会话确实继承了父会话的上下文）。
test('分支时的启动参数带齐 --resume / --fork-session / --session-id', () => {
  const launch = source.slice(source.indexOf('if (forkFrom !== null) {'))
  const line = launch.slice(0, launch.indexOf('} else {'))
  assert.match(line, /'--resume', forkFrom/)
  assert.match(line, /'--fork-session'/)
  assert.match(line, /'--session-id', claudeSessionId/)
})
