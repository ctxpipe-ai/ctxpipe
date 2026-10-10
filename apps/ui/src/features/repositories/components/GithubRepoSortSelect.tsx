import { Select, SelectItem } from "@/components/ui/Select"
import type { GithubRepoSort } from "../githubRepoSelection"

export function GithubRepoSortSelect(props: {
  value: GithubRepoSort
  onChange: (sort: GithubRepoSort) => void
}) {
  return (
    <Select
      aria-label="Sort repositories"
      selectedKey={props.value}
      onSelectionChange={(key) => props.onChange(key as GithubRepoSort)}
      className="shrink-0"
    >
      <SelectItem id="pushed-desc">Recently pushed</SelectItem>
      <SelectItem id="created-desc">Newest created</SelectItem>
      <SelectItem id="created-asc">Oldest created</SelectItem>
      <SelectItem id="name-asc">Name A–Z</SelectItem>
    </Select>
  )
}
