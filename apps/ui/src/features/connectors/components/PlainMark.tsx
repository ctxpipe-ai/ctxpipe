import { IconLifebuoy } from "@tabler/icons-react"

type PlainMarkProps = {
  className?: string
}

/**
 * The mark of the Plain connector. Simple Icons has no Plain logo, so this
 * is a generic support icon until ctxpipe may use the Plain logo.
 */
export function PlainMark({ className }: PlainMarkProps) {
  return <IconLifebuoy className={className} aria-hidden />
}
