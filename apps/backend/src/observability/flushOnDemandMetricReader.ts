import {
  MetricReader,
  type PushMetricExporter,
} from "@opentelemetry/sdk-metrics"

/** Same value as `@opentelemetry/core` `ExportResultCode.SUCCESS`. */
const EXPORT_SUCCESS = 0

/**
 * Push metrics only on `forceFlush` / shutdown. No periodic timer.
 * Railway PR replicas sleep; a periodic reader would keep them awake.
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

  protected override async onForceFlush(): Promise<void> {
    const { resourceMetrics, errors } = await this.collect()
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
