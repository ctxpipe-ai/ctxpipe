import type { Meta, StoryObj } from "@storybook/react-vite"
import { delay, http } from "msw"
import { Toaster } from "sonner"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"
import { activeMemberRoleHandler } from "@/mocks/workspace-sources-handlers"
import {
  upgradeItemFixture,
  upgradesFixture,
  workspaceUpgradeCheckHandler,
  workspaceUpgradeStartHandler,
  workspaceUpgradesHandler,
} from "@/mocks/workspace-upgrades-handlers"
import { entryPageInnerDecorators } from "../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import type { WorkspaceUpgradeItem } from "./queries"
import { WorkspaceUpgrades } from "./WorkspaceUpgrades"

const startRequests: string[] = []
const checkRequests: string[] = []
const state = { started: false, checked: false }

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
    expect(canvas.queryByText("No upgrades are pending.")).toBeNull()
  },
}

export const UpToDate: Story = {
  parameters: withUpgrades(
    workspaceUpgradesHandler(upgradesFixture([], { formatVersion: 3 })),
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(async () =>
      expect(await canvas.findByText("No upgrades are pending.")).toBeVisible(),
    )
    await waitFor(async () =>
      expect(
        canvas.getByText("The repository uses format 3. It is up to date."),
      ).toBeVisible(),
    )
    expect(canvas.queryByRole("button", { name: /^Start/ })).toBeNull()
  },
}

/** The section says in one line what an upgrade is and when it applies. */
export const PurposeLine: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(async () =>
      expect(await canvas.findByText("Ready to start")).toBeVisible(),
    )
    await waitFor(() =>
      expect(
        canvas.getByText(
          "Upgrades move your Workspace repository to the layout that this version of ctxpipe reads. Nothing changes until you merge the pull request.",
        ),
      ).toBeVisible(),
    )
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
    await waitFor(async () =>
      expect(await canvas.findByText("Ready to start")).toBeVisible(),
    )
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
    await waitFor(() =>
      expect(canvas.queryByText("Preparing the pull request")).toBeNull(),
    )
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
    const link = canvas.getByRole("link", { name: "Pull request #42" })
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
    await waitFor(() =>
      expect(
        canvas.getByText(
          /ctxpipe waits for you to merge pull request #42 on GitHub\. After the merge, ctxpipe reads the new format/,
        ),
      ).toBeVisible(),
    )
    expect(canvas.getByRole("button", { name: /^Check again/ })).toBeVisible()
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
            upgradesFixture([
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
            ]),
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
    await waitFor(
      async () =>
        expect(
          await canvas.findByText("No upgrades are pending."),
        ).toBeVisible(),
      { timeout: 10_000 },
    )
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

    await userEvent.click(canvas.getByRole("button", { name: "Details" }))
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
    expect(canvas.getByRole("button", { name: /^Start again/ })).toBeVisible()
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
    expect(canvas.getByText(/It is up to date\./)).toBeVisible()
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
    expect(canvas.getByText("Ready to start")).toBeVisible()
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

export const ReingestIngestionV2Off: Story = {
  parameters: blockedReingest("ingestion_v2_off"),
  play: async ({ canvasElement }) => {
    const canvas = await expectReingestCard(
      canvasElement,
      "The re-ingestion cannot run here yet",
    )
    await waitFor(() =>
      expect(canvas.getByText(/valid format file/)).toBeVisible(),
    )
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
    expect(canvas.queryByText(/No upgrades are pending/)).toBeNull()
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
    await waitFor(async () =>
      expect(await canvas.findByText("No upgrades are pending.")).toBeVisible(),
    )
    await waitFor(() =>
      expect(canvas.getByRole("button", { name: "History" })).toHaveAttribute(
        "aria-expanded",
        "false",
      ),
    )
    await waitFor(() => expect(canvas.queryByText("Applied")).not.toBeVisible())
    expect(canvas.queryByRole("button", { name: /^Start/ })).toBeNull()

    await userEvent.click(canvas.getByRole("button", { name: "History" }))
    await waitFor(() => expect(canvas.getByText("Applied")).toBeVisible())
    await waitFor(() =>
      expect(
        within(
          canvas.getByRole("list", { name: "Applied upgrades" }),
        ).getByRole("heading", { name: "Upgrade to format 3" }),
      ).toBeVisible(),
    )
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
    await waitFor(async () =>
      expect(await canvas.findByText("Ready to start")).toBeVisible(),
    )
    expect(canvas.queryByRole("button", { name: /^Start/ })).toBeNull()
    expect(canvas.queryByText("Ask an admin")).toBeNull()
  },
}
