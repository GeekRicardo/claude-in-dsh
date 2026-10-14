// 座位的下拉菜单必须贴着触发器，而不是靠「静态位置」。
//
// 这些菜单穿的是 dsh 的 `.menu`：position:fixed 且不设 inset，靠 fixed 元素
// 的「静态位置」贴住触发器。那个前提只在触发器没被滚动偏移时成立 —— 而座位
// 住在对话的滚动容器里，fixed 的静态位置按内容坐标算、**不减 scrollTop**。
//
// 实测（zhongxin/worker，55 轮，滚到底）：
//     触发器视觉位置 y=778，滚动容器 scrollTop=5094
//     菜单落在        y=5900  ≈ 5094 + 778，而视口只有 845 高
//
// 于是按钮翻成展开态、aria-expanded=true、菜单也确实在 DOM 里，就是在屏幕外。
// 表现正是「点击没有弹出菜单」。滚得越多偏得越远，所以短对话一直是好的——
// 这也是为什么一连几轮用「能不能读到 role=menuitem」去验都验不出问题：
// 那个检查只看 DOM，不看它在不在屏幕上。
//
// 座位的 .root 本来就是 relative，所以 absolute 即可贴回去，且与滚动无关。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const client = fs.readFileSync(path.join(root, 'src/client.dynamic.js'), 'utf8')

test('每一处座位菜单都带定位 class', () => {
  const uses = client.match(/className: SEL\.menu[^,\n]*/g) || []
  assert.ok(uses.length >= 2, '找到 ' + uses.length + ' 处 SEL.menu —— 少于预期')
  for (const use of uses) {
    assert.match(use, /ccmode-seat-menu/,
      '这处菜单没挂 ccmode-seat-menu，滚动后会被定位到屏幕外：' + use)
  }
})

test('定位规则把它从 fixed 改成贴着座位的 absolute', () => {
  const rule = /\.ccmode-seat-menu \{([^}]*)\}/.exec(client)
  assert.notEqual(rule, null, '.ccmode-seat-menu 的规则不见了')
  const body = rule[1]
  assert.match(body, /position:absolute/, '必须是 absolute —— fixed 就会用上不减 scrollTop 的静态位置')
  // top/left 必须让位，否则 dsh 的 fixed 残留值会继续生效
  assert.match(body, /top:auto/)
  assert.match(body, /left:auto/)
  // composer 在底部，菜单只能向上开
  assert.match(body, /bottom:calc\(100% \+ \d+px\)/, '菜单要开在触发器上方')
})

test('只作用于插件自己的菜单，不碰 dsh 的座位', () => {
  // 规则必须挂在我们自己的 class 上；直接改 dsh 的 hash class 会波及
  // DSH 对话里 dsh 自己的那些选择器（它们另有定位机制）。
  const rule = /\.ccmode-seat-menu \{/.exec(client)
  assert.notEqual(rule, null)
  assert.ok(!/\._7KE1Ra_menu\s*\{/.test(client),
    '不要直接给 dsh 的 .menu hash class 写定位规则')
})

test('菜单得有自己的面 —— dsh 把背景搬进 material 子元素后，光借 .menu 是透明的', () => {
  const rule = /\.ccmode-seat-menu \{([^}]*)\}/.exec(client)
  assert.notEqual(rule, null)
  const body = rule[1]
  assert.match(body, /background:var\(--dsw-menu-surface-fill/,
    '没有背景，手写菜单就是完全透明的（实测 background-color: rgba(0,0,0,0)）')
  assert.match(body, /backdrop-filter:var\(--dsw-menu-backdrop-filter/,
    '那个填充是半透明的，必须配模糊 —— 只给底色不给模糊就是导入面板那次的同一个错')
})

// 这一条是用一次真实事故换来的：上面那段 CSS 注释里写了一对反引号（引用
// `.menu` 这个 class 名），而整块 CSS 住在一个模板字符串里 —— 反引号提前把
// 字符串收了，后面的 CSS 变成 JS 表达式。要命的是 `node --check` 照样通过
// （碰巧语法合法），测试也全绿，直到 dsh web 整页变成
// 「Failed to load plugins / claude-in-dsh: failed」。
test('CSS 块里一个反引号都不许有', () => {
  const open = client.indexOf('styles.insert(`')
  assert.notEqual(open, -1, 'styles.insert 的模板字符串不见了')
  const close = client.indexOf('`)', open + 15)
  assert.notEqual(close, -1, 'CSS 模板字符串没有收尾 —— 多半正是反引号提前把它关了')
  const css = client.slice(open + 15, close)
  assert.equal(css.indexOf('`'), -1,
    'CSS 里出现了反引号，它会提前结束模板字符串；注释里引用 class 名时写成 .menu，不要加反引号')
  // 收尾处必须正好是整块 CSS 的末尾：括号配平能佐证没有被截断
  let depth = 0
  for (const ch of css) { if (ch === '{') depth += 1; else if (ch === '}') depth -= 1 }
  assert.equal(depth, 0, 'CSS 花括号不配平 —— 块被截断了')
})
