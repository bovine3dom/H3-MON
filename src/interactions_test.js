import {centralLinkedH3, createInteractions} from './interactions.js'

function assert(condition, message = 'Assertion failed') {
    if (!condition) throw new Error(message)
}

function setup(settings, options = {}) {
    const calls = [], errors = []
    const interactions = createInteractions({
        getSettings: () => settings,
        getValues: (_config, point) => point,
        request: async (url, context) => { calls.push({url, context}); return true },
        onError: error => errors.push(error),
        baseURL: 'https://example.test/maps/index.html',
        ...options,
    })
    return {...interactions, calls, errors}
}

Deno.test('cartogram origin is central and deterministic, including the dateline', () => {
    const points = {left: [0, -1], middle: [0, 0], right: [0, 1]}
    assert(centralLinkedH3(['right', 'left', 'middle', 'left'], key => points[key]) === 'middle')
    assert(centralLinkedH3([], key => points[key]) === null)
    assert(centralLinkedH3(['b', 'a'], () => [0, 0]) === 'a')
    const dateline = {east: [0, 179], west: [0, -179], distant: [0, 0]}
    assert(centralLinkedH3(Object.keys(dateline), key => dateline[key]) !== 'distant')
})

Deno.test('zero-wait HTTP and socket moves synchronously encode and deduplicate queries', () => {
    const original = globalThis.setTimeout
    globalThis.setTimeout = () => { throw new Error('Unexpected timer') }
    try {
        for (const transport of [{wait: 0}, {socket: 'wss://example.test/stream'}]) {
            const config = {url: '../query/{index}?time={controls.time}&fixed=a%2Fb', ...transport}
            const interactions = setup({onmove: config, onclick: config})
            const point = {index: 'a/b ?&=#{}', 'controls.time': '08:30 + 1'}
            interactions.move(point)
            interactions.move({...point, lat: 2, zoom: 3})
            assert(interactions.calls.length === 1)
            const path = '/query/a%2Fb%20%3F%26%3D%23%7B%7D?time=08%3A30%20%2B%201&fixed=a%2Fb'
            assert(interactions.calls[0].url === (transport.socket ? path : `https://example.test${path}`))
            assert(interactions.calls[0].context.socket === transport.socket)
            interactions.move({...point, index: 'next'})
            interactions.click(point)
            interactions.click(point)
            assert(interactions.calls.length === 4 && interactions.errors.length === 0)
            interactions.cancel()
        }
    } finally {
        globalThis.setTimeout = original
    }
})

Deno.test('disabled automatic movement still supports metadata replay, edits and retry', async () => {
    const metadata = {onmove: {url: '/query?index={index}&time={controls.time}', socket: 'wss://example.test/stream'}}
    const interactions = setup({onmove: false}, {getReplaySettings: () => metadata})
    const point = {index: 'saved', lat: 48.8, 'controls.time': 3}
    assert(await interactions.move(point) === false)
    await interactions.replay('onmove', point, {force: false})
    point.lat = 10
    await interactions.replay('onmove', point, {force: false})
    assert(interactions.calls.length === 1 && interactions.calls[0].context.point.lat === 48.8)
    await interactions.replay('onmove', {...point, 'controls.time': 6}, {force: false})
    await interactions.retry()
    assert(interactions.calls.length === 3 && interactions.calls[2].url.endsWith('time=6'))
    assert(interactions.calls.every(({context}) => context.manual && context.socket === metadata.onmove.socket))
    interactions.cancel()
})

Deno.test('unsafe endpoints and unknown tokens fail without issuing requests', async () => {
    for (const config of [
        {url: 'javascript:alert(1)'}, {url: 'https://user:pass@example.test'},
        {url: '/{unknown}'}, {url: '/{constructor}'},
        {url: '/query', socket: 'https://example.test'}, {url: '/query', wait: -1},
    ]) {
        const interactions = setup({onclick: config})
        assert(await interactions.click({unknown: 'provided'}) === false)
        assert(interactions.calls.length === 0 && interactions.errors.length === 1)
    }
})

Deno.test('throttled moves retain the latest point and clicks cancel trailing work', async () => {
    const config = {url: '/{index}', wait: 5}
    const interactions = setup({onmove: config, onclick: config})
    interactions.move({index: 'first'})
    interactions.move({index: 'middle'})
    interactions.move({index: 'latest'})
    await new Promise(resolve => setTimeout(resolve, 15))
    assert(interactions.calls.map(call => new URL(call.url).pathname).join() === '/first,/latest')
    interactions.move({index: 'next'})
    interactions.move({index: 'obsolete'})
    await interactions.click({index: 'click'})
    await new Promise(resolve => setTimeout(resolve, 15))
    assert(interactions.calls.length === 4 && interactions.calls[3].url.endsWith('/click'))
    interactions.cancel()
})
