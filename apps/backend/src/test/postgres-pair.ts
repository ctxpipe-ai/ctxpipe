import { execFile } from "node:child_process"
import { chmod, mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"

import pg from "pg"

/*
 * Two Postgres 17 servers in containers, with the role models of the cutover
 * (CTX-1217). The source has the roles of Neon: an owner login
 * `neondb_owner` that is a member of `neon_superuser`, which has BYPASSRLS.
 * The target has the roles of Aurora: a master login `ctxpipe` that is not a
 * superuser, in an `rds_superuser` group. The copy test and the local
 * rehearsal use them.
 */

const exec = promisify(execFile)

const POSTGRES_IMAGE =
  "pgvector/pgvector:pg17@sha256:7d0a41464797aeb9862dfdc0bbf1526b82cfd324cdd8036df19e3545f4a9ccb8"
const OWNER_PASSWORD = "owner-password"
const ADMIN_PASSWORD = "admin"

async function docker(...args: string[]): Promise<string> {
  const { stdout } = await exec("docker", args, { maxBuffer: 16 * 1024 * 1024 })
  return stdout.trim()
}

export async function sql(url: string, ...statements: string[]): Promise<void> {
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    for (const statement of statements) await client.query(statement)
  } finally {
    await client.end()
  }
}

function withLogin(
  url: string,
  database: string,
  user: string,
  password: string,
): string {
  const parsed = new URL(url)
  parsed.pathname = `/${database}`
  parsed.username = user
  parsed.password = password
  return parsed.toString()
}

type Server = { id: string; url: string }

/** Starts a server and returns the URL of its superuser on 127.0.0.1. */
async function startServer(superuser: string): Promise<Server> {
  const id = await docker(
    "run",
    "-d",
    "--rm",
    "-e",
    `POSTGRES_USER=${superuser}`,
    "-e",
    `POSTGRES_PASSWORD=${ADMIN_PASSWORD}`,
    "-e",
    "POSTGRES_DB=postgres",
    "-p",
    "127.0.0.1::5432",
    // Parallel index builds (the HNSW index of the embeddings) need more
    // shared memory than the Docker default of 64 MB.
    "--shm-size=1g",
    POSTGRES_IMAGE,
  )
  const port = (await docker("port", id, "5432/tcp")).split(":").pop()
  const url = `postgresql://${superuser}:${ADMIN_PASSWORD}@127.0.0.1:${port}/postgres`
  for (let attempt = 0; ; attempt++) {
    const client = new pg.Client({ connectionString: url })
    try {
      await client.connect()
      await client.query("SELECT 1")
      return { id, url }
    } catch (error) {
      if (attempt > 120) {
        await docker("rm", "-f", id).catch(() => undefined)
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
    } finally {
      await client.end().catch(() => undefined)
    }
  }
}

export type PostgresPair = {
  /** The Neon owner login on the source database `neondb`. */
  sourceUrl: string
  /** The source superuser on `neondb`, for test setup only. */
  sourceSuperUrl: string
  /** The Aurora master login on a target database. */
  targetUrl: (database: string) => string
  stop: () => Promise<void>
}

/**
 * Starts the pair. Each name in `targetDatabases` is an empty database of the
 * master login on the target, with the vector extension: the Aurora master
 * login can make it, and a plain non-superuser cannot.
 */
export async function startPostgresPair(
  targetDatabases: string[],
): Promise<PostgresPair> {
  const [source, target] = await Promise.all([
    startServer("cloud_admin"),
    startServer("rdsadmin"),
  ])
  const stop = async () => {
    await Promise.all(
      [source.id, target.id].map((id) =>
        docker("rm", "-f", id).catch(() => undefined),
      ),
    )
  }
  try {
    await sql(
      source.url,
      "CREATE ROLE neon_superuser NOLOGIN BYPASSRLS CREATEDB CREATEROLE",
      `CREATE ROLE neondb_owner LOGIN PASSWORD '${OWNER_PASSWORD}' CREATEDB CREATEROLE IN ROLE neon_superuser`,
      "CREATE DATABASE neondb OWNER neondb_owner",
    )
    const sourceSuperUrl = withLogin(
      source.url,
      "neondb",
      "cloud_admin",
      ADMIN_PASSWORD,
    )
    await sql(sourceSuperUrl, "CREATE EXTENSION vector")
    await sql(
      target.url,
      "CREATE ROLE rds_superuser NOLOGIN",
      `CREATE ROLE ctxpipe LOGIN PASSWORD '${OWNER_PASSWORD}' CREATEDB CREATEROLE IN ROLE rds_superuser`,
    )
    for (const database of targetDatabases) {
      await sql(target.url, `CREATE DATABASE ${database} OWNER ctxpipe`)
      await sql(
        withLogin(target.url, database, "rdsadmin", ADMIN_PASSWORD),
        "CREATE EXTENSION vector",
      )
    }
    return {
      sourceUrl: withLogin(
        source.url,
        "neondb",
        "neondb_owner",
        OWNER_PASSWORD,
      ),
      sourceSuperUrl,
      targetUrl: (database) =>
        withLogin(target.url, database, "ctxpipe", OWNER_PASSWORD),
      stop,
    }
  } catch (error) {
    await stop()
    throw error
  }
}

/**
 * Writes `pg_dump` and `pg_restore` wrappers that run the tools of the
 * server image, and returns their directory: put it first on PATH. The
 * wrappers mount `workRoot`, so the dump directory must be in it. On a Docker
 * VM (Colima), `workRoot` must be in a shared directory such as the home
 * directory.
 */
export async function clientToolsDirectory(workRoot: string): Promise<string> {
  const bin = join(workRoot, "bin")
  await mkdir(bin, { recursive: true })
  const { stdout: uid } = await exec("id", ["-u"])
  const { stdout: gid } = await exec("id", ["-g"])
  for (const tool of ["pg_dump", "pg_restore"]) {
    const path = join(bin, tool)
    await writeFile(
      path,
      [
        "#!/bin/sh",
        `exec docker run --rm --network host --user ${uid.trim()}:${gid.trim()} -e PGPASSWORD -v "${workRoot}:${workRoot}" ${POSTGRES_IMAGE} ${tool} "$@"`,
        "",
      ].join("\n"),
    )
    await chmod(path, 0o755)
  }
  return bin
}
