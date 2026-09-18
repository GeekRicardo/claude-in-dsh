// 一个 broker 死了却不吭声，是这套设计里最坏的一种失败。
//
// 插件靠 `exit.json` 加上对 broker pid 的存活检查来决定「重新挂上去」还是「重开
// 一个」。一个被未处理的 stream 'error' 干掉的 Node 进程两样都不留：exit.json 没
// 有，pid 还在——因为它成了僵尸，而这个容器的 pid 1 是 `sleep infinity`，永远不会
// 去收尸。于是 `kill -0` 说「活着」，插件重新挂上一个死掉的 broker，把每一条
// prompt 写进一个没人读的 fifo。对话就那么不说话了，哪儿都没有一行字解释为什么。
//
// 实测现场：broker 退出码 1，它的 Claude 退出码 0（stdin EOF，因为握着 fifo 的只
// 有我们），out.log 断在半句话上，没有 exit.json，一轮挂了几个小时才被发现。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const source = fs.readFileSync(path.join(root, 'src/host.dynamic.js'), 'utf8')
const BROKER = path.join(root, 'lib/broker.mjs')

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

const liveness = new Function('captureOn', `${sliceFunction('isAlive')}\nreturn isAlive`)(
  // captureOn(命令串, 目标, 超时)：插件里唯一的远端执行入口。本机档就是 /bin/sh -c。
  async (command) => {
    const { execFileSync: run } = await import('node:child_process')
    return run('/bin/sh', ['-c', command], { encoding: 'utf8' })
  },
)

function waitFor(check, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    const tick = () => {
      let value
      try { value = check() } catch (error) { value = undefined }
      if (value !== undefined && value !== false) return resolve(value)
      if (Date.now() > deadline) return reject(new Error('等超时了'))
      setTimeout(tick, 40)
    }
    tick()
  })
}

test('僵尸不算活着——这正是插件挂到死 broker 上的那一步', async () => {
  // 真造一个僵尸：Node 的子进程回收发生在事件循环里，父进程把循环堵死，子进程
  // 退出后就没人 wait 它——这正是那个 broker 留下的状态。
  const RECIPE = 'const cp=require("child_process"),fs=require("fs");'
    + 'const c=cp.spawn("/bin/true");fs.writeSync(1,String(c.pid)+"\\n");'
    + 'const end=Date.now()+8000;while(Date.now()<end){}'
  const holder = spawn(process.execPath, ['-e', RECIPE], { stdio: ['ignore', 'pipe', 'ignore'] })
  try {
    const pid = await new Promise((resolve) => {
      holder.stdout.once('data', (chunk) => resolve(Number(String(chunk).trim())))
    })
    assert.ok(pid > 0, '没拿到后台任务的 pid')
    const zombie = await waitFor(() => {
      const state = execFileSync('/bin/sh', ['-c', `ps -o stat= -p ${pid} 2>/dev/null | tr -d ' '`], { encoding: 'utf8' }).trim()
      return state.startsWith('Z') ? state : undefined
    })
    assert.match(zombie, /^Z/, '这个测试要的就是一个僵尸')

    assert.equal(await liveness(pid), false, '僵尸必须判成死的，否则插件会去挂它')
    assert.equal(await liveness(holder.pid), true, '真活着的进程要判成活的')
    assert.equal(await liveness(0), false)
    assert.equal(await liveness(undefined), false)
  } finally {
    holder.kill('SIGKILL')
  }
})

test('broker 被未处理的 stream 错误打死时，也要留下 exit.json', async () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'ccmode-death-'))
  execFileSync('mkfifo', [path.join(dir, 'in')])
  fs.writeFileSync(path.join(dir, 'meta.json'), '{}')
  // out.log 是个目录：写它必然 EISDIR。这就是「日志流报错」的可复现形态；修之前
  // 这个错没人接，Node 直接以 1 退出，什么都不留。
  fs.mkdirSync(path.join(dir, 'out.log'))

  const broker = spawn(process.execPath, [BROKER, dir, '/bin/sh', '-c', 'sleep 30'], { stdio: 'ignore' })
  try {
    // 一定要真的死掉。实测 process.exit() 在日志流失败之后会卡在退出路径里出不来，
    // 进程还活着——一个杀不死的 broker 正是这个文件最不能留下的东西，所以现在是
    // 自己给自己一刀。信号死也是死。
    const how = await new Promise((resolve) => broker.on('exit', (code, signal) => resolve({ code, signal })))
    assert.ok(how.code === 1 || how.signal === 'SIGKILL', '写不了日志就该退出，而不是装作没事：' + JSON.stringify(how))
    const exited = JSON.parse(fs.readFileSync(path.join(dir, 'exit.json'), 'utf8'))
    assert.match(String(exited.brokerError), /out\.log/, 'exit.json 要说清楚是日志流出的问题')
    assert.ok(typeof exited.at === 'number')
  } finally {
    broker.kill('SIGKILL')
  }
})

test('Claude 正常退出时，cc-exit 和 exit.json 一个都不少', async () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'ccmode-death-'))
  execFileSync('mkfifo', [path.join(dir, 'in')])
  fs.writeFileSync(path.join(dir, 'meta.json'), '{}')
  fs.writeFileSync(path.join(dir, 'out.log'), '')

  const broker = spawn(process.execPath, [BROKER, dir, '/bin/sh', '-c', 'exit 7'], { stdio: 'ignore' })
  try {
    await new Promise((resolve) => broker.on('exit', resolve))
    const exited = JSON.parse(fs.readFileSync(path.join(dir, 'exit.json'), 'utf8'))
    assert.equal(exited.code, 7)
    const log = fs.readFileSync(path.join(dir, 'out.log'), 'utf8')
    assert.match(log, /"type":"cc-exit"/, '附着的插件靠这一行知道进程没了，而不是干等')
  } finally {
    broker.kill('SIGKILL')
  }
})

test('每一条离开 broker 的路都先写记录', () => {
  const broker = fs.readFileSync(path.join(root, 'src/broker.mjs'), 'utf8')
  for (const hook of ['uncaughtException', 'unhandledRejection']) {
    assert.ok(broker.indexOf("process.on('" + hook + "'") !== -1,
      hook + ' 没接住，broker 就会重演那次「死了但 pid 还在」')
  }
  assert.match(broker, /out\.on\('error'/, '日志写入流的 error 必须有人接')
  assert.match(broker, /fifoReader\.on\('error'/, 'fifo 读取流的 error 必须有人接')
})
