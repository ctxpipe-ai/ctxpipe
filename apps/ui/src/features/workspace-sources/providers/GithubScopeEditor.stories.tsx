import { delay, http } from "msw"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"

import { signedInHandlers } from "@/mocks/handlers"
import { githubInstallationReposHandler } from "@/mocks/workspace-handlers"

import type { StoryRouteParams } from "../../../../.storybook/decorators/with-story-route"
import preview from "../../../../.storybook/preview"
import { sourceDialogStoryFrame } from "../source-dialog-story-frame"
import { GithubScopeEditor } from "./github"

const repos = [
  { id: 11, name: "api", full_name: "acme/api", clone_url: "x" },
  { id: 12, name: "web", full_name: "acme/web", clone_url: "x" },
  { id: 13, name: "docs", full_name: "acme/docs", clone_url: "x" },
].map((repo) => ({
  ...repo,
  clone_url: `https://github.com/${repo.full_name}.git`,
}))

const meta = preview.meta({
  title: "Components/WorkspaceSources/GithubScopeEditor",
  component: GithubScopeEditor,
  decorators: [sourceDialogStoryFrame],
  beforeEach: ({ msw }) => {
    msw.use(...signedInHandlers, githubInstallationReposHandler(repos))
  },
  parameters: {
    app: "root",
    review: { kind: "component" },
    layout: "fullscreen",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug: "acme",
    } satisfies StoryRouteParams,
  },
  args: {
    orgSlug: "acme",
    provider: "github",
    connectionId: "con_gh1",
    initialScope: {},
    onChange: fn(),
  },
})

/**
 * GitHub scope editor, where the user picks the repositories of a Workspace
 * source: the repository list still loads.
 */
export const Loading = meta.story({
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      await canvas.findByText("Loading repositories"),
    ).toBeInTheDocument()
  },
  beforeEach: ({ msw }) => {
    msw.use(
      http.get(/\/github\/installation\/repositories$/, async () => {
        await delay("infinite")
      }),
    )
  },
})

/**
 * GitHub scope editor, where the user picks the repositories of a Workspace
 * source: the user picks two repositories.
 */
export const SelectTwoRepositories = meta.story({
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      await canvas.findByRole("checkbox", { name: "acme/api" }),
    )
    await userEvent.click(canvas.getByRole("checkbox", { name: "acme/web" }))
    await expect(args.onChange).toHaveBeenLastCalledWith({
      repositories: ["acme/api", "acme/web"],
    })
    await expect(canvas.getByText("2 selected")).toBeVisible()
  },
})

/**
 * GitHub scope editor in the Edit source dialog: the saved scope has acme/web
 * and acme/gone, a repository that the connection can no longer see, and the
 * user unticks acme/gone.
 */
export const InitialScopeSelected = meta.story({
  args: { initialScope: { repositories: ["acme/web", "acme/gone"] } },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(() =>
      expect(canvas.getByRole("checkbox", { name: "acme/web" })).toBeChecked(),
    )
    // The list shows the initial scope before the connection's list loads.
    await waitFor(() =>
      expect(
        canvas.getByRole("checkbox", { name: "acme/api" }),
      ).not.toBeChecked(),
    )
    // The connection cannot see acme/gone, but the user can still remove it.
    const gone = canvas.getByRole("checkbox", { name: "acme/gone" })
    await expect(gone).toBeChecked()
    await userEvent.click(gone)
    await expect(args.onChange).toHaveBeenLastCalledWith({
      repositories: ["acme/web"],
    })
  },
})

/**
 * GitHub scope editor, where the user picks the repositories of a Workspace
 * source: the user clears the last repository, so the scope is empty and a hint
 * asks for one.
 */
export const EmptyGivesNull = meta.story({
  args: { initialScope: { repositories: ["acme/api"] } },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      await canvas.findByRole("checkbox", { name: "acme/api" }),
    )
    await expect(args.onChange).toHaveBeenLastCalledWith(null)
    await expect(
      canvas.getByText("Select at least one repository."),
    ).toBeVisible()
  },
})

/**
 * GitHub scope editor, where the user picks the repositories of a Workspace
 * source: a search narrows the list to the matching repository.
 */
export const SearchFilters = meta.story({
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.type(
      await canvas.findByRole("searchbox", { name: "Search repositories" }),
      "doc",
    )
    await expect(
      canvas.getByRole("checkbox", { name: "acme/docs" }),
    ).toBeVisible()
    await expect(
      canvas.queryByRole("checkbox", { name: "acme/api" }),
    ).toBeNull()
  },
})
