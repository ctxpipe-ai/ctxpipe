import type { Metadata } from "next"
import type { ComponentProps, ComponentType } from "react"
import { notFound, redirect } from "next/navigation"
import type { TOCItemType } from "fumadocs-core/toc"
import {
  DocsPage,
  DocsBody,
  DocsTitle,
  DocsDescription,
} from "fumadocs-ui/page"
import defaultMdxComponents from "fumadocs-ui/mdx"
import { Callout } from "fumadocs-ui/components/callout"
import {
  ImageZoom,
  type ImageZoomProps,
} from "fumadocs-ui/components/image-zoom"
import { source } from "@/lib/source"
import { Card, Cards } from "../components/docs-card"
import { ImageSlot } from "../components/docs-image-slot"

function ZoomableImage(props: ComponentProps<"img">) {
  return (
    <ImageZoom {...(props as ImageZoomProps)}>
      <img {...props} />
    </ImageZoom>
  )
}

/** MDX pages from fumadocs-mdx; loader output is typed as base `PageData` without `body`/`toc`. */
type DocPageData = {
  title: string
  description?: string
  /** MDX default export - props typing is provided by the MDX compiler, not base `PageData`. */
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
  const normalizedSlug = docSlugs(slug)
  if (normalizedSlug.length === 0) redirect("/docs/getting-started")

  const page = source.getPage(normalizedSlug)
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
              ImageSlot,
              img: ZoomableImage,
            } as Record<string, ComponentType<unknown>>
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
  const normalizedSlug = docSlugs(slug)
  const page = source.getPage(
    normalizedSlug.length === 0 ? ["getting-started"] : normalizedSlug,
  )
  if (!page) notFound()

  const data = page.data as DocPageData
  return {
    title: `${data.title} - ctx| docs`,
    description: data.description,
  }
}
