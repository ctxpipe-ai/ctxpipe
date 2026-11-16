import type { Meta, StoryObj } from "@storybook/react-vite"
import { type ComponentProps, useState } from "react"
import { expect, userEvent, waitFor, within } from "storybook/test"

import { signedInHandlers } from "@/mocks/handlers"
import { linearAvailableScopesHandler } from "@/mocks/linear-handlers"

import type { StoryRouteParams } from "../../../../.storybook/decorators/with-story-route"
import { LinearScopeEditor } from "./linear"

/** The editor with the last scope it reported, as a form holds it. */
function EditorWithOutput(
  props: Omit<ComponentProps<typeof LinearScopeEditor>, "onChange">,
) {
  const [scope, setScope] = useState<Record<string, unknown> | null>(
    props.initialScope,
  )
  return (
    <>
      <LinearScopeEditor {...props} onChange={setScope} />
      <output
        aria-label="Scope"
        className="mt-4 block text-xs text-muted-foreground"
      >
        {JSON.stringify(scope)}
      </output>
    </>
  )
}

const meta = {
  title: "Components/WorkspaceSources/LinearScopeEditor",
  component: EditorWithOutput,
  decorators: [
    (Story) => (
      <div className="max-w-lg bg-zinc-950 p-4">
        <Story />
      </div>
    ),
  ],
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
  },
} satisfies Meta<typeof EditorWithOutput>

export default meta

type Story = StoryObj<typeof meta>

const scopeText = (canvasElement: HTMLElement) =>
  within(canvasElement).getByRole("status", { name: "Scope" }).textContent

export const PicksTeamsAndProjects: Story = {
  parameters: {
    review: {
      purpose:
        "Linear scope editor, where the user picks the teams and projects of a Workspace source: the user picks a team and a project and turns off customer requests.",
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      await canvas.findByRole("checkbox", { name: /Engineering/ }),
    )
    await userEvent.click(canvas.getByRole("checkbox", { name: /Q3 launch/ }))
    await expect(JSON.parse(scopeText(canvasElement) ?? "")).toEqual({
      teams: ["ENG"],
      projects: ["project-launch"],
    })
    await userEvent.click(
      canvas.getByRole("checkbox", { name: "Include customer requests" }),
    )
    await expect(JSON.parse(scopeText(canvasElement) ?? "")).toEqual({
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
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const team = await canvas.findByRole("checkbox", { name: /Engineering/ })
    await expect(team).toBeChecked()
    await userEvent.click(team)
    await expect(scopeText(canvasElement)).toBe("null")
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
  play: async ({ canvasElement }) => {
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
    await expect(JSON.parse(scopeText(canvasElement) ?? "")).toEqual({
      teams: ["OPS"],
      customerRequests: "exclude",
    })
  },
}

export const LoadError: Story = {
  parameters: {
    review: {
      purpose:
        "Linear scope editor, where the user picks the teams and projects of a Workspace source: the teams and projects did not load, so an error with Retry shows.",
    },
    visual: { allow: { contrast: "Text below WCAG AA on main (CTX-1278)." } },
    msw: { handlers: { page: [linearAvailableScopesHandler("error")] } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(() =>
      expect(
        canvas.getByText("Could not load the Linear teams and projects."),
      ).toBeVisible(),
    )
    await expect(canvas.getByRole("button", { name: "Retry" })).toBeVisible()
  },
}
