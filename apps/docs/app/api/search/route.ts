export const dynamic = "force-dynamic"

import { createFromSource } from "fumadocs-core/search/server"
import { source } from "@/lib/source"

const searchAPI = createFromSource(source)

export const GET = searchAPI.GET
