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
  const onLoadRef = useRef(onLoad)
  const onErrorRef = useRef(onError)
  const [isVisible, setIsVisible] = useState(!lazyLoad)

  useEffect(() => {
    onLoadRef.current = onLoad
  }, [onLoad])

  useEffect(() => {
    onErrorRef.current = onError
  }, [onError])

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
        onLoadRef.current?.()
      } catch {
        onErrorRef.current?.()
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
  ])

  return <div ref={containerRef} id={elementId} className={className} style={style} />
}
