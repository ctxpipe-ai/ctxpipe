import Link from "next/link"

export default function HomePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-zinc-950 text-zinc-100">
      <div className="max-w-2xl px-6 text-center">
        <p className="mb-3 font-mono text-sm tracking-widest text-teal-400 uppercase">
          ctx
        </p>
        <h1 className="mb-4 text-4xl font-semibold tracking-tight">
          Documentation
        </h1>
        <p className="mb-8 text-lg text-zinc-400">
          The context layer for AI agents. Self host or host with us.
        </p>
        <Link
          href="/docs"
          className="inline-flex items-center gap-2 rounded-md bg-teal-500 px-5 py-2.5 text-sm font-medium text-zinc-950 transition-colors hover:bg-teal-400"
        >
          Get started
        </Link>
      </div>
    </main>
  )
}
