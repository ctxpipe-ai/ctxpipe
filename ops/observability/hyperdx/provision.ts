/**
 * Idempotent upsert of HyperDX dashboards and saved searches.
 *
 * Operator shell only — not Railway env:
 *   HYPERDX_API_URL    https://hyperdx.ctxpipe.ai/api
 *   HYPERDX_ACCESS_KEY personal API access key
 *
 * The public app proxies /api to the API server, so paths are /api/api/v2/...
 * Dashboard JSON references sources by name (`sourceName`, `appliesToSourceNames`).
 * This script resolves those to ids via GET /api/v2/sources before validate/write.
 * Dashboards that exist live but are not in dashboards/ are left in place.
 */
const apiUrl = process.env.HYPERDX_API_URL?.replace(/\/$/, "");
const accessKey = process.env.HYPERDX_ACCESS_KEY;
if (!apiUrl || !accessKey) {
  console.error("HYPERDX_API_URL and HYPERDX_ACCESS_KEY are required");
  process.exit(1);
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

type Tile = { id?: string; name: string };
type Filter = { id?: string; name?: string; expression?: string };
type Dashboard = {
  id?: string;
  name: string;
  tiles: Tile[];
  filters?: Filter[];
};

const dashboardsDir = `${import.meta.dir}/dashboards`;

async function api(method: string, path: string, body?: Json): Promise<{ status: number; json: Json }> {
  const response = await fetch(`${apiUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessKey}`,
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json: Json = null;
  if (text) {
    try {
      json = JSON.parse(text) as Json;
    } catch {
      json = text;
    }
  }
  return { status: response.status, json };
}

function unwrapList(payload: Json): Json[] {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const data = payload.data;
    if (Array.isArray(data)) return data;
  }
  throw new Error(`Unexpected list payload: ${JSON.stringify(payload).slice(0, 400)}`);
}

function resolveSources(value: Json, byName: Map<string, string>): Json {
  if (Array.isArray(value)) return value.map((item) => resolveSources(item, byName));
  if (value === null || typeof value !== "object") return value;
  const out: { [key: string]: Json } = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "sourceName") {
      if (typeof child !== "string" || !byName.has(child)) {
        throw new Error(`Unknown sourceName ${JSON.stringify(child)}`);
      }
      out.sourceId = byName.get(child) ?? null;
      continue;
    }
    if (key === "appliesToSourceNames") {
      if (!Array.isArray(child) || child.some((name) => typeof name !== "string")) {
        throw new Error("appliesToSourceNames must be an array of source names");
      }
      out.appliesToSourceIds = child.map((name) => {
        const id = byName.get(name as string);
        if (!id) throw new Error(`Unknown source ${name}`);
        return id;
      });
      continue;
    }
    out[key] = resolveSources(child, byName);
  }
  return out;
}

function asDashboard(value: Json): Dashboard {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Dashboard payload is not an object");
  }
  const name = value.name;
  const tiles = value.tiles;
  if (typeof name !== "string" || !Array.isArray(tiles)) {
    throw new Error("Dashboard is missing name or tiles");
  }
  return value as unknown as Dashboard;
}

function newId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function stampIds(next: Dashboard, prev: Dashboard | undefined): Dashboard {
  if (!prev) return next;
  const usedTiles = new Set<string>();
  const tiles = next.tiles.map((tile) => {
    const match = prev.tiles.find((existing) => existing.name === tile.name && existing.id && !usedTiles.has(existing.id));
    if (!match?.id) return { ...tile, id: tile.id ?? newId() };
    usedTiles.add(match.id);
    return { ...tile, id: match.id };
  });
  const usedFilters = new Set<string>();
  const filters = (next.filters ?? []).map((filter) => {
    const match = (prev.filters ?? []).find(
      (existing) =>
        existing.id &&
        !usedFilters.has(existing.id) &&
        existing.name === filter.name &&
        existing.expression === filter.expression,
    );
    if (!match?.id) return { ...filter, id: filter.id ?? newId() };
    usedFilters.add(match.id);
    return { ...filter, id: match.id };
  });
  return { ...next, tiles, filters };
}

function fail(action: string, status: number, json: Json): never {
  console.error(`${action} failed HTTP ${status}: ${JSON.stringify(json).slice(0, 2000)}`);
  process.exit(1);
}

const sourcesResponse = await api("GET", "/api/v2/sources");
if (sourcesResponse.status !== 200) fail("GET /api/v2/sources", sourcesResponse.status, sourcesResponse.json);
const sourcesByName = new Map<string, string>();
for (const source of unwrapList(sourcesResponse.json)) {
  if (!source || typeof source !== "object" || Array.isArray(source)) continue;
  const name = source.name;
  const id = source.id;
  if (typeof name === "string" && typeof id === "string") sourcesByName.set(name, id);
}
console.log(`sources: ${[...sourcesByName.keys()].sort().join(", ") || "(none)"}`);

const dashboardFiles = (await Array.fromAsync(new Bun.Glob("*.json").scan({ cwd: dashboardsDir }))).sort();
if (dashboardFiles.length === 0) {
  console.error(`No dashboard JSON in ${dashboardsDir}`);
  process.exit(1);
}

const existingDashboards = new Map<string, Dashboard>();
const listDashboards = await api("GET", "/api/v2/dashboards");
if (listDashboards.status !== 200) fail("GET /api/v2/dashboards", listDashboards.status, listDashboards.json);
for (const item of unwrapList(listDashboards.json)) {
  const dashboard = asDashboard(item);
  if (existingDashboards.has(dashboard.name)) {
    console.error(`Duplicate live dashboard name ${dashboard.name}`);
    process.exit(1);
  }
  existingDashboards.set(dashboard.name, dashboard);
}

const repoDashboardNames = new Set<string>();
for (const file of dashboardFiles) {
  const raw = JSON.parse(await Bun.file(`${dashboardsDir}/${file}`).text()) as Json;
  const resolved = asDashboard(resolveSources(raw, sourcesByName));
  repoDashboardNames.add(resolved.name);
  const validation = await api("POST", "/api/v2/dashboards/validate", resolved);
  if (validation.status !== 200) fail(`validate ${file}`, validation.status, validation.json);
  const validationBody = validation.json;
  const errors =
    validationBody && typeof validationBody === "object" && !Array.isArray(validationBody) && Array.isArray(validationBody.errors)
      ? validationBody.errors
      : [];
  const valid =
    validationBody &&
    typeof validationBody === "object" &&
    !Array.isArray(validationBody) &&
    validationBody.valid === true;
  console.log(`validate ${file} name=${JSON.stringify(resolved.name)} valid=${valid === true} errors=${errors.length}`);
  if (!valid) fail(`validate ${file}`, validation.status, validation.json);
  const tileCount = resolved.tiles.length;
  const existing = existingDashboards.get(resolved.name);
  if (!existing?.id) {
    const created = await api("POST", "/api/v2/dashboards", resolved);
    if (created.status !== 200 && created.status !== 201) fail(`create ${resolved.name}`, created.status, created.json);
    const body = created.json;
    const data =
      body && typeof body === "object" && !Array.isArray(body) && body.data ? asDashboard(body.data) : asDashboard(body);
    console.log(`created dashboard ${resolved.name} id=${data.id} tiles=${tileCount}`);
    continue;
  }
  const updatedBody = stampIds(resolved, existing);
  const updated = await api("PUT", `/api/v2/dashboards/${existing.id}`, updatedBody);
  if (updated.status !== 200) fail(`update ${resolved.name}`, updated.status, updated.json);
  console.log(`updated dashboard ${resolved.name} id=${existing.id} tiles=${tileCount}`);
}
for (const name of existingDashboards.keys()) {
  if (!repoDashboardNames.has(name)) console.log(`left dashboard not in repo: ${name}`);
}

const savedSearches: Json[] = [
  {
    name: "Request by id",
    sourceName: "Logs",
    select: "Timestamp, ServiceName, SeverityText, Body, TraceId, LogAttributes['request.id']",
    where: "LogAttributes['request.id'] != ''",
    whereLanguage: "sql",
    orderBy: "Timestamp DESC",
    tags: ["ctxpipe"],
  },
  {
    name: "Request by id (traces)",
    sourceName: "Traces",
    select: "Timestamp, ServiceName, StatusCode, SpanName, TraceId, SpanAttributes['request.id']",
    where: "SpanAttributes['request.id'] != ''",
    whereLanguage: "sql",
    orderBy: "Timestamp DESC",
    tags: ["ctxpipe"],
  },
];

const savedList = await api("GET", "/api/v2/saved-searches?limit=1000");
if (savedList.status !== 200) fail("GET /api/v2/saved-searches", savedList.status, savedList.json);
const savedByName = new Map<string, string>();
for (const item of unwrapList(savedList.json)) {
  if (!item || typeof item !== "object" || Array.isArray(item)) continue;
  if (typeof item.name === "string" && typeof item.id === "string") savedByName.set(item.name, item.id);
}

for (const savedSearch of savedSearches) {
  const savedSearchBody = resolveSources(savedSearch, sourcesByName);
  const name = typeof savedSearchBody === "object" && savedSearchBody && !Array.isArray(savedSearchBody) ? savedSearchBody.name : "";
  if (typeof name !== "string") fail("saved search", 0, savedSearchBody);
  const existingId = savedByName.get(name);
  if (!existingId) {
    const created = await api("POST", "/api/v2/saved-searches", savedSearchBody);
    if (created.status !== 200 && created.status !== 201) fail(`create saved search ${name}`, created.status, created.json);
    const body = created.json;
    const id =
      body && typeof body === "object" && !Array.isArray(body) && body.data && typeof body.data === "object" && !Array.isArray(body.data) && typeof body.data.id === "string"
        ? body.data.id
        : "";
    console.log(`created saved search ${name} id=${id}`);
    continue;
  }
  const updated = await api("PUT", `/api/v2/saved-searches/${existingId}`, savedSearchBody);
  if (updated.status !== 200) fail(`update saved search ${name}`, updated.status, updated.json);
  console.log(`updated saved search ${name} id=${existingId}`);
}
