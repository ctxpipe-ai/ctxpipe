import { cn } from "@/lib/utils"

/**
 * A Git branch name on one line, in mono. A long name loses its middle, not
 * its end, so that two branches with the same prefix stay apart (for example
 * two release branches). Use it wherever the chat shows a branch.
 */
export function BranchName(props: { name: string; className?: string }) {
  const { name } = props
  const tail = branchNameTail(name)
  return (
    <span className={cn("flex min-w-0 font-mono", props.className)}>
      <span className="truncate">
        {tail ? name.slice(0, -tail.length) : name}
      </span>
      {tail ? <span className="shrink-0">{tail}</span> : null}
    </span>
  )
}

/**
 * The end of a long name that always shows: its last words, from a `/`, `-`
 * or `_`, at most 16 characters. A short name fits in each place that shows
 * a branch, so it has no tail.
 */
export function branchNameTail(name: string) {
  if (name.length <= 24) return ""
  // One character more than the tail, so that a word that starts at the
  // limit stays whole.
  const end = name.slice(-17)
  const cut = end.search(/[/_-][^/_-]/)
  return cut === -1 ? name.slice(-10) : end.slice(cut + 1)
}
