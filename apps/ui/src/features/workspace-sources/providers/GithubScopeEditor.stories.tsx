import type { Meta, StoryObj } from "@storybook/react-vite"
import { delay, http } from "msw"
import { type ComponentProps, useState } from "react"
import { expect, userEvent, waitFor, within } from "storybook/test"
import { githubInstallationReposHandler } from "@/mocks/workspace-handlers"
import { entryPageInnerDecorators } from "../../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../../.storybook/decorators/with-story-route"
import { GithubScopeEditor } from "./github"

/** The editor with the last scope it gave, as a dialog holds it. */
function EditorWithOutput(
  props: Omit<ComponentProps<typeof GithubScopeEditor>, "onChange">,
) {
  const [scope, setScope] = useState<string>("No change")
  return (
    <>
      <GithubScopeEditor
        {...props}
        onChange={(next) => setScope(JSON.stringify(next))}
      />
      <output
        aria-label="Scope"
        className="mt-4 block text-xs text-muted-foreground"
      >
        {scope}
      </output>
    </>
  )
}

const repos = [
  { id: 11, name: "api", full_name: "acme/api", clone_url: "x" },
  { id: 12, name: "web", full_name: "acme/web", clone_url: "x" },
  { id: 13, name: "docs", full_name: "acme/docs", clone_url: "x" },
].map((repo) => ({
  ...repo,
  clone_url: `https://github.com/${repo.full_name}.git`,
}))

const meta = {
  title: "Components/WorkspaceSources/GithubScopeEditor",
  component: EditorWithOutput,
  decorators: [
    (Story) => (
      <div className="max-w-lg bg-zinc-950 p-4">
        <Story />
      </div>
    ),
    ...entryPageInnerDecorators,
  ],
  parameters: {
    layout: "fullscreen",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug: "acme",
    } satisfies StoryRouteParams,
    msw: { handlers: { page: [githubInstallationReposHandler(repos)] } },
  },
  args: {
    orgSlug: "acme",
    provider: "github",
    connectionId: "con_gh1",
    initialScope: {},
  },
} satisfies Meta<typeof EditorWithOutput>

export default meta

type Story = StoryObj<typeof meta>

export const Loading: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          http.get(/\/github\/installation\/repositories$/, async () => {
            await delay("infinite")
          }),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      await canvas.findByText("Loading repositories"),
    ).toBeInTheDocument()
  },
}

export const SelectTwoRepositories: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      await canvas.findByRole("checkbox", { name: "acme/api" }),
    )
    await userEvent.click(canvas.getByRole("checkbox", { name: "acme/web" }))
    await expect(
      canvas.getByRole("status", { name: "Scope" }),
    ).toHaveTextContent(
      JSON.stringify({ repositories: ["acme/api", "acme/web"] }),
    )
    await expect(canvas.getByText("2 selected")).toBeVisible()
  },
}

export const InitialScopeSelected: Story = {
  args: { initialScope: { repositories: ["acme/web", "acme/gone"] } },
  play: async ({ canvasElement }) => {
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
    await expect(
      canvas.getByRole("status", { name: "Scope" }),
    ).toHaveTextContent(JSON.stringify({ repositories: ["acme/web"] }))
  },
}

export const EmptyGivesNull: Story = {
  args: { initialScope: { repositories: ["acme/api"] } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      await canvas.findByRole("checkbox", { name: "acme/api" }),
    )
    await expect(
      canvas.getByRole("status", { name: "Scope" }),
    ).toHaveTextContent("null")
    await expect(
      canvas.getByText("Select at least one repository."),
    ).toBeVisible()
  },
}

export const SearchFilters: Story = {
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
}
