import { useCallback, useEffect, useState } from "react"

export function useOnboardingCarousel(slideCount: number) {
  const [currentSlide, setCurrentSlide] = useState(0)

  useEffect(() => {
    setCurrentSlide((s) =>
      Math.min(s, Math.max(0, slideCount > 0 ? slideCount - 1 : 0)),
    )
  }, [slideCount])

  const goToSlide = useCallback(
    (next: number) => {
      if (next < 0 || next >= slideCount) return
      setCurrentSlide(next)
    },
    [slideCount],
  )

  return { currentSlide, goToSlide }
}
