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
    assert(controls.schema.every(setting => !Object.hasOwn(setting, 'showIf')))
    assert(controls.values(settings).time === 30 && controls.values(settings).flag === false)
    assert(!Object.hasOwn(controls.values(settings), 'unknown'))
    assert(controls.encode(settings)['controls.time'] === '1800' && settings['p.time'] === '30')
    assert(controls.values().time === 180 && controls.encode()['controls.text'] === '')
})

Deno.test('showIf uses typed raw values and option values without encoding', () => {
    const controls = createRequestControls({
        text: {...definitions.text, showIf: 'values => (values.mode === "rail" || values.mode === "bus") && values.time >= 30 && !values.flag && ["", "note"].includes(values.text)'},
        time: {...definitions.time, encode: '() => { throw new Error("encoding must not run") }'},
        flag: definitions.flag,
        mode: {...definitions.mode, options: [...definitions.mode.options, {value: 'bus', label: 'Bus'}], encode: '() => "Train"'},
    })
    const showIf = controls.schema[0].showIf
    const raw = controls.values({'p.time': '30', 'p.flag': 'false'})
    assert(Object.isFrozen(raw) && raw.mode === 'rail' && raw.time === 30 && raw.flag === false)
    assert(showIf(raw) === true)
    assert(showIf(controls.values({'p.mode': 'bus', 'p.time': '30', 'p.flag': 'false'})) === true)
    assert(showIf(controls.values()) === false)
    assert(showIf(controls.values({'p.time': '29', 'p.flag': 'false'})) === false)
    assert(showIf(controls.values({'p.time': '30', 'p.flag': 'false', 'p.text': 'other'})) === false)
})

Deno.test('hidden controls keep their raw values and encoded request fields', () => {
    const controls = createRequestControls({time: {...definitions.time, showIf: 'values => values.time < 0'}})
    const settings = {'p.time': '30'}
    assert(controls.schema[0].showIf(controls.values(settings)) === false)
    assert(controls.values(settings).time === 30)
    assert(controls.encode(settings)['controls.time'] === '1800')
    assert(settings['p.time'] === '30')
})

Deno.test('showIf rejects malformed metadata, runtime errors and nonboolean results', async () => {
    for (const showIf of [undefined, null, true, () => true, 'values =>', 'true', '{}']) {
        assertThrows(() => createRequestControls({text: {...definitions.text, showIf}}), '"text":')
        assertThrows(() => createRequestControls({text: {...definitions.text, showIf}}), 'showIf')
    }
    for (const showIf of ['() => 1', '() => "false"', '() => null', '() => ({})', '() => { throw new Error("broken") }', 'async () => true', 'async () => { throw new Error("rejected") }']) {
        const controls = createRequestControls({text: {...definitions.text, showIf}})
        const evaluate = () => controls.schema[0].showIf(controls.values())
        assertThrows(evaluate, '"text": showIf')
    }
    await new Promise(resolve => setTimeout(resolve, 0))
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
