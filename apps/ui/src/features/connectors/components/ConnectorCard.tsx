import { Button } from "@/components/ui/Button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/Card"

type ConnectorCardProps = {
  title: string
  description: string
  statusLabel: string
  onSetup: () => void
  onManageScope?: () => void
  canManageScope?: boolean
}

export function ConnectorCard({
  title,
  description,
  statusLabel,
  onSetup,
  onManageScope,
  canManageScope = false,
}: ConnectorCardProps) {
  return (
    <Card className="rounded-xl">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <span className="inline-flex rounded-full border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-300">
          {statusLabel}
        </span>
      </CardContent>
      <CardFooter className="justify-end">
        <div className="flex gap-2">
          {canManageScope && onManageScope ? (
            <Button variant="secondary" onPress={onManageScope}>
              Manage scope
            </Button>
          ) : null}
          <Button variant="primary" onPress={onSetup}>
            Set up
          </Button>
        </div>
      </CardFooter>
    </Card>
  )
}
