import type { MetadataRoute } from "next"

import { docsOrigin, source } from "@/lib/source"

export default function sitemap(): MetadataRoute.Sitemap {
  return source.getPages().map((page) => ({ url: `${docsOrigin}${page.url}` }))
}
