import type { Meta, StoryObj } from "@storybook/react-vite"
import { HttpResponse, http } from "msw"
import { useEffect, useState } from "react"
import { expect, userEvent, waitFor, within } from "storybook/test"

import { signedInHandlers } from "@/mocks/handlers"

import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import { ConversationTitleButton } from "./ConversationTitleButton"

const patches: string[] = []

function Harness() {
  const [name, setName] = useState("New conversation")
  // The play function dispatches this event, so the input keeps focus.
  useEffect(() => {
    const arrive = () => setName("Automatic title")
    window.addEventListener("arrive-title", arrive)
    return () => window.removeEventListener("arrive-title", arrive)
  }, [])
  return (
    <div className="flex items-center gap-4 p-4 text-sm">
      <ConversationTitleButton
        orgSlug="acme"
        conversationId="conv_1"
        name={name}
        onRenamed={setName}
      />
    </div>
  )
}

const meta = {
  title: "Components/Workspaces/ConversationTitleButton",
  component: Harness,
  beforeEach: () => {
    patches.length = 0
  },
  parameters: {
    app: "root",
    layout: "fullscreen",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug: "acme",
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        session: signedInHandlers,
        page: [
          http.patch(
            ({ request }) =>
              /\/api\/v1\/conversations\/conv_1$/.test(
                new URL(request.url).pathname,
              ),
            async ({ request }) => {
              const body = (await request.json()) as { name: string }
              patches.push(body.name)
              return HttpResponse.json({
                id: "conv_1",
                name: body.name,
              })
            },
          ),
        ],
      },
    },
    review: { kind: "component" },
  },
} satisfies Meta<typeof Harness>

export default meta

type Story = StoryObj<typeof meta>

/**
 * Title button of a conversation, which lets the user rename it. The automatic
 * title arrives while the rename field is open, and the user presses Enter with
 * no edit. The automatic title stays, no request goes out, and focus returns to
 * the title button.
 */
export const UneditedSaveKeepsAutomaticTitle: Story = {
  parameters: {
    intent:
      "Catches a rename save with no edit that stores a title. The automatic title must stay, send no request, and return focus to the title button. Not for real renames.",
  },
  tags: ["required"],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      await canvas.findByRole("button", {
        name: "Rename conversation: New conversation",
      }),
    )
    const input = await canvas.findByRole("textbox", {
      name: "Conversation name",
    })
    window.dispatchEvent(new Event("arrive-title"))
    await userEvent.keyboard("{Enter}")
    await waitFor(() => expect(input).not.toBeInTheDocument())
    expect(patches).toEqual([])
    await waitFor(() =>
      expect(
        canvas.getByRole("button", {
          name: "Rename conversation: Automatic title",
        }),
      ).toHaveFocus(),
    )
  },
}

/**
 * Title button of a conversation, which lets the user rename it. The user
 * presses Escape in the rename field: the rename stops, no request goes out,
 * and focus returns to the title button.
 */
export const EscapeReturnsFocus: Story = {
  parameters: {
    intent:
      "Catches an Escape in the rename field that saves or loses focus. Escape cancels, sends no request, and returns focus to the title button. Not for saving a name.",
  },
  tags: ["required"],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      await canvas.findByRole("button", {
        name: "Rename conversation: New conversation",
      }),
    )
    await canvas.findByRole("textbox", { name: "Conversation name" })
    await userEvent.keyboard("{Escape}")
    await waitFor(() =>
      expect(
        canvas.getByRole("button", {
          name: "Rename conversation: New conversation",
        }),
      ).toHaveFocus(),
    )
    expect(patches).toEqual([])
  },
}

async function renameTo(
  canvasElement: HTMLElement,
  name: string,
  commit: () => Promise<unknown>,
) {
  const canvas = within(canvasElement)
  await userEvent.click(
    await canvas.findByRole("button", {
      name: "Rename conversation: New conversation",
    }),
  )
  const input = await canvas.findByRole("textbox", {
    name: "Conversation name",
  })
  // Focus selects the old name, so typing replaces it.
  await waitFor(() => expect(input).toHaveFocus())
  await userEvent.keyboard(name)
  await commit()
  await waitFor(() =>
    expect(
      canvas.getByRole("button", {
        name: `Rename conversation: ${name}`,
      }),
    ).toBeVisible(),
  )
  expect(canvas.queryByRole("textbox")).toBeNull()
  // A late blur or a second save would add a request.
  await new Promise((resolve) => setTimeout(resolve, 300))
  expect(patches).toEqual([name])
}

/**
 * Title button of a conversation, which lets the user rename it. The user types
 * a name and presses Enter, and the new title shows. The play proves that one
 * PATCH with the new name goes out.
 */
export const RenameSavesNewName: Story = {
  play: ({ canvasElement }) =>
    renameTo(canvasElement, "Quarterly plan", () =>
      userEvent.keyboard("{Enter}"),
    ),
}

/**
 * Title button of a conversation, which lets the user rename it. The rename
 * field loses focus and saves the typed name, and the new title shows. The play
 * proves that only one PATCH goes out.
 */
export const RenameSavesOnBlur: Story = {
  play: ({ canvasElement }) =>
    renameTo(canvasElement, "Quarterly plan", () => userEvent.tab()),
}
