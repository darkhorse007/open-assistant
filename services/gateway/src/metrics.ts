type LabelValues = Record<string, string | number | boolean | undefined>

function escapeLabelValue(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"')
}

function normalizeLabels(labels: LabelValues | undefined) {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(labels ?? {})) {
    if (v === undefined) continue
    out[k] = typeof v === "string" ? v : String(v)
  }
  const keys = Object.keys(out).sort()
  return { labels: out, keys }
}

function formatLabels(labels: Record<string, string>, keys: string[]) {
  if (!keys.length) return ""
  const parts = keys.map((k) => `${k}="${escapeLabelValue(labels[k] ?? "")}"`)
  return `{${parts.join(",")}}`
}

type MetricType = "counter" | "gauge" | "histogram"

type MetricBase = {
  name: string
  help: string
  type: MetricType
}

type CounterMetric = MetricBase & {
  type: "counter"
  values: Map<string, number>
}

type GaugeMetric = MetricBase & {
  type: "gauge"
  values: Map<string, number>
}

type HistogramMetric = MetricBase & {
  type: "histogram"
  buckets: number[]
  // For each label-key: bucketCounts[i], sum, count.
  values: Map<
    string,
    {
      bucketCounts: number[]
      sum: number
      count: number
    }
  >
}

type Metric = CounterMetric | GaugeMetric | HistogramMetric

export class MetricsRegistry {
  private metrics = new Map<string, Metric>()

  counter(name: string, help: string) {
    const existing = this.metrics.get(name)
    if (existing) {
      if (existing.type !== "counter") throw new Error(`Metric ${name} already registered with type ${existing.type}`)
      return {
        inc: (labels?: LabelValues, value = 1) => {
          const { labels: l, keys } = normalizeLabels(labels)
          const key = formatLabels(l, keys)
          existing.values.set(key, (existing.values.get(key) ?? 0) + value)
        },
      }
    }

    const metric: CounterMetric = { name, help, type: "counter", values: new Map() }
    this.metrics.set(name, metric)
    return {
      inc: (labels?: LabelValues, value = 1) => {
        const { labels: l, keys } = normalizeLabels(labels)
        const key = formatLabels(l, keys)
        metric.values.set(key, (metric.values.get(key) ?? 0) + value)
      },
    }
  }

  gauge(name: string, help: string) {
    const existing = this.metrics.get(name)
    if (existing) {
      if (existing.type !== "gauge") throw new Error(`Metric ${name} already registered with type ${existing.type}`)
      return {
        set: (labels: LabelValues | undefined, value: number) => {
          const { labels: l, keys } = normalizeLabels(labels)
          const key = formatLabels(l, keys)
          existing.values.set(key, value)
        },
      }
    }

    const metric: GaugeMetric = { name, help, type: "gauge", values: new Map() }
    this.metrics.set(name, metric)
    return {
      set: (labels: LabelValues | undefined, value: number) => {
        const { labels: l, keys } = normalizeLabels(labels)
        const key = formatLabels(l, keys)
        metric.values.set(key, value)
      },
    }
  }

  histogram(name: string, help: string, buckets: number[]) {
    const normalizedBuckets = [...buckets].sort((a, b) => a - b)

    const existing = this.metrics.get(name)
    if (existing) {
      if (existing.type !== "histogram") throw new Error(`Metric ${name} already registered with type ${existing.type}`)
      return {
        observe: (labels: LabelValues | undefined, value: number) => {
          const { labels: l, keys } = normalizeLabels(labels)
          const key = formatLabels(l, keys)
          let state = existing.values.get(key)
          if (!state) {
            state = { bucketCounts: new Array(existing.buckets.length).fill(0), sum: 0, count: 0 }
            existing.values.set(key, state)
          }
	          state.sum += value
	          state.count += 1
	          for (let i = 0; i < existing.buckets.length; i++) {
	            if (value <= existing.buckets[i]!) state.bucketCounts[i] = (state.bucketCounts[i] ?? 0) + 1
	          }
	        },
	      }
	    }

    const metric: HistogramMetric = { name, help, type: "histogram", buckets: normalizedBuckets, values: new Map() }
    this.metrics.set(name, metric)

    return {
      observe: (labels: LabelValues | undefined, value: number) => {
        const { labels: l, keys } = normalizeLabels(labels)
        const key = formatLabels(l, keys)
        let state = metric.values.get(key)
        if (!state) {
          state = { bucketCounts: new Array(metric.buckets.length).fill(0), sum: 0, count: 0 }
          metric.values.set(key, state)
        }
	        state.sum += value
	        state.count += 1
	        for (let i = 0; i < metric.buckets.length; i++) {
	          if (value <= metric.buckets[i]!) state.bucketCounts[i] = (state.bucketCounts[i] ?? 0) + 1
	        }
	      },
	    }
	  }

  renderPrometheus() {
    const lines: string[] = []

    const metrics = [...this.metrics.values()].sort((a, b) => a.name.localeCompare(b.name))
    for (const metric of metrics) {
      lines.push(`# HELP ${metric.name} ${metric.help}`)
      lines.push(`# TYPE ${metric.name} ${metric.type}`)

      if (metric.type === "counter" || metric.type === "gauge") {
        const entries = [...metric.values.entries()].sort((a, b) => a[0].localeCompare(b[0]))
        for (const [labelKey, value] of entries) {
          lines.push(`${metric.name}${labelKey} ${value}`)
        }
        continue
      }

      const buckets = metric.buckets
      const entries = [...metric.values.entries()].sort((a, b) => a[0].localeCompare(b[0]))
      for (const [labelKey, state] of entries) {
        for (let i = 0; i < buckets.length; i++) {
          const le = buckets[i]!
          const suffix = labelKey ? `${labelKey.slice(0, -1)},le="${le}"}` : `{le="${le}"}`
          lines.push(`${metric.name}_bucket${suffix} ${state.bucketCounts[i] ?? 0}`)
        }
        {
          const suffix = labelKey ? `${labelKey.slice(0, -1)},le="+Inf"}` : `{le="+Inf"}`
          lines.push(`${metric.name}_bucket${suffix} ${state.count}`)
        }
        lines.push(`${metric.name}_sum${labelKey} ${state.sum}`)
        lines.push(`${metric.name}_count${labelKey} ${state.count}`)
      }
    }

    lines.push("")
    return lines.join("\n")
  }
}
