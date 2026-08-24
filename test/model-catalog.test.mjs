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

test('新会话就落在那个默认模型上', () => {
  const { defaultModel } = catalog()
  // stateOf 的初值决定新会话开局显示什么、以及用什么启动进程。
  assert.match(host, /state = \{ mode: 'dsh', permissionMode: 'manual', model: DEFAULT_MODEL,/)
  assert.ok(defaultModel.length > 0)
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
