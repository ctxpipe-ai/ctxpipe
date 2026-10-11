import Docker from "dockerode"
import { expect, it } from "vitest"
import { attachProviderSandbox } from "./sandbox-provider.js"

const IMAGE = "alpine:3.22"
const docker = new Docker({ timeout: 30_000 })

async function pullImage(): Promise<void> {
  const exists = await docker
    .getImage(IMAGE)
    .inspect()
    .then(
      () => true,
      () => false,
    )
  if (exists) return
  const stream = await docker.pull(IMAGE)
  await new Promise<void>((resolve, reject) =>
    docker.modem.followProgress(stream, (error) =>
      error ? reject(error) : resolve(),
    ),
  )
}

it(
  "a read-only attach uses a running Docker sandbox and never starts a stopped one",
  { timeout: 120_000 },
  async () => {
    await pullImage()
    const container = await docker.createContainer({
      Image: IMAGE,
      Cmd: ["sleep", "600"],
      WorkingDir: "/workspace",
    })
    try {
      await container.start()
      const attach = (onlyRunning: boolean) =>
        attachProviderSandbox({
          orgId: "org_attach_contract",
          provider: "docker",
          providerSandboxId: container.id,
          onlyRunning,
        })
      const running = await attach(true)
      expect(running).not.toBeNull()
      expect((await running?.process.exec("echo ok"))?.stdout.trim()).toBe("ok")
      await container.stop({ t: 0 })
      expect(await attach(true)).toBeNull()
      expect((await container.inspect()).State.Running).toBe(false)
      // The sweep's push before a deletion still starts it.
      expect(await attach(false)).not.toBeNull()
      expect((await container.inspect()).State.Running).toBe(true)
    } finally {
      await container.remove({ force: true, v: true })
    }
  },
)
