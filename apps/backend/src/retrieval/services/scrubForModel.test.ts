import { execFileSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"

import { chat } from "@tanstack/ai"
import { initLogger } from "evlog"
import { HttpResponse, http } from "msw"
import { afterEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"

import { madeUpPrivateKey } from "../../../test/made-up-key.js"
import { useMswServer } from "../../../test/msw.js"
import {
  embeddingKey,
  embedQuery,
  embedTexts,
  textEmbeddingConfig,
} from "../embeddings/textEmbeddings.js"
import { decideNoul } from "../jev/client.js"
import { generateEmbeddings, getModel } from "./modelProvider.js"
import { scrubForModel } from "./scrubForModel.js"

// The secrets are made at run time from random bytes: they are not real,
// and no secret scanner of a Git host finds one in this file.
const ALPHANUMERIC =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
function random(length: number, alphabet = ALPHANUMERIC): string {
  return Array.from(
    randomBytes(length),
    (byte) => alphabet[byte % alphabet.length],
  ).join("")
}
const DIGITS = "0123456789"

/** A secret that `rule` finds. */
function secretOf(rule: string): string {
  const found = secrets().find((secret) => secret.rule === rule)
  if (!found) throw new Error(`No secret of the rule ${rule}`)
  return found.value
}

/** A secret of each of several kinds, with the rule that finds it. */
function secrets() {
  return [
    {
      rule: "betterleaks.github-pat",
      value: `ghp_${random(36)}`,
    },
    {
      rule: "betterleaks.slack-bot-token",
      value: `xoxb-${random(10, DIGITS)}-${random(13, DIGITS)}-${random(24)}`,
    },
    {
      rule: "betterleaks.aws-access-token",
      value: `AKIA${random(16, "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")}`,
    },
    {
      rule: "betterleaks.anthropic-api-key",
      value: `sk-ant-api03-${random(93, `${ALPHANUMERIC}-_`)}AA`,
    },
    {
      rule: "veles.secrets/openrouter",
      value: `sk-or-v1-${random(64, "0123456789abcdef")}`,
    },
    {
      rule: "betterleaks.gitlab-pat",
      value: `glpat-${random(20)}`,
    },
    {
      rule: "betterleaks.private-key",
      value: madeUpPrivateKey(2048),
    },
  ]
}

describe("scrubForModel", () => {
  it("replaces each secret by a placeholder that names its rule, and keeps the text around it", async () => {
    for (const { rule, value } of secrets())
      expect(await scrubForModel(`Set the key to ${value} — ünïcödé.`)).toBe(
        `Set the key to [REDACTED:${rule}] — ünïcödé.`,
      )
  })

  it("replaces the whole userinfo of a URL of any scheme, up to its last @", async () => {
    // Made-up passwords: a random one, one that a person chose, and
    // passwords with symbols, of the kind that people use.
    const passwords = [
      random(16),
      "hunter2",
      "%21abc%40x",
      "$uperSecret",
      "p@ssw0rd",
      "S3cr#t!",
      "pa'ssw0rd",
      "ab/Cd+e=",
      random(400),
    ]
    for (const [url, host] of [
      ["postgres://app:{}", "db.example.test:5432/app"],
      ["mysql://root:{}", "10.0.0.5/db"],
      ["redis://:{}", "cache.example.test:6379"],
      ["amqp://guest:{}", "rabbit.example.test:5672/"],
      ["https://bob:{}", "git.example.test/repo.git"],
      ["smtps://me@mail.example.test:{}", "smtp.example.test"],
      ["x://u:{}", "/db?host=/var/run/postgresql"],
    ] as const)
      for (const password of passwords)
        expect(
          await scrubForModel(
            `Use ${url.replace("{}", password)}@${host} now.`,
          ),
        ).toBe(
          `Use ${url.slice(0, url.indexOf("://") + 3)}[REDACTED:url-credentials]@${host} now.`,
        )
  })

  it("fails safe: a userinfo that only looks like a password is redacted too", async () => {
    // A redaction that was not needed costs a placeholder; a miss leaks a
    // secret. These are accepted false positives.
    for (const [text, scrubbed] of [
      [
        "https://example.test:8443?email=alice@example.test",
        "https://[REDACTED:url-credentials]@example.test",
      ],
      [
        `postgres://user:\${DB_PASSWORD}@db.example.test/app`,
        "postgres://[REDACTED:url-credentials]@db.example.test/app",
      ],
      [
        "redis://u:pw12345@cache.example.test:6379?x=a@b",
        "redis://[REDACTED:url-credentials]@b",
      ],
      // A scheme right after a word character.
      [
        "_postgres://app:pw12345@db.example.test_",
        "_postgres://[REDACTED:url-credentials]@db.example.test_",
      ],
      [
        "1redis://:pw12345@cache.example.test",
        "1redis://[REDACTED:url-credentials]@cache.example.test",
      ],
      [
        "接続先はpostgres://app:pw12345@db.example.testです",
        "接続先はpostgres://[REDACTED:url-credentials]@db.example.testです",
      ],
    ])
      expect(await scrubForModel(text)).toBe(scrubbed)
  })

  it("keeps an address and a URL with no password part as they are", async () => {
    const texts = [
      "user@host",
      "https://user@host.example.test/path",
      "postgres://user@db.example.test/app",
      "https://example.test/path?a=b",
      "https://example.test:8443/a",
      "mailto:someone@example.test",
      "git@github.com:org/repo.git",
      "The meeting is at 10:30@noon.",
    ]
    expect(await scrubForModel(texts)).toEqual(texts)
  })

  it("replaces each occurrence of a secret", async () => {
    const github = secretOf("betterleaks.github-pat")
    const text = `a ${github} b ${github} c`
    expect(await scrubForModel(text)).toBe(
      "a [REDACTED:betterleaks.github-pat] b [REDACTED:betterleaks.github-pat] c",
    )
  })

  it("keeps a text with no secret as it is", async () => {
    const texts = [
      "",
      "The sky is blue on a clear day.",
      // Source code: the scrubber module itself.
      readFileSync(
        fileURLToPath(new URL("./scrubForModel.ts", import.meta.url)),
        "utf8",
      ),
      readFileSync(
        fileURLToPath(new URL("../../../package.json", import.meta.url)),
        "utf8",
      ),
      'Ünïcödé, 日本語, emoji 🔑, and a line\nwith a tab\tand a quote ".',
      "token = $GITHUB_TOKEN\npassword: <your password>\nkey=REPLACE_ME",
    ]
    expect(await scrubForModel(texts)).toEqual(texts)
  })

  it("refuses a request with a secret split over two texts of its conversation: the model reads them as one text", async () => {
    const key = secretOf("betterleaks.private-key")
    const half = Math.floor(key.length / 2)
    // Two text parts of one message, and two messages of one role.
    for (const messages of [
      [
        {
          role: "user",
          content: [
            { type: "text", text: `See ${key.slice(0, half)}` },
            { type: "text", text: `${key.slice(half)} end` },
          ],
        },
      ],
      [
        { role: "user", content: `See ${key.slice(0, half)}` },
        { role: "user", content: `${key.slice(half)} end` },
      ],
      // A system message between them: Converse takes it out, then joins
      // the two user messages.
      [
        { role: "user", content: `See ${key.slice(0, half)}` },
        { role: "system", content: "!" },
        { role: "user", content: `${key.slice(half)} end` },
      ],
    ])
      await expect(scrubForModel({ messages })).rejects.toThrow(
        /split over two texts/,
      )
    // The same texts with no split secret pass.
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "a" },
            { type: "text", text: "b" },
          ],
        },
        { role: "user", content: "c" },
      ],
    }
    expect(await scrubForModel(body)).toEqual(body)
  })

  it("scrubs an SVG data URL, also in the image field of an image part: an SVG is text", async () => {
    const svg = Buffer.from(
      `<svg><text>${secretOf("betterleaks.github-pat")}</text></svg>`,
    )
    const url = `data:image/svg+xml;base64,${svg.toString("base64")}`
    const scrubbed = JSON.stringify(
      await scrubForModel({
        messages: [
          {
            role: "user",
            content: [{ type: "image_url", image_url: { url } }],
          },
        ],
      }),
    )
    expect(scrubbed).not.toContain(url)
    expect(scrubbed).toContain("[REDACTED:betterleaks.github-pat]")
    // The media type in another case is the same type.
    const upper = url.replace("image/svg+xml", "image/SVG+XML")
    expect(
      JSON.stringify(
        await scrubForModel({
          messages: [
            {
              role: "user",
              content: [{ type: "image_url", image_url: { url: upper } }],
            },
          ],
        }),
      ),
    ).not.toContain(upper)
  })

  it("keeps a raster image data URL in any case and with parameters, in the image field", async () => {
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
    const urls = [
      `data:image/PNG;charset=utf-8;base64,${png}`,
      `data: image/jpeg ;BASE64,${png}`,
      `data:image/webp;base64,${png}`,
    ]
    const body = {
      messages: [
        {
          role: "user",
          content: urls.map((url) => ({
            type: "image_url",
            image_url: { url },
          })),
        },
      ],
    }
    expect(await scrubForModel(body)).toEqual(body)
    // The parameters of an image data URL are text: only its payload stays.
    const token = secretOf("betterleaks.github-pat")
    const named = await scrubForModel({
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: `data:image/png;name=${token};base64,${png}` },
            },
          ],
        },
      ],
    })
    expect(JSON.stringify(named)).not.toContain(token)
    expect(JSON.stringify(named)).toContain(
      `data:image/png;name=[REDACTED:betterleaks.github-pat];base64,${png}`,
    )
  })

  it("refuses a message part that it cannot read, and a value that is not plain data", async () => {
    for (const part of [
      {
        type: "file",
        file: { file_data: "data:application/pdf;base64,JVBERi0=" },
      },
      { type: "input_audio", input_audio: { data: "UklGRg==", format: "wav" } },
    ])
      await expect(
        scrubForModel({ messages: [{ role: "user", content: [part] }] }),
      ).rejects.toThrow(/cannot go to a model/)
    await expect(
      scrubForModel({ data: new Map([["a", "b"]]) }),
    ).rejects.toThrow(/not plain data/)
    // Bytes stay as they are.
    const bytes = new Uint8Array([1, 2])
    expect(await scrubForModel({ bytes })).toEqual({ bytes })
  })

  it("fails only its own request for a text over 64 MiB, and reads a lone surrogate", async () => {
    await expect(scrubForModel("a".repeat(65 * 1024 * 1024))).rejects.toThrow(
      /larger than 64 MiB/,
    )
    // A lone surrogate becomes U+FFFD; the text around it is scrubbed.
    expect(
      await scrubForModel(`\ud800 ${secretOf("betterleaks.github-pat")}`),
    ).toBe("\ufffd [REDACTED:betterleaks.github-pat]")
    // The scrubber still answers.
    expect(await scrubForModel("ok")).toBe("ok")
  })

  it("scrubs a text with U+2028 and U+2029, and the requests in flight with it get their answers (CTX-1504)", async () => {
    // A GitHub issue body of about 11 KB with the line separator and the
    // paragraph separator, as a hydrate unit: the scrubber writes these
    // characters as they are, inside its answer line.
    const secret = secretOf("betterleaks.github-pat")
    const body = `${"Steps to reproduce.\u2028See the log.\u2029\n".repeat(
      300,
    )}token ${secret}\u2028end`
    const answers = await Promise.all([
      scrubForModel({ title: "Issue\u2029title", body }),
      ...Array.from({ length: 7 }, (_, at) => scrubForModel(`other ${at}`)),
    ])
    expect(answers[0]).toEqual({
      title: "Issue\u2029title",
      body: body.replace(secret, "[REDACTED:betterleaks.github-pat]"),
    })
    expect(answers.slice(1)).toEqual(
      Array.from({ length: 7 }, (_, at) => `other ${at}`),
    )
  })

  it("logs a stop of the scrubber, fails each request in flight, and starts a new scrubber for the next call", async () => {
    const events: Record<string, unknown>[] = []
    initLogger({
      env: { service: "ctxpipe-backend-test" },
      pretty: false,
      drain: (ctx) => {
        events.push(ctx.event as Record<string, unknown>)
      },
    })
    try {
      await scrubForModel("warm")
      // The scrubber of this test file (each file has its own process). The
      // kill and the request come in the same tick, so the request is in
      // flight when the process stops.
      const pid = Number(
        execFileSync("pgrep", [
          "-P",
          String(process.pid),
          "-f",
          "--",
          "--scrub",
        ])
          .toString()
          .trim(),
      )
      process.kill(pid, "SIGKILL")
      const inFlight = scrubForModel("in flight")
      await expect(inFlight).rejects.toThrow(
        /The secret scrubber stopped \(SIGKILL\)/,
      )
      await expect
        .poll(() => events)
        .toContainEqual(
          expect.objectContaining({
            step: "secret-scrubber.stopped",
            inFlight: 1,
          }),
        )
      expect(await scrubForModel("ok")).toBe("ok")
    } finally {
      initLogger({ enabled: false, env: { service: "ctxpipe-backend-test" } })
    }
  })

  it("gives the same output for the same input, alone or in a batch", async () => {
    const text = secrets()
      .map(({ value }) => `key ${value}`)
      .join("\n")
    const alone = await scrubForModel(text)
    expect(await scrubForModel(text)).toBe(alone)
    expect(await scrubForModel(["other", text, "more"])).toEqual([
      "other",
      alone,
      "more",
    ])
    // A scrubbed text stays the same when it is scrubbed again.
    expect(await scrubForModel(alone)).toBe(alone)
  })

  it("scrubs each string and key of a request body, and keeps the image data URL of an image part and the other values", async () => {
    const secret = secretOf("betterleaks.github-pat")
    const aws = secretOf("betterleaks.aws-access-token")
    const redacted = "[REDACTED:betterleaks.github-pat]"
    // A 1 × 1 PNG.
    const image =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
    const bytes = new Uint8Array([1, 2, 3])
    const body = {
      model: "fast",
      temperature: 0.2,
      stream: false,
      messages: [
        { role: "system", content: `Use ${secret}.` },
        {
          role: "user",
          content: [
            { type: "text", text: `Here: ${secret}` },
            { type: "image_url", image_url: { url: image } },
            // A URL of an image is text: its secret goes.
            {
              type: "image_url",
              image_url: { url: `https://images.test/a.png?token=${secret}` },
            },
          ],
        },
        // A message that says it is an image part does not hide its text,
        // and its image field is not an image place.
        {
          type: "image_url",
          image_url: `data:image/png;base64,${aws}`,
          content: `Also ${secret}`,
        },
        // An image data URL outside the image field is text.
        { role: "user", content: `data:image/png;base64,${aws}` },
        { type: "text", text: `data:image/png;base64,${aws}` },
        // A text that starts as a data URL is text (a Kubernetes Secret).
        { role: "tool", content: `data:\n  token: ${secret}\n` },
        { role: "user", content: { [secret]: "a key" } },
      ],
      // An image part in a schema value is schema data, not an image.
      schema: {
        default: {
          type: "image_url",
          image_url: { url: `data:image/png;base64,${aws}` },
        },
      },
      bytes,
    }
    expect(await scrubForModel(body)).toEqual({
      model: "fast",
      temperature: 0.2,
      stream: false,
      messages: [
        { role: "system", content: `Use ${redacted}.` },
        {
          role: "user",
          content: [
            { type: "text", text: `Here: ${redacted}` },
            { type: "image_url", image_url: { url: image } },
            {
              type: "image_url",
              image_url: { url: `https://images.test/a.png?token=${redacted}` },
            },
          ],
        },
        {
          type: "image_url",
          image_url:
            "data:image/png;base64,[REDACTED:betterleaks.aws-access-token]",
          content: `Also ${redacted}`,
        },
        {
          role: "user",
          content:
            "data:image/png;base64,[REDACTED:betterleaks.aws-access-token]",
        },
        {
          type: "text",
          text: "data:image/png;base64,[REDACTED:betterleaks.aws-access-token]",
        },
        { role: "tool", content: `data:\n  token: ${redacted}\n` },
        { role: "user", content: { [redacted]: "a key" } },
      ],
      schema: {
        default: {
          type: "image_url",
          image_url: {
            url: "data:image/png;base64,[REDACTED:betterleaks.aws-access-token]",
          },
        },
      },
      bytes,
    })
  })
})

describe("the model clients", () => {
  const server = useMswServer()
  afterEach(() => vi.unstubAllEnvs())

  const settings = () => {
    vi.stubEnv("MODEL_PROVIDER", "openai-like")
    vi.stubEnv("MODEL_PROVIDER_API_KEY", "fixture-key")
    vi.stubEnv("MODEL_PROVIDER_URL", "https://models.test/api/v1")
    vi.stubEnv("MODEL_FAST_NAME", "fast")
    vi.stubEnv("MODEL_MEDIUM_NAME", "medium")
    vi.stubEnv("MODEL_HIGH_NAME", "high")
    vi.stubEnv("MODEL_EMBEDDING_NAME", "embed")
  }

  /** Each request body that reaches the provider, as text. */
  function provider() {
    const sent: string[] = []
    const vectors = (count: number, dimensions: number) =>
      Array.from({ length: count }, (_, index) => ({
        index,
        embedding: Array<number>(dimensions).fill(0.5),
      }))
    server.use(
      http.post("https://models.test/api/v1/chat/completions", async (c) => {
        sent.push(await c.request.text())
        return HttpResponse.json({
          choices: [{ message: { role: "assistant", content: "ok" } }],
        })
      }),
      http.post("https://models.test/api/v1/embeddings", async (c) => {
        const text = await c.request.text()
        sent.push(text)
        const body = JSON.parse(text) as {
          input: string[]
          dimensions: number
        }
        return HttpResponse.json({
          data: vectors(body.input.length, body.dimensions),
        })
      }),
      http.post("https://models.test/api/alpha/decisions", async (c) => {
        sent.push(await c.request.text())
        return HttpResponse.json({
          answers: { q: { type: "noul", noul: 0.5 } },
        })
      }),
    )
    return sent
  }

  it("sends no secret to a model: LLM tiers, embeddings, the plane and Jev", async () => {
    settings()
    const sent = provider()
    const all = secrets()
    const text = all.map(({ value }) => `key ${value}`).join("\n")

    await chat({
      threadId: "test-thread",
      adapter: getModel("fast"),
      systemPrompts: [text],
      messages: [{ role: "user", content: text }],
      stream: false,
    })
    await generateEmbeddings([text])
    await embedTexts([
      { text, documentTitle: text, chunkIndex: 0, chunkCount: 1 },
    ])
    await embedQuery(text)
    await decideNoul(
      [text],
      { q: { type: "noul", instructions: text } },
      { timeoutMs: 5_000, attributes: {} },
    )
    // A structured call sends its output schema too. The provider gives no
    // tool call, so the call fails after its request.
    await chat({
      threadId: "test-thread",
      adapter: getModel("fast"),
      messages: [{ role: "user", content: text }],
      outputSchema: z.object({ answer: z.string().describe(text) }),
      stream: false,
    }).catch(() => undefined)

    expect(sent).toHaveLength(6)
    for (const body of sent) {
      for (const { rule, value } of all) {
        // No line of a secret (a private key has many) is in the request.
        for (const line of value.split("\n").filter((l) => l.length >= 20))
          expect(body).not.toContain(line)
        expect(body).toContain(`[REDACTED:${rule}]`)
      }
    }
  })

  it("scrubs a secret split over two text parts of a message, which the provider gets as one text", async () => {
    settings()
    const sent = provider()
    const value = secretOf("betterleaks.github-pat")
    await chat({
      threadId: "test-thread",
      adapter: getModel("fast"),
      messages: [
        {
          role: "user",
          content: [
            { type: "text", content: `key ${value.slice(0, 12)}` },
            { type: "text", content: `${value.slice(12)} end` },
          ],
        },
      ],
      stream: false,
    })
    expect(sent).toHaveLength(1)
    expect(sent[0]).not.toContain(value)
    expect(sent[0]).toContain("key [REDACTED:betterleaks.github-pat] end")
  })

  it("sends nothing for a host call with a secret split over two messages", async () => {
    settings()
    const sent = provider()
    const key = secretOf("betterleaks.private-key")
    const half = Math.floor(key.length / 2)
    await expect(
      chat({
        threadId: "test-thread",
        adapter: getModel("fast"),
        messages: [
          { role: "user", content: key.slice(0, half) },
          { role: "user", content: key.slice(half) },
        ],
        stream: false,
      }),
    ).rejects.toThrow(/split over two texts/)
    expect(sent).toHaveLength(0)
  })

  it("scrubs a search question before the cut to the input limit of the model", async () => {
    settings()
    const sent = provider()
    const pem = madeUpPrivateKey(4096)
    // The cut (8,192 bytes) falls inside the key and removes its END line.
    const question = `${"é".repeat(3_000)}\n${pem}`
    expect(
      Buffer.byteLength(question.slice(0, question.indexOf("-----END"))),
    ).toBeGreaterThan(8_192)
    await embedQuery(question)
    expect(sent).toHaveLength(1)
    for (const line of pem.split("\n").slice(1, 20))
      expect(sent[0]).not.toContain(line)
  })

  it("scrubs a token that the cut to the input limit would shorten by one character, on the query and the ingest path", async () => {
    settings()
    const sent = provider()
    const token = `ghp_${random(36)}`
    // 8,152 bytes, a space, then the token: it ends at byte 8,193, one byte
    // after the cut (8,192 bytes).
    const question = `${"é".repeat(4_076)} ${token}`
    expect(Buffer.byteLength(question)).toBe(8_193)
    await embedQuery(question)
    // The text of a chunk has its context line first: "T (part 1 of 1)" and
    // a blank line, 17 bytes. The chunk text is 8,193 bytes too.
    const chunk = `${"é".repeat(4_067)}a ${token}`
    expect(Buffer.byteLength(`T (part 1 of 1)\n\n${chunk}`)).toBe(8_193)
    await embedTexts([
      { text: chunk, documentTitle: "T", chunkIndex: 0, chunkCount: 1 },
    ])
    expect(sent).toHaveLength(2)
    for (const body of sent) expect(body).not.toContain(token.slice(0, -1))
  })

  it("keys a plane vector by the scrubbed text", async () => {
    // Two chunks that differ only in the value of a secret send the same
    // text, so they get the same key and share one vector.
    const chunk = (secret: string) => ({
      text: `token ${secret}`,
      documentTitle: "Setup",
      chunkIndex: 0,
      chunkCount: 1,
    })
    const [first, second] = await scrubForModel([
      chunk(`ghp_${random(36)}`),
      chunk(`ghp_${random(36)}`),
    ])
    if (!first || !second) throw new Error("Expected two inputs")
    expect(first.text).toBe("token [REDACTED:betterleaks.github-pat]")
    expect(embeddingKey(first, textEmbeddingConfig)).toBe(
      embeddingKey(second, textEmbeddingConfig),
    )
  })
})

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name)
    if (statSync(path).isDirectory())
      return name === "node_modules" || name === "test" ? [] : sourceFiles(path)
    return /\.(ts|mts)$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : []
  })
}

describe("the one scrub point", () => {
  it("is in each file that sends a request to a model", () => {
    const MODEL_REQUEST =
      /\/(?:chat\/completions|embeddings|alpha\/decisions|responses)["'`]|new (?:Converse|ConverseStream|InvokeModel|InvokeModelWithResponseStream)Command\b/
    const root = fileURLToPath(new URL("../../../", import.meta.url))
    const clients = [
      ...sourceFiles(join(root, "src")),
      ...sourceFiles(join(root, "evals")),
    ]
      .map((path) => ({
        file: relative(root, path),
        source: readFileSync(path, "utf8"),
      }))
      // A file that names a model endpoint and sends a request.
      .filter(
        ({ source }) =>
          MODEL_REQUEST.test(source) &&
          /\b(?:fetch|doFetch|forwardToUpstream)\(|\.send\(/.test(source),
      )
    // The detector finds the known clients, so an empty list is no pass.
    expect(clients.map(({ file }) => file)).toEqual(
      expect.arrayContaining([
        "src/retrieval/services/providers/openAiHostAdapter.ts",
        "src/retrieval/services/providers/bedrockModelProvider.ts",
        "src/retrieval/embeddings/textEmbeddings.ts",
        "src/retrieval/jev/client.ts",
        "src/routes/v1/openai.ts",
        "evals/knowledge/chat.ts",
      ]),
    )
    // A provider of HostTextAdapter sends only what HostTextAdapter.call
    // scrubbed.
    const bypass = clients
      .filter(
        ({ source }) =>
          !source.includes("scrubForModel(") &&
          !source.includes("new HostTextAdapter("),
      )
      .map(({ file }) => file)
    expect(bypass).toEqual([])
  })
})
