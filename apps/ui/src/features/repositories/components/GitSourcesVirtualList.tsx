import { useWindowVirtualizer } from "@tanstack/react-virtual"
import { useLayoutEffect, useRef, useState } from "react"
import type { GitSourceListRow } from "../gitSourcesListRows"
import type { Repository } from "../types"
import { PendingGitSourceRow } from "./PendingGitSourceRow"
import { RepositoryCard } from "./RepositoryCard"

const ROW_SIZE_PX = 72
const OVERSCAN_IDLE = 10
const OVERSCAN_SCROLLING = 36

function documentOffsetTop(el: HTMLElement): number {
  return el.getBoundingClientRect().top + window.scrollY
}

export function GitSourcesVirtualList({
  rows,
  onDelete,
  onRetry,
  onIndexNow,
  retryingRepoId,
  isDeleting,
  isIndexing,
}: {
  rows: GitSourceListRow[]
  onDelete: (repo: Repository) => void
  onRetry: (repo: Repository) => void
  onIndexNow: (input: { name: string; gitUrl: string }) => void
  retryingRepoId: string | null
  isDeleting: boolean
  isIndexing: boolean
}) {
  const listRef = useRef<HTMLDivElement>(null)
  const [scrollMargin, setScrollMargin] = useState(0)
  const [isScrolling, setIsScrolling] = useState(false)

  useLayoutEffect(() => {
    const el = listRef.current
    if (!el) return
    const update = () => {
      const next = documentOffsetTop(el)
      setScrollMargin((prev) => (prev === next ? prev : next))
    }
    update()
    const parent = el.parentElement
    const observer = parent ? new ResizeObserver(update) : null
    observer?.observe(parent)
    window.addEventListener("resize", update)
    return () => {
      observer?.disconnect()
      window.removeEventListener("resize", update)
    }
  }, [])

  const virtualizer = useWindowVirtualizer({
    count: rows.length,
    estimateSize: () => ROW_SIZE_PX,
    overscan: isScrolling ? OVERSCAN_SCROLLING : OVERSCAN_IDLE,
    scrollMargin,
    getItemKey: (index) => rows[index]?.key ?? index,
    onChange: (instance) => {
      setIsScrolling((prev) =>
        prev === instance.isScrolling ? prev : instance.isScrolling,
      )
    },
  })

  return (
    <div ref={listRef}>
      <ul
        aria-label="Git sources"
        className={`relative m-0 w-full list-none p-0 [overflow-anchor:none] ${isScrolling ? "pointer-events-none" : ""}`}
        style={{
          height: virtualizer.getTotalSize(),
          backgroundImage: `repeating-linear-gradient(to bottom, transparent 0, transparent ${ROW_SIZE_PX - 1}px, rgb(255 255 255 / 0.06) ${ROW_SIZE_PX - 1}px, rgb(255 255 255 / 0.06) ${ROW_SIZE_PX}px)`,
        }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const row = rows[virtualRow.index]
          if (!row) return null
          return (
            <li
              key={virtualRow.key}
              className="absolute top-0 left-0 w-full overflow-hidden"
              style={{
                height: ROW_SIZE_PX,
                transform: `translateY(${virtualRow.start - scrollMargin}px)`,
              }}
            >
              {row.kind === "indexed" ? (
                <RepositoryCard
                  repo={row.repo}
                  onDelete={onDelete}
                  onRetry={onRetry}
                  isRetrying={retryingRepoId === row.repo.id}
                  isDeleting={isDeleting}
                  interactive={!isScrolling}
                />
              ) : row.kind === "pending-connected" ? (
                <PendingGitSourceRow
                  title={row.repo.full_name}
                  subtitle={row.repo.html_url}
                  href={row.repo.html_url}
                  isIndexing={isIndexing}
                  interactive={!isScrolling}
                  onIndexNow={() =>
                    onIndexNow({
                      name: row.repo.full_name,
                      gitUrl: row.repo.clone_url,
                    })
                  }
                />
              ) : (
                <PendingGitSourceRow
                  title={row.repo.name}
                  subtitle={row.repo.gitUrl}
                  isIndexing={isIndexing}
                  interactive={!isScrolling}
                  onIndexNow={() =>
                    onIndexNow({
                      name: row.repo.name,
                      gitUrl: row.repo.gitUrl,
                    })
                  }
                />
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
