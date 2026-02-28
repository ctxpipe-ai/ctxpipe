import type { InferResponseType } from "hono/client"
import type { client } from "@/lib/api"

type ListRepositoriesResponse = InferResponseType<
  (typeof client)[":orgSlug"]["api"]["v1"]["repositories"]["$get"],
  200
>

export type Repository = ListRepositoriesResponse["items"][number]
