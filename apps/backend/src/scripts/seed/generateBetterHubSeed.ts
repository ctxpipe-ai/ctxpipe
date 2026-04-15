import { spawnSync } from "node:child_process"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { config } from "dotenv"
import { eq } from "drizzle-orm"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { parseEnv } from "../../config/env.js"
import {
  closeDb,
  getOrgDb,
  getSystemDb,
  initDb,
  withOrgDbContext,
} from "../../db/client.js"
import { members, organizations, users } from "../../db/schema/auth.js"
import { orgOnboarding } from "../../db/schema/org_onboarding.js"
import { createRepository } from "../../models/repositories.js"
import { repositoryIngestion } from "../../openworkflow/repository-ingestion.js"
import { ow } from "../../openworkflow/client.js"
import {
  BETTER_HUB_SEED_BUNDLE_TGZ,
  BETTER_HUB_SEED_DIR,
  BETTER_HUB_SEED_MANIFEST_JSON,
  BETTER_HUB_SEED_PUBLIC_CREDENTIALS_JSON,
} from "./seedPaths.js"
import { generateObjectId } from "../../lib/id.js"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
config({ path: resolve(__dirname, "../../../.env.local") })

type SeedManifest = {
  schemaVersion: 1
  createdAt: string
  app: {
    orgId: string
    orgSlug: string
    userId: string
    email: string
    repositoryId: string
    zoektRepoId: number
    targetHash: string | null
  }
  sources: {
    gitUrl: string
  }
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

function sh(cmd: string, args: string[], opts?: { env?: Record<string, string> }) {
  const res = spawnSync(cmd, args, {
    stdio: "inherit",
    env: { ...process.env, ...(opts?.env ?? {}) },
  })
  if (res.status !== 0) {
    throw new Error(`Command failed: ${cmd} ${args.join(" ")}`)
  }
}

function shOutput(cmd: string, args: string[]): string {
  const res = spawnSync(cmd, args, {
    stdio: ["ignore", "pipe", "inherit"],
    env: process.env,
    encoding: "utf8",
  })
  if (res.status !== 0) {
    throw new Error(`Command failed: ${cmd} ${args.join(" ")}`)
  }
  return (res.stdout ?? "").toString().trim()
}

async function ensureSeedDir() {
  await mkdir(BETTER_HUB_SEED_DIR, { recursive: true })
}

async function waitForHttpOk(url: string, timeoutMs: number) {
  const start = Date.now()
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const res = await fetch(url, { method: "GET" })
      if (res.ok) return
    } catch {
      // ignore until timeout
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for ${url}`)
    }
    await new Promise((r) => setTimeout(r, 500))
  }
}

async function main(): Promise<void> {
  const env = parseEnv(process.env as Record<string, string | undefined>)
  initDb(env.DATABASE_URL)

  const SEED_EMAIL = requireEnv("SEED_USER_EMAIL")
  const SEED_NAME = requireEnv("SEED_USER_NAME")
  const SEED_PASSWORD = requireEnv("SEED_USER_PASSWORD")
  const SEED_ORG_NAME = requireEnv("SEED_ORG_NAME")
  const SEED_ORG_SLUG = requireEnv("SEED_ORG_SLUG")

  const GIT_URL = "https://github.com/better-auth/better-hub.git"
  const REPO_NAME = "better-auth/better-hub"

  await ensureSeedDir()
  await rm(BETTER_HUB_SEED_BUNDLE_TGZ, { force: true }).catch(() => {})

  // 0) Ensure full dockerized stack is up (so auth HTTP endpoints exist).
  // Using deploy profile so codesearch+zoekt have stable /data paths for snapshotting.
  sh("bash", ["-lc", "docker compose --profile deploy up -d --build migrate backend worker ui codesearch"])
  await waitForHttpOk(`${env.AUTH_BASE_URL.replace(/\/$/, "")}/.docs/openapi`, 120_000)

  // 1) Create user via Better Auth HTTP API (so password hashing etc stays correct).
  const baseUrl = env.AUTH_BASE_URL.replace(/\/$/, "")
  const signUpRes = await fetch(`${baseUrl}/.auth/api/v1/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: SEED_EMAIL, password: SEED_PASSWORD, name: SEED_NAME }),
  })
  if (!signUpRes.ok && signUpRes.status != 409) {
    const text = await signUpRes.text().catch(() => "")
    throw new Error(`sign-up failed: ${signUpRes.status} ${text}`)
  }

  // 2) Create org and membership directly in Postgres (deterministic IDs + no cookie juggling).
  const systemDb = getSystemDb()
  const [userRow] = await systemDb
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.email, SEED_EMAIL))
    .limit(1)
  if (!userRow) throw new Error("Seed user not found after signup")

  const orgId = generateObjectId("org")
  const now = new Date()
  await systemDb.transaction(async (tx) => {
    await tx
      .insert(organizations)
      .values({
        id: orgId,
        name: SEED_ORG_NAME,
        slug: SEED_ORG_SLUG,
        logo: null,
        createdAt: now,
        metadata: null,
      })
      .onConflictDoNothing()
    await tx
      .insert(members)
      .values({
        id: generateObjectId("mbr"),
        organizationId: orgId,
        userId: userRow.id,
        role: "admin",
        createdAt: now,
      })
      .onConflictDoNothing()
  })

  // 3) Mark user onboarding complete + org onboarding complete.
  await systemDb
    .update(users)
    .set({ onboardingCompletedAt: now })
    .where(eq(users.id, userRow.id))
  await systemDb
    .insert(orgOnboarding)
    .values({
      organizationId: orgId,
      completedAt: now,
      completedByUserId: userRow.id,
      createdAt: now,
    })
    .onConflictDoUpdate({
      target: orgOnboarding.organizationId,
      set: { completedAt: now, completedByUserId: userRow.id },
    })

  // 4) Add repo and run ingestion workflow in-process.
  let repositoryId = ""
  let zoektRepoId = 0
  let targetHash: string | null = null
  await withOrgIdContext({ id: orgId, slug: SEED_ORG_SLUG }, async () =>
    withOrgDbContext(orgId, async () => {
      const repo = await createRepository({ name: REPO_NAME, gitUrl: GIT_URL })
      repositoryId = repo.id
      zoektRepoId = repo.zoektRepoId
      const result = await ow.runWorkflow(repositoryIngestion.spec, {
        repositoryId: repo.id,
        orgId: repo.orgId,
      })
      targetHash = (result as unknown as { targetHash?: string }).targetHash ?? null
    }),
  )

  // 5) Write public credentials for automation (no secret).
  await writeFile(
    BETTER_HUB_SEED_PUBLIC_CREDENTIALS_JSON,
    JSON.stringify(
      {
        orgSlug: SEED_ORG_SLUG,
        email: SEED_EMAIL,
        landingPath: `/${SEED_ORG_SLUG}/repositories`,
      },
      null,
      2,
    ),
    "utf8",
  )

  // 6) Export snapshots.
  // Postgres dump
  const pgDumpPath = resolve(BETTER_HUB_SEED_DIR, "postgres.sql")
  sh("bash", [
    "-lc",
    `PGPASSWORD=${process.env.POSTGRES_PASSWORD ?? "ctxpipe"} pg_dump "${env.DATABASE_URL}" > "${pgDumpPath}"`,
  ])

  // FalkorDB dump: use RDB save + copy dump file from container.
  const falkorDumpPath = resolve(BETTER_HUB_SEED_DIR, "falkor.rdb")
  const falkorContainer = shOutput("docker", ["compose", "--profile", "deploy", "ps", "-q", "falkordb"])
  sh("docker", ["exec", falkorContainer, "redis-cli", "SAVE"])
  sh("docker", ["cp", `${falkorContainer}:/var/lib/falkordb/data/dump.rdb`, falkorDumpPath])

  // Zoekt + repo-cache + kuzu live in codesearch container volumes mounted at /data.
  const codesearchContainer = shOutput("docker", [
    "compose",
    "--profile",
    "deploy",
    "ps",
    "-q",
    "codesearch",
  ])
  const zoektTar = resolve(BETTER_HUB_SEED_DIR, "zoekt_index.tar.gz")
  const repoCacheTar = resolve(BETTER_HUB_SEED_DIR, "repo_cache.tar.gz")
  sh("docker", ["exec", codesearchContainer, "tar", "-czf", "/tmp/zoekt_index.tar.gz", "-C", "/data", "zoekt-index"])
  sh("docker", ["exec", codesearchContainer, "tar", "-czf", "/tmp/repo_cache.tar.gz", "-C", "/data", "repo-cache"])
  sh("docker", ["cp", `${codesearchContainer}:/tmp/zoekt_index.tar.gz`, zoektTar])
  sh("docker", ["cp", `${codesearchContainer}:/tmp/repo_cache.tar.gz`, repoCacheTar])

  const manifest: SeedManifest = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    app: {
      orgId,
      orgSlug: SEED_ORG_SLUG,
      userId: userRow.id,
      email: SEED_EMAIL,
      repositoryId,
      zoektRepoId,
      targetHash,
    },
    sources: { gitUrl: GIT_URL },
    artifacts: {
      postgres: "postgres.sql",
      falkor: "falkor.rdb",
      zoektIndexTar: "zoekt_index.tar.gz",
      repoCacheTar: "repo_cache.tar.gz",
    },
  }
  await writeFile(BETTER_HUB_SEED_MANIFEST_JSON, JSON.stringify(manifest, null, 2), "utf8")

  // 7) Bundle everything into tar.gz
  sh("tar", [
    "-czf",
    BETTER_HUB_SEED_BUNDLE_TGZ,
    "-C",
    BETTER_HUB_SEED_DIR,
    "postgres.sql",
    "falkor.rdb",
    "zoekt_index.tar.gz",
    "repo_cache.tar.gz",
    "manifest.json",
    "credentials.json",
  ])

  console.log(`Seed bundle written: ${BETTER_HUB_SEED_BUNDLE_TGZ}`)
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(async () => {
    await closeDb().catch(() => {})
  })

