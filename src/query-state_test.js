import {readQueryState, writeQueryState} from './query-state.js'
import {queryTitle} from './query-title.js'

function assert(condition) { if (!condition) throw new Error('Assertion failed') }

Deno.test('query titles preserve templates until a city matches and use geographic coordinates', () => {
    const template = 'From {TOWN_NAME} to {TOWN_NAME}'
    const lookup = (lat, lng) => {
        assert(lat === 48.8 && Math.abs(lng - 2.4) < 1e-10)
        return {name: 'City $&'}
    }
    const point = {lat: 48.8, lng: 362.4, cartogram: [100, 200]}
    assert(queryTitle(template, null, lookup) === template)
    assert(queryTitle(template, {}, lookup) === template)
    assert(queryTitle(template, point, () => undefined) === template)
    assert(queryTitle(template, point, () => ({name: ''})) === template)
    assert(queryTitle(template, point, lookup) === 'From City $& to City $&')
    assert(queryTitle('Edited {TOWN_NAME}', point, lookup) === 'Edited City $&')
    for (const title of ['', undefined, 'Plain title']) {
        assert(queryTitle(title, point, () => { throw new Error('Unnecessary lookup') }) === title)
    }
})
const query = {event: 'onclick', index: '851fb467fffffff', lat: 48.8, lng: 2.4, zoom: 6, cartogram: [3, 7]}

Deno.test('query state round-trips without losing controls, data, or camera', () => {
    const url = new URL('https://example.test/?data=reachable.csv&p.travelTime=360&onmove=false#x=1&y=2&z=3')
    writeQueryState(url, query)
    const restored = readQueryState(new URL(url.href).searchParams)
    assert(JSON.stringify(restored) === JSON.stringify(query))
    assert(url.searchParams.get('p.travelTime') === '360')
    assert(url.searchParams.get('data') === 'reachable.csv' && url.searchParams.get('onmove') === 'false')
    assert(url.hash === '#x=1&y=2&z=3')
    writeQueryState(url, {...query, event: 'onmove'})
    assert(url.searchParams.getAll('query').length === 1)
    assert(readQueryState(new URLSearchParams()) === null)
})

Deno.test('saved query input is validated, never executed', () => {
    globalThis.queryExecuted = false
    const invalid = ['globalThis.queryExecuted = true', 'null', '[]', '{}', JSON.stringify({...query, event: 'eval'}),
        ...['lat', 'lng', 'zoom'].flatMap(key => [JSON.stringify({...query, [key]: null}), JSON.stringify({...query, [key]: '1'})]),
        JSON.stringify({...query, lat: 91}), JSON.stringify({...query, lng: 181}), JSON.stringify({...query, zoom: -1}),
        JSON.stringify({...query, index: 'x'}), JSON.stringify({...query, cartogram: [1]}),
        JSON.stringify({...query, cartogram: [1, '2']}), JSON.stringify({...query, encode: 'value => eval(value)'})]
    for (const input of invalid) {
        let failed = false
        try { readQueryState(new URLSearchParams({query: input})) } catch (_) { failed = true }
        assert(failed)
    }
    let failed = false
    const params = new URLSearchParams({query: JSON.stringify(query)})
    params.append('query', JSON.stringify(query))
    try { readQueryState(params) } catch (_) { failed = true }
    assert(failed && !globalThis.queryExecuted)
    delete globalThis.queryExecuted
})
