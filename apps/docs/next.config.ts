import { createMDX } from "fumadocs-mdx/next"

const withMDX = createMDX()

const config = withMDX({
  reactStrictMode: true,
  output: "standalone",
  async redirects() {
    return [
      {
        source: "/docs/connections/connecting-docs",
        destination: "/docs/connections/connected-sources",
        permanent: false,
      },
      {
        source: "/docs/connections/connecting-tools",
        destination: "/docs/connections/connected-sources",
        permanent: false,
      },
      {
        source: "/docs/connections/confluence-connector",
        destination: "/docs/connections/source-connectors/confluence",
        permanent: false,
      },
    ]
  },
})

export default config
