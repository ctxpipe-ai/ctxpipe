import { expect, userEvent, waitFor, within } from "storybook/test"

import preview from "../../../.storybook/preview"
import { ComboBox, ComboBoxItem } from "./ComboBox"

const meta = preview.meta({
  title: "Components/ComboBox",
  component: ComboBox,
  parameters: {
    layout: "centered",
    review: { kind: "component" },
  },
})

/** The branches of a repository that has worked for some years. */
const branches = [
  "main",
  "chore/bump-node-22",
  "docs/api-reference",
  "docs/onboarding-guide",
  "feature/audit-log-export",
  "feature/billing-annual-plans",
  "feature/checkout-retry",
  "feature/dark-mode-settings",
  "feature/sso-okta",
  "feature/usage-alerts",
  "fix/broken-links",
  "fix/invoice-rounding",
  "fix/session-timeout",
  "hotfix/payment-webhook",
  "refactor/search-index",
  "release/2026-08",
  "release/2026-09",
  "release/2026-10",
  "release/2026-11",
  "spike/vector-store",
]

function BranchField() {
  return (
    <ComboBox
      label="Base"
      items={branches.map((name) => ({ id: name }))}
      defaultSelectedKey="main"
      emptyText="No branch matches"
      labelClassName="text-xs text-muted-foreground"
      inputClassName="font-mono text-xs"
      className="w-56 flex-row items-center gap-2"
    >
      {(item) => (
        <ComboBoxItem id={item.id} textValue={item.id}>
          <span className="truncate font-mono text-xs">{item.id}</span>
        </ComboBoxItem>
      )}
    </ComboBox>
  )
}

/**
 * Base branch field of a new conversation, for a repository with many
 * branches: the member opened the list with the arrow button, and the list
 * scrolls inside its popover, with the selected branch checked.
 */
export const LongList = meta.story({
  render: () => <BranchField />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const page = within(canvasElement.ownerDocument.body)
    const arrow = canvas.getByRole("button")
    await userEvent.click(arrow)
    // The pointer leaves the arrow button, so it shows no hover fill.
    await userEvent.unhover(arrow)
    await waitFor(() =>
      expect(page.getAllByRole("option")).toHaveLength(branches.length),
    )
    await waitFor(() =>
      expect(page.getByRole("option", { name: "main" })).toHaveAttribute(
        "aria-selected",
        "true",
      ),
    )
  },
})

/**
 * Base branch field of a new conversation: the member typed "release" in
 * the field, so the list shows only the release branches.
 */
export const FilterByTyping = meta.story({
  render: () => <BranchField />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const page = within(canvasElement.ownerDocument.body)
    const input = canvas.getByRole("combobox", { name: "Base" })
    // Replace the selected name, as a member who selects it and types.
    await userEvent.type(input, "release", {
      initialSelectionStart: 0,
      initialSelectionEnd: "main".length,
    })
    await waitFor(() =>
      expect(canvas.getByRole("combobox", { name: "Base" })).toHaveValue(
        "release",
      ),
    )
    await waitFor(() =>
      expect(
        page.getAllByRole("option").map((option) => option.textContent),
      ).toEqual([
        "release/2026-08",
        "release/2026-09",
        "release/2026-10",
        "release/2026-11",
      ]),
    )
  },
})

/**
 * Base branch field of a new conversation: the member typed a name that no
 * branch has, so the list says that no branch matches.
 */
export const NoMatch = meta.story({
  render: () => <BranchField />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const page = within(canvasElement.ownerDocument.body)
    const input = canvas.getByRole("combobox", { name: "Base" })
    // Replace the selected name, as a member who selects it and types.
    await userEvent.type(input, "staging", {
      initialSelectionStart: 0,
      initialSelectionEnd: "main".length,
    })
    await waitFor(() =>
      expect(canvas.getByRole("combobox", { name: "Base" })).toHaveValue(
        "staging",
      ),
    )
    await waitFor(() =>
      expect(page.getByText("No branch matches")).toBeVisible(),
    )
  },
})
