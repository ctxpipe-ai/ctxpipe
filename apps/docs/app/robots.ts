import type { MetadataRoute } from "next"

import { docsOrigin } from "@/lib/source"

/** The same AI crawlers as https://www.ctxpipe.ai/robots.txt. Keep the lists the same. */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: "*", allow: "/", disallow: "/api/" },
      {
        userAgent: [
          "GPTBot",
          "ChatGPT-User",
          "OAI-SearchBot",
          "ClaudeBot",
          "Claude-User",
          "Google-Extended",
          "PerplexityBot",
        ],
        allow: "/",
        disallow: "/api/",
      },
    ],
    sitemap: `${docsOrigin}/sitemap.xml`,
  }
}
