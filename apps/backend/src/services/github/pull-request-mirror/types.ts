export const GITHUB_PR_FILE_STATUSES = [
  "added",
  "modified",
  "removed",
  "renamed",
  "copied",
  "changed",
] as const

export type GithubPrFileStatus = (typeof GITHUB_PR_FILE_STATUSES)[number]

export type GithubPrActor = {
  login: string
  type: "human" | "bot"
}

export type GithubPrFileChange = {
  path: string
  status: GithubPrFileStatus
  previousPath?: string
}

export type GithubPrReview = {
  id: number
  author: GithubPrActor
  state: string
  body: string
  submittedAt: string | null
}

export type GithubPrComment = {
  id: number
  kind: "conversation" | "review"
  author: GithubPrActor
  body: string
  createdAt: string
  path?: string
  line?: number | null
}

export type GithubPrRequiredCheck = {
  name: string
  conclusion: string | null
}

export type GithubPullRequestSnapshot = {
  id: number
  number: number
  repository: string
  url: string
  title: string
  body: string
  state: "open" | "closed"
  merged: boolean
  draft: boolean
  author: GithubPrActor
  base: { ref: string; sha: string }
  head: { ref: string; sha: string }
  reviewDecision: string | null
  labels: string[]
  requestedReviewers: string[]
  createdAt: string
  updatedAt: string
  mergedAt: string | null
  files: GithubPrFileChange[]
  reviews: GithubPrReview[]
  comments: GithubPrComment[]
  requiredChecks: GithubPrRequiredCheck[]
}

export type GithubPrMirrorFile = {
  path: string
  content: string
}
