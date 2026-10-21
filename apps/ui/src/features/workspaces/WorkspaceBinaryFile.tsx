import { IconDownload, IconFile } from "@tabler/icons-react"
import { useState } from "react"
import { Button } from "@/components/ui/Button"
import { InlineAlert } from "@/components/ui/InlineAlert"

/** The largest image that the Files pane shows. A larger one downloads. */
export const IMAGE_PREVIEW_MAX_BYTES = 5 * 1024 * 1024

/** The largest file that the raw file endpoint sends (backend `RAW_FILE_MAX_BYTES`). */
export const RAW_FILE_MAX_BYTES = 10 * 1024 * 1024

const PREVIEW_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg"])

function fileName(path: string) {
  return path.split("/").at(-1) || path
}

function isPreviewImage(path: string) {
  const name = fileName(path)
  const dot = name.lastIndexOf(".")
  return dot > 0 && PREVIEW_EXTENSIONS.has(name.slice(dot + 1).toLowerCase())
}

export function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** The same-origin URL of the raw file endpoint for a Workspace or a conversation. */
export function rawFileUrl(input: {
  orgSlug: string
  workspaceSlug: string
  conversationId?: string
  path: string
}) {
  const owner = input.conversationId
    ? `conversations/${encodeURIComponent(input.conversationId)}`
    : `workspaces/${encodeURIComponent(input.workspaceSlug)}`
  return `/${encodeURIComponent(input.orgSlug)}/api/v1/${owner}/files/raw?path=${encodeURIComponent(input.path)}`
}

/**
 * A binary file in the Files pane: an image preview, or a download. An SVG
 * shows only through `<img>`, so its scripts never run in the page.
 */
export function WorkspaceBinaryFile(props: {
  path: string
  size?: number
  rawUrl: string
}) {
  const name = fileName(props.path)
  if (props.size !== undefined && props.size > RAW_FILE_MAX_BYTES) {
    return (
      <div className="p-4">
        <InlineAlert variant="warning" title="This file is too large to open">
          This file is {formatFileSize(props.size)}. The Files pane sends files
          up to {formatFileSize(RAW_FILE_MAX_BYTES)}. Clone the repository to
          get this file.
        </InlineAlert>
      </div>
    )
  }
  if (
    isPreviewImage(props.path) &&
    (props.size === undefined || props.size <= IMAGE_PREVIEW_MAX_BYTES)
  ) {
    return <ImagePreview name={name} size={props.size} rawUrl={props.rawUrl} />
  }
  return (
    <div className="flex h-full min-h-0 flex-col items-start gap-3 p-4">
      <div className="flex items-center gap-2 text-sm text-foreground">
        <IconFile aria-hidden className="size-4 text-muted-foreground" />
        <span className="truncate">{name}</span>
        {props.size !== undefined ? (
          <span className="text-muted-foreground">
            {formatFileSize(props.size)}
          </span>
        ) : null}
      </div>
      <p className="text-sm text-muted-foreground">
        {isPreviewImage(props.path)
          ? `This image is larger than ${formatFileSize(IMAGE_PREVIEW_MAX_BYTES)}, so it has no preview. Download it to see it.`
          : "This file is binary and has no preview. Download it to open it."}
      </p>
      <DownloadButton name={name} rawUrl={props.rawUrl} />
    </div>
  )
}

function DownloadButton(props: { name: string; rawUrl: string }) {
  return (
    <Button
      variant="secondary"
      size="sm"
      href={props.rawUrl}
      download={props.name}
      aria-label={`Download ${props.name}`}
    >
      <IconDownload aria-hidden className="size-3.5" />
      Download
    </Button>
  )
}

function ImagePreview(props: { name: string; size?: number; rawUrl: string }) {
  const [fit, setFit] = useState(true)
  const [dimensions, setDimensions] = useState<{
    width: number
    height: number
  } | null>(null)
  const [failed, setFailed] = useState(false)
  const loaded = (image: HTMLImageElement) => {
    if (image.naturalWidth === 0) setFailed(true)
    else
      setDimensions({ width: image.naturalWidth, height: image.naturalHeight })
  }
  if (failed) {
    return (
      <div className="flex flex-col gap-3 p-4">
        <InlineAlert
          variant="error"
          title="The image did not load"
          actions={<DownloadButton name={props.name} rawUrl={props.rawUrl} />}
        >
          The browser could not show {props.name}. The file can be damaged or in
          a format that the browser cannot read. Download it to open it in
          another app.
        </InlineAlert>
      </div>
    )
  }
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <div className="flex shrink-0 items-center gap-3 px-3 py-2 text-xs text-muted-foreground">
        <span className="truncate text-foreground">{props.name}</span>
        {props.size !== undefined ? (
          <span>{formatFileSize(props.size)}</span>
        ) : null}
        {dimensions ? (
          <span>
            {dimensions.width} × {dimensions.height} px
          </span>
        ) : null}
        <span className="ml-auto flex items-center gap-2">
          <Button variant="ghost" size="sm" onPress={() => setFit(!fit)}>
            {fit ? "Actual size" : "Zoom to fit"}
          </Button>
          <DownloadButton name={props.name} rawUrl={props.rawUrl} />
        </span>
      </div>
      <div
        className={
          fit
            ? "flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-zinc-900/60 p-4"
            : "min-h-0 flex-1 overflow-auto bg-zinc-900/60 p-4"
        }
      >
        <img
          src={props.rawUrl}
          alt={props.name}
          className={
            fit ? "max-h-full max-w-full object-contain" : "max-w-none"
          }
          // A server-rendered image can finish before hydration, so the
          // load event never reaches React. The ref reads it then.
          ref={(image) => {
            if (image?.complete && !dimensions) loaded(image)
          }}
          onLoad={(event) => loaded(event.currentTarget)}
          onError={() => setFailed(true)}
        />
      </div>
    </div>
  )
}
