import { RootProvider } from "fumadocs-ui/provider"
import type { Metadata } from "next"
import { Geist, Geist_Mono } from "next/font/google"
import type { ReactNode } from "react"

import { docsOrigin } from "@/lib/source"

import "./global.css"

const geist = Geist({
  subsets: ["latin"],
  variable: "--font-geist-sans",
})

const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-geist-mono",
})

export const metadata: Metadata = {
  metadataBase: new URL(docsOrigin),
  icons: {
    icon: "/ctx_.svg",
    shortcut: "/ctx_.svg",
    apple: "/ctx_.svg",
  },
}

/** The same Organization as the JSON-LD of https://www.ctxpipe.ai. */
const websiteJsonLd = {
  "@context": "https://schema.org",
  "@type": "WebSite",
  name: "ctxpipe docs",
  url: docsOrigin,
  inLanguage: "en-US",
  publisher: {
    "@type": "Organization",
    name: "ctxpipe",
    url: "https://www.ctxpipe.ai",
    logo: "https://www.ctxpipe.ai/icon.png",
    sameAs: ["https://github.com/ctxpipe-ai", "https://x.com/ctxpipe"],
  },
}

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={`${geist.variable} ${geistMono.variable} dark`}
      suppressHydrationWarning
    >
      <body>
        <script
          type="application/ld+json"
          // oxlint-disable-next-line react/no-danger -- static JSON-LD built in this file
          dangerouslySetInnerHTML={{ __html: JSON.stringify(websiteJsonLd) }}
        />
        <RootProvider theme={{ enabled: false }}>{children}</RootProvider>
      </body>
    </html>
  )
}
