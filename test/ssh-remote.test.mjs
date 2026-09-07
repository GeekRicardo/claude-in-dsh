// 把 Claude 跑到远端机器上：一个会话要么用本机的 claude，要么用一个配置过的
// SSH 目标。broker 模型靠文件和 fifo 通信而不是靠进程自己的 stdio，所以整套
// 远端化只需要一个间接层——shArgv 决定这条命令由哪台机器的 shell 来跑。
//
// 这里跑的是真函数，不是对着源码做正则。

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
  let i = source.indexOf('{', start)
  while (i < source.length) {
    const c = source[i]
    if (c === '"' || c === "'" || c === '`') {
      i += 1
      while (i < source.length && source[i] !== c) i += source[i] === '\\' ? 2 : 1
      i += 1
      continue
    }
    if (c === '/' && source[i + 1] === '/') {
      i = source.indexOf('\n', i)
      if (i === -1) break
      continue
    }
    if (c === '/' && source[i + 1] === '*') {
      i = source.indexOf('*/', i) + 2
      continue
    }
    if (c === '{') depth += 1
    else if (c === '}') {
      depth -= 1
      if (depth === 0) return source.slice(from, i + 1)
    }
    i += 1
  }
  throw new Error(`${name} 的花括号没有配平`)
}

function build(REMOTES = new Map()) {
  const names = ['normalizeRemote', 'sshArgvPrefix', 'dockerArgv', 'shArgv', 'remoteOf', 'remoteLockedFor', 'remoteIndex']
  // shellQuote 不走 sliceFunction：它体内的正则字面量里有引号，
  // 那个扫描器会被带偏。它自己的行为由别处的测试覆盖。
  return new Function('REMOTES', 'shellQuote', `
    ${names.map(sliceFunction).join('\n')}
    return { ${names.join(', ')} }
  `)(REMOTES, (value) => "'" + String(value).replace(/'/g, "'\\''") + "'")
}

test('别名形态：连接细节留在 ~/.ssh/config 里', () => {
  const { normalizeRemote } = build()
  const remote = normalizeRemote('devbox', { ssh: 'devbox' })
  assert.equal(remote.host, 'devbox')
  assert.equal(remote.label, 'devbox', '没写 label 就拿 id 当显示名')
  // 远端的二进制不能从本机继承：process.execPath 是这台机器上的路径。
  assert.equal(remote.claudeBin, 'claude')
  assert.equal(remote.nodeBin, 'node')
})

test('显式形态：没有 ssh_config 时也能把连接说全', () => {
  const { normalizeRemote, sshArgvPrefix } = build()
  const remote = normalizeRemote('box', {
    ssh: 'root@10.0.0.2', port: 2222, identityFile: '/keys/id_ed25519',
    sshOptions: ['StrictHostKeyChecking=accept-new'], label: 'Box', claude: '/opt/claude', node: '/opt/node',
  })
  const argv = sshArgvPrefix(remote)
  assert.deepEqual(argv.slice(-1), ['root@10.0.0.2'], 'host 必须是最后一个参数，后面才轮到命令')
  assert.ok(argv.includes('-p') && argv.includes('2222'))
  assert.ok(argv.includes('-i') && argv.includes('/keys/id_ed25519'))
  assert.ok(argv.includes('IdentitiesOnly=yes'), '给了私钥就只用这把，别让 agent 里的钥匙抢答')
  assert.ok(argv.includes('StrictHostKeyChecking=accept-new'), 'sshOptions 要原样带上')
  assert.equal(remote.claudeBin, '/opt/claude')
  assert.equal(remote.nodeBin, '/opt/node')
})

test('一次转轮要发几十条小命令，所以必须复用连接', () => {
  const { normalizeRemote, sshArgvPrefix } = build()
  const argv = sshArgvPrefix(normalizeRemote('devbox', { ssh: 'devbox' }))
  const joined = argv.join(' ')
  // 没有 ControlMaster 的话，每次 stat/kill -0 都要重新握手一次 TCP + 认证。
  assert.ok(joined.includes('ControlMaster=auto'), '不复用连接的话这个设计不成立')
  assert.ok(joined.includes('ControlPersist'))
  // 要密码短语的目标不能把插件卡在一个没人看得见的提示上。
  assert.ok(joined.includes('BatchMode=yes'))
  assert.ok(argv.includes('-T'), '不要分配 pty——流是 JSON 行')
})

test('半截配置只丢掉它自己，不拖垮整张表', () => {
  const { normalizeRemote } = build()
  assert.equal(normalizeRemote('x', null), null)
  assert.equal(normalizeRemote('x', {}), null, '没有 ssh 就没法连')
  assert.equal(normalizeRemote('x', { ssh: '   ' }), null)
  assert.equal(normalizeRemote('x', { ssh: 'h', port: 0 }).port, '', '端口非法就当没写，而不是拼出 -p 0')
  assert.deepEqual(normalizeRemote('x', { ssh: 'h', sshOptions: ['ok', 42, ''] }).options, ['ok'])
})

test('每一跳都落到 /bin/sh -c，不看用户的登录 shell 脸色', () => {
  const { normalizeRemote, shArgv } = build()
  const command = "cat '/tmp/ccmode/session-1/meta.json' 2>/dev/null"
  assert.deepEqual(shArgv(command, null), ['/bin/sh', '-c', command])
  const remoteArgv = shArgv(command, normalizeRemote('devbox', { ssh: 'devbox' }))
  assert.equal(remoteArgv[0], 'ssh')
  assert.equal(remoteArgv[remoteArgv.length - 2], 'devbox')
  // ssh 把参数交给「账号的登录 shell」——那可能是 zsh（空 glob 直接中止整条
  // 命令）或 fish（根本读不懂 for…do…done）。所以显式点名 /bin/sh，
  // 代价是为 ssh 这一跳多引用一次。这是真机上踩出来的：worker 的 zsh 让
  // `.*/` 无匹配时整个列目录命令静默失败。
  assert.equal(remoteArgv[remoteArgv.length - 1], "'/bin/sh' '-c' " + q(command))
})

/** 和实现里的 shellQuote 同一套规则，用来拼期望值。 */
function q(v) { return "'" + String(v).replace(/'/g, "'\\''") + "'" }

test('指向一个已经不存在的目标时，退回本机而不是打不开', () => {
  const { normalizeRemote, remoteOf } = build(new Map([['devbox', { id: 'devbox' }]]))
  assert.equal(remoteOf({ remote: 'devbox' }).id, 'devbox')
  assert.equal(remoteOf({ remote: 'gone' }), null)
  assert.equal(remoteOf({ remote: '' }), null)
  assert.equal(remoteOf({}), null)
  assert.equal(remoteOf(undefined), null)
  assert.ok(normalizeRemote)
})

test('跑过一轮之后就钉死在那台机器上', () => {
  const { remoteLockedFor } = build()
  // Claude 的对话就是它的 transcript，而那个文件只在一台机器上。
  assert.equal(remoteLockedFor({}), false)
  assert.equal(remoteLockedFor({ claudeSessionId: '' }), false)
  assert.equal(remoteLockedFor({ claudeSessionId: 'abc' }), true)
})

test('选择器里本机永远排第一', () => {
  const { remoteIndex } = build(new Map([['devbox', { id: 'devbox', label: 'Devbox', host: 'devbox' }]]))
  const rows = remoteIndex()
  assert.equal(rows[0].id, '', '空 id 就是本机')
  assert.equal(rows[1].id, 'devbox')
  assert.equal(rows[1].label, 'Devbox')
})

test('远端会话不能开在 dsh 工作区那条路径上', async () => {
  // 那是本机的目录，远端多半没有——`set -e` 下 cd 直接就失败了。
  const calls = []
  const names = ['remoteHome', 'remoteCwdOf']
  const made = new Function('runCapture', 'shArgv', 'calls', `
    ${names.map(sliceFunction).join('\n')}
    return { ${names.join(', ')} }
  `)(
    (argv) => { calls.push(argv); return Promise.resolve('/home/dev\n') },
    (command) => command,
    calls,
  )
  // 会话自己选过就用它的
  assert.equal(await made.remoteCwdOf({ remoteCwd: '/srv/app' }, { dir: '/srv/work' }), '/srv/app')
  // 否则用目标声明的
  assert.equal(await made.remoteCwdOf({}, { dir: '/srv/work' }), '/srv/work')
  // 都没有就问远端的 home——而且只问一次
  const remote = { dir: '' }
  assert.equal(await made.remoteCwdOf({}, remote), '/home/dev')
  assert.equal(await made.remoteCwdOf({}, remote), '/home/dev')
  assert.equal(calls.length, 1, 'home 该记住，不该每轮都去问一次')
})

test('目标可以声明自己的项目目录', () => {
  const { normalizeRemote } = build()
  assert.equal(normalizeRemote('d', { ssh: 'd', dir: '  /srv/work  ' }).dir, '/srv/work')
  assert.equal(normalizeRemote('d', { ssh: 'd' }).dir, '', '没写就等于「远端的 home」')
})

test('容器不需要 ssh —— docker exec 是同一份契约', () => {
  const { normalizeRemote, shArgv } = build()
  const remote = normalizeRemote('app', { docker: 'myapp-1' })
  assert.equal(remote.host, '', '只声明容器就不该拼 ssh')
  const command = "cat '/tmp/ccmode/session-1/meta.json' 2>/dev/null"
  const argv = shArgv(command, remote)
  assert.deepEqual(argv, ['docker', 'exec', '-i', 'myapp-1', '/bin/sh', '-c', command])
  // -i 不是可选的：broker 的 stdin 和每次 `cat > fifo` 都要这条通道。
  assert.ok(argv.includes('-i'))
  // 没有 -t：流是 JSON 行，pty 会把它弄坏，和 ssh 那边同理。
  assert.ok(!argv.includes('-t'))
})

test('容器可以指定用户', () => {
  const { normalizeRemote, shArgv } = build()
  const argv = shArgv('echo x', normalizeRemote('app', { docker: 'c', dockerUser: 'dev' }))
  assert.deepEqual(argv.slice(0, 5), ['docker', 'exec', '-i', '-u', 'dev'])
})

test('另一台机器上的容器：docker 命令由 ssh 驮过去', () => {
  const { normalizeRemote, shArgv } = build()
  const argv = shArgv('echo hi', normalizeRemote('prod', { docker: 'api', ssh: 'prod' }))
  assert.equal(argv[0], 'ssh')
  assert.equal(argv[argv.length - 2], 'prod')
  // 远端登录 shell 会把这串重新解析一次，所以 docker 那层要为这一跳引用好
  assert.equal(argv[argv.length - 1], "'docker' 'exec' '-i' 'api' '/bin/sh' '-c' 'echo hi'")
})

test('两种运载方式都没声明就不是一个能用的目标', () => {
  const { normalizeRemote } = build()
  assert.equal(normalizeRemote('x', { label: '只有名字' }), null)
  assert.ok(normalizeRemote('x', { docker: 'c' }), '只有容器也成立')
  assert.ok(normalizeRemote('x', { ssh: 'h' }), '只有 ssh 也成立')
})

test('用量读数按机器分开：远端会话不该看到本机的窗口', () => {
  const made = new Function(`
    const usageByTarget = new Map()
    ${sliceFunction('usageCellOf')}
    return { usageCellOf, usageByTarget }
  `)()
  const here = made.usageCellOf(null)
  const there = made.usageCellOf({ id: 'devbox' })
  here.value = { official: true, windows: [{ id: 'five_hour' }] }
  assert.equal(there.value, null, '订阅属于那台机器登录的账号，不是这台的')
  assert.equal(made.usageCellOf(null), here, '同一台机器拿到同一个格子')
  assert.equal(made.usageByTarget.size, 2)
})

test('斜杠命令表按机器分开——各机器可以有自己的自定义命令', () => {
  const made = new Function('FALLBACK_COMMANDS', 'persistStates', `
    let commandCache = new Map()
    ${sliceFunction('rememberCommands')}
    ${sliceFunction('claudeCommands')}
    return { rememberCommands, claudeCommands, commandCache }
  `)(['/help'], () => {})
  made.rememberCommands(['/help', '/local-only'], null)
  made.rememberCommands(['/help', '/deploy'], { id: 'devbox' })
  assert.deepEqual(made.claudeCommands(null), ['/help', '/local-only'])
  assert.deepEqual(made.claudeCommands({ id: 'devbox' }), ['/help', '/deploy'])
  // 没握过手的机器落回兜底表，而不是借用别人的
  assert.deepEqual(made.claudeCommands({ id: 'never-seen' }), ['/help'])
})

test('导入这类按目录浏览的动作没有会话可问，就跟随上次选定的目标', () => {
  const REMOTES = new Map([['devbox', { id: 'devbox' }]])
  const made = new Function('REMOTES', 'defaults', `
    ${sliceFunction('browsingRemote')}
    return browsingRemote
  `)(REMOTES, { remote: 'devbox' })
  assert.equal(made({}).id, 'devbox', '和「新对话开在上次选定的配置上」同一条规矩')
  assert.equal(made({ remote: '' }), null, '显式指定本机时以它为准')
  assert.equal(made({ remote: 'gone' }), null, '指向不存在的目标就退回本机')
})

test('目录浏览的「上一级」由远端 pwd 的结果算出，根目录到头', () => {
  const parentDir = new Function(`${sliceFunction('parentDir')}; return parentDir`)()
  assert.equal(parentDir('/'), null, '根目录没有上一级')
  assert.equal(parentDir('/root'), '/')
  assert.equal(parentDir('/root/code/deepseek'), '/root/code')
  assert.equal(parentDir('/root/code/'), '/root', '远端 pwd 不会带尾斜杠，但带了也不该多出一级')
  // 客户端看不见那个文件系统，所以只认远端 shell 自己答出来的绝对路径
  assert.equal(parentDir('relative/path'), null)
  assert.equal(parentDir(''), null)
  assert.equal(parentDir(undefined), null)
})

test('容器目标用解析出来的 docker 路径，而不是裸名', () => {
  const { normalizeRemote, shArgv } = build()
  // dsh 常由 pm2/launchd 拉起，PATH 不是登录 shell 的那份；macOS 上
  // docker 就在 /usr/local/bin 这种它通常没有的目录里。真机上踩过：
  // spawn 直接 ENOENT，而且一个字的 stderr 都没有。
  const remote = normalizeRemote('app', { docker: 'c' })
  assert.equal(remote.dockerBin, '', '还没解析时留空')
  assert.equal(shArgv('echo x', remote)[0], 'docker', '解析不到就退回裸名')
  remote.dockerBin = '/usr/local/bin/docker'
  assert.equal(shArgv('echo x', remote)[0], '/usr/local/bin/docker')
})

test('配置里可以直接指定 docker 路径，跳过解析', () => {
  const { normalizeRemote, shArgv } = build()
  const remote = normalizeRemote('app', { docker: 'c', dockerBin: '/opt/homebrew/bin/docker' })
  assert.equal(shArgv('echo x', remote)[0], '/opt/homebrew/bin/docker')
})

// 这条是被真机上的一个 bug 逼出来的：readJsonFile / isAlive / fileSize 这些
// helper 的 remote 是最后一个参数，漏传就默认成「本机」——不报错、不告警，
// 只是安静地去读错机器。当时 broker 在容器里活得好好的，而就位判定在轮询
// 宿主机上一个根本不存在的同名路径，5 秒后报「broker 未就位」。
// 人眼看不住这个，所以让测试看。
test('凡是跟着会话走的调用，都必须把 remote 传下去', () => {
  // helper 名 → 带上 remote 之后的最少参数个数
  const WANT = {
    readJsonFile: 2, isAlive: 2, fileSize: 2, fileSizeOfShellWord: 2,
    createRun: 5, lastAiTitle: 3, mcpScopes: 2, lastBackgroundTaskCount: 2,
    previewClaudeConversation: 4, listClaudeConversations: 2,
    searchClaudeConversations: 3, recordPromptHistory: 4, usageSnapshot: 2,
  }
  const offenders = []
  const lines = source.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    for (const name of Object.keys(WANT)) {
      if (new RegExp('function\\s+' + name + '\\b').test(line)) continue
      for (const hit of line.matchAll(new RegExp('\\b' + name + '\\(', 'g'))) {
        const rest = line.slice(hit.index + hit[0].length)
        let depth = 1
        let args = 1
        let taken = 0
        for (const ch of rest) {
          if ('([{'.includes(ch)) depth += 1
          else if (')]}'.includes(ch)) { depth -= 1; if (depth === 0) break }
          else if (ch === ',' && depth === 1) args += 1
          taken += 1
        }
        if (depth !== 0) continue                       // 跨行的调用这里不判
        if (rest.slice(0, taken).trim() === '') args = 0
        if (args < WANT[name]) offenders.push((index + 1) + ': ' + line.trim())
      }
    }
  }
  assert.deepEqual(offenders, [],
    '这些调用漏了 remote，会静默读本机：\n' + offenders.join('\n'))
})

// CLI 在一轮没有可见输出之后，会注入一条 user 消息：
// "[Your previous response had no visible output. Please continue…]"。
// 它被投影成普通用户消息的话，在 dsh 里就长成「人说的话」——而它恰恰在
// 人要求「不要有多余输出」时触发，等于用人的口气反驳人。
// CLI 是打了标记的：transcript 里 isMeta，流里 isSynthetic。
test('CLI 自己的记账行不进转录', () => {
  const machineryRow = new Function(`${sliceFunction('machineryRow')}; return machineryRow`)()
  assert.equal(machineryRow({ isMeta: true }), true, 'jsonl 里的标记')
  assert.equal(machineryRow({ isSynthetic: true }), true, '流里的标记')
  // 真正的后台完成通知没有标记——它是要送到模型面前的
  assert.equal(machineryRow({ type: 'user' }), false)
  assert.equal(machineryRow({ isMeta: false, isSynthetic: false }), false)
  assert.equal(machineryRow(null), false)
  assert.equal(machineryRow(undefined), false)
})

test('每一处读会话行的地方都要挡住它', () => {
  // 五处读 jsonl / out.log 的循环 + 实时流那处，漏一处就会从那条路漏进来
  const guarded = (source.match(/isSidechain === true \|\| event\.isReplay === true \|\| machineryRow\(event\)/g) || []).length
  assert.equal(guarded, 5, '读行的五个循环都要判')
  assert.match(source, /message\.isReplay === true \|\| machineryRow\(message\)/, '实时流那处也要判')
})

// out.log 是 append-only 且跨重启保留的。重开一个进程时若从 0 开始读，
// 上一个进程的整段对话会被再投影一遍。/restart 让重开变得一点就有，
// 所以这条得钉住：起点是「重开之前 out.log 的大小」，而且必须在 spawn
// 之前量 —— 之后量会和子进程自己的 init 行赛跑，丢了那行就丢了模型与会话绑定。
test('重开进程从上一个进程的输出之后开始读', () => {
  const launch = sliceFunction('ensureRun')
  const measure = launch.indexOf("const priorLog = await fileSize(dir + '/out.log', remote)")
  const spawn = launch.indexOf('const started = subprocess.spawn({')
  const use = launch.indexOf('run.offset = priorLog')
  assert.notEqual(measure, -1, '没有量重开前的日志大小')
  assert.notEqual(use, -1, 'run.offset 没有用上它')
  assert.ok(measure < spawn, '必须在 spawn 之前量，否则和 init 行赛跑')
  assert.ok(!/run\.offset = 0\b/.test(launch), '不该再有从 0 开始读的路径')
})

test('目录按目标记：换一台机器不会带着上一台的路径开', () => {
  const lastDirs = new Map()
  const made = new Function('lastDirs', 'persistStates', `
    ${sliceFunction('rememberDir')}
    return rememberDir
  `)(lastDirs, () => {})
  made({ id: 'devbox' }, '/srv/work')
  made({ id: 'app' }, '/workspace')
  assert.equal(lastDirs.get('devbox'), '/srv/work')
  assert.equal(lastDirs.get('app'), '/workspace', '两台机器各记各的')
  // 本机没有「目标」这个概念，工作目录由 dsh 工作区决定
  made(null, '/whatever')
  assert.equal(lastDirs.size, 2)
  // 空值不该把记住的抹掉
  made({ id: 'devbox' }, '')
  assert.equal(lastDirs.get('devbox'), '/srv/work')
})

test('新会话继承的是「这个目标上次的目录」', () => {
  const lastDirs = new Map([['devbox', '/srv/work'], ['app', '/workspace']])
  const build = (remote) => new Function('defaults', 'states', 'lastDirs', 'DEFAULT_MODEL', 'committedEngine', `
    ${sliceFunction('stateOf')}
    return stateOf
  `)({ mode: 'claude', permissionMode: 'manual', model: 'm', effort: '', remote: remote },
     new Map(), lastDirs, 'm', () => undefined)
  assert.equal(build('devbox')('s1').remoteCwd, '/srv/work')
  assert.equal(build('app')('s2').remoteCwd, '/workspace', '换目标就换目录')
  assert.equal(build('')('s3').remoteCwd, '', '本机不带远端目录')
  assert.equal(build('never-used')('s4').remoteCwd, '', '没记过的目标留空，由目标的 dir / home 兜底')
})

// dsh 0.1.2-rc.1 把 Session 的事件日志改成私有：公开数组 `session.events`
// 没了，取而代之的是 snapshotEvents()。升级后第一轮就抛
// "session.events is not iterable"。两种形态都认，因为一台机器升级了
// 不等于这插件跑的每台机器都升级了。
test('事件日志：新老两种 dsh 都读得到', () => {
  const sessionEvents = new Function(`${sliceFunction('sessionEvents')}; return sessionEvents`)()
  const rows = [{ type: 'turn/start' }, { type: 'turn/end' }]

  // 0.1.2：私有日志 + 快照方法
  let asked = 0
  assert.deepEqual(sessionEvents({ snapshotEvents: () => { asked += 1; return rows } }), rows)
  assert.equal(asked, 1, '快照是按次要的——它自己缓存到下次 append')

  // ≤0.1.1：公开数组
  assert.deepEqual(sessionEvents({ events: rows }), rows)

  // 两个都没有，或者根本没 session：给空表，别把一轮炸掉
  assert.deepEqual(sessionEvents({}), [])
  assert.deepEqual(sessionEvents({ events: 'not an array' }), [])
  assert.deepEqual(sessionEvents(undefined), [])
  assert.deepEqual(sessionEvents(null), [])

  // 新形态优先：两个都在时不该去读那个陈旧的数组
  assert.deepEqual(sessionEvents({ snapshotEvents: () => rows, events: [] }), rows)
})

test('访问器之外，不再有任何地方直接摸 session.events', () => {
  // 挖掉访问器自身（它内部当然要读那个旧字段兜底），再剥掉注释——
  // 这条守卫管的是代码，不是散文里提到这个名字。
  const outside = source.replace(sliceFunction('sessionEvents'), '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
  const leaks = outside.match(/session\.events/g) || []
  assert.deepEqual(leaks, [], '还有地方直接读 session.events，在 dsh 0.1.2 上会炸')
})

// 「跑在本机」是一个选择，不是「没选过」。这两者在盘上必须能区分：
// 早先写盘时省掉了空值，于是 dsh 一重启，本机会话就被按 #defaults.remote
// 重新播种、静默漂到默认目标上——transcript 留在一台机器，进程重开在另一台。
test('明确选了本机，重启后不会漂到默认目标上', () => {
  const written = (() => {
    const state = { mode: 'claude', permissionMode: 'manual', model: 'm', effort: '',
      remote: '', claudeSessionId: 'cs-1' }
    const remote = typeof state.remote === 'string' ? state.remote : ''
    // 与实现里那段落盘表达式同形
    return {
      mode: state.mode,
      remote: remote,
      ...(claudeIdOf(state) === '' ? {} : { claudeSessionId: claudeIdOf(state) }),
    }
    function claudeIdOf(s) { return s.claudeSessionId === undefined ? '' : s.claudeSessionId }
  })()
  assert.ok('remote' in written, '空的 remote 也必须写进去，否则和「没选过」无法区分')
  assert.equal(written.remote, '')

  // 读回来：键在 → 用它；键不在 → 才继承默认
  const load = (saved, defaultRemote) => {
    const state = { remote: defaultRemote }
    if (typeof saved.remote === 'string') state.remote = saved.remote
    return state.remote
  }
  assert.equal(load(written, 'worker'), '', '写过本机就该还是本机')
  assert.equal(load({}, 'worker'), 'worker', '真的没选过才继承默认')
})

test('落盘表达式本身不再省略空的 remote', () => {
  // 钉住实现：这一处一旦改回 `remote === '' ? {} : …`，上面那个漂移就回来了
  assert.doesNotMatch(source, /\.\.\.\(remote === '' \? \{\} : \{ remote: remote \}\)/,
    '空 remote 又被省掉了——本机会话会在重启后漂到默认目标')
  assert.match(source, /^\s+remote: remote,$/m, '落盘里应无条件写 remote')
})
