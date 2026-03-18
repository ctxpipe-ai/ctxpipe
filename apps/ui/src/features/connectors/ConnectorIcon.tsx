import {
  siConfluence,
  siJira,
  siNotion,
  siLinear,
  siGithub,
  siGitlab,
} from "simple-icons"
import { IconCloud } from "@tabler/icons-react"

const ICON_MAP: Record<string, { path: string; hex: string }> = {
  confluence: siConfluence,
  jira: siJira,
  notion: siNotion,
  linear: siLinear,
  github: siGithub,
  gitlab: siGitlab,
}

interface ConnectorIconProps {
  type: string
  className?: string
}

export function ConnectorIcon({ type, className = "h-5 w-5" }: ConnectorIconProps) {
  const icon = ICON_MAP[type.toLowerCase()]

  if (!icon) {
    return <IconCloud className={className} />
  }

  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill={`#${icon.hex}`}
      aria-hidden="true"
      role="img"
    >
      <path d={icon.path} />
    </svg>
  )
}
