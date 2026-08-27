// The model seat names the model a conversation runs. It used to carry a
// "follow Claude's own setting" row, which on a new conversation read
// 「Claude 默认」 — true, but it left the seat unable to say which model that
// was. The list is now concrete models only, with one concrete default.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const host = fs.readFileSync(path.join(root, 'src/host.dynamic.js'), 'utf8')

/** The catalog literals, read out of the engine body. */
function catalog() {
  const start = host.indexOf('    const MODELS = [')
  const end = host.indexOf('    const EFFORTS = [')
  assert.ok(start > 0 && end > start, 'the catalog moved')
  const defaults = host.match(/const DEFAULT_MODEL = '([^']+)'/)
  assert.ok(defaults !== null, 'DEFAULT_MODEL is gone')
  const body = host.slice(start, end).replace(/^\s*const DEFAULT_MODEL.*$/m, '')
  const models = new Function(body + '; return MODELS')()
  return { models: models, defaultModel: defaults[1] }
}

test('模型清单里只有具体模型', () => {
  const { models } = catalog()
  assert.ok(models.length > 0)
  for (const model of models) {
    assert.notEqual(model.id, '', '「跟随 Claude 自己的设置」这一行不该再出现')
    assert.match(model.id, /^claude-/)
    assert.equal(typeof model.name, 'string')
    assert.ok(model.name.length > 0)
  }
})

test('默认模型是清单里的一个具体模型', () => {
  const { models, defaultModel } = catalog()
  assert.notEqual(defaultModel, '')
  assert.ok(models.some((model) => model.id === defaultModel),
    defaultModel + ' 不在清单里')
})

test('什么都没选过时，开局落在那个默认模型上', () => {
  const { defaultModel } = catalog()
  // 新会话的初值来自 defaults，而 defaults 自己的出厂值是这一行。
  assert.match(host, /const defaults = \{ mode: 'dsh', permissionMode: 'manual', model: DEFAULT_MODEL, effort: '' \}/)
  assert.ok(defaultModel.length > 0)
})

test('新会话开在上一次选定的那套配置上', () => {
  // 在一个会话里选了 Claude、权限档和模型，下一个新会话就该这么开——
  // 而不是每次都退回 DSH 再手动切一遍。
  assert.match(host, /state = \{\s*mode: defaults\.mode,\s*permissionMode: defaults\.permissionMode,\s*model: defaults\.model,\s*effort: defaults\.effort,/)
  // 只有三个选择器写这份默认：记的是「有人选了什么」，不是「某个会话恰好继承了什么」。
  assert.equal((host.match(/^\s+rememberDefaults\(state\)$/gm) || []).length, 3,
    '引擎、权限档、模型三个选择器各一次；多出来的话就是某处把继承来的值当成了选择')
})

test('老会话存下来的空选择仍然保留', () => {
  // 那些会话的进程已经跑在 Claude 自己的配置上；菜单少了一行不该悄悄换模型。
  assert.match(host, /saved\.model === ''\s*\|\|\s*MODELS\.some/)
})

test('「没什么可存」的判定跟着默认值走', () => {
  // 否则默认值非空会让每一个见过的会话都被写进状态文件。
  assert.match(host, /state\.model === DEFAULT_MODEL/)
  assert.doesNotMatch(host, /state\.permissionMode === 'manual' && state\.model === '' &&/)
})
