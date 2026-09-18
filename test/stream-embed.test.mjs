// dsh 0.1.5-rc.2 把一步的模型流从「一串 assistant/chunk 事件」改成「内嵌在这
// 一步的 assistant/message 里」。旧写法不是降级而是致命：带 assistant/chunk
// 的日志被整份拒绝（"unknown to this harness … refusing to interpret the log"），
// 那一天每一轮 Claude 都停了，本机档和远端档一起。
//
// 内嵌形态是压缩过的，dsh 在读的时候会校验（expandAssistantStream）。所以这里
// 按它的规则做往返：打包 → 展开，必须一字不差地还原原始 chunk 序列。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const source = fs.readFileSync(path.join(root, 'src/host.dynamic.js'), 'utf8')

function sliceFunction(name) {
  const start = source.indexOf(`function ${name}(`)
  assert.notEqual(start, -1, `找不到 ${name}`)
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
const packer = new Function(`${names.map(sliceFunction).join('\n')}\nreturn { ${names.join(', ')} }`)()

/** dsh 的 expandAssistantStream，照着它的实现写：run 展开成逐条 chunk。 */
function expand(stream) {
  const out = []
  for (const record of stream) {
    if (record.type === 'chunk') { out.push(record.chunk); continue }
    const members = record.type === 'tool-call-chunks' ? record.args : record.texts
    for (let i = 0; i < members.length; i += 1) {
      if (record.type === 'text-chunks') out.push({ type: 'text-delta', index: record.index, text: members[i] })
      else if (record.type === 'reasoning-chunks') out.push({ type: 'reasoning-delta', index: record.index, text: members[i] })
      else {
        out.push({
          type: 'tool-call-delta',
          index: record.index,
          id: record.id,
          ...(Object.hasOwn(record, 'name') ? { name: record.name } : {}),
          argumentsDelta: members[i],
        })
      }
    }
  }
  return out
}

/**
 * dsh 展开 run 时，会把这次调用的 name 补到它每一条增量上——name 是「这个调用」
 * 的属性，不是某一条增量的。所以往返比的是补齐之后的等价，不是逐字节相同。
 */
function normalize(chunks) {
  const nameOf = new Map()
  for (const chunk of chunks) {
    if (chunk.type === 'tool-call-delta' && typeof chunk.name === 'string') nameOf.set(chunk.id, chunk.name)
  }
  return chunks.map((chunk) => {
    if (chunk.type !== 'tool-call-delta' || !nameOf.has(chunk.id)) return chunk
    return { type: chunk.type, index: chunk.index, id: chunk.id, name: nameOf.get(chunk.id), argumentsDelta: chunk.argumentsDelta }
  })
}

/** dsh 在读的时候会拒掉的每一种形状，这里同样拒掉。 */
function assertValid(stream) {
  for (const record of stream) {
    if (record.type === 'chunk') {
      assert.deepEqual(Object.keys(record).sort(), ['chunk', 'time', 'type'], 'raw 记录只能有这三个键')
      assert.ok(Number.isSafeInteger(record.time))
      continue
    }
    const members = record.type === 'tool-call-chunks' ? record.args : record.texts
    const expected = record.type === 'tool-call-chunks'
      ? (Object.hasOwn(record, 'name') ? ['args', 'dt', 'id', 'index', 'name', 'time0', 'type'] : ['args', 'dt', 'id', 'index', 'time0', 'type'])
      : ['dt', 'index', 'texts', 'time0', 'type']
    assert.deepEqual(Object.keys(record).sort(), expected, record.type + ' 的键必须刚好是这些')
    assert.ok(members.length > 0, '成员不能为空')
    assert.equal(record.dt.length, members.length - 1, 'dt 必须比成员少一个')
    assert.ok(record.dt.every((gap) => Number.isSafeInteger(gap)), 'dt 必须都是安全整数')
    assert.ok(Number.isSafeInteger(record.time0) && record.index >= 0)
  }
}

function pack(chunks) {
  const step = { stream: [], streamAt: 0 }
  for (const chunk of chunks) packer.appendChunk(step, chunk)
  return step.stream
}

test('一个块的连续文本增量压成一条 run', () => {
  const chunks = [
    { type: 'text-delta', index: 0, text: '你' },
    { type: 'text-delta', index: 0, text: '好' },
    { type: 'text-delta', index: 0, text: '啊' },
  ]
  const stream = pack(chunks)
  assert.equal(stream.length, 1, '三条增量应该只占一条记录')
  assert.equal(stream[0].type, 'text-chunks')
  assert.deepEqual(stream[0].texts, ['你', '好', '啊'])
  assertValid(stream)
  assert.deepEqual(expand(stream), normalize(chunks), '展开必须原样还原')
})

test('换了块就换一条 run —— 否则两个块的文字会混进一个', () => {
  const chunks = [
    { type: 'text-delta', index: 0, text: 'a' },
    { type: 'text-delta', index: 1, text: 'b' },
    { type: 'text-delta', index: 0, text: 'c' },
  ]
  const stream = pack(chunks)
  assert.equal(stream.length, 3)
  assertValid(stream)
  assert.deepEqual(expand(stream), normalize(chunks))
})

test('思考增量和正文增量不混在一起', () => {
  const chunks = [
    { type: 'reasoning-delta', index: 0, text: '想一下' },
    { type: 'reasoning-delta', index: 0, text: '再想一下' },
    { type: 'text-delta', index: 0, text: '答案' },
  ]
  const stream = pack(chunks)
  assert.deepEqual(stream.map((r) => r.type), ['reasoning-chunks', 'text-chunks'])
  assertValid(stream)
  assert.deepEqual(expand(stream), normalize(chunks))
})

test('工具调用的参数增量：name 只在第一条上，后面的不算换了一个调用', () => {
  const chunks = [
    { type: 'tool-call-delta', index: 2, id: 'call_1', name: 'Bash', argumentsDelta: '{"cmd":' },
    { type: 'tool-call-delta', index: 2, id: 'call_1', argumentsDelta: '"ls"}' },
  ]
  const stream = pack(chunks)
  assert.equal(stream.length, 1, 'name 缺席不是「换了一个调用」')
  assert.equal(stream[0].name, 'Bash')
  assert.deepEqual(stream[0].args, ['{"cmd":', '"ls"}'])
  assertValid(stream)
  assert.deepEqual(expand(stream), normalize(chunks))
})

test('不同的调用不能并进同一条 run', () => {
  const chunks = [
    { type: 'tool-call-delta', index: 2, id: 'call_1', name: 'Bash', argumentsDelta: '{}' },
    { type: 'tool-call-delta', index: 2, id: 'call_2', name: 'Read', argumentsDelta: '{}' },
  ]
  const stream = pack(chunks)
  assert.equal(stream.length, 2, '并进去就会把两次调用的参数拼成一串废话')
  assertValid(stream)
  assert.deepEqual(expand(stream), normalize(chunks))
})

test('块的起止不是增量，各自留一条原始记录', () => {
  const chunks = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'hi' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'hi' } },
  ]
  const stream = pack(chunks)
  assert.deepEqual(stream.map((r) => r.type), ['chunk', 'text-chunks', 'chunk'])
  assertValid(stream)
  assert.deepEqual(expand(stream), normalize(chunks))
})

test('一整轮混合流：打包再展开，一个字都不能变', () => {
  const chunks = [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: '先看文件' },
    { type: 'reasoning-delta', index: 0, text: '再决定' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: '先看文件再决定' } },
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'text-delta', index: 1, text: '我来看看' },
    { type: 'block-end', index: 1, block: { type: 'text', text: '我来看看' } },
    { type: 'block-start', index: 2, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 2, id: 'call_9', name: 'Read', argumentsDelta: '{"path"' },
    { type: 'tool-call-delta', index: 2, id: 'call_9', argumentsDelta: ':"/a"}' },
    { type: 'block-end', index: 2, block: { type: 'tool-call', id: 'call_9', name: 'Read' } },
  ]
  const stream = pack(chunks)
  assertValid(stream)
  assert.deepEqual(expand(stream), normalize(chunks))
  assert.ok(stream.length < chunks.length, '打包总得真的压缩了点什么')
})

test('时间差是相对前一条的，累加回去必须单调不减', () => {
  const step = { stream: [], streamAt: 0 }
  for (let i = 0; i < 5; i += 1) packer.appendChunk(step, { type: 'text-delta', index: 0, text: 'x' })
  const record = step.stream[0]
  assertValid(step.stream)
  let time = record.time0
  for (const gap of record.dt) {
    assert.ok(gap >= 0, '时间不能倒流')
    time += gap
  }
  assert.ok(time >= record.time0)
})

test('assistant/chunk 这个事件类型必须彻底消失', () => {
  assert.equal(source.indexOf("'assistant/chunk'"), -1, 'dsh 0.1.5-rc.2 会因为它拒绝整份日志')
  assert.ok(source.indexOf("'assistant/attempt'") !== -1, '没有落成消息的一步，流要有地方去')
})

// 漏一个写入点，代价是一整个对话打不开。
//
// 第一次改的时候我只补了主转录那一处，另外六处（失败通知、drain 补投、子 agent
// 镜像、轮次失败）照旧写不带 stream 的消息。于是新对话照样在产生坏数据，而症状
// 要等到下次打开那个会话才出现：「stored session … is corrupt: seed
// assistant/message at index N has invalid settlement fields」。
//
// 所以这条不测行为，测源码：每一个写 assistant/message / assistant/attempt 的
// 地方，都必须在同一个对象字面量里带上 stream。
test('每一处写 assistant/message 的地方都带 stream', () => {
  const offenders = []
  const needle = /(['"])assistant\/(message|attempt)\1/g
  let match
  while ((match = needle.exec(source)) !== null) {
    const at = match.index
    // 只看真正的 append 调用：前面 120 字符里出现 append(
    const before = source.slice(Math.max(0, at - 120), at)
    if (!/append\(\s*$|append\(\s*\n\s*$|Append\([^,]*,\s*$/.test(before)) continue
    // 这次调用的参数对象：从这里到下一个 append( 或函数结束，取一段足够大的窗口
    const window = source.slice(at, at + 1400)
    const line = source.slice(0, at).split('\n').length
    if (!/\bstream\s*:/.test(window)) offenders.push(line)
  }
  assert.deepEqual(offenders, [],
    '这些行号上的 assistant/message / assistant/attempt 没有带 stream，dsh 会判整份会话损坏')
})

// 流要跟着它那条消息走。
//
// 一步只落一条消息，所以第二条要开新的一步；但它的增量此刻还攒在旧的那一步里
// （currentStep 只问「有没有开着的步」）。不交接的话，第一条带着不属于它的流，
// 第二条 stream 为空。实测：reasoning 那条 stream=2，正文那条 stream=0——
// 正文在回放里一个字的逐字过程都没有。
test('上一步已经落过消息时，攒着的流交接给新的一步', () => {
  const opened = []
  const beginStep = () => {
    const step = { step: opened.length + 2, stream: [], streamAt: 0, assistantLogged: false }
    opened.push(step)
    return step
  }
  const stepForAssistant = new Function(`${sliceFunction('stepForAssistant')}; return stepForAssistant`)()

  // 第一条消息：这一步还没落过东西，就用它自己
  const first = { step: 1, stream: [{ type: 'text-chunks', time0: 1, index: 0, dt: [], texts: ['甲'] }], streamAt: 1, assistantLogged: false }
  assert.equal(stepForAssistant(first, beginStep), first, '没落过消息的一步直接用')
  assert.equal(opened.length, 0, '不该白开一步')
  // 落这条消息时，assistantMessage 会把流从这一步里取走（splice），这一步归零。
  first.assistantLogged = true
  const settled = first.stream.splice(0)
  assert.deepEqual(settled[0].texts, ['甲'], '第一条消息带走的是它自己的流')

  // 之后新来的增量属于下一条消息，但此刻还攒在 first 里
  first.stream.push({ type: 'text-chunks', time0: 9, index: 1, dt: [], texts: ['乙'] })
  first.streamAt = 9
  const second = stepForAssistant(first, beginStep)

  assert.notEqual(second, first, '已经落过消息的一步不能再落第二条')
  assert.equal(second.stream.length, 1, '攒着的流要跟过来')
  assert.deepEqual(second.stream[0].texts, ['乙'])
  assert.equal(second.streamAt, 9, '时间基准也要跟过来，否则下一个 dt 会算错')
  assert.deepEqual(first.stream, [], '旧的那一步要清空——否则 closeStep 还会为它补一条 attempt')
})

test('一步都没开的时候，直接开一步且流是空的', () => {
  const stepForAssistant = new Function(`${sliceFunction('stepForAssistant')}; return stepForAssistant`)()
  const step = stepForAssistant(undefined, () => ({ step: 1, stream: [], streamAt: 0, assistantLogged: false }))
  assert.deepEqual(step.stream, [])
  assert.equal(step.streamAt, 0)
})
