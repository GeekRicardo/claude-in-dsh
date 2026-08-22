// The two generated bundle halves must load in their real containers:
// lib/index.js as an ES module with { apply, inject }, lib/client.js as a
// window.__ModuleLoader__ handoff whose factory wires the tested engine body.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

test('host half exports apply + inject', async () => {
  const mod = await import(path.join(root, 'lib/index.js'))
  assert.equal(typeof mod.apply, 'function')
  assert.deepEqual(mod.inject, ['webServer', 'subprocess', 'timer'])
})

test('client half registers through the module loader', () => {
  const source = fs.readFileSync(path.join(root, 'lib/client.js'), 'utf8')

  const handoffs = []
  const fakeWindow = {
    console: console,
    __ModuleLoader__: { load: (handoff) => handoffs.push(handoff) },
  }
  const styleTags = []
  const fakeDocument = {
    createElement: () => {
      const tag = { attributes: {}, setAttribute(k, v) { this.attributes[k] = v }, textContent: '' }
      return tag
    },
    head: { appendChild: (tag) => styleTags.push(tag) },
    body: { setAttribute() {}, removeAttribute() {} },
    addEventListener() {},
    removeEventListener() {},
    getElementsByClassName: () => [],
    querySelectorAll: () => [],
  }
  const evaluate = new Function('window', 'document', 'fetch', 'MutationObserver', 'Element', source)
  evaluate(fakeWindow, fakeDocument, () => Promise.resolve({ json: () => ({ ok: true, value: {} }) }),
    class { observe() {} disconnect() {} }, class {})

  assert.equal(handoffs.length, 1)
  assert.equal(handoffs[0].id, 'claude-in-dsh')

  const fakeReact = {
    createElement: () => null,
    Fragment: 'Fragment',
    useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
    useEffect: () => {},
    useRef: (v) => ({ current: v }),
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
  }
  const exports = handoffs[0].factory((spec) => {
    assert.equal(spec, 'react')
    return fakeReact
  })
  assert.equal(typeof exports.apply, 'function')
  assert.ok(Array.isArray(exports.inject) && exports.inject.includes('slots'))

  // applying with no slots service degrades gracefully (logs, no throw) —
  // the full-render coverage lives in src/client-rig.mjs against the source.
  exports.apply({ get: () => undefined, effect: () => () => {}, interval: () => () => {}, timeout: () => () => {} })
  assert.equal(styleTags.length, 0)
})

test('每条 shell 命令都是 GNU/BSD 双兼容（macOS 回归防线）', () => {
  const source = fs.readFileSync(path.join(root, 'lib/index.js'), 'utf8')

  // setsid(1) 是 util-linux 独有的，macOS 没有 —— broker 在 mac 上因此起不来，
  // 每条消息都死于 10 秒管道写超时。脱离会话必须走 node 自己的 detached:true。
  assert.ok(!/['"]setsid /.test(source), 'setsid 启动命令回来了 —— macOS 上 broker 会再次起不来')
  assert.ok(source.includes('{detached:true,stdio:"ignore"}'), 'broker 必须以 detached:true 脱离会话')

  // stat -c 是 GNU 语法；每一处都必须带 BSD 的 stat -f 兜底，否则 mac 上
  // 文件大小恒为 0（offset 兜底重放整段日志）、导入列表恒为空、broker 永不回收。
  for (const line of source.split('\n')) {
    if (!/['"$(]stat -c /.test(line)) continue
    assert.ok(line.includes('stat -f'), 'GNU-only 的 stat 调用（缺 BSD 兜底）: ' + line.trim())
  }
})
