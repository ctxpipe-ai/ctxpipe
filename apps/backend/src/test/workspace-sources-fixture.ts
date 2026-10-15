import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { config } from "dotenv"
import { eq } from "drizzle-orm"
import { closeDb, getSystemDb, initDb, withOrgDbContext } from "../db/client.js"
import { organizations } from "../db/schema/auth.js"
import { type ConnectionType, connections } from "../db/schema/connections.js"
import { repositories as repositoriesTable } from "../db/schema/repositories.js"
import { workspaces } from "../db/schema/workspaces.js"
import {
  SOURCES_TREE_READ,
  splitSourcesTree,
} from "../domain/workspace-sources/source-tree.js"
import { listMarkdownFilesAtGitSha } from "../services/git/clone-tree.js"

const execFileAsync = promisify(execFile)
const __dirname = fileURLToPath(new URL(".", import.meta.url))

/** A real Postgres org with Workspaces and connections, ids suffixed per run. */
export async function seedSourcesOrg(name: string) {
  config({ path: resolve(__dirname, "../../.env.local") })
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
  initDb(process.env.DATABASE_URL)
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`
  const orgId = `org_test_${name}_${suffix}`
  await getSystemDb()
    .insert(organizations)
    .values({ id: orgId, slug: orgId, name, createdAt: new Date() })
  const repositories: string[] = []
  return {
    orgId,
    suffix,
    async addConnection(type: ConnectionType, config: object = {}) {
      const id = `con_${type}_${Math.random().toString(36).slice(2)}`
      await withOrgDbContext(orgId, (db) =>
        db.insert(connections).values({
          id,
          orgId,
          type,
          config: config as Record<string, unknown>,
        }),
      )
      return id
    },
    async removeConnection(id: string) {
      await withOrgDbContext(orgId, (db) =>
        db.delete(connections).where(eq(connections.id, id)),
      )
    },
    async addWorkspace(slug: string, url?: string) {
      const id = `ws_${slug.replaceAll("-", "_")}_${suffix}`
      const repositoryUrl =
        url ?? `https://github.com/acme/${slug}-${suffix}.git`
      await withOrgDbContext(orgId, (db) =>
        db.insert(workspaces).values({
          id,
          orgId,
          slug: `${slug}-${suffix.replaceAll("_", "-")}`.slice(0, 60),
          displayName: slug,
          workspaceRepositoryUrl: repositoryUrl,
          desiredDefaultBranch: "main",
        }),
      )
      return id
    },
    async setRootPath(id: string, rootPath: string) {
      await withOrgDbContext(orgId, (db) =>
        db.update(workspaces).set({ rootPath }).where(eq(workspaces.id, id)),
      )
    },
    /** A local git repository whose commits stand in for a Workspace remote. */
    async gitRepository() {
      const dir = await mkdtemp(join(tmpdir(), "ctxpipe-sources-"))
      repositories.push(dir)
      await execFileAsync("git", ["init", "-b", "main", dir])
      await execFileAsync("git", [
        "-C",
        dir,
        "config",
        "user.email",
        "dev@example.com",
      ])
      await execFileAsync("git", ["-C", dir, "config", "user.name", "Dev"])
      const sourcesTree = async (sha: string) =>
        splitSourcesTree(
          await listMarkdownFilesAtGitSha({
            url: dir,
            sha,
            ...SOURCES_TREE_READ,
          }),
        )
      return {
        dir,
        async commit(files: Record<string, string | null>) {
          for (const [path, content] of Object.entries(files)) {
            const full = join(dir, path)
            if (content === null) await rm(full, { force: true })
            else {
              await mkdir(dirname(full), { recursive: true })
              await writeFile(full, content)
            }
          }
          await execFileAsync("git", ["-C", dir, "add", "-A"])
          await execFileAsync("git", [
            "-C",
            dir,
            "commit",
            "--allow-empty",
            "-m",
            "change",
          ])
          const { stdout } = await execFileAsync("git", [
            "-C",
            dir,
            "rev-parse",
            "HEAD",
          ])
          return stdout.trim()
        },
        /** Read the sources file at `sha` the way hydrate reads it. */
        async sourcesText(sha: string): Promise<string | null> {
          return (await sourcesTree(sha)).sourcesFile
        },
        /** Read `.ctxpipe/sources.yaml` and `sources/` the way hydrate reads them. */
        sourcesTree,
      }
    },
    async cleanup() {
      await withOrgDbContext(orgId, async (db) => {
        await db.delete(workspaces).where(eq(workspaces.orgId, orgId))
        await db.delete(connections).where(eq(connections.orgId, orgId))
        await db
          .delete(repositoriesTable)
          .where(eq(repositoriesTable.orgId, orgId))
      })
      await getSystemDb()
        .delete(organizations)
        .where(eq(organizations.id, orgId))
      for (const dir of repositories)
        await rm(dir, { recursive: true, force: true })
      await closeDb()
    },
  }
}
