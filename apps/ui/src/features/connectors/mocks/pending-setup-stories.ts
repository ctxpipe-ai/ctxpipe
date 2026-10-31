import { HttpResponse, http } from "msw"
import type { Mock } from "storybook/test"
import { expect, screen, userEvent, waitFor, within } from "storybook/test"

/**
 * Handlers for a pending-setup card story. Put them before the status
 * handler: the first one counts each status read and then lets the next
 * handler answer.
 */
export function pendingSetupHandlers(input: {
  orgSlug: string
  provider: "notion" | "linear" | "pagerduty" | "zendesk"
  statusReads: Mock
  deleted: Mock
}) {
  const base = `/${input.orgSlug}/api/v1/connectors/${input.provider}`
  return [
    http.get(`${base}/status`, () => {
      input.statusReads()
    }),
    http.delete(base, () => {
      input.deleted()
      return new HttpResponse(null, { status: 204 })
    }),
  ]
}

/** Continue opens setup; Remove asks first, then deletes and reads again. */
export async function playPendingSetup(input: {
  canvasElement: HTMLElement
  name: string
  onOpen: Mock
  statusReads: Mock
  deleted: Mock
}) {
  input.onOpen.mockClear()
  input.deleted.mockClear()
  const canvas = within(input.canvasElement)
  await canvas.findByText("Setup not finished")
  await userEvent.click(
    canvas.getByRole("button", { name: new RegExp(` for ${input.name}$`) }),
  )
  expect(input.onOpen).toHaveBeenCalledTimes(1)
  const reads = input.statusReads.mock.calls.length
  await userEvent.click(
    canvas.getByRole("button", { name: `Remove ${input.name} setup` }),
  )
  const dialog = await screen.findByRole("alertdialog")
  await within(dialog).findByText(`Remove this ${input.name} setup?`)
  expect(input.deleted).not.toHaveBeenCalled()
  const confirm = within(dialog).getByRole("button", { name: "Remove setup" })
  await waitFor(() => expect(confirm).toBeVisible())
  await userEvent.click(confirm)
  await waitFor(() => expect(input.deleted).toHaveBeenCalledTimes(1))
  await waitFor(() =>
    expect(input.statusReads.mock.calls.length).toBeGreaterThan(reads),
  )
}
