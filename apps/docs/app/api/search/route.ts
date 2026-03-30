export const dynamic = "force-dynamic"

/**
 * Docs search is stubbed: `createFromSource` + Orama advanced indexes throw during `next build`
 * (`TypeError: a.map is not a function` inside index formatting) with the current MDX output shape.
 * Re-enable fumadocs `createFromSource(source)` once upstream / structuredData is aligned.
 */
export async function GET(): Promise<Response> {
  return Response.json([])
}
