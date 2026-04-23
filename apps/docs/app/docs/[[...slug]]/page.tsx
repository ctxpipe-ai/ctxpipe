import type { Metadata } from "next"
import type { ComponentType } from "react"
import { notFound } from "next/navigation"
import type { TOCItemType } from "fumadocs-core/toc"
import {
  DocsPage,
  DocsBody,
  DocsTitle,
  DocsDescription,
} from "fumadocs-ui/page"
import defaultMdxComponents from "fumadocs-ui/mdx"
import { Card, Cards } from "fumadocs-ui/components/card"
import { Callout } from "fumadocs-ui/components/callout"
import { AddToCursorMcp } from "@/app/docs/components/add-to-cursor-mcp"
import { source } from "@/lib/source"

/** MDX pages from fumadocs-mdx; loader output is typed as base `PageData` without `body`/`toc`. */
type DocPageData = {
  title: string
  description?: string
  /** MDX default export — props typing is provided by the MDX compiler, not base `PageData`. */
  body: ComponentType<{ components?: Record<string, ComponentType<unknown>> }>
  toc: TOCItemType[]
  full?: boolean
}

interface Props {
  params: Promise<{ slug?: string[] }>
}

function docSlugs(slug: string[] | undefined): string[] {
  // Optional catch-all: Next may omit `slug` or pass `null` in some runtimes.
  // `getPage(null)` bypasses the default param and throws on `.join`.
  return Array.isArray(slug) ? slug : []
}

export default async function Page({ params }: Props) {
  const { slug } = await params
  const page = source.getPage(docSlugs(slug))
  if (!page) notFound()

  const data = page.data as DocPageData
  const MDX = data.body

  return (
    <DocsPage toc={data.toc} full={data.full}>
      <DocsTitle>{data.title}</DocsTitle>
      <DocsDescription>{data.description}</DocsDescription>
      <DocsBody>
        <MDX
          components={
            {
              ...defaultMdxComponents,
              Card,
              Cards,
              Callout,
              AddToCursorMcp,
            } as Record<
              string,
              ComponentType<unknown>
            >
          }
        />
      </DocsBody>
    </DocsPage>
  )
}

export async function generateStaticParams() {
  return source.generateParams()
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params
  const page = source.getPage(docSlugs(slug))
  if (!page) notFound()

  const data = page.data as DocPageData
  return {
    title: `${data.title} — ctx| docs`,
    description: data.description,
  }
}
