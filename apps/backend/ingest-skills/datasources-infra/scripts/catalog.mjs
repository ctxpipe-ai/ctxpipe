// The closed vocabulary of the datasources-infra script. Every word that the
// script puts in its result comes from this file, or it is a safe identifier
// (a variable name, a resource label). Text from the source repository never
// goes through.

/**
 * Data stores. `deps` are package names (lower case) in the manifests of the
 * languages. `schemes` are URL schemes. `images` are the last path segment of
 * a container image. `orm` are the tokens of an ORM or framework config.
 */
export const STORES = [
  {
    id: "postgres",
    name: "PostgreSQL",
    category: "relational",
    deps: [
      "pg",
      "postgres",
      "pg-promise",
      "@neondatabase/serverless",
      "@vercel/postgres",
      "psycopg",
      "psycopg2",
      "psycopg2-binary",
      "asyncpg",
      "pgx",
      "github.com/jackc/pgx",
      "github.com/lib/pq",
      "tokio-postgres",
      "deadpool-postgres",
      "postgresql",
    ],
    schemes: ["postgres", "postgresql"],
    images: ["postgres", "postgresql", "postgis", "timescaledb"],
    orm: ["postgres", "postgresql", "pg", "aurora-postgresql"],
  },
  {
    id: "mysql",
    name: "MySQL",
    category: "relational",
    deps: [
      "mysql",
      "mysql2",
      "@planetscale/database",
      "pymysql",
      "mysqlclient",
      "mysql-connector-python",
      "aiomysql",
      "github.com/go-sql-driver/mysql",
      "mysql_async",
      "mysql-connector-j",
      "mysql-connector-java",
    ],
    schemes: ["mysql"],
    images: ["mysql"],
    orm: ["mysql", "mysql2", "aurora-mysql"],
  },
  {
    id: "mariadb",
    name: "MariaDB",
    category: "relational",
    deps: ["mariadb", "mariadb-java-client"],
    schemes: ["mariadb"],
    images: ["mariadb"],
    orm: ["mariadb"],
  },
  {
    id: "sqlite",
    name: "SQLite",
    category: "relational",
    deps: [
      "better-sqlite3",
      "sqlite3",
      "@libsql/client",
      "github.com/mattn/go-sqlite3",
      "rusqlite",
      "sqlite-jdbc",
      "aiosqlite",
    ],
    schemes: ["sqlite", "libsql"],
    images: [],
    orm: ["sqlite", "sqlite3", "turso", "libsql"],
  },
  {
    id: "sqlserver",
    name: "SQL Server",
    category: "relational",
    deps: [
      "mssql",
      "tedious",
      "github.com/microsoft/go-mssqldb",
      "pymssql",
      "mssql-jdbc",
    ],
    schemes: ["sqlserver", "mssql"],
    images: ["mssql", "mssql-server"],
    orm: ["sqlserver", "mssql"],
  },
  {
    id: "oracle",
    name: "Oracle Database",
    category: "relational",
    deps: ["oracledb", "cx-oracle", "cx_oracle"],
    schemes: ["oracle"],
    images: [],
    orm: ["oracle"],
  },
  {
    id: "cockroachdb",
    name: "CockroachDB",
    category: "relational",
    deps: [],
    schemes: ["cockroachdb"],
    images: ["cockroach"],
    orm: ["cockroachdb"],
  },
  {
    id: "mongodb",
    name: "MongoDB",
    category: "document",
    deps: [
      "mongodb",
      "mongoose",
      "mongoid",
      "pymongo",
      "motor",
      "mongo",
      "go.mongodb.org/mongo-driver",
      "mongodb-driver-sync",
      "spring-boot-starter-data-mongodb",
    ],
    schemes: ["mongodb", "mongodb+srv"],
    images: ["mongo"],
    orm: ["mongodb"],
  },
  {
    id: "dynamodb",
    name: "Amazon DynamoDB",
    category: "key-value",
    deps: [
      "@aws-sdk/client-dynamodb",
      "@aws-sdk/lib-dynamodb",
      "aws-sdk-dynamodb",
      "github.com/aws/aws-sdk-go-v2/service/dynamodb",
    ],
    schemes: [],
    images: ["dynamodb-local"],
    orm: [],
  },
  {
    id: "cassandra",
    name: "Apache Cassandra",
    category: "wide-column",
    deps: [
      "cassandra-driver",
      "github.com/gocql/gocql",
      "scylla",
      "spring-boot-starter-data-cassandra",
    ],
    schemes: ["cassandra"],
    images: ["cassandra", "scylla"],
    orm: [],
  },
  {
    id: "redis",
    name: "Redis",
    category: "key-value",
    deps: [
      "redis",
      "ioredis",
      "@upstash/redis",
      "aioredis",
      "predis/predis",
      "jedis",
      "lettuce-core",
      "spring-boot-starter-data-redis",
      "github.com/redis/go-redis",
      "github.com/go-redis/redis",
    ],
    schemes: ["redis", "rediss", "valkey"],
    images: ["redis", "valkey", "redis-stack"],
    orm: [],
  },
  {
    id: "memcached",
    name: "Memcached",
    category: "key-value",
    deps: ["memjs", "pymemcache", "dalli", "github.com/bradfitz/gomemcache"],
    schemes: ["memcached", "memcache"],
    images: ["memcached"],
    orm: [],
  },
  {
    id: "elasticsearch",
    name: "Elasticsearch",
    category: "search",
    deps: [
      "@elastic/elasticsearch",
      "elasticsearch",
      "github.com/elastic/go-elasticsearch",
      "elasticsearch-java",
      "spring-boot-starter-data-elasticsearch",
    ],
    schemes: [],
    images: ["elasticsearch"],
    orm: [],
  },
  {
    id: "opensearch",
    name: "OpenSearch",
    category: "search",
    deps: ["@opensearch-project/opensearch", "opensearch-py"],
    schemes: [],
    images: ["opensearch"],
    orm: [],
  },
  {
    id: "clickhouse",
    name: "ClickHouse",
    category: "analytics",
    deps: [
      "@clickhouse/client",
      "clickhouse-connect",
      "github.com/clickhouse/clickhouse-go",
    ],
    schemes: ["clickhouse"],
    images: ["clickhouse-server", "clickhouse"],
    orm: [],
  },
  {
    id: "neo4j",
    name: "Neo4j",
    category: "graph",
    deps: ["neo4j-driver", "neo4j", "github.com/neo4j/neo4j-go-driver"],
    schemes: ["neo4j", "bolt"],
    images: ["neo4j"],
    orm: [],
  },
  {
    id: "couchdb",
    name: "CouchDB",
    category: "document",
    deps: ["couchdb"],
    schemes: ["couchdb"],
    images: ["couchdb"],
    orm: [],
  },
  {
    id: "influxdb",
    name: "InfluxDB",
    category: "time-series",
    deps: ["@influxdata/influxdb-client", "influxdb-client"],
    schemes: ["influxdb"],
    images: ["influxdb"],
    orm: [],
  },
  {
    id: "firestore",
    name: "Cloud Firestore",
    category: "document",
    deps: ["@google-cloud/firestore", "google-cloud-firestore"],
    schemes: [],
    images: [],
    orm: [],
  },
  {
    id: "cosmosdb",
    name: "Azure Cosmos DB",
    category: "document",
    deps: ["@azure/cosmos", "azure-cosmos"],
    schemes: [],
    images: [],
    orm: [],
  },
  {
    id: "supabase",
    name: "Supabase",
    category: "relational",
    deps: ["@supabase/supabase-js", "supabase"],
    schemes: [],
    images: [],
    orm: [],
  },
  {
    id: "bigquery",
    name: "Google BigQuery",
    category: "analytics",
    deps: ["@google-cloud/bigquery", "google-cloud-bigquery"],
    schemes: ["bigquery"],
    images: [],
    orm: [],
  },
  {
    id: "s3",
    name: "Amazon S3",
    category: "object-storage",
    deps: [
      "@aws-sdk/client-s3",
      "aws-sdk-s3",
      "github.com/aws/aws-sdk-go-v2/service/s3",
    ],
    schemes: ["s3"],
    images: [],
    orm: [],
  },
  {
    id: "minio",
    name: "MinIO",
    category: "object-storage",
    deps: ["minio", "github.com/minio/minio-go"],
    schemes: [],
    images: ["minio"],
    orm: [],
  },
  {
    id: "gcs",
    name: "Google Cloud Storage",
    category: "object-storage",
    deps: ["@google-cloud/storage", "google-cloud-storage"],
    schemes: ["gs"],
    images: [],
    orm: [],
  },
  // Engine not resolved by a script. The model reads the code and decides.
  {
    id: "relational-database",
    name: "Relational database",
    category: "relational",
    deps: [],
    schemes: [],
    images: [],
    orm: [],
  },
  {
    id: "cache",
    name: "Cache",
    category: "key-value",
    deps: [],
    schemes: [],
    images: [],
    orm: [],
  },
]

/** Text that names an engine (a Terraform `engine`, a CDK engine) to a store id. */
export function engineToStore(text) {
  const t = String(text).toLowerCase()
  if (t.includes("postgres") || t === "pg") return "postgres"
  if (t.includes("mariadb")) return "mariadb"
  if (t.includes("mysql")) return "mysql"
  if (
    t.includes("sqlserver") ||
    t.includes("sql-server") ||
    t.includes("mssql")
  )
    return "sqlserver"
  if (t.includes("oracle")) return "oracle"
  if (t.includes("redis") || t.includes("valkey")) return "redis"
  if (t.includes("memcached")) return "memcached"
  if (t.includes("docdb") || t.includes("mongo")) return "mongodb"
  return null
}

/**
 * Terraform and CloudFormation resource types that are a data store. `engine`
 * means that the script reads the engine in the resource block; `fallback` is
 * the store when it cannot.
 */
export const IAC_STORES = {
  aws_db_instance: { engine: true, fallback: "relational-database" },
  aws_rds_cluster: { engine: true, fallback: "relational-database" },
  google_sql_database_instance: {
    engine: true,
    fallback: "relational-database",
  },
  digitalocean_database_cluster: {
    engine: true,
    fallback: "relational-database",
  },
  azurerm_postgresql_flexible_server: { fallback: "postgres" },
  azurerm_mysql_flexible_server: { fallback: "mysql" },
  azurerm_mssql_server: { fallback: "sqlserver" },
  azurerm_cosmosdb_account: { fallback: "cosmosdb" },
  aws_dynamodb_table: { fallback: "dynamodb" },
  aws_elasticache_cluster: { engine: true, fallback: "cache" },
  aws_elasticache_replication_group: { engine: true, fallback: "cache" },
  aws_memorydb_cluster: { fallback: "redis" },
  google_redis_instance: { fallback: "redis" },
  azurerm_redis_cache: { fallback: "redis" },
  aws_s3_bucket: { fallback: "s3" },
  google_storage_bucket: { fallback: "gcs" },
  aws_opensearch_domain: { fallback: "opensearch" },
  aws_elasticsearch_domain: { fallback: "elasticsearch" },
  google_firestore_database: { fallback: "firestore" },
  google_bigquery_dataset: { fallback: "bigquery" },
  "AWS::RDS::DBInstance": { engine: true, fallback: "relational-database" },
  "AWS::RDS::DBCluster": { engine: true, fallback: "relational-database" },
  "AWS::DynamoDB::Table": { fallback: "dynamodb" },
  "AWS::DynamoDB::GlobalTable": { fallback: "dynamodb" },
  "AWS::S3::Bucket": { fallback: "s3" },
  "AWS::ElastiCache::CacheCluster": { engine: true, fallback: "cache" },
  "AWS::ElastiCache::ReplicationGroup": { engine: true, fallback: "cache" },
  "AWS::OpenSearchService::Domain": { fallback: "opensearch" },
  "AWS::DocDB::DBCluster": { fallback: "mongodb" },
}

/** Terraform resource types that run code: they show where a service runs. */
export const TERRAFORM_COMPUTE = new Set([
  "aws_instance",
  "aws_ecs_service",
  "aws_ecs_cluster",
  "aws_lambda_function",
  "aws_eks_cluster",
  "aws_apprunner_service",
  "aws_elastic_beanstalk_environment",
  "google_cloud_run_service",
  "google_cloud_run_v2_service",
  "google_compute_instance",
  "google_container_cluster",
  "azurerm_linux_web_app",
  "azurerm_container_app",
  "azurerm_kubernetes_cluster",
  "kubernetes_deployment",
  "kubernetes_deployment_v1",
  "kubernetes_stateful_set",
  "digitalocean_droplet",
  "digitalocean_app",
])

/** Infrastructure kinds. */
export const INFRA = {
  docker: "Docker",
  "docker-compose": "Docker Compose",
  kubernetes: "Kubernetes",
  helm: "Helm",
  terraform: "Terraform",
  pulumi: "Pulumi",
  "aws-cdk": "AWS CDK",
  "aws-sam": "AWS SAM",
  "aws-cloudformation": "AWS CloudFormation",
  "serverless-framework": "Serverless Framework",
  "cloudflare-workers": "Cloudflare Workers",
  vercel: "Vercel",
  "fly-io": "Fly.io",
  railway: "Railway",
  render: "Render",
  netlify: "Netlify",
}

/** File names (exact, lower case) that name an infrastructure kind. */
export const INFRA_FILES = {
  "pulumi.yaml": "pulumi",
  "pulumi.yml": "pulumi",
  "cdk.json": "aws-cdk",
  "serverless.yml": "serverless-framework",
  "serverless.yaml": "serverless-framework",
  "serverless.ts": "serverless-framework",
  "wrangler.toml": "cloudflare-workers",
  "wrangler.json": "cloudflare-workers",
  "wrangler.jsonc": "cloudflare-workers",
  "vercel.json": "vercel",
  "fly.toml": "fly-io",
  "railway.json": "railway",
  "railway.toml": "railway",
  "render.yaml": "render",
  "render.yml": "render",
  "netlify.toml": "netlify",
  "chart.yaml": "helm",
}

/** CDK constructs: `prefix.Class` (a module alias) to a store id, or an infra detail. */
export const CDK_STORES = {
  "rds.DatabaseInstance": "relational-database",
  "rds.DatabaseCluster": "relational-database",
  "rds.ServerlessCluster": "relational-database",
  "dynamodb.Table": "dynamodb",
  "dynamodb.TableV2": "dynamodb",
  "s3.Bucket": "s3",
  "elasticache.CfnCacheCluster": "cache",
  "elasticache.CfnReplicationGroup": "cache",
  "opensearch.Domain": "opensearch",
  "docdb.DatabaseCluster": "mongodb",
}

export const CDK_COMPUTE = new Set([
  "lambda.Function",
  "ecs.FargateService",
  "ecs.Ec2Service",
  "ecs.Cluster",
  "eks.Cluster",
  "apprunner.Service",
  "ecs_patterns.ApplicationLoadBalancedFargateService",
  "ecsPatterns.ApplicationLoadBalancedFargateService",
  "nodejs.NodejsFunction",
  "lambda_nodejs.NodejsFunction",
])
