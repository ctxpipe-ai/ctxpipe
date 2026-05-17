const accountRail = [
  {
    label: "Actor",
    title: "User",
    description: "Signs in via Atlassian OAuth from ctx|",
  },
  {
    label: "Atlassian OAuth",
    title: "Account and permission grant",
    description:
      "Confirms account, discovers sites, grants API access to selected site",
  },
  {
    label: "ctx| stores",
    title: "Linked account and site",
    description: "OAuth token stored, site linked, awaiting Forge confirmation",
  },
]

const siteRail = [
  {
    label: "Actor",
    title: "Confluence admin",
    description: "Installs ctx| Forge app into the Confluence site",
  },
  {
    label: "ctx| Forge app",
    title: "Runs inside Confluence site",
    description: "Sends install status and page or space change events to ctx|",
  },
  {
    label: "ctx| receives",
    title: "Site events",
    description: "Install confirmed, change events flowing, sync triggered",
  },
]

function FlowRail({
  items,
  tone,
  title,
}: {
  items: typeof accountRail
  tone: "a" | "b"
  title: string
}) {
  return (
    <div className="confluence-flow-rail">
      <div className={`confluence-flow-rail-header ${tone}`}>{title}</div>
      {items.map((item, index) => (
        <div key={item.title}>
          <div className={`confluence-flow-step ${tone}`}>
            <div className="confluence-flow-step-label">{item.label}</div>
            <div className="confluence-flow-step-title">{item.title}</div>
            <div className="confluence-flow-step-desc">{item.description}</div>
          </div>
          {index < items.length - 1 ? (
            <div className={`confluence-flow-arrow ${tone}`}>
              <div className="confluence-flow-arrow-line" />
              <div className="confluence-flow-arrow-head" />
            </div>
          ) : null}
        </div>
      ))}
    </div>
  )
}

export function ConfluenceDataFlowDiagram() {
  return (
    <figure
      className="not-prose confluence-flow"
      aria-label="Confluence connector data flow"
    >
      <div className="confluence-flow-title">
        <div className="confluence-flow-kicker">ctx| / Confluence connector</div>
        <div className="confluence-flow-heading">
          OAuth reads. Forge <span>notifies.</span>
        </div>
      </div>

      <div className="confluence-flow-rails">
        <FlowRail
          items={accountRail}
          tone="a"
          title="Rail A / Account and API access"
        />
        <div className="confluence-flow-center" aria-hidden="true">
          <div />
        </div>
        <FlowRail
          items={siteRail}
          tone="b"
          title="Rail B / Site app and change events"
        />
      </div>

      <div className="confluence-flow-converge" aria-hidden="true">
        <div className="confluence-flow-converge-left" />
        <div className="confluence-flow-converge-right" />
        <div className="confluence-flow-converge-dot" />
      </div>
      <div className="confluence-flow-drop" aria-hidden="true">
        <div />
        <span />
      </div>

      <div className="confluence-flow-connector">
        <div className="confluence-flow-connector-label">Converged state</div>
        <div className="confluence-flow-connector-title">
          ctx| Confluence Connector - active
        </div>
        <div className="confluence-flow-checks">
          <span>Site linked via OAuth</span>
          <span>Forge installed and events flowing</span>
          <span>Spaces selected for sync</span>
          <span>Changes auto-captured</span>
        </div>
      </div>

      <div className="confluence-flow-output-arrow" aria-hidden="true">
        <div />
        <span />
      </div>

      <div className="confluence-flow-output">
        <div>GitHub sync repo - ingestion - knowledge graph</div>
        <div className="confluence-flow-output-chips">
          <span>git-native</span>
          <span>auto-synced</span>
          <span>agent-ready</span>
        </div>
      </div>

      <div className="confluence-flow-why">
        <div>
          <div className="confluence-flow-why-label a">OAuth</div>
          <p>Gives ctx| permission to read Confluence content via Atlassian APIs.</p>
        </div>
        <div className="confluence-flow-why-div" />
        <div>
          <div className="confluence-flow-why-label b">Forge</div>
          <p>Lets the Confluence site notify ctx| when content changes.</p>
        </div>
        <div className="confluence-flow-why-div" />
        <div>
          <div className="confluence-flow-why-label c">Why both</div>
          <p>OAuth reads. Forge watches. Neither alone is enough.</p>
        </div>
      </div>

      <figcaption>
        OAuth grants read access. Forge confirms installation and sends change
        events. Together they let ctx| sync selected Confluence content into a
        GitHub-backed source.
      </figcaption>
    </figure>
  )
}
