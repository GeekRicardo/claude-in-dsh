// 模型清单是手工维护的（Claude Code 没有模型清单命令），而手工维护的副本必然
// 悄悄过期——broker 那份手工粘贴的源码就是这么过期的。这次过期的后果是：Opus
// 5.5 都发布了，选择器里最新还只到 Opus 5，想选都选不出来；而真正在跑的进程一
// 旦报回 `claude-opus-5-5[1m]`，`bare` 不在 MODELS 里，座位上只能显示那串原始
// route 字符串。
//
// 装好的 `claude` 自己带着权威的模型表（`{id,family,display_name,…}` 一行一
// 个），所以这里直接拿它对账：插件清单里的每个 id 都必须是 CLI 认识的 id。
// 只断言这一个方向——插件那份是给人选的精选短列表，不是 CLI 全集。
//
// 查不到 `claude` 的机器上整条 skip：这是一致性检查，不是「必须装 CLI」。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const host = fs.readFileSync(path.join(root, 'src/host.dynamic.js'), 'utf8')

/** The catalog literals, read out of the engine body (as model-catalog does). */
function catalog() {
  const start = host.indexOf('    const MODELS = [')
  const end = host.indexOf('    const EFFORTS = [')
  assert.ok(start > 0 && end > start, 'the catalog moved')
  const defaults = host.match(/const DEFAULT_MODEL = '([^']+)'/)
  assert.ok(defaults !== null, 'DEFAULT_MODEL is gone')
  const body = host.slice(start, end).replace(/^\s*const DEFAULT_MODEL.*$/m, '')
  return { models: new Function(body + '; return MODELS')(), defaultModel: defaults[1] }
}

/** Every model id the installed CLI knows, or null when it cannot be read. */
function cliModelIds() {
  let binary
  try {
    binary = fs.realpathSync(execFileSync('sh', ['-c', 'command -v claude'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim())
  } catch (error) { return null }
  if (binary.length === 0 || !fs.existsSync(binary)) return null
  let found
  try {
    // The table rows carry the family right after the id, which keeps this from
    // matching the many other `id:"claude-…"` strings in the bundle.
    found = execFileSync('grep', ['-aoh', 'id:"claude-[a-z0-9-]*",family:"[a-z]*"', binary], {
      encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch (error) { return null }
  const ids = new Set()
  for (const row of found.split('\n')) {
    const match = /^id:"([^"]+)"/.exec(row.trim())
    if (match !== null) ids.add(match[1])
  }
  return ids.size === 0 ? null : ids
}

test('清单里的每个 id 都是本机 Claude Code 认识的 id', (t) => {
  const ids = cliModelIds()
  if (ids === null) {
    t.skip('读不到本机 claude 的模型表——跳过一致性检查')
    return
  }
  const { models } = catalog()
  const unknown = models.filter((model) => !ids.has(model.id)).map((model) => model.id)
  assert.deepEqual(unknown, [],
    '这些 id 本机 CLI 不认识，选了就起不来：' + unknown.join(', '))
})

test('默认模型是本机 CLI 认识的 id', (t) => {
  const ids = cliModelIds()
  if (ids === null) {
    t.skip('读不到本机 claude 的模型表——跳过一致性检查')
    return
  }
  const { defaultModel } = catalog()
  assert.ok(ids.has(defaultModel), defaultModel + ' 本机 CLI 不认识')
})

test('每个家族里，清单的头一行就是 CLI 表里该家族最新的那个', (t) => {
  // 这条才是「清单过期」会响的那一条：Opus 5.5 发布后清单还停在 Opus 5，
  // 上面两条仍然全绿（Opus 5 一直是合法 id），只有这条会指出落后了一代。
  const ids = cliModelIds()
  if (ids === null) {
    t.skip('读不到本机 claude 的模型表——跳过一致性检查')
    return
  }
  const { models } = catalog()
  /** `claude-opus-5-5` -> {family:'opus', version:[5,5]} */
  const parse = (id) => {
    const match = /^claude-([a-z]+)-([0-9]+(?:-[0-9]+)?)$/.exec(id)
    if (match === null) return null
    return { family: match[1], version: match[2].split('-').map(Number) }
  }
  const newer = (a, b) => {
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
      const left = a[i] === undefined ? 0 : a[i]
      const right = b[i] === undefined ? 0 : b[i]
      if (left !== right) return left > right
    }
    return false
  }
  // CLI 表里每个家族最新的那个 id。
  const latest = new Map()
  for (const id of ids) {
    const row = parse(id)
    if (row === null) continue
    const seen = latest.get(row.family)
    if (seen === undefined || newer(row.version, seen.version)) latest.set(row.family, { id: id, version: row.version })
  }
  // 清单里出现过的每个家族，它的头一行必须是那个最新 id。
  const seenFamilies = new Set()
  for (const model of models) {
    const row = parse(model.id)
    if (row === null || seenFamilies.has(row.family)) continue
    seenFamilies.add(row.family)
    // Mythos 是 Project Glasswing 专属，普通订阅选不到，不要求出现。
    if (row.family === 'mythos') continue
    const top = latest.get(row.family)
    if (top === undefined) continue
    assert.equal(model.id, top.id,
      row.family + ' 家族落后了一代：清单里最新是 ' + model.id + '，CLI 已有 ' + top.id)
  }
  assert.ok(seenFamilies.size > 0, '清单里一个家族都没解析出来')
})
