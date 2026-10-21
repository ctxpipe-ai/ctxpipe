import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, userEvent, waitFor, within } from "storybook/test"
import {
  IMAGE_PREVIEW_MAX_BYTES,
  RAW_FILE_MAX_BYTES,
  rawFileUrl,
  WorkspaceBinaryFile,
} from "./WorkspaceBinaryFile"

// A 96 × 64 PNG with three stripes. A data URL keeps the image load
// deterministic; the pane passes the raw file endpoint URL.
const stripesPng =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABACAIAAABqVuVZAAAAe0lEQVR42u3QMQ0AIAwAsMlYghn8X0hAxPajYglHkypo7HtGZa5RVT0qBAkSJEiQIEGCBAkSJEiQIEGCBAkSJEiQIEGCBAkSJEiQIEGCBAkSJEiQIEGCBAkSJEiQIEGCBAkSJEiQIEGCBAkSJEiQIEGCBAkSJEiQoP+CHsS+wllr56WmAAAAAElFTkSuQmCC"

const diagramSvg = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120"><rect width="240" height="120" fill="#18181b"/><circle cx="60" cy="60" r="36" fill="#40e0d0"/><rect x="120" y="30" width="90" height="60" fill="#f4f4f5"/></svg>',
)}`

const meta = {
  title: "Components/Workspaces/WorkspaceBinaryFile",
  component: WorkspaceBinaryFile,
  decorators: [
    (Story) => (
      <div className="h-[24rem] w-[40rem] bg-background">
        <Story />
      </div>
    ),
  ],
  args: { path: "assets/logo.png", size: 180, rawUrl: stripesPng },
} satisfies Meta<typeof WorkspaceBinaryFile>

export default meta

type Story = StoryObj<typeof meta>

export const ImagePreview: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const image = await canvas.findByRole("img", { name: "logo.png" })
    await expect(image).toHaveAttribute("src", stripesPng)
    await canvas.findByText("96 × 64 px")
    await expect(canvas.getByText("180 B")).toBeVisible()
    await expect(
      canvas.getByRole("link", { name: "Download logo.png" }),
    ).toHaveAttribute("download", "logo.png")
    await userEvent.click(canvas.getByRole("button", { name: "Actual size" }))
    await waitFor(() =>
      expect(canvas.getByRole("button", { name: "Zoom to fit" })).toBeVisible(),
    )
    await waitFor(() =>
      expect(canvas.getByRole("img", { name: "logo.png" })).toHaveClass(
        "max-w-none",
      ),
    )
  },
}

/** An SVG shows only through `<img>`, never as markup in the page. */
export const SvgPreview: Story = {
  args: { path: "docs/diagram.svg", size: 412, rawUrl: diagramSvg },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const image = await canvas.findByRole("img", { name: "diagram.svg" })
    await expect(image.tagName).toBe("IMG")
    await canvas.findByText("240 × 120 px")
    await expect(canvasElement.querySelector("circle")).toBeNull()
  },
}

/**
 * A normal SVG is text, so the blob is not binary. The pane still shows the
 * image first, through `<img>`, and "View source" shows the text view.
 */
export const SvgTextWithSource: Story = {
  args: {
    path: "docs/diagram.svg",
    size: undefined,
    rawUrl: diagramSvg,
    source: (
      <pre className="p-3 text-xs">
        {'<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120">'}
      </pre>
    ),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByRole("img", { name: "diagram.svg" })
    await canvas.findByText("240 × 120 px")
    const sourceText = /^<svg xmlns=/
    await expect(canvas.queryByText(sourceText)).toBeNull()
    await userEvent.click(canvas.getByRole("button", { name: "View source" }))
    await waitFor(() => expect(canvas.getByText(sourceText)).toBeVisible())
    await expect(canvas.queryByRole("img")).toBeNull()
    await userEvent.click(canvas.getByRole("button", { name: "View image" }))
    await canvas.findByRole("img", { name: "diagram.svg" })
    await expect(canvasElement.querySelector("circle")).toBeNull()
  },
}

export const DownloadBinaryFile: Story = {
  args: {
    path: "dist/bundle.zip",
    size: 48_213,
    rawUrl: rawFileUrl({
      orgSlug: "acme",
      workspaceSlug: "docs",
      path: "dist/bundle.zip",
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const link = await canvas.findByRole("link", {
      name: "Download bundle.zip",
    })
    await expect(link).toHaveAttribute(
      "href",
      "/acme/api/v1/workspaces/docs/files/raw?path=dist%2Fbundle.zip",
    )
    await expect(link).toHaveAttribute("download", "bundle.zip")
    await expect(
      canvas.getByText(
        "This file is binary and has no preview. Download it to open it.",
      ),
    ).toBeVisible()
    await expect(canvas.queryByRole("img")).toBeNull()
  },
}

/** An image over the preview limit downloads; the pane does not load it. */
export const ImageOverPreviewLimit: Story = {
  args: {
    path: "assets/photo.jpg",
    size: IMAGE_PREVIEW_MAX_BYTES + 1024 * 1024,
    rawUrl: rawFileUrl({
      orgSlug: "acme",
      workspaceSlug: "docs",
      conversationId: "conv_story",
      path: "assets/photo.jpg",
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const link = await canvas.findByRole("link", {
      name: "Download photo.jpg",
    })
    await expect(link).toHaveAttribute(
      "href",
      "/acme/api/v1/conversations/conv_story/files/raw?path=assets%2Fphoto.jpg",
    )
    await expect(
      canvas.getByText(
        "This image is larger than 5.0 MB, so it has no preview. Download it to see it.",
      ),
    ).toBeVisible()
    await expect(canvas.queryByRole("img")).toBeNull()
  },
}

/** A file over the raw file limit cannot download here, so the pane says how to get it. */
export const FileOverDownloadLimit: Story = {
  args: {
    path: "media/demo.mp4",
    size: RAW_FILE_MAX_BYTES + 2 * 1024 * 1024,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const alert = await canvas.findByRole("alert")
    await expect(alert).toHaveTextContent("This file is too large to open")
    await expect(alert).toHaveTextContent(
      "This file is 12.0 MB. The Files pane sends files up to 10.0 MB. Clone the repository to get this file.",
    )
    await expect(canvas.queryByRole("link")).toBeNull()
  },
}

/** A broken image keeps the download, so the user can still open the file. */
export const ImageLoadError: Story = {
  args: { rawUrl: "data:image/png;base64,AAAA" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const alert = await canvas.findByRole("alert")
    await expect(alert).toHaveTextContent("The image did not load")
    await expect(
      canvas.getByRole("link", { name: "Download logo.png" }),
    ).toBeVisible()
  },
}
