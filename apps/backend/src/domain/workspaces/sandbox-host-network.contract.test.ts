import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { promisify } from "node:util"

import { describe, expect, it } from "vitest"

import {
  AGENT_VAULT_API_PORT,
  AGENT_VAULT_NETWORK,
  AGENT_VAULT_NETWORK_CREATE,
  AGENT_VAULT_PROXY_PORT,
  SANDBOX_HOST_FIREWALL,
  SANDBOX_HOST_NETWORK_DAEMON_CONFIG,
} from "../../../../../packages/aws-cdk/src/internal/sandbox-host-network.js"
import { testLabelArgs } from "../../../../../scripts/ci/test-containers.mjs"
import { contractImage } from "../../test/contract-images.js"

const exec = promisify(execFile)
const docker = async (...args: string[]) =>
  (await exec("docker", args, { timeout: 240_000 })).stdout.trim()

/**
 * The network of the AWS sandbox host (`@ctxpipe/aws-cdk`): its daemon
 * settings and firewall, in Docker-in-Docker, with the real Agent Vault image.
 * Amazon Linux 2023 ships Docker 25. Docker 28 changed the bridge rules.
 */
describe.each([
  [
    "25",
    "docker:25.0.5-dind@sha256:b41d0183012e2334aacd4e0b8e339b89246c4fdb7eada6cc86b0355f41328549",
  ],
  [
    "28",
    "docker:28.5.2-dind@sha256:2a232a42256f70d78e3cc5d2b5d6b3276710a0de0596c145f627ecfae90282ac",
  ],
])("the sandbox host on Docker %s", (_version, dindImage) => {
  it(
    "keeps a sandbox that fails Agent Vault's proxy auth from locking out another sandbox",
    { timeout: 400_000 },
    async () => {
      const name = `ctxpipe-sandbox-host-${randomUUID().slice(0, 8)}`
      // The rest of the host's daemon.json (TLS, the systemd slice, logs) does
      // not change the network. live-restore keeps containers up when dockerd
      // restarts, as on the host.
      const daemonJson = JSON.stringify({
        ...SANDBOX_HOST_NETWORK_DAEMON_CONFIG,
        "live-restore": true,
      })
      await docker(
        "run",
        "-d",
        ...testLabelArgs(),
        "--privileged",
        "--name",
        name,
        "-e",
        "DOCKER_TLS_CERTDIR=",
        "-e",
        `DAEMON_JSON=${daemonJson}`,
        "-e",
        `FIREWALL=${SANDBOX_HOST_FIREWALL.join("\n")}`,
        "--entrypoint",
        "sh",
        dindImage,
        "-c",
        // systemd restarts dockerd on the host; this loop does it here.
        'printf "%s" "$DAEMON_JSON" > /daemon.json && printf "%s\\n" "$FIREWALL" > /firewall.sh && while :; do dockerd-entrypoint.sh dockerd --config-file /daemon.json >>/var/log/dockerd.log 2>&1; sleep 1; done',
      )
      const inHost = (script: string) =>
        exec("docker", ["exec", name, "sh", "-c", script], {
          timeout: 240_000,
        }).then((result) => result.stdout.trim())
      /** The host's `ExecStartPost`: wait for dockerd, then the firewall. */
      const startDocker = async () => {
        const deadline = Date.now() + 90_000
        while (
          !(await inHost("docker info >/dev/null 2>&1 && echo up").catch(
            () => "",
          ))
        ) {
          if (Date.now() > deadline)
            throw new Error(
              `dockerd did not start: ${await inHost("tail -20 /var/log/dockerd.log").catch(() => "")}`,
            )
          await new Promise((resolve) => setTimeout(resolve, 1_000))
        }
        await inHost("set -e; sh -e /firewall.sh")
      }
      try {
        await startDocker()
        // DinD has its own image store. Load the pinned images from the
        // runner's daemon under local tags: a digest reference does not
        // survive save and load.
        const images = {
          vault: [
            contractImage("agentVault"),
            "ctxpipe-test-agent-vault:local",
          ],
          curl: [contractImage("curl"), "ctxpipe-test-curl:local"],
        } as const
        for (const [image, local] of Object.values(images)) {
          await exec("docker", ["image", "inspect", image]).catch(() =>
            exec("docker", ["pull", "-q", image], { timeout: 240_000 }),
          )
          await docker("tag", image, local)
          await exec(
            "sh",
            ["-c", `docker save ${local} | docker exec -i ${name} docker load`],
            { timeout: 240_000 },
          )
        }
        const curl = images.curl[1]
        await inHost(AGENT_VAULT_NETWORK_CREATE)
        await inHost(
          `docker run -d --name ctxpipe-agent-vault --restart unless-stopped --network ${AGENT_VAULT_NETWORK} -p ${AGENT_VAULT_API_PORT}:${AGENT_VAULT_API_PORT} -p ${AGENT_VAULT_PROXY_PORT}:${AGENT_VAULT_PROXY_PORT} -e AGENT_VAULT_MASTER_PASSWORD=${randomUUID()} -e AGENT_VAULT_TELEMETRY=false ${images.vault[1]}`,
        )
        // The host's own health check on the loopback address still works
        // without docker-proxy.
        await inHost(
          `for i in $(seq 1 60); do wget -q -O /dev/null -T 3 http://127.0.0.1:${AGENT_VAULT_API_PORT}/health && exit 0; sleep 1; done; exit 1`,
        )
        // Sandboxes dial the proxy on the host's address (the backend gives
        // them the address of the Docker host).
        const hostIp = await inHost(
          "ip -4 -o addr show eth0 | awk '{print $4}' | cut -d/ -f1",
        )
        const sandbox = (sandboxName: string) =>
          inHost(
            `docker run -d --name ${sandboxName} --entrypoint sh ${curl} -c 'sleep 3600'`,
          )
        /** The CONNECT status: 407 asks for proxy auth, 429 is the gate. */
        const connect = (sandboxName: string) =>
          inHost(
            `docker exec ${sandboxName} curl -s -o /dev/null --max-time 5 -p -x http://${hostIp}:${AGENT_VAULT_PROXY_PORT} -w '%{http_connect}' https://example.com || true`,
          )
        const get = (from: string, url: string) =>
          inHost(
            `docker exec ${from} curl -s -o /dev/null --max-time 5 -w '%{http_code}' ${url} || true`,
          )
        /** From Agent Vault's bridge: what the proxy could dial for a sandbox. */
        const getFromVaultNetwork = (url: string) =>
          inHost(
            `docker run --rm --network ${AGENT_VAULT_NETWORK} ${curl} -s -o /dev/null --max-time 5 -w '%{http_code}' ${url} || true`,
          )
        await sandbox("hostile")
        await sandbox("neighbor")
        // A sandbox with a published agent port, for the backend.
        await inHost(
          `docker run -d --name agent -p 18080:8080 --entrypoint sh ${curl} -c 'while :; do printf "HTTP/1.1 200 OK\\r\\nContent-Length: 2\\r\\n\\r\\nok" | nc -l -p 8080; done'`,
        )
        const dindIp = await docker(
          "inspect",
          "--format",
          "{{.NetworkSettings.IPAddress}}",
          name,
        )
        /** The backend, from outside the host, to a published agent port. */
        const backendToAgent = () =>
          exec(
            "docker",
            [
              "run",
              "--rm",
              ...testLabelArgs(),
              images.curl[0],
              "-s",
              "-o",
              "/dev/null",
              "--max-time",
              "5",
              "-w",
              "%{http_code}",
              `http://${dindIp}:18080/`,
            ],
            { timeout: 120_000 },
          ).then(
            (result) => result.stdout.trim(),
            () => "error",
          )

        // Agent Vault runs with its stock limits here, not the deployed ones
        // (agent-vault-limits.ts turns the gate off): the gate allows 50 auth
        // failures for each peer address in 5 minutes, so it shows which
        // address Agent Vault sees for each sandbox.
        const hostile = await inHost(
          `docker exec hostile sh -c 'for i in $(seq 1 55); do curl -s -o /dev/null --max-time 5 -p -x http://${hostIp}:${AGENT_VAULT_PROXY_PORT} -w "%{http_connect}\\n" https://example.com || true; done'`,
        )
        const codes = hostile.split("\n")
        expect(codes.slice(0, 50).every((code) => code === "407")).toBe(true)
        expect(codes.slice(50)).toEqual(["429", "429", "429", "429", "429"])
        // The gate keys each sandbox apart: the neighbor is not locked out.
        expect(await connect("neighbor")).toBe("407")

        // Sandboxes still reach nothing else on the host or through it.
        expect(
          await get(
            "neighbor",
            `http://${hostIp}:${AGENT_VAULT_API_PORT}/health`,
          ),
        ).toBe("000")
        expect(await get("neighbor", `http://${hostIp}:18080/`)).toBe("000")
        expect(await get("neighbor", "http://1.1.1.1/")).toBe("000")
        expect(await backendToAgent()).toBe("200")
        // Agent Vault's bridge does not reach a sandbox's published agent port
        // or Agent Vault's own API through the host address, so a sandbox
        // cannot CONNECT through the proxy to them.
        expect(await getFromVaultNetwork(`http://${hostIp}:18080/`)).toBe("000")
        expect(
          await getFromVaultNetwork(
            `http://${hostIp}:${AGENT_VAULT_API_PORT}/health`,
          ),
        ).toBe("000")

        // dockerd restarts (an update, a crash): systemd runs the firewall
        // again, and Docker may have moved its own rules above it.
        await inHost("pkill -x dockerd")
        await startDocker()
        expect(await connect("neighbor")).toBe("407")
        expect(await connect("hostile")).toBe("429")
        await sandbox("late")
        expect(await connect("late")).toBe("407")
        expect(await get("late", `http://${hostIp}:18080/`)).toBe("000")
        expect(await getFromVaultNetwork(`http://${hostIp}:18080/`)).toBe("000")
        expect(
          await getFromVaultNetwork(
            `http://${hostIp}:${AGENT_VAULT_API_PORT}/health`,
          ),
        ).toBe("000")
        expect(await backendToAgent()).toBe("200")
      } finally {
        await docker("rm", "-f", "-v", name).catch(() => "")
      }
    },
  )
})
