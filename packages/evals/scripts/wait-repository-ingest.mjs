#!/usr/bin/env node
/**
 * Polls org-scoped repository API until ingestion marks the repo ready
 * (indexReady + lastIngestedHash), matching openworkflow `repository-ingestion`
 * completion (see apps/backend/src/openworkflow/repository-ingestion.ts).
 *
 * Optional: POST a new repository first (triggers the same workflow as the UI create flow).
 */

function env(name, required = true) {
  const v = process.env[name]
  if (required && (v == null || v === "")) {
    console.error(`wait-repository-ingest: missing env ${name}`)
    process.exit(1)
  }
  return v ?? ""
}

function baseUrl() {
  const raw = env("CTXPIPE_API_BASE_URL")
  return raw.replace(/\/$/, "")
}

function authHeaders() {
  const token = env("CTXPIPE_API_TOKEN")
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  }
}

async function apiGet(path) {
  const res = await fetch(`${baseUrl()}${path}`, {
    headers: authHeaders(),
  })
  const text = await res.text()
  let json
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = { _raw: text }
  }
  return { ok: res.ok, status: res.status, json }
}

async function apiPost(path, body) {
  const res = await fetch(`${baseUrl()}${path}`, {
    method: "POST",
    headers: {
      ...authHeaders(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let json
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = { _raw: text }
  }
  return { ok: res.ok, status: res.status, json }
}

function orgScopedBase() {
  const slug = env("CTXPIPE_ORG_SLUG")
  return `/${encodeURIComponent(slug)}/api/v1`
}

async function maybeTriggerIngest() {
  if (process.env.CTXPIPE_EVAL_TRIGGER_INGEST !== "1") {
    return null
  }
  const name = env("CTXPIPE_EVAL_REPO_NAME")
  const gitUrl = env("CTXPIPE_EVAL_GIT_URL")
  const path = `${orgScopedBase()}/repositories`
  const { ok, status, json } = await apiPost(path, { name, gitUrl })
  if (!ok) {
    console.error(
      `wait-repository-ingest: POST ${path} failed: ${status}`,
      json,
    )
    process.exit(1)
  }
  const id = json?.id
  if (typeof id !== "string" || !id) {
    console.error("wait-repository-ingest: create response missing id", json)
    process.exit(1)
  }
  console.error(
    `wait-repository-ingest: created repository ${id} (name=${JSON.stringify(name)})`,
  )
  return id
}

async function resolveRepositoryId() {
  const triggered = await maybeTriggerIngest()
  if (triggered) return triggered

  let id = process.env.CTXPIPE_EVAL_REPOSITORY_ID
  if (id) return id

  const name = process.env.CTXPIPE_EVAL_REPO_NAME
  if (!name) {
    console.error(
      "wait-repository-ingest: set CTXPIPE_EVAL_REPOSITORY_ID, or CTXPIPE_EVAL_REPO_NAME (with list lookup), or CTXPIPE_EVAL_TRIGGER_INGEST=1 with create vars",
    )
    process.exit(1)
  }

  const path = `${orgScopedBase()}/repositories`
  const { ok, status, json } = await apiGet(path)
  if (!ok) {
    console.error(`wait-repository-ingest: GET ${path} failed: ${status}`, json)
    process.exit(1)
  }
  const items = json?.items
  if (!Array.isArray(items)) {
    console.error("wait-repository-ingest: unexpected list response", json)
    process.exit(1)
  }
  const row = items.find((r) => r.name === name)
  if (!row?.id) {
    console.error(
      `wait-repository-ingest: no repository with name ${JSON.stringify(name)}`,
    )
    process.exit(1)
  }
  console.error(`wait-repository-ingest: resolved id ${row.id} for name ${JSON.stringify(name)}`)
  return row.id
}

async function main() {
  if (process.env.CTXPIPE_EVAL_SKIP_WAIT === "1") {
    console.error("wait-repository-ingest: CTXPIPE_EVAL_SKIP_WAIT=1 — skipping poll")
    process.exit(0)
  }

  const repositoryId = await resolveRepositoryId()
  const path = `${orgScopedBase()}/repositories/${encodeURIComponent(repositoryId)}`

  const intervalMs = Number(process.env.CTXPIPE_EVAL_POLL_MS || "4000")
  const maxMs = Number(process.env.CTXPIPE_EVAL_INGEST_TIMEOUT_MS || String(20 * 60 * 1000))
  const deadline = Date.now() + maxMs

  console.error(`wait-repository-ingest: polling ${path} every ${intervalMs}ms (timeout ${maxMs}ms)`)

  while (Date.now() < deadline) {
    const { ok, status, json } = await apiGet(path)
    if (!ok) {
      console.error(`wait-repository-ingest: GET failed: ${status}`, json)
      process.exit(1)
    }
    const ready = json?.indexReady === true
    const hash = json?.lastIngestedHash
    if (ready && hash) {
      console.error(
        `wait-repository-ingest: ready (lastIngestedHash=${hash}, name=${JSON.stringify(json?.name)})`,
      )
      process.exit(0)
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }

  console.error("wait-repository-ingest: timed out waiting for indexReady + lastIngestedHash")
  process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
