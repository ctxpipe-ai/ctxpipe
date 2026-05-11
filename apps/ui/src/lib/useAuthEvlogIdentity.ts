import { useEffect } from "react"
import { clearIdentity, setIdentity } from "evlog/client"
import { useSession } from "@/lib/auth-client"

/**
 * Sync Better Auth session into evlog client logs (see
 * https://www.evlog.dev/logging/better-auth — Client Identity Sync).
 */
export function useAuthEvlogIdentity(): void {
  const { data: session, isPending } = useSession()

  useEffect(() => {
    if (isPending) return
    const user = session?.user
    if (user?.id) {
      setIdentity({ userId: user.id, userName: user.name ?? undefined })
    } else {
      clearIdentity()
    }
  }, [isPending, session?.user])
}
