/**
 * A synthetic Workspace of an engineering org, with the shapes that real
 * Workspaces have: a hub service with hundreds of notes and thousands of
 * rules, decisions scoped to one service, to some services, or to all of
 * them, decisions that a later one replaced, owners that changed, and pull
 * requests over two years that mostly also change one shared manifest note.
 * The graph relevance eval walks it. Every name is made up. The same call
 * gives the same Workspace and the same gold answers.
 *
 * The `free-form` vocabulary builds the same Workspace with the names that
 * authors and agents write: `GOVERNS` for a decision, `IMPORTS` for a
 * library, and plain body links (`LINKS_TO`) from a team to its services and
 * from a lesson to the note that declares it. Only the edges that
 * git gives (`CHANGED`, `MODIFIED`, `ADDED`) keep their names. The gold
 * answers do not change.
 *
 * The gold answers come from how the fixture is built, never from a ranking.
 * The Workspace graph stores no node-level authority, so no gold answer
 * depends on one.
 */
import type { RelatedUnit } from "../src/test/related-fixture.js"

export type EvalIntent = "ownership" | "why" | "change" | "dependencies"

export type EvalQuestion = {
  intent: EvalIntent
  /** The path of the seed unit. */
  seed: string
  /** True for the service with the hub shapes. */
  hub: boolean
  /** The paths that a good answer holds. */
  gold: ReadonlySet<string>
  /** How many of them the top results must hold at most (recall is out of this). */
  k: number
}

export type WorkspaceOrgFixture = {
  /** The ranking time of the eval: edges and recency count as of this instant. */
  now: Date
  units: RelatedUnit[]
  questions: EvalQuestion[]
}

const serviceNames = [
  "billing",
  "auth",
  "search",
  "notifications",
  "gateway",
  "reports",
]

/** `canonical` uses the predicates of the presets; `free-form` does not. */
export type EvalVocabulary = "canonical" | "free-form"

const FREE_FORM_NAMES: Readonly<Record<string, string>> = {
  OWNS: "MAINTAINED",
  USES_LIBRARY: "IMPORTS",
  WRITES_TO: "STORES_DATA_IN",
  READS_FROM: "CACHES_IN",
  DEPENDS_ON: "CALLS",
  PART_OF: "DESCRIBES",
  APPLIES_TO: "ENFORCED_ON",
  INFLUENCES: "GOVERNS",
  SUPERSEDES: "REPLACES",
}

export function workspaceOrgFixture(
  vocabulary: EvalVocabulary = "canonical",
  today = "2026-10-05",
): WorkspaceOrgFixture {
  const freeForm = vocabulary === "free-form"
  const now = new Date(`${today}T00:00:00.000Z`)
  let state = 42
  const random = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff
    return state / 0x7fffffff
  }
  const daysAgo = (days: number) =>
    new Date(now.getTime() - days * 86_400_000).toISOString()

  const units = new Map<string, RelatedUnit>()
  const unit = (path: string, kind: string, title = path) => {
    units.set(path, { path, kind, title, claims: [] })
    return path
  }
  const claim = (
    from: string,
    predicate: string,
    to: string,
    confidence: number,
    extra: { validFrom?: string; validTo?: string } = {},
  ) => {
    units.get(from)?.claims?.push({
      to,
      predicate: (freeForm && FREE_FORM_NAMES[predicate]) || predicate,
      confidence,
      ...extra,
    })
  }
  /** A body link in the free-form vocabulary, else the claim. */
  const linkOr = (
    from: string,
    predicate: string,
    to: string,
    confidence: number,
  ) => {
    const source = units.get(from)
    if (freeForm && source) source.links = [...(source.links ?? []), to]
    else claim(from, predicate, to, confidence)
  }

  const servicePath = (name: string) => `knowledge/services/${name}.md`
  const services = serviceNames.map((name) =>
    unit(servicePath(name), "Service", name),
  )
  const teams = ["payments", "identity", "discovery", "platform"].map((team) =>
    unit(`knowledge/teams/${team}.md`, "Team", team),
  )
  const libraries = ["zod", "drizzle", "hono", "pino", "lodash", "react"].map(
    (name) => unit(`knowledge/libraries/${name}.md`, "Library", name),
  )
  const databases = ["postgres", "redis"].map((name) =>
    unit(`knowledge/databases/${name}.md`, "Database", name),
  )
  const gateway = servicePath("gateway")

  const questions: EvalQuestion[] = []
  const dependencies = new Map<string, Set<string>>()
  const addDependency = (
    service: string,
    predicate: string,
    target: string,
    confidence: number,
  ) => {
    claim(service, predicate, target, confidence)
    dependencies.set(
      service,
      (dependencies.get(service) ?? new Set()).add(target),
    )
  }

  // Owners: the team that owns a service now, one earlier owner whose edge
  // ended in 2025, and a team that only contributes (a different predicate).
  const owners = new Map<string, string[]>()
  for (const [index, service] of services.entries()) {
    const owner = teams[index % teams.length] as string
    linkOr(owner, "OWNS", service, 0.95)
    owners.set(service, [owner])
    const contributor = teams[(index + 1) % teams.length] as string
    claim(contributor, "CONTRIBUTES_TO", service, 0.7)
    if (index % 3 === 0) {
      const earlier = teams[(index + 2) % teams.length] as string
      claim(earlier, "OWNS", service, 0.9, {
        validFrom: "2023-01-01T00:00:00.000Z",
        validTo: "2025-12-31T00:00:00.000Z",
      })
    }
  }

  for (const service of services) {
    for (const library of libraries) {
      if (random() < 0.6) addDependency(service, "USES_LIBRARY", library, 0.7)
    }
    addDependency(service, "WRITES_TO", databases[0] as string, 0.7)
    if (random() < 0.5)
      addDependency(service, "READS_FROM", databases[1] as string, 0.7)
    // The gateway depends on every other service. For another service this is
    // an inbound edge, a distractor, and no gold.
    if (service !== gateway) addDependency(gateway, "DEPENDS_ON", service, 0.7)
  }

  // Hub shapes: the billing service has 900 notes (low confidence) and 3,000
  // rules and lessons that apply to it or to the auth service.
  const billing = servicePath("billing")
  for (const name of serviceNames) {
    const count = name === "billing" ? 900 : 120
    for (let index = 0; index < count; index++) {
      const note = unit(`knowledge/notes/${name}/n${index}.md`, "Note")
      claim(note, "PART_OF", servicePath(name), 0.6)
    }
  }
  const manifest = unit("knowledge/shared/package-manifest.md", "Note")
  const lessons = unit("knowledge/shared/lessons-learned.md", "Note")
  for (let index = 0; index < 3000; index++) {
    const lesson = index < 400
    const rule = unit(
      `knowledge/rules/r${index}.md`,
      lesson ? "Lesson" : "Rule",
    )
    claim(
      rule,
      "APPLIES_TO",
      index % 2 ? servicePath("auth") : billing,
      lesson ? 0.72 : 0.82,
    )
    if (lesson) linkOr(rule, "DECLARED_IN", lessons, 0.95)
  }

  // Decisions: 6 scoped to one service, 8 to some, 16 to all. Every seventh
  // was replaced by the next: its edge ended when the next one began.
  const decisions: string[] = []
  const influences = new Map<
    string,
    Array<{ decision: string; confidence: number }>
  >()
  const decisionDate = (index: number) => daysAgo(700 - index * 20)
  for (let index = 1; index <= 30; index++) {
    const decision = unit(
      `knowledge/decisions/adr-${index}.md`,
      "Decision",
      `ADR-${index}`,
    )
    decisions.push(decision)
    const replaced = index % 7 === 0
    const endsAt = replaced ? decisionDate(index + 1) : undefined
    const scope =
      index <= 6
        ? [{ service: services[index - 1] as string, confidence: 0.9 }]
        : index <= 14
          ? [
              {
                service: services[index % services.length] as string,
                confidence: 0.8,
              },
            ]
          : services.map((service) => ({ service, confidence: 0.6 }))
    for (const { service, confidence } of scope) {
      // A decision that holds has no end and no start date: the truth
      // signal would decay it by age, but a decision stays true until a
      // later one replaces it.
      claim(
        decision,
        "INFLUENCES",
        service,
        confidence,
        endsAt ? { validFrom: decisionDate(index), validTo: endsAt } : {},
      )
      if (!replaced) {
        const list = influences.get(service) ?? []
        list.push({ decision, confidence })
        influences.set(service, list)
      }
    }
    if (replaced) {
      claim(
        `knowledge/decisions/adr-${index + 1}.md`,
        "SUPERSEDES",
        decision,
        0.9,
      )
    }
    const request = unit(`github/pull-requests/adr-${index}.md`, "PullRequest")
    claim(request, "ADDED", decision, 0.95, { validFrom: decisionDate(index) })
  }
  // 400 pull requests over two years. Each changes one service: one CHANGED
  // edge to the service (the extractor derives it) and three note edges. Most
  // also change the shared manifest note, a hub of about 320 pull requests.
  const changes = new Map<
    string,
    Array<{ request: string; mergedAt: string }>
  >()
  for (let index = 0; index < 400; index++) {
    const mergedAt = daysAgo(random() * 730)
    const service = services[Math.floor(random() * services.length)] as string
    const request = unit(
      `github/pull-requests/${index}.md`,
      "PullRequest",
      `Change ${index}`,
    )
    claim(request, "CHANGED", service, 0.95, { validFrom: mergedAt })
    const name = service.split("/").pop()?.replace(".md", "") as string
    const count = name === "billing" ? 900 : 120
    for (let k = 0; k < 3; k++) {
      claim(
        request,
        "MODIFIED",
        `knowledge/notes/${name}/n${Math.floor(random() * count)}.md`,
        0.95,
        { validFrom: mergedAt },
      )
    }
    if (random() < 0.8)
      claim(request, "MODIFIED", manifest, 0.95, { validFrom: mergedAt })
    if (random() < 0.05)
      claim(request, "MODIFIED", lessons, 0.95, { validFrom: mergedAt })
    changes.set(service, [
      ...(changes.get(service) ?? []),
      { request, mergedAt },
    ])
  }

  for (const service of services) {
    const hub = service === billing
    const add = (intent: EvalIntent, gold: readonly string[], k = 5) => {
      if (gold.length > 0)
        questions.push({ intent, seed: service, hub, gold: new Set(gold), k })
    }
    add("ownership", owners.get(service) ?? [])
    add(
      "why",
      (influences.get(service) ?? [])
        .filter((item) => item.confidence >= 0.8)
        .map((item) => item.decision),
    )
    add(
      "change",
      (changes.get(service) ?? [])
        .sort((a, b) => (a.mergedAt < b.mergedAt ? 1 : -1))
        .slice(0, 5)
        .map((item) => item.request),
    )
    add("dependencies", [...(dependencies.get(service) ?? [])])
  }

  return { now, units: [...units.values()], questions }
}
