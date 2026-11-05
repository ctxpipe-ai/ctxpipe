import pins from "../../../../scripts/ci/service-pins.json" with { type: "json" }

// The contracts lane includes this file and the pins file in each cache key.
export function contractImage(name: keyof typeof pins.contracts): string {
  const pin = pins.contracts[name]
  return `${pin.image}:${pin.tag}@${pin.digest}`
}
