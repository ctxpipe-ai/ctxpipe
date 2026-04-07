import type { Metadata } from "next"
import type { ReactNode } from "react"
import { RootProvider } from "fumadocs-ui/provider"
import { Geist, Geist_Mono } from "next/font/google"
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
  icons: {
    icon: "/ctx_.svg",
    shortcut: "/ctx_.svg",
    apple: "/ctx_.svg",
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
        <RootProvider theme={{ enabled: false }}>{children}</RootProvider>
      </body>
    </html>
  )
}
