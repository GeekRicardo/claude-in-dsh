// `persistStates()` 把整个状态文件从内存重写一遍，而**载入之前**内存是空的。
// 于是一次早到的写入——一份命令清单、一次设置改动、任何东西——就把文件换成了一个
// 两个键的残骸。`#remotes` 就是这么没的：那个块的注释白纸黑字写着「我们自己的写
// 入不能抹掉用户声明的目标」，结果正是被我们自己的写入抹掉的，就在那次本该把它
// 读进来的载入的前一拍。38 个对话的引擎选择、这台 dsh 自己的身份，一起没了——
// 所以重启之后没有任何目标，实例 id 也换了一个新的。

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
  const before = source.lastIndexOf('async ', start)
  const from = before !== -1 && source.slice(before + 'async '.length, start).trim() === '' ? before : start
  let depth = 0
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(from, i + 1)
    }
  }
  throw new Error(`${name} 的花括号没有配平`)
}

/**
 * 真的 loadPersistedStates + 真的 persistStates 的守卫，其余全部注入。
 * 载入是异步的（要去读文件），所以「读回来之前先写一次」是可以真实复现的。
 */
function build(fileContent, options = {}) {
  const calls = { writes: [], applied: [], errors: [] }
  let statePersistScheduled = false
  const deps = {
    // 同一个 calls：落盘替身和被测函数必须记在同一本账上。
    calls: calls,
    STATE_PATH: '/tmp/does-not-matter.json',
    runCapture: async () => {
      if (options.readFails) throw new Error('读不了')
      await new Promise((resolve) => setTimeout(resolve, 300))
      return fileContent
    },
    errorText: (error) => String(error && error.message ? error.message : error),
    console: { log: () => {}, error: (...args) => { calls.errors.push(args.join(' ')) } },
    uuid: () => 'minted-id',
    armTimeout: (fn) => { setTimeout(fn, 0); return () => {} },
    DEFAULT_MODEL: '',
    STATE_DIR: '/tmp',
    // 真的 persistStates 走到这里就算「写了一次」；内容原样记下来。
    silenceStdin: (proc) => proc,
    subprocess: {
      spawn: () => {
        let body = ''
        return {
          stdin: { write: (text) => { body += text }, end: () => { calls.writes.push(JSON.parse(body)) } },
          done: Promise.resolve(),
        }
      },
    },
  }

  const body = `
    let instanceId = ''
    let statesLoaded = false
    let persistWaiting = false
    let statePersistScheduled = false
    let remotesRaw = null
    const commandCache = new Map()
    const lastDirs = new Map()
    const states = new Map()
    const defaults = { mode: 'dsh', permissionMode: 'manual', model: '', effort: '', remote: '' }
    ${sliceFunction('loadPersistedStates')}
    ${sliceFunction('mintInstanceId')}
    async function applyPersistedStates(stored) {
      calls.applied.push(stored)
      if (typeof stored['#instance'] === 'string' && stored['#instance'].length > 0) {
        instanceId = stored['#instance']
      }
      if (stored['#remotes'] !== undefined) remotesRaw = stored['#remotes']
    }
    ${sliceFunction('persistStates')}
    return {
      load: loadPersistedStates,
      persist: persistStates,
      calls: calls,
      instance: () => instanceId,
      remotes: () => remotesRaw,
    }
  `
  const wired = body
  const names = Object.keys(deps)
  return new Function(...names, wired)(...names.map((name) => deps[name]))
}

const FILE = JSON.stringify({
  '#instance': 'the-real-id',
  '#remotes': { worker: { docker: 'claude-us' } },
  '#defaults': { mode: 'claude' },
})

const settled = () => new Promise((resolve) => setTimeout(resolve, 60))

test('载入之前的写入被压住，不会把文件换成一个空壳', async () => {
  const rig = build(FILE)
  const loading = rig.load()
  rig.persist()          // 早到的那一次——过去正是它抹掉了 #remotes
  await settled()
  assert.deepEqual(rig.calls.writes, [], '还没读回来就不许写')
  await loading
  await settled()
  assert.equal(rig.calls.writes.length >= 1, true, '读回来之后要把压住的那次补上')
  assert.deepEqual(rig.remotes(), { worker: { docker: 'claude-us' } }, '写出去的必须带着用户的目标')
})

test('实例 id 从文件里读回来，而不是每次重启换一个新的', async () => {
  const rig = build(FILE)
  await rig.load()
  assert.equal(rig.instance(), 'the-real-id', '读到了就不该再 mint')
})

test('文件不存在时才 mint 一个新 id', async () => {
  const rig = build('')
  await rig.load()
  assert.equal(rig.instance(), 'minted-id')
})

test('文件读不出来：什么都不写——宁可不存，也不能拿看不到的东西去覆盖', async () => {
  const rig = build(FILE, { readFails: true })
  await rig.load()
  rig.persist()
  await settled()
  assert.deepEqual(rig.calls.writes, [], '读失败之后写一次就是拿空内存覆盖真设置')
  assert.equal(rig.instance(), '', '连 id 都不该 mint——mint 会触发落盘')
})
