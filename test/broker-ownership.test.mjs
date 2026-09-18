// broker 目录住在目标机器共享的 /tmp 里，而同一台机器可能被不止一个 dsh 驱动：
// 笔记本上的 dsh 通过 docker exec 伸进容器，容器自己又跑着一个 dsh。对第二个
// dsh 来说，第一个建的每个目录都是它没听说过的会话——「孤儿」——于是它的回收器
// 在 5 分钟空闲后就把那些 Claude 杀掉、把目录 rm -rf 了。表现出来就是「隔几分钟
// 回来一发消息就卡住」，一个下午被这么收了 11 次。
//
// 所以每次启动都在目录里盖一个 owner，扫描时别人的不动。

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

const MINUTE = 60 * 1000

/**
 * 跑真的回收器，文件系统换成一张表：每个目录给出 out.log 的年龄和 owner。
 * listing 那条 shell 命令本身也是被测对象——它得把 owner 带回来。
 */
function build(dirs, options = {}) {
  const calls = { killed: [], removed: [], logged: [], listing: '' }
  const now = Date.now()
  const deps = {
    BROKER_ROOT: '/tmp/ccmode',
    FOREIGN_REAP_MS: 24 * 60 * 60 * 1000,
    IDLE_REAP_MS: 45 * MINUTE,
    instanceId: options.instanceId ?? 'me',
    states: new Map((options.known ?? []).map((id) => [id, {}])),
    runs: new Map((options.attached ?? []).map((id) => [id, {}])),
    activeTurns: new Map(),
    agents: { list: () => [] },
    shArgv: (command) => ['/bin/sh', '-c', command],
    shellQuote: (value) => "'" + String(value).replace(/'/g, "'\\''") + "'",
    readJsonFile: async () => ({ brokerPid: 111, childPid: 222 }),
    errorText: (error) => String(error && error.message ? error.message : error),
    console: {
      log: (...args) => { calls.logged.push(args.join(' ')) },
      error: (...args) => { calls.logged.push(args.join(' ')) },
    },
    runCapture: async (argv) => {
      const command = argv[argv.length - 1]
      if (command.indexOf('for d in') === 0) {
        calls.listing = command
        return dirs.map((entry) => {
          const at = Math.round((now - entry.idleMs) / 1000)
          return '/tmp/ccmode/' + entry.sessionId + '|' + at + '|' + (entry.owner ?? '')
        }).join('\n')
      }
      if (command.indexOf('kill ') === 0) { calls.killed.push(command); return '' }
      if (command.indexOf('rm -rf ') === 0) { calls.removed.push(command.slice('rm -rf '.length).replace(/'/g, '')); return '' }
      return ''
    },
  }
  // captureOn 是插件里唯一的远端执行入口（命令串 + 目标 → stdout）。daemon 档
  // 下它走一条常驻连接，其余档下就是这里拼出来的 runCapture(shArgv(...))——
  // 断言的仍然是同一条命令串。
  deps.captureOn = (command, remote, timeoutMs) => deps.runCapture(deps.shArgv(command, remote), timeoutMs)
  const names = Object.keys(deps)
  const made = new Function(...names, `${sliceFunction('reapIdleBrokersOn')}\nreturn reapIdleBrokersOn`)(
    ...names.map((name) => deps[name]))
  return { reap: () => made(null), calls: calls }
}

test('别的 dsh 建的 broker，空闲 10 分钟也不碰', async () => {
  const rig = build([
    { sessionId: 'session-aaa', idleMs: 10 * MINUTE, owner: '另一台 dsh' },
  ])
  await rig.reap()
  assert.deepEqual(rig.calls.removed, [], '这是别人屏幕上活着的对话，不是孤儿')
  assert.deepEqual(rig.calls.killed, [])
})

test('别的 dsh 建的 broker，一天没动过才扫掉（那个 dsh 已经不在了）', async () => {
  const rig = build([
    { sessionId: 'session-aaa', idleMs: 25 * 60 * MINUTE, owner: '另一台 dsh' },
  ])
  await rig.reap()
  assert.deepEqual(rig.calls.removed, ['/tmp/ccmode/session-aaa'])
  assert.ok(rig.calls.logged.some((line) => line.indexOf('another dsh') !== -1),
    '扫别人的东西要说出来')
})

test('自己盖章的目录，规则和以前一样：不认识的会话 5 分钟就收', async () => {
  const rig = build([
    { sessionId: 'session-bbb', idleMs: 6 * MINUTE, owner: 'me' },
  ])
  await rig.reap()
  assert.deepEqual(rig.calls.removed, ['/tmp/ccmode/session-bbb'])
})

test('自己盖章、且这个会话还在，就得等满空闲期', async () => {
  const rig = build([
    { sessionId: 'session-ccc', idleMs: 6 * MINUTE, owner: 'me' },
  ], { known: ['session-ccc'] })
  await rig.reap()
  assert.deepEqual(rig.calls.removed, [], '认识的对话只是没人看，不是没了')
})

test('没有 owner 的老目录照旧（升级前留下的）', async () => {
  const rig = build([
    { sessionId: 'session-ddd', idleMs: 6 * MINUTE },
  ])
  await rig.reap()
  assert.deepEqual(rig.calls.removed, ['/tmp/ccmode/session-ddd'])
})

test('还挂着读取器或正在跑一轮的，谁都不许动', async () => {
  const rig = build([
    { sessionId: 'session-eee', idleMs: 25 * 60 * MINUTE, owner: '另一台 dsh' },
  ], { attached: ['session-eee'] })
  await rig.reap()
  assert.deepEqual(rig.calls.removed, [])
})

test('扫描那条命令必须把 owner 带回来，否则上面全是空判断', async () => {
  const rig = build([{ sessionId: 'session-fff', idleMs: MINUTE, owner: 'me' }])
  await rig.reap()
  assert.match(rig.calls.listing, /cat "\$d\/owner"/,
    'listing 不读 owner，回收器就永远看不到归属')
})

test('每次启动都往目录里盖 owner', () => {
  const launch = source.slice(source.indexOf("const launch = 'set -e; '"))
  const script = launch.slice(0, launch.indexOf("echo started"))
  assert.match(script, /shellQuote\(instanceId\)/, '启动脚本不写 owner，盖章就无从谈起')
  assert.ok(script.indexOf("dir + '/owner'") !== -1)
})

test('实例 id 是持久的：重启后还是同一个 dsh', () => {
  assert.match(source, /stored\['#instance'\]/, '不从状态文件读回来，重启后自己的目录就成了别人的')
  assert.match(source, /out\['#instance'\] = instanceId/, '不落盘就每次重启换一个名字')
  const skip = source.slice(source.indexOf("sessionId === '#commands'"))
  assert.match(skip.slice(0, 200), /'#instance'/, "#instance 必须排除在会话键之外，否则会被当成一个对话")
})
