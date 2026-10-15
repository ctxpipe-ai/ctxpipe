import type { Meta, StoryObj } from "@storybook/react-vite"
import { HttpResponse, http } from "msw"
import { useEffect, useState } from "react"
import { expect, userEvent, waitFor, within } from "storybook/test"
import { entryPageInnerDecorators } from "../../../.storybook/decorators/entry-page-decorators"
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
  decorators: [...entryPageInnerDecorators],
  beforeEach: () => {
    patches.length = 0
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
  },
} satisfies Meta<typeof Harness>

export default meta

type Story = StoryObj<typeof meta>

/**
 * The automatic title arrives while the input is open. An unedited Enter does
 * not save the old name. Focus returns to the title button.
 */
export const UneditedSaveKeepsAutomaticTitle: Story = {
  tags: ["workspace-golden"],
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

/** Escape cancels and returns focus to the title button. */
export const EscapeReturnsFocus: Story = {
  tags: ["workspace-golden"],
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
  expect(
    await canvas.findByRole("button", {
      name: `Rename conversation: ${name}`,
    }),
  ).toBeVisible()
  expect(canvas.queryByRole("textbox")).toBeNull()
  // A late blur or a second save would add a request.
  await new Promise((resolve) => setTimeout(resolve, 300))
  expect(patches).toEqual([name])
}

/** Enter saves the typed name once: one PATCH with the new name, and the new title shows. */
export const RenameSavesNewName: Story = {
  play: ({ canvasElement }) =>
    renameTo(canvasElement, "Quarterly plan", () =>
      userEvent.keyboard("{Enter}"),
    ),
}

/** A blur saves the typed name once, the same way. */
export const RenameSavesOnBlur: Story = {
  play: ({ canvasElement }) =>
    renameTo(canvasElement, "Quarterly plan", () => userEvent.tab()),
}
