import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest"
import { createLogger, withLogger } from "../../observability/logger.js"
import { updateFolderList } from "./folder-list.js"

const replies: Array<Record<string, unknown>> = []
const requests: Array<Record<string, unknown>> = []
const server = setupServer(
  http.post("https://folder-list.test/v1/chat/completions", async (event) => {
    const body = (await event.request.json()) as Record<string, unknown>
    requests.push(body)
    const reply = replies.shift() ?? { replaceBlock: "none", list: "" }
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

const update = (text: string, folders: string[]) =>
  withLogger(createLogger({}), () =>
    updateFolderList({ agentsMd: text, folders }),
  )

it("splices the list under a different heading", async () => {
  configureModel()
  const list =
    "* [knowledge](knowledge/): team knowledge\n* [runbooks](runbooks/): on-call steps"
  replies.push({ replaceBlock: 2, list })
  await expect(update(agentsMd, ["knowledge/", "runbooks/"])).resolves.toBe(
    agentsMd.replace("* [knowledge](knowledge/): team knowledge", list),
  )
  const prompt = JSON.stringify(requests[0]?.messages)
  expect(prompt).toContain("runbooks/")
  expect(prompt).toContain("What lives where")
  expect(prompt).not.toContain("name: Docs")
})

it("rejects a reply that replaces a block that is not a folder list", async () => {
  configureModel()
  replies.push({ replaceBlock: 4, list: "- [runbooks](runbooks/)" })
  await expect(
    update(agentsMd, ["knowledge/", "runbooks/"]),
  ).resolves.toBeNull()
})

it("appends a list section when the file has none", async () => {
  configureModel()
  const plain = "---\nname: Docs\n---\n\nRead this first.\n"
  replies.push({
    replaceBlock: "append",
    list: "- `knowledge/` — team knowledge",
  })
  await expect(update(plain, ["knowledge/"])).resolves.toBe(
    `${plain}\n## Folder Structure\n\n- \`knowledge/\` — team knowledge\n`,
  )
})

it("returns no change when the model says so", async () => {
  configureModel()
  replies.push({ replaceBlock: "none", list: "" })
  await expect(update(agentsMd, ["knowledge/"])).resolves.toBeNull()
})

it("skips without a configured model", async () => {
  vi.stubEnv("MODEL_PROVIDER", "openai-like")
  vi.stubEnv("MODEL_PROVIDER_API_KEY", "")
  await expect(
    update(agentsMd, ["knowledge/", "runbooks/"]),
  ).resolves.toBeNull()
  expect(requests).toHaveLength(0)
})

it("skips more than 200 folders without a model call", async () => {
  configureModel()
  const folders = Array.from({ length: 201 }, (_, index) => `f${index}/`)
  await expect(update(agentsMd, folders)).resolves.toBeNull()
  expect(requests).toHaveLength(0)
})
