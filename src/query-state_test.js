import {readQueryState, writeQueryState} from './query-state.js'
import {queryTitle} from './query-title.js'
import {createRequestControls} from './request-controls.js'

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
