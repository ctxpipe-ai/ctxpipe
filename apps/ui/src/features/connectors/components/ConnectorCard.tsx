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
}

export function ConnectorCard({
  title,
  description,
  statusLabel,
  onSetup,
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
        <Button variant="primary" onPress={onSetup}>
          Set up
        </Button>
      </CardFooter>
    </Card>
  )
}
