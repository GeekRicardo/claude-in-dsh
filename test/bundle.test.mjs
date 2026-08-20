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
