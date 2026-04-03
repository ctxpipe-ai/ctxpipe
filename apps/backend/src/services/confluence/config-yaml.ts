import { stringify } from "yaml"

export function renderConfluenceConfigYaml(input: {
  spaces: Array<{ spaceKey: string; selectedPageIds: string[] | null }>
}): string {
  const payload = {
    version: 1,
    source: "confluence",
    spaces: input.spaces.map((space) => ({
      key: space.spaceKey,
      selectedPageIds: space.selectedPageIds ?? [],
    })),
  }
  return stringify(payload)
}

export function hasConfigYamlChanged(input: {
  current: string | undefined
  next: string
}): boolean {
  const current = (input.current ?? "").trim()
  const next = input.next.trim()
  return current !== next
}

export function getConfigPullRequestPayload(input: { orgSlug: string }) {
  return {
    title: "Update Confluence sync configuration",
    body: [
      "This PR updates `confluence/config.yaml` from the Atlassian connector settings.",
      "",
      `Organization: \`${input.orgSlug}\``,
    ].join("\n"),
    commitMessage: "chore(confluence): update sync config.yaml",
  }
}
