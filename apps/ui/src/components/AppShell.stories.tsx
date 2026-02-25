import type { Meta, StoryObj } from '@storybook/react-vite'
import { AppShell } from './AppShell'

const meta = {
  title: 'App/AppShell',
  component: AppShell,
  parameters: {
    layout: 'fullscreen',
  },
} satisfies Meta<typeof AppShell>

export default meta

type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {
    children: (
      <section className="mx-auto max-w-3xl rounded-2xl border border-zinc-800/90 bg-zinc-900/70 p-8 text-zinc-100 shadow-2xl shadow-black/30 backdrop-blur-sm">
        <p className="font-mono text-xs uppercase tracking-[0.24em] text-primary-300">
          Storybook preview
        </p>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight text-zinc-50">
          App shell content area
        </h1>
        <p className="mt-4 text-zinc-300">
          Pages should always pass explicit children into the shell.
        </p>
      </section>
    ),
  },
}
