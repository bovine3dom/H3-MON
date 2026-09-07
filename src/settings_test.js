import {
    SETTINGS_BY_KEY,
    effectiveSettingValue,
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

Deno.test('rankit defaults off and URL overrides metadata in both directions', () => {
    const setting = SETTINGS_BY_KEY.get('rankit')
    assert(effectiveSettingValue({}, {}, setting) === false)
    const url = new URL('https://example.test/?data=test.csv#x=1')
    for (const rankit of [true, false]) {
        updateUrlSettingOverrides(url, {rankit})
        assert(readSettingLayers({rankit: !rankit}, url.searchParams).settings.rankit === rankit)
        assert(url.searchParams.get('rankit') === (rankit ? '1' : '0'))
    }
    assert(url.searchParams.get('data') === 'test.csv' && url.hash === '#x=1')
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

Deno.test('frozen scale is linear, clamps outliers, preserves missing values and handles constant data', () => {
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
        assert(['immediate', 'throttle', 'staged'].includes(setting.apply))
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
