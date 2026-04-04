import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react"
import { loadUnicornStudio } from "@/lib/unicorn-studio"

type AnimatedBackgroundProps = {
  filePath?: string
  projectId?: string
  fps?: number
  scale?: number
  dpi?: number
  lazyLoad?: boolean
  fixed?: boolean
  disableMobile?: boolean
  production?: boolean
  className?: string
  style?: CSSProperties
  onLoad?: () => void
  onError?: () => void
}

export function AnimatedBackground({
  filePath,
  projectId,
  fps = 60,
  scale = 1,
  dpi = 1.5,
  lazyLoad = true,
  fixed = true,
  disableMobile = false,
  production = false,
  className,
  style,
  onLoad,
  onError,
}: AnimatedBackgroundProps) {
  const rawId = useId()
  const elementId = useMemo(
    () => `unicorn-scene-${rawId.replace(/[^a-zA-Z0-9_-]/g, "")}`,
    [rawId],
  )
  const containerRef = useRef<HTMLDivElement | null>(null)
  const sceneRef = useRef<{ destroy?: () => void; resize?: () => void } | null>(
    null,
  )
  const [isVisible, setIsVisible] = useState(!lazyLoad)

  useEffect(() => {
    if (!lazyLoad) return
    const el = containerRef.current
    if (!el) return

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setIsVisible(true)
          observer.disconnect()
        }
      },
      { rootMargin: "200px 0px" },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [lazyLoad])

  useEffect(() => {
    if (!isVisible) return
    if (!filePath && !projectId) return
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return

    let cancelled = false
    let removeResizeListener: (() => void) | undefined

    const mountScene = async () => {
      try {
        if (filePath) {
          const response = await fetch(filePath, { cache: "no-store" })
          if (!response.ok) throw new Error("Animation JSON failed to load")
          const jsonText = await response.text()
          if (!jsonText.trim()) throw new Error("Animation JSON is empty")
          JSON.parse(jsonText)
        }

        const sdk = await loadUnicornStudio()
        if (cancelled) return

        const scene = await sdk.addScene({
          elementId,
          filePath,
          projectId,
          fps,
          scale,
          dpi,
          lazyLoad: false,
          fixed,
          disableMobile,
          production,
        })

        if (cancelled) {
          scene?.destroy?.()
          return
        }

        sceneRef.current = scene
        const onResize = () => sceneRef.current?.resize?.()
        window.addEventListener("resize", onResize)
        removeResizeListener = () => window.removeEventListener("resize", onResize)
        onLoad?.()
      } catch {
        onError?.()
      }
    }

    void mountScene()

    return () => {
      cancelled = true
      removeResizeListener?.()
      sceneRef.current?.destroy?.()
      sceneRef.current = null
    }
  }, [
    isVisible,
    elementId,
    filePath,
    projectId,
    fps,
    scale,
    dpi,
    fixed,
    disableMobile,
    production,
    onLoad,
    onError,
  ])

  return <div ref={containerRef} id={elementId} className={className} style={style} />
}
