import type { Meta, StoryObj } from "@storybook/react-vite"
import { HttpResponse, delay, http } from "msw"
import { Toaster } from "sonner"
import { expect, userEvent, waitFor, within } from "storybook/test"

import { activeMemberRoleHandler } from "@/mocks/workspace-sources-handlers"
import {
  upgradeItemFixture,
  upgradesFixture,
  workspaceUpgradeCheckHandler,
  workspaceUpgradesHandler,
} from "@/mocks/workspace-upgrades-handlers"

import { entryPageInnerDecorators } from "../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import { checkingFormatExpired } from "./checking-format-clock"
import { WorkspaceUpgrades } from "./WorkspaceUpgrades"

const checkRequests: string[] = []
const state = { checked: false }

const minutesAgo = (minutes: number) =>
  new Date(Date.now() - minutes * 60_000).toISOString()

const pullRequest = {
  number: 42,
  url: "https://github.com/acme/docs/pull/42",
}

const meta = {
  title: "Components/Workspaces/Upgrades/Progress",
  component: WorkspaceUpgrades,
  decorators: [
    (Story) => (
      <div className="max-w-2xl bg-zinc-950 p-6">
        <Story />
        <Toaster />
      </div>
    ),
    ...entryPageInnerDecorators,
  ],
  beforeEach: () => {
    checkRequests.length = 0
    state.checked = false
  },
  parameters: {
    layout: "fullscreen",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug: "acme",
    } satisfies StoryRouteParams,
  },
  args: { orgSlug: "acme", workspaceSlug: "docs" },
} satisfies Meta<typeof WorkspaceUpgrades>

export default meta

type Story = StoryObj<typeof meta>

function withUpgrades(
  upgrades: Parameters<typeof workspaceUpgradesHandler>[0],
  role: "owner" | "member" = "owner",
  ...more: ReturnType<typeof http.post>[]
) {
  return {
    msw: {
      handlers: {
        page: [
          activeMemberRoleHandler(role),
          workspaceUpgradesHandler(upgrades),
          workspaceUpgradeCheckHandler({
            requests: checkRequests,
            onChecked: () => {
              state.checked = true
            },
          }),
          ...more,
        ],
      },
    },
  }
}

/** A queued run: it has not started a stage. The card says that the user can leave. */
export const Queued: Story = {
  parameters: withUpgrades(
    upgradesFixture([
      upgradeItemFixture({ status: "queued", approvedAt: minutesAgo(0.2) }),
    ]),
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const progress = await canvas.findByRole("region", {
      name: "Progress of Upgrade to format 3",
    })
    await waitFor(() =>
      expect(
        within(progress).getByText(
          "Queued. ctxpipe starts the run in a moment.",
        ),
      ).toBeVisible(),
    )
    expect(within(progress).getByText(/Time so far:/)).toBeVisible()
    expect(within(progress).getByText(/You can leave this page/)).toBeVisible()
  },
}

/** The run is in its second stage: the step, the bar, the time so far, and the leave note. */
export const RunningStage: Story = {
  parameters: withUpgrades(
    upgradesFixture([
      upgradeItemFixture({
        status: "running",
        approvedAt: minutesAgo(1.3),
        runStage: { name: "build", since: minutesAgo(1) },
      }),
    ]),
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const progress = await canvas.findByRole("region", {
      name: "Progress of Upgrade to format 3",
    })
    await waitFor(() =>
      expect(
        within(progress).getByText("Making the upgrade commits"),
      ).toBeVisible(),
    )
    expect(within(progress).getByText("Step 2 of 4")).toBeVisible()
    const bar = within(progress).getByRole("progressbar")
    expect(bar).toHaveAttribute("aria-valuenow", "25")
    expect(within(progress).getByText(/\d+ min \d+ s/)).toBeVisible()
    expect(within(progress).getByText(/You can leave this page/)).toBeVisible()
    expect(canvas.getByText("Preparing the pull request")).toBeVisible()
  },
}

/** A re-ingestion shows how many source repositories are done, and the one that it reads now. */
export const ReingestProgress: Story = {
  parameters: withUpgrades(
    upgradesFixture([
      upgradeItemFixture({
        kind: "reingest",
        title: "Fresh re-ingestion of the source repositories",
        status: "running",
        approvedAt: minutesAgo(7),
        repositories: [
          ["acme/api", "done"],
          ["acme/web", "pending"],
          ["acme/docs", "pending"],
        ].map(([repository, status]) => ({
          repository: repository as string,
          status: status as "done" | "pending",
          sha: null,
          runId: null,
          report: [],
          spendUsd: null,
          spendUnknown: false,
        })),
      }),
    ]),
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const progress = await canvas.findByRole("region", {
      name: /^Progress of Fresh re-ingestion/,
    })
    await waitFor(() =>
      expect(
        within(progress).getByText("1 of 3 repositories done"),
      ).toBeVisible(),
    )
    expect(within(progress).getByText("Now: acme/web")).toBeVisible()
    expect(canvas.getByText("Re-ingesting the sources")).toBeVisible()
    expect(canvas.queryByText("Preparing the pull request")).toBeNull()
    expect(within(progress).getByText(/7 min/)).toBeVisible()
    expect(within(progress).getByText(/You can leave this page/)).toBeVisible()
  },
}

/** A re-ingestion that plans its run has no count yet: the bar pulses. */
export const ReingestPlanning: Story = {
  parameters: withUpgrades(
    upgradesFixture([
      upgradeItemFixture({
        kind: "reingest",
        title: "Fresh re-ingestion of the source repositories",
        status: "running",
        approvedAt: minutesAgo(0.1),
      }),
    ]),
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(async () =>
      expect(await canvas.findByText("Planning the run")).toBeVisible(),
    )
    expect(canvas.getByRole("progressbar")).not.toHaveAttribute("aria-valuenow")
  },
}

/** ctxpipe saw the merge. The card says what it reads now and what comes next. */
export const MergedReadingFormat: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          // The first match wins: the role answers late, so the action shows after the card text.
          http.get(
            "*/.auth/api/v1/auth/organization/get-active-member-role",
            async () => {
              await delay(1_000)
              return HttpResponse.json({ role: "owner" })
            },
          ),
          ...withUpgrades(
            upgradesFixture(
              [
                upgradeItemFixture({
                  status: "pr_open",
                  pullRequest,
                  mergedAt: minutesAgo(2),
                  checkedAt: minutesAgo(2),
                }),
              ],
              { formatVersion: 2 },
            ),
          ).msw.handlers.page,
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const progress = await canvas.findByRole("region", {
      name: "Progress of Upgrade to format 3",
    })
    await waitFor(() =>
      expect(
        within(progress).getByText("Merged. Reading the new format…"),
      ).toBeVisible(),
    )
    expect(within(progress).getByText(/completes this upgrade/)).toBeVisible()
    expect(within(progress).getByText(/2 min/)).toBeVisible()
    expect(canvas.getByText("Merged. Reading the new format")).toBeVisible()
    // The "waits for you to merge" line is gone.
    expect(canvas.queryByText(/waits for you to merge/)).toBeNull()
    await waitFor(() =>
      expect(
        canvas.getByRole("button", { name: /^Check again/ }),
      ).toBeVisible(),
    )
  },
}

/** Check again shows that it ran, and what it found: the pull request is still open. */
export const CheckAgainStillOpen: Story = {
  parameters: withUpgrades(() =>
    upgradesFixture(
      [
        upgradeItemFixture({
          status: "pr_open",
          pullRequest,
          checkedAt: state.checked ? new Date().toISOString() : null,
        }),
      ],
      { formatVersion: 2 },
    ),
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      await canvas.findByRole("button", { name: /^Check again/ }),
    )
    await waitFor(() => expect(checkRequests).toHaveLength(1))
    // The same line shows on the card and in the toast.
    await waitFor(
      () =>
        expect(
          canvas.getAllByText(
            /Last check at .*Pull request #42 is still open on GitHub\. ctxpipe waits for the merge\./,
          ).length,
        ).toBeGreaterThan(0),
      { timeout: 10_000 },
    )
  },
}

/** Check again finds the merge: the card changes to the merged state. */
export const CheckAgainFindsMerge: Story = {
  parameters: withUpgrades(() =>
    upgradesFixture(
      [
        upgradeItemFixture({
          status: "pr_open",
          pullRequest,
          ...(state.checked
            ? {
                checkedAt: new Date().toISOString(),
                mergedAt: new Date().toISOString(),
              }
            : {}),
        }),
      ],
      { formatVersion: 2 },
    ),
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      await canvas.findByRole("button", { name: /^Check again/ }),
    )
    await waitFor(
      () =>
        expect(
          canvas.getByText("Merged. Reading the new format…"),
        ).toBeVisible(),
      { timeout: 10_000 },
    )
    expect(
      canvas.getAllByText(
        /The pull request merged\. ctxpipe is reading the new format\./,
      ).length,
    ).toBeGreaterThan(0)
  },
}

/** A failed check shows its cause and the next step. */
export const CheckAgainFails: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          activeMemberRoleHandler("owner"),
          workspaceUpgradesHandler(
            upgradesFixture([
              upgradeItemFixture({ status: "pr_open", pullRequest }),
            ]),
          ),
          http.post(/\/upgrades\/check$/, () =>
            HttpResponse.json({ error: "Server error" }, { status: 500 }),
          ),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      await canvas.findByRole("button", { name: /^Check again/ }),
    )
    await waitFor(async () =>
      expect(
        await within(document.body).findByText(
          /Press Check again to try again\./,
        ),
      ).toBeVisible(),
    )
  },
}

const checkingScope = "acme/docs/reingest-bundle"

const checkingFormatItem = upgradeItemFixture({
  key: "reingest-bundle",
  kind: "reingest",
  title: "Fresh re-ingestion of the source repositories",
  steps: [],
  status: "blocked",
  blockedReason: "needs_format",
  note: "Re-ingestion needs format 3. Merge the format upgrade first.",
})

/**
 * The scan after the hydrate never rewrites the item. This client saw the
 * checking state 59.5 s ago, so it ends within a second: the blocked line
 * comes back with the right control (CTX-949).
 */
function checkingFormatTimesOut(role: "owner" | "member"): Story {
  return {
    parameters: withUpgrades(
      upgradesFixture([checkingFormatItem], { formatVersion: 3 }),
      role,
    ),
    beforeEach: () => {
      checkingFormatExpired(checkingScope, false)
      checkingFormatExpired(checkingScope, true, Date.now() - 59_500)
      return () => {
        checkingFormatExpired(checkingScope, false)
      }
    },
    play: async ({ canvasElement }) => {
      const canvas = within(canvasElement)
      await waitFor(
        async () =>
          expect(
            await canvas.findByText("Apply the format upgrade first"),
          ).toBeVisible(),
        { timeout: 8_000 },
      )
      expect(
        canvas.getByText(
          "Re-ingestion needs format 3. Finish the format upgrade, then press Check again.",
        ),
      ).toBeVisible()
      expect(canvas.queryByText("Checking the new format")).toBeNull()
      expect(canvas.queryByText(/This page updates by itself/)).toBeNull()
      expect(canvas.getByText("Blocked")).toBeVisible()
      if (role === "owner")
        expect(
          canvas.getByRole("button", { name: /^Check again/ }),
        ).toBeVisible()
      else {
        expect(canvas.getByText("Ask an admin")).toBeVisible()
        expect(
          canvas.queryByRole("button", { name: /^Check again/ }),
        ).toBeNull()
      }
    },
  }
}

export const CheckingFormatTimesOutAdmin: Story =
  checkingFormatTimesOut("owner")

export const CheckingFormatTimesOutMember: Story =
  checkingFormatTimesOut("member")
