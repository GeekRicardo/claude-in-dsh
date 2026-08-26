// 把 Claude 自己起的会话名带回 dsh。标题只写在 Claude 的 transcript 里
// （流里没有），所以这半是读文件；写入这半要守住一条线：人手改过的标题不碰。
// 函数住在引擎体的闭包里，照 user-questions 的做法按名字切出源码单独求值。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const source = fs.readFileSync(path.join(root, 'src/host.dynamic.js'), 'utf8')

/**
 * 按花括号配平切出函数源码，但要跳过字符串和注释里的花括号——被切的
 * `lastAiTitle` 里就有个 grep 模式 `{"type":"ai-title"`，只数字符会当场数错，
 * 切出半截函数。（认识 '' "" `` 和两种注释；不认识正则字面量，将来往这些
 * 函数里写 /.../ 时要留意。）
 */
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

/** 造一个 Claude transcript，返回 (cwd, sessionId) 让被测函数照常去找它。 */
function transcript(lines) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccmode-title-'))
  const cwd = '/root/code/zx'
  const slug = cwd.replace(/[^A-Za-z0-9]/g, '-')
  const dir = path.join(home, '.claude', 'projects', slug)
  fs.mkdirSync(dir, { recursive: true })
  const id = '11111111-2222-3333-4444-555555555555'
  fs.writeFileSync(path.join(dir, id + '.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  return { home: home, cwd: cwd, id: id }
}

function buildRead(home) {
  const deps = {
    shellQuote: (v) => "'" + String(v).replace(/'/g, "'\\''") + "'",
    projectSlug: (cwd) => String(cwd).replace(/[^A-Za-z0-9]/g, '-'),
    // 真的跑 shell：tail | grep 那条管线本身也是被测的一部分。
    runCapture: (argv) => {
      try {
        return execFileSync(argv[0], argv.slice(1), { env: { ...process.env, HOME: home }, maxBuffer: 1 << 26 }).toString()
      } catch (error) { return '' }
    },
  }
  return new Function('deps', `
    const { ${Object.keys(deps).join(', ')} } = deps
    ${sliceFunction('lastAiTitle')}
    return lastAiTitle
  `)(deps)
}

test('读出 Claude 写下的最后一个标题', async () => {
  const t = transcript([
    { type: 'ai-title', aiTitle: '早先的名字', sessionId: 'x' },
    { type: 'user', message: { role: 'user', content: '继续' } },
    { type: 'ai-title', aiTitle: 'Claude.md p0 cluster login rule', sessionId: 'x' },
  ])
  const lastAiTitle = buildRead(t.home)
  assert.equal(await lastAiTitle(t.cwd, t.id), 'Claude.md p0 cluster login rule')
})

test('对话里"提到" ai-title 不算标题', async () => {
  // 这不是假想的：一个讨论标题同步的会话，会把 {"type":"ai-title"…} 原样
  // 写进自己的工具输出和正文。只按字符串匹配，会把它自己的聊天当成标题
  // ——我在查这件事时就先被这样骗过一次。
  const t = transcript([
    { type: 'ai-title', aiTitle: '真正的标题', sessionId: 'x' },
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '标题长这样：{"type":"ai-title","aiTitle":"冒牌货","sessionId":"x"}' }],
      },
    },
    {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', content: '{"type":"ai-title","aiTitle":"另一个冒牌货"}' }],
      },
    },
  ])
  const lastAiTitle = buildRead(t.home)
  assert.equal(await lastAiTitle(t.cwd, t.id), '真正的标题')
})

test('还没起名字就返回空', async () => {
  const t = transcript([{ type: 'user', message: { role: 'user', content: '你好' } }])
  const lastAiTitle = buildRead(t.home)
  assert.equal(await lastAiTitle(t.cwd, t.id), '')
})

test('transcript 不存在也不炸', async () => {
  const t = transcript([])
  const lastAiTitle = buildRead(t.home)
  assert.equal(await lastAiTitle(t.cwd, 'no-such-session'), '')
  assert.equal(await lastAiTitle('', t.id), '')
})

// —— 写入这半 ——

function buildWrite(world) {
  const calls = { renamed: [], refreshed: 0, persisted: 0 }
  const state = { mode: 'claude', claudeSessionId: 'cs', ...(world.state || {}) }
  const deps = {
    errorText: String,
    stateOf: () => state,
    runs: new Map(),
    titleRefreshed: new Set(),
    persistStates: () => { calls.persisted += 1 },
    lastAiTitle: async () => world.claudeTitle,
    sessionTitle: world.noService === true ? undefined : {
      get: () => world.snapshot,
      rename: (session, title) => {
        if (world.renameThrows === true) throw new Error('session is not live in this store')
        calls.renamed.push(title)
      },
      refresh: async () => {
        calls.refreshed += 1
        if (world.refreshThrows === true) throw new Error('no provider registered')
      },
    },
  }
  const fn = new Function('deps', `
    const { ${Object.keys(deps).join(', ')} } = deps
    ${sliceFunction('syncClaudeTitle')}
    return syncClaudeTitle
  `)(deps)
  return { syncClaudeTitle: fn, calls: calls, state: state }
}

const SESSION = { header: { cwd: '/root/code/zx' } }

test('dsh 还没有标题时，用 Claude 的', async () => {
  const rig = buildWrite({ claudeTitle: 'Claude 起的名字', snapshot: undefined })
  assert.equal(await rig.syncClaudeTitle('s', SESSION), true)
  assert.deepEqual(rig.calls.renamed, ['Claude 起的名字'])
  assert.equal(rig.state.titleWritten, 'Claude 起的名字')
})

test('dsh 自动生成的标题会被 Claude 的顶掉', async () => {
  const rig = buildWrite({
    claudeTitle: 'Claude 起的名字',
    snapshot: { title: 'dsh 猜的名字', source: { kind: 'provider', provider: 'session-title-llm' } },
  })
  assert.equal(await rig.syncClaudeTitle('s', SESSION), true)
  assert.deepEqual(rig.calls.renamed, ['Claude 起的名字'])
})

test('人手改过的标题永不覆盖', async () => {
  const rig = buildWrite({
    claudeTitle: 'Claude 起的名字',
    snapshot: { title: '我自己取的', source: { kind: 'user' } },
  })
  assert.equal(await rig.syncClaudeTitle('s', SESSION), false)
  assert.deepEqual(rig.calls.renamed, [])
  assert.equal(rig.state.titleWritten, '我自己取的', '记下来，以后每一轮都认这个')
})

test('自己写过之后，Claude 改名还能跟上', async () => {
  const rig = buildWrite({
    claudeTitle: '第二版名字',
    state: { titleWritten: '第一版名字' },
    snapshot: { title: '第一版名字', source: { kind: 'user' } },
  })
  assert.equal(await rig.syncClaudeTitle('s', SESSION), true, 'user 来源是 rename 自己留下的，不是人改的')
  assert.deepEqual(rig.calls.renamed, ['第二版名字'])
})

test('自己写过之后又被人改名，就此收手', async () => {
  const rig = buildWrite({
    claudeTitle: '第二版名字',
    state: { titleWritten: '第一版名字' },
    snapshot: { title: '人手改的', source: { kind: 'user' } },
  })
  assert.equal(await rig.syncClaudeTitle('s', SESSION), false)
  assert.deepEqual(rig.calls.renamed, [])
  assert.equal(rig.state.titleWritten, '人手改的')
})

test('标题没变就不重复写', async () => {
  const rig = buildWrite({
    claudeTitle: '一样的名字',
    state: { titleWritten: '一样的名字' },
    snapshot: { title: '一样的名字', source: { kind: 'user' } },
  })
  assert.equal(await rig.syncClaudeTitle('s', SESSION), false)
  assert.deepEqual(rig.calls.renamed, [])
})

test('DSH 引擎的会话不碰', async () => {
  const rig = buildWrite({ claudeTitle: 'Claude 起的名字', state: { mode: 'dsh' } })
  assert.equal(await rig.syncClaudeTitle('s', SESSION), false)
  assert.deepEqual(rig.calls.renamed, [])
})

test('宿主没有 sessionTitle 服务时安静跳过', async () => {
  const rig = buildWrite({ claudeTitle: 'Claude 起的名字', noService: true })
  assert.equal(await rig.syncClaudeTitle('s', SESSION), false)
})

// —— Claude 没起名时，请 dsh 自己来 ——
// dsh 的 title provider 把活标记成 pending 之后，要靠 request/header 或 dsh
// 自己那次模型调用去启动，而 Claude 驱动的会话两样都不产生。于是标题永远停在
// fallback（截断的首句）。refresh 是这个服务留的显式入口。

test('Claude 没起名而标题还是 fallback，就请 dsh 起', async () => {
  const rig = buildWrite({
    claudeTitle: '',
    snapshot: { title: '你看下cc-in-dsh 里我再dsh里的一', source: { kind: 'fallback' } },
  })
  assert.equal(await rig.syncClaudeTitle('s', SESSION), false)
  assert.equal(rig.calls.refreshed, 1)
  assert.deepEqual(rig.calls.renamed, [], 'refresh 由 dsh 自己写回，不该再 rename')
})

test('同一个会话只请一次', async () => {
  const rig = buildWrite({
    claudeTitle: '',
    snapshot: { title: 'fallback 标题', source: { kind: 'fallback' } },
  })
  await rig.syncClaudeTitle('s', SESSION)
  await rig.syncClaudeTitle('s', SESSION)
  await rig.syncClaudeTitle('s', SESSION)
  assert.equal(rig.calls.refreshed, 1, '每轮都请就是每轮都花一次模型调用')
})

test('已经有正经标题了就不请', async () => {
  const rig = buildWrite({
    claudeTitle: '',
    snapshot: { title: 'dsh 起好的名字', source: { kind: 'provider', provider: 'session-title-llm' } },
  })
  assert.equal(await rig.syncClaudeTitle('s', SESSION), false)
  assert.equal(rig.calls.refreshed, 0)
})

test('人手改过的标题，也不请', async () => {
  const rig = buildWrite({
    claudeTitle: '',
    snapshot: { title: '我自己取的', source: { kind: 'user' } },
  })
  assert.equal(await rig.syncClaudeTitle('s', SESSION), false)
  assert.equal(rig.calls.refreshed, 0, 'refresh 会覆盖用户标题——它自己的文档就是这么写的')
})

test('refresh 抛错不会带走这一轮', async () => {
  const rig = buildWrite({
    claudeTitle: '',
    snapshot: { title: 'fallback 标题', source: { kind: 'fallback' } },
    refreshThrows: true,
  })
  assert.equal(await rig.syncClaudeTitle('s', SESSION), false)
})

test('rename 抛错不会带走这一轮', async () => {
  const rig = buildWrite({ claudeTitle: 'Claude 起的名字', snapshot: undefined, renameThrows: true })
  assert.equal(await rig.syncClaudeTitle('s', SESSION), false)
  assert.equal(rig.state.titleWritten, undefined, '没写成就不该记成写过了')
})
