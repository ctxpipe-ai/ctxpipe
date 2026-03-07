import { createMDX } from "fumadocs-mdx/next"

const withMDX = createMDX()

const config = withMDX({
  reactStrictMode: true,
  output: "standalone",
})

export default config
