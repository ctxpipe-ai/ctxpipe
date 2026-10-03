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
      {
        source: "/docs/mcp/troubleshooting",
        destination: "/docs/mcp/mcp-docs#troubleshooting",
        permanent: false,
      },
      {
        source: "/docs/mcp/claude-plugin",
        destination: "/docs/mcp/mcp-docs",
        permanent: false,
      },
      {
        source: "/docs/knowledge-graph/:path*",
        destination: "/docs/workspaces/graph",
        permanent: false,
      },
      {
        source: "/docs/chat/:path*",
        destination: "/docs/workspaces/chat",
        permanent: false,
      },
      {
        source: "/docs/git-repositories/install-mcps-via-pr",
        destination: "/docs/mcp/install-mcps-via-pr",
        permanent: false,
      },
      {
        source: "/docs/git-repositories/:path*",
        destination: "/docs/workspaces/linked-repositories",
        permanent: false,
      },
      {
        source: "/docs/connections/context-repository",
        destination: "/docs/workspaces/create-workspace",
        permanent: false,
      },
      {
        source: "/docs/getting-started/who-is-it-for",
        destination: "/docs/getting-started/common-workflows",
        permanent: false,
      },
    ]
  },
})

export default config
