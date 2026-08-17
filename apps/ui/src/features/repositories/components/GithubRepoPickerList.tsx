import { useVirtualizer } from "@tanstack/react-virtual"
import { useRef } from "react"
import { Checkbox } from "@/components/ui/Checkbox"
import type { GithubRepoItem } from "../githubRepoSelection"

const ROW_SIZE_PX = 40

export function GithubRepoPickerList({
  repos,
  selectedIds,
  onToggle,
}: {
  repos: readonly GithubRepoItem[]
  selectedIds: ReadonlySet<number>
  onToggle: (id: number, selected: boolean) => void
}) {
  const parentRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: repos.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_SIZE_PX,
    overscan: 12,
    getItemKey: (index) => repos[index]?.id ?? index,
  })

  return (
    <div
      ref={parentRef}
      className="max-h-96 overflow-auto rounded-none border border-white/[0.06] bg-card/40 [overflow-anchor:none]"
    >
      <ul
        aria-label="Repositories"
        className="relative m-0 w-full list-none p-0"
        style={{ height: virtualizer.getTotalSize() }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const repo = repos[virtualRow.index]
          if (!repo) return null
          const isSelected = selectedIds.has(repo.id)
          return (
            <li
              key={virtualRow.key}
              className={`absolute top-0 left-0 w-full overflow-hidden ${
                virtualRow.index === 0 ? "" : "border-t border-white/[0.06]"
              }`}
              style={{
                height: ROW_SIZE_PX,
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              <Checkbox
                isSelected={isSelected}
                onChange={(selected) => onToggle(repo.id, selected)}
                className={`h-full w-full rounded-none px-3 ${
                  isSelected
                    ? "bg-zinc-700/30 hover:bg-zinc-700/40"
                    : "hover:bg-zinc-700/60"
                }`}
              >
                <span className="min-w-0 truncate">{repo.full_name}</span>
              </Checkbox>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
