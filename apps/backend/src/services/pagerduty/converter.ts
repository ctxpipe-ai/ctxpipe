import { isConnectorAssetCredentialUrl } from "../connectors/assets.js"
import { connectorPathSegment } from "../connectors/path-segment.js"

export const PAGERDUTY_MANAGED_ROOT = "pagerduty"
export const PAGERDUTY_CONFIG_PATH = `${PAGERDUTY_MANAGED_ROOT}/config.yaml`
const PAGERDUTY_MAX_ADDITIONAL_ALERT_SUMMARIES = 4

/** The incident folder of the legacy per-connection mirror. */
const PAGERDUTY_LEGACY_INCIDENTS_ROOT = `${PAGERDUTY_MANAGED_ROOT}/incidents/`

/**
 * The incident folder of one service in a Workspace source (ADR-034, ADR-050).
 * The sources sync gives ownership by path prefix, so each service has its
 * own folder.
 */
export function pagerdutyServiceIncidentsRoot(serviceId: string): string {
  return `${PAGERDUTY_MANAGED_ROOT}/services/${serviceId}/incidents/`
}

const ROUTING_KEY_PATTERN = /routing[_-]?key/i

type PagerdutyMirrorFile = {
  path: string
  content: string
  encoding?: "utf-8" | "base64"
}

export type PagerdutyAlertContext = {
  type: string
  href?: string
  src?: string
  text?: string
}

export type PagerdutyAlertForMirror = {
  id: string
  summary: string
  severity?: string | null
  status?: string | null
  createdAt?: string | null
  alertKey?: string | null
  integrationName?: string | null
  details?: Record<string, unknown> | null
  contexts?: PagerdutyAlertContext[]
}

export type PagerdutyNoteForMirror = {
  id: string
  content: string
  createdAt?: string | null
  userName?: string | null
}

export type PagerdutyIncidentForMirror = {
  id: string
  number: number
  title: string
  htmlUrl: string
  status: string
  urgency?: string | null
  priority?: string | null
  createdAt?: string | null
  updatedAt?: string | null
  serviceId: string
  serviceName?: string | null
  serviceUrl?: string | null
  assigneeName?: string | null
  assigneeUrl?: string | null
  escalationPolicyName?: string | null
  escalationPolicyUrl?: string | null
  teamName?: string | null
  teamUrl?: string | null
  alerts: PagerdutyAlertForMirror[]
  notes: PagerdutyNoteForMirror[]
}

type PagerdutyAlertAssetCandidate = {
  sourceUrl: string
  sourceKey: string
  filename: string
  label: string
}

function pagerdutyImageSourceIsUnsafe(src: string): boolean {
  return isConnectorAssetCredentialUrl(src, { includeGenericCredentials: true })
}

export function pagerdutyIncidentImageStub(
  label: string,
  incidentUrl: string,
): string {
  return `[image: ${label} — view in PagerDuty](${incidentUrl})`
}

export function pagerdutyIncidentMarkdownPath(
  number: number,
  id: string,
  root = PAGERDUTY_LEGACY_INCIDENTS_ROOT,
): string {
  return `${root}${number}--${connectorPathSegment(id)}.md`
}

function pagerdutyIncidentAssetPrefix(
  number: number,
  id: string,
  root = PAGERDUTY_LEGACY_INCIDENTS_ROOT,
): string {
  return `${root}${number}--${connectorPathSegment(id)}/`
}

function pagerdutyIncidentAssetDir(
  number: number,
  id: string,
  root = PAGERDUTY_LEGACY_INCIDENTS_ROOT,
): string {
  return `${pagerdutyIncidentAssetPrefix(number, id, root)}assets/`
}

/**
 * The link from an incident Markdown file to one of its mirrored assets. It
 * uses the same cleaned id as the paths above, so the link and the path
 * always match.
 */
export function pagerdutyIncidentAssetLink(
  number: number,
  id: string,
  assetPath: string,
): string {
  return `./${number}--${connectorPathSegment(id)}/assets/${assetPath.slice(assetPath.lastIndexOf("/") + 1)}`
}

function yamlScalar(value: string): string {
  return JSON.stringify(value)
}

function stripRoutingKeys(
  details: Record<string, unknown>,
): Record<string, unknown> {
  const next: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(details)) {
    if (ROUTING_KEY_PATTERN.test(key)) continue
    next[key] = value
  }
  return next
}

function definitionList(details: Record<string, unknown>): string[] {
  const safe = stripRoutingKeys(details)
  return Object.entries(safe).map(([key, value]) => {
    const rendered =
      typeof value === "string" || typeof value === "number"
        ? String(value)
        : JSON.stringify(value)
    return `- **${key}:** ${rendered}`
  })
}

export function pagerdutyAlertAssetCandidates(
  incident: PagerdutyIncidentForMirror,
  root = PAGERDUTY_LEGACY_INCIDENTS_ROOT,
): PagerdutyAlertAssetCandidate[] {
  const prefix = pagerdutyIncidentAssetDir(incident.number, incident.id, root)
  const candidates: PagerdutyAlertAssetCandidate[] = []
  const [trigger, ...rest] = incident.alerts
  const mirrored = trigger
    ? [trigger, ...rest.slice(0, PAGERDUTY_MAX_ADDITIONAL_ALERT_SUMMARIES)]
    : []
  for (const alert of mirrored) {
    for (const [index, context] of (alert.contexts ?? []).entries()) {
      if (context.type !== "image" || !context.src) continue
      if (pagerdutyImageSourceIsUnsafe(context.src)) continue
      candidates.push({
        sourceUrl: context.src,
        sourceKey: `${alert.id}-image-${index}`,
        filename: `${connectorPathSegment(alert.id)}-image-${index}.png`,
        label: context.text ?? "alert image",
      })
    }
  }
  return candidates.map((candidate) => ({
    ...candidate,
    filename: `${prefix}${candidate.filename}`,
  }))
}

export function renderPagerdutyIncidentMarkdown(
  incident: PagerdutyIncidentForMirror,
): string {
  const [trigger, ...rest] = incident.alerts
  const extra = rest.slice(0, PAGERDUTY_MAX_ADDITIONAL_ALERT_SUMMARIES)
  const overflow = rest.length - extra.length
  const lines = [
    "---",
    "source: pagerduty",
    `pagerduty_id: ${yamlScalar(incident.id)}`,
    `incident_number: ${incident.number}`,
    `url: ${yamlScalar(incident.htmlUrl)}`,
    `service_id: ${yamlScalar(incident.serviceId)}`,
    ...(incident.serviceName
      ? [`service_name: ${yamlScalar(incident.serviceName)}`]
      : []),
    `status: ${yamlScalar(incident.status)}`,
    ...(incident.urgency ? [`urgency: ${yamlScalar(incident.urgency)}`] : []),
    ...(incident.priority
      ? [`priority: ${yamlScalar(incident.priority)}`]
      : []),
    ...(incident.createdAt
      ? [`created_at: ${yamlScalar(incident.createdAt)}`]
      : []),
    ...(incident.updatedAt
      ? [`updated_at: ${yamlScalar(incident.updatedAt)}`]
      : []),
    "---",
    "",
    `# ${incident.title}`,
    "",
  ]

  const refs: string[] = []
  if (incident.serviceName) {
    refs.push(
      incident.serviceUrl
        ? `Service: [${incident.serviceName}](${incident.serviceUrl})`
        : `Service: ${incident.serviceName}`,
    )
  }
  if (incident.assigneeName) {
    refs.push(
      incident.assigneeUrl
        ? `Assignee: [${incident.assigneeName}](${incident.assigneeUrl})`
        : `Assignee: ${incident.assigneeName}`,
    )
  }
  if (incident.escalationPolicyName) {
    refs.push(
      incident.escalationPolicyUrl
        ? `Escalation: [${incident.escalationPolicyName}](${incident.escalationPolicyUrl})`
        : `Escalation: ${incident.escalationPolicyName}`,
    )
  }
  if (incident.teamName) {
    refs.push(
      incident.teamUrl
        ? `Team: [${incident.teamName}](${incident.teamUrl})`
        : `Team: ${incident.teamName}`,
    )
  }
  if (refs.length > 0) {
    lines.push(...refs.map((line) => `- ${line}`), "")
  }

  lines.push("## Alerts", "")
  if (!trigger) {
    lines.push("No alerts were returned for this incident.", "")
  } else {
    lines.push(`### ${trigger.summary}`, "")
    if (trigger.severity) lines.push(`- **Severity:** ${trigger.severity}`)
    if (trigger.status) lines.push(`- **Status:** ${trigger.status}`)
    if (trigger.createdAt) lines.push(`- **Created:** ${trigger.createdAt}`)
    if (trigger.alertKey) lines.push(`- **Alert key:** ${trigger.alertKey}`)
    if (trigger.integrationName) {
      lines.push(`- **Integration:** ${trigger.integrationName}`)
    }
    if (
      trigger.details &&
      Object.keys(stripRoutingKeys(trigger.details)).length > 0
    ) {
      lines.push("", "#### Details", "")
      lines.push(...definitionList(trigger.details), "")
    }
    const links = (trigger.contexts ?? []).filter(
      (context) => context.type === "link" && context.href,
    )
    if (links.length > 0) {
      lines.push("#### Links", "")
      for (const link of links) {
        lines.push(`- [${link.text ?? link.href}](${link.href})`)
      }
      lines.push("")
    }
    const images = (trigger.contexts ?? []).filter(
      (context) => context.type === "image" && context.src,
    )
    if (images.length > 0) {
      lines.push("#### Images", "")
      for (const image of images) {
        const label = image.text ?? "alert image"
        lines.push(
          !image.src || pagerdutyImageSourceIsUnsafe(image.src)
            ? pagerdutyIncidentImageStub(label, incident.htmlUrl)
            : `![${label}](${image.src})`,
        )
      }
      lines.push("")
    }
    if (extra.length > 0) {
      lines.push("### Other alerts", "")
      for (const alert of extra) {
        const bits = [
          alert.createdAt,
          alert.severity,
          alert.summary,
          alert.status,
        ]
          .filter(Boolean)
          .join(" · ")
        lines.push(`- ${bits}`)
      }
      lines.push("")
    }
    if (overflow > 0) {
      lines.push(
        `${overflow} further alerts not mirrored. See [${incident.htmlUrl}](${incident.htmlUrl}).`,
        "",
      )
    }
  }

  if (incident.notes.length > 0) {
    lines.push("## Notes", "")
    for (const note of incident.notes) {
      const who = [note.userName, note.createdAt].filter(Boolean).join(" · ")
      if (who) lines.push(`### ${who}`, "")
      lines.push(note.content, "")
    }
  }

  return `${lines.join("\n").trim()}\n`
}

export function pagerdutyIncidentMirrorFiles(
  incident: PagerdutyIncidentForMirror,
  root = PAGERDUTY_LEGACY_INCIDENTS_ROOT,
): PagerdutyMirrorFile[] {
  return [
    {
      path: pagerdutyIncidentMarkdownPath(incident.number, incident.id, root),
      content: renderPagerdutyIncidentMarkdown(incident),
    },
  ]
}

export function pagerdutyManagedPathsForIncidentId(
  paths: string[],
  incidentId: string,
  root = PAGERDUTY_LEGACY_INCIDENTS_ROOT,
): string[] {
  const fileSuffix = `--${connectorPathSegment(incidentId)}.md`
  const dirNeedle = `--${connectorPathSegment(incidentId)}/`
  return paths.filter(
    (path) =>
      path.startsWith(root) &&
      (path.endsWith(fileSuffix) || path.includes(dirNeedle)),
  )
}

export function rewritePagerdutyIncidentImageSrcs(
  markdown: string,
  replacements: Array<{ sourceUrl: string; relativePath: string }>,
): string {
  let next = markdown
  for (const replacement of replacements) {
    next = next.split(replacement.sourceUrl).join(replacement.relativePath)
  }
  return next
}
