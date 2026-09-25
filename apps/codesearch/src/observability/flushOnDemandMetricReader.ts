import {
  MetricReader,
  type PushMetricExporter,
} from "@opentelemetry/sdk-metrics"

/** Same value as `@opentelemetry/core` `ExportResultCode.SUCCESS`. */
const EXPORT_SUCCESS = 0

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
    // One observable callback can fail without invalidating the rest.
    // Bun 1.3.11 throws from v8.getHeapSpaceStatistics inside runtime-node;
    // throwing here dropped event-loop and HTTP metrics for the whole flush.
    if (resourceMetrics.scopeMetrics.length === 0) {
      if (errors.length > 0) throw errors[0]
      return
    }
    await new Promise<void>((resolve, reject) => {
      this.#exporter.export(resourceMetrics, (result) => {
        if (result.code === EXPORT_SUCCESS) {
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
