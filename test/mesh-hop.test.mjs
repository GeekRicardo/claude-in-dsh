// Claude 的 `dsh-agents` 工具是 dsh 自己提供的 HTTP MCP 服务。把 Claude 直接指
// 向 dsh，那么每一次 dsh 重启——pm2 的十来秒——都会变成某个工具调用里的连接错误；
// CLI 把它报成「服务器没了」，模型从此不再用 mesh，一个正在带着十四个子对话的
// 主对话就退回到自己动手，还会说「MCP 连接又断了」。
//
// broker 天生比 dsh 活得久（它存在的全部理由就是这个），所以 Claude 那头的连接
// 应该终结在 broker 上。这里跑的是真的 broker、真的上游、真的 HTTP。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const BROKER = path.join(root, 'lib/broker.mjs')

function tempDir() {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'ccmode-hop-'))
  execFileSync('mkfifo', [path.join(dir, 'in')])
  fs.writeFileSync(path.join(dir, 'out.log'), '')
  fs.writeFileSync(path.join(dir, 'meta.json'), '{}')
  return dir
}

/** An upstream that records what reached it. */
function upstream(reply) {
  const seen = []
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body: Buffer.concat(chunks).toString('utf8') })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(reply))
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      seen: seen,
      close: () => new Promise((done) => server.close(done)),
    }))
  })
}

// Stands in for the Claude CLI: prints the argv it was started with (which goes
// straight into out.log through the broker's pipe) and then stays up.
// `node -e <code> -- <args>`：这种形态下 process.argv 是 [node, ...args]。
const FAKE_CLAUDE = 'process.stdout.write(JSON.stringify({argv:process.argv.slice(1)})+"\\n");setInterval(()=>{},1000)'

function startBroker(dir, mcpConfig, env) {
  const child = spawn(process.execPath, [
    BROKER, dir,
    process.execPath, '-e', FAKE_CLAUDE, '--', '--mcp-config', mcpConfig,
  ], { stdio: 'ignore', env: { ...process.env, ...(env || {}) } })
  return child
}

async function waitForArgv(dir, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const text = fs.readFileSync(path.join(dir, 'out.log'), 'utf8')
    for (const line of text.split('\n')) {
      if (line.indexOf('"argv"') === -1) continue
      try {
        const value = JSON.parse(line)
        if (Array.isArray(value.argv)) return value.argv
      } catch (error) { /* a partial line */ }
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('broker 没有把 claude 起起来（out.log 里没有 argv）\n'
    + fs.readFileSync(path.join(dir, 'out.log'), 'utf8').slice(0, 1000))
}

function post(port, urlPath, body) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1', port: port, path: urlPath, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString('utf8') }))
    })
    request.on('error', reject)
    request.end(body)
  })
}

/** The hop's address, out of the --mcp-config the broker actually handed Claude. */
function hopPortOf(argv) {
  const at = argv.indexOf('--mcp-config')
  assert.notEqual(at, -1, 'broker 没把 --mcp-config 传下去')
  const config = JSON.parse(argv[at + 1])
  const url = config.mcpServers['dsh-agents'].url
  assert.equal(url.indexOf('__CCMODE_MESH__'), -1, '占位符没有被替换，Claude 会连到一个不存在的主机')
  const match = url.match(/^http:\/\/127\.0\.0\.1:(\d+)(\/.*)$/)
  assert.ok(match !== null, '替换后的地址不是本机的 hop：' + url)
  return { port: Number(match[1]), path: match[2], config: config }
}

test('broker 把 Claude 指向自己的 hop，并带着 token 转发到 dsh', async () => {
  const dir = tempDir()
  const dsh = await upstream({ jsonrpc: '2.0', id: 1, result: { tools: [] } })
  fs.writeFileSync(path.join(dir, 'mesh.json'),
    JSON.stringify({ origin: '127.0.0.1:' + dsh.port, token: 'tok-123' }))

  const config = JSON.stringify({
    mcpServers: { 'dsh-agents': { type: 'http', url: 'http://__CCMODE_MESH__/dsh-agent-mesh/mcp/session-x' } },
  })
  const broker = startBroker(dir, config)
  try {
    const hop = hopPortOf(await waitForArgv(dir))
    assert.equal(hop.path, '/dsh-agent-mesh/mcp/session-x', '路径必须原样带过去')
    // 令牌不在 Claude 的 argv 里了——ps 看不到它。
    assert.equal(JSON.stringify(hop.config).indexOf('tok-123'), -1, 'token 不该出现在 Claude 的命令行里')

    const answer = await post(hop.port, hop.path, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))
    assert.equal(answer.status, 200)
    assert.deepEqual(JSON.parse(answer.text).result, { tools: [] })
    assert.equal(dsh.seen.length, 1)
    assert.equal(dsh.seen[0].url, '/dsh-agent-mesh/mcp/session-x')
    assert.equal(dsh.seen[0].auth, 'Bearer tok-123', 'hop 必须自己补上 Authorization')
  } finally {
    broker.kill('SIGKILL')
    await dsh.close()
  }
})

test('dsh 关着的时候：hop 先重试，再答一个工具错误——而不是让连接失败', async () => {
  const dir = tempDir()
  const dsh = await upstream({ jsonrpc: '2.0', id: 7, result: {} })
  const port = dsh.port
  fs.writeFileSync(path.join(dir, 'mesh.json'), JSON.stringify({ origin: '127.0.0.1:' + port, token: 't' }))
  const config = JSON.stringify({
    mcpServers: { 'dsh-agents': { type: 'http', url: 'http://__CCMODE_MESH__/mcp/p' } },
  })
  const broker = startBroker(dir, config, { CCMODE_MESH_RETRY_MS: '1200', CCMODE_MESH_RETRY_STEP_MS: '100' })
  try {
    const hop = hopPortOf(await waitForArgv(dir))
    await dsh.close()   // dsh 重启中

    const started = Date.now()
    const answer = await post(hop.port, hop.path, JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call' }))
    const elapsed = Date.now() - started
    assert.ok(elapsed >= 1000, '应该先重试一阵子，而不是立刻放弃（用了 ' + elapsed + 'ms）')
    // 关键：HTTP 200 + 一个 JSON-RPC 结果。CLI 因此保留这台服务器，模型只看到
    // 「这次调用失败了」——而不是「这个服务器没了」。
    assert.equal(answer.status, 200, '连接层面绝不能失败，那正是模型判定服务器没了的依据')
    const body = JSON.parse(answer.text)
    assert.equal(body.id, 7, 'JSON-RPC 的 id 要对上，否则 CLI 认不出这是哪个请求的答复')
    assert.equal(body.result.isError, true)
    assert.match(body.result.content[0].text, /重试/)
  } finally {
    broker.kill('SIGKILL')
  }
})

test('dsh 回来之后，同一个 hop 继续用——不用重启对话', async () => {
  const dir = tempDir()
  const first = await upstream({ jsonrpc: '2.0', id: 1, result: { round: 'before' } })
  const port = first.port
  fs.writeFileSync(path.join(dir, 'mesh.json'), JSON.stringify({ origin: '127.0.0.1:' + port, token: 't' }))
  const config = JSON.stringify({
    mcpServers: { 'dsh-agents': { type: 'http', url: 'http://__CCMODE_MESH__/mcp/p' } },
  })
  const broker = startBroker(dir, config, { CCMODE_MESH_RETRY_MS: '4000', CCMODE_MESH_RETRY_STEP_MS: '100' })
  let second
  try {
    const hop = hopPortOf(await waitForArgv(dir))
    await post(hop.port, hop.path, '{"jsonrpc":"2.0","id":1,"method":"ping"}')
    await first.close()

    // 「重启」：同一个端口上换一个新的 dsh 起来。
    const call = post(hop.port, hop.path, '{"jsonrpc":"2.0","id":1,"method":"ping"}')
    await new Promise((resolve) => setTimeout(resolve, 300))
    second = await new Promise((resolve) => {
      const server = http.createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { round: 'after' } }))
      })
      server.listen(port, '127.0.0.1', () => resolve({ close: () => new Promise((done) => server.close(done)) }))
    })

    const answer = await call
    assert.equal(answer.status, 200)
    assert.deepEqual(JSON.parse(answer.text).result, { round: 'after' },
      '重启期间发出的那次调用，应该由重启后的 dsh 答复——调用方什么都不用做')
  } finally {
    broker.kill('SIGKILL')
    if (second !== undefined) await second.close()
  }
})

test('没有 mesh.json 就没有 hop：占位符不该留在 Claude 的命令行里', () => {
  // 配置里没有占位符时，host 侧走的是老形态（url 直连 + Authorization 头）。
  const source = fs.readFileSync(path.join(root, 'src/host.dynamic.js'), 'utf8')
  assert.match(source, /function directMeshConfig\(/, '留一条不带 hop 的老路，占位符替换不了时才有退路')
  assert.match(source, /agentsMcp\.indexOf\(MESH_PLACEHOLDER\) !== -1/,
    '只有配置里真的有占位符时才写 mesh.json，否则会留下过期的种子')
  const broker = fs.readFileSync(path.join(root, 'src/broker.mjs'), 'utf8')
  assert.match(broker, /agent-mesh hop could not bind — talking to dsh directly/,
    'hop 绑不上端口时要退回直连，而不是让这次启动失败')
})
