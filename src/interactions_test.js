import {centralLinkedH3, createInteractions} from './interactions.js'

function assert(condition, message = 'Assertion failed') {
    if (!condition) throw new Error(message)
}

const delay = (wait = 25) => new Promise(resolve => setTimeout(resolve, wait))

Deno.test('cartogram origin is central, deterministic, and one of the linked cells', () => {
    const points = {left: [0, -1], middle: [0, 0], right: [0, 1]}
    assert(centralLinkedH3(Object.keys(points), key => points[key]) === 'middle')
    assert(centralLinkedH3(['right', 'left', 'middle', 'left'], key => points[key]) === 'middle')
    assert(centralLinkedH3([], key => points[key]) === null)
    assert(centralLinkedH3(['left'], key => points[key]) === 'left')
    assert(centralLinkedH3(['b', 'a'], () => [0, 0]) === 'a')
    const dateline = {east: [0, 179], west: [0, -179], distant: [0, 0]}
    assert(centralLinkedH3(Object.keys(dateline), key => dateline[key]) !== 'distant')
})

Deno.test('disabling default actions leaves the click request intact', async () => {
    let calls = 0
    for (const defaultAction of [undefined, true, false]) {
        const interactions = createInteractions({
            getSettings: () => ({onclick: {url: '/{index}', defaultAction}}),
            getValues: (config, point) => { assert(config.defaultAction === (defaultAction ?? true)); return point },
            request: async () => { calls++; return true }, baseURL: 'https://example.test',
        })
        assert(await interactions.click({index: '851fb467fffffff'}))
    }
    assert(calls === 3)
    const errors = []
    const interactions = createInteractions({
        getSettings: () => ({onclick: {url: '/x', defaultAction: 'false'}}), getValues: () => ({}),
        request: async () => { calls++ }, onError: error => errors.push(error), baseURL: 'https://example.test',
    })
    assert(await interactions.click({}) === false && errors.length === 1 && calls === 3)
})

Deno.test('explicit replay uses metadata, carries context, and can deduplicate parameter edits', async () => {
    const calls = []
    const metadata = {onmove: {url: '/reachable?index={index}&budget_s={controls.time}'}}
    let minutes = 180
    const interactions = createInteractions({
        getSettings: () => ({onmove: false}), getReplaySettings: () => metadata,
        getValues: (_config, point) => ({index: point.index, 'controls.time': String(minutes * 60)}),
        request: async (url, context) => { calls.push({url, context}); return true },
        baseURL: 'https://example.test',
    })
    const point = {index: '851fb467fffffff', lat: 48.8, lng: 2.4}
    interactions.move(point)
    assert(calls.length === 0)
    assert(await interactions.replay('onmove', point))
    assert(calls[0].context.event === 'onmove' && calls[0].context.point.index === point.index)
    point.lat = 10
    assert(calls[0].context.point.lat === 48.8)
    await interactions.replay('onmove', point, {force: false})
    assert(calls.length === 1)
    minutes = 360
    await interactions.replay('onmove', point, {force: false})
    assert(calls.length === 2 && new URL(calls[1].url).searchParams.get('budget_s') === '21600')
    await interactions.retry()
    assert(calls.length === 3)
    interactions.cancel()
})

Deno.test('disabled movement cannot replace the click selected for Retry', async () => {
    const calls = []
    const interactions = createInteractions({
        getSettings: () => ({onclick: {url: '/{index}'}}), getValues: (_config, point) => point,
        request: async url => { calls.push(url); return false }, baseURL: 'https://example.test',
    })
    await interactions.click({index: 'clicked'})
    interactions.move({index: 'unconfigured-move'})
    await interactions.retry()
    assert(calls.join(',') === 'https://example.test/clicked,https://example.test/clicked')
})

function setup(settings = {}, options = {}) {
    const calls = []
    const errors = []
    const interactions = createInteractions({
        getSettings: () => settings,
        getValues: (_config, point) => point,
        request: async url => { calls.push(url); return true },
        onError: error => errors.push(error),
        baseURL: 'https://example.test/maps/index.html',
        ...options,
    })
    return {...interactions, calls, errors}
}

Deno.test('missing and disabled interaction metadata leaves static behaviour alone', () => {
    for (const value of [undefined, null, false, 'false', '0', 'off', 'no', ' FALSE ', 'Off']) {
        const interactions = setup({onclick: value, onmove: value}, {
            getValues: () => { throw new Error('Disabled interactions must not read values') },
        })
        interactions.click({})
        interactions.move({})
        assert(interactions.calls.length === 0)
        assert(interactions.errors.length === 0)
        interactions.cancel()
    }
    const interactions = setup(undefined, {getSettings: () => undefined})
    interactions.click({})
    interactions.move({})
    assert(interactions.errors.length === 0)
})

Deno.test('invalid interaction metadata reports errors without throwing from events', () => {
    const invalid = [true, 0, 1, '', 'true', '/endpoint', '() => fetch("/endpoint")', [], {}, {url: 1}, {url: ' '},
        ...[-1, 16, 1.5, '5', null, NaN, Infinity].map(resolution => ({url: '/endpoint', resolution})),
        ...[-1, 60001, '10', null, NaN, Infinity].map(wait => ({url: '/endpoint', wait})),
    ]
    for (const value of invalid) {
        const interactions = setup({onclick: value, onmove: value})
        interactions.click({})
        interactions.move({})
        assert(interactions.calls.length === 0)
        assert(interactions.errors.length === 2, `Expected both events to reject ${JSON.stringify(value)}`)
        interactions.cancel()
    }
})

Deno.test('templates encode values and preserve endpoint queries and unsigned H3 split words', () => {
    const index = '8a2a1072b59ffff'
    const index_lower = 0x2b59ffff
    const index_upper = 0x08a2a107
    assert((BigInt(index_upper) << 32n | BigInt(index_lower)).toString(16) === index)
    const interactions = setup({onclick: {
        url: '../reach.arrow?budget=1800&departure=08%3A30&index={index}&lower={index_lower}&upper={index_upper}&lat={lat}&lng={lng}&zoom={zoom}&again={index}',
        resolution: 15,
        wait: 60000,
    }})
    interactions.click({index, index_lower, index_upper, lat: 51.5, lng: -0.1, zoom: 12})
    const url = new URL(interactions.calls[0])
    assert(url.pathname === '/reach.arrow')
    assert(url.searchParams.get('budget') === '1800')
    assert(url.searchParams.get('departure') === '08:30')
    assert(url.searchParams.get('index') === index && url.searchParams.get('again') === index)
    assert(url.searchParams.get('lower') === String(index_lower))
    assert(url.searchParams.get('upper') === String(index_upper))
    assert(url.searchParams.get('lat') === '51.5' && url.searchParams.get('lng') === '-0.1')
    assert(url.searchParams.get('zoom') === '12')
    assert(url.search.includes('departure=08%3A30') && !url.searchParams.has('v'))

    interactions.click({index: 'a/b ?&=#{}', index_lower: 4294967295, index_upper: 2147483648, lat: 0, lng: 0, zoom: 0})
    const encoded = new URL(interactions.calls[1])
    assert(encoded.search.includes('index=a%2Fb%20%3F%26%3D%23%7B%7D'))
    assert(encoded.searchParams.get('lower') === '4294967295')
    assert(encoded.searchParams.get('upper') === '2147483648')
    assert(interactions.errors.length === 0)
})

Deno.test('unsafe URLs and malformed or unavailable template tokens are rejected', () => {
    const invalid = ['javascript:alert(1)', 'data:text/plain,hello', 'file:///tmp/data', 'ftp://example.test/data',
        'https://user:pass@example.test/data', 'https://user@example.test/data', '//user@example.test/data',
        'https://[broken', '/{unknown}', '/{constructor}', '/{__proto__}', '/{toString}', '/{}', '/{{lat}}', '/{lat', '/lat}',
    ]
    for (const url of invalid) {
        const interactions = setup({onclick: {url}})
        interactions.click({lat: 1, unknown: 'provided'})
        assert(interactions.calls.length === 0, url)
        assert(interactions.errors.length === 1, url)
    }
    for (const values of [{}, Object.create({lat: 1}), {lat: undefined}, {lat: null}, {lat: NaN}, {lat: Infinity}, {lat: -Infinity}, {lat: {}}, {lat: () => 1}]) {
        const interactions = setup({onclick: {url: '/{lat}'}})
        interactions.click(values)
        assert(interactions.calls.length === 0)
        assert(interactions.errors.length === 1)
    }
})

Deno.test('getValues receives configuration and event point and can defer until data loads', () => {
    const point = {lat: 1, lng: 2, zoom: 3}
    let loaded = false
    const interactions = setup({onclick: {url: 'http://example.test/{index}', resolution: 0}}, {
        getValues: (config, received) => {
            assert(config.resolution === 0 && received === point)
            return loaded ? {index: 'cell'} : null
        },
    })
    interactions.click(point)
    assert(interactions.calls.length === 0 && interactions.errors.length === 0)
    loaded = true
    interactions.click(point)
    interactions.click(point)
    assert(interactions.calls.join(',') === 'http://example.test/cell,http://example.test/cell')
})

Deno.test('moves deliver immediately and capture only the latest trailing event URL', async () => {
    let reads = 0
    const interactions = setup({onmove: {url: '/{lat}/{lng}/{zoom}', wait: 10}}, {
        getValues: (_config, point) => { reads++; return point },
    })
    const point = {lat: 1, lng: 2, zoom: 3}
    interactions.move(point)
    point.lat = 4
    interactions.move(point)
    point.zoom = 5
    interactions.move(point)
    point.lng = 99
    assert(interactions.calls.join(',') === 'https://example.test/1/2/3')
    await delay()
    assert(interactions.calls.join(',') === 'https://example.test/1/2/3,https://example.test/4/2/5')
    assert(reads === 3)
    interactions.cancel()
})

Deno.test('moves use the default 350ms wait and skip requests until values are available', async () => {
    const interactions = setup({onmove: {url: '/{index}'}})
    interactions.move(null)
    assert(interactions.calls.length === 0 && interactions.errors.length === 0)
    interactions.move({index: 'first'})
    interactions.move({index: 'trailing'})
    await delay()
    assert(interactions.calls.length === 1)
    await delay(350)
    assert(interactions.calls.join(',') === 'https://example.test/first,https://example.test/trailing')
    interactions.cancel()
})

Deno.test('moves deduplicate URLs across pans and zooms while clicks always refresh', async () => {
    const config = {url: '/{index}', wait: 10}
    const interactions = setup({onmove: config, onclick: config})
    interactions.move({index: 'same', lat: 1, zoom: 2})
    interactions.move({index: 'same', lat: 3, zoom: 4})
    await delay()
    interactions.move({index: 'same', lat: 5, zoom: 6})
    assert(interactions.calls.length === 1)
    interactions.click({index: 'same'})
    interactions.click({index: 'same'})
    assert(interactions.calls.length === 3)
    interactions.cancel()
})

Deno.test('configured clicks cancel older trailing moves but disabled clicks do not', async () => {
    const settings = {onmove: {url: '/{index}', wait: 10}, onclick: 'off'}
    const interactions = setup(settings)
    interactions.move({index: 'first'})
    interactions.move({index: 'pending'})
    interactions.click({index: 'ignored'})
    await delay()
    assert(interactions.calls.length === 2)
    interactions.move({index: 'second'})
    interactions.move({index: 'obsolete'})
    settings.onclick = {url: '/{index}'}
    interactions.click({index: 'click'})
    assert(interactions.calls.length === 4)
    await delay()
    assert(interactions.calls.join(',') === 'https://example.test/first,https://example.test/pending,https://example.test/second,https://example.test/click')
    interactions.cancel()
})

Deno.test('failed and rejected requests allow retry without clearing a newer delivered URL', async () => {
    for (const rejects of [false, true]) {
        const pending = []
        const interactions = setup({onmove: {url: '/{index}', wait: 0}}, {
            request: () => new Promise((resolve, reject) => pending.push({resolve, reject})),
        })
        interactions.move({index: 'old'})
        if (rejects) pending[0].reject(new Error('Load failed'))
        else pending[0].resolve(false)
        await delay()
        assert(interactions.errors.length === Number(rejects))
        interactions.move({index: 'old'})
        assert(pending.length === 2)
        interactions.move({index: 'new'})
        await delay()
        assert(pending.length === 3)
        pending[1].resolve(false)
        pending[2].resolve(true)
        await delay()
        interactions.move({index: 'new'})
        assert(pending.length === 3)
        interactions.cancel()
    }
})

Deno.test('configuration changes discard trailing work and changed waits restart the timer', async () => {
    for (const change of [{url: '/changed'}, {resolution: 5}, {wait: 0}]) {
        const settings = {onmove: {url: '/{index}', wait: 10}}
        const interactions = setup(settings)
        interactions.move({index: 'first'})
        interactions.move({index: 'obsolete'})
        Object.assign(settings.onmove, change)
        await delay()
        assert(interactions.calls.length === 1)
        interactions.cancel()
    }
    const settings = {onmove: {url: '/{index}', wait: 60000}}
    const interactions = setup(settings)
    interactions.move({index: 'first'})
    interactions.move({index: 'obsolete'})
    settings.onmove.wait = 0
    interactions.move({index: 'new-leading'})
    interactions.move({index: 'new-trailing'})
    assert(interactions.calls.length === 2)
    await delay()
    assert(interactions.calls.join(',') === 'https://example.test/first,https://example.test/new-leading,https://example.test/new-trailing')
    interactions.cancel()
})

Deno.test('disabled or invalid settings stop pending moves, and cancel clears long-lived timers', async () => {
    for (const config of [null, 'false', {url: '/{index}', wait: -1}]) {
        const settings = {onmove: {url: '/{index}', wait: 10}}
        const interactions = setup(settings)
        interactions.move({index: 'first'})
        interactions.move({index: 'obsolete'})
        settings.onmove = config
        await delay()
        assert(interactions.calls.length === 1)
        assert(interactions.errors.length === (typeof config === 'object' && config !== null ? 1 : 0))
        interactions.cancel()
    }
    const interactions = setup({onmove: {url: '/{index}', wait: 60000}})
    interactions.move({index: 'first'})
    interactions.move({index: 'obsolete'})
    interactions.cancel()
    interactions.cancel()
    await delay()
    assert(interactions.calls.length === 1)
    interactions.move({index: 'first'})
    assert(interactions.calls.length === 2)
    interactions.cancel()
})
