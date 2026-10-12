import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest"
import { updateFolderList } from "./folder-list.js"

const replies: Array<Record<string, unknown>> = []
const requests: Array<Record<string, unknown>> = []
const server = setupServer(
  http.post("https://folder-list.test/v1/chat/completions", async (event) => {
    const body = (await event.request.json()) as Record<string, unknown>
    requests.push(body)
    const reply = replies.shift() ?? { changed: false, agentsMd: null }
    const tools = body.tools as Array<{ function: { name: string } }>
    return HttpResponse.json({
      id: "folder-list",
      object: "chat.completion",
      created: 1,
      model: "fixture",
      choices: [
        {
          index: 0,
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: {
                  name: tools[0]?.function.name,
                  arguments: JSON.stringify(reply),
                },
              },
            ],
          },
        },
      ],
    })
  }),
)

beforeAll(() => server.listen({ onUnhandledRequest: "error" }))
afterEach(() => {
  replies.length = 0
  requests.length = 0
  vi.unstubAllEnvs()
})
afterAll(() => server.close())

function configureModel() {
  vi.stubEnv("MODEL_PROVIDER", "openai-like")
  vi.stubEnv("MODEL_PROVIDER_API_KEY", "fixture-only")
  vi.stubEnv("MODEL_PROVIDER_URL", "https://folder-list.test/v1")
}

const agentsMd = [
  "---",
  "name: Docs",
  "---",
  "",
  "Read this first.",
  "",
  "### What lives where",
  "",
  "* [knowledge](knowledge/): team knowledge",
  "",
  "## Rules",
  "",
  "Be kind.",
  "",
].join("\n")

it("writes a list under a different heading", async () => {
  configureModel()
  const updated = agentsMd.replace(
    "* [knowledge](knowledge/): team knowledge\n",
    "* [knowledge](knowledge/): team knowledge\n* [runbooks](runbooks/): on-call steps\n",
  )
  replies.push({ changed: true, agentsMd: updated })
  await expect(
    updateFolderList({ agentsMd, folders: ["knowledge/", "runbooks/"] }),
  ).resolves.toBe(updated)
  const prompt = JSON.stringify(requests[0]?.messages)
  expect(prompt).toContain("runbooks/")
  expect(prompt).toContain("What lives where")
})

it("rejects a reply that edits outside the list", async () => {
  configureModel()
  replies.push({
    changed: true,
    agentsMd: agentsMd
      .replace("Be kind.", "Be brief.")
      .replace("team knowledge\n", "team knowledge\n* [runbooks](runbooks/)\n"),
  })
  await expect(
    updateFolderList({ agentsMd, folders: ["knowledge/", "runbooks/"] }),
  ).resolves.toBeNull()
})

it("adds a list section when the file has none", async () => {
  configureModel()
  const plain = "---\nname: Docs\n---\n\nRead this first.\n"
  const updated = `${plain}\n## Folders\n\n- \`knowledge/\` — team knowledge\n`
  replies.push({ changed: true, agentsMd: updated })
  await expect(
    updateFolderList({ agentsMd: plain, folders: ["knowledge/"] }),
  ).resolves.toBe(updated)
})

it("returns no change when the model says so", async () => {
  configureModel()
  replies.push({ changed: false, agentsMd: null })
  await expect(
    updateFolderList({ agentsMd, folders: ["knowledge/"] }),
  ).resolves.toBeNull()
})

it("skips without a configured model", async () => {
  vi.stubEnv("MODEL_PROVIDER", "openai-like")
  vi.stubEnv("MODEL_PROVIDER_API_KEY", "")
  await expect(
    updateFolderList({ agentsMd, folders: ["knowledge/", "runbooks/"] }),
  ).resolves.toBeNull()
  expect(requests).toHaveLength(0)
})
