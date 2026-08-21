// AskUserQuestion / ExitPlanMode 桥接的纯函数：识别、题目翻译、答案翻译，
// 外加计划审核那几个必须和 dsh-plan-mode 逐字一致的常量。
//
// 它们住在 host 引擎体的闭包里（apply 在没有 subprocess 服务时直接返回，
// 拿不到内部函数），所以这里按名字把函数源码切出来单独求值。切不到就断言失败——
// 函数被改名或删掉时这个测试会响，而不是静默失效。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const source = fs.readFileSync(path.join(root, 'src/host.dynamic.js'), 'utf8')

/** 从引擎体里切出一个具名函数的完整源码（按花括号配平）。 */
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

const names = ['isUserQuestion', 'dshQuestionsOf', 'ccAnswersOf', 'isPlanReview']
const { isUserQuestion, dshQuestionsOf, ccAnswersOf, isPlanReview } = new Function(
  `${names.map(sliceFunction).join('\n')}\nreturn { ${names.join(', ')} }`,
)()

const CC_INPUT = {
  questions: [{
    question: 'Do you prefer tabs or spaces?',
    header: 'Indentation',
    multiSelect: false,
    options: [
      { label: 'Spaces', description: 'Indent with spaces.' },
      { label: 'Tabs', description: 'Indent with tabs.' },
    ],
  }],
}

test('只认 AskUserQuestion 且入参带 questions', () => {
  assert.equal(isUserQuestion({ tool_name: 'AskUserQuestion', input: CC_INPUT }), true)
  assert.equal(isUserQuestion({ tool_name: 'Bash', input: { command: 'ls' } }), false)
  assert.equal(isUserQuestion({ tool_name: 'AskUserQuestion', input: {} }), false)
  assert.equal(isUserQuestion({ tool_name: 'AskUserQuestion', input: { questions: [] } }), false)
  assert.equal(isUserQuestion({ tool_name: 'AskUserQuestion' }), false)
})

test('题目翻译成 dsh 的 AskUserQuestionItem：补 id，保留 header/options/multiSelect', () => {
  assert.deepEqual(dshQuestionsOf(CC_INPUT), [{
    id: 'q0',
    question: 'Do you prefer tabs or spaces?',
    header: 'Indentation',
    options: [
      { label: 'Spaces', description: 'Indent with spaces.' },
      { label: 'Tabs', description: 'Indent with tabs.' },
    ],
  }])
  const multi = dshQuestionsOf({ questions: [{ question: '选哪些？', multiSelect: true, options: [{ label: 'A' }] }] })
  assert.equal(multi[0].multiSelect, true)
  assert.deepEqual(multi[0].options, [{ label: 'A' }])
  assert.equal(multi[0].header, undefined)
})

test('空题面、空标签的选项被丢掉，题号仍按原下标', () => {
  const items = dshQuestionsOf({ questions: [{ question: '   ' }, { question: '真问题', options: [{ label: '' }, { label: 'ok' }] }] })
  assert.equal(items.length, 1)
  assert.equal(items[0].id, 'q1')
  assert.deepEqual(items[0].options, [{ label: 'ok' }])
})

test('答案按题面文本取键——Claude 要的就是这个形状', () => {
  const items = dshQuestionsOf(CC_INPUT)
  const answers = ccAnswersOf(items, { answers: [{ id: 'q0', selected: ['Tabs'] }] })
  assert.deepEqual(answers, { 'Do you prefer tabs or spaces?': 'Tabs' })
})

test('多选连成一个字符串，「其他」的自由文本拼在后面', () => {
  const items = dshQuestionsOf({ questions: [{ question: '要哪些？', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] }] })
  assert.deepEqual(
    ccAnswersOf(items, { answers: [{ id: 'q0', selected: ['A', 'B'], custom: '还要 C' }] }),
    { '要哪些？': 'A, B, 还要 C' },
  )
  assert.deepEqual(
    ccAnswersOf(items, { answers: [{ id: 'q0', selected: [], custom: '都不要' }] }),
    { '要哪些？': '都不要' },
  )
})

test('没答的题不出现在 answers 里（Claude 据此说「没有回答」）', () => {
  const items = dshQuestionsOf(CC_INPUT)
  assert.deepEqual(ccAnswersOf(items, { answers: [] }), {})
  assert.deepEqual(ccAnswersOf(items, { answers: [{ id: 'q0', selected: [] }] }), {})
  assert.deepEqual(ccAnswersOf(items, undefined), {})
  assert.deepEqual(ccAnswersOf(items, { answers: [{ id: '不认识的 id', selected: ['X'] }] }), {})
})

test('计划审核只认 ExitPlanMode 且带非空 plan', () => {
  assert.equal(isPlanReview({ tool_name: 'ExitPlanMode', input: { plan: '# 计划\n步骤', planFilePath: '/x.md' } }), true)
  assert.equal(isPlanReview({ tool_name: 'ExitPlanMode', input: { plan: '   ' } }), false)
  assert.equal(isPlanReview({ tool_name: 'ExitPlanMode', input: {} }), false)
  assert.equal(isPlanReview({ tool_name: 'Write', input: { plan: '# 计划' } }), false)
})

test('批准的判定与 dsh 的 exit_plan_mode 逐字一致', () => {
  // src 里的判定不是独立函数（它读闭包里的常量），所以这里把规则原样复刻一份对照，
  // 任何一条改了都会和 src 的注释对不上——真正的守卫是下面对 src 文本的断言。
  const approved = (item) => item !== undefined
    && Array.isArray(item.selected) && item.selected.length === 1
    && item.selected[0] === 'Approve'
    && (typeof item.custom !== 'string' || item.custom.trim() === '')
  assert.equal(approved({ selected: ['Approve'] }), true)
  assert.equal(approved({ selected: ['Approve'], custom: '  ' }), true)
  assert.equal(approved({ selected: ['Approve'], custom: '再想想第 3 步' }), false, '带反馈就不是批准')
  assert.equal(approved({ selected: ['Keep planning'] }), false)
  assert.equal(approved({ selected: [] }), false)
  assert.equal(approved(undefined), false)
  // 常量必须和 dsh-plan-mode 一致，否则客户端渲染的就不是计划审核卡片。
  assert.match(source, /const PLAN_REVIEW_ID = 'plan-review'/)
  assert.match(source, /const PLAN_APPROVE_LABEL = 'Approve'/)
  assert.match(source, /const PLAN_KEEP_LABEL = 'Keep planning'/)
  assert.match(source, /intent: \{ kind: 'plan-review', approve: PLAN_APPROVE_LABEL \}/)
})

test('批准后把计划档落回监督档，否则换进程会退回计划模式', () => {
  assert.match(source, /state\.permissionMode === 'plan'[\s\S]{0,120}state\.permissionMode = 'manual'/)
})
