import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { Octokit } from "octokit"
import { z } from "zod"

import { runGit } from "../../src/domain/ingestion/run-git.js"
import { githubSourcePath } from "../../src/domain/workspace-sources/source-file.js"
import { stampMirrorFiles } from "../../src/domain/workspace-sources/stamp-sources.js"
import { gitRemoteEnvironment } from "../../src/services/git/clone-tree.js"
import { importPublicGithubIssues } from "../../src/services/github/issue-mirror/public-import.js"
import type { Corpus } from "./dataset.js"

/*
 * The public corpora of ADR-069 decision 2. A plan names the slice of each
 * source: the public repositories at fixed SHAs and the issue cut-off date.
 * The steps:
 *
 * 1. `snapshot`: copy the tree of each repository at its SHA into a private
 *    snapshot repository, as one commit with no history and no personal
 *    data. The product ingests the snapshot, so the ingest reads a fixed SHA.
 * 2. `issues`: write the issue mirror files of each repository into the
 *    context repo of the corpus, with the production converter.
 * 3. `freeze`: after the ingest, write the SHA of each context repo into
 *    the dataset.
 */

const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/)

/** The name of the private snapshot repository of a source. */
function repositoryName(prefix: string, corpus: string, source: string) {
  return `${prefix}${corpus}-${source.split("/")[1]?.toLowerCase()}`
}

export const planSchema = z
  .strictObject({
    version: z.string().min(1),
    /** The issue cut-off date. The snapshot commits also carry this date. */
    cutoff: z.iso.datetime({ offset: true }),
    /** The GitHub org of the snapshot repositories and the context repos. */
    owner: z.string().regex(/^[A-Za-z0-9-]+$/),
    /** The name prefix of each repository that the plan makes. */
    prefix: z.string().regex(/^[a-z0-9-]+$/),
    corpora: z
      .array(
        z.strictObject({
          id,
          /** The id of the Workspace fixture that holds the context repo. */
          workspace: id,
          repositories: z
            .array(
              z.strictObject({
                /** The public repository, `owner/name`. */
                source: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
                sha: z.string().regex(/^[0-9a-f]{40}$/),
                /** The count of the newest issues before the cut-off date. */
                issues: z.number().int().min(0),
              }),
            )
            .min(1),
        }),
      )
      .min(1),
  })
  .superRefine((plan, context) => {
    // Each repository that the plan makes has its own name.
    const names = plan.corpora.flatMap((corpus) => [
      `${plan.prefix}${corpus.id}-context`,
      ...corpus.repositories.map((repository) =>
        repositoryName(plan.prefix, corpus.id, repository.source),
      ),
    ])
    for (const name of new Set(names))
      if (names.filter((other) => other === name).length > 1)
        context.addIssue({
          code: "custom",
          message: `Two repositories of the plan are named ${name}.`,
        })
  })

export type Plan = z.infer<typeof planSchema>
type PlanCorpus = Plan["corpora"][number]
type PlanRepository = PlanCorpus["repositories"][number]

/** Where the repositories are. Tests give a `file://` base. */
export type GithubAccess = {
  octokit: Octokit
  /** Pushes to the snapshot and context repos. Never printed. */
  token?: string
  gitBase: string
}

function snapshotName(
  plan: Plan,
  corpus: PlanCorpus,
  repository: PlanRepository,
): string {
  return repositoryName(plan.prefix, corpus.id, repository.source)
}

function contextName(plan: Plan, corpus: PlanCorpus): string {
  return `${plan.prefix}${corpus.id}-context`
}

function remote(access: GithubAccess, fullName: string) {
  const url = `${access.gitBase}/${fullName}.git`
  const token = url.startsWith("https://") ? access.token : undefined
  return { url, env: gitRemoteEnvironment({ url, token }) }
}

/** A fixed author, so that a commit holds no personal data. */
function author(date: string): NodeJS.ProcessEnv {
  return {
    GIT_AUTHOR_NAME: "ctxpipe evals",
    GIT_AUTHOR_EMAIL: "evals@ctxpipe.invalid",
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: "ctxpipe evals",
    GIT_COMMITTER_EMAIL: "evals@ctxpipe.invalid",
    GIT_COMMITTER_DATE: date,
  }
}

async function git(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  input?: string,
): Promise<string> {
  const out = await runGit(cwd, ["-c", "commit.gpgsign=false", ...args], {
    cleanEnv: env,
    input,
  })
  return out.toString("utf8").trim()
}

/** The refs of a remote, from ref name to SHA. */
async function remoteRefs(
  cwd: string,
  target: ReturnType<typeof remote>,
): Promise<Map<string, string>> {
  const out = await git(cwd, ["ls-remote", target.url], target.env)
  return new Map(
    out
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [sha = "", ref = ""] = line.split("\t")
        return [ref, sha] as const
      }),
  )
}

/**
 * Make the private repository when it is not there, and turn GitHub Actions
 * off in it. A snapshot holds the tree of another project, so no workflow
 * of that project may run in our org.
 */
async function ensureSnapshotRepository(
  access: GithubAccess,
  owner: string,
  name: string,
): Promise<void> {
  try {
    const { data } = await access.octokit.rest.repos.get({ owner, repo: name })
    if (!data.private)
      throw new Error(`${owner}/${name} is not private. Use a new prefix.`)
  } catch (error) {
    if ((error as { status?: number }).status !== 404) throw error
    await access.octokit.rest.repos.createInOrg({
      org: owner,
      name,
      private: true,
    })
  }
  await access.octokit.rest.actions.setGithubActionsPermissionsRepository({
    owner,
    repo: name,
    enabled: false,
  })
  const { data } =
    await access.octokit.rest.actions.getGithubActionsPermissionsRepository({
      owner,
      repo: name,
    })
  if (data.enabled)
    throw new Error(`GitHub Actions are still on in ${owner}/${name}.`)
}

export type Snapshot = {
  corpus: string
  source: string
  sha: string
  repository: string
  snapshotSha: string
}

/**
 * Push the tree of each repository at its SHA to its private snapshot
 * repository, as one commit with no history. The tree leaves out
 * `.github/workflows`. The commit is the same for the same plan, so a second
 * run pushes nothing. A snapshot repository with any other branch, tag or
 * commit is refused.
 */
export async function snapshotRepositories(
  plan: Plan,
  access: GithubAccess,
  log: (line: string) => void,
): Promise<Snapshot[]> {
  const snapshots: Snapshot[] = []
  for (const corpus of plan.corpora)
    for (const repository of corpus.repositories) {
      const name = snapshotName(plan, corpus, repository)
      await ensureSnapshotRepository(access, plan.owner, name)
      const work = await mkdtemp(join(tmpdir(), "eval-snapshot-"))
      try {
        // The local steps use no remote.
        const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" }
        await git(work, ["init", "-q"], env)
        const source = remote(access, repository.source)
        // The public repository is read with no token.
        await git(
          work,
          [
            "fetch",
            "-q",
            "--depth",
            "1",
            "--no-tags",
            source.url,
            repository.sha,
          ],
          gitRemoteEnvironment({ url: source.url }),
        )
        await git(work, ["read-tree", repository.sha], env)
        await git(
          work,
          [
            "rm",
            "-r",
            "-q",
            "--cached",
            "--ignore-unmatch",
            ".github/workflows",
          ],
          env,
        )
        const tree = await git(work, ["write-tree"], env)
        const commit = await git(
          work,
          [
            "commit-tree",
            tree,
            "-m",
            `${repository.source} at ${repository.sha}`,
          ],
          { ...env, ...author(plan.cutoff) },
        )
        const target = remote(access, `${plan.owner}/${name}`)
        const refs = await remoteRefs(work, target)
        const other = [...refs].find(
          ([ref, sha]) =>
            !((ref === "refs/heads/main" || ref === "HEAD") && sha === commit),
        )
        if (other)
          throw new Error(
            `${plan.owner}/${name} holds another snapshot (${other[0]}). Use a new prefix.`,
          )
        if (!refs.has("refs/heads/main"))
          await git(
            work,
            ["push", "-q", target.url, `${commit}:refs/heads/main`],
            target.env,
          )
        log(
          `${repository.source}@${repository.sha} -> ${plan.owner}/${name}@${commit}`,
        )
        snapshots.push({
          corpus: corpus.id,
          source: repository.source,
          sha: repository.sha,
          repository: `${plan.owner}/${name}`,
          snapshotSha: commit,
        })
      } finally {
        await rm(work, { recursive: true, force: true })
      }
    }
  return snapshots
}

/**
 * Write the issue mirror files of each repository of each corpus into its
 * context repo, and push one commit. The files are as the production issue
 * mirror writes them for the snapshot repository: the converter output, with
 * the source file of the snapshot repository in `sources`. The product makes
 * the context repo when it makes the Workspace, so it must be there. The
 * commit is made with git plumbing in a bare clone, so no path of the
 * context repo is written to the disk.
 */
export async function importCorpusIssues(
  plan: Plan,
  access: GithubAccess,
  log: (line: string) => void,
): Promise<Array<{ corpus: string; source: string; issues: number }>> {
  const counts: Array<{ corpus: string; source: string; issues: number }> = []
  for (const corpus of plan.corpora) {
    const repositories = corpus.repositories.filter((r) => r.issues > 0)
    if (repositories.length === 0) continue
    const target = remote(access, `${plan.owner}/${contextName(plan, corpus)}`)
    const work = await mkdtemp(join(tmpdir(), "eval-issues-"))
    try {
      const env = { ...target.env, GIT_INDEX_FILE: join(work, "index") }
      await git(work, ["init", "-q", "--bare"], env)
      await git(
        work,
        ["fetch", "-q", "--depth", "1", target.url, "refs/heads/main"],
        env,
      )
      const parent = await git(work, ["rev-parse", "FETCH_HEAD"], env)
      await git(work, ["read-tree", parent], env)
      const entries: string[] = []
      for (const repository of repositories) {
        const sourcePath = githubSourcePath(
          plan.owner,
          snapshotName(plan, corpus, repository),
        )
        let count = 0
        for await (const file of importPublicGithubIssues({
          octokit: access.octokit,
          repository: repository.source,
          until: new Date(plan.cutoff),
          limit: repository.issues,
        })) {
          for (const stamped of stampMirrorFiles([file], sourcePath, [])) {
            const blob = await git(
              work,
              ["hash-object", "-w", "--stdin"],
              env,
              stamped.content,
            )
            entries.push(`100644 blob ${blob}\t${stamped.path}`)
          }
          count += 1
        }
        log(`${repository.source}: ${count} issues`)
        counts.push({
          corpus: corpus.id,
          source: repository.source,
          issues: count,
        })
      }
      if (entries.length === 0) continue
      await git(
        work,
        ["update-index", "--index-info"],
        env,
        `${entries.join("\n")}\n`,
      )
      const tree = await git(work, ["write-tree"], env)
      if (tree === (await git(work, ["rev-parse", `${parent}^{tree}`], env)))
        continue
      const commit = await git(
        work,
        [
          "commit-tree",
          tree,
          "-p",
          parent,
          "-m",
          `Mirror the issues up to ${plan.cutoff}`,
        ],
        { ...env, ...author(new Date().toISOString()) },
      )
      await git(
        work,
        ["push", "-q", target.url, `${commit}:refs/heads/main`],
        env,
      )
    } finally {
      await rm(work, { recursive: true, force: true })
    }
  }
  return counts
}

const datasetDraftSchema = z.looseObject({
  corpora: z.array(z.looseObject({ id: z.string() })).optional(),
})

/**
 * Write the frozen corpora into `datasetFile`: for each corpus of the plan,
 * the SHA that the main branch of its context repo has now. The other
 * corpora and the questions of the file stay. With no file, the result is a
 * draft with no questions, which the drafting step fills.
 */
export async function freezeCorpora(
  plan: Plan,
  access: GithubAccess,
  datasetFile: string,
): Promise<void> {
  const frozen: Corpus[] = []
  for (const corpus of plan.corpora) {
    const fullName = `${plan.owner}/${contextName(plan, corpus)}`
    const sha = (await remoteRefs(tmpdir(), remote(access, fullName))).get(
      "refs/heads/main",
    )
    if (!sha) throw new Error(`${fullName} has no main branch.`)
    frozen.push({
      id: corpus.id,
      source: corpus.repositories
        .map((repository) => `${repository.source}@${repository.sha}`)
        .join(", "),
      contextRepo: { url: `https://github.com/${fullName}`, sha },
      workspace: corpus.workspace,
    })
  }
  const existing = await readFile(datasetFile, "utf8").then(
    (text) => datasetDraftSchema.parse(JSON.parse(text)),
    () => datasetDraftSchema.parse({ version: plan.version, questions: [] }),
  )
  const ids = new Set(frozen.map((corpus) => corpus.id))
  const corpora = [
    ...(existing.corpora ?? []).filter((corpus) => !ids.has(corpus.id)),
    ...frozen,
  ]
  await writeFile(
    datasetFile,
    `${JSON.stringify({ ...existing, corpora }, null, 2)}\n`,
  )
}
