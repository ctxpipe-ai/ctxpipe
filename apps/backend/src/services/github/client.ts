import { z } from "zod"

const GitHubFileChangeSchema = z.object({
  path: z.string(),
  content: z.string(),
})

const GitHubTreeItemSchema = z.object({
  path: z.string(),
  mode: z.string(),
  type: z.string(),
  content: z.string(),
})

export type FileChange = z.infer<typeof GitHubFileChangeSchema>

export interface GitHubClientConfig {
  token: string
  owner: string
  repo: string
}

export interface CreatePROptions {
  title: string
  body: string
  head: string
  base: string
}

export interface CreatePRResult {
  number: number
  url: string
}

export class GitHubClient {
  private token: string
  private owner: string
  private repo: string
  private baseUrl = "https://api.github.com"

  constructor(config: GitHubClientConfig) {
    this.token = config.token
    this.owner = config.owner
    this.repo = config.repo
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {},
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`
    const response = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        ...options.headers,
      },
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(
        `GitHub API error: ${response.status} ${response.statusText} - ${error}`,
      )
    }

    return response.json() as Promise<T>
  }

  async getDefaultBranch(): Promise<string> {
    const data = await this.request<{ default_branch: string }>(
      `/repos/${this.owner}/${this.repo}`,
    )
    return data.default_branch
  }

  async getBranchRef(branch: string): Promise<string> {
    const data = await this.request<{ object: { sha: string } }>(
      `/repos/${this.owner}/${this.repo}/git/refs/heads/${branch}`,
    )
    return data.object.sha
  }

  async createBranch(branchName: string, fromSha: string): Promise<void> {
    await this.request(`/repos/${this.owner}/${this.repo}/git/refs`, {
      method: "POST",
      body: JSON.stringify({
        ref: `refs/heads/${branchName}`,
        sha: fromSha,
      }),
    })
  }

  async createBlob(content: string): Promise<string> {
    const data = await this.request<{ sha: string }>(
      `/repos/${this.owner}/${this.repo}/git/blobs`,
      {
        method: "POST",
        body: JSON.stringify({
          content,
          encoding: "utf-8",
        }),
      },
    )
    return data.sha
  }

  async createTree(
    baseTreeSha: string,
    files: FileChange[],
    deletions: string[] = [],
  ): Promise<string> {
    const tree = [
      ...files.map((file) => ({
        path: file.path,
        mode: "100644" as const,
        type: "blob" as const,
        content: file.content,
      })),
      // sha: null removes the file from the tree
      ...deletions.map((path) => ({
        path,
        mode: "100644" as const,
        type: "blob" as const,
        sha: null,
      })),
    ]

    const data = await this.request<{ sha: string }>(
      `/repos/${this.owner}/${this.repo}/git/trees`,
      {
        method: "POST",
        body: JSON.stringify({
          base_tree: baseTreeSha,
          tree,
        }),
      },
    )
    return data.sha
  }

  /** Returns all blob paths under the given path prefix on the given branch. */
  async listFilesInTree(branch: string, prefix: string): Promise<string[]> {
    try {
      const sha = await this.getBranchRef(branch)
      const data = await this.request<{
        tree: Array<{ path: string; type: string }>
        truncated: boolean
      }>(`/repos/${this.owner}/${this.repo}/git/trees/${sha}?recursive=1`)

      if (data.truncated) {
        console.warn("[github] tree response truncated — large repo, some deletions may be missed")
      }

      return data.tree
        .filter((item) => item.type === "blob" && item.path.startsWith(prefix))
        .map((item) => item.path)
    } catch (err) {
      console.warn(`[github] listFilesInTree failed (branch=${branch}, prefix=${prefix}):`, err)
      return []
    }
  }

  async createCommit(
    message: string,
    treeSha: string,
    parentSha: string,
  ): Promise<string> {
    const data = await this.request<{ sha: string }>(
      `/repos/${this.owner}/${this.repo}/git/commits`,
      {
        method: "POST",
        body: JSON.stringify({
          message,
          tree: treeSha,
          parents: [parentSha],
        }),
      },
    )
    return data.sha
  }

  async updateBranchRef(branch: string, commitSha: string): Promise<void> {
    await this.request(
      `/repos/${this.owner}/${this.repo}/git/refs/heads/${branch}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          sha: commitSha,
        }),
      },
    )
  }

  async createPullRequest(options: CreatePROptions): Promise<CreatePRResult> {
    const data = await this.request<{ number: number; html_url: string }>(
      `/repos/${this.owner}/${this.repo}/pulls`,
      {
        method: "POST",
        body: JSON.stringify({
          title: options.title,
          body: options.body,
          head: options.head,
          base: options.base,
        }),
      },
    )

    return {
      number: data.number,
      url: data.html_url,
    }
  }

  async commitFiles(
    branch: string,
    message: string,
    files: FileChange[],
    deletions: string[] = [],
  ): Promise<void> {
    const baseRef = await this.getBranchRef(branch)
    const treeSha = await this.createTree(baseRef, files, deletions)
    const commitSha = await this.createCommit(message, treeSha, baseRef)
    await this.updateBranchRef(branch, commitSha)
  }

  async getFileContent(path: string): Promise<string> {
    const data = await this.request<{ content: string; encoding: string }>(
      `/repos/${this.owner}/${this.repo}/contents/${path}`,
    )
    if (data.encoding !== "base64") {
      throw new Error(`Unexpected encoding: ${data.encoding}`)
    }
    return Buffer.from(data.content.replace(/\n/g, ""), "base64").toString(
      "utf-8",
    )
  }

  async isRepoEmpty(): Promise<boolean> {
    try {
      await this.request(`/repos/${this.owner}/${this.repo}/git/refs`)
      return false
    } catch {
      return true
    }
  }

  async createEmptyRootCommit(branch: string): Promise<string> {
    const treeData = await this.request<{ sha: string }>(
      `/repos/${this.owner}/${this.repo}/git/trees`,
      {
        method: "POST",
        body: JSON.stringify({ tree: [] }),
      },
    )

    const commitData = await this.request<{ sha: string }>(
      `/repos/${this.owner}/${this.repo}/git/commits`,
      {
        method: "POST",
        body: JSON.stringify({
          message: "chore: initialise repository",
          tree: treeData.sha,
          parents: [],
        }),
      },
    )

    await this.request(`/repos/${this.owner}/${this.repo}/git/refs`, {
      method: "POST",
      body: JSON.stringify({
        ref: `refs/heads/${branch}`,
        sha: commitData.sha,
      }),
    })

    return commitData.sha
  }

  async createPullRequestWithFiles(
    options: Omit<CreatePROptions, "head"> & {
      files: FileChange[]
      branchName: string
    },
  ): Promise<CreatePRResult> {
    const { files, branchName, ...prOptions } = options

    const baseBranch = prOptions.base || (await this.getDefaultBranch())

    const empty = await this.isRepoEmpty()
    if (empty) {
      // Seed an empty root commit on the base branch so a PR can be opened
      // against it. The PR branch then carries all the Confluence content.
      await this.createEmptyRootCommit(baseBranch)
    }

    const baseSha = await this.getBranchRef(baseBranch)
    await this.createBranch(branchName, baseSha)
    await this.commitFiles(branchName, prOptions.title, files)

    return this.createPullRequest({
      ...prOptions,
      head: branchName,
      base: baseBranch,
    })
  }
}
