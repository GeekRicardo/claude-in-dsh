// GenUI 挂给 Claude 的方式：plugin skill，**不是**系统提示词。
//
// dsh-genui 用 `ctx.systemPrompt.section()` 把 ```dsh-ui 围栏语法教给 DSH 引擎，
// 而 Claude 对话的 pre-step 直接 reject、从不构建 dsh 的 model request，所以那条
// 路到不了 Claude。看着最顺手的补法是 `--append-system-prompt`，但它错两次：
//
//   1. 它改的正是 Claude Code 里不该由我们改的那部分；
//   2. `--system-prompt-snapshot` 默认 on —— 系统提示按会话记录一次，之后每次
//      请求和 resume 都逐字重放。注进去的东西，对那个会话再也改不掉、撤不掉。
//
// plugin skill 一个都不沾：Claude 判断相关时才加载（每轮不花 token）、有命名空间、
// `--plugin-dir` 只作用于这一个进程、路径加载失败就跳过且会话继续。文本直接用
// genui 自己的 SKILL.md，所以触发用的 description 是作者调过的那份，genui 升级
// 也自动跟上。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const source = fs.readFileSync(path.join(root, 'src/host.dynamic.js'), 'utf8')

/** 启动 Claude 的那段 argv 构造。 */
function launchArgv() {
  const start = source.indexOf("const argv = [\n        executable, '-p',")
  assert.notEqual(start, -1, 'Claude 的启动 argv 不在这儿了')
  return source.slice(start, start + 4000)
}

test('绝不动 cc 的系统提示词', () => {
  // 注释里可以解释为什么不用，代码里不许出现。
  const code = source.split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n')
  for (const flag of ['--append-system-prompt', '--system-prompt', '--append-system-prompt-file', '--system-prompt-file']) {
    assert.ok(!code.includes(flag),
      '代码里出现了 ' + flag + ' —— 系统提示词是明确不许碰的，而且 --system-prompt-snapshot'
      + ' 默认 on，注进去的东西对那个会话再也撤不掉')
  }
})

test('GenUI 走 --plugin-dir', () => {
  assert.match(launchArgv(), /argv\.push\('--plugin-dir', GENUI_PLUGIN_ROOT\)/,
    'GenUI 应当作为 plugin skill 挂上，而不是别的形式')
})

test('skill 的落盘路径符合 Claude plugin 的契约', () => {
  // 契约：plugin 根目录是 skills/ 的父目录；每个 skill 自己一个子目录，里面 SKILL.md。
  assert.match(source, /const GENUI_PLUGIN_ROOT = BROKER_ROOT \+ '\/genui-plugin'/)
  assert.match(source, /const GENUI_SKILL_DIR = GENUI_PLUGIN_ROOT \+ '\/skills\/[a-z-]+'/,
    'skill 必须住在 <root>/skills/<name>/ 下，否则 Claude 发现不了它')
  assert.match(source, /GENUI_SKILL_DIR \+ '\/SKILL\.md'/, '文件名必须是 SKILL.md')
  // --plugin-dir 要指到根，不是 skills/ 也不是 skill 自己那层。
  assert.ok(!/argv\.push\('--plugin-dir', GENUI_SKILL_DIR\)/.test(source),
    '--plugin-dir 指到了 skill 目录；它要的是 plugin 根目录')
})

test('语法取自 genui 自己的 SKILL.md，不在插件里另抄一份', () => {
  assert.match(source, /dsh-genui\/SKILL\.md/, '应当去读 genui 自己的 SKILL.md')
  // 以前这里内置过一份精简语法常量；留着就会和 genui 的版本脱节。
  assert.ok(!source.includes('GENUI_PRIMER'),
    '又出现了内置的语法副本 —— 手工副本必然和 genui 脱节，和 broker 那次一个道理')
})

test('genui 没装就一个字都不注入', () => {
  // 没有渲染器的地方（终端里的 claude、没装 genui 的部署）吐出 dsh-ui 围栏
  // 就是一堆没人渲染的 JSON，比不支持更糟。
  assert.match(source, /genuiBody\.length > 0 && await ensureGenuiSkill\(remote, genuiBody\)/,
    '必须同时满足「读到了语法」和「写过去了」才挂 --plugin-dir')
  assert.match(source, /usable \? body : ''/, '读不到就要回空串')
})

test('探测的是 dsh 所在的机器，不是 Claude 跑的那台', () => {
  const probe = source.slice(source.indexOf('function genuiSkill()'), source.indexOf('function genuiSkill()') + 700)
  assert.match(probe, /captureOn\([\s\S]*?,\s*\n?\s*null,/,
    '探测要走本机（remote=null）：渲染器在 dsh 旁边的浏览器里，不在远端目标上')
})

test('skill 按目标机器投放一次，不是每轮重写', () => {
  assert.match(source, /const genuiSkillReady = new Map\(\)/, '应当按目标缓存投放结果')
  assert.match(source, /genuiSkillReady\.get\(key\)/)
})
