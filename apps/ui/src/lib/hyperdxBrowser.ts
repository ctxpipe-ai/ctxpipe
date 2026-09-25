import HyperDX from "@hyperdx/browser"
import {
  clearedHyperDxGlobalAttributes,
  type HyperDxGlobalAttributes,
} from "@/lib/hyperdxAttributes"
import { noteHyperDxSessionIdentity } from "@/lib/hyperdxQueryErrors"

/** No-ops until `HyperDX.init` has run (`@hyperdx/otel-web` checks `inited`). */
export function recordHyperDxAction(
  name: string,
  attributes?: Record<string, string>,
): void {
  HyperDX.addAction(name, attributes)
}

export function recordHyperDxException(
  error: unknown,
  attributes?: Record<string, string>,
): void {
  HyperDX.recordException(error, attributes)
}

export function setHyperDxGlobalAttributes(
  attributes: HyperDxGlobalAttributes,
): void {
  HyperDX.setGlobalAttributes(attributes)
  noteHyperDxSessionIdentity("signed-in")
}

export function clearHyperDxGlobalAttributes(): void {
  HyperDX.setGlobalAttributes(clearedHyperDxGlobalAttributes())
  noteHyperDxSessionIdentity("signed-out")
}
