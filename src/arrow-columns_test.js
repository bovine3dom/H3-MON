import {arrowColumnValues} from './arrow-columns.js'

Deno.test('UInt32 dictionary H3 words skip the intermediate object array', () => {
    const data = [0, 0xffffffff, 0x80000000, 7]
    const column = {type: {dictionary: {ArrayType: Uint32Array}}, nullCount: 0, length: data.length,
        data: [{length: data.length, values: new Int8Array([0, 1, 2, 3]),
            dictionary: {nullCount: 0, toArray: () => new Uint32Array(data)}}],
        get() { throw Error('unexpected scalar decode') },
        toArray() { throw Error('allocated an intermediate array') }}
    for (const name of ['index_lower', 'index_upper']) {
        const values = arrowColumnValues(column, name)
        if (!(values instanceof Uint32Array) || !values.every((v, i) => v === data[i])) throw Error('changed H3 bits')
    }
})

Deno.test('dictionary chunks use sliced indexes and their own dictionary validity', () => {
    const dictionary = {nullCount: 0, toArray: () => new Uint32Array([7, 0xffffffff])}
    const column = {type: {dictionary: {ArrayType: Uint32Array}}, nullCount: 0, length: 4,
        data: [
            {offset: 2, length: 2, values: new Int8Array([1, 0]), dictionary},
            {offset: 0, length: 2, values: new Int8Array([0, 1]),
                dictionary: {nullCount: 1, get: i => i === 0 ? null : 42,
                    toArray() { throw Error('ignored dictionary validity') }}},
        ]}
    const result = arrowColumnValues(column, 'index_lower')
    if (!result.every((v, i) => v === [0xffffffff, 7, 0, 42][i])) throw Error('changed chunk values')
})

Deno.test('other Arrow types and nullable dictionaries keep their existing conversion', () => {
    const cases = [
        [{dictionary: {ArrayType: BigUint64Array}}, 0, 'index_lower', [0xffffffffffffffffn]],
        [{dictionary: {ArrayType: Uint32Array}}, 1, 'index_lower', [null, 7]],
        [{dictionary: {ArrayType: Uint32Array}}, 0, 'value', [7]],
        [{ArrayType: Uint32Array}, 0, 'index_lower', new Uint32Array([7])],
    ]
    for (const [type, nullCount, name, expected] of cases) {
        const column = {type, nullCount, toArray: () => expected, get() { throw Error('unexpected scalar decode') }}
        if (arrowColumnValues(column, name) !== expected) throw Error('changed conversion')
    }
})
