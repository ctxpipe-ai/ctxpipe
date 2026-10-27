import type { Meta, StoryObj } from "@storybook/react-vite"
import { delay, http } from "msw"
import { Toaster } from "sonner"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"

import {
  expectSkeletonMatchesLoaded,
  SkeletonMatchFrame,
} from "@/components/ui/skeletonMatchStory"
import type { IngestionItem } from "@/features/workspaces/ingestion"
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

import { entryPageInnerDecorators } from "../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
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

const meta = {
  title: "Components/Workspaces/Upgrades",
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
    layout: "fullscreen",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug: "acme",
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        page: [
          activeMemberRoleHandler("owner"),
          workspaceUpgradesHandler(upgradesFixture([upgradeItemFixture()])),
          workspaceUpgradeStartHandler({ requests: startRequests }),
          workspaceUpgradeCheckHandler({ requests: checkRequests }),
          ...workspaceUpgradeAutomaticHandlers({
            requests: automaticRequests,
            setting,
          }),
        ],
      },
    },
  },
  args: { orgSlug: "acme", workspaceSlug: "docs" },
} satisfies Meta<typeof WorkspaceUpgrades>

export default meta

type Story = StoryObj<typeof meta>

function withUpgrades(
  ...handlers: ReturnType<typeof workspaceUpgradesHandler>[]
) {
  return {
    msw: {
      handlers: {
        page: [
          activeMemberRoleHandler("owner"),
          ...handlers,
          workspaceUpgradeStartHandler({ requests: startRequests }),
          workspaceUpgradeCheckHandler({ requests: checkRequests }),
          ...workspaceUpgradeAutomaticHandlers({
            requests: automaticRequests,
            setting,
          }),
        ],
      },
    },
  }
}

export const Loading: Story = {
  parameters: withUpgrades(workspaceUpgradesHandler("loading")),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(async () =>
      expect(await canvas.findByText("Loading upgrades")).toBeVisible(),
    )
    expect(canvas.queryByRole("button", { name: /^Start/ })).toBeNull()
    expect(canvas.queryByText("Up to date")).toBeNull()
    expect(canvas.queryByRole("switch")).toBeNull()
  },
}

export const UpToDate: Story = {
  parameters: withUpgrades(
    workspaceUpgradesHandler(upgradesFixture([], { formatVersion: 3 })),
  ),
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
}

/**
 * An item that waits for a person is in the Needs you list. Its Start button
 * says that it is ready: it has no "Ready to start" tag.
 */
export const PurposeLine: Story = {
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
}

/** An admin sees Start. The click queues the item and shows the new status. */
export const AdminStartsUpgrade: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
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
        ],
      },
    },
  },
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
}

/** A member sees "Ask an admin" and no Start button. */
export const MemberAsksAdmin: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          activeMemberRoleHandler("member"),
          workspaceUpgradesHandler(upgradesFixture([upgradeItemFixture()])),
          workspaceUpgradeStartHandler({ requests: startRequests }),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(async () =>
      expect(await canvas.findByText("Ask an admin")).toBeVisible(),
    )
    expect(canvas.queryByRole("button", { name: /^Start/ })).toBeNull()
    expect(startRequests).toHaveLength(0)
  },
}

export const Running: Story = {
  parameters: withUpgrades(
    workspaceUpgradesHandler(
      upgradesFixture([upgradeItemFixture({ status: "running" })]),
    ),
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(async () =>
      expect(
        await canvas.findByText("Preparing the pull request"),
      ).toBeVisible(),
    )
    expect(canvas.queryByRole("button", { name: /^Start/ })).toBeNull()
  },
}

/** A re-ingestion that waits for a free sandbox slot (CTX-908). */
export const WaitingForSandbox: Story = {
  parameters: withUpgrades(
    workspaceUpgradesHandler(
      upgradesFixture([
        upgradeItemFixture({
          kind: "reingest",
          title: "Ingest the source repositories again",
          status: "running",
          waitingForSlot: {
            reason: "The re-ingestion slots of this instance are full.",
            since: new Date(Date.now() - 12 * 60_000 - 5_000).toISOString(),
          },
        }),
      ]),
    ),
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(async () => {
      expect(
        await canvas.findByText("Waiting for a free sandbox"),
      ).toBeVisible()
      expect(await canvas.findByText(/for 12 min\./)).toBeVisible()
    })
    await expectGroup(canvas, "Working now", 1)
    expect(canvas.queryByRole("list", { name: "Needs you" })).toBeNull()
    await waitFor(() =>
      expect(canvas.queryByText("Preparing the pull request")).toBeNull(),
    )
  },
}

/** A re-ingestion that runs: Working, its progress, and the spend so far (CTX-980). */
export const ReingestWorkingWithSpend: Story = {
  parameters: withUpgrades(
    workspaceUpgradesHandler(
      upgradesFixture(
        [
          upgradeItemFixture({
            key: "reingest-3",
            kind: "reingest",
            title: "Ingest the source repositories again",
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
  ),
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
}

/** The pull request is open. The step commits and the notes show. */
export const PullRequestOpen: Story = {
  parameters: withUpgrades(
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
  ),
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
}

/** The open item says what it waits for and what happens after the merge. */
export const WaitingForMerge: Story = {
  parameters: withUpgrades(
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
  ),
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
}

/** Check again runs the tip check now. The card then shows the applied state. */
export const CheckAgainAfterMerge: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
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
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const button = await canvas.findByRole("button", { name: /^Check again/ })
    await userEvent.click(button)
    await waitFor(() => expect(checkRequests).toHaveLength(1))
    expect(checkRequests[0]).toMatch(/\/workspaces\/docs\/upgrades\/check$/)
    // The check waits for the scan, then the card shows the applied state.
    await waitFor(() => expectUpToDate(canvas), { timeout: 10_000 })
  },
}

/** A member cannot run the check. The card gives no button. */
export const MemberCannotCheck: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
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
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(async () =>
      expect(await canvas.findByText("Waiting for merge")).toBeVisible(),
    )
    expect(canvas.queryByRole("button", { name: /^Check again/ })).toBeNull()
  },
}

/**
 * The card shows only the actions and the risks, the action first. The
 * report lines, with their paths and counts, stay behind Details until the
 * user opens it.
 */
export const NotesWithDetails: Story = {
  parameters: PullRequestOpen.parameters,
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
}

export const Failed: Story = {
  parameters: withUpgrades(
    workspaceUpgradesHandler(
      upgradesFixture([
        upgradeItemFixture({
          status: "failed",
          failureReason: "GitHub refused the push to the upgrade branch.",
        }),
      ]),
    ),
  ),
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
}

/** A failed re-ingestion item with a classified cause (CTX-895). */
function failedReingest(
  failure: NonNullable<WorkspaceUpgradeItem["failure"]>,
  autoRetried = false,
) {
  return withUpgrades(
    workspaceUpgradesHandler(
      upgradesFixture([
        upgradeItemFixture({
          key: "reingest-3",
          kind: "reingest",
          title: "Fresh re-ingestion of the source repositories",
          status: "failed",
          steps: [],
          failureReason:
            "The re-ingestion did not finish for acme/ky. Start it again.",
          failure,
          autoRetried,
        }),
      ]),
    ),
  )
}

const REINGEST_START =
  "Start again: Fresh re-ingestion of the source repositories"

/** The CTX-895 case: another run published first, and the merge failed. */
export const FailedPublishConflict: Story = {
  parameters: failedReingest({
    code: "publish_conflict",
    step: "publish",
    repository: "acme/ky",
    summary:
      "The semantic merge failed: The model did not call the structured output tool",
  }),
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
}

/** CTX-896: the automatic retry failed too, so the card says that ctxpipe started it again once. */
export const FailedAfterAutoRetry: Story = {
  parameters: failedReingest(
    {
      code: "model",
      step: "ingest",
      repository: "acme/ky",
      summary: "The ingestion run failed: the model provider is overloaded",
    },
    true,
  ),
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
}

export const FailedSourceAccess: Story = {
  parameters: failedReingest({
    code: "source_access",
    step: "read_source",
    repository: "acme/ky",
    summary:
      "ctxpipe cannot read the default branch of the repository. Repository not found.",
  }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const link = await canvas.findByRole("link", { name: "Reconnect GitHub" })
    expect(link).toHaveAttribute("href", "/acme/connectors")
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
}

const tooManySources = {
  code: "too_many_sources",
  step: "plan",
  repository: null,
  summary:
    "The Workspace has 40 source repositories. One re-ingestion run handles at most 25.",
} as const

/**
 * The admin removes sources first. The card shows the cause and the fix, then
 * Start again for the admin.
 */
export const FailedTooManySources: Story = {
  parameters: failedReingest(tooManySources),
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
}

/** A member of the org keeps "Ask an admin" for that failure. */
export const FailedTooManySourcesMember: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          activeMemberRoleHandler("member"),
          workspaceUpgradesHandler(
            upgradesFixture([
              upgradeItemFixture({
                key: "reingest-3",
                kind: "reingest",
                title: "Fresh re-ingestion of the source repositories",
                status: "failed",
                steps: [],
                failureReason: "One re-ingestion run handles at most 25.",
                failure: tooManySources,
              }),
            ]),
          ),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(async () =>
      expect(await canvas.findByText("Ask an admin")).toBeVisible(),
    )
    expect(canvas.queryByRole("button", { name: /^Start/ })).toBeNull()
  },
}

const fixPrompts = fn()

export const FailedUnknown: Story = {
  args: { onFixWithAgent: fixPrompts },
  parameters: failedReingest({
    code: "unknown",
    step: "ingest",
    repository: "acme/ky",
    summary: "The ingestion run failed: something odd happened",
  }),
  play: async ({ canvasElement }) => {
    fixPrompts.mockClear()
    const canvas = within(canvasElement)
    await userEvent.click(
      await canvas.findByRole("button", { name: "Fix using agent" }),
    )
    expect(fixPrompts).toHaveBeenCalledWith(
      'The upgrade "Fresh re-ingestion of the source repositories" of this Workspace failed at the step "Ingest the source repository (acme/ky)". ctxpipe recorded: The ingestion run failed: something odd happened Find the cause, and tell me how to fix it.',
    )
  },
}

/** CTX-952: the server had no room for a Git process, so starting again is the fix. */
export const FailedServerBusy: Story = {
  args: { onFixWithAgent: fixPrompts },
  parameters: failedReingest({
    code: "server_busy",
    step: "ingest",
    repository: "acme/ky",
    summary: "spawn EAGAIN",
  }),
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
}

export const Blocked: Story = {
  parameters: withUpgrades(
    workspaceUpgradesHandler(
      upgradesFixture([
        upgradeItemFixture({
          status: "blocked",
          blockedReason: "write_access",
          note: "The GitHub App has read access only.",
        }),
      ]),
    ),
  ),
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
}

/** A remote that is not GitHub: the note names the cause, with no GitHub App text. */
export const BlockedNotGithub: Story = {
  parameters: withUpgrades(
    workspaceUpgradesHandler(
      upgradesFixture([
        upgradeItemFixture({
          status: "blocked",
          blockedReason: "write_access",
          note: "This remote is not GitHub. v1 can hydrate, search, and chat, but cannot commit or push. Relink to a GitHub repository the App can write.",
        }),
      ]),
    ),
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(async () =>
      expect(
        await canvas.findByText(/This remote is not GitHub/),
      ).toBeVisible(),
    )
    expect(canvas.queryByText(/Connect the Workspace repository/)).toBeNull()
  },
}

/** No reason and no note: the alert still says why, with no empty line. */
export const BlockedWithoutReason: Story = {
  parameters: withUpgrades(
    workspaceUpgradesHandler(
      upgradesFixture([upgradeItemFixture({ status: "blocked" })]),
    ),
  ),
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
}

/**
 * A blocked re-ingestion item, with no note from the server. The Workspace is
 * on format 2, so the block is current. `formatVersion` 3 would be the state
 * between the hydrate and the scan (see ReingestChecksNewFormat).
 */
function blockedReingest(blockedReason: string, formatVersion = 2) {
  return withUpgrades(
    workspaceUpgradesHandler(
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

export const ReingestBlockedOnWriteAccess: Story = {
  parameters: blockedReingest("write_access"),
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
}

export const ReingestNeedsFormat: Story = {
  parameters: blockedReingest("needs_format"),
  play: async ({ canvasElement }) => {
    const canvas = await expectReingestCard(
      canvasElement,
      "Apply the format upgrade first",
    )
    await waitFor(() =>
      expect(canvas.getByText(/Re-ingestion needs format 3/)).toBeVisible(),
    )
  },
}

/**
 * The block is short and has one action. The server note names two actions,
 * so the card does not show it.
 */
export const ReingestBlockedNextStep: Story = {
  parameters: blockedReingest("needs_format"),
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
}

/**
 * CTX-944. The hydrate read the new format, and the scan has not yet changed
 * the re-ingestion. The page shows one state: the item says that ctxpipe checks
 * the new format, and it has no blocked warning. The page reads the items
 * again by itself, so the item becomes ready to start with no refresh.
 */
export const ReingestChecksNewFormat: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
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
        ],
      },
    },
  },
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
}

export const ReingestSandboxUnavailable: Story = {
  parameters: blockedReingest("sandbox_unavailable"),
  play: async ({ canvasElement }) => {
    const canvas = await expectReingestCard(
      canvasElement,
      "This deployment cannot run the re-ingestion",
    )
    await waitFor(() =>
      expect(canvas.getByText(/no ingest sandbox/)).toBeVisible(),
    )
  },
}

/**
 * ctxpipe has not read a valid format file at the tip yet: a wait on ctxpipe,
 * so the item is in Working now with no warning.
 */
export const ReingestIngestionV2Off: Story = {
  parameters: blockedReingest("ingestion_v2_off"),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const working = await expectGroup(canvas, "Working now", 1)
    expect(working.getByText("Waiting")).toBeVisible()
    expect(working.getByText(/valid format file/)).toBeVisible()
    expect(
      canvas.queryByText("The re-ingestion cannot run here yet"),
    ).toBeNull()
  },
}

/** A read-only Workspace below format 3: the format item and the re-ingestion are both blocked. */
export const ReadOnlyBelowFormat: Story = {
  parameters: withUpgrades(
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
  ),
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
}

/**
 * An applied upgrade leaves the list. It waits in History, which starts
 * collapsed, so the section says only that the repository is up to date.
 */
export const HistoryWithAppliedUpgrade: Story = {
  parameters: withUpgrades(
    workspaceUpgradesHandler(
      upgradesFixture([upgradeItemFixture({ status: "completed" })], {
        formatVersion: 3,
      }),
    ),
  ),
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
}

export const LoadError: Story = {
  parameters: withUpgrades(workspaceUpgradesHandler("error")),
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
}

/**
 * The card says what the upgrade does to the Workspace repository. It shows
 * no cost or time estimate: the range was too wide to help (CTX-894).
 */
export const DescriptionWithoutEstimate: Story = {
  parameters: withUpgrades(
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
  ),
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
}

/** The server refuses the start (409). The card shows the reason in a toast. */
export const StartRefused: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          activeMemberRoleHandler("owner"),
          workspaceUpgradesHandler(upgradesFixture([upgradeItemFixture()])),
          workspaceUpgradeStartHandler({
            requests: startRequests,
            answer: 409,
          }),
        ],
      },
    },
  },
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
}

/** The role never answers. Neither Start nor "Ask an admin" shows. */
export const RoleNeverAnswers: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          http.get(
            "*/.auth/api/v1/auth/organization/get-active-member-role",
            async () => {
              await delay("infinite")
            },
          ),
          workspaceUpgradesHandler(upgradesFixture([upgradeItemFixture()])),
          workspaceUpgradeStartHandler({ requests: startRequests }),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expectGroup(canvas, "Needs you", 1)
    expect(canvas.queryByRole("button", { name: /^Start/ })).toBeNull()
    expect(canvas.queryByText("Ask an admin")).toBeNull()
  },
}

/**
 * CTX-980. The checking state ends after a minute. The row moves from Working
 * now to Needs you in one render: one clock drives both lists. The clock of
 * the page jumps a minute ahead, and the next tick shows the change.
 */
export const CheckingEndsAfterAMinute: Story = {
  // An own Workspace: the minute counts from the first sight of this item.
  args: { workspaceSlug: "docs-clock" },
  parameters: withUpgrades(
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
  ),
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
    expect(needsYou.getByText("Apply the format upgrade first")).toBeVisible()
    expect(canvas.queryByText("Checking the new format")).toBeNull()
    expect(canvas.queryByRole("list", { name: "Working now" })).toBeNull()
  },
}

/** A format file that ctxpipe cannot read needs a person, also with no item. */
export const InvalidFormatFile: Story = {
  beforeEach: () => {
    setting.mode = null
    setting.reason = "invalid_format"
  },
  parameters: withUpgrades(
    workspaceUpgradesHandler(upgradesFixture([], { formatVersion: -1 })),
  ),
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
}

/**
 * The format pull request is merged, and ctxpipe has not read the new format
 * yet. The re-ingestion waits for it: it is in Working now with the format
 * upgrade, and the Working now list has both rows.
 */
export const MergedFormatWithReingestWaiting: Story = {
  parameters: withUpgrades(
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
  ),
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
}

/** An owner or admin turns automatic upgrades on with the switch, then off again (CTX-980). */
export const AutomaticUpgradesOnAndOff: Story = {
  parameters: withUpgrades(
    workspaceUpgradesHandler(upgradesFixture([], { formatVersion: 3 })),
  ),
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
}

/** A member sees the setting and cannot change it: the switch is disabled. */
export const MemberSeesAutomaticUpgrades: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          activeMemberRoleHandler("member"),
          workspaceUpgradesHandler(upgradesFixture([], { formatVersion: 3 })),
          ...workspaceUpgradeAutomaticHandlers({ setting }),
        ],
      },
    },
  },
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
}

/** The skeleton has the box of the Up to date state (DESIGN.md Loading, Match). */
export const SkeletonMatchesLoaded: Story = {
  parameters: withUpgrades(
    workspaceUpgradesHandler("loading", "loading"),
    workspaceUpgradesHandler(upgradesFixture([], { formatVersion: 3 }), "docs"),
  ),
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
}

/** The Upgrades card of a Workspace that ingests sources (CTX-980). */
function withIngestion(
  upgrades: ReturnType<typeof workspaceUpgradesHandler>,
  items: IngestionItem[],
) {
  const parameters = withUpgrades(upgrades)
  return {
    msw: {
      handlers: {
        ...parameters.msw.handlers,
        ingestion: workspaceIngestionHandlers({ docs: items }),
      },
    },
  }
}

/**
 * Ingestion runs and no upgrade is open: the card says "Up to date". Sources
 * show their own runs in the Sources card, so the Upgrades card shows none.
 */
export const IngestionWorking: Story = {
  parameters: withIngestion(
    workspaceUpgradesHandler(upgradesFixture([], { formatVersion: 3 })),
    [ingestionItemFixture()],
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expectUpToDate(canvas)
    expect(canvas.queryByRole("list", { name: "Ingesting now" })).toBeNull()
    expect(canvas.queryByText("acme/web")).toBeNull()
  },
}

/** An upgrade needs the user while ingestion runs: the card shows the upgrade only. */
export const IngestionWhileUpgradeNeedsYou: Story = {
  parameters: withIngestion(
    workspaceUpgradesHandler(upgradesFixture([upgradeItemFixture()])),
    [ingestionItemFixture()],
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expectGroup(canvas, "Needs you", 1)
    expect(canvas.queryByRole("list", { name: "Ingesting now" })).toBeNull()
    expect(canvas.queryByText("acme/web")).toBeNull()
  },
}
