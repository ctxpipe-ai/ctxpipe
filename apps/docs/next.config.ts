import { createMDX } from "fumadocs-mdx/next"

const withMDX = createMDX()

const config = withMDX({
  reactStrictMode: true,
  output: "standalone",
  async rewrites() {
    return [{ source: "/docs/:path*.mdx", destination: "/llms.mdx/:path*" }]
  },
  async redirects() {
    return [
      {
        source: "/docs/connections/connecting-docs",
        destination: "/docs/connections",
        permanent: false,
      },
      {
        source: "/docs/connections/connecting-tools",
        destination: "/docs/connections",
        permanent: false,
      },
      {
        source: "/docs/connections/connected-sources",
        destination: "/docs/connections",
        permanent: false,
      },
      {
        source: "/docs/connections/source-connectors",
        destination: "/docs/connections",
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
        destination: "/docs/mcp/mcp-docs",
        permanent: false,
      },
      {
        source: "/docs/mcp/install-mcps-via-pr",
        destination: "/docs/mcp/mcp-docs",
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
        source: "/docs/managing-organization/team-members",
        destination: "/docs/managing-organization",
        permanent: false,
      },
      {
        source: "/docs/self-hosting/deployment",
        destination: "/docs/self-hosting",
        permanent: false,
      },
      {
        source: "/docs/getting-started/how-it-works",
        destination: "/docs/getting-started",
        permanent: false,
      },
      {
        source: "/docs/connections/ingestion",
        destination: "/docs/workspaces/indexing",
        permanent: false,
      },
      {
        source: "/docs/connections/faq",
        destination: "/docs/resources/faq",
        permanent: false,
      },
      {
        source: "/docs/managing-organization/verified-domains",
        destination: "/docs/resources/faq#can-i-verify-my-company-domain",
        permanent: false,
      },
      {
        source: "/docs/using-the-app/knowledge-graph",
        destination: "/docs/workspaces/graph",
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
