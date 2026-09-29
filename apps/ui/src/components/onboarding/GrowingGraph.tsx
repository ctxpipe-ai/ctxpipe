import { useEffect, useRef } from "react"

/**
 * A mocked knowledge graph that grows once over `growMs` (no loop), then
 * twinkles and drifts like the ctxpipe.ai diagram. It is decoration for
 * "ingestion is building your graph", not real data.
 */
export function GrowingGraph({
  nodeCount = 64,
  growMs = 12_000,
  seed = 7,
}: {
  nodeCount?: number
  growMs?: number
  seed?: number
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  // Drawing on a canvas is outside React, so this Effect owns the animation
  // loop and cleans it up.
  useEffect(() => {
    const canvas = canvasRef.current
    const context = canvas?.getContext("2d")
    if (!canvas || !context) return

    const random = mulberry32(seed)
    // Clustered layout in unit space: a few hubs, nodes around them.
    const hubs = Array.from({ length: 5 }, () => ({
      x: 0.15 + random() * 0.7,
      y: 0.2 + random() * 0.6,
    }))
    const nodes = Array.from({ length: nodeCount }, (_, index) => {
      const hub = hubs[index % hubs.length] as { x: number; y: number }
      const angle = random() * Math.PI * 2
      const radius = index < hubs.length ? 0 : 0.04 + random() * 0.2
      return {
        x: clamp(hub.x + Math.cos(angle) * radius, 0.05, 0.95),
        y: clamp(hub.y + Math.sin(angle) * radius * 0.8, 0.08, 0.92),
        size: index < hubs.length ? 2.6 : 1.2 + random() * 1.2,
        phase: random() * Math.PI * 2,
        twinkle: 0,
      }
    })
    // Each node links to its nearest earlier node, sometimes a second one.
    const edges: Array<[number, number]> = []
    for (let index = 1; index < nodes.length; index++) {
      const node = nodes[index] as (typeof nodes)[number]
      const nearest = nodes
        .slice(0, index)
        .map((other, otherIndex) => ({
          otherIndex,
          distance: Math.hypot(other.x - node.x, other.y - node.y),
        }))
        .sort((a, b) => a.distance - b.distance)
      edges.push([index, (nearest[0] as { otherIndex: number }).otherIndex])
      if (nearest[1] && random() < 0.35)
        edges.push([index, nearest[1].otherIndex])
    }

    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches
    let width = 0
    let height = 0
    const resize = () => {
      const ratio = window.devicePixelRatio || 1
      width = canvas.clientWidth
      height = canvas.clientHeight
      canvas.width = Math.round(width * ratio)
      canvas.height = Math.round(height * ratio)
      context.setTransform(ratio, 0, 0, ratio, 0, 0)
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(canvas)

    const start = performance.now()
    let frame = 0
    const draw = (now: number) => {
      const elapsed = reducedMotion ? growMs : now - start
      const grown = Math.min(1, elapsed / growMs)
      // Ease out: quick at first, settling as the graph fills.
      const visible = Math.floor((1 - (1 - grown) ** 2) * nodes.length)
      const settled = grown >= 1
      context.clearRect(0, 0, width, height)

      const position = (node: (typeof nodes)[number]) => {
        const drift = settled && !reducedMotion ? 3 : 0
        const t = now / 1000
        return {
          x: node.x * width + Math.sin(t * 0.35 + node.phase) * drift,
          y: node.y * height + Math.cos(t * 0.3 + node.phase) * drift,
        }
      }

      context.lineWidth = 1
      for (const [a, b] of edges) {
        if (a >= visible || b >= visible) continue
        const from = position(nodes[a] as (typeof nodes)[number])
        const to = position(nodes[b] as (typeof nodes)[number])
        context.strokeStyle = "rgba(64, 224, 208, 0.22)"
        context.beginPath()
        context.moveTo(from.x, from.y)
        context.lineTo(to.x, to.y)
        context.stroke()
      }

      for (let index = 0; index < visible; index++) {
        const node = nodes[index] as (typeof nodes)[number]
        if (settled && !reducedMotion && Math.random() < 0.004) {
          node.twinkle = 1
        }
        node.twinkle *= 0.94
        const { x, y } = position(node)
        const alpha = 0.55 + node.twinkle * 0.45
        if (node.twinkle > 0.05) {
          context.fillStyle = `rgba(64, 224, 208, ${node.twinkle * 0.25})`
          context.beginPath()
          context.arc(x, y, node.size * 3.2, 0, Math.PI * 2)
          context.fill()
        }
        context.fillStyle = `rgba(64, 224, 208, ${alpha})`
        context.beginPath()
        context.arc(x, y, node.size, 0, Math.PI * 2)
        context.fill()
      }

      if (!reducedMotion) frame = requestAnimationFrame(draw)
    }
    frame = requestAnimationFrame(draw)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [nodeCount, growMs, seed])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="pointer-events-none absolute inset-0 h-full w-full"
    />
  )
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

/** Small seeded PRNG so every visit grows the same pleasant layout. */
function mulberry32(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
