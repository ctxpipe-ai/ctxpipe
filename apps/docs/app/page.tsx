import Link from "next/link"

export default function HomePage() {
  return (
    <main
      className="flex min-h-screen flex-col items-center justify-center px-6"
      style={{ backgroundColor: "oklch(0.145 0.004 286)" }}
    >
      <div className="w-full max-w-xl text-center">
        {/* Eyebrow — mirrors the "Open Source / Coming soon" badge treatment */}
        <p
          className="mb-4 flex items-center justify-center gap-2 text-xs font-medium tracking-tight text-zinc-200"
          aria-label="ctxpipe docs"
        >
          <img
            src="/ctx_.svg"
            alt=""
            className="docs-landing-brand-mark select-none"
            draggable={false}
          />
          <span className="font-medium">docs</span>
        </p>

        <h1
          className="mb-4 text-4xl font-semibold tracking-tight"
          style={{ color: "oklch(0.96 0 0)" }}
        >
          The Context Layer for AI Agents
        </h1>

        <p
          className="mb-10 text-base leading-relaxed"
          style={{ color: "oklch(0.62 0.004 286)" }}
        >
          Self-learning knowledge graph infrastructure for autonomous coding
          agents. Self host or host with us.
        </p>

        <div className="flex items-center justify-center gap-4">
          <Link
            href="/docs"
            className="inline-flex items-center rounded-md px-5 py-2.5 text-sm font-medium transition-colors"
            style={{
              backgroundColor: "oklch(0.78 0.13 182)",
              color: "oklch(0.15 0.04 182)",
            }}
          >
            Get started
          </Link>
          <Link
            href="https://ctxpipe.ai"
            className="inline-flex items-center gap-1.5 text-sm transition-colors"
            style={{ color: "oklch(0.62 0.004 286)" }}
          >
            ctxpipe.ai
            <svg
              width="12"
              height="12"
              viewBox="0 0 12 12"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M2.5 9.5L9.5 2.5M9.5 2.5H5M9.5 2.5V7"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </Link>
        </div>
      </div>
    </main>
  )
}
