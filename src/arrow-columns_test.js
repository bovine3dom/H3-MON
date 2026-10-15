import {arrowColumnValues} from './arrow-columns.js'

Deno.test('ordinary UInt32 dictionaries preserve H3 words in numeric buffers', () => {
    const data = [0, 0xffffffff, 0x80000000, 7]
    const column = {type: {dictionary: {ArrayType: Uint32Array}}, nullCount: 0,
        toArray: () => data}
    for (const name of ['index_lower', 'index_upper']) {
        const values = arrowColumnValues(column, name)
        if (!(values instanceof Uint32Array) || !values.every((v, i) => v === data[i])) throw Error('changed H3 bits')
    }
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
