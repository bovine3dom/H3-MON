import {encodeQueryState, readQueryOrigins, readQueryState, writeQueryOrigins, writeQueryState} from './query-state.js'
import {queryTitle} from './query-title.js'
import {mostPopulousCityInCell} from './city-label.js'
import {createRequestControls} from './request-controls.js'
import {createURLState} from './url-state.js'

function assert(condition, message = 'Assertion failed') {
    if (!condition) throw new Error(message)
}

Deno.test('titles use raw inputs and select labels, preserving unknown tokens and inserted literals', () => {
    const controls = createRequestControls({
        time: {label: 'Time', type: 'number', default: 360, encode: 'value => value * 60'},
        mode: {label: 'Mode', type: 'select', default: 'rail', options: [{value: 'rail', label: 'Train $& {controls.time}'}]},
        flag: {label: 'Flag', type: 'boolean', default: false},
    })
    const query = {...controls.encode(), lat: 48.8, lng: 362.4, _inputs: controls.values()}
    const lookup = (lat, lng) => {
        assert(lat === 48.8 && Math.abs(lng - 2.4) < 1e-10)
        return {name: 'City {controls.time}'}
    }
    const template = '{controls.time}|{controls.mode}|{controls.flag}|{TOWN_NAME}|{unknown}|{controls.toString}'
    assert(queryTitle(template, query, lookup, controls.schema) ===
        '360|train $& {controls.time}|false|City {controls.time}|{unknown}|{controls.toString}')
    assert(queryTitle('{controls.mode}', query, lookup, controls.schema) === 'Train $& {controls.time}')
    assert(queryTitle('Mode: {controls.mode}', query, lookup, controls.schema) === 'Mode: train $& {controls.time}')
    assert(queryTitle('Done. {controls.mode}', query, lookup, controls.schema) === 'Done. Train $& {controls.time}')
    assert(queryTitle('{TOWN_NAME}', {index: '851fb467fffffff'}, lookup, [], () => [48.8, 2.4]) === 'City {controls.time}')
    assert(query['controls.time'] === '21600' && query._inputs.mode === 'rail')
    assert(queryTitle(template, null, lookup, controls.schema) === template)
    assert(queryTitle('{TOWN_NAME}', query, () => undefined) === '{TOWN_NAME}')
    assert(queryTitle('{controls.mode}', {_inputs: {mode: 'removed'}}, null, controls.schema) === 'removed')
    assert(queryTitle('{lat}|{controls.time}', {lat: NaN, 'controls.time': '21600'}) === '{lat}|{controls.time}')
})

Deno.test('title blocks hide with their controls and can contain static text', () => {
    const controls = createRequestControls({
        metric: {label: 'Metric', type: 'select', default: 'time', options: [
            {value: 'time', label: 'travel time'}, {value: 'population', label: 'population'},
        ]},
        radius: {label: 'Radius', type: 'number', default: 5, showIf: 'values => values.metric === "population"'},
        fallback: {label: 'Fallback', type: 'text', default: 'shown', showIf: '() => { throw new Error("broken") }'},
        window_size: {label: 'Window size', type: 'number', default: 0},
    })
    const query = {...controls.encode(), _inputs: controls.values()}
    assert(queryTitle('{controls.radius}', query, null, controls.schema) === '')
    assert(queryTitle('Reachable{ within {controls.radius} km}', query, null, controls.schema) === 'Reachable')
    assert(queryTitle('{within {controls.metric} and {controls.radius} km}', query, null, controls.schema) === '')
    assert(queryTitle('{controls.metric}', query, null, controls.schema) === 'travel time')
    assert(queryTitle('{controls.fallback}', query, null, controls.schema) === 'shown')
    assert(queryTitle('{until {controls.window_size > 0} hours later}', query, null, controls.schema) === '')

    query._inputs = controls.values({'p.metric': 'population', 'p.window_size': 3})
    assert(queryTitle('{within {controls.radius} km of {controls.metric}}', query, null, controls.schema) === 'within 5 km of population')
    assert(queryTitle('{until {controls.window_size > 0} hours later}', query, null, controls.schema) === 'until hours later')
    assert(queryTitle('{for population {controls.metric == "population"}}', query, null, controls.schema) === 'for population')

    const contexts = {
        client: {values: {aggregation: 'mean', coverage: 'union'}, showIfValues: {originCount: 2}, schema: [
            {key: 'aggregation', type: 'select', showIf: values => values.originCount > 1, options: [
                {value: 'mean', name: 'Mean'}, {value: 'median', name: 'Median'},
            ]},
            {key: 'coverage', type: 'select', showIf: values => values.originCount > 1, options: [
                {value: 'intersection', name: 'Intersection'}, {value: 'union', name: 'Union'},
            ]},
        ]},
        remote: {values: {window_size: 3, aggregation: 'remote value'}, schema: [
            {key: 'window_size', remoteControl: true}, {key: 'aggregation', remoteControl: true},
        ]},
    }
    assert(queryTitle('{client.aggregation}', query, null, controls.schema, undefined, undefined, contexts) === 'Mean')
    assert(queryTitle('Statistic: {client.aggregation}', query, null, controls.schema, undefined, undefined, contexts) === 'Statistic: mean')
    assert(queryTitle('Done. {client.aggregation}', query, null, controls.schema, undefined, undefined, contexts) === 'Done. Mean')
    assert(queryTitle('Using {client.coverage}', query, null, controls.schema, undefined, undefined, contexts) === 'Using union')
    const singleOriginContexts = {...contexts, client: {...contexts.client, showIfValues: {originCount: 1}}}
    assert(queryTitle('Using {client.aggregation}', query, null, controls.schema, undefined, undefined, singleOriginContexts) === 'Using ')
    assert(queryTitle('{with {client.coverage} coverage}', query, null, controls.schema, undefined, undefined, singleOriginContexts) === '')
    assert(queryTitle('{remote.aggregation}', query, null, controls.schema, undefined, undefined, contexts) === 'remote value')
    assert(queryTitle('{remote.window_size}', query, null, controls.schema, undefined, undefined, contexts) === '3')
    assert(queryTitle('{until {remote.window_size > 0} hours later}', query, null, controls.schema, undefined, undefined, contexts) === 'until hours later')
    assert(queryTitle('At {remote.query.lat}', {lat: 48.5}, null, [], undefined, undefined, contexts) === 'At 48.5')
})

Deno.test('multi-origin titles list every town and retain shared control values', () => {
    const query = {index: '851fb467fffffff', _inputs: {time: 360}, origins: [
        {index: '851fb467fffffff'}, {index: '851fb467ffffffe'}, {index: '851fb467ffffffd'},
    ]}
    const lookup = (_lat, lng) => ({name: `Town ${lng}`})
    const latLng = index => [48, Number.parseInt(index.slice(-1), 16)]
    assert(queryTitle('{TOWN_NAME} | {controls.time}', query, lookup, [], latLng) ===
        'Town 15, Town 14, and Town 13 | 360')
    assert(queryTitle('{TOWN_NAME}', query, lookup, [], latLng, index => ({name: `Owned ${index}`})) ===
        'Owned 851fb467fffffff, Owned 851fb467ffffffe, and Owned 851fb467ffffffd')
})

Deno.test('city labels choose the most populous town that belongs to the cell', () => {
    const cities = [
        {name: 'Neighbor city', population: 10000, latitude: 0, longitude: 0.8},
        {name: 'Smaller owner', population: 100, latitude: 0, longitude: 0.1},
        {name: 'Largest owner', population: 1000, latitude: 0, longitude: -0.2},
    ]
    const center = [0, 0]
    const neighbors = [[0, 1], [0, -1], [1, 0]]
    assert(mostPopulousCityInCell(cities, center, neighbors)?.name === 'Largest owner')
})

const query = {event: 'onclick', index: '851fb467fffffff', lat: 48.8, lng: 2.4, zoom: 6, cartogram: [3, 7]}

Deno.test('URL writes throttle without starvation, merge pending edits and cancel on navigation', () => {
    let now = 0, id = 0
    const timers = new Map(), events = {}, writes = []
    const browser = {location: {href: 'https://example.test/?data=sample.csv#x=1'}, performance: {now: () => now},
        setTimeout: (fn, delay) => { timers.set(++id, {fn, at: now + delay}); return id },
        clearTimeout: id => timers.delete(id), addEventListener: (name, fn) => { events[name] = fn },
        history: {state: {}, replaceState: (value, title, href) => {
            assert(value === browser.history.state, 'Preserve history.state identity')
            writes.push([now, href]); browser.location.href = href
        }}}
    const tick = end => {
        while ([...timers.values()].some(timer => timer.at <= end)) {
            const [id, timer] = [...timers].sort((a, b) => a[1].at - b[1].at)[0]
            now = timer.at; timers.delete(id); timer.fn()
        }
        now = end
    }
    const urls = createURLState(browser, 150)
    const edit = fn => { const url = urls.read(); fn(url); urls.replace(url) }
    for (let i = 0; i < 35; i++) {
        tick(i * 10)
        edit(url => writeQueryState(url, {...query, lat: i}))
        edit(url => url.searchParams.set('p.time', String(i)))
        edit(url => url.searchParams.set('colourScale', 'rankit'))
        edit(url => { url.hash = `x=${i}` })
        assert(readQueryState(urls.read().searchParams).lat === i, 'Read latest pending snapshot')
    }
    assert(JSON.stringify(writes.map(([time]) => time)) === '[0,150,300]', 'Immediate and intermediate writes')
    tick(449); assert(writes.length === 3, 'Trailing write waits for 450ms'); tick(450)
    assert(JSON.stringify(writes.map(([, href]) => readQueryState(new URL(href).searchParams).lat)) === '[0,14,29,34]')
    const final = urls.read()
    assert(final.searchParams.get('p.time') === '34' && final.searchParams.get('colourScale') === 'rankit')
    assert(final.searchParams.get('data') === 'sample.csv' && final.hash === '#x=34')
    urls.replace(final); tick(600); assert(writes.length === 4, 'Skip unchanged URLs')
    for (const event of ['read', 'timer', 'popstate', 'hashchange', 'pagehide']) {
        edit(url => url.searchParams.set('prime', event))
        edit(url => url.searchParams.set('stale', '1'))
        browser.history.state = {event}
        if (event !== 'pagehide') browser.location.href = `https://example.test/?navigation=${event}#new`
        const destination = browser.location.href, count = writes.length
        if (event === 'read') assert(urls.read().href === destination); else events[event]?.()
        tick(now + 150)
        assert(writes.length === count && browser.location.href === destination && timers.size === 0, event)
    }
})

Deno.test('saved queries round-trip without replacing controls, data or camera', () => {
    const url = new URL('https://example.test/?data=sample.csv&p.time=360&onmove=false#x=1')
    writeQueryState(url, query)
    assert(url.searchParams.get('query') === 'q2o1f_851fb467fffffff_48.8_2.4_6_3_7')
    assert(JSON.stringify(readQueryState(url.searchParams)) === JSON.stringify(query))
    const legacy = new URL('https://example.test/')
    legacy.searchParams.set('query', JSON.stringify(query))
    assert(JSON.stringify(readQueryState(legacy.searchParams)) === JSON.stringify(query))
    writeQueryState(url, {...query, event: 'onmove'})
    assert(url.searchParams.getAll('query').length === 1)
    const partial = new URL('https://example.test/')
    writeQueryState(partial, {event: 'onmove', index: query.index})
    assert(partial.searchParams.get('query') === 'q2m1_851fb467fffffff')
    assert(JSON.stringify(readQueryState(partial.searchParams)) === JSON.stringify({event: 'onmove', index: query.index}))
    assert(url.searchParams.get('p.time') === '360' && url.searchParams.get('data') === 'sample.csv')
    assert(url.searchParams.get('onmove') === 'false' && url.hash === '#x=1')
    assert(readQueryState(new URLSearchParams()) === null)
})

Deno.test('file-selection queries save and restore without an origin', () => {
    const url = new URL('https://example.test/?data=loads/index.csv&p.layer=max-axle-at-90kmh')
    writeQueryState(url, {event: 'onchange'})
    assert(url.searchParams.get('query') === 'q2c0')
    assert(JSON.stringify(readQueryState(url.searchParams)) === '{"event":"onchange"}')
    assert(url.searchParams.get('p.layer') === 'max-axle-at-90kmh')
})

Deno.test('saved origin sets use bare H3 indexes when possible and read legacy encodings', () => {
    const h3Origins = [
        {event: 'onclick', index: query.index},
        {event: 'onclick', index: '851fb463fffffff'},
    ]
    const h3Url = new URL('https://example.test/')
    writeQueryOrigins(h3Url, h3Origins)
    assert(h3Url.searchParams.get('multiOrigin') === h3Origins.map(origin => origin.index).join('*'))
    assert(JSON.stringify(readQueryOrigins(h3Url.searchParams)) === JSON.stringify(h3Origins))

    const origins = [query, {...query, index: '851fb463fffffff', lat: 48.8, lng: 2.18}]
    const url = new URL('https://example.test/?data=sample.csv')
    writeQueryOrigins(url, origins)
    assert(url.searchParams.getAll('multiOrigin').length === 1)
    assert(url.searchParams.get('multiOrigin').split('*').length === 2)
    assert(JSON.stringify(readQueryOrigins(url.searchParams)) === JSON.stringify(origins))
    const legacy = new URLSearchParams()
    for (const origin of origins) legacy.append('multiOrigin', encodeQueryState(origin))
    assert(JSON.stringify(readQueryOrigins(legacy)) === JSON.stringify(origins))
    let failed = false
    try { writeQueryOrigins(url, [{event: 'onmove', index: query.index}]) } catch { failed = true }
    assert(failed, 'Only on-click origins can be saved')
})

Deno.test('saved queries reject executable strings and malformed geographic state', () => {
    for (const input of ['(() => { throw new Error("executed") })()', '{}', 'q2o2_851fb467fffffff_bad',
        JSON.stringify({...query, lat: 91}), JSON.stringify({...query, event: 'eval'}),
        JSON.stringify({...query, zoom: '6'}), JSON.stringify({...query, cartogram: [1]})]) {
        let error
        try { readQueryState(new URLSearchParams({query: input})) } catch (caught) { error = caught }
        assert(error && error.message !== 'executed', input)
    }
})
