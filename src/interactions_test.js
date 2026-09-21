import {centralLinkedH3, createInteractions} from './interactions.js'
import {readSettingLayers, updateUrlSettingOverrides} from './settings.js'

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

Deno.test('CPU estimators receive resolved, encoded HTTP and WebSocket URLs', async () => {
    for (const socket of [undefined, 'wss://example.test/stream']) {
        let estimated
        const metadata = {onclick: {url: '../query?cost={controls.cost}&index={index}', socket, estimator: url => { estimated = url; return 10 }}}
        const f = setup(metadata, {metadata}), point = {index: 'a/b', 'controls.cost': '08:30 + 1'}
        assert(f.preview('onclick', point).cost === 10 && !f.calls.length && f.preview('onmove', point) === undefined)
        await f.click(point)
        assert(estimated === f.calls[0].url && estimated === `${socket ? '' : 'https://example.test'}/query?cost=08%3A30%20%2B%201&index=a%2Fb`)
        assert(f.calls[0].context.tokens.has('index') && !f.calls[0].context.tokens.has('lat'))
    }
})

Deno.test('CPU budgets allow equality, reject invalid estimates and persist independent overrides', async () => {
    const hook = {url: '/query?cost={controls.cost}', budget: 10, estimator: 'url => Number(new URL(url).searchParams.get("cost"))'}
    for (const event of ['onclick', 'onmove']) {
        const metadata = {onclick: hook, onmove: {...hook, wait: 0}}, state = {...metadata}, f = setup(state, {metadata})
        assert(JSON.stringify(f.preview(event, {'controls.cost': 10})) === '{"cost":10,"budget":10,"over":false}')
        f.check(event, 'https://example.test/query?cost=10')
        assert(await f.replay(event, {'controls.cost': 11}) === false && /exceeds budget/.test(f.errors.at(-1).message))
        const flag = `${event}BudgetOverride`, url = updateUrlSettingOverrides(new URL('https://example.test'), {[flag]: true})
        Object.assign(state, readSettingLayers(metadata, url.searchParams).settings)
        assert(state[flag] && !state[`${event === 'onclick' ? 'onmove' : 'onclick'}BudgetOverride`] && !await f.retry(event === 'onclick' ? 'onmove' : 'onclick'))
        assert(await f.retry(event) && await f.retry() && state[flag])
        assert(f.preview(event, {'controls.cost': 'invalid'}).error && await f.replay(event, {'controls.cost': 'invalid'}) === false)
    }
})

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
