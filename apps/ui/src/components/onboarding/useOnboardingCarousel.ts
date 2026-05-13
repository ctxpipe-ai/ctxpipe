import { useCallback, useEffect, useRef, useState } from "react"

export function useOnboardingCarousel(slideCount: number) {
  const [currentSlide, setCurrentSlide] = useState(0)
  const [slideKey, setSlideKey] = useState(0)
  const [transitioning, setTransitioning] = useState(false)
  const transitionTimerRef = useRef<number | null>(null)

  useEffect(() => {
    setCurrentSlide((s) =>
      Math.min(s, Math.max(0, slideCount > 0 ? slideCount - 1 : 0)),
    )
  }, [slideCount])

  useEffect(() => {
    return () => {
      if (transitionTimerRef.current !== null) {
        window.clearTimeout(transitionTimerRef.current)
      }
    }
  }, [])

  const goToSlide = useCallback(
    (next: number) => {
      if (
        next === currentSlide ||
        transitioning ||
        next < 0 ||
        next >= slideCount
      )
        return
      setTransitioning(true)
      if (transitionTimerRef.current !== null) {
        window.clearTimeout(transitionTimerRef.current)
      }
      transitionTimerRef.current = window.setTimeout(() => {
        setCurrentSlide(next)
        setSlideKey((k) => k + 1)
        window.requestAnimationFrame(() => setTransitioning(false))
        transitionTimerRef.current = null
      }, 180)
    },
    [currentSlide, transitioning, slideCount],
  )

  return { currentSlide, slideKey, transitioning, goToSlide }
}
