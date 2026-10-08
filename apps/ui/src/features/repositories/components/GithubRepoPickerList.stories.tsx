import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, fn, userEvent, within } from "storybook/test"
import { eligibleGithubRepos } from "@/features/workspaces/workspace-fixtures"
import { GithubRepoPickerList } from "./GithubRepoPickerList"

const [firstRepo, secondRepo] = eligibleGithubRepos
if (!firstRepo || !secondRepo) throw new Error("The fixture needs two repos")

const meta = {
  title: "Components/Repositories/Repo picker list",
  component: GithubRepoPickerList,
  parameters: {
    layout: "padded",
  },
  args: {
    repos: eligibleGithubRepos,
    selectedIds: new Set<number>(),
    onToggle: fn(),
  },
} satisfies Meta<typeof GithubRepoPickerList>

export default meta

type Story = StoryObj<typeof meta>

/** Linked repositories: pick any number. */
export const Multiple: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    const [firstBox] = await canvas.findAllByRole("checkbox")
    if (!firstBox) throw new Error("No repository checkboxes rendered")
    await userEvent.click(firstBox)
    expect(args.onToggle).toHaveBeenCalledWith(firstRepo.id, true)
  },
}

/** The Workspace repository: exactly one. */
export const Single: Story = {
  args: {
    selectionMode: "single",
    selectedIds: new Set([secondRepo.id]),
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    const radios = await canvas.findAllByRole("radio")
    const [firstRadio, secondRadio] = radios
    if (!firstRadio || !secondRadio) throw new Error("No repository radios")
    expect(canvas.queryByRole("checkbox")).toBeNull()
    expect(secondRadio).toBeChecked()
    await userEvent.click(firstRadio)
    expect(args.onToggle).toHaveBeenCalledWith(firstRepo.id, true)
  },
}
