import assert from 'node:assert/strict'
import {Dictionary, Int8, Uint32, makeData, makeVector, vectorFromArray} from 'apache-arrow'
import {arrowColumnValues} from '../src/arrow-columns.js'

const type = new Dictionary(new Uint32(), new Int8(), 12)
const first = vectorFromArray([7, 0xffffffff, 7, 0x80000000], type)
const nullable = makeVector(makeData({type, data: new Int8Array([0, 1]),
    dictionary: makeVector(makeData({type: new Uint32(), data: new Uint32Array([1234, 42]),
        length: 2, nullCount: 1, nullBitmap: new Uint8Array([2])}))}))
for (const column of [first, first.slice(1, 3), nullable]) {
    const expected = Uint32Array.from(column.toArray())
    for (const name of ['index_lower', 'index_upper']) {
        assert.deepEqual(arrowColumnValues(column, name), expected)
    }
}
console.log('Ordinary Arrow dictionaries, slices and nulls pass')
