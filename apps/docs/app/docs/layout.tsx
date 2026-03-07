import type { ReactNode } from "react"
import { DocsLayout } from "fumadocs-ui/layouts/docs"
import { source } from "@/lib/source"

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <DocsLayout
      tree={source.pageTree}
      nav={{
        title: (
          <span className="flex items-center gap-1.5 select-none">
            <span
              className="font-mono font-semibold tracking-tight"
              style={{ color: "oklch(0.78 0.13 182)" }}
            >
              ctx|
            </span>
            <span className="font-medium tracking-tight text-zinc-200">
              docs
            </span>
          </span>
        ),
        url: "https://ctxpipe.ai",
      }}
      links={[
        {
          text: "ctxpipe.ai",
          url: "https://ctxpipe.ai",
          active: "nested-url",
        },
      ]}
    >
      {children}
    </DocsLayout>
  )
}
