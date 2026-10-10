import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { expect, it } from "vitest"
import { withAgentVault } from "../../test/agent-vault-fixture.js"
import { openRunVault, writeProxyCaCommand } from "./agent-vault.js"
import { workspaceChatDockerImage } from "./chat-runtime.js"

const exec = promisify(execFile)
const docker = async (...args: string[]) =>
  (await exec("docker", args, { timeout: 240_000 })).stdout.trim()

const dindDir = fileURLToPath(
  new URL("../../../../../scripts/sandbox-dind/", import.meta.url),
)

/** Compose's `dind` service: the stock image with our entrypoint and daemon.json. */
it(
  "lets a DinD sandbox reach only Agent Vault's proxy",
  { timeout: 300_000 },
  async () => {
    await withAgentVault(
      { image: workspaceChatDockerImage() },
      async (fixture) => {
        const name = `ctxpipe-dind-egress-${randomUUID().slice(0, 8)}`
        const proxy = `${fixture.access.proxyHost}:14322`
        await docker(
          "run",
          "-d",
          "--privileged",
          "--name",
          name,
          "--network",
          fixture.network,
          "-e",
          "DOCKER_TLS_CERTDIR=",
          "-e",
          `CTXPIPE_SANDBOX_PROXY=${proxy}`,
          "-v",
          `${dindDir}entrypoint.sh:/sandbox-dind/entrypoint.sh:ro`,
          "-v",
          `${dindDir}daemon.json:/etc/docker/daemon.json:ro`,
          "--entrypoint",
          "dind",
          "docker:29.8.2-dind",
          "sh",
          "/sandbox-dind/entrypoint.sh",
        )
        try {
          const deadline = Date.now() + 90_000
          for (;;) {
            const ready = await docker("exec", name, "docker", "info")
              .then(() => true)
              .catch(() => false)
            if (ready) break
            if (Date.now() > deadline) {
              const logs = await exec("docker", ["logs", name]).catch(
                (error) => error,
              )
              throw new Error(`DinD did not start: ${logs.stderr}`)
            }
            await new Promise((resolve) => setTimeout(resolve, 1_000))
          }
          // DinD itself pulls images; only its sandbox bridges are limited.
          await docker(
            "exec",
            name,
            "docker",
            "pull",
            "-q",
            "curlimages/curl:8.17.0",
          )
          // Compose builds the chat image inside DinD. A build step on a
          // sandbox bridge is blocked; on the DinD host network it downloads.
          const build = (network: string) =>
            exec("docker", [
              "exec",
              name,
              "sh",
              "-c",
              `printf 'FROM curlimages/curl:8.17.0\\nRUN curl -sSf -m 10 -o /dev/null https://example.com\\n' | docker build --no-cache -q --network ${network} -`,
            ]).then(
              () => "built",
              () => "failed",
            )
          expect(await build("default")).toBe("failed")
          expect(await build("host")).toBe("built")
          const vault = await openRunVault({
            access: fixture.access,
            runKey: `egress:${randomUUID()}`,
            ttlSeconds: 600,
            rules: [],
          })
          try {
            const run = (script: string) =>
              exec(
                "docker",
                [
                  "exec",
                  name,
                  "docker",
                  "run",
                  "--rm",
                  ...Object.entries(vault.env).flatMap(([key, value]) => [
                    "-e",
                    `${key}=${value}`,
                  ]),
                  "curlimages/curl:8.17.0",
                  "sh",
                  "-c",
                  script,
                ],
                { timeout: 120_000 },
              ).then(
                (result) => ({ code: 0, out: result.stdout.trim() }),
                (error: { code?: number; stdout?: string }) => ({
                  code: error.code ?? 1,
                  out: error.stdout?.trim() ?? "",
                }),
              )
            const upstream = await docker(
              "inspect",
              "--format",
              `{{(index .NetworkSettings.Networks "${fixture.network}").IPAddress}}`,
              `ctxpipe-av-upstream-${fixture.network.split("-").pop()}`,
            )
            // Through the proxy: the upstream stands in for the internet and
            // the backend.
            expect(
              await run(
                `${writeProxyCaCommand(vault.caPem)} && curl -sSf -o /dev/null http://${fixture.upstream}:8080/echo/x && echo ok`,
              ),
            ).toEqual({ code: 0, out: "ok" })
            // A connection that ignores the proxy is refused.
            const direct = await run(
              `unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY; curl -sS -m 5 -o /dev/null http://${upstream}:8080/echo/x && echo reached`,
            )
            expect(direct.out).not.toBe("reached")
            // The proxy never reaches Agent Vault's own management API.
            const manage = await run(
              `${writeProxyCaCommand(vault.caPem)} && curl -sS -o /dev/null -w "%{http_code}" http://${fixture.agentVaultName}:14321/health`,
            )
            expect(manage.out).not.toBe("200")
            // Sandboxes resolve no names. The one public host in this test:
            // Docker gives sandboxes a public resolver, so that is the path
            // that must be closed.
            const dns = await run(
              "unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY; nslookup -timeout=3 example.com 8.8.8.8 >/dev/null 2>&1 && echo resolved",
            )
            expect(dns.out).not.toBe("resolved")
          } finally {
            await vault.close()
          }
        } finally {
          await docker("rm", "-f", "-v", name).catch(() => "")
        }
      },
    )
  },
)
