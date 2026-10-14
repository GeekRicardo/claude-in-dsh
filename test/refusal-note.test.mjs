// 安全分类器拦截：Claude Code 在 `-p --output-format stream-json` 这条路上，
// 用一条 `system/model_refusal_fallback` 事件报告「上一段回复被安全分类器停
// 了」——有 fallback_model 时在本轮切模型重答，没有时拒绝维持、这一轮空收。
// 两种支都先出一条 stop_reason 为 "refusal" 的 message_delta。插件以前把这些
// 事件一律丢掉，于是 dsh 在停流+切模型+重试的整段里一片安静（有过一个对话连
// 着撞了六次），拒绝维持时还留一个空白轮。refusalNote 负责那条提示的措辞；它
// 住在引擎体闭包里，照 quota-wait 的做法按名字切出源码单独求值——改名或删掉
// 时测试会响。

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

const refusalNote = new Function(`${sliceFunction('refusalNote')}; return refusalNote`)()

test('能重试：提示里点名要切到哪个 fallback 模型', () => {
  const text = refusalNote({
    type: 'system',
    subtype: 'model_refusal_fallback',
    direction: 'retry',
    api_refusal_category: 'cyber',
    original_model: 'claude-opus-5',
    fallback_model: 'claude-opus-4-8',
  })
  assert.match(text, /安全防护/)
  assert.match(text, /claude-opus-4-8/, '重试支必须说清楚换到哪个模型')
  assert.match(text, /cyber/, '带上拒绝类别，便于判断是不是误伤')
})

test('拒绝维持：没有 fallback 时说明这一轮到此为止，不假装要重试', () => {
  const text = refusalNote({
    type: 'system',
    subtype: 'model_refusal_fallback',
    api_refusal_category: 'cyber',
  })
  assert.match(text, /安全防护/)
  assert.doesNotMatch(text, /切到|重答/, '没有 fallback 就不能说在重试')
  assert.match(text, /cyber/)
})

test('类别缺失也能成句，不留一对空括号', () => {
  const text = refusalNote({ subtype: 'model_refusal_fallback', fallback_model: 'claude-opus-4-8' })
  assert.match(text, /claude-opus-4-8/)
  assert.doesNotMatch(text, /（）/, '类别为空时不应渲染空括号')
})

test('不是 refusal 事件就返回 null，让调用处保持一行', () => {
  assert.equal(refusalNote({ type: 'system', subtype: 'compact_boundary' }), null)
  assert.equal(refusalNote({ type: 'result' }), null)
  assert.equal(refusalNote(null), null)
  assert.equal(refusalNote(undefined), null)
})
