import type { Meta, StoryObj } from "@storybook/react-vite"
import { delay, http } from "msw"
import { type ComponentProps, useState } from "react"
import { expect, userEvent, within } from "storybook/test"
import { linearAvailableScopesHandler } from "@/mocks/linear-handlers"
import { workspaceListHandler } from "@/mocks/workspace-handlers"
import { entryPageInnerDecorators } from "../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import {
  docsWorkspace,
  readOnlyWorkspace,
} from "../workspaces/workspace-fixtures"
import {
  CHOOSE_WORKSPACES_HINT,
  ChooseWorkspacesStep,
} from "./ChooseWorkspacesStep"
import {
  type ChooseWorkspacesValue,
  chooseWorkspacesRequests,
  emptyChooseWorkspaces,
} from "./choose-workspaces"

/** The step with its state, as a wizard holds it. */
function StepWithState(
  props: Omit<
    ComponentProps<typeof ChooseWorkspacesStep>,
    "value" | "onChange"
  >,
) {
  const [value, setValue] = useState<ChooseWorkspacesValue>(
    emptyChooseWorkspaces,
  )
  const requests = chooseWorkspacesRequests(value, props)
  return (
    <>
      <ChooseWorkspacesStep {...props} value={value} onChange={setValue} />
      <output className="mt-4 block text-xs text-muted-foreground">
        {requests ? `${requests.length} ready` : "Not ready"}
      </output>
    </>
  )
}

const meta = {
  title: "Components/WorkspaceSources/ChooseWorkspacesStep",
  component: StepWithState,
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
    msw: {
      handlers: {
        page: [
          workspaceListHandler([docsWorkspace, readOnlyWorkspace]),
          linearAvailableScopesHandler(),
        ],
      },
    },
  },
  args: { orgSlug: "acme", provider: "linear", connectionId: "con_li1" },
} satisfies Meta<typeof StepWithState>

export default meta

type Story = StoryObj<typeof meta>

export const Loading: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          http.get(/\/api\/v1\/workspaces$/, async () => {
            await delay("infinite")
          }),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText("Loading Workspaces")
    await expect(canvas.getByText(CHOOSE_WORKSPACES_HINT)).toBeVisible()
  },
}

export const ShowsHint: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByRole("checkbox", { name: docsWorkspace.displayName })
    await expect(canvas.getByText(CHOOSE_WORKSPACES_HINT)).toBeVisible()
    await expect(canvas.getByText("Not ready")).toBeVisible()
  },
}

export const SingleWorkspace: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      await canvas.findByRole("checkbox", { name: docsWorkspace.displayName }),
    )
    await expect(canvas.queryByRole("radiogroup")).toBeNull()
    await expect(canvas.getByText("Not ready")).toBeVisible()
    await userEvent.click(
      await canvas.findByRole("checkbox", { name: /Engineering/ }),
    )
    await expect(canvas.getByText("1 ready")).toBeVisible()
  },
}

export const ChooseWorkspacesMulti: Story = {
  tags: ["workspace-golden"],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      await canvas.findByRole("checkbox", { name: docsWorkspace.displayName }),
    )
    await userEvent.click(
      canvas.getByRole("checkbox", { name: readOnlyWorkspace.displayName }),
    )
    await expect(
      canvas.getByRole("radio", { name: /Same scope/ }),
    ).toBeChecked()
    await expect(
      await canvas.findAllByRole("group", {
        name: "Linear teams and projects",
      }),
    ).toHaveLength(1)
    await userEvent.click(canvas.getByRole("checkbox", { name: /Engineering/ }))
    await expect(canvas.getByText("2 ready")).toBeVisible()

    await userEvent.click(
      canvas.getByRole("radio", { name: /different scope/ }),
    )
    const own = (name: string) =>
      canvas.findByRole("group", {
        name: `Linear teams and projects for ${name}`,
      })
    await userEvent.click(
      within(await own(docsWorkspace.displayName)).getByRole("checkbox", {
        name: /Operations/,
      }),
    )
    await expect(await own(readOnlyWorkspace.displayName)).toBeVisible()
    await expect(canvas.getByText("Not ready")).toBeVisible()
    await expect(canvas.getByText(CHOOSE_WORKSPACES_HINT)).toBeVisible()
  },
}
