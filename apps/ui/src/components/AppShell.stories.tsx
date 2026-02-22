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

export const Default: Story = {}
