import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve, sep } from "node:path"

import type { Octokit } from "octokit"
import { z } from "zod"

import { runGit } from "../../src/domain/ingestion/run-git.js"
import { renderSourceFile } from "../../src/domain/workspace-sources/source-file-text.js"
import { gitSourcePath } from "../../src/domain/workspace-sources/source-file.js"
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
 * Each corpus has one context repo, and no copy of the public repositories
 * (CTX-1661). The steps:
 *
 * 1. `sources`: write one plain git source file for each repository into
 *    the context repo. The file names the public URL and pins the SHA, so
 *    the product ingests the public repository at that SHA.
 * 2. `issues`: write the issue and pull request mirror files of each
 *    repository into the context repo of the corpus, with the production
 *    converters, and the public chat of the corpus (`zulip-chat.ts`).
 * 3. `freeze`: after the ingest, write the SHA of each context repo into
 *    the dataset.
 */

const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/)

/** The name of the private context repo of a corpus. */
function contextName(prefix: string, corpus: string) {
  return `${prefix}${corpus}-context`
}

/** The public URL of a repository of a plan, `owner/name`. */
function publicUrl(source: string) {
  return `https://github.com/${source}`
}

/** The path of the plain git source file of a repository of a plan. */
function sourcePath(source: string): string {
  const path = gitSourcePath(publicUrl(source))
  if (!path) throw new Error(`${source} gives no plain git URL.`)
  return path
}

export const planSchema = z
  .strictObject({
    version: z.string().min(1),
    /** The issue cut-off date. */
    cutoff: z.iso.datetime({ offset: true }),
    /** The GitHub org of the context repos. */
    owner: z.string().regex(/^[A-Za-z0-9-]+$/),
    /** The name prefix of each context repo. */
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
    // Each context repo and each source file of a corpus has its own name.
    const unique = (names: string[], what: string) => {
      for (const name of new Set(names))
        if (names.filter((other) => other === name).length > 1)
          context.addIssue({
            code: "custom",
            message: `Two ${what} of the plan are named ${name}.`,
          })
    }
    unique(
      plan.corpora.map((corpus) => contextName(plan.prefix, corpus.id)),
      "context repos",
    )
    for (const corpus of plan.corpora)
      unique(
        corpus.repositories.map((repository) => sourcePath(repository.source)),
        "source files",
      )
  })

export type Plan = z.infer<typeof planSchema>

/** Where the repositories are. Tests give a `file://` base. */
export type GithubAccess = {
  octokit: Octokit
  /** Pushes to the context repos. Never printed. */
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

/** The main branch SHA of the context repo of a corpus. */
type CorpusContext = { corpus: string; sha: string }

/**
 * Write one plain git source file for each repository of each corpus into
 * the context repo of the corpus, in one commit. The file names the public
 * URL and pins the SHA of the plan (ADR-050, revision 2026-11-26), so the
 * product reads the public repository at that SHA with no credential and
 * no copy. A repository that is not public is refused. A second run with
 * the same plan pushes nothing. Returns the main branch SHA of each context
 * repo after the step.
 */
export async function writeCorpusSources(
  plan: Plan,
  access: GithubAccess,
  log: (line: string) => void,
): Promise<CorpusContext[]> {
  const contexts: CorpusContext[] = []
  for (const corpus of plan.corpora) {
    const files: ChatFile[] = []
    for (const repository of corpus.repositories) {
      const [owner = "", repo = ""] = repository.source.split("/")
      const { data: upstream } = await access.octokit.rest.repos.get({
        owner,
        repo,
      })
      if (upstream.private || upstream.visibility !== "public")
        throw new Error(`${repository.source} is not a public repository`)
      const path = sourcePath(repository.source)
      files.push({
        path,
        content: renderSourceFile(
          {
            path,
            provider: "git",
            connectionId: null,
            scope: {
              url: publicUrl(repository.source),
              commit: repository.sha,
            },
          },
          `The public repository ${repository.source} at ${repository.sha}, its last commit up to ${plan.cutoff}.\n`,
        ),
      })
      log(`${repository.source}@${repository.sha} -> ${path}`)
    }
    const sha = await commitToContext(
      plan,
      access,
      corpus.id,
      files,
      `Add the public repositories at ${plan.cutoff} as pinned sources`,
    )
    contexts.push({ corpus: corpus.id, sha })
  }
  return contexts
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
 * production mirrors write them (the converter output, with the plain git
 * source file of the repository in `sources`),
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
      const stamp = sourcePath(repository.source)
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
          github.push(...stampMirrorFiles([file], stamp, []))
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
    if (files.length > 0)
      await commitToContext(
        plan,
        access,
        corpus.id,
        files,
        `Mirror the issues, pull requests and chat up to ${plan.cutoff}`,
      )
  }
  return { repositories: counts, chat: manifests }
}

/**
 * Add `files` to the main branch of the context repo of `corpus` in one
 * commit, and return the SHA of the main branch. When the files change
 * nothing, it pushes nothing.
 */
async function commitToContext(
  plan: Plan,
  access: GithubAccess,
  corpus: string,
  files: ChatFile[],
  message: string,
): Promise<string> {
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
      return parent
    const commit = await git(
      work,
      ["commit-tree", tree, "-p", parent, "-m", message],
      { ...env, ...author(new Date().toISOString()) },
    )
    await git(
      work,
      ["push", "-q", target.url, `${commit}:refs/heads/main`],
      env,
    )
    return commit
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
