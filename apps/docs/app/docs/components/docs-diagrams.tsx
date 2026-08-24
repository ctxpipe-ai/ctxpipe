import { DocsIcon } from "./docs-icon"

const connectorKinds = [
  {
    icon: "git" as const,
    title: "Git sources",
    example: "GitHub",
    description: "Index repositories directly for search and graph extraction.",
    tone: "teal",
  },
  {
    icon: "book" as const,
    title: "Scoped mirrors",
    example: "Linear · Notion · Confluence",
    description:
      "Review source scope in Git, then keep selected content current.",
    tone: "violet",
  },
  {
    icon: "chat" as const,
    title: "Intent capture",
    example: "Slack",
    description:
      "Capture a valuable thread on demand instead of mirroring channels.",
    tone: "amber",
  },
]

export function ConnectorKindsDiagram() {
  return (
    <div className="not-prose docs-connector-kinds">
      {connectorKinds.map((kind) => (
        <article
          className={`docs-connector-kind is-${kind.tone}`}
          key={kind.title}
        >
          <div className="docs-connector-kind__icon">
            <DocsIcon name={kind.icon} className="size-5" />
          </div>
          <div>
            <span>{kind.example}</span>
            <h3>{kind.title}</h3>
            <p>{kind.description}</p>
          </div>
        </article>
      ))}
    </div>
  )
}
