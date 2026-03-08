export type EntityType =
  | "Repository"
  | "File"
  | "Function"
  | "Class"
  | "Concept"

export type RelationshipType = "related_to" | "mentions"

export type GraphNode = {
  id: string
  name: string
  type: EntityType
  description?: string
  repository?: string
  color: string
  size: number
}

export type GraphLink = {
  source: string
  target: string
  type: RelationshipType
}

export const ENTITY_COLORS: Record<EntityType, string> = {
  Repository: "#f59e0b",
  File: "#2dd4bf",
  Function: "#60a5fa",
  Class: "#a78bfa",
  Concept: "#fb7185",
}

function node(
  id: string,
  name: string,
  type: EntityType,
  description?: string,
  repository?: string,
): GraphNode {
  return {
    id,
    name,
    type,
    description,
    repository,
    color: ENTITY_COLORS[type],
    size: type === "Repository" ? 14 : type === "Concept" ? 10 : 7,
  }
}

export const STUB_NODES: GraphNode[] = [
  // Repositories
  node("r1", "ctxpipe-backend", "Repository", "Core API, MCP server, and graph ingestion pipeline"),
  node("r2", "ctxpipe-ui", "Repository", "TanStack Start frontend application"),

  // Files (backend)
  node("f1", "src/app/app.ts", "File", "Hono application factory", "r1"),
  node("f2", "src/platform/graph/client.ts", "File", "FalkorDB / Neo4j driver abstraction", "r1"),
  node("f3", "src/auth/config.ts", "File", "Better Auth configuration", "r1"),
  node("f4", "src/server.ts", "File", "HTTP server entry point", "r1"),
  node("f5", "src/db/migrate.ts", "File", "Drizzle migration runner", "r1"),
  node("f6", "src/mcp/server.ts", "File", "MCP server definition and tool registration", "r1"),
  node("f7", "src/ingestion/pipeline.ts", "File", "Repository ingestion orchestration", "r1"),
  node("f8", "src/ingestion/chunker.ts", "File", "Code chunking and tokenisation", "r1"),

  // Files (UI)
  node("f9", "src/routes/$orgSlug.chat.tsx", "File", "Chat route", "r2"),
  node("f10", "src/components/SideNav/SideNav.tsx", "File", "Primary navigation", "r2"),
  node("f11", "src/lib/api.ts", "File", "Hono RPC client", "r2"),

  // Classes
  node("c1", "GraphClient", "Class", "Manages Neo4j/FalkorDB driver lifecycle and tenant scoping", "r1"),
  node("c2", "AuthConfig", "Class", "Better Auth server configuration", "r1"),
  node("c3", "McpServer", "Class", "Model Context Protocol server instance", "r1"),
  node("c4", "IngestionPipeline", "Class", "Orchestrates repository clone, chunk, embed and ingest", "r1"),
  node("c5", "AppShell", "Class", "Root layout wrapper with SideNav", "r2"),
  node("c6", "SideNav", "Class", "Collapsible primary navigation", "r2"),

  // Functions
  node("fn1", "getConfig()", "Function", "Reads graph DB connection config from environment", "r1"),
  node("fn2", "withGraphClient()", "Function", "Scopes a graph DB driver to a request via AsyncLocalStorage", "r1"),
  node("fn3", "resolveDriver()", "Function", "Creates or retrieves a tenant-scoped Bolt driver", "r1"),
  node("fn4", "closeGraphDb()", "Function", "Gracefully closes all active graph DB connections", "r1"),
  node("fn5", "ctx_advisor()", "Function", "MCP tool — queries the knowledge graph for code context", "r1"),
  node("fn6", "ingestRepository()", "Function", "Triggers clone, chunk, embed and load for a repo", "r1"),
  node("fn7", "chunkCode()", "Function", "Splits source files into semantically bounded chunks", "r1"),
  node("fn8", "embedChunks()", "Function", "Generates vector embeddings for code chunks", "r1"),
  node("fn9", "runMigrations()", "Function", "Applies pending Drizzle migrations at startup", "r1"),
  node("fn10", "buildApp()", "Function", "Composes Hono middleware stack and routes", "r1"),
  node("fn11", "useSession()", "Function", "Better Auth session hook", "r2"),
  node("fn12", "prepareCosmographData()", "Function", "Indexes raw graph data for GPU rendering", "r2"),

  // Concepts
  node("co1", "Authentication", "Concept", "Session management, OAuth, passkeys, 2FA"),
  node("co2", "Graph DB", "Concept", "OpenCypher-compatible knowledge graph store"),
  node("co3", "MCP Protocol", "Concept", "Model Context Protocol — tool calling over HTTP"),
  node("co4", "RAG Pipeline", "Concept", "Retrieval-augmented generation over indexed code"),
  node("co5", "Multi-tenancy", "Concept", "Per-org data isolation via graph database scoping"),
  node("co6", "Embeddings", "Concept", "Vector representations of code chunks"),
  node("co7", "OpenCypher", "Concept", "Graph query language used across FalkorDB, Neo4j, Memgraph"),
]

export const STUB_LINKS: GraphLink[] = [
  // Files belong to repositories
  { source: "r1", target: "f1", type: "related_to" },
  { source: "r1", target: "f2", type: "related_to" },
  { source: "r1", target: "f3", type: "related_to" },
  { source: "r1", target: "f4", type: "related_to" },
  { source: "r1", target: "f5", type: "related_to" },
  { source: "r1", target: "f6", type: "related_to" },
  { source: "r1", target: "f7", type: "related_to" },
  { source: "r1", target: "f8", type: "related_to" },
  { source: "r2", target: "f9", type: "related_to" },
  { source: "r2", target: "f10", type: "related_to" },
  { source: "r2", target: "f11", type: "related_to" },

  // Classes defined in files
  { source: "f2", target: "c1", type: "related_to" },
  { source: "f3", target: "c2", type: "related_to" },
  { source: "f6", target: "c3", type: "related_to" },
  { source: "f7", target: "c4", type: "related_to" },
  { source: "f1", target: "c5", type: "related_to" },
  { source: "f10", target: "c6", type: "related_to" },

  // Functions defined in files
  { source: "f2", target: "fn1", type: "related_to" },
  { source: "f2", target: "fn2", type: "related_to" },
  { source: "f2", target: "fn3", type: "related_to" },
  { source: "f2", target: "fn4", type: "related_to" },
  { source: "f6", target: "fn5", type: "related_to" },
  { source: "f7", target: "fn6", type: "related_to" },
  { source: "f8", target: "fn7", type: "related_to" },
  { source: "f8", target: "fn8", type: "related_to" },
  { source: "f5", target: "fn9", type: "related_to" },
  { source: "f1", target: "fn10", type: "related_to" },
  { source: "f9", target: "fn11", type: "related_to" },

  // Cross-function mentions
  { source: "fn2", target: "fn3", type: "mentions" },
  { source: "fn5", target: "fn2", type: "mentions" },
  { source: "fn6", target: "fn7", type: "mentions" },
  { source: "fn6", target: "fn8", type: "mentions" },
  { source: "fn10", target: "fn9", type: "mentions" },
  { source: "c4", target: "fn6", type: "mentions" },
  { source: "c3", target: "fn5", type: "mentions" },

  // Concept relationships
  { source: "c1", target: "co2", type: "mentions" },
  { source: "c1", target: "co7", type: "mentions" },
  { source: "c1", target: "co5", type: "mentions" },
  { source: "c2", target: "co1", type: "mentions" },
  { source: "c3", target: "co3", type: "mentions" },
  { source: "c4", target: "co4", type: "mentions" },
  { source: "c4", target: "co6", type: "mentions" },
  { source: "fn5", target: "co3", type: "mentions" },
  { source: "fn5", target: "co4", type: "mentions" },
  { source: "fn8", target: "co6", type: "mentions" },
  { source: "co4", target: "co6", type: "related_to" },
  { source: "co2", target: "co7", type: "related_to" },
  { source: "co5", target: "co2", type: "related_to" },
  { source: "f11", target: "fn11", type: "mentions" },
  { source: "f9", target: "f11", type: "mentions" },
  { source: "f4", target: "f1", type: "mentions" },
  { source: "f4", target: "f3", type: "mentions" },
]
