// dsh-native 镜像：Claude Code 的后台任务要出现在 dsh 自己的面上——
// 普通任务入账成 ctx.jobs 行（后台任务区），Agent/Task 工具调用镜像成
// 真正的 subagent 子会话（卡片区）。这些函数住在引擎体闭包里，照
// idle-drain 的做法按名字切出源码单独求值——改名或删掉时测试会响。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const source = fs.readFileSync(path.join(root, 'src/host.dynamic.js'), 'utf8')

function sliceFunction(name) {
  const start = source.indexOf(`function ${name}(`)
  assert.notEqual(start, -1, `找不到 ${name}——它被改名或删掉了`)
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

/**
 * dsh 的 surface 规则，逐字照抄自 `Session.append`：三种产消息的事件必须带
 * `surfaceOp`，其余任何类型带了就抛。假 session 以前不校验这一条，于是镜像给
 * 每条事件都盖了标记、`tool/call` 和 `turn/end` 全在 catch 里被吞掉，而测试一
 * 路绿灯。这里把规则搬进来，同样的错就再也过不去。
 */
function appendChecked(events, type, data, opts) {
  const eligible = type === 'user/message' || type === 'assistant/message' || type === 'tool/result'
  if (eligible && (opts === undefined || opts.surfaceOp === undefined)) {
    throw new Error(`session event "${type}" is surface-eligible and requires a surfaceOp marker`)
  }
  if (!eligible && opts !== undefined && opts.surfaceOp !== undefined) {
    throw new Error(`session event "${type}" is not surface-eligible and cannot carry surfaceOp`)
  }
  events.push({ type, data })
}

/** 一块足够真实的会话模拟：记录 append 的事件，detach 记录收尾。 */
function makeSession(events) {
  return {
    id: 'session-main',
    header: { cwd: '/root/code/zx' },
    append(type, data, opts) { appendChecked(events, type, data, opts) },
  }
}

function makeChildSession(events) {
  return {
    id: 'session-child',
    header: { origin: 'subagent', parentSession: 'session-main', cwd: '/root/code/zx' },
    events,
    append(type, data, opts) { appendChecked(events, type, data, opts) },
  }
}

/** 镜像用的小型注入面（与引擎体内真实依赖同形）。 */
function build(overrides) {
  const calls = { starts: [], waits: 0, detaches: [], errors: [] }
  const sessions = { prepares: [], announced: 0 }
  const deps = {
    PROVIDER: 'claude-code',
    uuid: () => 'u-00000000-0000-4000-8000-000000000000',
    errorText: (error) => String(error && error.message ? error.message : error),
    runs: new Map(),
    sessionsStore: {
      prepare: (id, options) => {
        sessions.prepares.push({ id, options })
        return makeChildSession([])
      },
      enter: (child) => () => { calls.detaches.push(child.id) },
      announce: () => { sessions.announced += 1 },
    },
    jobs: {
      start: (spec) => { calls.starts.push(spec); return 'claude-task-' + (calls.starts.length) },
      wait: async () => { calls.waits += 1 },
    },
    // 投影用的块转换不是本测试的对象；给一个同形的最小实现。
    assistantBlocksOf: (content) => (content || [])
      .filter((block) => block.type === 'text' || block.type === 'tool_use')
      .map((block) => block.type === 'text'
        ? { type: 'text', text: block.text }
        : { type: 'tool-call', id: block.id, name: block.name, arguments: JSON.stringify(block.input || {}) }),
    resultBlocksOf: (content) => typeof content === 'string' ? [{ type: 'text', text: content }] : [],
    ...overrides,
  }
  const names = [
    'firstLineOf', 'ccTaskLabel', 'spawnCcSubagent', 'spawnCcSubagentsFrom',
    'ccChildAppend', 'ccChildCloseStep', 'ccChildStep',
    'mirrorParentedAssistant', 'mirrorParentedResult',
    'findCcSubagentByLabel', 'ccTaskStarted', 'finalizeCcSubagent', 'ccTaskNotification',
    'cleanupCcMirror',
  ]
  const made = new Function('deps', `
    const SURFACE_EVENT_TYPES = new Set(['user/message', 'assistant/message', 'tool/result'])
    const { ${Object.keys(deps).join(', ')} } = deps
    ${names.map(sliceFunction).join('\n')}
    return { ${names.join(', ')} }
  `)(deps)
  return { ...made, calls, sessions }
}

function makeRun() {
  return { ccSubagents: new Map(), ccTasks: new Map() }
}

const AGENT_TOOL_USE = {
  content: [{ type: 'tool_use', id: 'toolu_agent_1', name: 'Agent', input: { description: '优化压缩方案', subagent_type: 'general-purpose' } }],
}

test('普通后台任务入账成 ctx.jobs 行，通知到达时结算', () => {
  const rig = build()
  const run = makeRun()
  const agent = { id: 'session-main' }

  rig.ccTaskStarted(run, agent, {
    task_id: 'byyew76rg',
    description: 'sleep 600\n\n背景里等十分钟',
  })

  assert.equal(rig.calls.starts.length, 1, '应该开一行 job')
  const spec = rig.calls.starts[0]
  assert.equal(spec.kind, 'claude-task')
  assert.equal(spec.label, 'sleep 600', 'label 取描述首行')
  assert.equal(spec.owner, agent)
  assert.equal(typeof spec.run, 'function')
  const hooks = spec.run()
  assert.equal(typeof hooks.cancel, 'function')
  assert.equal(typeof hooks.done.then, 'function')
  assert.equal(rig.calls.waits, 1, '停靠一个 waiter，结算时 tool-jobs 的完成通知就会被跳过')
  assert.ok(run.ccTasks.has('byyew76rg'))

  rig.ccTaskNotification(run, agent, {
    task_id: 'byyew76rg',
    summary: 'Background command 完成 (exit code 0)',
  })
  assert.equal(run.ccTasks.size, 0, '结算后出账')
  // done 以 completed + 摘要结算（结算本身把 snapshot 标记为 reported）。
})

test('Agent 工具调用镜像成 subagent 子会话并带 descriptor', () => {
  const rig = build()
  const run = makeRun()
  const main = makeSession([])

  rig.spawnCcSubagentsFrom(run, main, AGENT_TOOL_USE)

  assert.equal(rig.sessions.prepares.length, 1, '应该建一个子会话')
  const [prepared] = rig.sessions.prepares
  assert.match(prepared.id, /^session-u-/, '子会话 id 独立生成')
  assert.deepEqual(prepared.options.meta, {
    origin: 'subagent',
    parentSession: 'session-main',
    cwd: '/root/code/zx',
    delegationDepth: 1,
  })
  assert.equal(rig.sessions.announced, 1, 'announce 后客户端列表才看得到')
  assert.equal(rig.calls.detaches.length, 0, '运行中不收尾')

  const record = run.ccSubagents.get('toolu_agent_1')
  assert.ok(record, '按工具调用 id 记录')
  assert.equal(record.label, '优化压缩方案')
  assert.equal(record.child.events[0].type, 'subagent/descriptor')
  const descriptor = record.child.events[0].data
  assert.equal(descriptor.version, 2)
  assert.equal(descriptor.mode, 'one-shot')
  assert.equal(descriptor.provider, 'claude-code')
  assert.equal(descriptor.label, '优化压缩方案')
  // 打开一轮，让子会话不再是 blank（无 turn/start 的会话会被部分列表基线藏起来）。
  assert.equal(record.child.events[1].type, 'turn/start')
  assert.deepEqual(record.child.events[1].data, { turn: 1 })
})

test('Agent 任务不再重复开 job 行，通知按 task_id 收尾子会话', () => {
  const rig = build()
  const run = makeRun()
  const agent = { id: 'session-main' }

  rig.spawnCcSubagentsFrom(run, makeSession([]), AGENT_TOOL_USE)
  rig.ccTaskStarted(run, agent, {
    task_id: 'a651f009645e8d8c0',
    description: '优化压缩方案',
  })

  assert.equal(rig.calls.starts.length, 0, 'Agent 任务由卡片覆盖，不开 job 行')
  assert.deepEqual(run.ccTasks.get('a651f009645e8d8c0'), { child: run.ccSubagents.get('toolu_agent_1') })

  // 父级流镜像进子会话：主 agent 写什么，子会话就写什么——step 括号、
  // assistant/message、tool/call 一个不少。dsh 的工具卡片就是从 tool/call
  // 起头的，少了它，dsh-better-tool-ui 连工具名都拿不到。
  rig.mirrorParentedAssistant(run, 'toolu_agent_1', {
    content: [
      { type: 'text', text: '我先读代码。' },
      { type: 'tool_use', id: 'toolu_sub_1', name: 'Grep', input: { pattern: 'compress', path: 'crates' } },
    ],
  })
  const child = run.ccSubagents.get('toolu_agent_1').child
  assert.deepEqual(child.events.map((event) => event.type),
    ['subagent/descriptor', 'turn/start', 'step/start', 'assistant/message', 'tool/call'])
  const call = child.events[4].data
  assert.deepEqual({ turn: call.turn, step: call.step, callId: call.callId, name: call.name },
    { turn: 1, step: 1, callId: 'toolu_sub_1', name: 'Grep' })

  rig.mirrorParentedResult(run, 'toolu_agent_1', {
    content: [{ type: 'tool_result', tool_use_id: 'toolu_sub_1', content: '3 处', is_error: false }],
  })
  assert.equal(child.events[5].type, 'tool/result')
  assert.equal(child.events[5].data.message.source.callId, 'toolu_sub_1')

  // 通知带报告：报告落进子会话，子会话收尾（关步 + turn/end）。
  rig.ccTaskNotification(run, agent, {
    task_id: 'a651f009645e8d8c0',
    summary: '方案已完成并落盘：/root/code/zx/plans/optimization.md',
  })
  assert.deepEqual(child.events.slice(6).map((event) => event.type),
    ['step/end', 'step/start', 'assistant/message', 'step/end', 'turn/end'])
  assert.match(child.events[8].data.message.content[0].text, /方案已完成/)
  assert.deepEqual(child.events.at(-1).data, { turn: 1, reason: { kind: 'completed' } })
  assert.deepEqual(rig.calls.detaches, [child.id], '收尾时释放子会话（转 persistence，卡片变 inactive）')
  assert.equal(run.ccSubagents.size, 0)
  assert.equal(run.ccTasks.size, 0)
})

test('报告与子代理自己的收尾发言重复时，不再打印两遍', () => {
  const rig = build()
  const run = makeRun()
  rig.spawnCcSubagentsFrom(run, makeSession([]), AGENT_TOOL_USE)
  const child = run.ccSubagents.get('toolu_agent_1').child

  rig.mirrorParentedAssistant(run, 'toolu_agent_1', { content: [{ type: 'text', text: '方案已完成。' }] })
  rig.ccTaskNotification(run, { id: 'session-main' }, { task_id: 'x', summary: '方案已完成。' })

  const texts = child.events
    .filter((event) => event.type === 'assistant/message')
    .map((event) => event.data.message.content[0].text)
  assert.deepEqual(texts, ['方案已完成。'], '通知里的报告就是子代理最后那句，不该再抄一遍')
})

test('run 断了也不留悬空的工具卡片：未答复的调用补一个中断结果', () => {
  const rig = build()
  const run = makeRun()
  rig.spawnCcSubagentsFrom(run, makeSession([]), AGENT_TOOL_USE)
  const child = run.ccSubagents.get('toolu_agent_1').child

  rig.mirrorParentedAssistant(run, 'toolu_agent_1', {
    content: [{ type: 'tool_use', id: 'toolu_sub_1', name: 'Bash', input: { command: 'ls' } }],
  })
  rig.cleanupCcMirror(run)

  const result = child.events.find((event) => event.type === 'tool/result')
  assert.ok(result, '没等到结果的调用必须自己有个结果，否则卡片永远转下去')
  assert.equal(result.data.message.content[0].isError, true)
  assert.deepEqual(child.events.at(-1).data, { turn: 1, reason: { kind: 'interrupted' } })
})

test('descriptor 相同但任务启动事件错过的通知，折叠进唯一挂起的子会话', () => {
  const rig = build()
  const run = makeRun()

  rig.spawnCcSubagentsFrom(run, makeSession([]), AGENT_TOOL_USE)
  rig.ccTaskNotification(run, { id: 'session-main' }, {
    task_id: 'a651f009645e8d8c0',
    summary: '方案已完成',
  })
  assert.equal(rig.calls.detaches.length, 1, '唯一挂起子会话收到报告并收尾')
})

test('run 收尾时清理镜像：挂起的子会话全部释放', () => {
  const rig = build()
  const run = makeRun()

  rig.spawnCcSubagentsFrom(run, makeSession([]), AGENT_TOOL_USE)
  rig.ccTaskStarted(run, { id: 'session-main' }, { task_id: 'x1', description: 'sleep 60' })
  assert.equal(rig.calls.starts.length, 1)

  rig.cleanupCcMirror(run)
  assert.equal(rig.calls.detaches.length, 1, '挂起子会话收尾')
  assert.equal(run.ccSubagents.size, 0)
  assert.equal(run.ccTasks.size, 0)
})

test('非 Agent 工具（Bash 前台调用）不镜像子会话', () => {
  const rig = build()
  const run = makeRun()

  rig.spawnCcSubagentsFrom(run, makeSession([]), {
    content: [{ type: 'tool_use', id: 'toolu_bash_1', name: 'Bash', input: { command: 'ls' } }],
  })
  assert.equal(rig.sessions.prepares.length, 0, '只有 Agent/Task 才建子会话')
})
