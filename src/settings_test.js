import {
    SETTINGS_BY_KEY, colourScale, effectiveSettingValue, fixedLegendScale,
    readSettingLayers, updateUrlSettingOverrides, validateSettingValue,
} from './settings.js'

function assert(condition, message = 'Assertion failed') {
    if (!condition) throw new Error(message)
}

Deno.test('legacy colour aliases and canonical precedence survive shared URLs', () => {
    const setting = SETTINGS_BY_KEY.get('colourScale')
    assert(setting.type === 'select')
    for (const key of ['raw', 'linear', 'rankit']) {
        assert(SETTINGS_BY_KEY.get(key).type === 'boolean')
        assert(readSettingLayers({}, new URLSearchParams(key)).settings.colourScale === key)
        assert(readSettingLayers({[key]: true}, new URLSearchParams(`${key}=false`)).settings.colourScale === 'quantile')
    }
    const cases = [
        [{raw: true, linear: true, rankit: true}, '', 'raw'],
        [{raw: true, linear: true, rankit: true}, 'raw=no&linear=off', 'rankit'],
        [{colourScale: 'rankit', raw: true}, '', 'rankit'],
        [{colourScale: 'rankit', raw: true, linear: true}, 'raw=0', 'linear'],
        [{raw: true}, 'colourScale=linear&raw&rankit', 'linear'],
        [{colourScale: 'linear'}, 'colourScale=unknown', 'linear'],
    ]
    for (const [metadata, query, expected] of cases) {
        const original = JSON.stringify(metadata)
        const layers = readSettingLayers(metadata, new URLSearchParams(query))
        assert(colourScale(layers.settings) === expected, query)
        assert(effectiveSettingValue(metadata, layers.overrides, setting) === expected, query)
        assert(JSON.stringify(metadata) === original)
    }
})

Deno.test('subset URL writes preserve unrelated state and selector edits clear aliases', () => {
    const url = new URL('https://example.test/?raw&linear=OFF&rankit=false&data=a.csv&query=saved#x=1')
    updateUrlSettingOverrides(url, {t: 'New title'}, [SETTINGS_BY_KEY.get('t')])
    assert(url.searchParams.get('raw') === '' && url.searchParams.get('linear') === 'OFF')
    assert(url.searchParams.get('rankit') === 'false')
    updateUrlSettingOverrides(url, {colourScale: 'quantile'}, [SETTINGS_BY_KEY.get('colourScale')])
    for (const key of ['raw', 'linear', 'rankit']) assert(!url.searchParams.has(key))
    assert(readSettingLayers({raw: true}, url.searchParams).settings.colourScale === 'quantile')
    assert(url.searchParams.get('t') === 'New title')
    updateUrlSettingOverrides(url, {})
    assert(url.search === '?data=a.csv&query=saved' && url.hash === '#x=1')
    assert(readSettingLayers({rankit: true}, url.searchParams).settings.colourScale === 'rankit')
})

Deno.test('typed settings round-trip while legacy strings retain their meaning', () => {
    const url = new URL('https://example.test/?cartogram=false&scale={}&t=')
    const legacy = readSettingLayers({}, url.searchParams).settings
    assert(legacy.cartogram === 'false' && legacy.scale === '{}' && legacy.t === '')
    const overrides = {scale: {'0': 'Low'}, flip: false, defaultValue: null, legendBounds: [-2, 9], crosshair: false, requireCompleteCoverage: true}
    updateUrlSettingOverrides(url, overrides)
    const settings = readSettingLayers({flip: true, crosshair: true}, url.searchParams).settings
    for (const [key, value] of Object.entries(overrides)) assert(JSON.stringify(settings[key]) === JSON.stringify(value), key)
    updateUrlSettingOverrides(url, {legendBounds: null})
    assert(readSettingLayers({legendBounds: [0, 1]}, url.searchParams).settings.legendBounds === null)
    const schema = [{key: 'p.time', name: 'Time', type: 'number'}]
    updateUrlSettingOverrides(url, {'p.time': 30}, schema)
    assert(readSettingLayers({}, url.searchParams, schema).overrides['p.time'] === 30)
})

Deno.test('validation and fixed scales preserve bounds, missing values and inverse units', () => {
    for (const [key, good, bad] of [
        ['colourScale', 'rankit', 'unknown'], ['trimFactor', 0, 0.5],
        ['scale', {'0': 'Low'}, {nope: 'Low'}], ['legendBounds', [0, 1], [2, 1]],
    ]) {
        assert(validateSettingValue(SETTINGS_BY_KEY.get(key), good) === null)
        assert(validateSettingValue(SETTINGS_BY_KEY.get(key), bad) !== null)
    }
    const [normalise, value] = fixedLegendScale([10, 110])
    assert(normalise(-10) === 0 && normalise(200) === 1)
    assert(normalise(35) === 0.25 && value(0.25) === 35)
    for (const missing of [null, '', NaN, Infinity]) assert(normalise(missing) === null)
    assert(fixedLegendScale([0, Infinity]) === null)
    const [constant, label] = fixedLegendScale([7, 7])
    assert(constant(7) === 0.5 && label(0) === 7 && label(1) === 7)
})
