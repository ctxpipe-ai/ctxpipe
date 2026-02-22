import { Heading, Text } from 'react-aria-components'

export function AppShell() {
  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100">
      <section className="mx-auto flex min-h-screen max-w-5xl items-center justify-center px-6">
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-10 shadow-xl shadow-black/20">
          <Text
            slot="description"
            className="font-mono text-xs uppercase tracking-[0.2em] text-primary-400"
          >
            ctxpipe ui
          </Text>
          <Heading className="mt-3 text-4xl font-semibold tracking-tight text-zinc-50">
            Hello world
          </Heading>
          <Text className="mt-4 max-w-md text-zinc-300">
            TanStack Start app scaffolded with React Aria + Tailwind, ready for
            UI architecture work.
          </Text>
        </div>
      </section>
    </main>
  )
}
