import { delay, http } from "msw"
import { type ComponentProps, useState } from "react"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"

import { signedInHandlers } from "@/mocks/handlers"
import { linearAvailableScopesHandler } from "@/mocks/linear-handlers"
import { workspaceListHandler } from "@/mocks/workspace-handlers"
import { activeMemberRoleHandler } from "@/mocks/workspace-sources-handlers"
import {
  pendingWorkspaceUpgradesHandler,
  upgradeItemFixture,
} from "@/mocks/workspace-upgrades-handlers"

import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import preview from "../../../.storybook/preview"
import {
  docsWorkspace,
  readOnlyWorkspace,
} from "../workspaces/workspace-fixtures"
import {
  type ChooseWorkspacesValue,
  chooseWorkspacesRequests,
  emptyChooseWorkspaces,
} from "./choose-workspaces"
import {
  CHOOSE_WORKSPACES_HINT,
  ChooseWorkspacesStep,
} from "./ChooseWorkspacesStep"
import { sourceDialogStoryFrame } from "./source-dialog-story-frame"

type StepProps = Omit<ComponentProps<typeof ChooseWorkspacesStep>, "value">

/** The step with its state, as a wizard holds it. */
function StepWithState(props: StepProps) {
  const [value, setValue] = useState<ChooseWorkspacesValue>(
    emptyChooseWorkspaces,
  )
  return (
    <ChooseWorkspacesStep
      {...props}
      value={value}
      onChange={(next) => {
        setValue(next)
        props.onChange(next)
      }}
    />
  )
}

/** The onChange of the step: each value that the step gives to the wizard. */
const onStepChange = fn<(value: ChooseWorkspacesValue) => void>()

/**
 * The requests that the wizard sends for the last value of the step, or null
 * while the step is not ready.
 */
function lastRequests(args: StepProps) {
  const value = onStepChange.mock.lastCall?.[0] ?? emptyChooseWorkspaces()
  return chooseWorkspacesRequests(value, args)
}

const meta = preview.meta({
  title: "Components/WorkspaceSources/ChooseWorkspacesStep",
  component: StepWithState,
  decorators: [sourceDialogStoryFrame],
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
    provider: "linear",
    connectionId: "con_li1",
    onChange: onStepChange,
  },
  beforeEach: ({ msw }) => {
    msw.use(
      ...signedInHandlers,
      pendingWorkspaceUpgradesHandler({}),
      workspaceListHandler([docsWorkspace, readOnlyWorkspace]),
      linearAvailableScopesHandler(),
    )
    onStepChange.mockClear()
  },
})

/**
 * Choose Workspaces step of a connector setup, where the user adds a source to
 * Workspaces: the Workspace list still loads.
 */
export const Loading = meta.story({
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText("Loading Workspaces")
    await expect(canvas.getByText(CHOOSE_WORKSPACES_HINT)).toBeVisible()
  },
  beforeEach: ({ msw }) => {
    msw.use(
      http.get(/\/api\/v1\/workspaces$/, async () => {
        await delay("infinite")
      }),
    )
  },
})

/**
 * Add to Workspaces step of a connector setup, where the user ticks the
 * Workspaces that get the new source: the list loaded and nothing is ticked
 * yet, so no scope editor shows, only a hint.
 */
export const ShowsHint = meta.story({
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByRole("checkbox", { name: docsWorkspace.displayName })
    await expect(canvas.getByText(CHOOSE_WORKSPACES_HINT)).toBeVisible()
    await expect(lastRequests(args)).toBeNull()
  },
})

/**
 * Choose Workspaces step of a connector setup, where the user adds a source to
 * Workspaces: the org has no Workspaces yet, so the step offers to create one.
 */
export const NoWorkspaces = meta.story({
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(() =>
      expect(canvas.getByText(/There are no Workspaces yet\./)).toBeVisible(),
    )
    await expect(canvas.getByText(/Add to a Workspace/)).toBeVisible()
    await expect(
      canvas.getByRole("button", { name: "Create a Workspace" }),
    ).toBeEnabled()
  },
  beforeEach: ({ msw }) => {
    msw.use(workspaceListHandler([]))
  },
})

/**
 * Choose Workspaces step of a connector setup, where the user adds a source to
 * Workspaces: the user picks one Workspace and one Linear team, so the step is
 * ready.
 */
export const SingleWorkspace = meta.story({
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      await canvas.findByRole("checkbox", { name: docsWorkspace.displayName }),
    )
    await expect(canvas.queryByRole("radiogroup")).toBeNull()
    await expect(lastRequests(args)).toBeNull()
    await userEvent.click(
      await canvas.findByRole("checkbox", { name: /Engineering/ }),
    )
    await expect(lastRequests(args)).toHaveLength(1)
  },
})

/**
 * Choose Workspaces step of a connector setup, where the user adds a source to
 * Workspaces: two Workspaces are picked, with a choice between one Linear scope
 * for both and a scope for each.
 */
export const ChooseWorkspacesMulti = meta.story({
  parameters: {
    intent:
      "Catches a multi-workspace connector step that mixes the shared and per-workspace scope. Same scope shows one picker, different scope shows one for each workspace. Not for connector sign-in.",
  },
  tags: ["required"],
  play: async ({ args, canvasElement }) => {
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
    await expect(lastRequests(args)).toHaveLength(2)

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
    await expect(lastRequests(args)).toBeNull()
    await expect(canvas.getByText(CHOOSE_WORKSPACES_HINT)).toBeVisible()
  },
})

const docsAndHandbook = workspaceListHandler([docsWorkspace, readOnlyWorkspace])

/**
 * Add to Workspaces step of a connector setup, where the user adds a source to
 * Workspaces: one Workspace needs the format upgrade first, so its row is off
 * and links to its upgrade. The other Workspace stays usable. A Workspace below
 * the newest format refuses a source (CTX-935).
 */
export const OneWorkspaceNeedsUpgrade = meta.story({
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByRole("checkbox", { name: docsWorkspace.displayName })
    await waitFor(() =>
      expect(
        canvas.getByRole("checkbox", { name: docsWorkspace.displayName }),
      ).toBeDisabled(),
    )
    await waitFor(() =>
      expect(
        canvas.getByRole("checkbox", { name: readOnlyWorkspace.displayName }),
      ).toBeEnabled(),
    )
    await expect(
      canvas.getByText(/Needs the format upgrade first/),
    ).toBeVisible()
    await expect(
      canvas.getByRole("link", { name: "Review upgrade" }),
    ).toHaveAttribute("href", "/acme/ws/docs?pane=settings#upgrades")
    // Some Workspace can still take the source: no page-level notice.
    await expect(
      canvas.queryByText("Upgrade a Workspace before you add a source"),
    ).toBeNull()
  },
  beforeEach: ({ msw }) => {
    msw.use(
      pendingWorkspaceUpgradesHandler({
        [docsWorkspace.slug]: [upgradeItemFixture()],
      }),
      docsAndHandbook,
      linearAvailableScopesHandler(),
      activeMemberRoleHandler("owner"),
    )
  },
})

/**
 * Add to Workspaces step of a connector setup, seen by a member: each Workspace
 * needs the format upgrade, so a warning tells the member to ask an admin, and
 * each row is off with its upgrade link.
 */
export const AllWorkspacesNeedUpgrade = meta.story({
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText("Upgrade a Workspace before you add a source")
    for (const workspace of [docsWorkspace, readOnlyWorkspace])
      await expect(
        canvas.getByRole("checkbox", { name: workspace.displayName }),
      ).toBeDisabled()
    await waitFor(() => expect(canvas.getByText("Ask an admin")).toBeVisible())
    // The rows link to each upgrade, so the warning has no second link.
    await expect(
      canvas.getAllByRole("link", { name: /Review upgrade/ }),
    ).toHaveLength(2)
    await expect(lastRequests(args)).toBeNull()
  },
  beforeEach: ({ msw }) => {
    msw.use(
      pendingWorkspaceUpgradesHandler({
        [docsWorkspace.slug]: [upgradeItemFixture()],
        [readOnlyWorkspace.slug]: [upgradeItemFixture({ status: "failed" })],
      }),
      docsAndHandbook,
      linearAvailableScopesHandler(),
      activeMemberRoleHandler("member"),
    )
  },
})

/**
 * Add to Workspaces step of a connector setup, where the user adds a source to
 * Workspaces: one Workspace is below the newest format with no upgrade item
 * yet, so its row is off and links to its upgrade. The scan did not record an
 * item, but the read still lists the Workspace with its format.
 */
export const BelowFormatWithNoUpgradeRowYet = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(
      pendingWorkspaceUpgradesHandler({}, undefined, {
        formats: { [docsWorkspace.slug]: 1 },
      }),
      docsAndHandbook,
      linearAvailableScopesHandler(),
      activeMemberRoleHandler("owner"),
    )
  },
  parameters: {
    visual: {
      skip: "Behavior test: it ends in the same state as OneWorkspaceNeedsUpgrade.",
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByRole("checkbox", { name: docsWorkspace.displayName })
    await waitFor(() =>
      expect(
        canvas.getByRole("checkbox", { name: docsWorkspace.displayName }),
      ).toBeDisabled(),
    )
    await waitFor(() =>
      expect(
        canvas.getByRole("checkbox", { name: readOnlyWorkspace.displayName }),
      ).toBeEnabled(),
    )
    await expect(
      canvas.getByRole("link", { name: "Review upgrade" }),
    ).toHaveAttribute("href", "/acme/ws/docs?pane=settings#upgrades")
  },
})

/**
 * Add to Workspaces step of a connector setup, where the user adds a source to
 * Workspaces: the format check still loads, so a skeleton shows and no rows.
 * The step cannot tell yet which Workspace the server refuses.
 */
export const NoRowsWhileFormatCheckLoads = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(
      http.get(/\/workspace-upgrades\/pending$/, () => delay("infinite")),
      docsAndHandbook,
      linearAvailableScopesHandler(),
      activeMemberRoleHandler("owner"),
    )
  },
  parameters: {
    visual: { skip: "Behavior test: it ends in the same state as Loading." },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText("Loading Workspaces")
    await expect(canvas.queryAllByRole("checkbox")).toHaveLength(0)
  },
})

/**
 * Add to Workspaces step of a connector setup, where the user adds a source to
 * Workspaces: the format check failed, so the rows are off, and an error says
 * why and gives Retry.
 */
export const FormatCheckFailed = meta.story({
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText(
      /Could not check which Workspaces need the format upgrade/,
    )
    await expect(canvas.getByRole("button", { name: "Retry" })).toBeVisible()
    for (const workspace of [docsWorkspace, readOnlyWorkspace])
      await expect(
        canvas.getByRole("checkbox", { name: workspace.displayName }),
      ).toBeDisabled()
  },
  beforeEach: ({ msw }) => {
    msw.use(
      pendingWorkspaceUpgradesHandler({}, undefined, { answer: "error" }),
      docsAndHandbook,
      linearAvailableScopesHandler(),
      activeMemberRoleHandler("owner"),
    )
  },
})
