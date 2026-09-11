import { execFileSync } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import Docker from "dockerode"
import { expect, it } from "vitest"
import { withNativeHttpsGitFixture } from "../../test/native-https-git-fixture.js"
import { WORKSPACE_CHAT_DOCKER_SANDBOX } from "./chat-runtime.js"

it(
  "serves authenticated github.com HTTPS and records read observations",
  { timeout: 180_000 },
  async () => {
    const quotaHost = process.env.CTXPIPE_TEST_QUOTA_DOCKER_HOST?.trim()
    const quotaPort = Number(process.env.CTXPIPE_TEST_QUOTA_DOCKER_PORT)
    if (!quotaHost || !Number.isInteger(quotaPort) || quotaPort < 1)
      throw new Error(
        "CTXPIPE_TEST_QUOTA_DOCKER_HOST and CTXPIPE_TEST_QUOTA_DOCKER_PORT are required",
      )
    const previous = Object.fromEntries(
      ["DOCKER_HOST", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"].map((key) => [
        key,
        process.env[key],
      ]),
    )
    process.env.DOCKER_HOST = `tcp://${quotaHost}:${quotaPort}`
    delete process.env.DOCKER_TLS_VERIFY
    delete process.env.DOCKER_CERT_PATH
    const docker = new Docker({ timeout: 120_000 })
    const directory = await mkdtemp(join(tmpdir(), "ctxpipe-https-git-auth-"))
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim()
    git("init", "-b", "main")
    await writeFile(join(directory, "README.md"), "# Native chat workspace\n")
    git("add", ".")
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "-m",
      "Initial",
    )
    const sha = git("rev-parse", "HEAD")
    try {
      await docker.getImage(WORKSPACE_CHAT_DOCKER_SANDBOX.image).inspect()
      await withNativeHttpsGitFixture(
        {
          baseImage:
            process.env.CTXPIPE_TEST_CHAT_SANDBOX_IMAGE?.trim() ||
            "ctxpipe-chat-sandbox:opencode-1.18.18",
          docker,
        },
        async (fixture) => {
          await fixture.serve(
            directory,
            async (remote) => {
              expect(remote.url).toBe(
                "https://github.com/fixture/workspace.git",
              )
              const bridge = await docker.getNetwork("bridge").inspect()
              const gateway = bridge.IPAM?.Config?.[0]?.Gateway
              if (!gateway)
                throw new Error("Nested Docker bridge gateway missing")
              const denied = await runGitRemote(docker, {
                image: fixture.image,
                extraHosts: [`github.com:${gateway}`],
              })
              expect(denied.code).not.toBe(0)
              const allowed = await runGitRemote(docker, {
                image: fixture.image,
                extraHosts: [`github.com:${gateway}`],
                token: "fixture-read-1",
              })
              expect(allowed.code).toBe(0)
              expect(allowed.stdout).toContain(sha)
              expect(allowed.stdout).toContain("refs/heads/main")
              const observed = await remote.observedRequests()
              expect(observed.some((entry) => entry.auth === "read")).toBe(true)
              expect(
                observed.some(
                  (entry) => entry.auth === "none" || entry.auth === "invalid",
                ),
              ).toBe(true)
              expect(
                observed.every((entry) =>
                  entry.path.startsWith("/fixture/workspace.git"),
                ),
              ).toBe(true)
            },
            {
              githubAuth: {
                bootstrapToken: "fixture-bootstrap",
                readToken: "fixture-read-1",
              },
            },
          )
        },
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  },
)

async function runGitRemote(
  docker: Docker,
  input: { image: string; extraHosts: string[]; token?: string },
) {
  const header = input.token
    ? `Authorization: Basic ${Buffer.from(`x-access-token:${input.token}`).toString("base64")}`
    : ""
  const container = await docker.createContainer({
    Image: input.image,
    User: "1000:1000",
    Env: ["GIT_TERMINAL_PROMPT=0"],
    Cmd: [
      "git",
      ...(header ? ["-c", `http.extraHeader=${header}`] : []),
      "ls-remote",
      "https://github.com/fixture/workspace.git",
      "refs/heads/main",
    ],
    HostConfig: { ExtraHosts: input.extraHosts },
    Labels: { "ai.ctxpipe.purpose": "native-https-git-auth-client" },
  })
  try {
    await container.start()
    const result = await container.wait()
    const logs = (
      await container.logs({ stdout: true, stderr: true })
    ).toString()
    return { code: Number(result.StatusCode), stdout: logs, stderr: logs }
  } finally {
    await container.remove({ force: true, v: true })
  }
}
