import Link from "fumadocs-core/link"
import { LargeSearchToggle } from "fumadocs-ui/components/layout/search-toggle"
import { SidebarTrigger } from "fumadocs-ui/layouts/docs"
import { SidebarCollapseTrigger } from "fumadocs-ui/components/layout/sidebar"
import { buttonVariants } from "fumadocs-ui/components/ui/button"
import { cn } from "fumadocs-ui/utils/cn"
import { Sidebar as SidebarIcon } from "fumadocs-ui/internal/icons"

const APP_URL = "https://app.ctxpipe.ai"
const GITHUB_ORG_URL = "https://github.com/ctxpipe-ai"
/** Marketing CTA — change if you add a dedicated demo or calendar URL */
const GET_DEMO_URL = "https://ctxpipe.ai"

function GitHubMark({ className }: { className?: string }) {
  return (
    <svg
      role="img"
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden
    >
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  )
}

export function DocsCustomNav() {
  return (
    <header
      id="nd-subnav"
      className={cn(
        "fixed top-(--fd-banner-height) left-0 right-(--removed-body-scroll-bar-size,0) z-30",
        "flex w-full min-w-0 items-center justify-between gap-4 border-b border-fd-border px-4 py-3 sm:px-5",
      )}
    >
      <div className="flex min-w-0 shrink-0 items-center gap-2">
        {/* Mobile: open the drawer overlay */}
        <div className="flex items-center md:hidden">
          <SidebarTrigger
            className={cn(
              buttonVariants({
                color: "ghost",
                size: "icon-sm",
                className: "rounded-none p-2",
              }),
            )}
          >
            <SidebarIcon />
          </SidebarTrigger>
        </div>

        {/* Desktop: collapse / expand the pinned sidebar */}
        <div className="hidden items-center md:flex">
          <SidebarCollapseTrigger
            className={cn(
              buttonVariants({
                color: "ghost",
                size: "icon-sm",
                className: "rounded-none p-2 text-fd-muted-foreground hover:text-fd-foreground",
              }),
            )}
          >
            <SidebarIcon />
          </SidebarCollapseTrigger>
        </div>

        <Link
          href="https://ctxpipe.ai"
          className="inline-flex shrink-0 items-center gap-1.5 text-[15px] font-medium"
          external
        >
          <span
            className="font-mono font-semibold tracking-tight"
            style={{ color: "oklch(0.78 0.13 182)" }}
          >
            ctx|
          </span>
          <span className="hidden font-medium tracking-tight text-zinc-200 sm:inline">
            docs
          </span>
        </Link>
      </div>

      {/* Right cluster: Search → GitHub → App → Get demo (`justify-between` keeps this on the end) */}
      <nav
        className="flex min-w-0 shrink-0 items-center gap-2 sm:gap-3"
        aria-label="Search and product links"
      >
        {/*
          Fixed max width (not % of shrink-wrapped nav) so the field actually sizes;
          ~19rem matches a typical docs search pill.
        */}
        <div
          className="min-w-0 shrink-0"
          style={{
            width: "min(18rem, calc(100vw - 14rem))",
          }}
        >
          <LargeSearchToggle
            className="box-border flex w-full min-w-0 justify-start rounded-none text-xs"
            style={{ height: "2.25rem" }}
          />
        </div>

        <a
          href={GITHUB_ORG_URL}
          target="_blank"
          rel="noreferrer noopener"
          className={cn(
            buttonVariants({ color: "ghost", size: "icon-sm" }),
            "h-9 w-9 shrink-0 rounded-none text-zinc-200 no-underline hover:text-white",
          )}
          aria-label="ctxpipe-ai on GitHub"
        >
          <GitHubMark className="size-[18px]" />
        </a>

        <a
          href={APP_URL}
          target="_blank"
          rel="noreferrer noopener"
          className="docs-cta-app inline-flex shrink-0 items-center justify-center whitespace-nowrap no-underline"
          style={{
            height: "2.25rem",
            padding: "0 0.875rem",
            fontSize: "0.875rem",
            fontWeight: 500,
            lineHeight: 1,
            borderRadius: 0,
            border: "none",
            backgroundColor: "#ffffff",
            color: "#09090b",
            transition: "background-color 150ms",
          }}
        >
          App
        </a>

        <a
          href={GET_DEMO_URL}
          target="_blank"
          rel="noreferrer noopener"
          className="docs-cta-demo inline-flex shrink-0 items-center justify-center whitespace-nowrap no-underline"
          style={{
            height: "2.25rem",
            padding: "0 0.875rem",
            fontSize: "0.875rem",
            fontWeight: 500,
            lineHeight: 1,
            borderRadius: 0,
            border: "none",
            backgroundColor: "#18181b",
            color: "#ffffff",
            transition: "background-color 150ms",
          }}
        >
          Get demo
        </a>
      </nav>
    </header>
  )
}
