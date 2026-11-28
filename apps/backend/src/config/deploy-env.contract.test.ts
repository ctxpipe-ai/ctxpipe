import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

import {
  knownFindings,
  operatorSettings,
  SERVICES,
  serviceFindings,
} from "./deploy-env-contract.js"

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url))

/** The operator `.env` of the contract: each setting of the docs. */
function operatorEnv(): Record<string, string> {
  return {
    ...operatorSettings(),
    MODEL_PROVIDER: "openrouter",
    MODEL_PROVIDER_API_KEY: "model-key",
    MODEL_VISION_NAME: "openai/gpt-6.1-terra",
    POSTGRES_PASSWORD: "postgres-password",
    CLICKHOUSE_PASSWORD: "admin-password",
    CLICKHOUSE_READER_PASSWORD: "reader-password",
    CLICKHOUSE_WRITER_PASSWORD: "writer-password",
  }
}

/**
 * The service envs of `docker compose --profile deploy config` with this
 * `.env`. The test reads the Compose file itself and gives it on stdin, so
 * that the check selection sees the read. The process env holds no
 * setting, and the `.env` of the checkout is not read.
 */
async function composeEnvironments(
  dotEnv: Record<string, string>,
): Promise<Record<string, Record<string, string>>> {
  const compose = await readFile(join(repoRoot, "docker-compose.yml"), "utf8")
  const dir = await mkdtemp(join(tmpdir(), "ctxpipe-env-contract-"))
  try {
    const envFile = join(dir, "operator.env")
    await writeFile(
      envFile,
      Object.entries(dotEnv)
        .map(([name, value]) => `${name}=${value}\n`)
        .join(""),
    )
    const child = execFile(
      "docker",
      [
        "compose",
        "--project-directory",
        repoRoot,
        "--file",
        "-",
        "--env-file",
        envFile,
        "--profile",
        "deploy",
        "config",
        "--format",
        "json",
      ],
      {
        env: { PATH: process.env.PATH, HOME: process.env.HOME },
        maxBuffer: 16 * 1024 * 1024,
        timeout: 60_000,
      },
    )
    const output = new Promise<string>((resolve, reject) => {
      let stdout = ""
      let stderr = ""
      child.stdout?.on("data", (chunk) => (stdout += chunk))
      child.stderr?.on("data", (chunk) => (stderr += chunk))
      child.on("error", reject)
      child.on("close", (code) =>
        code === 0
          ? resolve(stdout)
          : reject(new Error(`docker compose config failed: ${stderr}`)),
      )
    })
    child.stdin?.end(compose)
    const services = (
      JSON.parse(await output) as {
        services: Record<string, { environment?: Record<string, string> }>
      }
    ).services
    return Object.fromEntries(
      Object.entries(services).map(([name, service]) => [
        name,
        service.environment ?? {},
      ]),
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function composeFindings(
  dotEnv: Record<string, string>,
): Promise<string[]> {
  const services = await composeEnvironments(dotEnv)
  return SERVICES.flatMap((service) => {
    const env = services[service]
    return env
      ? serviceFindings("compose", service, env)
      : [`compose ${service}: no service`]
  }).sort()
}

// The env contract (deploy-env-contract.ts) of the Compose `deploy` profile.
// The construct half is packages/aws-cdk/src/env-contract.test.ts: only that
// package resolves aws-cdk-lib and makes the generated image tag file.
describe("the env contract of the Compose deploy profile", () => {
  it("gives each service the settings that it needs, except the known gaps", async () => {
    // A new finding: fix docker-compose.yml. A known finding that is gone:
    // remove it from KNOWN_GAPS in deploy-env-contract.ts.
    expect(await composeFindings(operatorEnv())).toEqual(
      knownFindings("compose"),
    )
  })

  it("fails Compose settings that cannot serve the knowledge plane", async () => {
    const findings = await composeFindings({
      ...operatorEnv(),
      MODEL_PROVIDER_ALLOWLIST: "azure",
    })
    expect(findings).toContain("compose backend: plane allowlist-without-jev")
    expect(findings).toContain("compose worker: plane allowlist-without-jev")

    const openAi = await composeFindings({
      ...operatorEnv(),
      MODEL_PROVIDER: "openai-like",
      MODEL_PROVIDER_URL: "https://api.openai.com/v1",
      MODEL_PROVIDER_ALLOWLIST: "",
    })
    expect(openAi).toContain("compose backend: plane not-openrouter")
  })
})
