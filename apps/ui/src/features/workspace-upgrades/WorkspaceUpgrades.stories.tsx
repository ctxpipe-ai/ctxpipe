import { WRITE_STATUS_REASONS } from "backend/domain/workspaces/write-status"
import { HttpResponse, http } from "msw"
import { Toaster } from "sonner"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"

import {
  expectSkeletonMatchesLoaded,
  responseGate,
  SkeletonMatchFrame,
} from "@/components/ui/skeletonMatchStory"
import type { IngestionItem } from "@/features/workspaces/ingestion"
import { signedInHandlers } from "@/mocks/handlers"
import {
  ingestionItemFixture,
  workspaceIngestionHandlers,
} from "@/mocks/workspace-ingestion-handlers"
import { activeMemberRoleHandler } from "@/mocks/workspace-sources-handlers"
import {
  upgradeItemFixture,
  upgradesFixture,
  workspaceUpgradeAutomaticHandlers,
  workspaceUpgradeCheckHandler,
  workspaceUpgradeStartHandler,
  workspaceUpgradesHandler,
} from "@/mocks/workspace-upgrades-handlers"

import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import preview from "../../../.storybook/preview"
import type { WorkspaceUpgradeItem } from "./queries"
import { WorkspaceUpgrades } from "./WorkspaceUpgrades"

/**
 * The card has no upgrade row, and its header says "Up to date" (CTX-980).
 * Neither list shows.
 */
async function expectUpToDate(canvas: ReturnType<typeof within>) {
  await waitFor(() => expect(canvas.getByText("Up to date")).toBeVisible())
  expect(canvas.queryByRole("list", { name: "Needs you" })).toBeNull()
  expect(canvas.queryByRole("list", { name: "Working now" })).toBeNull()
}

/**
 * One list of the card has `count` upgrade rows. A screen reader reads the
 * kind of each row before its title. The header says no "Up to date" while a
 * row shows.
 */
async function expectGroup(
  canvas: ReturnType<typeof within>,
  group: "Needs you" | "Working now",
  count: number,
) {
  const list = await canvas.findByRole("list", { name: group })
  await waitFor(() =>
    expect(within(list).getAllByRole("heading", { level: 3 })).toHaveLength(
      count,
    ),
  )
  for (const heading of within(list).getAllByRole("heading", { level: 3 }))
    expect(heading).toHaveAccessibleName(
      group === "Needs you" ? /^(Needs you|Failed): / : /^Working: /,
    )
  expect(canvas.queryByText("Up to date")).toBeNull()
  return within(list)
}

const startRequests: string[] = []
const checkRequests: string[] = []
const automaticRequests: string[] = []
const state = { started: false, checked: false }
const setting: {
  mode: "manual" | "automatic" | null
  reason: "no_tip" | "invalid_format" | "unreadable" | null
} = { mode: "manual", reason: null }
const realDateNow = Date.now

const meta = preview.meta({
  title: "Components/Workspaces/Upgrades",
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
      activeMemberRoleHandler("owner"),
      workspaceUpgradesHandler(upgradesFixture([upgradeItemFixture()])),
      workspaceUpgradeStartHandler({ requests: startRequests }),
      workspaceUpgradeCheckHandler({ requests: checkRequests }),
      ...workspaceUpgradeAutomaticHandlers({
        requests: automaticRequests,
        setting,
      }),
    )
    startRequests.length = 0
    checkRequests.length = 0
    state.started = false
    state.checked = false
    automaticRequests.length = 0
    setting.mode = "manual"
    setting.reason = null
    return () => {
      Date.now = realDateNow
    }
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

/**
 * Upgrades card in the Workspace settings, where an admin starts format
 * upgrades and re-ingestions: the upgrade list still loads, so skeleton rows
 * hold its place.
 */
export const Loading = meta.story({
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(async () =>
      expect(await canvas.findByText("Loading upgrades")).toBeVisible(),
    )
    expect(canvas.queryByRole("button", { name: /^Start/ })).toBeNull()
    expect(canvas.queryByText("Up to date")).toBeNull()
    expect(canvas.queryByRole("switch")).toBeNull()
  },
  beforeEach: ({ msw }) => {
    msw.use(workspaceUpgradesHandler("loading"))
  },
})

/**
 * Upgrades section of a Workspace: the Workspace is at the newest format and no
 * upgrade is open.
 */
export const UpToDate = meta.story({
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expectUpToDate(canvas)
    await waitFor(() =>
      expect(canvas.getByText("Format 3, the latest")).toBeVisible(),
    )
    expect(
      canvas.getByRole("button", { name: "About the format" }),
    ).toBeVisible()
    expect(canvas.queryByRole("button", { name: /^Start/ })).toBeNull()
  },
  beforeEach: ({ msw }) => {
    msw.use(workspaceUpgradesHandler(upgradesFixture([], { formatVersion: 3 })))
  },
})

/**
 * Upgrades section of a Workspace: one format upgrade waits in the Needs you
 * list with its Start button. The Start button says that the item is ready, so
 * the item has no "Ready to start" tag.
 */
export const PurposeLine = meta.story({
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const needsYou = await expectGroup(canvas, "Needs you", 1)
    await waitFor(() =>
      expect(
        needsYou.getByRole("button", { name: "Start: Upgrade to format 3" }),
      ).toBeVisible(),
    )
    expect(canvas.queryByText("Ready to start")).toBeNull()
  },
})

/**
 * Upgrades section of a Workspace, for an admin: the admin pressed Start, and
 * the upgrade is queued. The item changes to its new status after the click.
 */
export const AdminStartsUpgrade = meta.story({
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expectGroup(canvas, "Needs you", 1)
    await waitFor(async () =>
      expect(canvas.getByText("Export and sources")).toBeVisible(),
    )
    expect(canvas.queryByText("Ask an admin")).toBeNull()
    await userEvent.click(
      await canvas.findByRole("button", {
        name: "Start: Upgrade to format 3",
      }),
    )
    await waitFor(() => expect(startRequests).toHaveLength(1))
    expect(startRequests[0]).toMatch(/\/upgrades\/format-3\/start$/)
    await waitFor(async () =>
      expect(await canvas.findByText("Queued")).toBeVisible(),
    )
    await expectGroup(canvas, "Working now", 1)
    expect(canvas.queryByRole("list", { name: "Needs you" })).toBeNull()
    await waitFor(() =>
      expect(canvas.queryByRole("button", { name: /^Start/ })).toBeNull(),
    )
  },
  beforeEach: ({ msw }) => {
    msw.use(
      activeMemberRoleHandler("admin"),
      workspaceUpgradesHandler(() =>
        upgradesFixture([
          upgradeItemFixture({
            status: state.started ? "queued" : "awaiting_operator",
          }),
        ]),
      ),
      workspaceUpgradeStartHandler({
        requests: startRequests,
        onStarted: () => {
          state.started = true
        },
      }),
    )
  },
})

/**
 * Upgrades section of a Workspace, for a member: a format upgrade waits, and
 * the member must ask an admin. The member sees "Ask an admin" and no Start
 * button.
 */
export const MemberAsksAdmin = meta.story({
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(async () =>
      expect(await canvas.findByText("Ask an admin")).toBeVisible(),
    )
    expect(canvas.queryByRole("button", { name: /^Start/ })).toBeNull()
    expect(startRequests).toHaveLength(0)
  },
  beforeEach: ({ msw }) => {
    msw.use(
      activeMemberRoleHandler("member"),
      workspaceUpgradesHandler(upgradesFixture([upgradeItemFixture()])),
      workspaceUpgradeStartHandler({ requests: startRequests }),
    )
  },
})

/** Upgrades section of a Workspace: a format upgrade is running. */
export const Running = meta.story({
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(async () =>
      expect(
        await canvas.findByText("Preparing the pull request"),
      ).toBeVisible(),
    )
    expect(canvas.queryByRole("button", { name: /^Start/ })).toBeNull()
  },
  beforeEach: ({ msw }) => {
    msw.use(
      workspaceUpgradesHandler(
        upgradesFixture([upgradeItemFixture({ status: "running" })]),
      ),
    )
  },
})

/**
 * Upgrades card in the Workspace settings: the admin started the re-ingestion,
 * but all sandbox slots are busy, so the item waits for a free one and says how
 * long it has waited (CTX-908).
 */
export const WaitingForSandbox = meta.story({
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(async () => {
      expect(
        await canvas.findByText("Waiting for a free sandbox"),
      ).toBeVisible()
      expect(await canvas.findByText(/has waited 12 min/)).toBeVisible()
    })
    await expectGroup(canvas, "Working now", 1)
    expect(canvas.queryByRole("list", { name: "Needs you" })).toBeNull()
    await waitFor(() =>
      expect(canvas.queryByText("Preparing the pull request")).toBeNull(),
    )
  },
  beforeEach: ({ msw }) => {
    msw.use(
      workspaceUpgradesHandler(
        // A re-ingestion runs only on format 3.
        upgradesFixture(
          [
            upgradeItemFixture({
              kind: "reingest",
              status: "running",
              waitingForSlot: {
                reason: "The re-ingestion slots of this instance are full.",
                since: new Date(Date.now() - 12 * 60_000 - 5_000).toISOString(),
              },
            }),
          ],
          { formatVersion: 3 },
        ),
      ),
    )
  },
})

/**
 * Upgrades section of a Workspace: a re-ingestion runs, with the Working
 * status, its progress, and the spend so far (CTX-980).
 */
export const ReingestWorkingWithSpend = meta.story({
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expectGroup(canvas, "Working now", 1)
    await waitFor(() =>
      expect(canvas.getByText("Spend so far: at least $1.75")).toBeVisible(),
    )
    await waitFor(() =>
      expect(canvas.getByText(/1 of 2 repositories done/)).toBeVisible(),
    )
    expect(canvas.queryByRole("list", { name: "Needs you" })).toBeNull()
  },
  beforeEach: ({ msw }) => {
    msw.use(
      workspaceUpgradesHandler(
        upgradesFixture(
          [
            upgradeItemFixture({
              key: "reingest-3",
              kind: "reingest",
              status: "running",
              approvedAt: new Date(Date.now() - 72 * 60_000).toISOString(),
              repositories: [
                {
                  repository: "acme/api",
                  sha: "abc1234",
                  runId: "run_1",
                  status: "done",
                  report: [],
                  spendUsd: 1.5,
                  spendUnknown: false,
                },
                {
                  repository: "acme/web",
                  sha: null,
                  runId: "run_2",
                  status: "pending",
                  report: [],
                  spendUsd: 0.25,
                  spendUnknown: true,
                },
              ],
            }),
          ],
          { formatVersion: 3 },
        ),
      ),
    )
  },
})

/**
 * Upgrades section of a Workspace: the format upgrade pull request is open,
 * with the step commits and the notes.
 */
export const PullRequestOpen = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(
      workspaceUpgradesHandler(
        upgradesFixture([
          upgradeItemFixture({
            status: "pr_open",
            pullRequest: {
              number: 42,
              url: "https://github.com/acme/docs/pull/42",
            },
            steps: [
              {
                format: 1,
                title: "Export and sources",
                commitSha: "a1b2c3d4e5f6",
                report: [
                  "Not moved: a Slack connection. It has no Workspace.",
                  "Kept 219 knowledge item(s) from https://gitlab.example.com/acme/legacy in `knowledge/`. Fresh ingestion reads only GitHub repositories, so it cannot make them again.",
                ],
                notices: [
                  {
                    kind: "risk",
                    text: "ctxpipe kept some knowledge as files, because fresh ingestion cannot make it again. Do not delete these files.",
                  },
                  {
                    kind: "action",
                    text: "Some connections did not move to this Workspace. Check the Sources of the Workspace after the merge.",
                  },
                ],
              },
              {
                format: 2,
                title: "Move the context files",
                commitSha: null,
                report: [],
              },
            ],
            note: "Merge the pull request to apply the upgrade.",
          }),
        ]),
      ),
    )
  },
  parameters: {
    visual: { allow: { axes: "A layout defect on main (CTX-1279)." } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(async () =>
      expect(await canvas.findByText("Waiting for merge")).toBeVisible(),
    )
    const link = await canvas.findByRole("link", { name: "Pull request #42" })
    await waitFor(() => expect(link).toBeVisible())
    expect(link).toHaveAttribute("href", "https://github.com/acme/docs/pull/42")
    await waitFor(async () => expect(canvas.getByText("a1b2c3d")).toBeVisible())
    await waitFor(async () =>
      expect(
        canvas.getByText("Merge the pull request to apply the upgrade."),
      ).toBeVisible(),
    )
    expect(canvas.queryByRole("button", { name: /^Start/ })).toBeNull()
  },
})

/**
 * Upgrades card in the Workspace settings: ctxpipe opened the format upgrade
 * pull request #42, so the item waits for the admin to merge it on GitHub. The
 * item says what happens after the merge and gives a link and Check again.
 */
export const WaitingForMerge = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(
      workspaceUpgradesHandler(
        upgradesFixture([
          upgradeItemFixture({
            status: "pr_open",
            pullRequest: {
              number: 42,
              url: "https://github.com/acme/docs/pull/42",
            },
          }),
        ]),
      ),
    )
  },
  parameters: {
    visual: { allow: { axes: "A layout defect on main (CTX-1279)." } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(async () =>
      expect(await canvas.findByText("Waiting for merge")).toBeVisible(),
    )
    await expectGroup(canvas, "Needs you", 1)
    await waitFor(() =>
      expect(
        canvas.getByText(
          /ctxpipe waits for you to merge pull request #42 on GitHub\. After the merge, ctxpipe reads the new format/,
        ),
      ).toBeVisible(),
    )
    await waitFor(() =>
      expect(
        canvas.getByRole("button", { name: /^Check again/ }),
      ).toBeVisible(),
    )
  },
})

/**
 * Upgrades section of a Workspace, for an admin: after the merge, the admin
 * pressed Check again, and the upgrade is applied. Check again runs the tip
 * check at once and waits for the scan.
 */
export const CheckAgainAfterMerge = meta.story({
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const button = await canvas.findByRole("button", { name: /^Check again/ })
    await userEvent.click(button)
    await waitFor(() => expect(checkRequests).toHaveLength(1))
    expect(checkRequests[0]).toMatch(/\/workspaces\/docs\/upgrades\/check$/)
    // The check waits for the scan, then the card shows the applied state.
    await waitFor(() => expectUpToDate(canvas), { timeout: 10_000 })
  },
  beforeEach: ({ msw }) => {
    msw.use(
      activeMemberRoleHandler("admin"),
      workspaceUpgradesHandler(() =>
        upgradesFixture(
          [
            upgradeItemFixture(
              state.checked
                ? { status: "completed" }
                : {
                    status: "pr_open",
                    pullRequest: {
                      number: 42,
                      url: "https://github.com/acme/docs/pull/42",
                    },
                  },
            ),
          ],
          // The applied upgrade wrote the new format.
          { formatVersion: state.checked ? 3 : 2 },
        ),
      ),
      workspaceUpgradeCheckHandler({
        requests: checkRequests,
        onChecked: () => {
          state.checked = true
        },
      }),
    )
  },
})

/**
 * Upgrades section of a Workspace, for a member: the upgrade pull request is
 * open, and there is no Check again button, because a member cannot run the
 * check.
 */
export const MemberCannotCheck = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(
      activeMemberRoleHandler("member"),
      workspaceUpgradesHandler(
        upgradesFixture([
          upgradeItemFixture({
            status: "pr_open",
            pullRequest: {
              number: 42,
              url: "https://github.com/acme/docs/pull/42",
            },
          }),
        ]),
      ),
    )
  },
  parameters: {
    visual: { allow: { axes: "A layout defect on main (CTX-1279)." } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(async () =>
      expect(await canvas.findByText("Waiting for merge")).toBeVisible(),
    )
    expect(canvas.queryByRole("button", { name: /^Check again/ })).toBeNull()
  },
})

/**
 * Upgrades section of a Workspace with an open upgrade pull request: the notes
 * list the actions and the risks, the action first, and the user opened
 * Details. The report lines, with their paths and counts, stay behind Details
 * until the user opens it.
 */
export const NotesWithDetails = meta.story({
  beforeEach: PullRequestOpen.input.beforeEach,
  parameters: {
    visual: { allow: { axes: "A layout defect on main (CTX-1279)." } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const notes = () =>
      within(canvas.getByRole("list", { name: "Notes of Upgrade to format 3" }))
    await waitFor(async () =>
      expect(await canvas.findByText("Waiting for merge")).toBeVisible(),
    )
    await waitFor(() =>
      expect(
        notes()
          .getAllByRole("listitem")
          .map((row) => row.textContent),
      ).toEqual([
        "Action: Some connections did not move to this Workspace. Check the Sources of the Workspace after the merge.",
        "Risk: ctxpipe kept some knowledge as files, because fresh ingestion cannot make it again. Do not delete these files.",
      ]),
    )
    await waitFor(() =>
      expect(canvas.getByRole("button", { name: "Details" })).toHaveAttribute(
        "aria-expanded",
        "false",
      ),
    )
    await waitFor(() =>
      expect(
        canvas.queryByText(
          "Not moved: a Slack connection. It has no Workspace.",
        ),
      ).not.toBeVisible(),
    )

    await userEvent.click(
      await canvas.findByRole("button", { name: "Details" }),
    )
    await waitFor(() =>
      expect(
        canvas.getByText("Not moved: a Slack connection. It has no Workspace."),
      ).toBeVisible(),
    )
    await waitFor(() =>
      expect(canvas.getByText(/^Kept 219 knowledge item/)).toBeVisible(),
    )
    await waitFor(() =>
      expect(canvas.getByText("Format 1: Export and sources")).toBeVisible(),
    )
  },
})

/**
 * Upgrades section of a Workspace: the format upgrade failed because GitHub
 * refused the push, with Start again.
 */
export const Failed = meta.story({
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(async () =>
      expect(await canvas.findByText("The upgrade failed")).toBeVisible(),
    )
    await expectGroup(canvas, "Needs you", 1)
    await waitFor(async () =>
      expect(
        canvas.getByText("GitHub refused the push to the upgrade branch."),
      ).toBeVisible(),
    )
    await userEvent.click(
      await canvas.findByRole("button", {
        name: "Start again: Upgrade to format 3",
      }),
    )
    await waitFor(() => expect(startRequests).toHaveLength(1))
  },
  beforeEach: ({ msw }) => {
    msw.use(
      workspaceUpgradesHandler(
        upgradesFixture([
          upgradeItemFixture({
            status: "failed",
            failureReason: "GitHub refused the push to the upgrade branch.",
          }),
        ]),
      ),
    )
  },
})

/** A failed re-ingestion item with a classified cause (CTX-895). */
function failedReingest(
  failure: NonNullable<WorkspaceUpgradeItem["failure"]>,
  autoRetried = false,
) {
  return workspaceUpgradesHandler(
    // A re-ingestion runs only on format 3.
    upgradesFixture(
      [
        upgradeItemFixture({
          key: "reingest-3",
          kind: "reingest",
          status: "failed",
          failureReason:
            "The re-ingestion did not finish for acme/ky. Start it again.",
          failure,
          autoRetried,
        }),
      ],
      { formatVersion: 3 },
    ),
  )
}

const REINGEST_START =
  "Start again: Fresh re-ingestion of the source repositories"

/**
 * Upgrades section of a Workspace: a re-ingestion failed, because another run
 * published first and the merge failed (CTX-895). The item names the failed
 * step and gives one sentence for the fix.
 */
export const FailedPublishConflict = meta.story({
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(async () =>
      expect(
        await canvas.findByText(
          "Failed step: Publish to the Workspace (acme/ky).",
        ),
      ).toBeVisible(),
    )
    expect(
      canvas.getByText(
        "The Workspace changed while ctxpipe published, and ctxpipe could not merge the files.",
      ),
    ).toBeVisible()
    expect(
      canvas.getByText(/^Details: The semantic merge failed/),
    ).toBeVisible()
    // The fix is one sentence: no second "start it again".
    expect(canvas.getAllByText(/start it again/i)).toHaveLength(1)
    await userEvent.click(
      await canvas.findByRole("button", { name: REINGEST_START }),
    )
    await waitFor(() => expect(startRequests).toHaveLength(1))
  },
  beforeEach: ({ msw }) => {
    msw.use(
      failedReingest({
        code: "publish_conflict",
        step: "publish",
        repository: "acme/ky",
        summary:
          "The semantic merge failed: The model did not call the structured output tool",
      }),
    )
  },
})

/**
 * Upgrades section of a Workspace: a re-ingestion failed again after ctxpipe
 * started it again once by itself, and the card says so (CTX-896).
 */
export const FailedAfterAutoRetry = meta.story({
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(() =>
      expect(
        canvas.getByText(
          "ctxpipe already started this upgrade again once by itself.",
        ),
      ).toBeVisible(),
    )
  },
  beforeEach: ({ msw }) => {
    msw.use(
      failedReingest(
        {
          code: "model",
          step: "ingest",
          repository: "acme/ky",
          summary: "The ingestion run failed: the model provider is overloaded",
        },
        true,
      ),
    )
  },
})

/**
 * Upgrades card in the Workspace settings, seen by an admin: the re-ingestion
 * failed because ctxpipe cannot read the source repository acme/ky, so the item
 * gives the cause, Reconnect GitHub and Start again.
 */
export const FailedSourceAccess = meta.story({
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const link = await canvas.findByRole("link", { name: "Reconnect GitHub" })
    expect(link).toHaveAttribute("href", "/acme/connectors")
    // The title names the kind of the item that failed.
    expect(canvas.getByText("The re-ingestion failed")).toBeVisible()
    expect(canvas.queryByText("The upgrade failed")).toBeNull()
    expect(
      canvas.getByText("Failed step: Read the source repository (acme/ky)."),
    ).toBeVisible()
    // The user fixes the access, then starts it again.
    await waitFor(() =>
      expect(
        canvas.getByRole("button", { name: REINGEST_START }),
      ).toBeVisible(),
    )
  },
  beforeEach: ({ msw }) => {
    msw.use(
      failedReingest({
        code: "source_access",
        step: "read_source",
        repository: "acme/ky",
        summary:
          "ctxpipe cannot read the default branch of the repository. Repository not found.",
      }),
    )
  },
})

const tooManySources = {
  code: "too_many_sources",
  step: "plan",
  repository: null,
  summary:
    "The Workspace has 40 source repositories. One re-ingestion run handles at most 25.",
} as const

/**
 * Upgrades section of a Workspace, for an admin: a re-ingestion failed, because
 * the Workspace has too many source repositories. The card gives the cause and
 * the fix (remove some sources first), then Start again.
 */
export const FailedTooManySources = meta.story({
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(async () =>
      expect(
        await canvas.findByText(
          "The Workspace has more source repositories than one re-ingestion handles.",
        ),
      ).toBeVisible(),
    )
    expect(
      canvas.getByText(
        "Remove some source repositories from the Workspace, then start it again.",
      ),
    ).toBeVisible()
    await waitFor(() =>
      expect(
        canvas.getByRole("button", { name: REINGEST_START }),
      ).toBeVisible(),
    )
    expect(startRequests).toHaveLength(0)
  },
  beforeEach: ({ msw }) => {
    msw.use(failedReingest(tooManySources))
  },
})

/**
 * Upgrades card in the Workspace settings, seen by a member: the re-ingestion
 * failed, because the Workspace has 40 source repositories and a run takes 25.
 * Only an admin can start it again, so the member gets "Ask an admin".
 */
export const FailedTooManySourcesMember = meta.story({
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(async () =>
      expect(await canvas.findByText("Ask an admin")).toBeVisible(),
    )
    expect(canvas.queryByRole("button", { name: /^Start/ })).toBeNull()
  },
  beforeEach: ({ msw }) => {
    msw.use(
      activeMemberRoleHandler("member"),
      workspaceUpgradesHandler(
        // A re-ingestion runs only on format 3.
        upgradesFixture(
          [
            upgradeItemFixture({
              key: "reingest-3",
              kind: "reingest",
              status: "failed",
              failureReason: "One re-ingestion run handles at most 25.",
              failure: tooManySources,
            }),
          ],
          { formatVersion: 3 },
        ),
      ),
    )
  },
})

const fixPrompts = fn()

/**
 * Upgrades section of a Workspace: a re-ingestion failed with an unknown cause,
 * and the user can fix it with an agent.
 */
export const FailedUnknown = meta.story({
  args: { onFixWithAgent: fixPrompts },
  play: async ({ canvasElement }) => {
    fixPrompts.mockClear()
    const canvas = within(canvasElement)
    await userEvent.click(
      await canvas.findByRole("button", { name: "Fix using agent" }),
    )
    expect(fixPrompts).toHaveBeenCalledWith(
      'The upgrade "Fresh re-ingestion of the source repositories" of this Workspace failed at the step "Ingest the source repository (acme/ky)". ctxpipe recorded: The ingestion run failed: something odd happened. Find the cause, and tell me how to fix it.',
    )
  },
  beforeEach: ({ msw }) => {
    msw.use(
      failedReingest({
        code: "unknown",
        step: "ingest",
        repository: "acme/ky",
        summary: "The ingestion run failed: something odd happened",
      }),
    )
  },
})

/**
 * Upgrades section of a Workspace: a re-ingestion failed, because the server
 * had no room for a Git process, so Start again is the fix (CTX-952).
 */
export const FailedServerBusy = meta.story({
  args: { onFixWithAgent: fixPrompts },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(async () =>
      expect(
        await canvas.findByText(
          "The server was busy and could not start a Git process for this upgrade.",
        ),
      ).toBeVisible(),
    )
    await waitFor(() =>
      expect(
        canvas.getByRole("button", { name: /^Start again/ }),
      ).toBeVisible(),
    )
  },
  beforeEach: ({ msw }) => {
    msw.use(
      failedReingest({
        code: "server_busy",
        step: "ingest",
        repository: "acme/ky",
        summary: "spawn EAGAIN",
      }),
    )
  },
})

/**
 * Upgrades card in the Workspace settings: ctxpipe cannot open the format
 * upgrade pull request because the GitHub App has read access only, so the item
 * is blocked with no Start.
 */
export const Blocked = meta.story({
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(async () =>
      expect(
        await canvas.findByText("ctxpipe cannot open the upgrade pull request"),
      ).toBeVisible(),
    )
    await waitFor(async () =>
      expect(
        canvas.getByText("The GitHub App has read access only."),
      ).toBeVisible(),
    )
    await expectGroup(canvas, "Needs you", 1)
    expect(canvas.queryByRole("button", { name: /^Start/ })).toBeNull()
  },
  beforeEach: ({ msw }) => {
    msw.use(
      workspaceUpgradesHandler(
        upgradesFixture([
          upgradeItemFixture({
            status: "blocked",
            blockedReason: "write_access",
            note: "The GitHub App has read access only.",
          }),
        ]),
      ),
    )
  },
})

/**
 * Upgrades card in the Workspace settings: the Workspace repository is not on
 * GitHub, so ctxpipe cannot open the format upgrade pull request, and the item
 * says to relink to GitHub. The note names the cause and has no GitHub App
 * text.
 */
export const BlockedNotGithub = meta.story({
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(async () =>
      expect(
        await canvas.findByText(/This remote is not GitHub/),
      ).toBeVisible(),
    )
    expect(canvas.queryByText(/Connect the Workspace repository/)).toBeNull()
  },
  beforeEach: ({ msw }) => {
    msw.use(
      workspaceUpgradesHandler(
        upgradesFixture([
          upgradeItemFixture({
            status: "blocked",
            blockedReason: "write_access",
            note: WRITE_STATUS_REASONS.nonGithubHost,
          }),
        ]),
      ),
    )
  },
})

/**
 * Upgrades section of a Workspace: the format upgrade is blocked with no reason
 * or note from the server. The alert still says why, and it has no empty line.
 */
export const BlockedWithoutReason = meta.story({
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(async () =>
      expect(await canvas.findByText("The upgrade cannot start")).toBeVisible(),
    )
    await waitFor(() =>
      expect(
        canvas.getByText("ctxpipe cannot start this item now."),
      ).toBeVisible(),
    )
  },
  beforeEach: ({ msw }) => {
    msw.use(
      workspaceUpgradesHandler(
        upgradesFixture([upgradeItemFixture({ status: "blocked" })]),
      ),
    )
  },
})

/**
 * A blocked re-ingestion item, with no note from the server. The Workspace is
 * on format 2, so the block is current. `formatVersion` 3 would be the state
 * between the hydrate and the scan (see ReingestChecksNewFormat).
 */
function blockedReingest(blockedReason: string, formatVersion = 2) {
  return workspaceUpgradesHandler(
    upgradesFixture(
      [
        upgradeItemFixture({
          key: "reingest-bundle",
          kind: "reingest",
          title: "Fresh re-ingestion of the source repositories",
          steps: [],
          status: "blocked",
          blockedReason,
        }),
      ],
      { formatVersion },
    ),
  )
}

/** The re-ingestion card never uses the pull request copy of a format upgrade. */
async function expectReingestCard(canvasElement: HTMLElement, title: string) {
  const canvas = within(canvasElement)
  await waitFor(async () =>
    expect(await canvas.findByText(title)).toBeVisible(),
  )
  await waitFor(() =>
    expect(
      canvas.getByText(/Ingests each source repository again/),
    ).toBeVisible(),
  )
  expect(canvas.queryByText(/opens one pull request/)).toBeNull()
  return canvas
}

/**
 * Upgrades section of a Workspace: the re-ingestion is blocked because ctxpipe
 * cannot publish to the repository.
 */
export const ReingestBlockedOnWriteAccess = meta.story({
  play: async ({ canvasElement }) => {
    const canvas = await expectReingestCard(
      canvasElement,
      "ctxpipe cannot publish the re-ingestion",
    )
    await waitFor(() =>
      expect(
        canvas.getByText(/write access through the GitHub App to publish/),
      ).toBeVisible(),
    )
  },
  beforeEach: ({ msw }) => {
    msw.use(blockedReingest("write_access"))
  },
})

/**
 * Upgrades card in the Workspace settings: the Workspace has format 2, so the
 * re-ingestion is blocked until the format upgrade to format 3 is merged, with
 * Check again.
 */
export const ReingestNeedsFormat = meta.story({
  play: async ({ canvasElement }) => {
    const canvas = await expectReingestCard(
      canvasElement,
      "Apply the format upgrade first",
    )
    await waitFor(() =>
      expect(canvas.getByText(/Re-ingestion needs format 3/)).toBeVisible(),
    )
  },
  beforeEach: ({ msw }) => {
    msw.use(blockedReingest("needs_format"))
  },
})

/**
 * Upgrades section of a Workspace: the re-ingestion is blocked on the format,
 * with one short next step. The server note names two actions, so the card does
 * not use it.
 */
export const ReingestBlockedNextStep = meta.story({
  play: async ({ canvasElement }) => {
    const canvas = await expectReingestCard(
      canvasElement,
      "Apply the format upgrade first",
    )
    await waitFor(() =>
      expect(
        canvas.getByText(
          "Re-ingestion needs format 3. Finish the format upgrade, then press Check again.",
        ),
      ).toBeVisible(),
    )
    expect(canvas.queryByText(/Next step/)).toBeNull()
    await userEvent.click(canvas.getByRole("button", { name: /^Check again/ }))
    await waitFor(() => expect(checkRequests).toHaveLength(1))
  },
  beforeEach: ({ msw }) => {
    msw.use(blockedReingest("needs_format"))
  },
})

/**
 * Upgrades section of a Workspace: ctxpipe checks the new format for the
 * re-ingestion, and then the item becomes ready to start with no refresh. While
 * the check runs, the item has no blocked warning (CTX-944).
 */
export const ReingestChecksNewFormat = meta.story({
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(async () =>
      expect(await canvas.findByText("Checking the new format")).toBeVisible(),
    )
    expect(canvas.getByText(/ctxpipe is checking the new format/)).toBeVisible()
    expect(canvas.getByText("Format 3, the latest")).toBeVisible()
    // ctxpipe checks by itself: nobody must act.
    await expectGroup(canvas, "Working now", 1)
    expect(canvas.queryByRole("list", { name: "Needs you" })).toBeNull()
    expect(canvas.queryByText("Apply the format upgrade first")).toBeNull()
    expect(canvas.queryByText(/Merge the format upgrade/)).toBeNull()
    // The scan finishes. The page reads again, with no refresh.
    state.checked = true
    await waitFor(
      async () =>
        expect(
          await canvas.findByRole("button", { name: /^Start/ }),
        ).toBeVisible(),
      { timeout: 8_000 },
    )
    expect(canvas.queryByText("Checking the new format")).toBeNull()
    // The item waits for a person now: the Start button says it.
    await expectGroup(canvas, "Needs you", 1)
    expect(canvas.queryByText("Ready to start")).toBeNull()
  },
  beforeEach: ({ msw }) => {
    msw.use(
      activeMemberRoleHandler("owner"),
      workspaceUpgradesHandler(() =>
        upgradesFixture(
          [
            upgradeItemFixture({
              key: "reingest-bundle",
              kind: "reingest",
              title: "Fresh re-ingestion of the source repositories",
              steps: [],
              status: state.checked ? "awaiting_operator" : "blocked",
              blockedReason: state.checked ? null : "needs_format",
              note: state.checked
                ? null
                : "Re-ingestion needs format 3. Merge the format upgrade first.",
            }),
          ],
          { formatVersion: 3 },
        ),
      ),
      workspaceUpgradeStartHandler({ requests: startRequests }),
      workspaceUpgradeCheckHandler({ requests: checkRequests }),
    )
  },
})

/**
 * Upgrades section of a Workspace: the re-ingestion is blocked because this
 * deployment cannot run it.
 */
export const ReingestSandboxUnavailable = meta.story({
  play: async ({ canvasElement }) => {
    const canvas = await expectReingestCard(
      canvasElement,
      "This deployment cannot run the re-ingestion",
    )
    await waitFor(() =>
      expect(canvas.getByText(/no ingest sandbox/)).toBeVisible(),
    )
  },
  beforeEach: ({ msw }) => {
    msw.use(blockedReingest("sandbox_unavailable"))
  },
})

/**
 * Upgrades section of a Workspace: ctxpipe has not read a valid format file at
 * the tip yet, so the re-ingestion is in Working now with no warning. The wait
 * is on ctxpipe, not on a person.
 */
export const ReingestIngestionV2Off = meta.story({
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const working = await expectGroup(canvas, "Working now", 1)
    expect(working.getByText("Waiting")).toBeVisible()
    expect(working.getByText(/valid format file/)).toBeVisible()
    expect(
      canvas.queryByText("The re-ingestion cannot run here yet"),
    ).toBeNull()
  },
  beforeEach: ({ msw }) => {
    msw.use(blockedReingest("ingestion_v2_off"))
  },
})

/**
 * Upgrades section of a read-only Workspace below format 3: the format upgrade
 * and the re-ingestion are both blocked. The format card names the cause, and
 * the re-ingestion gives one action.
 */
export const ReadOnlyBelowFormat = meta.story({
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(() =>
      expect(
        canvas.getByText("ctxpipe cannot open the upgrade pull request"),
      ).toBeVisible(),
    )
    await waitFor(() =>
      expect(canvas.getByText("Apply the format upgrade first")).toBeVisible(),
    )
    await expectGroup(canvas, "Needs you", 2)
    // The format card names the cause. The re-ingestion says one action.
    expect(
      canvas.getByText(/needs write access through the GitHub App/),
    ).toBeVisible()
    expect(canvas.getByText(/Finish the format upgrade/)).toBeVisible()
    expect(canvas.queryByRole("button", { name: /^Start/ })).toBeNull()
  },
  beforeEach: ({ msw }) => {
    msw.use(
      workspaceUpgradesHandler(
        upgradesFixture([
          upgradeItemFixture({
            status: "blocked",
            blockedReason: "write_access",
            note: "ctxpipe needs write access through the GitHub App to open the upgrade pull request.",
          }),
          upgradeItemFixture({
            key: "reingest-bundle",
            kind: "reingest",
            title: "Fresh re-ingestion of the source repositories",
            steps: [],
            status: "blocked",
            blockedReason: "needs_format",
            note: "Re-ingestion needs format 3. ctxpipe needs write access through the GitHub App to open the format upgrade pull request.",
          }),
        ]),
      ),
    )
  },
})

/**
 * Upgrades section of a Workspace that is up to date: an applied upgrade is in
 * the History list, and the user opened History and the upgrade row. History
 * starts collapsed, so at first the section says only that the repository is up
 * to date.
 */
export const HistoryWithAppliedUpgrade = meta.story({
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expectUpToDate(canvas)
    const history = "History · 1 applied, last on Oct 16"
    await waitFor(() =>
      expect(canvas.getByRole("button", { name: history })).toHaveAttribute(
        "aria-expanded",
        "false",
      ),
    )
    await waitFor(() =>
      expect(
        canvas.queryByRole("list", { name: "Applied upgrades" }),
      ).toBeNull(),
    )
    expect(canvas.queryByRole("button", { name: /^Start/ })).toBeNull()

    await userEvent.click(canvas.getByRole("button", { name: history }))
    const applied = within(
      await canvas.findByRole("list", { name: "Applied upgrades" }),
    )
    expect(applied.getAllByRole("listitem")).toHaveLength(1)
    // The row is collapsed: the description and the steps wait for a press.
    const row = applied.getByRole("button", { name: /Upgrade to format 3$/ })
    expect(row).toHaveAttribute("aria-expanded", "false")
    await waitFor(() =>
      expect(
        canvas.queryByText(/Moves the repository links/),
      ).not.toBeVisible(),
    )
    await userEvent.click(row)
    await waitFor(() => expect(row).toHaveAttribute("aria-expanded", "true"))
    await waitFor(() =>
      expect(canvas.getByText(/Moves the repository links/)).toBeVisible(),
    )
    expect(
      canvas.getByRole("list", { name: "Steps of Upgrade to format 3" }),
    ).toBeVisible()
  },
  beforeEach: ({ msw }) => {
    msw.use(
      workspaceUpgradesHandler(
        upgradesFixture([upgradeItemFixture({ status: "completed" })], {
          formatVersion: 3,
        }),
      ),
    )
  },
})

/** Upgrades section of a Workspace: the upgrades failed to load. */
export const LoadError = meta.story({
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(async () =>
      expect(
        await canvas.findByText("Could not load the upgrades."),
      ).toBeVisible(),
    )
    await waitFor(async () =>
      expect(canvas.getByRole("button", { name: "Try again" })).toBeVisible(),
    )
  },
  beforeEach: ({ msw }) => {
    msw.use(workspaceUpgradesHandler("error"))
  },
})

/**
 * Upgrades section of a Workspace: a re-ingestion card says what it does to the
 * Workspace repository, with no cost or time estimate. The range of the
 * estimate was too wide to help (CTX-894).
 */
export const DescriptionWithoutEstimate = meta.story({
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(async () =>
      expect(
        await canvas.findByText(
          /publishes the new knowledge files under knowledge\//,
        ),
      ).toBeVisible(),
    )
    await waitFor(async () =>
      expect(
        await canvas.findByText(/into \.ctxpipe\/sources\.yaml/),
      ).toBeVisible(),
    )
    await waitFor(() => expect(canvas.queryByText(/Estimated cost/)).toBeNull())
  },
  beforeEach: ({ msw }) => {
    msw.use(
      workspaceUpgradesHandler(
        upgradesFixture([
          upgradeItemFixture({
            key: "reingest",
            title: "Fresh re-ingestion of the source repositories",
            description:
              "Ingests each source repository again with the new ingestion and publishes the new knowledge files under knowledge/. This uses model calls, so it costs money.",
            steps: [],
            kind: "reingest",
            estimate: {
              repositories: 1,
              costUsd: { low: 0.28, high: 3.36 },
              minutes: { low: 10, high: 92 },
              perRepository: [],
            },
          }),
          upgradeItemFixture(),
        ]),
      ),
    )
  },
})

/**
 * Upgrades section of a Workspace: the server refused the start (409), so a
 * toast gives the reason, and the card keeps its Start button because nothing
 * was queued.
 */
export const StartRefused = meta.story({
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      await canvas.findByRole("button", {
        name: "Start: Upgrade to format 3",
      }),
    )
    await waitFor(() => expect(startRequests).toHaveLength(1))
    await waitFor(async () =>
      expect(await canvas.findByText("The upgrade is blocked")).toBeVisible(),
    )
    // The card keeps its Start button: nothing was queued.
    await waitFor(() =>
      expect(
        canvas.getByRole("button", { name: "Start: Upgrade to format 3" }),
      ).toBeEnabled(),
    )
  },
  beforeEach: ({ msw }) => {
    msw.use(
      activeMemberRoleHandler("owner"),
      workspaceUpgradesHandler(upgradesFixture([upgradeItemFixture()])),
      workspaceUpgradeStartHandler({
        requests: startRequests,
        answer: 409,
      }),
    )
  },
})

/**
 * Upgrades section of a Workspace: the user role never loads, so neither Start
 * nor "Ask an admin" is visible.
 */
export const RoleNeverAnswers = meta.story({
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expectGroup(canvas, "Needs you", 1)
    expect(canvas.queryByRole("button", { name: /^Start/ })).toBeNull()
    expect(canvas.queryByText("Ask an admin")).toBeNull()
  },
  beforeEach: ({ msw }) => {
    msw.use(
      activeMemberRoleHandler("loading"),
      workspaceUpgradesHandler(upgradesFixture([upgradeItemFixture()])),
      workspaceUpgradeStartHandler({ requests: startRequests }),
    )
  },
})

/**
 * Upgrades section of a Workspace: the format check of a re-ingestion ended
 * after a minute, so the item moved from Working now to Needs you. One clock
 * drives both lists, so the row moves in one render (CTX-980). The play moves
 * the page clock a minute ahead.
 */
export const CheckingEndsAfterAMinute = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(
      workspaceUpgradesHandler(
        upgradesFixture(
          [
            upgradeItemFixture({
              key: "reingest-bundle",
              kind: "reingest",
              title: "Fresh re-ingestion of the source repositories",
              steps: [],
              status: "blocked",
              blockedReason: "needs_format",
            }),
          ],
          { formatVersion: 3 },
        ),
      ),
    )
  },
  // An own Workspace: the minute counts from the first sight of this item.
  args: { workspaceSlug: "docs-clock" },
  parameters: {
    visual: {
      skip: "Behavior test: it ends in the state of Upgrades/Progress, Checking Format Times Out Admin.",
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expectGroup(canvas, "Working now", 1)
    expect(canvas.getByText("Checking the new format")).toBeVisible()
    const start = realDateNow()
    Date.now = () => realDateNow() - start + start + 61_000
    // The clock ticks each second: the next tick shows the change.
    await waitFor(
      () =>
        expect(canvas.getByRole("list", { name: "Needs you" })).toBeVisible(),
      { timeout: 5_000 },
    )
    // No await between the two checks: the card changed in the same render.
    const needsYou = within(canvas.getByRole("list", { name: "Needs you" }))
    expect(needsYou.getByText("Blocked")).toBeVisible()
    // The Workspace has format 3, so the block does not ask for the format
    // upgrade again (upgradeBlockedCopy).
    expect(
      needsYou.getByText("ctxpipe did not finish the format check"),
    ).toBeVisible()
    expect(canvas.queryByText("Checking the new format")).toBeNull()
    expect(canvas.queryByRole("list", { name: "Working now" })).toBeNull()
  },
})

/**
 * Upgrades section of a Workspace: the format file is not valid, so the card
 * needs a person and names the fix, also with no upgrade item. The amber edge
 * of the card marks that it needs a person, and the automatic upgrades line
 * offers no button.
 */
export const InvalidFormatFile = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(
      workspaceUpgradesHandler(upgradesFixture([], { formatVersion: -1 })),
    )
    setting.mode = null
    setting.reason = "invalid_format"
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(() =>
      expect(
        canvas.getByText(/The format file in the repository is not valid\./),
      ).toBeVisible(),
    )
    // No row shows, and the header does not say "Up to date". The amber edge
    // of the card says that it needs a person.
    expect(canvas.queryByText("Up to date")).toBeNull()
    expect(canvas.queryByRole("list", { name: "Needs you" })).toBeNull()
    expect(canvas.getByRole("region", { name: "Upgrades" })).toHaveClass(
      "border-l-amber-400/70",
    )
    // ctxpipe cannot read the setting from a file that is not valid: the
    // line names the cause and the fix, and offers no button.
    await waitFor(() =>
      expect(
        canvas.getByText(
          "Automatic upgrades: the format file .ctxpipe/workspace.yaml is not valid. Fix it on the default branch.",
        ),
      ).toBeVisible(),
    )
    expect(canvas.queryByRole("switch")).toBeNull()
  },
})

/**
 * Upgrades section of a Workspace: the format pull request merged, and ctxpipe
 * has not read the new format yet. The re-ingestion waits for it, so the
 * Working now list has both rows.
 */
export const MergedFormatWithReingestWaiting = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(
      workspaceUpgradesHandler(
        upgradesFixture(
          [
            upgradeItemFixture({
              status: "pr_open",
              pullRequest: {
                number: 5,
                url: "https://github.com/acme/docs/pull/5",
              },
              mergedAt: "2026-10-16T10:00:00.000Z",
            }),
            upgradeItemFixture({
              key: "reingest-bundle",
              kind: "reingest",
              title: "Fresh re-ingestion of the source repositories",
              steps: [],
              status: "blocked",
              blockedReason: "needs_format",
              note: "Re-ingestion needs format 3. Merge the format upgrade first.",
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
    const working = await expectGroup(canvas, "Working now", 2)
    expect(
      working.getByRole("heading", { name: "Working: Upgrade to format 3" }),
    ).toBeVisible()
    expect(
      working.getByRole("heading", {
        name: "Working: Fresh re-ingestion of the source repositories",
      }),
    ).toBeVisible()
    expect(working.getByText("Waiting")).toBeVisible()
    expect(
      working.getByText(
        "This starts after ctxpipe reads the format upgrade above.",
      ),
    ).toBeVisible()
    expect(canvas.queryByRole("list", { name: "Needs you" })).toBeNull()
    expect(canvas.queryByText("Apply the format upgrade first")).toBeNull()
  },
})

/**
 * Upgrades section of a Workspace, for an owner: the owner turned the automatic
 * upgrades switch on and then off again (CTX-980). The line under the switch
 * says who starts each upgrade.
 */
export const AutomaticUpgradesOnAndOff = meta.story({
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const automatic = () =>
      canvas.getByRole("switch", { name: "Automatic upgrades" })
    await waitFor(() => expect(automatic()).not.toBeChecked())
    expect(automatic()).toBeEnabled()
    expect(
      canvas.getByText(
        "You start each upgrade. Turn this on to let ctxpipe start them.",
      ),
    ).toBeVisible()
    await userEvent.click(automatic())
    await waitFor(() => expect(automatic()).toBeChecked())
    await waitFor(() =>
      expect(
        canvas.getByText(
          "ctxpipe starts each upgrade by itself, paid re-ingestions too. A failed upgrade waits for you.",
        ),
      ).toBeVisible(),
    )
    await waitFor(async () =>
      expect(
        await within(document.body).findByText(
          "Automatic upgrades are on. ctxpipe starts each upgrade by itself.",
        ),
      ).toBeVisible(),
    )
    await userEvent.click(automatic())
    await waitFor(() => expect(automatic()).not.toBeChecked())
    await waitFor(() =>
      expect(
        canvas.getByText(
          "You start each upgrade. Turn this on to let ctxpipe start them.",
        ),
      ).toBeVisible(),
    )
    expect(automaticRequests.filter((line) => line.startsWith("POST"))).toEqual(
      [
        "POST /acme/api/v1/workspaces/docs/upgrades/automatic automatic",
        "POST /acme/api/v1/workspaces/docs/upgrades/automatic manual",
      ],
    )
  },
  beforeEach: ({ msw }) => {
    msw.use(workspaceUpgradesHandler(upgradesFixture([], { formatVersion: 3 })))
  },
})

/**
 * Upgrades section of a Workspace, for a member: the automatic upgrades switch
 * is visible but disabled, because only an owner or admin can change it.
 */
export const MemberSeesAutomaticUpgrades = meta.story({
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(() =>
      expect(
        canvas.getByRole("switch", { name: "Automatic upgrades" }),
      ).toBeDisabled(),
    )
    expect(
      canvas.getByRole("switch", { name: "Automatic upgrades" }),
    ).not.toBeChecked()
    expect(
      canvas.getByText(
        "An owner or admin starts each upgrade, and can turn this on.",
      ),
    ).toBeVisible()
  },
  beforeEach: ({ msw }) => {
    msw.use(
      activeMemberRoleHandler("member"),
      workspaceUpgradesHandler(upgradesFixture([], { formatVersion: 3 })),
      ...workspaceUpgradeAutomaticHandlers({ setting }),
    )
  },
})

/**
 * Upgrades section of a Workspace: the loading skeleton and the up to date
 * state side by side, at the same size. The skeleton has the box of the Up to
 * date state (DESIGN.md Loading, Match).
 */
export const SkeletonMatchesLoaded = meta.story({
  render: () => (
    <SkeletonMatchFrame
      skeleton={<WorkspaceUpgrades orgSlug="acme" workspaceSlug="loading" />}
      loaded={<WorkspaceUpgrades orgSlug="acme" workspaceSlug="docs" />}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(() =>
      expect(
        within(canvas.getByTestId("loaded-box")).getByRole("switch", {
          name: "Automatic upgrades",
        }),
      ).toBeVisible(),
    )
    expect(canvas.getByText("Loading upgrades")).toBeInTheDocument()
    await expectSkeletonMatchesLoaded(canvasElement)
  },
  beforeEach: ({ msw }) => {
    msw.use(
      workspaceUpgradesHandler("loading", "loading"),
      workspaceUpgradesHandler(
        upgradesFixture([], { formatVersion: 3 }),
        "docs",
      ),
    )
  },
})

/** The automatic-upgrades setting answers when the play releases this gate. */
const settingGate = responseGate()
/** The upgrade list adds its path when it answers. */
const listAnswered: string[] = []

/**
 * Upgrades section of a Workspace: the upgrade list loads before the
 * automatic-upgrades setting, and the card keeps its skeleton until both have
 * loaded. A card without the switch row is 22 px lower, and its growth moved
 * the scroll position of the settings pane (CTX-1466).
 */
export const SkeletonWaitsForSetting = meta.story({
  parameters: {
    visual: { skip: "Behavior test: it ends in the same state as UpToDate." },
  },
  beforeEach: ({ msw }) => {
    msw.use(
      activeMemberRoleHandler("owner"),
      workspaceUpgradesHandler(
        upgradesFixture([], { formatVersion: 3 }),
        undefined,
        listAnswered,
      ),
      http.get(
        ({ request }) =>
          new URL(request.url).pathname.endsWith("/upgrades/automatic"),
        async () => {
          await settingGate.wait()
          return HttpResponse.json({ mode: "manual", reason: null })
        },
      ),
    )
    listAnswered.length = 0
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(() => expect(listAnswered).toHaveLength(1))
    // The response reaches the page, and the card renders the list.
    for (let frame = 0; frame < 5; frame++)
      await new Promise((next) => requestAnimationFrame(next))
    expect(canvas.getByText("Loading upgrades")).toBeInTheDocument()
    expect(canvas.queryByText("Format 3, the latest")).toBeNull()
    await settingGate.release()
    await waitFor(() =>
      expect(
        canvas.getByRole("switch", { name: "Automatic upgrades" }),
      ).toBeVisible(),
    )
    await expectUpToDate(canvas)
  },
})

/** The Upgrades card of a Workspace that ingests sources (CTX-980). */
function withIngestion(
  upgrades: ReturnType<typeof workspaceUpgradesHandler>,
  items: IngestionItem[],
) {
  return [upgrades, ...workspaceIngestionHandlers({ docs: items })]
}

/**
 * Upgrades section of a Workspace while source ingestion runs: no upgrade is
 * open, so the card says Up to date. Sources show their own runs in the Sources
 * card, so the Upgrades card shows no run.
 */
export const IngestionWorking = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(
      ...withIngestion(
        workspaceUpgradesHandler(upgradesFixture([], { formatVersion: 3 })),
        [ingestionItemFixture()],
      ),
    )
  },
  parameters: {
    visual: { skip: "Behavior test: it ends in the same state as UpToDate." },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expectUpToDate(canvas)
    expect(canvas.queryByRole("list", { name: "Ingesting now" })).toBeNull()
    expect(canvas.queryByText("acme/web")).toBeNull()
  },
})

/**
 * Upgrades section of a Workspace while source ingestion runs: a format upgrade
 * needs the user, and it is the only item. The card shows no ingestion run.
 */
export const IngestionWhileUpgradeNeedsYou = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(
      ...withIngestion(
        workspaceUpgradesHandler(upgradesFixture([upgradeItemFixture()])),
        [ingestionItemFixture()],
      ),
    )
  },
  parameters: {
    visual: {
      skip: "Behavior test: it ends in the same state as PurposeLine.",
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expectGroup(canvas, "Needs you", 1)
    expect(canvas.queryByRole("list", { name: "Ingesting now" })).toBeNull()
    expect(canvas.queryByText("acme/web")).toBeNull()
  },
})
