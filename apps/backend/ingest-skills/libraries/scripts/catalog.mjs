// Architectural libraries: the ones that shape a codebase (data access, web
// framework, HTTP client, auth, validation, cache, messaging, RPC). Utility
// libraries and test tools are not in the list. `id` is the file name in
// knowledge/libraries/. Package names are exact; a Go module path also
// matches its major-version suffix (for example /v9).

export const CATEGORY_SUMMARY = {
  orm: "Data access library (ORM or query builder).",
  web: "Web framework.",
  http: "HTTP client library.",
  auth: "Authentication library.",
  validation: "Schema validation library.",
  cache: "Cache and key-value client library.",
  messaging: "Message queue or stream client library.",
  rpc: "RPC framework.",
  runtime: "Async runtime.",
  serialization: "Serialization library.",
  ui: "UI framework.",
}

export const LIBRARIES = [
  // Data access
  {
    id: "prisma",
    name: "Prisma",
    category: "orm",
    npm: ["@prisma/client", "prisma"],
  },
  { id: "drizzle", name: "Drizzle ORM", category: "orm", npm: ["drizzle-orm"] },
  { id: "typeorm", name: "TypeORM", category: "orm", npm: ["typeorm"] },
  { id: "sequelize", name: "Sequelize", category: "orm", npm: ["sequelize"] },
  { id: "mongoose", name: "Mongoose", category: "orm", npm: ["mongoose"] },
  { id: "knex", name: "Knex", category: "orm", npm: ["knex"] },
  { id: "kysely", name: "Kysely", category: "orm", npm: ["kysely"] },
  {
    id: "sqlalchemy",
    name: "SQLAlchemy",
    category: "orm",
    pypi: ["sqlalchemy"],
  },
  { id: "gorm", name: "GORM", category: "orm", go: ["gorm.io/gorm"] },
  {
    id: "sqlx",
    name: "SQLx",
    category: "orm",
    cargo: ["sqlx"],
    go: ["github.com/jmoiron/sqlx"],
  },
  { id: "diesel", name: "Diesel", category: "orm", cargo: ["diesel"] },
  {
    id: "hibernate",
    name: "Hibernate",
    category: "orm",
    maven: ["org.hibernate:hibernate-core", "org.hibernate.orm:hibernate-core"],
  },
  // Web frameworks
  { id: "express", name: "Express", category: "web", npm: ["express"] },
  { id: "fastify", name: "Fastify", category: "web", npm: ["fastify"] },
  { id: "hono", name: "Hono", category: "web", npm: ["hono"] },
  { id: "nestjs", name: "NestJS", category: "web", npm: ["@nestjs/core"] },
  { id: "koa", name: "Koa", category: "web", npm: ["koa"] },
  { id: "next-js", name: "Next.js", category: "web", npm: ["next"] },
  { id: "fastapi", name: "FastAPI", category: "web", pypi: ["fastapi"] },
  { id: "flask", name: "Flask", category: "web", pypi: ["flask"] },
  { id: "django", name: "Django", category: "web", pypi: ["django"] },
  { id: "gin", name: "Gin", category: "web", go: ["github.com/gin-gonic/gin"] },
  {
    id: "echo",
    name: "Echo",
    category: "web",
    go: ["github.com/labstack/echo"],
  },
  { id: "chi", name: "chi", category: "web", go: ["github.com/go-chi/chi"] },
  {
    id: "fiber",
    name: "Fiber",
    category: "web",
    go: ["github.com/gofiber/fiber"],
  },
  { id: "axum", name: "Axum", category: "web", cargo: ["axum"] },
  { id: "actix-web", name: "Actix Web", category: "web", cargo: ["actix-web"] },
  {
    id: "spring-boot",
    name: "Spring Boot",
    category: "web",
    maven: [
      "org.springframework.boot:spring-boot-starter-web",
      "org.springframework.boot:spring-boot-starter-webflux",
    ],
  },
  { id: "rails", name: "Ruby on Rails", category: "web", gem: ["rails"] },
  // UI frameworks
  { id: "react", name: "React", category: "ui", npm: ["react"] },
  { id: "vue", name: "Vue", category: "ui", npm: ["vue"] },
  { id: "svelte", name: "Svelte", category: "ui", npm: ["svelte"] },
  { id: "angular", name: "Angular", category: "ui", npm: ["@angular/core"] },
  // HTTP clients
  { id: "axios", name: "Axios", category: "http", npm: ["axios"] },
  { id: "requests", name: "Requests", category: "http", pypi: ["requests"] },
  { id: "httpx", name: "HTTPX", category: "http", pypi: ["httpx"] },
  { id: "reqwest", name: "reqwest", category: "http", cargo: ["reqwest"] },
  // Auth
  {
    id: "better-auth",
    name: "Better Auth",
    category: "auth",
    npm: ["better-auth"],
  },
  {
    id: "next-auth",
    name: "NextAuth.js",
    category: "auth",
    npm: ["next-auth", "@auth/core"],
  },
  { id: "passport", name: "Passport", category: "auth", npm: ["passport"] },
  {
    id: "clerk",
    name: "Clerk",
    category: "auth",
    npm: ["@clerk/nextjs", "@clerk/clerk-sdk-node", "@clerk/backend"],
  },
  {
    id: "spring-security",
    name: "Spring Security",
    category: "auth",
    maven: ["org.springframework.boot:spring-boot-starter-security"],
  },
  // Validation
  { id: "zod", name: "Zod", category: "validation", npm: ["zod"] },
  { id: "yup", name: "Yup", category: "validation", npm: ["yup"] },
  { id: "joi", name: "Joi", category: "validation", npm: ["joi"] },
  { id: "valibot", name: "Valibot", category: "validation", npm: ["valibot"] },
  {
    id: "pydantic",
    name: "Pydantic",
    category: "validation",
    pypi: ["pydantic"],
  },
  // Cache
  {
    id: "redis",
    name: "Redis client",
    category: "cache",
    npm: ["redis", "ioredis", "@upstash/redis"],
    pypi: ["redis"],
    go: ["github.com/redis/go-redis", "github.com/go-redis/redis"],
    cargo: ["redis"],
  },
  // Messaging
  {
    id: "kafka",
    name: "Kafka client",
    category: "messaging",
    npm: ["kafkajs"],
    pypi: ["kafka-python", "confluent-kafka"],
    go: [
      "github.com/segmentio/kafka-go",
      "github.com/confluentinc/confluent-kafka-go",
    ],
    cargo: ["rdkafka"],
    maven: [
      "org.apache.kafka:kafka-clients",
      "org.springframework.kafka:spring-kafka",
    ],
  },
  { id: "bullmq", name: "BullMQ", category: "messaging", npm: ["bullmq"] },
  {
    id: "amqp",
    name: "AMQP client",
    category: "messaging",
    npm: ["amqplib"],
    pypi: ["pika"],
    go: ["github.com/rabbitmq/amqp091-go"],
    cargo: ["lapin"],
  },
  { id: "celery", name: "Celery", category: "messaging", pypi: ["celery"] },
  { id: "sidekiq", name: "Sidekiq", category: "messaging", gem: ["sidekiq"] },
  // RPC
  { id: "trpc", name: "tRPC", category: "rpc", npm: ["@trpc/server"] },
  {
    id: "grpc",
    name: "gRPC",
    category: "rpc",
    npm: ["@grpc/grpc-js"],
    pypi: ["grpcio"],
    go: ["google.golang.org/grpc"],
    cargo: ["tonic"],
    maven: ["io.grpc:grpc-stub"],
  },
  {
    id: "graphql",
    name: "GraphQL",
    category: "rpc",
    npm: ["graphql"],
    pypi: ["graphene", "strawberry-graphql"],
    go: ["github.com/99designs/gqlgen"],
    cargo: ["async-graphql"],
  },
  // Runtime and serialization
  { id: "tokio", name: "Tokio", category: "runtime", cargo: ["tokio"] },
  { id: "serde", name: "Serde", category: "serialization", cargo: ["serde"] },
]
