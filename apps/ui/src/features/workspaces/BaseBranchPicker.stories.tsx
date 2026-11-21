import { useState } from "react"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"

import { chatColumnClassName } from "@/features/chat/chat-column"
import { MessageInputBox } from "@/features/chat/MessageInputBox"
import { workspaceBranchesHandler } from "@/mocks/workspace-handlers"

import preview from "../../../.storybook/preview"
import { BaseBranchPicker } from "./BaseBranchPicker"
import { docsWorkspaceBranches } from "./workspace-fixtures"

// The branches of a repository with a longer history: the search matters here.
const manyBranches = {
  defaultBranch: "main",
  branches: [
    "main",
    "docs/api-reference",
    "docs/billing-ledger",
    "docs/onboarding-guide",
    "docs/runbooks",
    "feature/checkout-retry",
    "feature/invoice-export",
    "feature/sso-group-sync",
    "fix/broken-links",
    "fix/search-index-timeout",
    "release/2026-07",
    "release/2026-08",
    "release/2026-09",
    "release/2026-10",
    "release/2026-11",
  ],
}

const meta = preview.meta({
  title: "Components/Workspaces/BaseBranchPicker",
  component: BaseBranchPicker,
  args: {
    orgSlug: "acme",
    workspaceSlug: "docs",
    defaultBranch: "main",
    onChange: fn(),
  },
  // The composer of a new conversation holds the picker in its footer, as
  // `WorkspaceComposeChat` does. The value follows the pick, as there.
  render: function Render(args) {
    const [value, setValue] = useState(args.value)
    return (
      <div className={`w-full p-4 ${chatColumnClassName}`}>
        <MessageInputBox
          layout="empty"
          placeholder="What should ctxpipe do in this Workspace?"
          sendMessage={() => {}}
          tools={
            <BaseBranchPicker
              {...args}
              value={value}
              onChange={(branch) => {
                setValue(branch)
                args.onChange(branch)
              }}
            />
          }
        />
      </div>
    )
  },
  beforeEach: ({ msw }) => {
    msw.use(workspaceBranchesHandler())
  },
  parameters: {
    queryClient: true,
    layout: "fullscreen",
    review: { kind: "component" },
    visual: { viewports: ["desktop", "mobile"] },
  },
})

const trigger = (canvasElement: HTMLElement) =>
  within(canvasElement).findByRole("button", { name: /main|release/ })

/**
 * Composer of a new conversation in a Workspace: the base branch sits in the
 * footer as a quiet control with a branch icon, the default branch main and
 * a chevron, on the line of the send button. The member can send at once.
 */
export const OnDefaultBranch = meta.story({
  play: async ({ canvasElement }) => {
    await waitFor(async () =>
      expect(await trigger(canvasElement)).toHaveTextContent("main"),
    )
  },
})

/**
 * Composer of a new conversation in a Workspace: the branch list of the
 * repository still loads, but the base branch control already shows the
 * default branch main, the same as after the load. No bar holds its place.
 */
export const ValueShowsWhileListLoads = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(workspaceBranchesHandler("loading"))
  },
  parameters: {
    visual: {
      duplicate:
        "The value shows before the list loads, so the closed control has the pixels of OnDefaultBranch.",
    },
  },
  play: async ({ canvasElement }) => {
    await waitFor(async () =>
      expect(await trigger(canvasElement)).toHaveTextContent("main"),
    )
  },
})

/**
 * Composer of a new conversation in a Workspace: the pointer is on the base
 * branch control, so it shows a soft wash and brighter text, like the other
 * quiet controls of the composer.
 */
export const HoverShowsWash = meta.story({
  play: async ({ canvasElement }) => {
    await userEvent.hover(await trigger(canvasElement))
  },
})

/**
 * Base branch menu of a new conversation, open after the member pressed the
 * branch control: a search row, then the branches with main first, checked
 * and marked default.
 */
export const MenuOpen = meta.story({
  play: async ({ canvasElement }) => {
    await userEvent.click(await trigger(canvasElement))
    const page = within(canvasElement.ownerDocument.body)
    await waitFor(() =>
      expect(
        page.getByRole("searchbox", { name: "Search branches" }),
      ).toHaveFocus(),
    )
    await waitFor(() =>
      expect(page.getAllByRole("option")).toHaveLength(
        docsWorkspaceBranches.branches.length,
      ),
    )
    expect(page.getByRole("option", { name: /main/ })).toHaveAttribute(
      "aria-selected",
      "true",
    )
  },
})

/**
 * Base branch menu of a new conversation in a repository with many branches:
 * the member typed "release" in the search field, so only the five release
 * branches show.
 */
export const SearchFiltersLongList = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(workspaceBranchesHandler(manyBranches))
  },
  play: async ({ canvasElement }) => {
    await userEvent.click(await trigger(canvasElement))
    const page = within(canvasElement.ownerDocument.body)
    await userEvent.type(
      await page.findByRole("searchbox", { name: "Search branches" }),
      "release",
    )
    await waitFor(() => expect(page.getAllByRole("option")).toHaveLength(5))
  },
})

/**
 * Base branch menu of a new conversation: the member searched for a branch
 * that the repository does not have, so the list says that no branch matches.
 */
export const SearchNoMatch = meta.story({
  play: async ({ canvasElement }) => {
    await userEvent.click(await trigger(canvasElement))
    const page = within(canvasElement.ownerDocument.body)
    await userEvent.type(
      await page.findByRole("searchbox", { name: "Search branches" }),
      "hotfix/payments",
    )
    await page.findByText("No branch matches your search.")
  },
})

/**
 * Base branch menu of a new conversation, opened while the branch list still
 * loads: the known default branch main is first and checked, and gray rows
 * below it wait for the other branches.
 */
export const MenuWhileListLoads = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(workspaceBranchesHandler("loading"))
  },
  play: async ({ canvasElement }) => {
    await userEvent.click(await trigger(canvasElement))
    const page = within(canvasElement.ownerDocument.body)
    await page.findByRole("option", { name: /main/ })
    await page.findByText("Loading branches")
  },
})

/**
 * Base branch menu of a new conversation when the repository did not list its
 * branches: main stays checked, so the member can still send, and a line says
 * that the other branches did not load, with Try again.
 */
export const MenuWhenListFails = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(workspaceBranchesHandler("error"))
  },
  play: async ({ canvasElement }) => {
    const button = await trigger(canvasElement)
    // The value stays when the list fails.
    await waitFor(() => expect(button).toHaveTextContent("main"))
    await userEvent.click(button)
    const page = within(canvasElement.ownerDocument.body)
    await page.findByText("The other branches did not load.")
    await waitFor(() =>
      expect(page.getByRole("button", { name: "Try again" })).toBeVisible(),
    )
    expect(page.getAllByRole("option")).toHaveLength(1)
  },
})

/**
 * Composer of a new conversation where the member picked a base branch with a
 * long name: the control keeps the start and the end of the name and drops
 * its middle, so it stays on the line of the send button.
 */
export const LongBranchName = meta.story({
  args: { value: "feature/2026-11-checkout-retry-with-idempotency-keys" },
  beforeEach: ({ msw }) => {
    msw.use(
      workspaceBranchesHandler({
        defaultBranch: "main",
        branches: [
          "main",
          "feature/2026-11-checkout-retry-with-idempotency-keys",
        ],
      }),
    )
  },
  play: async ({ canvasElement }) => {
    const button = await within(canvasElement).findByRole("button", {
      name: /idempotency-keys/,
    })
    await document.fonts.ready
    const head = button.querySelector(".truncate")
    if (!(head instanceof HTMLElement)) throw new Error("Branch name missing")
    expect(head.scrollWidth).toBeGreaterThan(head.clientWidth)
  },
})
