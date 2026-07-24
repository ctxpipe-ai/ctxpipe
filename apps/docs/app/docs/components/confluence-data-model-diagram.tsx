function Node({
  artifacts,
  label,
  title,
  tone,
}: {
  artifacts: Array<{ text: string; code?: boolean }>
  label: string
  title: string
  tone?: string
}) {
  return (
    <div className={`confluence-model-node ${tone ?? ""}`}>
      <div className="confluence-model-node-label">{label}</div>
      <div className="confluence-model-node-title">{title}</div>
      <div className="confluence-model-artifacts">
        {artifacts.map((artifact) => (
          <div
            className={`confluence-model-artifact ${artifact.code ? "code" : ""}`}
            key={artifact.text}
          >
            {artifact.text}
          </div>
        ))}
      </div>
    </div>
  )
}

function Arrow({
  double,
  label,
}: {
  double?: boolean
  label: string
}) {
  return (
    <div className="confluence-model-arrow">
      <div />
      <div className="confluence-model-arrow-centre">
        {double ? (
          <div className="confluence-model-arrow-lines-row">
            <div className="confluence-model-arrow-line-pair">
              <div className="confluence-model-arrow-solid-line" />
              <div className="confluence-model-arrow-solid-head" />
            </div>
            <div className="confluence-model-arrow-line-pair">
              <div className="confluence-model-arrow-dotted-line" />
              <div className="confluence-model-arrow-dotted-head" />
            </div>
          </div>
        ) : (
          <>
            <div className="confluence-model-arrow-solid-line" />
            <div className="confluence-model-arrow-solid-head" />
          </>
        )}
        <div className="confluence-model-arrow-label-main">{label}</div>
      </div>
      <div />
    </div>
  )
}

export function ConfluenceDataModelDiagram() {
  return (
    <figure
      className="not-prose confluence-model"
      aria-label="Confluence connector data flow"
    >
      <div className="confluence-model-title">
        <h3>Confluence connector - data flow</h3>
        <span>ctx|</span>
      </div>

      <div className="confluence-model-flow">
        <Node
          label="Source"
          title="Confluence Cloud"
          tone="source"
          artifacts={[
            { text: "Spaces and pages" },
            { text: "Change events" },
          ]}
        />

        <Arrow double label="OAuth reads / Forge events" />

        <Node
          label="Connector"
          title="ctx| Confluence Connector"
          tone="connector"
          artifacts={[
            { text: "Reads selected pages via OAuth" },
            { text: "Receives change events via Forge" },
            { text: "Converts pages to repo-backed files" },
          ]}
        />

        <Arrow label="Writes markdown and config" />

        <Node
          label="Sync target"
          title="GitHub Repository"
          tone="github"
          artifacts={[
            { text: "confluence/pages/", code: true },
            { text: "confluence/config.yaml", code: true },
            { text: "Git history / visible / reviewable" },
          ]}
        />

        <Arrow label="Repository ingestion" />

        <Node
          label="Ingestion"
          title="ctx| Ingestion"
          tone="ingest"
          artifacts={[
            { text: "Search index" },
            { text: "Knowledge graph" },
            { text: "Retrieval stores" },
          ]}
        />

        <Arrow label="Context retrieval" />

        <div className="confluence-model-mcp-agents">
          <Node
            label="Interface"
            title="ctx| MCP"
            tone="mcp"
            artifacts={[{ text: "ctx_advisor and ctx| tools" }]}
          />
          <div className="confluence-model-small-arrow" aria-hidden="true">
            <div className="confluence-model-small-arrow-line" />
            <div className="confluence-model-small-arrow-head" />
          </div>
          <Node
            label="Consumers"
            title="Agents"
            tone="agents"
            artifacts={[{ text: "Cursor / Claude Code / Codex / custom" }]}
          />
        </div>
      </div>

      <div className="confluence-model-legend">
        <div className="confluence-model-legend-item">
          <div className="confluence-model-legend-line-h">
            <div className="confluence-model-legend-solid" />
          </div>
          <span>Content movement</span>
        </div>
        <div className="confluence-model-legend-item">
          <div className="confluence-model-legend-line-h">
            <div className="confluence-model-legend-dotted" />
          </div>
          <span>Control / access signal (OAuth, Forge)</span>
        </div>
      </div>

      <figcaption>
        Selected Confluence content moves into a team-controlled GitHub
        repository before ctx| ingests it for search, graph context, and MCP
        tools.
      </figcaption>
    </figure>
  )
}
