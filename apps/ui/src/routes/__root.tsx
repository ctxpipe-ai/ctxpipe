import { TanStackDevtools } from "@tanstack/react-devtools"
import { createRootRoute, HeadContent, Scripts } from "@tanstack/react-router"
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools"
import type { ReactNode } from "react"
import { Toaster } from "sonner"
import { getAmplitudeRuntimeConfig } from "@/lib/amplitudeRuntimeConfig"
import { getConfluenceForgeRuntimeConfig } from "@/lib/confluenceForgeRuntimeConfig"
import { Providers } from "@/providers"

import appCss from "../styles.css?url"

export const Route = createRootRoute({
  loader: () => ({
    amplitudeRuntimeConfig: getAmplitudeRuntimeConfig(),
    confluenceForgeRuntimeConfig: getConfluenceForgeRuntimeConfig(),
  }),
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1",
      },
      { title: "ctx | The Context Layer for AI Agents" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      {
        rel: "preload",
        href: "/fonts/Geist-Variable.woff2",
        as: "font",
        type: "font/woff2",
        crossOrigin: "anonymous",
      },
      {
        rel: "preload",
        href: "/fonts/GeistPixel-Square.woff2",
        as: "font",
        type: "font/woff2",
        crossOrigin: "anonymous",
      },
      {
        rel: "preload",
        href: "/animations/onboarding/welcome-background.v1.json",
        as: "fetch",
        type: "application/json",
        crossOrigin: "anonymous",
      },
      {
        rel: "preload",
        href: "/images/ctxpipe-onboarding-diagram.svg",
        as: "image",
        type: "image/svg+xml",
      },
    ],
  }),
  shellComponent: RootDocument,
  notFoundComponent: () => (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-3xl px-6 py-16">
        <p className="text-sm text-muted-foreground">Not Found</p>
      </div>
    </main>
  ),
})

function RootDocument({ children }: { children: ReactNode }) {
  const { amplitudeRuntimeConfig, confluenceForgeRuntimeConfig } =
    Route.useLoaderData()
  return (
    <html lang="en" className="dark">
      <head>
        <HeadContent />
      </head>
      <body>
        <Providers
          amplitudeRuntimeConfig={amplitudeRuntimeConfig}
          confluenceForgeRuntimeConfig={confluenceForgeRuntimeConfig}
        >
          {children}
        </Providers>
        <TanStackDevtools
          config={{
            position: "bottom-right",
          }}
          plugins={[
            {
              name: "Tanstack Router",
              render: <TanStackRouterDevtoolsPanel />,
            },
          ]}
        />
        <Toaster richColors position="top-center" />
        <Scripts />
      </body>
    </html>
  )
}
