import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { startContainerAgentCore } from "../../test/agentcore-fake.js"
import { agentCoreSandboxProvider } from "./agentcore-sandbox-provider.js"
import { workspaceChatDockerImage } from "./chat-runtime.js"

/*
 * The AgentCore provider against the chat sandbox image in Docker, with the
 * shim as its entry point: Linux, the image user and the image's `sh` (dash),
 * as on a real AgentCore runtime. A test against a real runtime found two
 * faults that a macOS shell hides: dash's `kill` refuses `--`, and dash turns
 * job control off.
 */
let fake: Awaited<ReturnType<typeof startContainerAgentCore>>
let provider: ReturnType<typeof agentCoreSandboxProvider>

beforeAll(async () => {
  fake = await startContainerAgentCore(workspaceChatDockerImage())
  provider = agentCoreSandboxProvider({ runtime: fake.runtime })
}, 120_000)
afterAll(() => fake?.close())

describe("the AgentCore provider in the chat sandbox image", () => {
  it("runs commands as the image user in /workspace, with the create environment", async () => {
    const handle = await provider.create({ env: { PROXY_SESSION: "it's set" } })
    const result = await handle.process.exec(
      'id -un; pwd; echo "$PROXY_SESSION"; readlink /proc/$$/exe',
    )
    expect(result).toEqual({
      stdout: "node\n/workspace\nit's set\n/usr/bin/dash\n",
      stderr: "",
      exitCode: 0,
    })
    await provider.destroy({ id: handle.id })
  })

  it("kills the process group of a background process", async () => {
    const handle = await provider.create({})
    const server = await handle.process.spawn(
      "echo started; sh -c 'sleep 300' & sleep 300",
    )
    expect((await server.stdout[Symbol.asyncIterator]().next()).value).toBe(
      "started\n",
    )
    const started = Date.now()
    await server.kill("SIGKILL")
    expect(await server.wait()).toBe(137)
    expect(Date.now() - started).toBeLessThan(30_000)
    // A process of the group that is not a zombie. In /proc/<pid>/stat,
    // after the last ") ", the first field is the state and the third the
    // group id.
    const left = await handle.process.exec(
      `for s in /proc/[0-9]*/stat; do r=$(sed 's/.*) //' "$s" 2>/dev/null) || continue; set -- $r; [ "$3" = ${server.pid} ] && [ "$1" != Z ] && echo alive; done; echo checked`,
    )
    expect(left.stdout).toBe("checked\n")
    await provider.destroy({ id: handle.id })
  })

  it("reads back a large file and reaches a port in the sandbox through the shim", async () => {
    const handle = await provider.create({})
    const large = `${"x".repeat(300_000)}\n`
    await handle.fs.write("/workspace/large.txt", large)
    expect(await handle.fs.read("/workspace/large.txt")).toBe(large)
    const server = await handle.process.spawn(
      `node -e "require('http').createServer((q, s) => s.end('pong ' + q.url)).listen(4096, '127.0.0.1', () => console.log('listening'))"`,
    )
    await server.stdout[Symbol.asyncIterator]().next()
    const channel = await handle.ports.connect(4096)
    const answer = await fetch(`${channel.url}/ping?x=1`)
    expect(await answer.text()).toBe("pong /ping?x=1")
    await server.kill("SIGKILL")
    await provider.destroy({ id: handle.id })
  })
})
