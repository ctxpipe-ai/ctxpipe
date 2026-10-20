import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { request } from "node:http"
import { request as httpsRequest } from "node:https"
import { createServer, type Server } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer as createTlsServer } from "node:tls"
import { afterEach, describe, expect, it } from "vitest"
import {
  connectionTimeoutError,
  expectRefusal,
  retryOnConnectionError,
} from "./retryOnConnectionError.js"

let server: Server | undefined
afterEach(() => {
  server?.close()
  server = undefined
})

async function resetFirstConnection() {
  let connections = 0
  server = createServer((socket) => {
    connections += 1
    if (connections === 1) {
      socket.resetAndDestroy()
      return
    }
    socket.end(
      "HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok",
    )
  })
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : 0
  const get = () =>
    new Promise<number>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port }, (response) => {
        response.resume()
        response.on("end", () => resolve(response.statusCode ?? 0))
      })
      req.on("error", reject)
      req.end()
    })
  return { get, count: () => connections }
}

describe("retryOnConnectionError", () => {
  it("fails on a reset connection without the retry", async () => {
    const { get } = await resetFirstConnection()
    await expect(get()).rejects.toMatchObject({ code: "ECONNRESET" })
  })

  it("succeeds when only the first connection is reset", async () => {
    const { get, count } = await resetFirstConnection()
    await expect(retryOnConnectionError(get, { delayMs: 1 })).resolves.toBe(200)
    expect(count()).toBe(2)
  })

  it("stops at once on an error that is not a connection error", async () => {
    let calls = 0
    await expect(
      retryOnConnectionError(
        async () => {
          calls += 1
          throw new Error("bad pin")
        },
        { delayMs: 1 },
      ),
    ).rejects.toThrow("bad pin")
    expect(calls).toBe(1)
  })

  it("gives up after the bounded number of attempts", async () => {
    let calls = 0
    await expect(
      retryOnConnectionError(
        async () => {
          calls += 1
          throw Object.assign(new Error("reset"), { code: "ECONNRESET" })
        },
        { attempts: 3, delayMs: 1 },
      ),
    ).rejects.toThrow("reset")
    expect(calls).toBe(3)
  })
})

// The first connection stays silent, so the probe times out. Later ones answer.
async function silentServer(silent: "first" | "all") {
  let connections = 0
  server = createServer((socket) => {
    connections += 1
    if (silent === "all" || connections === 1) return
    socket.end(
      "HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok",
    )
  })
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : 0
  const probe = () =>
    new Promise<number>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port }, (response) => {
        response.resume()
        response.on("end", () => resolve(response.statusCode ?? 0))
      })
      req.setTimeout(50, () =>
        req.destroy(connectionTimeoutError("Timed out verifying probe")),
      )
      req.on("error", reject)
      req.end()
    })
  const open = (onResponse: () => void) =>
    request({ host: "127.0.0.1", port }, onResponse)
  return { probe, open, count: () => connections }
}

describe("retryOnConnectionError with a probe timeout", () => {
  it("passes when the probe times out once and then succeeds", async () => {
    const { probe, count } = await silentServer("first")
    await expect(retryOnConnectionError(probe, { delayMs: 1 })).resolves.toBe(
      200,
    )
    expect(count()).toBe(2)
  })

  it("still fails when every attempt times out", async () => {
    const { probe, count } = await silentServer("all")
    await expect(
      retryOnConnectionError(probe, { attempts: 3, delayMs: 1 }),
    ).rejects.toMatchObject({ code: "ETIMEDOUT" })
    expect(count()).toBe(3)
  })
})

function refusalOptions(timeoutMs: number) {
  return {
    timeoutMs,
    timeoutMessage: "Timed out",
    answeredMessage: "The host answered",
    refusalCode: "ERR_TLS_CERT_ALTNAME_INVALID",
  }
}

// A TLS server whose self-signed certificate is for another host name.
async function mismatchServer() {
  const dir = mkdtempSync(join(tmpdir(), "refusal-"))
  try {
    execFileSync(
      "openssl",
      [
        ...["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2"],
        ...["-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem")],
        ...["-subj", "/CN=other.example"],
        ...["-addext", "subjectAltName=DNS:other.example"],
      ],
      { stdio: "ignore" },
    )
    const cert = readFileSync(join(dir, "c.pem"))
    const key = readFileSync(join(dir, "k.pem"))
    server = createTlsServer({ key, cert }, (socket) => socket.end())
    server.on("tlsClientError", () => {})
    await new Promise<void>((resolve) =>
      server?.listen(0, "127.0.0.1", resolve),
    )
    const address = server.address()
    const port = typeof address === "object" && address ? address.port : 0
    const open = (onResponse: () => void) =>
      httpsRequest(
        "https://requested.example/",
        {
          ca: cert,
          port,
          lookup: (_host, _options, callback) =>
            callback(null, [{ address: "127.0.0.1", family: 4 }] as never),
        },
        onResponse,
      )
    return { open }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// Probes that fail with an error other than the expected refusal.
async function failingProbe(
  kind: "reset" | "hangup" | "epipe" | "dns" | "dns-notfound",
) {
  server = createServer((socket) => {
    if (kind === "reset") socket.resetAndDestroy()
    else socket.destroy()
  })
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : 0
  let attempts = 0
  const open = (onResponse: () => void) => {
    attempts += 1
    if (kind === "dns" || kind === "dns-notfound") {
      const code = kind === "dns" ? "EAI_AGAIN" : "ENOTFOUND"
      return request(
        {
          host: "probe.example",
          port,
          lookup: (_host, _options, callback) =>
            callback(Object.assign(new Error(code), { code }) as never, "", 4),
        },
        onResponse,
      )
    }
    const req = request({ host: "127.0.0.1", port }, onResponse)
    if (kind === "epipe") {
      queueMicrotask(() =>
        req.destroy(Object.assign(new Error("write EPIPE"), { code: "EPIPE" })),
      )
    }
    return req
  }
  return {
    open,
    count: () => attempts,
  }
}

describe("expectRefusal", () => {
  it("fails with ETIMEDOUT when the probe host stays silent", async () => {
    const { open } = await silentServer("all")
    await expect(expectRefusal(open, refusalOptions(50))).rejects.toMatchObject(
      { code: "ETIMEDOUT" },
    )
  })

  it("fails after the last attempt when the host stays silent", async () => {
    const { open, count } = await silentServer("all")
    await expect(
      retryOnConnectionError(() => expectRefusal(open, refusalOptions(50)), {
        attempts: 3,
        delayMs: 1,
      }),
    ).rejects.toMatchObject({ code: "ETIMEDOUT" })
    expect(count()).toBe(3)
  })

  it("passes on a TLS host name mismatch", async () => {
    const { open } = await mismatchServer()
    await expect(expectRefusal(open, refusalOptions(1_000))).resolves.toBe(
      undefined,
    )
  })

  it.each([
    ["a reset", "reset"],
    ["a hang up", "hangup"],
    ["an EPIPE", "epipe"],
    ["a DNS error", "dns"],
  ] as const)("does not pass on %s, and retries then fails", async (_, kind) => {
    const { open, count } = await failingProbe(kind)
    const expected = {
      reset: "ECONNRESET",
      hangup: "ECONNRESET",
      epipe: "EPIPE",
      dns: "EAI_AGAIN",
    }[kind]
    await expect(
      retryOnConnectionError(() => expectRefusal(open, refusalOptions(1_000)), {
        attempts: 3,
        delayMs: 1,
      }),
    ).rejects.toMatchObject({ code: expected })
    expect(count()).toBe(3)
  })

  it("does not retry an error that is not a connection error", async () => {
    const { open, count } = await failingProbe("dns-notfound")
    await expect(
      retryOnConnectionError(() => expectRefusal(open, refusalOptions(1_000)), {
        attempts: 3,
        delayMs: 1,
      }),
    ).rejects.toMatchObject({ code: "ENOTFOUND" })
    expect(count()).toBe(1)
  })

  it("fails when the host answers", async () => {
    const { open } = await silentServer("first")
    // The first connection is silent, so use a second probe that gets an answer.
    await expect(expectRefusal(open, refusalOptions(50))).rejects.toBeDefined()
    await expect(expectRefusal(open, refusalOptions(1_000))).rejects.toThrow(
      "answered",
    )
  })
})
