// 导入面板里那张「这个目录下有哪些 Claude 对话」的清单。
//
// 实测现场：用户在 /home/ricardo/code/courtify/zhongxin 里找一个自己改名叫
// 「微调示例」的对话，列表里怎么都没有。它其实一直在列表第一行，只是顶着
// 最早那个自动名字「Qwen火灾点位检测微调」——取标题用的是 `grep | head -3`，
// 而那次改名躺在 109MB 日志的后半段。对用户来说，这和「没列出来」没有区别。
//
// 现在是一趟 awk 扫完整个文件（109MB 实测 ~90ms，比 tail -n 4000 的 297ms
// 还快，因为这些日志行特别长），所有文件拼成一条命令一次跑完。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const source = fs.readFileSync(path.join(root, 'src/host.dynamic.js'), 'utf8')

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
    if (c === '/' && source[i + 1] === '/') { i = source.indexOf('\n', i); if (i === -1) break; continue }
    if (c === '/' && source[i + 1] === '*') { i = source.indexOf('*/', i) + 2; continue }
    if (c === '{') depth += 1
    else if (c === '}') { depth -= 1; if (depth === 0) return source.slice(from, i + 1) }
    i += 1
  }
  throw new Error(`${name} 的花括号没有配平`)
}

function sliceConst(name) {
  const key = 'const ' + name + ' = '
  const at = source.indexOf(key)
  assert.notEqual(at, -1, `找不到 ${name}`)
  let end = at
  for (;;) {
    const nl = source.indexOf('\n', end)
    if (source.slice(nl + 1).match(/^\s*\+/) === null) return source.slice(at, nl)
    end = nl + 1
  }
}

/** 造一个项目目录，每份 transcript 一组事件行。返回 cwd。 */
function project(files) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccmode-list-'))
  const cwd = '/work/proj'
  const dir = path.join(home, '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'))
  fs.mkdirSync(dir, { recursive: true })
  for (const [id, lines] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, id + '.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  }
  return { home: home, cwd: cwd }
}

function build(home) {
  const deps = {
    CONVERSATION_LIST_LIMIT: 120,
    shellQuote: (v) => "'" + String(v).replace(/'/g, "'\\''") + "'",
    projectSlug: (cwd) => String(cwd).replace(/[^A-Za-z0-9]/g, '-'),
    // 真的跑 shell：那条 awk 本身就是被测对象。
    captureOn: (command) => {
      try {
        return execFileSync('/bin/sh', ['-c', command],
          { env: { ...process.env, HOME: home }, maxBuffer: 1 << 26 }).toString()
      } catch (error) { return '' }
    },
  }
  return new Function('deps', `
    const { ${Object.keys(deps).join(', ')} } = deps
    ${sliceConst('TITLE_RULES')}
    ${sliceConst('TITLE_PICK')}
    ${sliceFunction('titleOfLine')}
    ${sliceFunction('textOfClaudeMessage')}
    ${sliceFunction('listClaudeConversations')}
    return listClaudeConversations
  `)(deps)
}

const user = (text) => ({ type: 'user', message: { role: 'user', content: text } })

test('人手改的名字要显示出来，哪怕它埋在几百条自动标题底下', async () => {
  const lines = [user('帮我微调一个模型'), { type: 'ai-title', aiTitle: 'Qwen火灾点位检测微调', sessionId: 'a' }]
  for (let i = 0; i < 200; i += 1) lines.push({ type: 'assistant', message: { role: 'assistant', content: '嗯' } })
  lines.push({ type: 'custom-title', customTitle: '微调示例', sessionId: 'a' })
  for (let i = 0; i < 200; i += 1) lines.push({ type: 'ai-title', aiTitle: '又一个自动名字 ' + i, sessionId: 'a' })
  const p = project({ 'aaaaaaaa-0000-0000-0000-000000000001': lines })
  const rows = await build(p.home)(p.cwd, null)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].title, '微调示例')
})

test('没改过名就用 Claude 起的；一个都没有就用第一句话', async () => {
  const p = project({
    'aaaaaaaa-0000-0000-0000-000000000002': [user('你好'), { type: 'ai-title', aiTitle: '自动名字', sessionId: 'b' }],
    'aaaaaaaa-0000-0000-0000-000000000003': [user('这个对话还没来得及起名')],
  })
  const rows = await build(p.home)(p.cwd, null)
  const byId = new Map(rows.map((r) => [r.claudeSessionId.slice(-1), r]))
  assert.equal(byId.get('2').title, '自动名字')
  assert.equal(byId.get('3').title, '这个对话还没来得及起名',
    '兜底那条 user 事件必须是完整可解析的 JSON，截断过就 parse 不出来了')
})

test('一条命令列完所有对话，不是一个文件一趟', async () => {
  const files = {}
  for (let i = 0; i < 12; i += 1) {
    files['aaaaaaaa-0000-0000-0000-0000000001' + String(i).padStart(2, '0')] = [user('第 ' + i + ' 个')]
  }
  const p = project(files)
  const calls = []
  const made = build(p.home)
  const rows = await made(p.cwd, null)
  assert.equal(rows.length, 12)
  // 扫描那趟必须只有一条命令：40 个文件 40 次 ssh 往返，用户要等十几秒。
  const body = sliceFunction('listClaudeConversations')
  assert.match(body, /rows\.map\(\(row\) => awkProgram \+ shellQuote\(row\.path\)[^)]*\)\.join\('; '\)/,
    '所有文件要拼成一条命令')
  assert.equal((body.match(/await captureOn\(/g) || []).length, 2,
    '一趟列文件、一趟读内容，就这两次')
})

test('认不出来的行只是跳过，不会串到别的对话头上', async () => {
  const p = project({
    'aaaaaaaa-0000-0000-0000-000000000004': [user('甲'), { type: 'custom-title', customTitle: '甲的名字', sessionId: 'c' }],
    'aaaaaaaa-0000-0000-0000-000000000005': [user('乙')],
  })
  const list = build(p.home)
  const rows = await list(p.cwd, null)
  const four = rows.find((r) => r.claudeSessionId.endsWith('4'))
  const five = rows.find((r) => r.claudeSessionId.endsWith('5'))
  assert.equal(four.title, '甲的名字')
  assert.equal(five.title, '乙', '没有标题的那个不该捡到邻居的')
})

test('列表上限够大——曾经卡在 40，恰好切掉用户要找的那个', () => {
  const at = source.indexOf('const CONVERSATION_LIST_LIMIT = ')
  assert.notEqual(at, -1)
  const limit = parseInt(source.slice(at).match(/= (\d+)/)[1], 10)
  assert.ok(limit >= 100, '一个用了一年的项目轻松上百个对话，' + limit + ' 太小')
})
