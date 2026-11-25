import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve, sep } from "node:path"

import type { Octokit } from "octokit"
import { z } from "zod"

import { runGit } from "../../src/domain/ingestion/run-git.js"
import { githubSourcePath } from "../../src/domain/workspace-sources/source-file.js"
import { stampMirrorFiles } from "../../src/domain/workspace-sources/stamp-sources.js"
import { gitRemoteEnvironment } from "../../src/services/git/clone-tree.js"
import { bodiesEditedAfter } from "../../src/services/github/github-mirror.js"
import { importPublicGithubIssues } from "../../src/services/github/issue-mirror/public-import.js"
import {
  countOpenPullRequestsAt,
  importPublicGithubPullRequests,
} from "../../src/services/github/pull-request-mirror/public-import.js"
import type { Corpus } from "./dataset.js"
import { Pseudonyms } from "./pseudonyms.js"
import {
  type ChatFile,
  type ChatManifest,
  readZulipChat,
  renderZulipChat,
  zulipChatSchema,
} from "./zulip-chat.js"

/*
 * The public corpora of ADR-069 decision 2. A plan names the slice of each
 * source: the public repositories at fixed SHAs and the issue cut-off date.
 * The steps:
 *
 * 1. `snapshot`: copy the tree of each repository at its SHA into a private
 *    snapshot repository, as one commit with no history and no personal
 *    data. The product ingests the snapshot, so the ingest reads a fixed SHA.
 * 2. `issues`: write the issue and pull request mirror files of each
 *    repository into the context repo of the corpus, with the production
 *    converters, and the public chat of the corpus (`zulip-chat.ts`).
 * 3. `freeze`: after the ingest, write the SHA of each context repo into
 *    the dataset.
 */

const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/)

/** The name of the private snapshot repository of a source. */
function snapshotName(prefix: string, corpus: string, source: string) {
  return `${prefix}${corpus}-${source.split("/")[1]?.toLowerCase()}`
}

/** The name of the private context repo of a corpus. */
function contextName(prefix: string, corpus: string) {
  return `${prefix}${corpus}-context`
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
                /**
                 * The count of the newest pull requests that are closed
                 * before the cut-off date (CTX-1661).
                 */
                pulls: z.number().int().min(0).default(0),
              }),
            )
            .min(1),
          /** The public chat up to the cut-off date (CTX-1661). */
          chat: zulipChatSchema.optional(),
        }),
      )
      .min(1),
  })
  .superRefine((plan, context) => {
    // Each repository that the plan makes has its own name.
    const names = plan.corpora.flatMap((corpus) => [
      contextName(plan.prefix, corpus.id),
      ...corpus.repositories.map((repository) =>
        snapshotName(plan.prefix, corpus.id, repository.source),
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

/** Where the repositories are. Tests give a `file://` base. */
export type GithubAccess = {
  octokit: Octokit
  /** Pushes to the snapshot and context repos. Never printed. */
  token?: string
  gitBase: string
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
 * repository, as one commit with no history. The tree leaves out the
 * workflows and the Dependabot and Renovate configs. The commit is the same for the same plan, so a second
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
      const name = snapshotName(plan.prefix, corpus.id, repository.source)
      const [owner = "", repo = ""] = repository.source.split("/")
      const { data: upstream } = await access.octokit.rest.repos.get({
        owner,
        repo,
      })
      if (upstream.private || upstream.visibility !== "public")
        throw new Error(`${repository.source} is not a public repository`)
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
            "--",
            // The files that make GitHub or a bot act on a repository.
            ".github/workflows",
            ".github/dependabot.yml",
            ".github/dependabot.yaml",
            ".github/renovate.json",
            ".github/renovate.json5",
            "renovate.json",
            "renovate.json5",
            ".renovaterc",
            ".renovaterc.json",
            ".renovaterc.json5",
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

/** What the `issues` step wrote for one repository. */
type MirrorCount = {
  corpus: string
  source: string
  issues: number
  pulls: number
  /**
   * The pull requests that were open at the cut-off date. The production
   * mirror shows only closed ones, so the twin leaves them out.
   */
  openAtCutoff: number
  /**
   * The issues and pull requests whose body was edited after the cut-off
   * date. Their file shows the current body, so a task must not take its
   * answer from them.
   */
  editedAfterCutoff: number[]
}

/**
 * Write the mirror files of each corpus into its context repo, and push one
 * commit: the issue and pull request files of each repository, as the
 * production mirrors write them for the snapshot repository (the converter
 * output, with the source file of the snapshot repository in `sources`),
 * and the chat files of the corpus. Each person of a corpus gets one
 * pseudonym for each account (`pseudonyms.ts`), and the text of each file
 * loses the known names and logins. The product makes the context repo
 * when it makes the Workspace, so it must be there. The commit is made with
 * git plumbing in a bare clone, so no path of the context repo is written
 * to the disk.
 */
export async function importCorpusMirrors(
  plan: Plan,
  access: GithubAccess,
  log: (line: string) => void,
): Promise<{ repositories: MirrorCount[]; chat: ChatManifest[] }> {
  const counts: MirrorCount[] = []
  const manifests: ChatManifest[] = []
  const until = new Date(plan.cutoff)
  // The accounts of the orgs are not people, and their names are in paths.
  const orgs = new Set(
    [
      plan.owner,
      ...plan.corpora.flatMap((corpus) =>
        corpus.repositories.map(
          (repository) => repository.source.split("/")[0],
        ),
      ),
    ].map((name) => name?.toLowerCase()),
  )
  for (const corpus of plan.corpora) {
    const repositories = corpus.repositories.filter(
      (r) => r.issues > 0 || r.pulls > 0,
    )
    if (repositories.length === 0 && !corpus.chat) continue
    const people = new Pseudonyms()
    const alias = (login: string) =>
      orgs.has(login.toLowerCase())
        ? login
        : people.add(`github:${login.toLowerCase()}`, [login])
    const github: ChatFile[] = []
    for (const repository of repositories) {
      const sourcePath = githubSourcePath(
        plan.owner,
        snapshotName(plan.prefix, corpus.id, repository.source),
      )
      const read = { octokit: access.octokit, repository: repository.source }
      const kinds = {
        issues:
          repository.issues > 0
            ? importPublicGithubIssues({
                ...read,
                until,
                limit: repository.issues,
                alias,
              })
            : [],
        pulls:
          repository.pulls > 0
            ? importPublicGithubPullRequests({
                ...read,
                until,
                limit: repository.pulls,
                alias,
              })
            : [],
      }
      const numbers: number[] = []
      const count = { issues: 0, pulls: 0 }
      for (const [kind, files] of Object.entries(kinds) as Array<
        [keyof typeof kinds, (typeof kinds)[keyof typeof kinds]]
      >)
        for await (const file of files) {
          github.push(...stampMirrorFiles([file], sourcePath, []))
          numbers.push(file.number)
          count[kind] += 1
        }
      const editedAfterCutoff = await bodiesEditedAfter({
        ...read,
        numbers,
        until,
      })
      const openAtCutoff =
        repository.pulls > 0
          ? await countOpenPullRequestsAt({ ...read, until })
          : 0
      log(
        `${repository.source}: ${count.issues} issues, ${count.pulls} pull requests (${openAtCutoff} open at the cut-off date left out), ${editedAfterCutoff.length} edited after the cut-off date`,
      )
      counts.push({
        corpus: corpus.id,
        source: repository.source,
        ...count,
        openAtCutoff,
        editedAfterCutoff,
      })
    }
    // The chat comes after the GitHub files, so that its text loses the
    // logins too; then the GitHub files lose the names of the chat.
    const chat = corpus.chat
      ? await corpusChat(corpus.chat, until, people, log)
      : null
    const files = [
      ...github.map((file) => ({
        ...file,
        content: people.scrub(file.content),
      })),
      ...(chat?.files ?? []),
    ]
    if (chat) manifests.push(chat.manifest)
    if (files.length > 0) await commitToContext(plan, access, corpus.id, files)
  }
  return { repositories: counts, chat: manifests }
}

/** Add `files` to the main branch of the context repo of `corpus` in one commit. */
async function commitToContext(
  plan: Plan,
  access: GithubAccess,
  corpus: string,
  files: ChatFile[],
): Promise<void> {
  const target = remote(
    access,
    `${plan.owner}/${contextName(plan.prefix, corpus)}`,
  )
  const work = await mkdtemp(join(tmpdir(), "eval-mirrors-"))
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
    for (const file of files) {
      const blob = await git(
        work,
        ["hash-object", "-w", "--stdin"],
        env,
        file.content,
      )
      entries.push(`100644 blob ${blob}\t${file.path}`)
    }
    // NUL ends each entry, so no path can add another entry.
    await git(
      work,
      ["update-index", "-z", "--index-info"],
      env,
      `${entries.join("\0")}\0`,
    )
    const tree = await git(work, ["write-tree"], env)
    if (tree === (await git(work, ["rev-parse", `${parent}^{tree}`], env)))
      return
    const commit = await git(
      work,
      [
        "commit-tree",
        tree,
        "-p",
        parent,
        "-m",
        `Mirror the issues, pull requests and chat up to ${plan.cutoff}`,
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

async function corpusChat(
  chat: NonNullable<Plan["corpora"][number]["chat"]>,
  until: Date,
  people: Pseudonyms,
  log: (line: string) => void,
): Promise<{ files: ChatFile[]; manifest: ChatManifest }> {
  const messages = await readZulipChat(chat, until, log)
  const result = renderZulipChat(chat, until, messages, people)
  log(
    `${chat.realm}: ${result.manifest.topics} topics, ${result.manifest.messages} messages`,
  )
  return result
}

/**
 * Write the chat files of each corpus to `<dir>/<corpus>/`, and the
 * manifest to `<dir>/<corpus>.chat.json`, with no GitHub step. The files
 * are the chat files that `importCorpusMirrors` writes into the context
 * repo, with no GitHub login to remove, so a pilot slice or a fork can use
 * them.
 */
export async function exportCorpusChat(
  plan: Plan,
  dir: string,
  log: (line: string) => void,
): Promise<ChatManifest[]> {
  const manifests: ChatManifest[] = []
  for (const corpus of plan.corpora) {
    if (!corpus.chat) continue
    const chat = await corpusChat(
      corpus.chat,
      new Date(plan.cutoff),
      new Pseudonyms(),
      log,
    )
    const root = resolve(dir, corpus.id)
    for (const file of chat.files) {
      const path = resolve(root, file.path)
      if (!path.startsWith(`${root}${sep}`))
        throw new Error(`${file.path} is not in ${root}.`)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, file.content)
    }
    await writeFile(
      join(dir, `${corpus.id}.chat.json`),
      `${JSON.stringify(chat.manifest, null, 2)}\n`,
    )
    manifests.push(chat.manifest)
  }
  return manifests
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
    const fullName = `${plan.owner}/${contextName(plan.prefix, corpus.id)}`
    const sha = (await remoteRefs(tmpdir(), remote(access, fullName))).get(
      "refs/heads/main",
    )
    if (!sha) throw new Error(`${fullName} has no main branch.`)
    frozen.push({
      id: corpus.id,
      source: corpus.repositories
        .map((repository) => `${repository.source}@${repository.sha}`)
        .join(", "),
      // The Workspace of the corpus has the whole context repo.
      contextRepo: { url: `https://github.com/${fullName}`, sha, root: "" },
      workspace: corpus.workspace,
    })
  }
  // Only a missing file gives a new draft; any other error stops.
  const text = await readFile(datasetFile, "utf8").catch((error: unknown) => {
    if ((error as { code?: string }).code !== "ENOENT") throw error
    return JSON.stringify({ version: plan.version, questions: [] })
  })
  const existing = datasetDraftSchema.parse(JSON.parse(text))
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
