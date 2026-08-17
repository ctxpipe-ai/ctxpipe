import {
  IconGitBranch,
  IconMessageCircle,
  IconRefresh,
} from "@tabler/icons-react"
import { Link } from "@tanstack/react-router"
import {
  getRepositoryIndexingStatus,
  type RepositoryIndexingStatus,
} from "@/features/repositories/types"

export type ChatAvailability =
  | "loading"
  | "no-repositories"
  | "indexing"
  | "ready"
  | "unavailable"

export function getChatAvailability(
  repositories:
    | Array<{
        indexReady?: boolean
        indexingStatus?: RepositoryIndexingStatus | null
      }>
    | undefined,
  isPending: boolean,
): ChatAvailability {
  if (isPending) return "loading"
  if (!repositories) return "ready"
  if (repositories.length === 0) return "no-repositories"
  if (
    repositories.some(
      (repository) => getRepositoryIndexingStatus(repository) === "ready",
    )
  ) {
    return "ready"
  }
  if (
    repositories.some((repository) => {
      const status = getRepositoryIndexingStatus(repository)
      return status === "queued" || status === "running"
    })
  ) {
    return "indexing"
  }
  return "unavailable"
}

export function ChatEmptyState(props: {
  availability: ChatAvailability
  orgSlug: string
  onPromptSelect: (prompt: string) => void
}) {
  const { availability, orgSlug, onPromptSelect } = props

  if (availability !== "ready") {
    const content = {
      loading: {
        title: "Checking your repositories…",
        description:
          "Chat becomes available as soon as there is indexed code to query.",
        icon: <IconRefresh aria-hidden className="h-6 w-6 animate-spin" />,
      },
      "no-repositories": {
        title: "Connect a repository to start chatting",
        description:
          "ctx| answers questions from the repositories in your knowledge graph.",
        icon: <IconGitBranch aria-hidden className="h-6 w-6" />,
      },
      indexing: {
        title: "Building your code context…",
        description:
          "Your repositories are still indexing. Chat will be ready when the first repository finishes.",
        icon: <span aria-hidden className="ctx-indexing-dot" />,
      },
      unavailable: {
        title: "No repository is ready to query",
        description:
          "Review repository status and retry any indexing jobs that need attention.",
        icon: <IconGitBranch aria-hidden className="h-6 w-6" />,
      },
    }[availability]

    return (
      <div className="text-center">
        <div className="ctx-node mx-auto mb-6 flex h-14 w-14 items-center justify-center text-muted-foreground">
          {content.icon}
        </div>
        <h2 className="text-xl font-medium tracking-tight text-foreground">
          {content.title}
        </h2>
        <p className="mx-auto mt-2 max-w-lg text-sm leading-relaxed text-muted-foreground">
          {content.description}
        </p>
        {availability !== "loading" ? (
          <Link
            to="/$orgSlug/repositories"
            params={{ orgSlug }}
            className="mt-4 inline-block text-sm text-teal-400 underline decoration-teal-400/40 underline-offset-4 hover:text-teal-300"
          >
            View repositories
          </Link>
        ) : null}
      </div>
    )
  }

  const prompts = [
    "How is authentication implemented across our repositories?",
    "What engineering standards are shared across our codebase?",
    "Where do our services handle errors differently?",
  ]

  return (
    <div className="text-center">
      <div className="ctx-node mx-auto mb-6 flex h-14 w-14 items-center justify-center">
        <IconMessageCircle
          aria-hidden
          className="h-6 w-6 text-muted-foreground"
        />
      </div>
      <h2 className="text-xl font-medium tracking-tight text-foreground">
        Ask across your codebase
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">
        Start with an example, or ask your own question.
      </p>
      <div className="mt-6 grid gap-2 text-left sm:grid-cols-3">
        {prompts.map((prompt) => (
          <button
            key={prompt}
            type="button"
            className="min-h-24 border border-border bg-card/35 p-3 text-left text-sm leading-relaxed text-zinc-300 transition-colors hover:border-teal-400/40 hover:bg-teal-400/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-400/70"
            onClick={() => onPromptSelect(prompt)}
          >
            {prompt}
          </button>
        ))}
      </div>
    </div>
  )
}
