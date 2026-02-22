import { createFileRoute } from '@tanstack/react-router'
import { AppShell } from '@/components/AppShell'

export const Route = createFileRoute('/')({ component: App })

function App() {
  return <AppShell />
}
