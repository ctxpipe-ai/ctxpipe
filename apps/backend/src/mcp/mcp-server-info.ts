import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { Implementation } from "@modelcontextprotocol/sdk/types.js"

const moduleDir = dirname(fileURLToPath(import.meta.url))

function resolveBrandLogoPath(): string {
  return join(moduleDir, "..", "..", "public", "mcp-brand-logo.svg")
}

function readBrandSvg(): string | null {
  const path = resolveBrandLogoPath()
  if (!existsSync(path)) return null
  return readFileSync(path, "utf8")
}

function svgToDataUri(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

/** Public path (same origin as MCP) for clients that fetch icons by URL. */
export const MCP_BRAND_LOGO_PATH = "/.well-known/ctxpipe/mcp-brand-logo.svg"

const implementationByBaseUrl = new Map<string, Implementation>()

export function getMcpServerImplementation(
  authBaseUrl: string | undefined,
): Implementation {
  const base = (authBaseUrl?.trim() || "https://localhost:3000").replace(
    /\/$/,
    "",
  )
  const hit = implementationByBaseUrl.get(base)
  if (hit) return hit

  const svg = readBrandSvg()
  const urlIcon = `${base}${MCP_BRAND_LOGO_PATH}`

  const icons =
    svg !== null
      ? [
          {
            src: svgToDataUri(svg),
            mimeType: "image/svg+xml",
            sizes: ["196x106"],
          },
          { src: urlIcon, mimeType: "image/svg+xml" },
        ]
      : [{ src: urlIcon, mimeType: "image/svg+xml" }]

  const impl: Implementation = {
    name: "ctxpipe",
    title: "ctx|",
    version: "0.1.0",
    websiteUrl: base,
    icons,
  }
  implementationByBaseUrl.set(base, impl)
  return impl
}

export function getMcpBrandLogoAbsolutePath(): string {
  return resolveBrandLogoPath()
}
