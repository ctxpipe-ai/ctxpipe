import { ExportResultCode } from "@opentelemetry/core"
import {
  MetricReader,
  type PushMetricExporter,
} from "@opentelemetry/sdk-metrics"

/**
 * Push metrics only on `forceFlush` / shutdown. No periodic timer.
 * Use on Railway Serverless PR replicas so idle containers can sleep.
 */
export class FlushOnDemandMetricReader extends MetricReader {
  readonly #exporter: PushMetricExporter

  constructor(exporter: PushMetricExporter) {
    super({
      aggregationSelector: exporter.selectAggregation?.bind(exporter),
      aggregationTemporalitySelector:
        exporter.selectAggregationTemporality?.bind(exporter),
    })
    this.#exporter = exporter
  }

  protected override onInitialized(): void {
    // Intentionally no setInterval — production uses PeriodicExportingMetricReader.
  }

  protected override async onForceFlush(): Promise<void> {
    const { resourceMetrics, errors } = await this.collect()
    if (errors.length > 0) {
      throw errors[0]
    }
    if (resourceMetrics.scopeMetrics.length === 0) return
    await new Promise<void>((resolve, reject) => {
      this.#exporter.export(resourceMetrics, (result) => {
        if (result.code === ExportResultCode.SUCCESS) {
          resolve()
          return
        }
        reject(result.error ?? new Error("metrics export failed"))
      })
    })
    await this.#exporter.forceFlush()
  }

  protected override async onShutdown(): Promise<void> {
    await this.onForceFlush()
    await this.#exporter.shutdown()
  }
}
