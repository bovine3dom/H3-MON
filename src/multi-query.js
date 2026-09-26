import {MULTI_QUERY_SETTING_OPTIONS, readCompactSettingOverrides, writeCompactSettingOverrides} from './settings.js'

export const MULTI_QUERY_DEFAULTS = Object.freeze({aggregation: 'mean', coverage: 'intersection', quantile: 0.5, accumulateOnClick: false})
const AGGREGATIONS = new Set(MULTI_QUERY_SETTING_OPTIONS.aggregation)
const COVERAGES = new Set(MULTI_QUERY_SETTING_OPTIONS.coverage)

export function validateMultiQueryOptions(options = {}) {
    const {aggregation = MULTI_QUERY_DEFAULTS.aggregation, coverage = MULTI_QUERY_DEFAULTS.coverage,
        quantile = MULTI_QUERY_DEFAULTS.quantile, accumulateOnClick = MULTI_QUERY_DEFAULTS.accumulateOnClick} = options
    if (!AGGREGATIONS.has(aggregation)) throw new Error('Unsupported multi-query aggregation')
    if (!COVERAGES.has(coverage)) throw new Error('Unsupported multi-query coverage')
    if (!Number.isFinite(quantile) || quantile < 0 || quantile > 1) throw new Error('Quantile must be between 0 and 1')
    if (typeof accumulateOnClick !== 'boolean') throw new Error('Accumulate on click must be a boolean')
    return {aggregation, coverage, quantile, accumulateOnClick}
}

export function readMultiQueryOptions(searchParams) {
    const compact = readCompactSettingOverrides(searchParams)
    const read = (key, fallback) => {
        const values = searchParams.getAll(key)
        if (values.length > 1) throw new Error(`Duplicate ${key} setting`)
        return values.length ? values[0] : compact.get(key) ?? fallback
    }
    const quantile = read('multiQuantile', MULTI_QUERY_DEFAULTS.quantile)
    const accumulate = read('multiAccumulate', MULTI_QUERY_DEFAULTS.accumulateOnClick)
    const accumulateOnClick = typeof accumulate === 'boolean' ? accumulate
        : accumulate === 'true' ? true : accumulate === 'false' ? false : null
    if (accumulateOnClick === null) throw new Error('Invalid multiAccumulate setting')
    return validateMultiQueryOptions({
        accumulateOnClick,
        aggregation: read('multiAggregation', MULTI_QUERY_DEFAULTS.aggregation),
        coverage: read('multiCoverage', MULTI_QUERY_DEFAULTS.coverage),
        quantile: quantile === '' ? NaN : Number(quantile),
    })
}

export function writeMultiQueryOptions(url, options) {
    const values = validateMultiQueryOptions(options)
    for (const key of ['multiAggregation', 'multiCoverage', 'multiQuantile', 'multiAccumulate']) url.searchParams.delete(key)
    return writeCompactSettingOverrides(url, {
        multiAggregation: values.aggregation === MULTI_QUERY_DEFAULTS.aggregation ? undefined : values.aggregation,
        multiCoverage: values.coverage === MULTI_QUERY_DEFAULTS.coverage ? undefined : values.coverage,
        multiQuantile: values.quantile === MULTI_QUERY_DEFAULTS.quantile ? undefined : values.quantile,
        multiAccumulate: values.accumulateOnClick === MULTI_QUERY_DEFAULTS.accumulateOnClick ? undefined : values.accumulateOnClick,
    })
}

function statistic(values, aggregation, quantile) {
    if (aggregation === 'min') return values.reduce((best, value) => Math.min(best, value), Infinity)
    if (aggregation === 'max') return values.reduce((best, value) => Math.max(best, value), -Infinity)
    if (aggregation === 'mean') return values.reduce((sum, value) => sum + value, 0) / values.length
    const sorted = [...values].sort((a, b) => a - b)
    if (aggregation === 'median') return quantileValue(sorted, 0.5)
    return quantileValue(sorted, quantile)
}

function quantileValue(sorted, quantile) {
    const position = (sorted.length - 1) * quantile
    const lower = Math.floor(position)
    const fraction = position - lower
    return sorted[lower] + (sorted[Math.min(lower + 1, sorted.length - 1)] - sorted[lower]) * fraction
}

export function aggregateH3Values(results, options = {}) {
    if (!Array.isArray(results)) throw new TypeError('Multi-query results must be an array')
    const {aggregation, coverage, quantile} = validateMultiQueryOptions(options)
    if (!results.length) return new Map()
    if (results.some(result => !(result instanceof Map))) throw new TypeError('Each multi-query result must be a Map')

    const keys = new Set(results[0].keys())
    if (coverage === 'intersection') {
        for (const result of results.slice(1)) for (const key of keys) if (!result.has(key)) keys.delete(key)
    } else {
        for (const result of results.slice(1)) for (const key of result.keys()) keys.add(key)
    }

    const output = new Map()
    for (const key of keys) {
        const values = results.map(result => result.get(key)).filter(Number.isFinite)
        if (!values.length || coverage === 'intersection' && values.length !== results.length) continue
        output.set(key, statistic(values, aggregation, quantile))
    }
    return output
}
