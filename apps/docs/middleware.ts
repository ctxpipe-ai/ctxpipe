import type { NextRequest } from "next/server"
import { NextResponse } from "next/server"

/**
 * Serve the Fumadocs index at `/` while keeping `baseUrl: "/docs"` for generated links.
 * Middleware rewrites are applied reliably in dev (including Turbopack); `rewrites` in
 * `next.config.ts` alone has been flaky for some setups hitting `/`.
 */
export function middleware(request: NextRequest) {
  if (request.nextUrl.pathname === "/") {
    const url = request.nextUrl.clone()
    url.pathname = "/docs"
    return NextResponse.rewrite(url)
  }
  return NextResponse.next()
}

export const config = {
  matcher: "/",
}
