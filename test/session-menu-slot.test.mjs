// 会话行 ⋯ 菜单：从 DOM 克隆迁到 dsh 的正式槽位。
//
// 原来的做法是把 dsh 已经渲染出来的菜单行克隆一份、改掉文字、插进 DOM，再用
// MutationObserver 加一个 300ms 轮询不停地重插——因为 dsh 的 Menu 会自己量尺寸
// 并在最终位置重渲染，那次 reconcile 会把 React 不认识的节点丢掉。dsh 0.2 把这
// 个座位正式声明了（`sidebar.workspaces.session.menu.item`，它自己的 JSDoc 例子
// 就是「复制 session id」这一项），所以克隆、观察者、轮询、插入顺序的小把戏全部
// 不需要了，而且这两行成了 dsh 列表真正的子节点，它的键盘遍历和焦点归还都认。
//
// 项目行（workspace row）的菜单**没有**槽位——dsh 直接渲染 rename/delete，
// 契约里只有 session.menu.item / session.row.action / directoryFlow 三个——
// 所以「导入 Claude Code 对话」那一项仍然走克隆，这是有意保留的。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const client = fs.readFileSync(path.join(root, 'src/client.dynamic.js'), 'utf8')

const SEAT = 'sidebar.workspaces.session.menu.item'

/** The `{ … }` option literals of every slots.register for one seat name. */
function registrations(seat) {
  const found = []
  const needle = new RegExp("slots\\.register\\(\\s*\\{([^}]*name: '" + seat + "'[^}]*)\\}", 'g')
  let match
  while ((match = needle.exec(client)) !== null) found.push(match[1])
  return found
}

test('两项都注册到了正式槽位上', () => {
  const rows = registrations(SEAT)
  assert.equal(rows.length, 2, '应当正好两项：复制 UUID 和同步')
})

test('每一项都带 id——list 槽位缺 id 会静默丢掉这一行', () => {
  for (const row of registrations(SEAT)) {
    const id = /id: '([^']+)'/.exec(row)
    assert.notEqual(id, null, '这一项没有 id：' + row.trim())
    assert.match(id[1], /^ccmode-/, 'id 要带包的前缀，避免撞上 dsh 自己的行：' + id[1])
  }
})

test('排在 dsh 自己那几行之前（pin 是 100）', () => {
  const orders = registrations(SEAT).map((row) => {
    const order = /order: (-?\d+)/.exec(row)
    assert.notEqual(order, null, '这一项没有 order：' + row.trim())
    return Number(order[1])
  })
  assert.equal(orders.length, 2)
  for (const order of orders) assert.ok(order < 100, 'order ' + order + ' 会跑到 dsh 的 pin(100) 后面去')
  assert.notEqual(orders[0], orders[1], '两项的 order 不能相同，否则相对顺序没定义')
  assert.ok(orders[0] < orders[1], '复制 UUID 要排在同步之前')
})

test('会话行的 DOM 克隆已经彻底拆掉', () => {
  for (const gone of ['injectResumeItem', 'RESUME_ITEM_CLASS', 'SYNC_ITEM_CLASS', 'pendingSession']) {
    assert.ok(!client.includes(gone), gone + ' 还在——迁移没做干净，两套机制会同时往菜单里塞东西')
  }
})

test('项目行仍然走克隆——那个菜单没有槽位，这是有意的', () => {
  assert.ok(client.includes('injectImportItem'), '导入那一项没有槽位可用，不能跟着一起删')
  assert.ok(client.includes('IMPORT_ITEM_CLASS'))
  assert.ok(client.includes('function cloneMenuItem'), '克隆器还有这一个使用者')
})

test('菜单项穿的是 dsh 自己 MenuItemButton 的 class，不是另写一套', () => {
  const block = /const MENU = \{([^}]*)\}/.exec(client)
  assert.notEqual(block, null, 'MENU class 表不见了')
  for (const key of ['itemWrap', 'item', 'itemIcon', 'itemLabel']) {
    assert.match(block[1], new RegExp(key + ": '_"), key + ' 缺失或不是 CSS module 的 hash 名')
  }
  // 自己写样式就等于「近似」，而这个插件的做法是借 class 继承 dsh 的真样式。
  assert.ok(!/\.ccmode-menu-item\s*\{/.test(client), '不该为菜单项另写一套 CSS')
})

test('可见性由组件自己判断，而且不额外发请求', () => {
  // 槽位对每一个会话行都渲染一次（Claude 的和 dsh 的都渲染），所以组件必须自己
  // 认出「这是 Claude 对话吗」；读的是 badge 画笔已经在轮询的那份 engines，
  // 17 个会话不该变成 17 次 state.get。
  assert.match(client, /engines\[sessionId\] !== 'claude'\) return null/,
    '组件没有按 engines 判断可见性')
  assert.match(client, /if \(changed\) notify\(\)/,
    'engines 变了要 notify，否则组件不会重渲染，切换引擎后菜单项不跟着变')
})
