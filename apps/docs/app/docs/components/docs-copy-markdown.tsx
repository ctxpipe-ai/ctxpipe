"use client"

import { buttonVariants } from "fumadocs-ui/components/ui/button"
import { useCopyButton } from "fumadocs-ui/utils/use-copy-button"
import { useState } from "react"

import { DocsIcon } from "./docs-icon"

const cache = new Map<string, string>()

/** Copy the Markdown copy of the page, for a person to paste into an agent. */
export function DocsCopyMarkdown({ markdownUrl }: { markdownUrl: string }) {
  const [isLoading, setLoading] = useState(false)
  const [checked, onClick] = useCopyButton(async () => {
    const cached = cache.get(markdownUrl)
    if (cached) return navigator.clipboard.writeText(cached)

    setLoading(true)
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/plain": fetch(markdownUrl).then(async (res) => {
            const content = await res.text()
            cache.set(markdownUrl, content)
            return content
          }),
        }),
      ])
    } finally {
      setLoading(false)
    }
  })

  return (
    <button
      type="button"
      disabled={isLoading}
      className={buttonVariants({
        color: "secondary",
        size: "sm",
        className: "gap-2 [&_svg]:size-3.5 [&_svg]:text-fd-muted-foreground",
      })}
      onClick={onClick}
    >
      <DocsIcon name={checked ? "check" : "copy"} />
      Copy Markdown
    </button>
  )
}
