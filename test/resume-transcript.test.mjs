// 「这个对话的 Claude 会话有没有 transcript」这个判断，决定的是 `--resume` 还是
// 「重开一个空的」。而 `runCapture` 从不抛异常：命令超时和「文件真不存在」回来的
// 都是空串。把空串读成「不存在」，代价是一整个对话的上下文。
//
// 实测现场：那个 30MB 的 transcript 一直好好地躺在原地，只是机器负载 80，一次
// `stat` 超过了它的五秒，回来是空的。插件于是认定「没什么可恢复的」，用一个全新的
// 空 Claude 会话把对话接着往下开——页面上还是原来那条对话，驱动它的模型却什么都
// 不记得了。用户看到的是「收到了子对话的回复，但页面卡住、没有任何输出」。

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

function build(answer) {
  const seen = []
  const deps = {
    runCapture: async (argv) => { seen.push(argv[argv.length - 1]); return answer },
    shArgv: (command) => ['/bin/sh', '-c', command],
  }
  const names = Object.keys(deps)
  const fn = new Function(...names, `${sliceFunction('fileExistsOfShellWord')}\nreturn fileExistsOfShellWord`)(
    ...names.map((name) => deps[name]))
  return { exists: fn, seen: seen }
}

test('shell 明说 yes / no 才算数', async () => {
  assert.equal(await build('yes\n').exists('/x'), 'yes')
  assert.equal(await build('no\n').exists('/x'), 'no')
})

test('空串是「不知道」，不是「不存在」——这就是丢掉对话上下文的那一步', async () => {
  assert.equal(await build('').exists('/x'), 'unknown')
  assert.equal(await build('   \n').exists('/x'), 'unknown')
  assert.equal(await build('stat: 谁知道呢').exists('/x'), 'unknown')
})

test('问的是存在性，不是大小——大小拿不到时也会是 0', async () => {
  const rig = build('yes')
  await rig.exists("'/tmp/a b.jsonl'")
  assert.match(rig.seen[0], /if \[ -f '\/tmp\/a b\.jsonl' \]; then echo yes; else echo no; fi/)
})

test('只有确定的 no 才放弃 --resume；不确定就照样 resume', () => {
  const ensure = sliceFunction('ensureRun')
  const at = ensure.indexOf('has no transcript on disk')
  assert.notEqual(at, -1, '这段判断不见了')
  const around = ensure.slice(at - 400, at + 500)
  assert.match(around, /const exists = await fileExistsOfShellWord\(transcript, remote\)/,
    '必须用三态判断，不能再拿文件大小 <= 0 当「不存在」')
  assert.match(around, /if \(exists === 'no'\)/, '只有确定的 no 才允许把 resume 清掉')
  assert.match(around, /exists === 'unknown'/, "'unknown' 要单独处理，而且必须继续 resume")
  const unknownAt = around.indexOf("exists === 'unknown'")
  const resetAt = around.indexOf('resume = null')
  assert.ok(resetAt < unknownAt, 'resume = null 只能出现在 no 分支里')
  assert.equal(around.slice(unknownAt).indexOf('resume = null'), -1,
    'unknown 分支里绝对不能清掉 resume——那正是丢上下文的那一行')
})
