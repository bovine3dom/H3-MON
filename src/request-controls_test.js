import {createRequestControls} from './request-controls.js'
import {readSettingLayers} from './settings.js'
import reachable from '../www/data/reachable.json' with {type: 'json'}

function assert(condition, message = 'Assertion failed') {
    if (!condition) throw new Error(message)
}

function assertThrows(callback, message) {
    try {
        callback()
    } catch (error) {
        assert(error instanceof Error && error.message.includes(message), `Expected "${message}", got ${error}`)
        return
    }
    throw new Error(`Expected an error containing "${message}"`)
}

const definitions = {
    travelTime: {label: 'Travel time', type: 'number', default: 180, unit: 'min', min: 0, max: 10080, step: 15, encode: 'value => value * 60'},
    departure: {label: 'Departure', type: 'time', default: '08:00', encode: 'value => value.length === 5 ? value + ":00" : value'},
}

Deno.test('reachable metadata sends floating hours in every active and inactive URL', () => {
    const controls = createRequestControls(reachable.controls)
    assert(controls.values().travelTime === 168 && controls.values().departure === 0)
    assert(controls.schema.every(field => field.type === 'number' && field.name.endsWith('(h)')))
    const layers = readSettingLayers({}, new URLSearchParams('p.travelTime=0.25&p.departure=23.5'))
    const tokens = {...controls.encode(layers.settings), index: '871fb4662ffffff'}
    for (const hook of [reachable.onclick, reachable.onmove]) {
        for (const [name, template] of Object.entries(hook)) {
            if (!name.endsWith('url')) continue
            const url = new URL(template.replace(/\{([^}]+)\}/g, (_, key) => tokens[key]), 'http://127.0.0.1:1988')
            const params = url.searchParams
            assert(!url.href.includes('undefined') && !url.href.includes('{'))
            assert(params.get('departure_h') === '23.5')
            assert(params.get('budget_h') === (hook === reachable.onmove ? '3' : '0.25'))
            assert(!['departure', 'budget_s', 'window_s', 'step_s', 'max_walk_s'].some(key => params.has(key)))
            assert(['0', '1'].includes(params.get('max_walk_h')))
            if (params.has('window_h')) assert(params.get('window_h') === '24' && params.get('step_h') === '0.25')
        }
    }
    for (const value of ['08:00', 24, -1, NaN, Infinity]) assertThrows(() => controls.encode({'p.departure': value}), 'departure')
    assert(controls.encode({'p.travelTime': '2.5e-1'})['controls.travelTime'] === '0.25')
})

Deno.test('trusted metadata produces panel schema and raw defaults separately from encoded tokens', () => {
    const controls = createRequestControls(definitions)
    assert(JSON.stringify(controls.schema) === JSON.stringify([
        {key: 'p.travelTime', name: 'Travel time (min)', group: 'Request', type: 'number', apply: 'debounce', refresh: 'request', min: 0, max: 10080, step: 15, defaultValue: 180},
        {key: 'p.departure', name: 'Departure', group: 'Request', type: 'time', apply: 'debounce', refresh: 'request', defaultValue: '08:00'},
    ]))
    assert(JSON.stringify(controls.values()) === JSON.stringify({travelTime: 180, departure: '08:00'}))
    assert(JSON.stringify(controls.encode()) === JSON.stringify({'controls.travelTime': '10800', 'controls.departure': '08:00:00'}))
    assert(!Object.hasOwn(definitions.travelTime, 'defaultValue'))
    assert(!Object.hasOwn(controls.schema[0], 'encode'))
    const empty = createRequestControls()
    assert(empty.schema.length === 0 && Object.keys(empty.values()).length === 0 && Object.keys(empty.encode()).length === 0)
})

Deno.test('defaults normalize numbers and flags while select labels and help match the panel', () => {
    const controls = createRequestControls({
        amount: {label: 'Amount', type: 'number', default: '1.5', step: 'any'},
        enabled: {label: 'Enabled', type: 'boolean', default: 'off'},
        note: {label: 'Note', type: 'text', default: '', help: 'Optional note'},
        mode: {label: 'Mode', type: 'select', default: 'walk', options: [{value: 'walk', label: 'Walking'}, {value: 'rail', label: 'Rail'}]},
    })
    assert(JSON.stringify(controls.values()) === JSON.stringify({amount: 1.5, enabled: false, note: '', mode: 'walk'}))
    assert(controls.schema[0].defaultValue === 1.5 && controls.schema[0].step === 'any')
    assert(controls.schema[1].defaultValue === false && controls.schema[2].description === 'Optional note')
    assert(JSON.stringify(controls.schema[3].options) === JSON.stringify([{value: 'walk', name: 'Walking'}, {value: 'rail', name: 'Rail'}]))
    assert(controls.values({'p.mode': 'rail'}).mode === 'rail')
    assert(controls.encode()['controls.note'] === '' && controls.encode()['controls.enabled'] === 'false')
})

Deno.test('URL and typed overrides use only p.id and preserve colliding core settings', () => {
    const controls = createRequestControls({...definitions, raw: {label: 'Custom raw', type: 'text', default: 'default'}})
    const layers = readSettingLayers({raw: true}, new URLSearchParams('raw=false&travelTime=999&p.travelTime=30&p.departure=09%3A15%3A20&p.raw=custom&p.unknown=ignored'))
    const before = JSON.stringify(layers.settings)
    const values = controls.values(layers.settings)
    assert(values.travelTime === 30 && values.departure === '09:15:20' && values.raw === 'custom')
    assert(layers.settings.raw === false && !Object.hasOwn(values, 'unknown'))
    assert(controls.encode(layers.settings)['controls.travelTime'] === '1800')
    assert(controls.encode(layers.settings)['controls.departure'] === '09:15:20')
    assert(JSON.stringify(layers.settings) === before)
    assert(controls.values({'p.travelTime': 0}).travelTime === 0)
    assert(controls.values({travelTime: 30, 'controls.travelTime': 60}).travelTime === 180)
})

Deno.test('false checkboxes and legacy boolean spellings survive parsing and encoding', () => {
    const controls = createRequestControls({flag: {label: 'Flag', type: 'boolean', default: true}})
    for (const value of [false, 'false', ' FALSE ', 'off', 'no', '0', 0]) {
        assert(controls.values({'p.flag': value}).flag === false)
        assert(controls.encode({'p.flag': value})['controls.flag'] === 'false')
    }
    for (const value of [true, '', 'true', 'yes', 'on', '1', 1]) assert(controls.values({'p.flag': value}).flag === true)
    assert(controls.values().flag === true)
    for (const value of [null, undefined, {}, [], () => false, Infinity, NaN]) assertThrows(() => controls.values({'p.flag': value}), 'flag')
})

Deno.test('numeric inputs must be nonblank finite numbers within inclusive bounds', () => {
    const controls = createRequestControls(definitions)
    for (const value of ['', ' ', 'nope', '1 + 2', 'Infinity', NaN, Infinity, -Infinity, null, undefined, true, false, {}, [], () => 3, -1, 10081]) {
        assertThrows(() => controls.values({'p.travelTime': value}), 'travelTime')
        assertThrows(() => controls.encode({'p.travelTime': value}), 'travelTime')
    }
    for (const value of [0, '0', 10080, '10080', ' 30 ']) assert(controls.values({'p.travelTime': value}).travelTime === Number(value))
    assert(controls.schema[0].step === 15)
    const decimal = createRequestControls({n: {label: 'Number', type: 'number', default: 0.3, min: 0.1, max: 0.5, step: 0.1}})
    assert(decimal.values({'p.n': '0.5'}).n === 0.5)
})

Deno.test('time inputs validate the clock and optional bounds across both supported formats', () => {
    const controls = createRequestControls(definitions)
    for (const value of ['00:00', '23:59', '23:59:59', '08:00:00']) assert(controls.values({'p.departure': value}).departure === value)
    for (const value of ['', '8:00', '08:0', '24:00', '12:60', '12:00:60', '12:00:00.5', ' 08:00', '08:00\n', 'tomorrow', 800, null, {}]) {
        assertThrows(() => controls.values({'p.departure': value}), 'departure')
    }
    const bounded = createRequestControls({departure: {...definitions.departure, min: '08:00:00', max: '09:30', step: 30}})
    assert(bounded.schema[0].min === '08:00:00' && bounded.schema[0].max === '09:30' && bounded.schema[0].step === 30)
    for (const value of ['08:00', '08:00:01', '09:30:00']) assert(bounded.values({'p.departure': value}).departure === value)
    for (const value of ['07:59:59', '09:30:01']) assertThrows(() => bounded.values({'p.departure': value}), 'departure')
})

Deno.test('text and select inputs remain strings and selected values must be declared', () => {
    const controls = createRequestControls({
        text: {label: 'Text', type: 'text', default: ''},
        select: {label: 'Select', type: 'select', default: '', options: [{value: '', label: 'None'}, {value: 'x', label: 'X'}]},
    })
    assert(controls.values({'p.text': '', 'p.select': ''}).text === '')
    assert(controls.values({'p.select': 'x'}).select === 'x')
    assertThrows(() => controls.values({'p.select': 'unknown'}), 'select')
    for (const value of [0, false, null, undefined, {}, [], () => 'x']) {
        assertThrows(() => controls.values({'p.text': value}), 'text')
        assertThrows(() => controls.values({'p.select': value}), 'select')
    }
})

Deno.test('malformed definitions, metadata and defaults fail at construction with field context', () => {
    for (const value of [null, false, 1, 'value => value', [], () => ({})]) assertThrows(() => createRequestControls(value), 'Request controls')
    const invalid = [null, false, 1, '', [], {},
        {label: '', type: 'text', default: ''}, {label: ' ', type: 'text', default: ''}, {label: 1, type: 'text', default: ''},
        {label: 'Field', type: 'range', default: 0}, {label: 'Field', type: 'text'},
        ...[undefined, null, 0, false, {}, []].map(value => ({label: 'Field', type: 'text', default: value})),
        ...['', 'nope', Infinity, -1, 11].map(value => ({label: 'Field', type: 'number', default: value, min: 0, max: 10})),
        {label: 'Field', type: 'time', default: '24:00'},
        {label: 'Field', type: 'time', default: '08:00', min: '09:00'},
        {label: 'Field', type: 'boolean', default: null},
        ...[{unit: 1}, {unit: ''}, {help: false}].map(extra => ({label: 'Field', type: 'text', default: '', ...extra})),
    ]
    for (const definition of invalid) assertThrows(() => createRequestControls({field: definition}), 'field')
})

Deno.test('malformed bounds, steps and options are rejected rather than passed to the panel', () => {
    const invalid = [
        ...['0', null, NaN, Infinity].flatMap(value => [{min: value}, {max: value}]),
        {min: 20, max: 10}, ...[0, -1, '15', null, Infinity, NaN].map(step => ({step})),
        {options: []},
    ]
    for (const extra of invalid) assertThrows(() => createRequestControls({field: {label: 'Field', type: 'number', default: 5, ...extra}}), 'field')
    for (const extra of [{min: '25:00'}, {max: 900}, {min: '09:00', max: '08:00'}]) {
        assertThrows(() => createRequestControls({field: {label: 'Field', type: 'time', default: '08:00', ...extra}}), 'field')
    }
    for (const type of ['text', 'boolean', 'select']) {
        for (const extra of [{min: 0}, {max: 1}, {step: 1}]) assertThrows(() => createRequestControls({field: {label: 'Field', type, default: '', ...extra}}), 'field')
    }
    for (const options of [undefined, null, {}, [], ['x'], [null], [{value: 1, label: 'One'}], [{value: 'x'}], [{value: 'x', label: ''}], [{value: 'x', label: 'X'}, {value: 'x', label: 'Again'}], [{value: 'other', label: 'Other'}]]) {
        assertThrows(() => createRequestControls({field: {label: 'Field', type: 'select', default: 'x', options}}), 'field')
    }
})

Deno.test('converters compile once from metadata, never from query configuration or field strings', () => {
    globalThis.__requestControlsTest = {compiled: 0, called: 0, injected: 0}
    try {
        const controls = createRequestControls({
            text: {label: 'Text', type: 'text', default: '', encode: '(() => { globalThis.__requestControlsTest.compiled++; return value => { globalThis.__requestControlsTest.called++; return value } })()'},
            number: {label: 'Number', type: 'number', default: 0},
        })
        const payload = '(() => { globalThis.__requestControlsTest.injected++; return "executed" })()'
        const settings = Object.fromEntries(new URLSearchParams({
            'p.text': payload, controls: JSON.stringify({text: {encode: payload}}),
            encode: payload, 'p.text.encode': payload, 'controls.text': payload,
        }))
        assert(globalThis.__requestControlsTest.compiled === 1 && globalThis.__requestControlsTest.called === 0)
        assert(controls.values(settings).text === payload)
        assertThrows(() => controls.encode({...settings, 'p.number': 'invalid'}), 'number')
        assert(globalThis.__requestControlsTest.called === 0)
        for (let i = 0; i < 3; i++) assert(controls.encode(settings)['controls.text'] === payload)
        assert(globalThis.__requestControlsTest.compiled === 1 && globalThis.__requestControlsTest.called === 3)
        assert(globalThis.__requestControlsTest.injected === 0)
        assertThrows(() => createRequestControls(definitions).values({'p.travelTime': payload}), 'travelTime')
        assert(globalThis.__requestControlsTest.injected === 0)
    } finally {
        delete globalThis.__requestControlsTest
    }
})

Deno.test('converters receive every typed input before conversion, in a frozen shared map', () => {
    const controls = createRequestControls({
        first: {label: 'First', type: 'number', default: 2, encode: '(value, values) => { if (!Object.isFrozen(values)) throw new Error("not frozen"); return value + values.second }'},
        second: {label: 'Second', type: 'number', default: 3, encode: '(value, values) => value * values.first'},
    })
    const settings = {'p.first': '4', 'p.second': '5'}
    assert(JSON.stringify(controls.encode(settings)) === JSON.stringify({'controls.first': '9', 'controls.second': '20'}))
    const mutating = createRequestControls({field: {label: 'Field', type: 'number', default: 1, encode: '(value, values) => { values.field = 99; return value }'}})
    assertThrows(() => mutating.encode(), 'field')
    assert(mutating.values().field === 1)
})

Deno.test('invalid converter expressions and conversion exceptions identify the field', () => {
    for (const encode of [null, 1, {}, () => 1, '', 'value =>', '42', '({})', 'missingRequestControlFunction', '(() => { throw new Error("compile failed") })()']) {
        assertThrows(() => createRequestControls({field: {label: 'Field', type: 'text', default: '', encode}}), 'field')
    }
    for (const expression of ['new Error("conversion failed")', '"conversion failed"']) {
        const controls = createRequestControls({field: {label: 'Field', type: 'text', default: '', encode: `() => { throw ${expression} }`}})
        assertThrows(() => controls.encode(), 'Request control "field": encode failed: conversion failed')
    }
})

Deno.test('converters return only finite scalar tokens and do not URL-encode them', async () => {
    for (const expression of ['null', 'undefined', '{}', '[]', 'NaN', 'Infinity', '-Infinity', '() => 1', 'Promise.resolve(1)', 'Promise.reject(new Error("rejected"))', '1n', 'Symbol("x")']) {
        const controls = createRequestControls({field: {label: 'Field', type: 'text', default: '', encode: `() => (${expression})`}})
        assertThrows(() => controls.encode(), 'Request control "field": encode must return')
    }
    await Promise.resolve()
    for (const [expression, expected] of [['0', '0'], ['false', 'false'], ['true', 'true'], ['"a/b ?&=#{}%"', 'a/b ?&=#{}%']]) {
        const controls = createRequestControls({field: {label: 'Field', type: 'text', default: '', encode: `() => (${expression})`}})
        const encoded = controls.encode()
        assert(Object.hasOwn(encoded, 'controls.field') && encoded['controls.field'] === expected)
    }
})

Deno.test('prototype names and inherited settings cannot alter control definitions or defaults', () => {
    for (const id of ['constructor', 'prototype', '__proto__', '', '1field', '_field', 'p.field', 'two-words', 'a b', 'field\n']) {
        assertThrows(() => createRequestControls(Object.fromEntries([[id, {label: 'Field', type: 'text', default: ''}]])), 'invalid field id')
    }
    const inherited = Object.assign(Object.create({hidden: {label: 'Hidden', type: 'text', default: 'ignored'}}), {
        toString: {label: 'Text', type: 'text', default: 'own'},
        hasOwnProperty: {label: 'Flag', type: 'boolean', default: false},
    })
    const controls = createRequestControls(inherited)
    const settings = Object.create({'p.toString': 'inherited', 'p.hasOwnProperty': true})
    const values = controls.values(settings)
    assert(Object.keys(values).length === 2 && Object.hasOwn(values, 'toString') && values.toString === 'own')
    assert(values.hasOwnProperty === false && controls.encode(settings)['controls.toString'] === 'own')
    assert(!Object.hasOwn(controls.encode(settings), 'controls.hidden'))
    const nullPrototype = createRequestControls(Object.assign(Object.create(null), definitions))
    assert(nullPrototype.values(Object.create(null)).travelTime === 180)
})
