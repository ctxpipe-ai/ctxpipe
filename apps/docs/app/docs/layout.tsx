import type { ReactNode } from "react"
import { DocsLayout } from "fumadocs-ui/layouts/docs"
import { source } from "@/lib/source"
import Image from "next/image"

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <DocsLayout
      tree={source.pageTree}
      nav={{
        title: (
          <span className="flex items-center gap-2 font-semibold tracking-tight">
            <span className="font-mono text-teal-400">ctx</span>
            <span className="text-zinc-400">/</span>
            <span>docs</span>
          </span>
        ),
        url: "/",
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
