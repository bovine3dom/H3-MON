import {createRequestControls} from './request-controls.js'
import {readSettingLayers} from './settings.js'

function assert(condition, message = 'Assertion failed') {
    if (!condition) throw new Error(message)
}

function assertThrows(callback, field) {
    try { callback() } catch (error) {
        assert(error.message.includes(field), error.message)
        return
    }
    throw new Error(`Expected an error for ${field}`)
}

const definitions = {
    time: {label: 'Travel time', type: 'number', default: 180, unit: 'min', min: 0, max: 360, encode: 'value => value * 60'},
    departure: {label: 'Departure', type: 'time', default: '08:00'},
    flag: {label: 'Enabled', type: 'boolean', default: true},
    text: {label: 'Note', type: 'text', default: ''},
    mode: {label: 'Mode', type: 'select', default: 'rail', options: [{value: 'rail', label: 'Train'}]},
}

Deno.test('controls expose typed panel labels and encode only namespaced raw inputs', () => {
    const controls = createRequestControls(definitions)
    const settings = readSettingLayers({}, new URLSearchParams('time=999&p.time=30&p.flag=false&p.unknown=x')).settings
    assert(controls.schema[0].name === 'Travel time (min)' && controls.schema[0].type === 'number')
    assert(controls.schema[4].options[0].name === 'Train')
    assert(controls.values(settings).time === 30 && controls.values(settings).flag === false)
    assert(!Object.hasOwn(controls.values(settings), 'unknown'))
    assert(controls.encode(settings)['controls.time'] === '1800' && settings['p.time'] === '30')
    assert(controls.values().time === 180 && controls.encode()['controls.text'] === '')
})

Deno.test('typed validation rejects invalid inputs and malformed select definitions', () => {
    const controls = createRequestControls(definitions)
    for (const [field, value] of [
        ['time', ' '], ['time', Infinity], ['time', -1], ['time', 361],
        ['departure', '24:00'], ['departure', '08:00\n'],
        ['flag', null], ['text', 1], ['mode', 'unknown'],
    ]) assertThrows(() => controls.encode({[`p.${field}`]: value}), field)
    for (const value of [0, '360']) assert(controls.values({'p.time': value}).time === Number(value))
    assert(controls.values({'p.departure': '23:59:59'}).departure === '23:59:59')
    for (const options of [[], [{value: 'rail'}], [{value: 'other', label: 'Other'}]]) {
        assertThrows(() => createRequestControls({mode: {...definitions.mode, options}}), 'mode')
    }
})

Deno.test('only trusted metadata compiles; URL strings stay literal and conversion sees raw peers', () => {
    globalThis.__controlInjected = false
    try {
        const controls = createRequestControls({
            first: {label: 'First', type: 'number', default: 2, encode: '(value, values) => value + values.second'},
            second: {label: 'Second', type: 'number', default: 3, encode: '(value, values) => value * values.first'},
            text: {...definitions.text, encode: 'value => value'},
        })
        const payload = '(() => { globalThis.__controlInjected = true; return "executed" })()'
        const settings = Object.fromEntries(new URLSearchParams({
            'p.first': '4', 'p.second': '5', 'p.text': payload,
            controls: JSON.stringify({text: {encode: payload}}), 'p.text.encode': payload,
        }))
        const tokens = controls.encode(settings)
        assert(tokens['controls.first'] === '9' && tokens['controls.second'] === '20')
        assert(tokens['controls.text'] === payload && !globalThis.__controlInjected)
        assertThrows(() => controls.encode({...settings, 'p.first': payload}), 'first')
        assert(!globalThis.__controlInjected)
    } finally {
        delete globalThis.__controlInjected
    }
    for (const encode of ['value =>', '() => Infinity', '() => ({})']) {
        assertThrows(() => createRequestControls({text: {...definitions.text, encode}}).encode(), 'text')
    }
})
