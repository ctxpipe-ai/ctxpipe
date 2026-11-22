import type { StoryContext } from "@storybook/react-vite"
import { HttpResponse, http } from "msw"
import { Toaster } from "sonner"
import { expect, userEvent, waitFor, within } from "storybook/test"

import { signedInHandlers } from "@/mocks/handlers"
import { activeMemberRoleHandler } from "@/mocks/workspace-sources-handlers"
import {
  upgradeItemFixture,
  upgradesFixture,
  workspaceUpgradeAutomaticHandlers,
  workspaceUpgradeCheckHandler,
  workspaceUpgradesHandler,
} from "@/mocks/workspace-upgrades-handlers"

import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import preview from "../../../.storybook/preview"
import { checkingFormatExpired } from "./checking-format-clock"
import { WorkspaceUpgrades } from "./WorkspaceUpgrades"

const checkRequests: string[] = []
const state = { checked: false }
// The play of MergedReadingFormat opens this gate after it asserts the card
// text. Then the role answers, and the play waits for the action.
let answerRole = () => {}

const minutesAgo = (minutes: number) =>
  new Date(Date.now() - minutes * 60_000).toISOString()

const pullRequest = {
  number: 42,
  url: "https://github.com/acme/docs/pull/42",
}

const meta = preview.meta({
  title: "Components/Workspaces/Upgrades/Progress",
  component: WorkspaceUpgrades,
  decorators: [
    (Story) => (
      <div className="max-w-2xl bg-zinc-950 p-6">
        <Story />
        <Toaster />
      </div>
    ),
  ],
  beforeEach: ({ msw }) => {
    msw.use(
      ...signedInHandlers,
      // Upgrades wait for a start by hand.
      ...workspaceUpgradeAutomaticHandlers(),
    )
    checkRequests.length = 0
    state.checked = false
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
  args: { orgSlug: "acme", workspaceSlug: "docs" },
})

function withUpgrades(
  upgrades: Parameters<typeof workspaceUpgradesHandler>[0],
  role: "owner" | "member" = "owner",
) {
  return [
    activeMemberRoleHandler(role),
    workspaceUpgradesHandler(upgrades),
    workspaceUpgradeCheckHandler({
      requests: checkRequests,
      onChecked: () => {
        state.checked = true
      },
    }),
  ]
}

/**
 * Progress card of a Workspace format upgrade: the run is queued and has not
 * started a stage. The card gives the time so far and tells the user that they
 * can leave the page.
 */
export const Queued = meta.story({
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
  beforeEach: ({ msw }) => {
    msw.use(
      ...withUpgrades(
        upgradesFixture([
          upgradeItemFixture({ status: "queued", approvedAt: minutesAgo(0.2) }),
        ]),
      ),
    )
  },
})

/**
 * Progress card of a Workspace format upgrade: the run is in its second stage,
 * with the step, the progress bar, the time so far, and the note that the user
 * can leave the page.
 */
export const RunningStage = meta.story({
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
  beforeEach: ({ msw }) => {
    msw.use(
      ...withUpgrades(
        upgradesFixture([
          upgradeItemFixture({
            status: "running",
            approvedAt: minutesAgo(1.3),
            runStage: { name: "build", since: minutesAgo(1) },
          }),
        ]),
      ),
    )
  },
})

/**
 * Progress card of a Workspace re-ingestion: one of three source repositories
 * is done, and the card names the repository that ctxpipe reads now.
 */
export const ReingestProgress = meta.story({
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
  beforeEach: ({ msw }) => {
    msw.use(
      ...withUpgrades(
        // A re-ingestion runs only on format 3.
        upgradesFixture(
          [
            upgradeItemFixture({
              kind: "reingest",
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
          ],
          { formatVersion: 3 },
        ),
      ),
    )
  },
})

/**
 * Re-ingestion item in the Upgrades card, seconds after the admin pressed
 * Start: ctxpipe plans the run and has no repository count yet, so the progress
 * bar pulses with no value.
 */
export const ReingestPlanning = meta.story({
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(async () =>
      expect(await canvas.findByText("Planning the run")).toBeVisible(),
    )
    expect(canvas.getByRole("progressbar")).not.toHaveAttribute("aria-valuenow")
  },
  beforeEach: ({ msw }) => {
    msw.use(
      ...withUpgrades(
        // A re-ingestion runs only on format 3.
        upgradesFixture(
          [
            upgradeItemFixture({
              kind: "reingest",
              status: "running",
              approvedAt: minutesAgo(0.1),
            }),
          ],
          { formatVersion: 3 },
        ),
      ),
    )
  },
})

/**
 * Format upgrade item in the Upgrades card: the admin merged the upgrade pull
 * request two minutes ago, so a progress block says that ctxpipe reads the new
 * format, how long it has taken, and what comes next.
 */
export const MergedReadingFormat = meta.story({
  beforeEach: ({ msw }) => {
    const roleGate = new Promise<void>((resolve) => {
      answerRole = resolve
    })
    msw.use(
      // The first match wins: the role answers only when the play opens the
      // gate, so the action shows after the card text.
      http.get(
        "*/.auth/api/v1/auth/organization/get-active-member-role",
        async () => {
          await roleGate
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
          // ctxpipe has not read the new format yet: the Workspace
          // still has the format that the upgrade starts from.
          { formatVersion: 0 },
        ),
      ),
    )
  },
  parameters: {
    visual: { allow: { axes: "A layout defect on main (CTX-1279)." } },
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
    // The progress block names the state, so the line above it says only
    // when ctxpipe checked last.
    expect(canvas.getByText(/^Last check at [^.]+\.$/)).toBeVisible()
    expect(canvas.queryByText("Merged. Reading the new format")).toBeNull()
    // The "waits for you to merge" line is gone.
    expect(canvas.queryByText(/waits for you to merge/)).toBeNull()
    expect(canvas.queryByRole("button", { name: /^Check again/ })).toBeNull()
    answerRole()
    await waitFor(() =>
      expect(
        canvas.getByRole("button", { name: /^Check again/ }),
      ).toBeVisible(),
    )
  },
})

/**
 * Progress card of a Workspace format upgrade: the user pressed Check again,
 * and the pull request is still open. The card and a toast both say that the
 * check ran and what it found.
 */
export const CheckAgainStillOpen = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(
      ...withUpgrades(() =>
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
    )
  },
  parameters: {
    visual: { allow: { axes: "A layout defect on main (CTX-1279)." } },
  },
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
})

/**
 * Progress card of a Workspace format upgrade: the user pressed Check again,
 * and it found the merge, so the card changed to the merged state.
 */
export const CheckAgainFindsMerge = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(
      ...withUpgrades(() =>
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
    )
  },
  parameters: {
    visual: { allow: { axes: "A layout defect on main (CTX-1279)." } },
  },
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
})

/**
 * Progress card of a Workspace format upgrade: the user pressed Check again,
 * and the check failed. A message gives the cause and the next step.
 */
export const CheckAgainFails = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(
      activeMemberRoleHandler("owner"),
      workspaceUpgradesHandler(
        upgradesFixture([
          upgradeItemFixture({ status: "pr_open", pullRequest }),
        ]),
      ),
      http.post(/\/upgrades\/check$/, () =>
        HttpResponse.json({ error: "Server error" }, { status: 500 }),
      ),
    )
  },
  parameters: {
    visual: { allow: { axes: "A layout defect on main (CTX-1279)." } },
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
})

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
function checkingFormatTimesOut(role: "owner" | "member") {
  return {
    beforeEach: ({ msw }: StoryContext) => {
      msw.use(
        ...withUpgrades(
          upgradesFixture([checkingFormatItem], { formatVersion: 3 }),
          role,
        ),
      )
      checkingFormatExpired(checkingScope, false)
      checkingFormatExpired(checkingScope, true, Date.now() - 59_500)
      return () => {
        checkingFormatExpired(checkingScope, false)
      }
    },
    play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
      const canvas = within(canvasElement)
      await waitFor(
        async () =>
          expect(
            await canvas.findByText("ctxpipe did not finish the format check"),
          ).toBeVisible(),
        { timeout: 8_000 },
      )
      // The Workspace has format 3, so the block does not ask for the
      // format upgrade again.
      expect(
        canvas.getByText(
          "The Workspace has format 3 now, but this item did not see it yet. Press Check again.",
        ),
      ).toBeVisible()
      expect(canvas.queryByText(/Finish the format upgrade/)).toBeNull()
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

/**
 * Re-ingestion item in the Upgrades card, seen by an owner: the Workspace has
 * format 3, but the check after the hydrate did not finish in a minute, so a
 * stale block asks for Check again.
 */
export const CheckingFormatTimesOutAdmin = meta.story(
  checkingFormatTimesOut("owner"),
)

/**
 * Re-ingestion card in the Upgrades section, for a member: the format check
 * timed out, so the blocked line comes back with no Check again.
 */
export const CheckingFormatTimesOutMember = meta.story(
  checkingFormatTimesOut("member"),
)
