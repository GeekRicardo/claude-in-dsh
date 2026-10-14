// dsh 0.2 的 CommandContribution 把菜单行的文案收成了方法：
//
//   label?(): string
//   description?(): string
//
// （为了换语言时不必重新注册——契约里写着 "Row copy is read on every
// candidate pass"。）传字符串的后果远不止「这一行少个说明」：候选合成是一个
// 遍历所有 contribution 的循环，循环体里直接写 `contribution.description()`，
// 所以**任何一个** contribution 传了字符串，整个 candidates() 就抛
// TypeError。插件所有命令的 available 都是「这是个 Claude 会话吗」，于是
// 症状正好是：DSH 会话里菜单好的（全被 available=false 跳过），一进 Claude
// 会话整个斜杠命令菜单全废——表现出来就是「/restart 失效了」。
//
// 这里只做静态形状检查：每个 commandUi.register({…}) 的顶层 label /
// description 若出现，必须是函数。popupSelect 选项里的 label 是另一个契约
// （SelectOption.label 就是 string），所以只看顶层，不碰嵌套。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const client = fs.readFileSync(path.join(root, 'src/client.dynamic.js'), 'utf8')

/** The argument text of every `commandUi.register(` / `.decorate(` call. */
function registrationBlocks(source) {
  const blocks = []
  const call = /commandUi\.(register|decorate)\s*\(/g
  let match
  while ((match = call.exec(source)) !== null) {
    let depth = 0
    for (let i = match.index + match[0].length - 1; i < source.length; i += 1) {
      const ch = source[i]
      if (ch === '(') depth += 1
      else if (ch === ')') {
        depth -= 1
        if (depth === 0) {
          blocks.push({ kind: match[1], text: source.slice(match.index, i + 1) })
          break
        }
      }
    }
  }
  return blocks
}

/**
 * The value text of `field:` at the object literal's TOP level, or null.
 *
 * Depth is counted from the `({` that opens the contribution, so a `label:`
 * inside `ui.options` (a different contract) is never mistaken for this one.
 */
function topLevelField(blockText, field) {
  const open = blockText.indexOf('{')
  if (open === -1) return null
  let depth = 0
  for (let i = open; i < blockText.length; i += 1) {
    const ch = blockText[i]
    if (ch === '{' || ch === '[' || ch === '(') depth += 1
    else if (ch === '}' || ch === ']' || ch === ')') depth -= 1
    else if (depth === 1 && blockText.startsWith(field + ':', i)) {
      const rest = blockText.slice(i + field.length + 1)
      return rest.slice(0, rest.search(/[,\n]/) === -1 ? rest.length : rest.search(/[,\n]/)).trim()
    }
  }
  return null
}

const FUNCTION_VALUE = /^(\(\s*\)\s*=>|function\b|\(\s*[A-Za-z_$])/

test('每个 commandUi 注册都存在', () => {
  const blocks = registrationBlocks(client)
  assert.ok(blocks.length >= 3,
    '找到 ' + blocks.length + ' 个注册——少于预期（Claude 命令、/restart、导入），正则可能失配了')
})

test('顶层 description 必须是函数，不能是字符串', () => {
  for (const block of registrationBlocks(client)) {
    const value = topLevelField(block.text, 'description')
    if (value === null) continue
    assert.match(value, FUNCTION_VALUE,
      'commandUi.' + block.kind + ' 的 description 传了非函数（' + value
      + '）—— dsh 会 description() 调用它，一个字符串就让整个命令菜单抛 TypeError')
  }
})

test('顶层 label 若出现也必须是函数', () => {
  for (const block of registrationBlocks(client)) {
    const value = topLevelField(block.text, 'label')
    if (value === null) continue
    assert.match(value, FUNCTION_VALUE,
      'commandUi.' + block.kind + ' 的 label 传了非函数（' + value + '）')
  }
})

test('available 是必填的方法', () => {
  for (const block of registrationBlocks(client)) {
    const value = topLevelField(block.text, 'available')
    assert.notEqual(value, null, 'commandUi.' + block.kind + ' 少了 available —— 契约里它是必填的')
    assert.match(value, FUNCTION_VALUE, 'available 必须是函数')
  }
})

// ---------------------------------------------------------------------------
// 座位的菜单是组件自己的 useState，所以任何让座位重渲染的事都会把它关掉。
// 这里曾经在触发器的 onClick 里刷新模型目录：RPC 一回来就 notify()，座位重渲染，
// 刚点开的菜单当场关上——表现就是「点了没反应、弹不出菜单」。而 30 秒节流让它在
// 连续重试时不复现，`locked` 的老对话又没有别的轮询，所以只在那种对话上稳定踩中。

test('点击路径里不许刷新目录——那会把刚点开的菜单关掉', () => {
  const client = fs.readFileSync(path.join(root, 'src/client.dynamic.js'), 'utf8')
  const seat = client.slice(client.indexOf('function ClaudeModelSeat'),
    client.indexOf('function ClaudeModelSeat') + 4200)
  const onClick = /onClick: \(\) => \{([^}]*)\}/.exec(seat)
  assert.notEqual(onClick, null, 'ClaudeModelSeat 的触发器没有 onClick 了')
  assert.ok(!/refreshCatalog/.test(onClick[1]),
    'onClick 里又调了 refreshCatalog —— notify 会让座位重渲染，菜单弹不出来')
  assert.match(seat, /load\(sessionId\); refreshCatalog\(\)/,
    '目录刷新要放在 mount 时（那会儿没有菜单开着）')
})

test('目录没变就不 notify', () => {
  const client = fs.readFileSync(path.join(root, 'src/client.dynamic.js'), 'utf8')
  const fn = client.slice(client.indexOf('function refreshCatalog'),
    client.indexOf('function refreshCatalog') + 900)
  assert.match(fn, /JSON\.stringify\(value\) === JSON\.stringify\(catalog\)\) return/,
    '内容相同就该直接返回，不要白白重渲染每一个座位')
})
