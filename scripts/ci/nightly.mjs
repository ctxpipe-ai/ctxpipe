import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs"
import { join, relative, sep } from "node:path"
import { pathToFileURL } from "node:url"

// The thin nightly CI run of main (ADR-062, revision 2026-11-10).
//
//   node scripts/ci/nightly.mjs changed
//     Writes `run=false` to $GITHUB_OUTPUT when the commit of this run is the
//     commit of the last successful scheduled CI run on main, else
//     `run=true`. The other nightly jobs run only when it is true.
//
//   node scripts/ci/nightly.mjs tickets <results dir>
//     Makes Linear tickets from the signals of the run:
//     - A flaky story: a screenshot or play check that failed and then passed
//       in its rerun (records.ndjson, then rerun/rerun.ndjson). Each story
//       gets one open ticket (Todo, ready-for-agent, parent CTX-1178). When
//       it already has one, this is its second flake: the ticket gets a
//       comment, and the story goes into `unstable` with that ticket.
//     - A failed job of the run: one ticket in Triage that lists them.
//     <results dir> holds one folder for each downloaded artifact. Writes
//     `unstable=<JSON>` to $GITHUB_OUTPUT: the entries for
//     scripts/ci/visual-unstable-stories.json, each with the baselines of
//     the story, which the Unstable screenshots job removes.
//
// Environment: GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_SHA,
// GITHUB_SERVER_URL, GH_TOKEN (read the runs, jobs and artifacts), and for
// `tickets` LINEAR_API_KEY. Without the Linear key, `tickets` gives an error
// annotation and fails.

// The commit of the last successful scheduled CI run on main is the commit
// of this run: main has no new commit.
export async function nightlyChanged({ repo, sha, token }) {
  const { workflow_runs: runs } = await github(
    `/repos/${repo}/actions/workflows/ci.yaml/runs?event=schedule&branch=main&status=success&per_page=1`,
    token,
  )
  return runs[0]?.head_sha !== sha
}

// The entries of the unstable list without a valid `since` date, or with a
// date more than 7 days before `today` (YYYY-MM-DD).
export function overdueEntries(stories, today) {
  return stories.filter(
    (entry) =>
      !/^\d{4}-\d{2}-\d{2}$/.test(entry.since ?? "") ||
      Number.isNaN(Date.parse(entry.since)) ||
      Date.parse(today) - Date.parse(entry.since) > 7 * 86_400_000,
  )
}

// The tickets of one nightly run. Returns the entries for the unstable list.
export async function nightlyTickets({
  results,
  repo,
  runId,
  sha,
  server,
  token,
  linearKey,
  today,
}) {
  const runUrl = `${server}/${repo}/actions/runs/${runId}`
  const flakes = flakyStories(results)
  const { jobs } = await github(
    `/repos/${repo}/actions/runs/${runId}/jobs?per_page=100`,
    token,
  )
  const failedJobs = jobs.filter((job) => job.conclusion === "failure")
  if (!flakes.length && !failedJobs.length) return []

  const team = await linearSetup(linearKey)
  const unstable = []
  if (flakes.length) {
    const { artifacts } = await github(
      `/repos/${repo}/actions/runs/${runId}/artifacts?per_page=100`,
      token,
    )
    const artifactUrl = (name) => {
      const artifact = artifacts.find((item) => item.name === name)
      return artifact ? `${runUrl}/artifacts/${artifact.id}` : `${runUrl}#artifacts`
    }
    for (const flake of flakes) {
      const lines = [
        `- Story: \`${flake.id}\``,
        ...flake.checks.map(
          ({ id, artifact }) =>
            `- Check: \`${id}\`. Results and diff images: ${artifactUrl(artifact)} (folder \`visual-first-run/${flake.id}/\` for a screenshot check)`,
        ),
        `- Run: ${runUrl}`,
      ].join("\n")
      const title = `Flaky story ${flake.id}`
      const open = await openIssue(linearKey, title)
      if (open) {
        await linear(
          linearKey,
          `mutation Comment($input: CommentCreateInput!) { commentCreate(input: $input) { success } }`,
          {
            input: {
              issueId: open.id,
              body: `The story flaked again in a nightly run, so it goes on the unstable list with this ticket (a draft pull request on the branch ci/unstable-screenshots). An entry older than 7 days fails CI.\n\n${lines}`,
            },
          },
        )
        unstable.push({
          id: flake.id,
          reason: `Flaked in two nightly runs (${runUrl}).`,
          ticket: open.identifier,
          since: today,
          baselines: flake.baselines,
        })
      } else
        await createIssue(linearKey, {
          teamId: team.id,
          title,
          stateId: team.state("Todo"),
          labelIds: [team.readyForAgent],
          parentId: team.parent,
          description: `A check of this story failed in the nightly CI run and then passed in its rerun: it is flaky (the contradiction rule, scripts/checks/README.md). Find the cause (a mask, a fixed clock, an animation, a race in the play) and fix it. A second flake puts the story on the unstable list (scripts/ci/visual-unstable-stories.json) with this ticket.\n\n${lines}`,
        })
    }
  }
  if (failedJobs.length)
    await createIssue(linearKey, {
      teamId: team.id,
      title: `Nightly CI run failed on ${sha.slice(0, 7)}`,
      stateId: team.state("Triage"),
      description: `These jobs of the nightly CI run of main failed:\n\n${failedJobs
        .map((job) => `- ${job.name}: ${job.html_url}`)
        .join("\n")}\n\nRun: ${runUrl}`,
    })
  return unstable
}

// The flaky stories below `results`: each screenshot or play check that has
// a failed record and a passed rerun record. One entry for each story, with
// its checks (and the artifact folder of each), and the baselines of the
// story from the visual manifests of the run.
function flakyStories(results) {
  const failed = new Map()
  const passedAgain = new Set()
  const baselines = new Map()
  for (const path of files(results)) {
    const artifact = relative(results, path).split(sep)[0]
    const name = path.split(sep).at(-1)
    if (name === "manifest.json") {
      for (const story of JSON.parse(readFileSync(path, "utf8")).stories ?? [])
        baselines.set(
          story.id,
          new Set([...(baselines.get(story.id) ?? []), story.baseline]),
        )
      continue
    }
    if (name !== "records.ndjson" && name !== "rerun.ndjson") continue
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue
      const record = JSON.parse(line)
      if (name === "rerun.ndjson" && record.status === "passed")
        passedAgain.add(record.id)
      if (name === "records.ndjson" && record.status === "failed")
        failed.set(record.id, artifact)
    }
  }
  const stories = new Map()
  for (const [id, artifact] of failed) {
    const story = /^storybook:(?:visual|plays):[^#]+#(.+)$/.exec(id)?.[1]
    if (!story || !passedAgain.has(id)) continue
    stories.set(story, [...(stories.get(story) ?? []), { id, artifact }])
  }
  return [...stories]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, checks]) => ({
      id,
      checks,
      baselines: [...(baselines.get(id) ?? [])].sort(),
    }))
}

function* files(directory) {
  if (!existsSync(directory)) return
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) yield* files(path)
    else yield path
  }
}

async function github(path, token) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
    },
  })
  if (!response.ok)
    throw new Error(`GitHub API ${path}: HTTP ${response.status}`)
  return response.json()
}

async function linear(key, query, variables) {
  const response = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: key },
    body: JSON.stringify({ query, variables }),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok || body.errors?.length)
    throw new Error(
      `Linear API: HTTP ${response.status} ${JSON.stringify(body.errors ?? [])}`,
    )
  return body.data
}

// The team CTX with its workflow states, the label ready-for-agent and the
// epic CTX-1178.
async function linearSetup(key) {
  const data = await linear(
    key,
    `query Setup {
      teams(filter: { key: { eq: "CTX" } }) { nodes { id states(first: 100) { nodes { id name } } } }
      issueLabels(filter: { name: { eq: "ready-for-agent" } }) { nodes { id } }
      issue(id: "CTX-1178") { id }
    }`,
  )
  const team = data.teams.nodes[0]
  const label = data.issueLabels.nodes[0]
  if (!team || !label || !data.issue)
    throw new Error(
      "Linear has no team CTX, no label ready-for-agent or no issue CTX-1178.",
    )
  return {
    id: team.id,
    readyForAgent: label.id,
    parent: data.issue.id,
    state: (name) => {
      const state = team.states.nodes.find((item) => item.name === name)
      if (!state) throw new Error(`The Linear team CTX has no state ${name}.`)
      return state.id
    },
  }
}

// The open issue of the team with this title, or undefined.
async function openIssue(key, title) {
  const data = await linear(
    key,
    `query Open($title: String!) {
      issues(first: 1, filter: { team: { key: { eq: "CTX" } }, title: { eq: $title }, state: { type: { nin: ["completed", "canceled"] } } }) { nodes { id identifier } }
    }`,
    { title },
  )
  return data.issues.nodes[0]
}

async function createIssue(key, input) {
  const data = await linear(
    key,
    `mutation Create($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { identifier url } } }`,
    { input },
  )
  const issue = data.issueCreate.issue
  console.log(`Opened ${issue.identifier}: ${input.title} (${issue.url})`)
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const env = process.env
  const output = (line) =>
    env.GITHUB_OUTPUT
      ? appendFileSync(env.GITHUB_OUTPUT, `${line}\n`)
      : console.log(line)
  try {
    const [command, results] = process.argv.slice(2)
    const repo = env.GITHUB_REPOSITORY
    if (command === "changed") {
      const run = await nightlyChanged({
        repo,
        sha: env.GITHUB_SHA,
        token: env.GH_TOKEN,
      })
      if (!run)
        console.log(
          "main has no commit since the last successful nightly run: the other jobs do not run.",
        )
      output(`run=${run}`)
    } else if (command === "tickets" && results) {
      if (!env.LINEAR_API_KEY) {
        console.log(
          "::error::LINEAR_API_KEY is not set. Add it to the workbench environment: the nightly run makes a Linear ticket of each flake and failure.",
        )
        process.exit(1)
      }
      const unstable = await nightlyTickets({
        results,
        repo,
        runId: env.GITHUB_RUN_ID,
        sha: env.GITHUB_SHA,
        server: env.GITHUB_SERVER_URL,
        token: env.GH_TOKEN,
        linearKey: env.LINEAR_API_KEY,
        today: new Date().toISOString().slice(0, 10),
      })
      output(`unstable=${JSON.stringify(unstable)}`)
    } else throw new Error("Usage: nightly.mjs changed | tickets <results dir>")
  } catch (error) {
    console.log(`::error::nightly.mjs: ${error.message}`)
    process.exitCode = 1
  }
}
