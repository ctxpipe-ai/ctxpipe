import { IconExternalLink } from "@tabler/icons-react"
import type { ReactNode } from "react"

import { Link } from "@/components/ui/Link"

export function ExternalLink(props: { href: string; children: ReactNode }) {
  return (
    <Link href={props.href} target="_blank" rel="noreferrer">
      {props.children}
      <IconExternalLink className="ml-1 inline size-3.5" aria-hidden />
    </Link>
  )
}
