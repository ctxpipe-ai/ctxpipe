import { execFileSync } from "node:child_process"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, expect, it } from "vitest"
import { parse } from "yaml"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { withOrgDbContext } from "../../db/client.js"
import { claims } from "../../db/schema/claims.js"
import { connections } from "../../db/schema/connections.js"
import { repositories } from "../../db/schema/repositories.js"
import { generateObjectId } from "../../lib/id.js"
import { persistOrgFirstWorkspace } from "../../models/workspaces.js"
import {
  type GitPack,
  readGitPackFromRemote,
  withGitDirectory,
} from "../../services/git/pack.js"
import { usePlainGitNetwork } from "../../services/git/plain-git-remote.js"
import { pagerdutySourceMigrationHook } from "../../services/pagerduty/workspace-source-migration.js"
import {
  slackLegacyBindings,
  slackSourceMigrationHook,
} from "../../services/slack/source-migration.js"
import { seedLegacyExtractionObject } from "../../test/legacy-extraction-fixture.js"
import {
  type NativeHydrationFixture,
  withNativeHydrationFixture,
} from "../../test/native-hydration-fixture.js"
import type { SourceMigrationHook } from "../workspace-sources/migration-plan.js"
import type { SourceProvider } from "../workspace-sources/sources-file.js"
import { ensureOrgRepositoryForGitUrl } from "../workspaces/ensure-org-repository.js"
import { buildUpgradeCommits } from "./build-commits.js"
import { exportAndSourcesStep } from "./steps/export-and-sources.js"

/*
 * Upgrade step 1 on a real Workspace repository and a real database. Each
 * test reads the commit of the step and the lines of its report.
 */

// The DNS of the test: `hidden.example.com` resolves to a private address,
// each other host to a public one.
let restoreNetwork = () => {}
beforeAll(() => {
  restoreNetwork = usePlainGitNetwork({
    lookup: async (host) => [
      { address: host === "hidden.example.com" ? "10.0.0.7" : "93.184.215.14" },
    ],
  })
})
afterAll(() => restoreNetwork())

async function runStep(
  f: NativeHydrationFixture,
  hooks: Partial<Record<SourceProvider, SourceMigrationHook>> = {},
  base?: GitPack,
) {
  return withOrgIdContext(f.org, async () =>
    buildUpgradeCommits({
      pack:
        base ?? (await readGitPackFromRemote({ url: f.remote, sha: f.sha })),
      steps: [exportAndSourcesStep(hooks)],
      fromFormat: 0,
      targetFormat: 1,
      ctx: {
        orgId: f.org.id,
        workspaceId: f.workspaceId,
        baseSha: f.sha,
        remote: { url: f.workspaceUrl, connectionId: f.connectionId },
      },
      createdAt: "2026-10-17T00:00:00.000Z",
    }),
  )
}

/** The files of the pack's head, with their mode and text. */
async function readTree(pack: GitPack) {
  return withGitDirectory(
    pack.sha,
    async (directory) => {
      const git = (...args: string[]) =>
        execFileSync("git", args, { cwd: directory, encoding: "utf8" })
      const modes = new Map(
        git("ls-tree", "-r", pack.sha)
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const tab = line.indexOf("\t")
            return [line.slice(tab + 1), line.slice(0, 6)] as const
          }),
      )
      const text = new Map(
        [...modes.keys()].map((path) => [
          path,
          git("show", `${pack.sha}:${path}`),
        ]),
      )
      return { paths: [...modes.keys()], modes, text }
    },
    pack,
  )
}

function seed(
  f: NativeHydrationFixture,
  kind: string,
  deduplicationKey: string,
  payload: Record<string, unknown>,
) {
  return withOrgDbContext(f.org.id, () =>
    seedLegacyExtractionObject(f.org.id, { kind, deduplicationKey, payload }),
  )
}

async function link(
  f: NativeHydrationFixture,
  subjectId: string,
  objectId: string,
  predicate: string,
) {
  const now = new Date("2026-01-01T00:00:00Z")
  await withOrgDbContext(f.org.id, (db) =>
    db.insert(claims).values({
      id: `clm_${f.id}_${predicate}`,
      orgId: f.org.id,
      subjectId,
      objectId,
      predicate,
      status: "active",
      aggregatedConfidence: 0.9,
      firstObservedAt: now,
      lastObservedAt: now,
    }),
  )
}

async function repository(
  f: NativeHydrationFixture,
  gitUrl: string,
  githubConnectionId?: string,
) {
  const row = await ensureOrgRepositoryForGitUrl({ orgId: f.org.id, gitUrl })
  if (!row) throw new Error(`The org repository ${gitUrl} was not created`)
  // The GitHub connection that main recorded for the repository.
  if (githubConnectionId)
    await withOrgDbContext(f.org.id, (db) =>
      db
        .update(repositories)
        .set({ githubConnectionId })
        .where(eq(repositories.id, row.id)),
    )
  return row
}

it(
  "links each repository under its own connection, keeps what the sources do not link, and reports each link that it cannot keep",
  { timeout: 90_000 },
  async () =>
    withNativeHydrationFixture(
      {
        github: true,
        files: [
          { path: "README.md", body: "# Context\n" },
          {
            path: "linear/issues/ENG-1.md",
            body: "---\nidentifier: ENG-1\n---\n# ENG-1 Fix the build\n",
          },
        ],
      },
      async (f) => {
        const other = `con_other_${f.id}`
        await withOrgIdContext(f.org, async () => {
          await withOrgDbContext(f.org.id, (db) =>
            db.insert(connections).values({
              id: other,
              orgId: f.org.id,
              type: "github",
              config: {},
            }),
          )
          const own = await repository(f, f.workspaceUrl, f.connectionId)
          const api = await repository(
            f,
            "https://github.com/team-a/api.git",
            other,
          )
          // A GitHub repository with no connection: main read it as a
          // public repository, so it becomes a plain git source (CTX-815).
          const lost = await repository(f, "https://github.com/team-b/lost.git")
          // A port that is not the default: no source links it.
          const gitlab = await repository(
            f,
            "https://gitlab.com:8443/team-c/tools.git",
          )
          // A host name whose DNS answer is private: no source links it.
          const hidden = await repository(
            f,
            "https://hidden.example.com/team-e/hidden.git",
          )
          await persistOrgFirstWorkspace({
            orgId: f.org.id,
            workspaceId: f.workspaceId,
            sourceRepositoryId: own.id,
          })
          const tools = await seed(f, "Service", `svc:${gitlab.id}:tools`, {
            name: "Tools CLI",
            summary: "The release tools.",
          })
          const library = await seed(f, "Library", `lib:${api.id}:parser`, {
            name: "Parser library",
            summary: "Old pipeline text.",
          })
          const issue = await seed(f, "Issue", "iss:linear:ENG-1", {
            title: "ENG-1 Fix the build",
            path: "linear/issues/ENG-1.md",
          })
          const team = await seed(f, "Team", "team:github:acme/platform", {
            name: "Platform team",
          })
          await seed(f, "Service", `svc:${own.id}:context`, {
            name: "Context service",
            summary: "The code of the Workspace repository.",
          })
          await seed(f, "Library", `lib:${own.id}:helpers`, {
            name: "Workspace helpers",
          })
          await seed(f, "Service", `svc:${hidden.id}:hidden`, {
            name: "Hidden service",
            summary: "No source links this repository.",
          })
          await seed(f, "Service", `svc:${lost.id}:worker`, {
            name: "Lost worker",
            summary: "A plain git source links this repository.",
          })
          await link(f, tools.id, library.id, "USES")
          await link(f, tools.id, issue.id, "TRACKED_IN")
          await link(f, tools.id, team.id, "OWNED_BY")
        })

        const result = await runStep(f)
        const [step] = result.steps
        const report = step?.report ?? []
        const tree = await readTree(result.pack)

        // Blocker 1: each org repository links under its own connection.
        const sources = tree.text.get(".ctxpipe/sources.yaml") ?? ""
        const entries = (
          parse(sources) as {
            sources: Array<{ connection: string; repositories: unknown[] }>
          }
        ).sources
        expect(
          entries.find((entry) => entry.connection === other)?.repositories,
        ).toEqual(["team-a/api"])
        expect(sources).toContain("team-a/api")
        expect(sources).not.toContain("team-b/lost")
        expect(tree.text.get("sources/git/github.com/team-b-lost.md")).toBe(
          "---\nprovider: git\nurl: https://github.com/team-b/lost\n---\n",
        )
        expect(report).toContain(
          "Linked https://github.com/team-b/lost as a plain git source in `sources/git/github.com/team-b-lost.md`. Fresh ingestion reads it over HTTPS with no credential.",
        )
        expect(report).toContain(
          "Not linked: https://gitlab.com:8443/team-c/tools. ctxpipe does not read it as a plain git source: A plain git URL must use the default HTTPS port. Plain git sources must use an https:// URL. ssh (git@… or ssh://), git:// and file:// are not supported. ctxpipe keeps its knowledge and exports it.",
        )
        // Step 1 runs the DNS rule too: a private answer is not linked. The
        // report states the protocol rule, as the repositories route does.
        expect(report).toContain(
          "Not linked: https://hidden.example.com/team-e/hidden. ctxpipe does not read it as a plain git source: The host hidden.example.com of the plain git URL has no public address. Plain git sources must use an https:// URL. ssh (git@… or ssh://), git:// and file:// are not supported. ctxpipe keeps its knowledge and exports it.",
        )
        expect(
          tree.paths.filter((path) => path.startsWith("sources/git/hidden")),
        ).toEqual([])

        const exported = tree.paths.filter((path) =>
          path.startsWith("knowledge/"),
        )
        const all = exported.map((path) => tree.text.get(path)).join("\n")
        // Kept: the GitLab service, each object of the Workspace repository
        // that no Markdown file backs, whatever its key prefix, and the
        // CODEOWNERS team. The re-ingestion makes the knowledge of the
        // plain git source again.
        expect(all).toContain("Tools CLI")
        expect(all).toContain("Hidden service")
        expect(all).toContain("Context service")
        expect(all).toContain("Workspace helpers")
        expect(all).toContain("Platform team")
        expect(all).not.toContain("Lost worker")
        expect(all).not.toContain("Parser library")
        expect(report).toEqual(
          expect.arrayContaining([
            expect.stringMatching(
              /^Kept 1 knowledge item\(s\) from https:\/\/gitlab\.com:8443\/team-c\/tools .*public HTTPS git repositories/,
            ),
            expect.stringMatching(
              /^Kept 2 knowledge item\(s\) from .*Ingestion v2 does not ingest it/,
            ),
            expect.stringMatching(
              /^Kept 1 knowledge item\(s\) from CODEOWNERS files .*Hydrate does not make them/,
            ),
          ]),
        )

        // Blocker 2: the link to the Linear issue goes to its file, and the
        // link to the CODEOWNERS team goes to its exported file. The link to
        // the GitHub library is reported.
        const toolsFile = exported.find((path) =>
          tree.text.get(path)?.includes("Tools CLI"),
        )
        const toolsText = tree.text.get(toolsFile ?? "") ?? ""
        expect(toolsText).toContain("predicate: TRACKED_IN")
        expect(toolsText).toContain("to: ../../linear/issues/ENG-1.md")
        expect(toolsText).not.toContain("USES")
        expect(toolsText).toContain("predicate: OWNED_BY")
        expect(report).toEqual(
          expect.arrayContaining([
            expect.stringMatching(
              /^Dropped a link: "Tools CLI" \(svc:.*\) USES "Parser library" \(lib:/,
            ),
          ]),
        )
        expect(
          report.filter((line) => line.startsWith("Dropped")),
        ).toHaveLength(1)

        // A second plan on the output changes nothing.
        const rerun = await runStep(f, {}, result.pack)
        expect(rerun.steps[0]?.sha).toBeNull()
      },
    ),
)

it(
  "exports each object of the Workspace repository that no Markdown file backs, whatever its key prefix",
  { timeout: 90_000 },
  async () =>
    withNativeHydrationFixture(
      {
        github: true,
        files: [
          { path: "README.md", body: "# Context\n" },
          { path: "docs/adr/0001-use-git.md", body: "# Use git\n" },
        ],
      },
      async (f) => {
        await withOrgIdContext(f.org, async () => {
          const own = await repository(f, f.workspaceUrl, f.connectionId)
          await persistOrgFirstWorkspace({
            orgId: f.org.id,
            workspaceId: f.workspaceId,
            sourceRepositoryId: own.id,
          })
          // Code-only objects: no Markdown file of the Workspace backs them.
          await seed(f, "Api", `api:${own.id}:./:public`, {
            name: "Public API surface",
            summary: "The HTTP routes.",
          })
          await seed(f, "Operation", `op:${own.id}:./:deploy`, {
            name: "Deploy operation",
            summary: "Ships the service.",
            path: "scripts/deploy.ts",
          })
          // Hydrate makes this object again from its Markdown file.
          await seed(f, "Decision", `dec:${own.id}:docs/adr/0001-use-git.md`, {
            name: "Use git",
            path: "docs/adr/0001-use-git.md",
          })
        })

        const result = await runStep(f)
        const report = result.steps[0]?.report ?? []
        const tree = await readTree(result.pack)
        const all = tree.paths
          .filter((path) => path.startsWith("knowledge/"))
          .map((path) => tree.text.get(path))
          .join("\n")
        expect(all).toContain("Public API surface")
        expect(all).toContain("Deploy operation")
        expect(all).not.toContain("Use git")
        expect(report).toEqual(
          expect.arrayContaining([
            expect.stringMatching(
              /^Kept 2 knowledge item\(s\) from .*Ingestion v2 does not ingest it/,
            ),
            expect.stringMatching(
              /^Not exported, because ctx\| makes it again: 0 item\(s\) from source repositories .*, 1 item\(s\) from Workspace repositories /,
            ),
          ]),
        )
      },
    ),
)

it(
  "reports each repository that it cannot link when the sources file is not valid, and keeps its knowledge",
  { timeout: 90_000 },
  async () =>
    withNativeHydrationFixture(
      {
        github: true,
        files: [
          { path: "README.md", body: "# Context\n" },
          { path: ".ctxpipe/sources.yaml", body: "version: 2\n" },
          {
            path: "repositories/web.md",
            body: "---\ngit: https://github.com/acme/web.git\n---\n",
          },
        ],
      },
      async (f) => {
        await withOrgIdContext(f.org, async () => {
          const own = await repository(f, f.workspaceUrl, f.connectionId)
          const api = await repository(
            f,
            "https://github.com/team-a/api.git",
            f.connectionId,
          )
          await persistOrgFirstWorkspace({
            orgId: f.org.id,
            workspaceId: f.workspaceId,
            sourceRepositoryId: own.id,
          })
          await seed(f, "Library", `lib:${api.id}:parser`, {
            name: "Parser library",
            summary: "Reads the manifest.",
          })
        })
        const result = await runStep(f)
        const report = result.steps[0]?.report ?? []
        for (const item of [
          "repositories/web.md",
          "https://github.com/team-a/api",
        ])
          expect(report).toEqual(
            expect.arrayContaining([
              expect.stringMatching(
                new RegExp(
                  `^Not linked: ${item.replace(/[.]/g, "\\.")}\\. \`\\.ctxpipe/sources\\.yaml\` is not a valid version 1 file`,
                ),
              ),
            ]),
          )
        const tree = await readTree(result.pack)
        expect(tree.text.get(".ctxpipe/sources.yaml")).toBe("version: 2\n")
        expect(tree.paths).toContain("repositories/web.md")
        expect(
          tree.paths
            .filter((path) => path.startsWith("knowledge/"))
            .map((path) => tree.text.get(path))
            .join("\n"),
        ).toContain("Parser library")
      },
    ),
)

it(
  "never prints the user name or the password of a stored repository URL in the report",
  { timeout: 90_000 },
  async () =>
    withNativeHydrationFixture(
      { github: true, files: [{ path: "README.md", body: "# Context\n" }] },
      async (f) => {
        // A row that `POST /v1/repositories` stored before CTX-815: the URL
        // has a credential, so no plain git source links it.
        const stored =
          "https://deploy:s3cr3t-token@gitlab.com:8443/team-c/tools.git"
        await withOrgIdContext(f.org, async () => {
          const own = await repository(f, f.workspaceUrl, f.connectionId)
          await withOrgDbContext(f.org.id, (db) =>
            db.insert(repositories).values({
              id: generateObjectId("repo"),
              orgId: f.org.id,
              name: "team-c/tools",
              gitUrl: stored,
            }),
          )
          await persistOrgFirstWorkspace({
            orgId: f.org.id,
            workspaceId: f.workspaceId,
            sourceRepositoryId: own.id,
          })
        })
        const report = (await runStep(f)).steps[0]?.report ?? []
        expect(report).toContain(
          "Not linked: https://gitlab.com:8443/team-c/tools. ctxpipe does not read it as a plain git source: A plain git URL must not have a user name or a password. Plain git sources must use an https:// URL. ssh (git@… or ssh://), git:// and file:// are not supported. ctxpipe keeps its knowledge and exports it.",
        )
        expect(report.join("\n")).not.toContain("s3cr3t-token")
        expect(report.join("\n")).not.toContain("deploy:")
      },
    ),
)

it(
  "does not print the credential of a stored URL when the org has no first Workspace",
  { timeout: 90_000 },
  async () =>
    withNativeHydrationFixture(
      { files: [{ path: "README.md", body: "# Context\n" }] },
      async (f) => {
        await withOrgDbContext(f.org.id, (db) =>
          db.insert(repositories).values({
            id: generateObjectId("repo"),
            orgId: f.org.id,
            name: "team-c/tools",
            gitUrl: "https://deploy:s3cr3t-token@gitlab.com/team-c/tools.git",
          }),
        )
        const report = (await runStep(f)).steps[0]?.report ?? []
        expect(report).toContain(
          "Not linked: https://gitlab.com/team-c/tools. The org has no first Workspace, so no Workspace gets this repository.",
        )
        expect(report.join("\n")).not.toContain("s3cr3t-token")
      },
    ),
)

it(
  "names each repository and item that no Workspace gets when the org has no first Workspace",
  { timeout: 90_000 },
  async () =>
    withNativeHydrationFixture(
      { files: [{ path: "README.md", body: "# Context\n" }] },
      async (f) => {
        await withOrgIdContext(f.org, async () => {
          const gitlab = await repository(
            f,
            "https://gitlab.com/team-c/tools.git",
          )
          await seed(f, "Service", `svc:${gitlab.id}:tools`, {
            name: "Tools CLI",
          })
        })
        const report = (await runStep(f)).steps[0]?.report ?? []
        expect(report).toContain(
          "Not linked: https://gitlab.com/team-c/tools. The org has no first Workspace, so no Workspace gets this repository.",
        )
        expect(report).toEqual(
          expect.arrayContaining([
            expect.stringMatching(
              /^Not exported: "Tools CLI" \(svc:.*:tools\)\. The org has no first Workspace/,
            ),
          ]),
        )
      },
    ),
)

it(
  "moves the old Slack and PagerDuty files with their bytes and mode, and keeps a newer file at the managed path",
  { timeout: 90_000 },
  async () =>
    withNativeHydrationFixture(
      {
        files: [
          { path: "README.md", body: "# Context\n" },
          {
            path: "slack/channels/general--C0123ABCD/2026-01-01-thread.md",
            body: "# A thread\n",
          },
          // A symbolic link stays a symbolic link.
          {
            path: "slack/channels/general--C0123ABCD/latest.md",
            body: "2026-01-01-thread.md",
            mode: "120000",
          },
          // Not UTF-8 text: the move copies the bytes.
          {
            path: "slack/channels/general--C0123ABCD/2026-01-02-thread.md",
            body: "# Old copy é\u0000ÿ\n",
          },
          // A newer file at the managed path: the old file stays.
          {
            path: "slack/channels/C0123ABCD/2026-01-02-thread.md",
            body: "# Newer copy\n",
          },
          {
            path: "pagerduty/incidents/42--PINC1.md",
            body: "---\nservice_id: PSVC1\n---\n# Incident 42\n",
          },
          // An executable file stays executable.
          {
            path: "pagerduty/incidents/42--PINC1/runbook.sh",
            body: "#!/bin/sh\necho restart\n",
            mode: "100755",
          },
        ],
      },
      async (f) => {
        const slackConnection = `con_slack_${f.id}`
        const pagerdutyConnection = `con_pd_${f.id}`
        const hooks: Partial<Record<SourceProvider, SourceMigrationHook>> = {
          slack: {
            ...slackSourceMigrationHook,
            listLegacyBindings: async () =>
              slackLegacyBindings({
                connectionId: slackConnection,
                syncRepositoryUrl: f.workspaceUrl,
                paths: ["slack/channels/general--C0123ABCD/latest.md"],
              }),
          },
          pagerduty: {
            ...pagerdutySourceMigrationHook,
            listLegacyBindings: async () => [
              {
                provider: "pagerduty",
                connectionId: pagerdutyConnection,
                syncRepositoryUrl: f.workspaceUrl,
                scope: { services: ["PSVC1"] },
              },
            ],
          },
        }
        const base = await readTree(
          await readGitPackFromRemote({ url: f.remote, sha: f.sha }),
        )
        const result = await runStep(f, hooks)
        const report = result.steps[0]?.report ?? []
        const tree = await readTree(result.pack)

        expect(
          tree.text.get("slack/channels/C0123ABCD/2026-01-01-thread.md"),
        ).toBe("# A thread\n")
        expect(tree.modes.get("slack/channels/C0123ABCD/latest.md")).toBe(
          "120000",
        )
        expect(tree.text.get("slack/channels/C0123ABCD/latest.md")).toBe(
          "2026-01-01-thread.md",
        )
        expect(
          tree.text.get("pagerduty/services/PSVC1/incidents/42--PINC1.md"),
        ).toContain("# Incident 42")
        expect(
          tree.modes.get(
            "pagerduty/services/PSVC1/incidents/42--PINC1/runbook.sh",
          ),
        ).toBe("100755")
        for (const old of [
          "slack/channels/general--C0123ABCD/2026-01-01-thread.md",
          "slack/channels/general--C0123ABCD/latest.md",
          "pagerduty/incidents/42--PINC1.md",
          "pagerduty/incidents/42--PINC1/runbook.sh",
        ])
          expect(tree.paths).not.toContain(old)

        // Item 5: the newer file wins, and the old file stays.
        expect(
          tree.text.get("slack/channels/C0123ABCD/2026-01-02-thread.md"),
        ).toBe("# Newer copy\n")
        expect(
          tree.text.get(
            "slack/channels/general--C0123ABCD/2026-01-02-thread.md",
          ),
        ).toBe(
          base.text.get(
            "slack/channels/general--C0123ABCD/2026-01-02-thread.md",
          ),
        )
        expect(report).toContain(
          "Not moved: `slack/channels/general--C0123ABCD/2026-01-02-thread.md`. The tree already has `slack/channels/C0123ABCD/2026-01-02-thread.md`, so the old file stays. Compare the two files, then delete the old file.",
        )
        expect(report).toContain(
          "Moved 4 old connector file(s) to the paths that their sources manage. Git keeps their history.",
        )

        // The base64 compare finds no change on a second plan.
        const rerun = await runStep(f, hooks, result.pack)
        expect(rerun.steps[0]?.sha).toBeNull()
      },
    ),
)
