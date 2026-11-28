import { execFileSync } from "node:child_process"
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { HttpResponse, http } from "msw"
import { describe, expect, it, vi } from "vitest"

import { judgeClaims } from "../../evals/bench/taskset.js"
import { useMswServer } from "../../test/msw.js"

/*
 * The task set of the OrgBench Zulip twin (CTX-1664): the committed task
 * folders and their manifest, the verifier (`evals/bench/grade.py`, run with
 * python3 as the container runs it), and the claims rubric of the judge
 * panel against a fake OpenRouter (msw).
 */

const BENCH = new URL("../../evals/bench/", import.meta.url).pathname
const TASKS = join(BENCH, "tasks", "zulip-v1")
const manifest = JSON.parse(
  readFileSync(join(TASKS, "dataset.json"), "utf8"),
) as {
  tasks: Array<
    | { id: string; family: string; split: "sealed"; sha256: string }
    | {
        id: string
        family: string
        split: "dev" | "holdout"
        path: string
        triad: { null: number; gold: number; dump: number }
      }
  >
}
const published = manifest.tasks.flatMap((task) =>
  task.split === "sealed" ? [] : [task],
)

const scratch = mkdtempSync(join(tmpdir(), "orgbench-test-"))
/** The result of grade.py for `answer`, as the host gets it. */
function grade(gold: unknown, answer: string) {
  const goldFile = join(scratch, "gold.json")
  const answerFile = join(scratch, "answer.md")
  writeFileSync(goldFile, JSON.stringify(gold))
  writeFileSync(answerFile, answer)
  return JSON.parse(
    execFileSync(
      "python3",
      [join(BENCH, "grade.py"), goldFile, "--answer", answerFile],
      {
        encoding: "utf8",
      },
    ),
  ) as { reward: number; citation?: number; needsPanel?: boolean }
}

const REPOS = ["zulip", "zulip-flutter", "zulip-terminal"]

describe("the verifier of an OrgBench task", () => {
  const files = {
    grader: "file-set-f1",
    repos: REPOS,
    items: ["zulip:web/src/drafts.ts", "zulip-flutter:lib/model/katex.dart"],
  }

  it("reads the files of the list section in each form that an arm writes", () => {
    const answer = [
      "The drafts module saves the draft, see web/src/compose.ts too.",
      "",
      "## Files",
      "- `/app/org/repos/zulip/web/src/drafts.ts`",
      "- https://github.com/zulip/zulip-flutter/blob/92ebd6d/lib/model/katex.dart",
    ].join("\n")
    // The prose before the section does not count: two of two, F1 1.
    expect(grade(files, answer).reward).toBe(1)
    expect(
      grade(files, "## Files\nzulip:web/src/drafts.ts\n").reward,
    ).toBeCloseTo(2 / 3, 3)
  })

  it("gives a file of another repository no match", () => {
    expect(
      grade(files, "## Files\nzulip-terminal:web/src/drafts.ts\n").reward,
    ).toBe(0)
  })

  it("reads a path that starts with the repository name", () => {
    // An ORACLE run on Haiku wrote the folder of the corpus as the repository.
    const one = { ...files, items: ["zulip:web/src/drafts.ts"] }
    expect(grade(one, "## Files\nzulip/web:src/drafts.ts\n").reward).toBe(1)
    expect(grade(one, "## Files\n- zulip/web/src/drafts.ts\n").reward).toBe(1)
    // A Markdown link with a line anchor names the file.
    expect(
      grade(
        one,
        "## Files\n- [drafts](https://github.com/zulip/zulip/blob/c803cca/web/src/drafts.ts#L42)\n",
      ).reward,
    ).toBe(1)
    // A name with no repository is one prediction, also when it matches the
    // gold of two repositories.
    const readmes = {
      ...files,
      items: ["zulip:README.md", "zulip-flutter:README.md"],
    }
    expect(grade(readmes, "## Files\nREADME.md\n").reward).toBeCloseTo(2 / 3, 3)
    // A file with no extension in the list section.
    const plain = { ...files, items: ["zulip:docs/THIRDPARTY"] }
    expect(grade(plain, "## Files\n- `zulip:docs/THIRDPARTY`\n").reward).toBe(1)
  })

  it("scores a repository set and a guideline set", () => {
    const repos = {
      grader: "repo-set-f1",
      repos: REPOS,
      items: ["zulip", "zulip-flutter"],
    }
    expect(
      grade(repos, "## Repositories\n- zulip/zulip-flutter\n- zulip\n").reward,
    ).toBe(1)
    // `zulip` inside `zulip-terminal` is no mention of the server repository.
    expect(grade(repos, "## Repositories\nzulip-terminal\n").reward).toBe(0)
    // A listed repository that is not of the org counts against precision.
    expect(
      grade(repos, "## Repositories\nzulip\nzulip-flutter\nacme/invalid\n")
        .reward,
    ).toBeCloseTo(0.8, 3)
    const rules = {
      grader: "rule-set-f1",
      repos: REPOS,
      items: ["docs/contributing/commit-discipline.md"],
    }
    expect(
      grade(
        rules,
        "## Rules\nhttps://zulip.readthedocs.io/en/latest/contributing/commit-discipline.html#commit-messages\n",
      ).reward,
    ).toBe(1)
  })

  it("rewards an abstention only on a no-answer task", () => {
    const abstain = { grader: "abstention", repos: REPOS, items: [] }
    expect(
      grade(abstain, "**NO ANSWER**\n\nThe sources stop before that release.")
        .reward,
    ).toBe(1)
    expect(grade(abstain, "").reward).toBe(0)
    expect(grade(abstain, "The release notes say it shipped.").reward).toBe(0)
    expect(
      grade(files, "NO ANSWER\n\n## Files\nzulip:web/src/drafts.ts").reward,
    ).toBe(0)
  })

  it("matches a cited record in each form, with a cap on extra citations", () => {
    const gold = {
      grader: "citations-and-claims",
      repos: REPOS,
      items: [],
      citations: [
        {
          ref: "x",
          aliases: [
            "czo:378/2538271",
            "czo-msg:2538271",
            "czo-topic:378/demote resolved topics",
          ],
        },
      ],
    }
    const viaPath = grade(gold, "As decided in chat/zulip/378/2538271.md.")
    expect(viaPath).toMatchObject({
      citation: 1,
      needsPanel: true,
      reward: 0.5,
    })
    const viaTopic = grade(
      gold,
      "See https://chat.zulip.org/#narrow/channel/378-api-design/topic/demote.20resolved.20topics",
    )
    expect(viaTopic.citation).toBe(1)
    const dump = Array.from(
      { length: 9 },
      (_, n) => `https://github.com/zulip/zulip/issues/${n + 1}`,
    )
    expect(
      grade(gold, `chat/zulip/378/2538271.md\n${dump.join("\n")}`).citation,
    ).toBeCloseTo(3 / 10, 3)
  })
})

describe("the committed Zulip task set", () => {
  it("has the tasks of the manifest, and no sealed task in the repository", () => {
    const folders = readdirSync(TASKS, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
    expect(folders).toEqual(published.map((task) => task.path).sort())
    // A sealed task shows no path and no id that names its source event.
    for (const task of manifest.tasks.filter(
      (item) => item.split === "sealed",
    )) {
      expect(task).not.toHaveProperty("path")
      expect(task.id).toMatch(/^zulip-sealed-[0-9a-f]{12}$/)
    }
  })

  const canonical = readFileSync(join(BENCH, "grade.py"), "utf8")
  it.each(published.map((task) => [task.id, task] as const))(
    "%s",
    (_id, task) => {
      const dir = join(TASKS, task.path)
      expect(readFileSync(join(dir, "tests", "grade.py"), "utf8")).toBe(
        canonical,
      )
      // The task.toml as run.py reads it (tomllib).
      const toml = JSON.parse(
        execFileSync(
          "python3",
          [
            "-c",
            "import json, sys, tomllib; print(json.dumps(tomllib.load(open(sys.argv[1], 'rb'))))",
            join(dir, "task.toml"),
          ],
          {
            encoding: "utf8",
          },
        ),
      ) as {
        metadata: Record<string, unknown>
        agent: Record<string, unknown>
        verifier: Record<string, unknown>
      }
      const fields = toml.metadata
      for (const key of [
        "twin",
        "snapshot",
        "family",
        "split",
        "base_time",
        "sources_needed",
        "answerable_at_t",
        "lexical_hook",
        "repos",
        "gold_context",
        "grader",
        "expected_pass_band",
      ])
        expect(fields).toHaveProperty(key)
      expect(fields.family).toBe(task.family)
      expect(toml.agent).toMatchObject({
        network_mode: "allowlist",
        allowed_hosts: [],
      })
      expect(toml.verifier).toMatchObject({ network_mode: "no-network" })
      for (const path of fields.gold_context as string[])
        expect(path).toMatch(/^(repos\/[\w-]+|github\/(issues|pulls)|chat)\//)
      // Privacy: no pseudonym, handle, email address or link in the task text.
      const instruction = readFileSync(join(dir, "instruction.md"), "utf8")
      expect(instruction).not.toMatch(
        /person-\d{4}|\[person\]|@\w|[\w.+-]+@[\w-]+\.\w|https?:\/\//,
      )
      // The calibration triad: a null answer 0.1 or less, the gold 0.9 or
      // more, a keyword dump 0.5 or less. grade.py scores the set graders
      // again here; the panel scored the claims when the build ran.
      const gold = JSON.parse(
        readFileSync(join(dir, "tests", "gold.json"), "utf8"),
      )
      if (
        ["file-set-f1", "repo-set-f1", "rule-set-f1", "abstention"].includes(
          gold.grader,
        )
      ) {
        expect(grade(gold, "").reward).toBeLessThanOrEqual(0.1)
        expect(
          grade(gold, gold.calibration.gold).reward,
        ).toBeGreaterThanOrEqual(0.9)
        expect(grade(gold, gold.calibration.dump).reward).toBeLessThanOrEqual(
          0.5,
        )
      }
      expect(task.triad.null).toBeLessThanOrEqual(0.1)
      expect(task.triad.gold).toBeGreaterThanOrEqual(0.9)
      expect(task.triad.dump).toBeLessThanOrEqual(0.5)
    },
  )
})

describe("the claims rubric of the judge panel", () => {
  const BASE = "https://openrouter.example.test/api/v1"
  const bodies: string[] = []
  const verdicts: Record<string, string[]> = {
    "anthropic/claude-sonnet-5.5": ["full", "none"],
    "openai/gpt-6.1-terra": ["full", "partial"],
    "google/gemini-3.8-flash": ["partial", "partial"],
  }
  useMswServer(
    http.post(`${BASE}/chat/completions`, async ({ request }) => {
      const body = (await request.json()) as {
        model: string
        messages: { content: string }[]
      }
      bodies.push(body.messages[0]?.content ?? "")
      const support = verdicts[body.model] ?? []
      const claims = support.map((value, index) => ({
        claim: index + 1,
        support: value,
      }))
      return HttpResponse.json({
        choices: [{ message: { content: JSON.stringify({ claims }) } }],
        usage: { cost: 0.001 },
      })
    }),
  )

  it("scores each claim with the median of the panel, on a blinded answer", async () => {
    vi.stubEnv("MODEL_PROVIDER", "openrouter")
    vi.stubEnv("MODEL_PROVIDER_URL", BASE)
    vi.stubEnv("MODEL_PROVIDER_API_KEY", "fixture-only")
    const result = await judgeClaims({
      question: "Which discussion decided the setting?",
      claims: [
        "The api design channel decided it.",
        "It is a channel setting.",
      ],
      answer:
        "The ctxpipe tool mcp__ctxpipe__search_knowledge found /app/org/chat/zulip/378/2538271.md and /app/org/repos/zulip/zerver/models/streams.py.",
    })
    // Claim 1: full, full, partial → full. Claim 2: none, partial, partial → partial.
    expect(result.perClaim).toEqual([1, 0.5])
    expect(result.score).toBe(0.75)
    expect(bodies).toHaveLength(3)
    for (const body of bodies) {
      expect(body).toContain(
        "https://chat.zulip.org/#narrow/channel/378/near/2538271",
      )
      expect(body).toContain(
        "https://github.com/zulip/zulip/blob/c803cca1ceac58fed390846d4aae5be40e06132d/zerver/models/streams.py",
      )
      expect(body).not.toMatch(/ctxpipe|mcp__|\/app\/org/)
    }
  })

  it("gives an empty answer no score with no call", async () => {
    bodies.length = 0
    const result = await judgeClaims({
      question: "Why?",
      claims: ["A fact."],
      answer: "  ",
    })
    expect(result).toEqual({ score: 0, perClaim: [0] })
    expect(bodies).toHaveLength(0)
  })
})
