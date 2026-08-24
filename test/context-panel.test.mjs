// dsh's context panel shows three heuristic rows a Claude conversation cannot
// feed (no `request/header`, and dsh's surface is not Claude's context), so the
// plugin writes Claude's own `/context` figures into dsh's own nodes. Both
// halves of that are pure enough to test: the report parser on the host, and
// the panel rewrite on the client.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/** Lift the pure report helpers out of the host engine body. */
function hostHelpers() {
  const src = fs.readFileSync(path.join(root, 'src/host.dynamic.js'), 'utf8')
  const start = src.indexOf('    /** "4.1k" / "167.4K"')
  const end = src.indexOf('    function contextWindowKeyOf')
  assert.ok(start > 0 && end > start, 'the report helpers moved')
  return new Function(src.slice(start, end) + '; return { tokensOf, parseContextReport }')()
}

// The real answer `/context` gives over stream-json (Claude Code 2.1.x).
const REPORT = `## Context Usage

**Model:** claude-opus-5
**Tokens:** 191.1k / 1m (19%)

### Estimated usage by category

| Category | Tokens | Percentage |
|----------|--------|------------|
| System prompt | 4.1k | 0.4% |
| System tools | 15.2k | 1.5% |
| MCP tools (deferred) | 9.3k | 0.9% |
| System tools (deferred) | 15.1k | 1.5% |
| Memory files | 4k | 0.4% |
| Skills | 1.9k | 0.2% |
| Messages | 167.4k | 16.7% |
| Free space | 807.5k | 80.8% |
`

test('/context 的分类表按 dsh 的三行折叠', () => {
  const { parseContextReport } = hostHelpers()
  const report = parseContextReport(REPORT)

  // 记忆文件与技能是系统提示词的一部分（Claude 就是这么拼请求的）。
  assert.equal(report.system, 4100 + 4000 + 1900)
  assert.equal(report.tools, 15200)
  assert.equal(report.messages, 167400)

  // 关键：deferred 的工具没有被加载，不占窗口。报告自己的算术能证明——
  // 三行之和应当等于「窗口 − 空闲」（每行只印一位小数，容差是逐行舍入；
  // 把两条 deferred 算进去会差 24,400，远在容差之外）。
  const resident = report.system + report.tools + report.messages
  assert.ok(Math.abs(resident - (1000000 - report.free)) <= 500,
    '三行之和 ' + resident + ' 与「窗口 − 空闲」' + (1000000 - report.free) + ' 对不上')
})

// The same answer with the sections that follow it — the report also lists
// every MCP tool, memory file and skill, in tables whose second column is a
// server / path / source rather than a figure.
const FULL_REPORT = REPORT + `
### MCP Tools

| Tool | Server | Tokens |
|------|--------|--------|
| mcp__obscura__browser_back | obscura | 70 |
| mcp__terminal-47__pty_edit | terminal-47 | 700 |

### Memory Files

| Type | Path | Tokens |
|------|------|--------|
| User | /root/.claude/CLAUDE.md | 366 |
| AutoMem | <auto-memory-index> | 858 |

### Skills

| Skill | Source | Tokens |
|-------|--------|--------|
| dataviz | Built-in | ~380 |
| run | Built-in | ~120 |
`

test('报告后面几张表不参与统计', () => {
  const { parseContextReport } = hostHelpers()
  const scoped = parseContextReport(FULL_REPORT)
  const bare = parseContextReport(REPORT)
  // 逐工具 / 逐记忆文件 / 逐技能的明细是同一批 token 的展开，不是额外占用。
  assert.deepEqual(
    { system: scoped.system, tools: scoped.tools, messages: scoped.messages },
    { system: bare.system, tools: bare.tools, messages: bare.messages },
  )
})

// 第二个真实样本（另一台机器、另一轮）：同一条算术规则必须照样成立。
test('另一份真实报告的算术同样闭合', () => {
  const { parseContextReport } = hostHelpers()
  const report = parseContextReport(`### Estimated usage by category

| Category | Tokens | Percentage |
|----------|--------|------------|
| System prompt | 3.8k | 0.4% |
| System tools | 15k | 1.5% |
| MCP tools (deferred) | 9.3k | 0.9% |
| System tools (deferred) | 15k | 1.5% |
| Memory files | 4.1k | 0.4% |
| Skills | 1.9k | 0.2% |
| Messages | 270.4k | 27.0% |
| Free space | 704.9k | 70.5% |
`)
  assert.equal(report.system, 3800 + 4100 + 1900)
  assert.equal(report.tools, 15000)
  assert.equal(report.messages, 270400)
  const resident = report.system + report.tools + report.messages
  assert.ok(Math.abs(resident - (1000000 - report.free)) <= 500,
    '三行之和 ' + resident + ' 与「窗口 − 空闲」' + (1000000 - report.free) + ' 对不上')
})

test('分类表缺失或不可解析时不冒充数据', () => {
  const { parseContextReport, tokensOf } = hostHelpers()
  assert.equal(parseContextReport(''), undefined)
  assert.equal(parseContextReport('Context low · /compact suggested'), undefined)
  // 表头与分隔行不是数据行。
  assert.equal(parseContextReport('| Category | Tokens |\n|---|---|\n'), undefined)
  assert.equal(tokensOf('4.1k'), 4100)
  assert.equal(tokensOf('1m'), 1000000)
  assert.equal(tokensOf('912'), 912)
  assert.equal(tokensOf('不是数字'), 0)
})

/** Lift the client's panel corrector, with the globals it reads stubbed. */
function clientPanel(answer, dom) {
  const src = fs.readFileSync(path.join(root, 'src/client.dynamic.js'), 'utf8')
  const start = src.indexOf('    const breakdowns = new Map()')
  const end = src.indexOf('    // ---------- Claude badge')
  assert.ok(start > 0 && end > start, 'the panel corrector moved')
  const body = src.slice(start, end)
  const make = new Function('document', 'host', 'currentClaudeSessionId', 'safelyClient',
    body + '; return { paintContextPanel, formatTokens }')
  return make(
    dom,
    { call: () => Promise.resolve(answer) },
    'session-1',
    (label, fn) => fn(),
  )
}

/**
 * The panel dsh renders: a header, a bar of segments, then a 3-row legend.
 * `segmentWidths` models what dsh actually emits — it DROPS a part it priced
 * at zero, so the screenshot this fixes arrives with one segment, not three.
 */
function fakePanel(options) {
  const settings = options || {}
  const node = (tag) => ({
    tagName: tag,
    className: '',
    style: { width: '' },
    children: [],
    textContent: '',
    attributes: {},
    get firstChild() { return this.children.length === 0 ? null : this.children[0] },
    getAttribute(key) { return this.attributes[key] === undefined ? null : this.attributes[key] },
    setAttribute(key, value) { this.attributes[key] = String(value) },
    appendChild(child) { this.children.push(child); return child },
    removeChild(child) {
      const at = this.children.indexOf(child)
      if (at !== -1) this.children.splice(at, 1)
      return child
    },
    cloneNode() {
      const copy = node(this.tagName)
      copy.className = this.className
      return copy
    },
  })

  const values = [node('dd'), node('dd'), node('dd')]
  // Each legend row's swatch wears the shared swatch class plus its own color.
  const swatchClasses = settings.swatchClasses
    || ['sw colorSystem', 'sw colorTools', 'sw colorMessages']
  const swatches = swatchClasses.map((names) => {
    const span = node('span')
    span.className = names
    return span
  })

  const widths = settings.segmentWidths || ['0%', '0%', '19%']
  const segments = widths.map((width, index) => {
    const segment = node('div')
    // dsh's segment carries its own class plus the part's color class; a bar
    // that dropped the zero parts keeps only the surviving one's colour.
    segment.className = 'seg ' + (widths.length === 3
      ? ['colorSystem', 'colorTools', 'colorMessages'][index]
      : 'colorMessages')
    segment.style.width = width
    return segment
  })

  const bar = node('div')
  for (const segment of segments) bar.appendChild(segment)

  const list = node('dl')
  list.previousElementSibling = bar
  list.querySelectorAll = (selector) => (selector === 'dt span' ? swatches : values)

  const dialog = node('div')
  dialog.querySelector = (selector) => (selector === 'dl' ? list : null)

  return {
    dialog,
    bar,
    values,
    document: {
      body: { getAttribute: () => 'claude' },
      querySelectorAll: (selector) => (selector === '[role="dialog"]' ? [dialog] : []),
    },
  }
}

test('把 Claude 的真实分类写进 dsh 自己的面板节点', async () => {
  const panel = fakePanel()
  const { paintContextPanel } = clientPanel({
    known: true, systemTokens: 10000, toolsTokens: 15200, messageTokens: 167400, at: 7,
  }, panel.document)

  paintContextPanel()          // 第一趟只发起取数
  await Promise.resolve()
  await Promise.resolve()
  paintContextPanel()          // 数据到位后重绘

  assert.deepEqual(panel.values.map((cell) => cell.textContent), ['~10K', '~15.2K', '~167K'])

  // 条形图的总长仍是环上那个精确百分比，只是三段的比例换成了真实的。
  const widths = panel.bar.children.map((segment) => parseFloat(segment.style.width))
  assert.ok(Math.abs(widths[0] + widths[1] + widths[2] - 19) < 1e-6, '总长必须仍等于 19%')
  assert.ok(widths[2] > widths[1] && widths[1] > widths[0], '对话消息应当是最长的一段')
})

test('dsh 丢掉零宽分段时，按图例的颜色把三段补回来', async () => {
  // 正是用户截图那一幕：系统提示词与工具都是 0，dsh 只渲染了一段（对话消息）。
  const panel = fakePanel({ segmentWidths: ['19%'] })
  const { paintContextPanel } = clientPanel({
    known: true, systemTokens: 10000, toolsTokens: 15200, messageTokens: 167400, at: 7,
  }, panel.document)

  paintContextPanel()
  await Promise.resolve()
  await Promise.resolve()
  paintContextPanel()

  assert.equal(panel.bar.children.length, 3, '三段都该在')
  const widths = panel.bar.children.map((segment) => parseFloat(segment.style.width))
  assert.ok(Math.abs(widths[0] + widths[1] + widths[2] - 19) < 1e-6, '总长仍是环上的 19%')
  // 颜色取自图例色块：每段带的是它那一行独有的那个类名，外加 dsh 自己的段类名。
  assert.deepEqual(panel.bar.children.map((segment) => segment.className), [
    'seg colorSystem', 'seg colorTools', 'seg colorMessages',
  ])
})

test('图例结构不认识时，宁可不动条形图', async () => {
  const panel = fakePanel({ segmentWidths: ['19%'], swatchClasses: ['sw', 'sw'] })
  const { paintContextPanel } = clientPanel({
    known: true, systemTokens: 10000, toolsTokens: 15200, messageTokens: 167400, at: 7,
  }, panel.document)
  paintContextPanel()
  await Promise.resolve()
  await Promise.resolve()
  paintContextPanel()
  assert.equal(panel.bar.children.length, 1)
  assert.equal(panel.bar.children[0].style.width, '19%')
})

test('宿主答不上来时，dsh 的面板保持原样', async () => {
  const panel = fakePanel()
  const { paintContextPanel } = clientPanel({ known: false }, panel.document)
  paintContextPanel()
  await Promise.resolve()
  await Promise.resolve()
  paintContextPanel()
  assert.deepEqual(panel.values.map((cell) => cell.textContent), ['', '', ''])
  assert.equal(panel.bar.children[2].style.width, '19%')
})

test('dsh 换了面板结构就整个不碰', async () => {
  const panel = fakePanel()
  panel.dialog.querySelector = () => null   // 没有 dl：不是我们认识的面板
  const { paintContextPanel } = clientPanel({
    known: true, systemTokens: 10000, toolsTokens: 15200, messageTokens: 167400, at: 7,
  }, panel.document)
  paintContextPanel()
  await Promise.resolve()
  paintContextPanel()
  assert.deepEqual(panel.values.map((cell) => cell.textContent), ['', '', ''])
})

test('数字格式与 dsh 的 formatTokens 一致', () => {
  const { formatTokens } = clientPanel({ known: false }, fakePanel().document)
  assert.equal(formatTokens(912), '912')
  assert.equal(formatTokens(10000), '10K')
  assert.equal(formatTokens(15200), '15.2K')
  assert.equal(formatTokens(167400), '167K')
  assert.equal(formatTokens(1000000), '1M')
})
