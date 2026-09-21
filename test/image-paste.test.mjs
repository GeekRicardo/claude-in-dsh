// 在 dsh 的输入框里粘一张图，Claude 得能看见它。
//
// dsh 自己的 prompt RPC 在会话的 dsh 模型没有视觉能力时会拒收图片——那道闸
// 门不知道这条对话其实是 Claude 在驱动。所以客户端抢在 dsh 的附件流程之前
// 把粘贴截下来，图片存到插件这边，下一轮 prompt 带着它一起过去。
//
// 实测现场：图片贴上去了，dsh 的附件栏里也有，Claude 却说看不到。因为拦截
// 的第一道判断是「事件目标是不是 <textarea>」，而 dsh 0.1.5 起 composer 换
// 成了绑 Lexical 编辑器的 contenteditable div（ComposerContentEditable，带
// role="textbox" 和 data-composer-input）——那句判断永远成立，整个拦截一次
// 都没跑过。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const client = fs.readFileSync(path.join(root, 'src/client.dynamic.js'), 'utf8')

function sliceFunction(name) {
  const start = client.indexOf(`function ${name}(`)
  assert.notEqual(start, -1, `找不到 ${name}`)
  let depth = 0
  let i = client.indexOf('{', start)
  while (i < client.length) {
    const c = client[i]
    if (c === '"' || c === "'" || c === '`') {
      i += 1
      while (i < client.length && client[i] !== c) i += client[i] === '\\' ? 2 : 1
      i += 1
      continue
    }
    if (c === '/' && client[i + 1] === '/') { i = client.indexOf('\n', i); if (i === -1) break; continue }
    if (c === '{') depth += 1
    else if (c === '}') { depth -= 1; if (depth === 0) return client.slice(start, i + 1) }
    i += 1
  }
  throw new Error(`${name} 花括号没配平`)
}

const paste = sliceFunction('handleImagePaste')
// 断言要看代码，不能看注释——注释里正会引用出问题的那句写法。
const code = paste.split('\n').map((line) => {
  const at = line.indexOf('//')
  return at === -1 ? line : line.slice(0, at)
}).join('\n')

test('认的是 dsh 给输入框打的标记，不是元素名', () => {
  assert.match(code, /data-composer-input/,
    'composer 是个 contenteditable div，认 tagName 等于这条路一次都不走')
  assert.equal(/tagName/.test(code), false,
    'tagName 判断是这个 bug 本身——它让拦截永远提前 return')
})

test('旧版 dsh 的 textarea 也还认', () => {
  const at = code.indexOf('closest(')
  assert.notEqual(at, -1, '要用 closest 往上找，事件目标可能是编辑器内部的节点')
  assert.match(code.slice(at, at + 120), /textarea/, '同一个插件还要能装在旧版 dsh 上')
})

test('target 没有 closest 就直接走开，别在 text node 上炸', () => {
  assert.match(code, /typeof target\.closest !== 'function'/)
})

test('拦下来之后要挡住 dsh 自己的附件流程', () => {
  // 不 preventDefault，图片会被 dsh 的 store 再收一遍，composer 里出现两份。
  assert.match(code, /event\.preventDefault\(\)/)
  assert.match(code, /event\.stopPropagation\(\)/)
  const registration = client.slice(client.indexOf("addEventListener('paste'"))
  assert.match(registration.slice(0, 80), /handleImagePaste, true/,
    '必须是捕获阶段：Lexical 自己也听 paste，冒泡上来就晚了')
})
