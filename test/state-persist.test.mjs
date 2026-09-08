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
    // 真的 runCapture 从不 reject：起不来、超时、真没文件，回来的都是 ''。
    // 所以替身也不 reject——「读失败」就是回一个空串。
    runCapture: async () => {
      await new Promise((resolve) => setTimeout(resolve, 300))
      return options.readFails ? '' : fileContent
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
  const rig = build('@@ccmode-absent@@')
  await rig.load()
  assert.equal(rig.instance(), 'minted-id')
})

// 读回来是空的，可能是「真没文件」，也可能是起不来 / 超时——runCapture 分不出来。
// 分不出来就不能当成「没东西可恢复」，否则一次超时就把全部设置写没了（实测：
// 恢复好的 11671 字节，一小时里被写回 153 字节两次，机器当时负载 80）。
test('读回来是空的（超时/起不来）：什么都不写——只有 shell 明说「文件不存在」才算空', async () => {
  const rig = build(FILE, { readFails: true })
  await rig.load()
  rig.persist()
  await settled()
  assert.deepEqual(rig.calls.writes, [], '读失败之后写一次就是拿空内存覆盖真设置')
  assert.equal(rig.instance(), '', '连 id 都不该 mint——mint 会触发落盘')
})

// 落盘必须是「写临时文件 + mv」。`cat > file` 一打开就把文件截断了，而这个插件
// 一次 dsh 启动会激活不止一次（日志里一次重启三次激活）：激活 B 正好在激活 A
// 截断的那一瞬间去读，读到空文件，于是认定「没有东西可恢复」，再把这个结论写
// 回去——用户的目标和所有对话设置就这么没了，两次。同目录内的 mv 是原子的，读
// 的人只会看到旧文件或新文件，看不到中间那个空档。
test('状态文件是 mv 进去的，不是就地截断重写', () => {
  const body = sliceFunction('persistStates')
  assert.match(body, /\.tmp\.\$\$/, '没有临时文件，就还是就地截断')
  assert.match(body, /&& mv /, '临时文件要 mv 进去，这一步才是原子的')
  // 只看真正的命令行（注释里也提到了 `cat > file`，那是在讲这个 bug 本身）。
  const command = body.split('\n').filter((line) => line.indexOf('//') === -1 && line.indexOf('cat > ') !== -1)
  assert.equal(command.length, 1, '落盘命令应该只有一处')
  assert.match(command[0], /cat > ' \+ STATE_PATH \+ '\.tmp\.\$\$/,
    'cat 的目标必须是临时文件——直接 cat > 真文件就是那个 bug 本身')
})

test('内容读回来是坏的，就当读失败——不是当成空的重来一遍', async () => {
  const rig = build('{ 这不是 JSON')
  await rig.load()
  rig.persist()
  await settled()
  assert.deepEqual(rig.calls.writes, [], '解析不了就不许写：那多半是读到了别人写到一半的文件')
  assert.equal(rig.instance(), '', '也不该 mint——mint 会触发落盘')
})
