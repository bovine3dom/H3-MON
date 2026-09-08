import {readQueryState, writeQueryState} from './query-state.js'
import {queryTitle} from './query-title.js'
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
        '360|Train $& {controls.time}|false|City {controls.time}|{unknown}|{controls.toString}')
    assert(query['controls.time'] === '21600' && query._inputs.mode === 'rail')
    assert(queryTitle(template, null, lookup, controls.schema) === template)
    assert(queryTitle('{TOWN_NAME}', query, () => undefined) === '{TOWN_NAME}')
    assert(queryTitle('{controls.mode}', {_inputs: {mode: 'removed'}}, null, controls.schema) === 'removed')
    assert(queryTitle('{lat}|{controls.time}', {lat: NaN, 'controls.time': '21600'}) === '{lat}|{controls.time}')
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
    assert(JSON.stringify(readQueryState(url.searchParams)) === JSON.stringify(query))
    writeQueryState(url, {...query, event: 'onmove'})
    assert(url.searchParams.getAll('query').length === 1)
    assert(url.searchParams.get('p.time') === '360' && url.searchParams.get('data') === 'sample.csv')
    assert(url.searchParams.get('onmove') === 'false' && url.hash === '#x=1')
    assert(readQueryState(new URLSearchParams()) === null)
})

Deno.test('saved queries reject executable strings and malformed geographic state', () => {
    for (const input of ['(() => { throw new Error("executed") })()', '{}',
        JSON.stringify({...query, lat: 91}), JSON.stringify({...query, event: 'eval'}),
        JSON.stringify({...query, zoom: '6'}), JSON.stringify({...query, cartogram: [1]})]) {
        let error
        try { readQueryState(new URLSearchParams({query: input})) } catch (caught) { error = caught }
        assert(error && error.message !== 'executed', input)
    }
})
