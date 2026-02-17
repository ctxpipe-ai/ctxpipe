// Local Zod module augmentation for OpenAPI metadata.
//
// Goal: allow `z.object().openapi("something")` (type-level only) without
// touching runtime behavior, while staying compatible with Zod v4's core
// types and `@hono/zod-openapi` / `@asteasolutions/zod-to-openapi`.

import "zod"

type OpenApiOptions = Record<string, unknown>
type ZodOpenAPIMetadata<T = unknown> = Record<string, unknown> & {
  default?: T
  example?: unknown
}

declare module "zod" {
  interface ZodString {
    openapi(
      metadata: Partial<ZodOpenAPIMetadata<string>>,
      options?: OpenApiOptions,
    ): this
    openapi(
      refId: string,
      metadata?: Partial<ZodOpenAPIMetadata<string>>,
      options?: OpenApiOptions,
    ): this
  }

  interface ZodLiteral<T = unknown> {
    openapi(
      metadata: Partial<ZodOpenAPIMetadata<T>>,
      options?: OpenApiOptions,
    ): this
    openapi(
      refId: string,
      metadata?: Partial<ZodOpenAPIMetadata<T>>,
      options?: OpenApiOptions,
    ): this
  }

  interface ZodObject {
    openapi(
      metadata: Partial<ZodOpenAPIMetadata<any>>,
      options?: OpenApiOptions,
    ): this
    openapi(
      refId: string,
      metadata?: Partial<ZodOpenAPIMetadata<any>>,
      options?: OpenApiOptions,
    ): this
  }
}

export {}
