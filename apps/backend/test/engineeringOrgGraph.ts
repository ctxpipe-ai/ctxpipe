/**
 * A synthetic engineering org graph with the shapes real orgs have: a hub
 * service with hundreds of files and thousands of instructions, ADRs scoped to
 * one service, to some services, or to all of them, superseded ADRs, and pull
 * requests over two years that mostly also touch a shared hub file. The
 * retrieval eval walks it. Every name is made up; the same seed gives the same
 * graph.
 */

export type FixtureNode = {
  id: string
  kind: string
  name: string
  status?: string
  summary?: string
  review_decision?: string
}

export type FixtureEdge = {
  from: string
  type: string
  to: string
  confidence: number
  sourceCount?: number
  validFrom?: string
}

export function engineeringOrgFixture(today = "2026-10-05"): {
  nodes: FixtureNode[]
  edges: FixtureEdge[]
} {
  let state = 42
  const random = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff
    return state / 0x7fffffff
  }
  const daysAgo = (days: number) =>
    new Date(Date.parse(today) - days * 86_400_000).toISOString().slice(0, 10)

  const nodes: FixtureNode[] = []
  const edges: FixtureEdge[] = []
  const node = (n: FixtureNode) => {
    nodes.push(n)
    return n.id
  }
  const edge = (
    from: string,
    type: string,
    to: string,
    confidence: number,
    extra: Partial<FixtureEdge> = {},
  ) => edges.push({ from, type, to, confidence, ...extra })

  const repository = node({
    id: "repo_fx",
    kind: "Repository",
    name: "acme/platform",
  })
  const root = node({ id: "svc:repo_fx:./", kind: "Service", name: "./" })
  edge(root, "IMPLEMENTED_IN", repository, 0.95)
  const services = [
    "billing",
    "auth",
    "search",
    "notifications",
    "gateway",
    "reports",
  ].map((name) => {
    const id = node({
      id: `svc:repo_fx:apps/${name}`,
      kind: "Service",
      name: `apps/${name}`,
    })
    edge(id, "IMPLEMENTED_IN", repository, 0.95)
    edge(id, "PART_OF", root, 0.95)
    return { id, name }
  })
  const teams = ["payments", "identity", "discovery", "platform"].map((team) =>
    node({ id: `team:fx:${team}`, kind: "Team", name: team }),
  )
  for (const [i, s] of services.entries()) {
    edge(teams[i % teams.length] as string, "OWNS", s.id, 0.95)
  }

  const libraries = ["zod", "drizzle", "hono", "pino", "lodash", "react"].map(
    (name) => node({ id: `lib:fx:${name}`, kind: "Library", name }),
  )
  const databases = ["postgres", "redis"].map((name) =>
    node({ id: `db:fx:${name}`, kind: "Database", name }),
  )
  const gateway = services[4] as { id: string }
  for (const s of services) {
    for (const library of libraries)
      if (random() < 0.6) edge(s.id, "USES_LIBRARY", library, 0.7)
    edge(s.id, "WRITES_TO", databases[0] as string, 0.7, {
      sourceCount: random() < 0.5 ? 3 : 1,
    })
    if (random() < 0.5) edge(s.id, "READS_FROM", databases[1] as string, 0.7)
    if (s.id !== gateway.id) edge(gateway.id, "DEPENDS_ON", s.id, 0.7)
  }

  const filesByService = new Map<string, string[]>()
  for (const s of services) {
    const files: string[] = []
    for (let i = 0; i < (s.name === "billing" ? 900 : 120); i++) {
      const path = `apps/${s.name}/src/f${i}.ts`
      const id = node({ id: `fil:repo_fx:${path}`, kind: "File", name: path })
      edge(id, "PART_OF", s.id, 0.95)
      files.push(id)
    }
    filesByService.set(s.id, files)
  }
  const hubFile = node({
    id: "fil:repo_fx:package.json",
    kind: "File",
    name: "package.json",
  })
  edge(hubFile, "PART_OF", root, 0.95)
  const lessons = node({
    id: "fil:repo_fx:.ai/memory/lessons-learned.md",
    kind: "File",
    name: ".ai/memory/lessons-learned.md",
  })
  edge(lessons, "PART_OF", root, 0.95)

  const billing = services[0] as { id: string }
  for (let i = 0; i < 3000; i++) {
    const lesson = i < 400
    const id = node({
      id: `inu:fx:${i}`,
      kind: "InstructionUnit",
      name: lesson ? `lesson ${i}` : `rule ${i}`,
    })
    edge(i % 2 ? root : billing.id, "HAS_INSTRUCTION", id, lesson ? 0.72 : 0.82)
    if (lesson) edge(id, "DECLARED_IN", lessons, 0.95)
  }

  const decisions: string[] = []
  for (let i = 1; i <= 30; i++) {
    const status =
      i % 7 === 0 ? "superseded" : i % 11 === 0 ? "proposed" : "accepted"
    const id = node({
      id: `dec:fx:${i}`,
      kind: "Decision",
      name: `ADR-${i}`,
      status,
    })
    const file = node({
      id: `fil:repo_fx:docs/adr/ADR-${i}.md`,
      kind: "File",
      name: `docs/adr/ADR-${i}.md`,
    })
    edge(id, "DECLARED_IN", file, 0.95)
    decisions.push(id)
    if (i <= 6)
      edge(id, "INFLUENCES", (services[i - 1] as { id: string }).id, 0.9)
    else if (i <= 14)
      edge(
        id,
        "INFLUENCES",
        (services[i % services.length] as { id: string }).id,
        0.8,
      )
    else for (const s of services) edge(id, "INFLUENCES", s.id, 0.6)
    if (status === "superseded")
      edge(decisions[i - 2] ?? id, "SUPERSEDES", id, 0.9)
    const merged = daysAgo(700 - i * 20)
    const pr = node({
      id: `prq:fx:adr-${i}`,
      kind: "PullRequest",
      name: `acme/platform#${1000 + i}`,
      summary: `Record ADR-${i}`,
      review_decision: "APPROVED",
    })
    edge(pr, "ADDED", file, 0.95, { validFrom: merged })
    edge(pr, "TARGETS", repository, 0.95, { validFrom: merged })
  }

  for (let i = 0; i < 400; i++) {
    const merged = daysAgo(Math.floor(random() * 730))
    const s = services[Math.floor(random() * services.length)] as {
      id: string
      name: string
    }
    const review =
      random() < 0.7 ? "APPROVED" : random() < 0.5 ? "CHANGES_REQUESTED" : ""
    const pr = node({
      id: `prq:fx:${i}`,
      kind: "PullRequest",
      name: `acme/platform#${i}`,
      summary: `Change ${s.name} ${i}`,
      review_decision: review,
    })
    edge(pr, "TARGETS", repository, 0.95, { validFrom: merged })
    const files = filesByService.get(s.id) ?? []
    for (let k = 0; k < 3; k++) {
      edge(
        pr,
        "MODIFIED",
        files[Math.floor(random() * files.length)] as string,
        0.95,
        { validFrom: merged },
      )
    }
    if (random() < 0.8)
      edge(pr, "MODIFIED", hubFile, 0.95, { validFrom: merged })
    if (random() < 0.05)
      edge(pr, "MODIFIED", lessons, 0.95, { validFrom: merged })
  }

  // The pull request extractor derives one CHANGED edge per package that a
  // pull request touched, dated with the merge.
  const packageOf = new Map<string, string>()
  for (const e of edges) {
    if (e.type === "PART_OF" && e.from.startsWith("fil:"))
      packageOf.set(e.from, e.to)
  }
  const changed = new Set<string>()
  for (const e of [...edges]) {
    if (!["ADDED", "MODIFIED", "REMOVED", "RENAMED"].includes(e.type)) continue
    const pkg = packageOf.get(e.to)
    if (!pkg || changed.has(`${e.from}|${pkg}`)) continue
    changed.add(`${e.from}|${pkg}`)
    edge(e.from, "CHANGED", pkg, 0.95, { validFrom: e.validFrom })
  }

  // Write order must not matter: shuffle with the same seed.
  edges.sort(() => random() - 0.5)
  return { nodes, edges }
}
