import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type SandboxOpencodeServer,
  startOpencodeServerInSandbox,
} from "@tanstack/ai-opencode"
import { localProcessSandbox } from "@tanstack/ai-sandbox-local-process"
import { expect, it } from "vitest"

it(
  "connects to the port OpenCode reports when local-process requests port 0",
  { timeout: 60_000 },
  async () => {
    const directories = await Promise.all([
      mkdtemp(join(tmpdir(), "ctxpipe-opencode-a-")),
      mkdtemp(join(tmpdir(), "ctxpipe-opencode-b-")),
    ])
    const entries = await Promise.all(
      directories.map(async (directory) => ({
        directory,
        sandbox: await localProcessSandbox({
          dir: directory,
          removeOnDestroy: true,
        }).create({
          id: directory,
          workspace: { source: { type: "none" } },
        }),
      })),
    )
    const sandboxes = entries.map(({ sandbox }) => sandbox)
    let servers: Array<SandboxOpencodeServer> = []
    const failures: unknown[] = []
    try {
      await Promise.all(
        entries.map(({ directory, sandbox }) =>
          sandbox.env.set({
            XDG_DATA_HOME: join(directory, "data"),
            OPENCODE_CONFIG_CONTENT: JSON.stringify({
              $schema: "https://opencode.ai/config.json",
              enabled_providers: ["synthetic"],
              provider: {
                synthetic: {
                  npm: "@ai-sdk/openai-compatible",
                  name: "synthetic",
                  options: {
                    baseURL: "http://127.0.0.1:9",
                    apiKey: "synthetic-test-key",
                  },
                  models: { probe: { name: "probe" } },
                },
              },
            }),
          }),
        ),
      )
      const started = await Promise.allSettled(
        entries.map(({ sandbox }) =>
          startOpencodeServerInSandbox(sandbox, {
            port: 0,
            hostname: "127.0.0.1",
            cwd: ".",
          }),
        ),
      )
      servers = started.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      )
      for (const result of started)
        if (result.status === "rejected") throw result.reason
      const urls = servers.map((server) => new URL(server.baseUrl))
      for (const url of urls) expect(url.port).toMatch(/^[1-9]\d*$/)
      expect(urls[0]?.port).not.toBe(urls[1]?.port)
      const health = await Promise.all(
        urls.map(async (url) => {
          const response = await fetch(`${url.origin}/global/health`)
          expect(response.status).toBe(200)
          return response.json()
        }),
      )
      expect(health).toEqual([
        { healthy: true, version: "1.18.18" },
        { healthy: true, version: "1.18.18" },
      ])
      await Promise.all(servers.map((server) => server.dispose()))
      for (const url of urls)
        await expect(fetch(`${url.origin}/global/health`)).rejects.toThrow()
      servers = []
    } catch (error) {
      failures.push(error)
    }
    const cleanup = [
      ...(await Promise.allSettled(servers.map((server) => server.dispose()))),
      ...(await Promise.allSettled(
        sandboxes.map((sandbox) => sandbox.destroy()),
      )),
      ...(await Promise.allSettled(
        directories.map((directory) =>
          rm(directory, { recursive: true, force: true }),
        ),
      )),
    ]
    for (const result of cleanup)
      if (result.status === "rejected") failures.push(result.reason)
    if (failures.length)
      throw new AggregateError(failures, "Native OpenCode port proof failed")
  },
)
