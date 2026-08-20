// Offline rig for the client half: evaluates it exactly the way the browser
// runner does (same closure parameters), then renders every component it seats
// with realistic props. A reference error or a bad hook call fails here instead
// of silently abdicating a slot entry in the page.

import fs from 'node:fs'

const source = fs.readFileSync(new URL('./client.dynamic.js', import.meta.url), 'utf8')

// ---- a React stand-in with just enough hook behaviour -----------------------
let hookCells = []
let hookIndex = 0
const effects = []

const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  Fragment: 'Fragment',
  useState(initial) {
    const at = hookIndex++
    if (!(at in hookCells)) hookCells[at] = typeof initial === 'function' ? initial() : initial
    return [hookCells[at], (next) => { hookCells[at] = typeof next === 'function' ? next(hookCells[at]) : next }]
  },
  useEffect(fn, deps) { effects.push(fn) },
  useRef(initial) {
    const at = hookIndex++
    if (!(at in hookCells)) hookCells[at] = { current: initial }
    return hookCells[at]
  },
  useMemo(fn) { return fn() },
  useCallback(fn) { return fn },
}

const styles = { insert: (css) => { if (typeof css !== 'string') throw new Error('styles.insert needs a string') } }

const hostCalls = []
const host = {
  call: (method, args) => {
    hostCalls.push(method)
    if (method === 'catalog') {
      return Promise.resolve({
        models: [{ id: '', name: 'default', reasoning: false }, { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', reasoning: true }],
        efforts: [{ id: '', name: 'default' }, { id: 'high', name: 'high' }],
        permissionModes: [{ id: 'manual', name: 'manual', detail: 'ask' }, { id: 'acceptEdits', name: 'acceptEdits', detail: 'edits' }],
      })
    }
    if (method === 'state.get') {
      return Promise.resolve({ mode: 'claude', permissionMode: 'manual', model: 'claude-sonnet-5', effort: 'high', running: true, committed: 'claude', locked: true })
    }
    if (method === 'commands') {
      return Promise.resolve({ commands: ['deep-research', 'verify', 'code-review', 'compact', 'usage'] })
    }
    if (method === 'engines') {
      return Promise.resolve({ engines: { 'session-11111111-2222-4333-8444-555555555555': 'claude', 'session-99999999-8888-4777-8666-555555555555': 'dsh' } })
    }
    if (method === 'usage') {
      return Promise.resolve({
        official: true, subscription: 'max',
        windows: [
          { id: 'five_hour', label: '5h', utilization: 35, resetsAt: new Date(Date.now() + 4 * 3600e3).toISOString() },
          { id: 'seven_day', label: '7d', utilization: 22, resetsAt: new Date(Date.now() + 30 * 3600e3).toISOString() },
        ],
        fetchedAt: Date.now(),
      })
    }
    return Promise.resolve({})
  },
}
const harness = {}

// ---- a slots service that records what gets seated -------------------------
const seated = []
const slots = {
  inject: (name, factory) => {
    const value = factory()
    if (value && typeof value.next === 'function') { let step = value.next(); while (!step.done) step = value.next() }
    return () => {}
  },
  register: (options, component) => { seated.push({ options, component }); return () => {} },
  spec: () => ({ kind: 'list', scope: 'session' }),
}

const registeredCommands = []
const commandUi = { register: (c) => { registeredCommands.push(c.name); return () => {} } }
const sessionsService = { binding: () => ({ session: { prompt: async () => true } }), create: async () => 'session-new', open: () => {} }

const ctx = {
  get: (name) => (name === 'slots' ? slots : name === 'commandUi' ? commandUi : name === 'sessions' ? sessionsService : undefined),
  interval: (fn, ms) => { if (typeof fn !== 'function') throw new Error('ctx.interval needs a function'); return () => {} },
  timeout: (fn, ms) => () => {},
  effect: (fn) => { const disposer = fn(); return () => { if (typeof disposer === 'function') disposer() } },
}

// a DOM stand-in with two sidebar rows, one of them a Claude session
function fakeEl(className, sessionId) {
  const el = {
    className, children: [], parentNode: null,
    getElementsByClassName(name) { return el.children.filter((c) => c.className === name) },
    insertBefore(node, ref) { node.parentNode = el; el.children.unshift(node) },
    remove() { if (el.parentNode) el.parentNode.children = el.parentNode.children.filter((c) => c !== el) },
    get firstChild() { return el.children[0] },
    title: '', textContent: '',
  }
  if (sessionId !== undefined) {
    // mirrors the shipped shape: div → span → Tooltip → SessionNodeItem({node, currentId})
    const itemFiber = { memoizedProps: { node: { kind: 'session', row: { sessionId, title: 't' } }, currentId: 'session-selected' }, return: null }
    el['__reactFiber$rig'] = { memoizedProps: { className: 'row' }, return: { memoizedProps: {}, return: itemFiber } }
  }
  return el
}
const claudeRow = fakeEl('YDXeBa_sessionRow', 'session-11111111-2222-4333-8444-555555555555')
claudeRow.children.push(fakeEl('YDXeBa_title'))
const dshRow = fakeEl('YDXeBa_sessionRow', 'session-99999999-8888-4777-8666-555555555555')
dshRow.children.push(fakeEl('YDXeBa_title'))
const rows = [claudeRow, dshRow]

globalThis.MutationObserver = class { observe() {} disconnect() {} }
globalThis.Element = class {}
globalThis.document = {
  body: { setAttribute() {}, removeAttribute() {} },
  addEventListener() {}, removeEventListener() {},
  getElementsByClassName(name) {
    if (name === 'YDXeBa_sessionRow') return rows
    return rows.flatMap((r) => r.getElementsByClassName(name))
  },
  querySelectorAll: () => rows,
  createElement: () => fakeEl(''),
  querySelectorAll: () => rows,
}

const closure = new Function('React', 'console', 'styles', 'host', 'harness', `return (async () => {\n${source}\n})()`)
const plugin = await closure(React, console, styles, host, harness)
if (typeof plugin.apply !== 'function') throw new Error('client half returned no apply')
plugin.apply(ctx)

console.log('inject declared:', JSON.stringify(plugin.inject))
console.log('seats:', seated.map((s) => s.options.name + (s.options.id ? '#' + s.options.id : '') + (s.options.key ? ':' + s.options.key : '')).join(', ').slice(0, 400))

// ---- render every seated component with plausible props --------------------
function render(component, props, label) {
  hookCells = []
  hookIndex = 0
  effects.length = 0
  const tree = component(props)
  for (const fn of effects) { const cleanup = fn(); if (typeof cleanup === 'function') cleanup() }
  return tree
}

const sessionProps = { sessionId: 'session-11111111-2222-4333-8444-555555555555' }
const runningCall = { callId: 'toolu_1', name: 'Bash', argsRaw: JSON.stringify({ command: 'echo hi', description: 'd' }), subCalls: [] }
const settledCall = {
  kind: 'tool-result', callId: 'toolu_1', call: { name: 'Edit', argsRaw: JSON.stringify({ file_path: '/a/b.txt', old_string: 'x', new_string: 'y' }) },
  content: [{ type: 'text', text: 'done' }], isError: false, subCalls: [],
}
const failedCall = {
  kind: 'tool-result', callId: 'toolu_2', call: { name: 'Write', argsRaw: JSON.stringify({ file_path: '/a/b.txt', content: 'hello' }) },
  content: [{ type: 'text', text: '<tool_use_error>File has not been read yet. Read it first.</tool_use_error>' }], isError: true, subCalls: [],
}

let failures = 0
for (const seat of seated) {
  const isTool = seat.options.name === 'tool.call.toolview'
  const cases = isTool
    ? [
        ['running', { ...sessionProps, toolName: seat.options.key, block: { ...runningCall, name: seat.options.key } }],
        ['settled', { ...sessionProps, toolName: seat.options.key, block: settledCall }],
        ['failed', { ...sessionProps, toolName: seat.options.key, block: failedCall }],
      ]
    : [['default', sessionProps]]
  for (const [label, props] of cases) {
    try {
      render(seat.component, props, label)
    } catch (error) {
      failures += 1
      console.log('RENDER FAILURE', seat.options.name, seat.options.key || seat.options.id, label, '→', error.message)
    }
  }
}

// the seats acquired only while Claude drives are registered lazily; force them
const before = seated.length
const engine = seated.find((s) => s.options.id === 'ccmode-engine')
if (engine !== undefined) {
  hookCells = []; hookIndex = 0; effects.length = 0
  engine.component({ ...sessionProps })
  for (const fn of effects) fn()
  console.log('shadow seats after claude mode:', seated.slice(before).map((s) => s.options.name + (s.options.id ? '#' + s.options.id : '')).join(', ') || '(none)')
  for (const seat of seated.slice(before)) {
    try { render(seat.component, sessionProps, 'shadow') } catch (error) {
      failures += 1
      console.log('RENDER FAILURE', seat.options.name, seat.options.id, '→', error.message)
    }
  }
}

await new Promise((r) => setTimeout(r, 50))
const badged = rows.map((row) => row.getElementsByClassName('ccmode-row-badge').length)
console.log('sidebar badges [claude row, dsh row]:', JSON.stringify(badged))
if (badged[0] !== 1 || badged[1] !== 0) { failures += 1; console.log('BADGE FAILURE') }

await new Promise((r) => setTimeout(r, 30))
console.log('claude commands registered:', registeredCommands.length, registeredCommands.slice(0, 4).join(','))
console.log(failures === 0 ? 'ALL COMPONENTS RENDER' : failures + ' RENDER FAILURES')
process.exit(failures === 0 ? 0 : 1)
