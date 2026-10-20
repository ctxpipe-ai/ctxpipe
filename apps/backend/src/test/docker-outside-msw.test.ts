import nodeHttp from "node:http"
import Docker from "dockerode"
import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import { expect, it } from "vitest"
import { listenWithDockerOutsideMsw } from "./docker-outside-msw.js"

it("sends Docker API requests to the daemon and other requests to msw", async () => {
  const server = setupServer(
    http.get("http://mocked.test/", () => HttpResponse.text("mocked")),
  )
  const before = nodeHttp.request
  listenWithDockerOutsideMsw(server, { onUnhandledRequest: "error" })
  try {
    expect(String(await new Docker().ping())).toBe("OK")
    const body = await new Promise<string>((resolve, reject) => {
      // msw patches the module property, not a named import binding.
      nodeHttp
        .get("http://mocked.test/", (res) => {
          let text = ""
          res.on("data", (chunk) => {
            text += chunk
          })
          res.on("end", () => resolve(text))
        })
        .on("error", reject)
    })
    expect(body).toBe("mocked")
  } finally {
    server.close()
  }
  expect(nodeHttp.request).toBe(before)
})
