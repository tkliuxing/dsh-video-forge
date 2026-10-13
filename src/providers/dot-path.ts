/**
 * The dotted-path reader and template filler used by the configurable
 * `generic-openai-videos` protocol. A relay's response nesting is not knowable
 * ahead of time, so every field we read out of it is a configured path:
 *
 *   readPath(body, 'data.0.url')      → body.data[0].url
 *   readPath(body, 'output.task_id')  → body.output.task_id
 *
 * Paths are data, never code: a missing or malformed segment yields `undefined`
 * instead of throwing, because a provider that changed its body shape must
 * degrade to "field absent", not crash a paid poll loop.
 */

/** Read one value out of a parsed JSON body by dotted path. */
export function readPath(body: unknown, path: string | null | undefined): unknown {
  if (path === null || path === undefined || path === '') return undefined
  let current: unknown = body
  for (const segment of path.split('.')) {
    if (current === null || current === undefined) return undefined
    if (Array.isArray(current)) {
      const index = Number.parseInt(segment, 10)
      if (!Number.isInteger(index)) return undefined
      current = current[index]
      continue
    }
    if (typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

/** Read one value as a string, or null when absent or not a scalar. */
export function readString(body: unknown, path: string | null | undefined): string | null {
  const value = readPath(body, path)
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return null
}

/**
 * Read one value as a number. Accepts numeric strings, and percentages such as
 * `"42%"`, because relays in the wild report both.
 */
export function readNumber(body: unknown, path: string | null | undefined): number | null {
  const value = readPath(body, path)
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const trimmed = value.trim()
    const percent = /^(-?\d+(?:\.\d+)?)%$/.exec(trimmed)
    if (percent?.[1] !== undefined) return Number.parseFloat(percent[1]) / 100
    const parsed = Number.parseFloat(trimmed)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

/**
 * Fill `{name}` placeholders from a value map. Unknown placeholders are left
 * untouched so a misconfigured path shows up verbatim in the error text.
 */
export function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => values[name] ?? match)
}
