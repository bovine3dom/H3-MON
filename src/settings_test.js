import {
    SETTINGS_BY_KEY,
    colourScale,
    effectiveSettingValue,
    inheritedSettingValue,
    fixedLegendScale,
    leadingThrottleDebounce,
    readSettingLayers,
    updateUrlSettingOverrides,
    validateSettingValue,
} from './settings.js'

function assert(condition, message = 'Assertion failed') {
    if (!condition) throw new Error(message)
}

Deno.test('query settings override metadata with legacy boolean spellings', () => {
    const params = new URLSearchParams('flip=false&raw&trimFactor=0&data=example.arrow')
    const layers = readSettingLayers({flip: true, raw: false, trimFactor: 0.1}, params)

    assert(layers.settings.flip === false)
    assert(layers.settings.raw === true)
    assert(layers.settings.trimFactor === 0)
    assert(layers.settings.data === 'example.arrow')
})

Deno.test('legacy non-JSON setting values retain their old string semantics', () => {
    const layers = readSettingLayers({}, new URLSearchParams('scale={"0":"Low"}&cartogram=false&t='))

    assert(layers.settings.scale === '{"0":"Low"}')
    assert(layers.settings.cartogram === 'false')
    assert(layers.settings.t === '')
})

Deno.test('colour scale schema keeps hidden aliases and validates canonical choices', () => {
    const setting = SETTINGS_BY_KEY.get('colourScale')
    assert(setting.type === 'select' && setting.defaultValue === 'quantile')
    assert(setting.apply === 'immediate' && setting.refresh === 'data')
    for (const key of ['raw', 'linear', 'rankit']) {
        const alias = SETTINGS_BY_KEY.get(key)
        assert(alias.hidden === true && alias.type === 'boolean' && alias.name)
    }
    for (const value of ['quantile', 'rankit', 'linear', 'raw']) assert(validateSettingValue(setting, value) === null)
    for (const value of ['', 'unknown', 'Linear', null]) assert(validateSettingValue(setting, value) !== null)
})

Deno.test('legacy colour scale matrix preserves metadata precedence and every query spelling', () => {
    const setting = SETTINGS_BY_KEY.get('colourScale')
    const keys = ['raw', 'linear', 'rankit']
    const spellings = ['', '1', 'true', 'yes', '0', 'false', 'off', 'no', ' FALSE ']
    for (let mask = 0; mask < 8; mask++) {
        const metadata = Object.fromEntries(keys.map((key, i) => [key, !!(mask & (1 << i))]))
        const expected = keys.find(key => metadata[key]) || 'quantile'
        assert(colourScale(metadata) === expected)
        assert(inheritedSettingValue(metadata, setting) === expected)
        for (const key of keys) for (const spelling of spellings) {
            const enabled = !['0', 'false', 'off', 'no'].includes(spelling.trim().toLowerCase())
            const params = new URLSearchParams({[key]: spelling})
            const before = params.toString()
            const layers = readSettingLayers(metadata, params)
            const merged = {...metadata, [key]: enabled}
            const resolved = keys.find(key => merged[key]) || 'quantile'
            assert(layers.overrides[key] === enabled)
            assert(layers.settings.colourScale === resolved, `${mask}: ${key}=${spelling}`)
            assert(effectiveSettingValue(layers.metadata, layers.overrides, setting) === resolved)
            assert(JSON.stringify(layers.metadata) === JSON.stringify(metadata))
            assert(!Object.hasOwn(layers.overrides, 'colourScale') && params.toString() === before)
        }
    }
    assert(readSettingLayers({}, new URLSearchParams('raw')).settings.colourScale === 'raw')
    assert(colourScale({raw: 'off', linear: 'no', rankit: 'true'}) === 'rankit')
})

Deno.test('canonical and legacy layers resolve without mutating original settings', () => {
    const setting = SETTINGS_BY_KEY.get('colourScale')
    const cases = [
        [{colourScale: 'rankit', raw: true}, '', 'rankit'],
        [{colourScale: 'rankit', raw: true, linear: true}, 'raw=false', 'linear'],
        [{colourScale: 'raw'}, 'linear=off', 'quantile'],
        [{raw: true, linear: true, rankit: true}, 'raw=no&linear=off', 'rankit'],
        [{raw: true, linear: true, rankit: true}, 'raw=0&linear=false&rankit=no', 'quantile'],
        [{colourScale: 'linear', raw: true}, 'colourScale=unknown', 'linear'],
        [{colourScale: 'linear', raw: true}, 'colourScale=unknown&raw=false&rankit', 'rankit'],
        [{colourScale: 'unknown', raw: true}, '', 'raw'],
        [{raw: true}, 'colourScale=unknown', 'raw'],
        [{}, 'colourScale=unknown', 'quantile'],
    ]
    for (const value of ['quantile', 'rankit', 'linear', 'raw']) {
        cases.push([{colourScale: 'raw', raw: true, linear: true}, `colourScale=${value}&raw&linear&rankit`, value])
    }
    for (const [metadata, query, expected] of cases) {
        const original = JSON.stringify(metadata)
        const layers = readSettingLayers(metadata, new URLSearchParams(query))
        assert(layers.settings.colourScale === expected, query)
        assert(effectiveSettingValue(metadata, layers.overrides, setting) === expected, query)
        assert(colourScale(layers.settings) === expected)
        assert(JSON.stringify(metadata) === original && JSON.stringify(layers.metadata) === original)
    }
})

Deno.test('selector edits clear legacy URL overrides while unrelated writes preserve originals', () => {
    const metadata = {colourScale: 'linear', raw: true, rankit: true}
    const original = JSON.stringify(metadata)
    const url = new URL('https://example.test/?raw&linear=OFF&rankit=false&colourScale=unknown&data=a.csv#x=1')
    const layers = readSettingLayers(metadata, url.searchParams)
    updateUrlSettingOverrides(url, {...layers.overrides, t: 'New title'}, [SETTINGS_BY_KEY.get('t')])
    updateUrlSettingOverrides(url, {...layers.overrides, t: 'New title'})
    assert(url.searchParams.get('raw') === '' && url.searchParams.get('linear') === 'OFF')
    assert(url.searchParams.get('rankit') === 'false' && url.searchParams.get('colourScale') === 'unknown')
    const overrides = {...layers.overrides, colourScale: 'quantile'}
    for (const key of ['raw', 'linear', 'rankit']) delete overrides[key]
    updateUrlSettingOverrides(url, overrides, [SETTINGS_BY_KEY.get('colourScale')])
    for (const key of ['raw', 'linear', 'rankit']) assert(!url.searchParams.has(key))
    assert(readSettingLayers(metadata, url.searchParams).settings.colourScale === 'quantile')
    assert(url.searchParams.get('t') === 'New title')
    updateUrlSettingOverrides(url, {})
    assert(url.search === '?data=a.csv' && url.hash === '#x=1')
    assert(readSettingLayers(metadata, url.searchParams).settings.colourScale === 'linear')
    assert(JSON.stringify(metadata) === original)
    const legacyUrl = new URL('https://example.test/?raw&linear=0&rankit=true&colourScale=raw')
    updateUrlSettingOverrides(legacyUrl, {})
    assert(legacyUrl.search === '')
    assert(readSettingLayers({rankit: true}, legacyUrl.searchParams).settings.colourScale === 'rankit')
})

Deno.test('scale overrides round-trip while unrelated URL state is preserved', () => {
    const url = new URL('https://example.test/?data=old.csv&perf&unknown=x#x=1&y=2&z=3')
    updateUrlSettingOverrides(url, {scale: {'0': 'Low', '1': 'High'}, flip: false, defaultValue: null})
    const layers = readSettingLayers({}, url.searchParams)

    assert(layers.settings.scale['0'] === 'Low')
    assert(layers.settings.scale['1'] === 'High')
    assert(layers.settings.flip === false)
    assert(layers.settings.defaultValue === null)
    assert(url.searchParams.get('data') === 'old.csv')
    assert(url.searchParams.has('perf'))
    assert(url.searchParams.get('unknown') === 'x')
    assert(url.hash === '#x=1&y=2&z=3')
})

Deno.test('metadata control schema parses and shares raw input values without losing query state', () => {
    const schema = [{key: 'p.time', name: 'Travel time', type: 'number', min: 0, max: 10080},
        {key: 'p.departure', name: 'Departure', type: 'time'}]
    const url = new URL('https://example.test/?data=reachable.csv&query=saved#x=1&y=2&z=3&b=20&p=30')
    updateUrlSettingOverrides(url, {'p.time': 360, 'p.departure': '09:15'}, schema)
    const layers = readSettingLayers({}, url.searchParams, schema)
    assert(layers.overrides['p.time'] === 360 && layers.overrides['p.departure'] === '09:15')
    assert(url.searchParams.get('query') === 'saved' && url.hash.endsWith('b=20&p=30'))
    assert(validateSettingValue(schema[0], 10081).includes('10080'))
    assert(validateSettingValue(schema[1], '08:00\n') !== null)
    assert(validateSettingValue(schema[0], readSettingLayers({}, new URLSearchParams('p.time=+'), schema).overrides['p.time']) !== null)
})

Deno.test('removing an override reveals metadata again', () => {
    const metadata = {flip: true}
    const overrides = {flip: false}
    assert(effectiveSettingValue(metadata, overrides, SETTINGS_BY_KEY.get('flip')) === false)
    delete overrides.flip
    assert(effectiveSettingValue(metadata, overrides, SETTINGS_BY_KEY.get('flip')) === true)
})

for (const key of ['rankit', 'linear', 'requireCompleteCoverage']) Deno.test(`${key} defaults off and URL overrides metadata in both directions`, () => {
    const setting = SETTINGS_BY_KEY.get(key)
    assert(effectiveSettingValue({}, {}, setting) === false)
    assert(effectiveSettingValue({[key]: true}, {}, setting) === true)
    const url = new URL('https://example.test/?data=test.csv#x=1')
    for (const value of [true, false]) {
        updateUrlSettingOverrides(url, {[key]: value})
        assert(readSettingLayers({[key]: !value}, url.searchParams).settings[key] === value)
        assert(url.searchParams.get(key) === (value ? '1' : '0'))
    }
    assert(url.searchParams.get('data') === 'test.csv' && url.hash === '#x=1')
})

Deno.test('complete coverage applies immediately and preserves missing-value settings', () => {
    const setting = SETTINGS_BY_KEY.get('requireCompleteCoverage')
    assert(setting.name === 'Require complete coverage')
    assert(setting.type === 'boolean' && setting.apply === 'immediate' && setting.refresh === 'data')
    for (const value of ['', '1', 'true', '0', 'false', 'off', 'no']) {
        const layers = readSettingLayers({defaultValue: 0, infill: true}, new URLSearchParams(`requireCompleteCoverage=${value}`))
        assert(layers.settings.requireCompleteCoverage === ['', '1', 'true'].includes(value))
        assert(layers.settings.defaultValue === 0 && layers.settings.infill === true)
    }
    const url = new URL('https://example.test/?requireCompleteCoverage=1&data=test.csv')
    updateUrlSettingOverrides(url, {})
    assert(!url.searchParams.has(setting.key) && url.searchParams.get('data') === 'test.csv')
    assert(effectiveSettingValue({requireCompleteCoverage: true}, {}, setting) === true)
})

Deno.test('crosshair defaults on and metadata can be overridden through shared URLs', () => {
    const setting = SETTINGS_BY_KEY.get('crosshair')
    assert(effectiveSettingValue({}, {}, setting) === true)
    const url = new URL('https://example.test/?onmove=false&query=saved')
    for (const crosshair of [false, true]) {
        updateUrlSettingOverrides(url, {crosshair})
        const layers = readSettingLayers({crosshair: !crosshair}, url.searchParams)
        assert(layers.settings.crosshair === crosshair)
        assert(url.searchParams.get('crosshair') === (crosshair ? '1' : '0'))
        assert(layers.settings.onmove === 'false' && url.searchParams.get('query') === 'saved')
    }
    assert(effectiveSettingValue({crosshair: false}, {}, setting) === false)
})

Deno.test('frozen numeric bounds round-trip and override metadata, including unfreeze', () => {
    const url = new URL('https://example.test/?data=test.csv&query=saved#x=1&y=2&z=3')
    updateUrlSettingOverrides(url, {legendBounds: [-12.345, 987.654]})
    const layers = readSettingLayers({legendBounds: [0, 1]}, url.searchParams)
    assert(JSON.stringify(layers.settings.legendBounds) === '[-12.345,987.654]')
    assert(url.searchParams.get('query') === 'saved' && url.hash === '#x=1&y=2&z=3')
    updateUrlSettingOverrides(url, {legendBounds: null})
    assert(readSettingLayers({legendBounds: [0, 1]}, url.searchParams).settings.legendBounds === null)
    const setting = SETTINGS_BY_KEY.get('legendBounds')
    for (const value of [[2, 1], [0, Infinity], ['0', 1], [], {}, 'bad']) {
        assert(validateSettingValue(setting, value) !== null)
        assert(fixedLegendScale(value) === null)
    }
})

Deno.test('shared frozen/linear scale clamps outliers, preserves missing values and handles constant data', () => {
    const [normalise, value] = fixedLegendScale([10, 110])
    assert(normalise(10) === 0 && normalise(35) === 0.25 && normalise(110) === 1)
    assert(normalise(-10) === 0 && normalise(200) === 1)
    for (const missing of [null, undefined, '', NaN, Infinity]) assert(normalise(missing) === null)
    assert(value(0) === 10 && value(0.25) === 35 && value(1) === 110)
    const [constant, label] = fixedLegendScale([7, 7])
    assert(constant(6) === 0 && constant(7) === 0.5 && constant(8) === 1)
    assert(label(0) === 7 && label(1) === 7)
})

Deno.test('trim factor and scale validation reject malformed values', () => {
    const trim = SETTINGS_BY_KEY.get('trimFactor')
    const scale = SETTINGS_BY_KEY.get('scale')
    assert(validateSettingValue(trim, 0) === null)
    assert(validateSettingValue(trim, 0.5) !== null)
    assert(validateSettingValue(scale, {'0': 'Low', '1': 'High'}) === null)
    assert(validateSettingValue(scale, {nope: 'Low'}) !== null)
})

Deno.test('every setting defines user-facing and application metadata', () => {
    for (const setting of SETTINGS_BY_KEY.values()) {
        assert(setting.name)
        assert(setting.description === undefined || typeof setting.description === 'string')
        assert(['immediate', 'debounce'].includes(setting.apply))
        assert(['render', 'data', 'cartogram'].includes(setting.refresh))
    }
})

Deno.test('throttle-debounce runs first and final alterations', async () => {
    const values = []
    const update = leadingThrottleDebounce(value => values.push(value), 10)
    update('first')
    update('middle')
    update('final')
    assert(values.join(',') === 'first')
    await new Promise(resolve => setTimeout(resolve, 20))
    assert(values.join(',') === 'first,final')
})
