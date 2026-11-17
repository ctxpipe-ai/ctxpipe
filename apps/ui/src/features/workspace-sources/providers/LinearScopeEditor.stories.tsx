import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"

import { signedInHandlers } from "@/mocks/handlers"
import { linearAvailableScopesHandler } from "@/mocks/linear-handlers"

import type { StoryRouteParams } from "../../../../.storybook/decorators/with-story-route"
import { LinearScopeEditor } from "./linear"
import { scopeEditorStoryFrame } from "./scope-editor-story-frame"

const meta = {
  title: "Components/WorkspaceSources/LinearScopeEditor",
  component: LinearScopeEditor,
  decorators: [scopeEditorStoryFrame],
  parameters: {
    app: "root",
    review: { kind: "component" },
    layout: "fullscreen",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug: "acme",
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        session: signedInHandlers,
        page: [linearAvailableScopesHandler()],
      },
    },
  },
  args: {
    orgSlug: "acme",
    provider: "linear",
    connectionId: "con_li1",
    initialScope: {},
    onChange: fn(),
  },
} satisfies Meta<typeof LinearScopeEditor>

export default meta

type Story = StoryObj<typeof meta>

export const PicksTeamsAndProjects: Story = {
  parameters: {
    review: {
      purpose:
        "Linear scope editor, where the user picks the teams and projects of a Workspace source: the user picks a team and a project and turns off customer requests.",
    },
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      await canvas.findByRole("checkbox", { name: /Engineering/ }),
    )
    await userEvent.click(canvas.getByRole("checkbox", { name: /Q3 launch/ }))
    await expect(args.onChange).toHaveBeenLastCalledWith({
      teams: ["ENG"],
      projects: ["project-launch"],
    })
    await userEvent.click(
      canvas.getByRole("checkbox", { name: "Include customer requests" }),
    )
    await expect(args.onChange).toHaveBeenLastCalledWith({
      teams: ["ENG"],
      projects: ["project-launch"],
      customerRequests: "exclude",
    })
  },
}

export const EmptySelectionIsNotReady: Story = {
  parameters: {
    review: {
      purpose:
        "Linear scope editor, where the user picks the teams and projects of a Workspace source: the user clears the last team, so the scope is not ready and a hint asks for one.",
    },
  },
  args: { initialScope: { teams: ["ENG"] } },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    const team = await canvas.findByRole("checkbox", { name: /Engineering/ })
    await expect(team).toBeChecked()
    await userEvent.click(team)
    await expect(args.onChange).toHaveBeenLastCalledWith(null)
    await expect(
      canvas.getByText("Select at least one team or project."),
    ).toBeVisible()
  },
}

export const EditsAnExistingScope: Story = {
  parameters: {
    review: {
      purpose:
        "Linear scope editor, where the user picks the teams and projects of a Workspace source: a saved scope has a team that Linear no longer has, marked as not found.",
    },
  },
  args: {
    initialScope: { teams: ["ops", "OLD"], customerRequests: "exclude" },
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(() =>
      expect(
        canvas.getByRole("checkbox", { name: /Operations/ }),
      ).toBeChecked(),
    )
    const missing = canvas.getByRole("checkbox", { name: /OLD/ })
    await expect(missing).toBeChecked()
    await expect(canvas.getByText("Not found in Linear")).toBeVisible()
    await expect(
      canvas.getByRole("checkbox", { name: "Include customer requests" }),
    ).not.toBeChecked()
    await userEvent.click(missing)
    await expect(args.onChange).toHaveBeenLastCalledWith({
      teams: ["OPS"],
      customerRequests: "exclude",
    })
  },
}

export const LoadError: Story = {
  parameters: {
    review: {
      purpose:
        "Linear scope editor in the Add source dialog: the request for the Linear teams and projects failed, so an error alert with Retry stands in place of the list.",
    },
    msw: { handlers: { page: [linearAvailableScopesHandler("error")] } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(() =>
      expect(canvas.getByRole("alert")).toHaveTextContent(
        "Could not load the Linear teams and projects.",
      ),
    )
    await expect(canvas.getByRole("button", { name: "Retry" })).toBeVisible()
  },
}
