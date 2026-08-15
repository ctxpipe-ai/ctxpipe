import { useNavigate } from "@tanstack/react-router"
import { useEffect } from "react"
import {
  SCENE_NAMES,
  type SceneKey,
  VARIANT_NAMES,
  type VariantKey,
} from "./mock"

function parseVariant(value: unknown): VariantKey {
  return value === "B" || value === "C" ? value : "A"
}

const VARIANTS: VariantKey[] = ["A", "B", "C"]
const SCENES: SceneKey[] = [
  "populated",
  "one-ws",
  "empty-org",
  "empty-ws",
  "readonly",
]

export function PrototypeSwitcher(props: {
  variant: VariantKey
  scene: SceneKey
}) {
  const navigate = useNavigate({ from: "/.workspace-ui-prototype" })
  const { variant, scene } = props

  const setVariant = (next: VariantKey) => {
    void navigate({
      search: (prev) => ({ ...prev, variant: next }),
      replace: true,
    })
  }
  const setScene = (next: SceneKey) => {
    void navigate({
      search: (prev) => ({ ...prev, scene: next }),
      replace: true,
    })
  }
  const cycle = (delta: number) => {
    const i = VARIANTS.indexOf(variant)
    setVariant(VARIANTS[(i + delta + VARIANTS.length) % VARIANTS.length])
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target
      if (
        target instanceof HTMLElement &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return
      }
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
      const delta = event.key === "ArrowLeft" ? -1 : 1
      void navigate({
        search: (prev) => {
          const current = parseVariant(prev.variant)
          const i = VARIANTS.indexOf(current)
          return {
            ...prev,
            variant: VARIANTS[(i + delta + VARIANTS.length) % VARIANTS.length],
          }
        },
        replace: true,
      })
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [navigate])

  if (import.meta.env.PROD) return null

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[80] flex justify-center px-3">
      <div className="pointer-events-auto flex max-w-full flex-col items-center gap-2">
        <div className="flex flex-wrap justify-center gap-1 rounded-full border border-amber-400/70 bg-amber-200 px-2 py-1 text-[11px] font-medium text-zinc-900 shadow-lg shadow-black/40">
          {SCENES.map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setScene(key)}
              className={[
                "rounded-full px-2 py-0.5",
                scene === key
                  ? "bg-zinc-900 text-amber-100"
                  : "hover:bg-amber-100",
              ].join(" ")}
            >
              {SCENE_NAMES[key]}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 rounded-full border border-amber-400 bg-amber-300 px-2 py-1 text-sm font-semibold text-zinc-950 shadow-lg shadow-black/50">
          <button
            type="button"
            aria-label="Previous variant"
            onClick={() => cycle(-1)}
            className="rounded-full px-2 py-0.5 hover:bg-amber-200"
          >
            ←
          </button>
          <span className="min-w-48 text-center">
            {variant} — {VARIANT_NAMES[variant]}
          </span>
          <button
            type="button"
            aria-label="Next variant"
            onClick={() => cycle(1)}
            className="rounded-full px-2 py-0.5 hover:bg-amber-200"
          >
            →
          </button>
        </div>
      </div>
    </div>
  )
}
