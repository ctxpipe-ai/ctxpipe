import { IconBrandGithub } from "@tabler/icons-react"
import { useQuery } from "@tanstack/react-query"
import { SOURCE_SCOPES } from "backend/domain/workspace-sources/sources-file"
import { useMemo, useState } from "react"
import { InlineAlert } from "@/components/ui/InlineAlert"
import { SearchField } from "@/components/ui/SearchField"
import {
  GithubRepoPickerList,
  GithubRepoPickerSkeleton,
} from "@/features/repositories/components/GithubRepoPickerList"
import {
  type GithubRepoItem,
  githubInstallationReposOptions,
  sortGithubRepos,
} from "@/features/repositories/githubRepoSelection"
import type {
  SourceProviderUi,
  SourceScopeEditorProps,
} from "../source-provider-ui"
import { ScopeLimitAlert } from "./ScopeLimitAlert"

function initialRepositories(scope: Record<string, unknown>): string[] {
  const value = scope.repositories
  return Array.isArray(value)
    ? value.filter((name): name is string => typeof name === "string")
    : []
}

/**
 * The GitHub scope editor: pick the repositories of one GitHub connection.
 * A repository from the initial scope stays in the list when the connection
 * cannot see it, so that the user can remove it.
 */
export function GithubScopeEditor(props: SourceScopeEditorProps) {
  const { orgSlug, connectionId, initialScope, onChange, label } = props
  const [selected, setSelected] = useState(() =>
    initialRepositories(initialScope),
  )
  const [searchQuery, setSearchQuery] = useState("")

  const reposQuery = useQuery(
    githubInstallationReposOptions(orgSlug, [connectionId]),
  )

  const repos = useMemo(() => {
    const listed = sortGithubRepos(
      reposQuery.data?.repositories ?? [],
      "name-asc",
    )
    const known = new Set(listed.map((repo) => repo.full_name.toLowerCase()))
    const missing: GithubRepoItem[] = initialRepositories(initialScope)
      .filter((name) => !known.has(name.toLowerCase()))
      .map((name, index) => ({
        id: -(index + 1),
        name,
        full_name: name,
        html_url: `https://github.com/${name}`,
        clone_url: `https://github.com/${name}.git`,
      }))
    return [...missing, ...listed]
  }, [reposQuery.data?.repositories, initialScope])

  const selectedKeys = new Set(selected.map((name) => name.toLowerCase()))
  const selectedIds = new Set(
    repos
      .filter((repo) => selectedKeys.has(repo.full_name.toLowerCase()))
      .map((repo) => repo.id),
  )
  const query = searchQuery.trim().toLowerCase()
  const visibleRepos = query
    ? repos.filter((repo) => repo.full_name.toLowerCase().includes(query))
    : repos

  function toggle(id: number, isSelected: boolean) {
    const repo = repos.find((item) => item.id === id)
    if (!repo) return
    const key = repo.full_name.toLowerCase()
    const next = isSelected
      ? [...selected, repo.full_name]
      : selected.filter((name) => name.toLowerCase() !== key)
    setSelected(next)
    const parsed = SOURCE_SCOPES.github.schema.safeParse({
      repositories: next,
    })
    onChange(parsed.success ? parsed.data : null)
  }

  const heading = label ? `Repositories for ${label}` : "Repositories"
  return (
    <fieldset className="min-w-0 space-y-3">
      <legend className="mb-1 text-sm font-medium">{heading}</legend>
      {reposQuery.isError ? (
        <InlineAlert variant="error" title="Could not load repositories">
          Check the GitHub connection under Connectors.
        </InlineAlert>
      ) : null}
      {reposQuery.isPending && repos.length === 0 ? (
        <GithubRepoPickerSkeleton rows={4} />
      ) : (
        <>
          <SearchField
            value={searchQuery}
            onChange={setSearchQuery}
            placeholder="Search repositories"
            aria-label={`Search ${heading.toLowerCase()}`}
          />
          {visibleRepos.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No repositories match.
            </p>
          ) : (
            <GithubRepoPickerList
              repos={visibleRepos}
              selectedIds={selectedIds}
              onToggle={toggle}
            />
          )}
        </>
      )}
      <p className="text-xs text-muted-foreground">
        {selected.length === 0
          ? "Select at least one repository."
          : `${selected.length} selected`}
      </p>
      <ScopeLimitAlert
        schema={SOURCE_SCOPES.github.schema}
        scope={{ repositories: selected }}
      />
    </fieldset>
  )
}

export const githubSourceUi: SourceProviderUi = {
  Icon: IconBrandGithub,
  ScopeEditor: GithubScopeEditor,
}
