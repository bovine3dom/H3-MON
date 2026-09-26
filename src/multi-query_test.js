import {aggregateH3Values, readMultiQueryOptions, writeMultiQueryOptions} from './multi-query.js'
import {SETTINGS_BY_KEY, readSettingLayers, updateUrlSettingOverrides} from './settings.js'

function assert(condition, message = 'Assertion failed') {
    if (!condition) throw new Error(message)
}

function assertEqual(actual, expected, message) {
    assert(Object.is(actual, expected), message || `Expected ${expected}, got ${actual}`)
}

const first = new Map([['a', 1], ['b', 4]])
const second = new Map([['a', 3], ['c', 9]])

Deno.test('multi-query aggregation uses intersection by default', () => {
    const result = aggregateH3Values([first, second])
    assertEqual(result.size, 1)
    assertEqual(result.get('a'), 2)
})

Deno.test('multi-query aggregation supports union and reducers', () => {
    const result = aggregateH3Values([first, second], {coverage: 'union', aggregation: 'max'})
    assertEqual(result.get('a'), 3)
    assertEqual(result.get('b'), 4)
    assertEqual(result.get('c'), 9)
})

Deno.test('multi-query mean, median and quantile use the values for each H3 cell', () => {
    const results = [new Map([['a', 1]]), new Map([['a', 2]]), new Map([['a', 8]]), new Map([['a', 10]])]
    assertEqual(aggregateH3Values(results, {aggregation: 'mean'}).get('a'), 5.25)
    assertEqual(aggregateH3Values(results, {aggregation: 'median'}).get('a'), 5)
    assertEqual(aggregateH3Values(results, {aggregation: 'quantile', quantile: 0.25}).get('a'), 1.75)
})

Deno.test('multi-query aggregation accepts finite values only under union coverage', () => {
    const result = aggregateH3Values([new Map([['a', 1], ['b', NaN]]), new Map([['a', null], ['b', 3]])], {coverage: 'union'})
    assertEqual(result.get('a'), 1)
    assertEqual(result.get('b'), 3)
})

Deno.test('multi-query options round-trip through URL settings', () => {
    const medianURL = new URL('https://example.test/')
    writeMultiQueryOptions(medianURL, {aggregation: 'median'})
    assertEqual(medianURL.searchParams.get('s'), 'v1*3k*o3')
    const url = new URL('https://example.test/?data=sample.csv')
    const options = {aggregation: 'quantile', coverage: 'union', quantile: 0.75, accumulateOnClick: true}
    writeMultiQueryOptions(url, options)
    assert(url.searchParams.has('s'))
    assert(['multiAggregation', 'multiCoverage', 'multiQuantile', 'multiAccumulate'].every(key => !url.searchParams.has(key)))
    assertEqual(JSON.stringify(readMultiQueryOptions(url.searchParams)), JSON.stringify(options))
    const legacy = new URLSearchParams('multiAggregation=quantile&multiCoverage=union&multiQuantile=0.75&multiAccumulate=true')
    assertEqual(JSON.stringify(readMultiQueryOptions(legacy)), JSON.stringify(options))
    const defaults = readMultiQueryOptions(new URLSearchParams())
    assertEqual(defaults.aggregation, 'mean')
    assertEqual(defaults.accumulateOnClick, false)
    writeMultiQueryOptions(url, defaults)
    for (const key of ['multiAggregation', 'multiCoverage', 'multiQuantile', 'multiAccumulate']) {
        assert(!url.searchParams.has(key), `Default ${key} is omitted`)
    }
    assert(!url.searchParams.has('s'))
})

Deno.test('multi-query and application settings share the compact settings field', () => {
    const url = new URL('https://example.test/')
    updateUrlSettingOverrides(url, {colourScale: 'linear'}, [SETTINGS_BY_KEY.get('colourScale')])
    writeMultiQueryOptions(url, {aggregation: 'median', coverage: 'union', quantile: 0.75, accumulateOnClick: true})
    assertEqual(readSettingLayers({}, url.searchParams).settings.colourScale, 'linear')
    assertEqual(readMultiQueryOptions(url.searchParams).aggregation, 'median')
    updateUrlSettingOverrides(url, {colourScale: 'rankit'}, [SETTINGS_BY_KEY.get('colourScale')])
    assertEqual(readMultiQueryOptions(url.searchParams).coverage, 'union')
    assertEqual(readMultiQueryOptions(url.searchParams).quantile, 0.75)
    assertEqual(readMultiQueryOptions(url.searchParams).accumulateOnClick, true)
})

Deno.test('multi-query aggregation validates options', () => {
    for (const options of [{aggregation: 'sum'}, {coverage: 'partial'}, {quantile: 1.1}, {accumulateOnClick: 'yes'}]) {
        let failed = false
        try { aggregateH3Values([first], options) } catch { failed = true }
        assert(failed, `Expected invalid options to fail: ${JSON.stringify(options)}`)
    }
})
