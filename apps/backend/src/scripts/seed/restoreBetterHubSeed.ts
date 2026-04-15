import { spawnSync } from "node:child_process"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { config } from "dotenv"
import { fileURLToPath } from "node:url"
import {
  BETTER_HUB_SEED_BUNDLE_TGZ,
  BETTER_HUB_SEED_DIR,
  BETTER_HUB_SEED_MANIFEST_JSON,
  BETTER_HUB_SEED_PUBLIC_CREDENTIALS_JSON,
  BETTER_HUB_SEED_RUNTIME_CREDENTIALS_JSON,
} from "./seedPaths.js"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
config({ path: resolve(__dirname, "../../../.env.local") })

type SeedManifest = {
  schemaVersion: 1
  app: { orgSlug: string; email: string }
  artifacts: {
    postgres: string
    falkor: string
    zoektIndexTar: string
    repoCacheTar: string
  }
}

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) {
    console.error(`Missing required env var ${name}`)
    process.exit(1)
  }
  return v
}

function sh(cmd: string, args: string[]) {
  const res = spawnSync(cmd, args, { stdio: "inherit", env: process.env })
  if (res.status !== 0) throw new Error(`Command failed: ${cmd} ${args.join(" ")}`)
}

function shOutput(cmd: string, args: string[]): string {
  const res = spawnSync(cmd, args, {
    stdio: ["ignore", "pipe", "inherit"],
    env: process.env,
    encoding: "utf8",
  })
  if (res.status !== 0) throw new Error(`Command failed: ${cmd} ${args.join(" ")}`)
  return (res.stdout ?? "").toString().trim()
}

async function ensureSeedDir(): Promise<void> {
  await mkdir(BETTER_HUB_SEED_DIR, { recursive: true })
}

async function main(): Promise<void> {
  await ensureSeedDir()

  // Ensure stack is up so we can restore into running services.
  sh("bash", [
    "-lc",
    "docker compose --profile deploy up -d postgres falkordb migrate backend worker ui codesearch",
  ])

  // Extract seed bundle into seed dir (overwrites expected files).
  await rm(resolve(BETTER_HUB_SEED_DIR, "postgres.sql"), { force: true }).catch(() => {})
  await rm(resolve(BETTER_HUB_SEED_DIR, "falkor.rdb"), { force: true }).catch(() => {})
  await rm(resolve(BETTER_HUB_SEED_DIR, "zoekt_index.tar.gz"), { force: true }).catch(() => {})
  await rm(resolve(BETTER_HUB_SEED_DIR, "repo_cache.tar.gz"), { force: true }).catch(() => {})
  sh("tar", ["-xzf", BETTER_HUB_SEED_BUNDLE_TGZ, "-C", BETTER_HUB_SEED_DIR])

  const manifest = JSON.parse(
    await readFile(BETTER_HUB_SEED_MANIFEST_JSON, "utf8"),
  ) as SeedManifest

  // Restore Postgres via psql in container.
  const postgresContainer = shOutput("docker", [
    "compose",
    "--profile",
    "deploy",
    "ps",
    "-q",
    "postgres",
  ])
  const pgSql = resolve(BETTER_HUB_SEED_DIR, manifest.artifacts.postgres)
  sh("docker", ["cp", pgSql, `${postgresContainer}:/tmp/seed.sql`])
  sh("docker", [
    "exec",
    "-i",
    postgresContainer,
    "bash",
    "-lc",
    "psql -U ctxpipe -d ctxpipe -f /tmp/seed.sql",
  ])

  // Restore FalkorDB by replacing dump.rdb and restarting container.
  const falkorContainer = shOutput("docker", [
    "compose",
    "--profile",
    "deploy",
    "ps",
    "-q",
    "falkordb",
  ])
  const falkorRdb = resolve(BETTER_HUB_SEED_DIR, manifest.artifacts.falkor)
  sh("docker", ["cp", falkorRdb, `${falkorContainer}:/var/lib/falkordb/data/dump.rdb`])
  sh("docker", ["restart", falkorContainer])

  // Restore zoekt index + repo cache into codesearch volumes.
  const codesearchContainer = shOutput("docker", [
    "compose",
    "--profile",
    "deploy",
    "ps",
    "-q",
    "codesearch",
  ])
  const zoektTar = resolve(BETTER_HUB_SEED_DIR, manifest.artifacts.zoektIndexTar)
  const repoCacheTar = resolve(BETTER_HUB_SEED_DIR, manifest.artifacts.repoCacheTar)
  sh("docker", ["cp", zoektTar, `${codesearchContainer}:/tmp/zoekt_index.tar.gz`])
  sh("docker", ["cp", repoCacheTar, `${codesearchContainer}:/tmp/repo_cache.tar.gz`])
  sh("docker", [
    "exec",
    codesearchContainer,
    "bash",
    "-lc",
    "rm -rf /data/zoekt-index /data/repo-cache && mkdir -p /data && tar -xzf /tmp/zoekt_index.tar.gz -C /data && tar -xzf /tmp/repo_cache.tar.gz -C /data",
  ])

  // Write runtime-only credentials for browser automation.
  const seedPassword = requireEnv("SEED_USER_PASSWORD")
  const publicCreds = JSON.parse(
    await readFile(BETTER_HUB_SEED_PUBLIC_CREDENTIALS_JSON, "utf8"),
  ) as { orgSlug: string; email: string; landingPath: string }
  await mkdir(dirname(BETTER_HUB_SEED_RUNTIME_CREDENTIALS_JSON), {
    recursive: true,
  })
  await writeFile(
    BETTER_HUB_SEED_RUNTIME_CREDENTIALS_JSON,
    JSON.stringify(
      {
        ...publicCreds,
        password: seedPassword,
      },
      null,
      2,
    ),
    "utf8",
  )

  console.log(
    `Restored better_hub_full seed. Runtime creds at ${BETTER_HUB_SEED_RUNTIME_CREDENTIALS_JSON}`,
  )
  console.log(
    `Landing: /${manifest.app.orgSlug}/repositories (email: ${manifest.app.email})`,
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

