import {compactCartogramColumns} from './compact-cartogram.js'

Deno.test('cartogram compaction releases the IPC buffer without changing typed values', () => {
    const buffer = new ArrayBuffer(256)
    const columns = {index_lower: new Uint32Array(buffer, 0, 2), index_upper: new Uint32Array(buffer, 8, 2),
        weight: new Float32Array(buffer, 16, 2), weight_mean: new Float64Array(buffer, 24, 2),
        x: new Int16Array(buffer, 40, 2), label: {buffer}, _h3Strings: ['a', 'b']}
    columns.index_lower.set([0xffffffff, 7]); columns.index_upper.set([0x08510000, 0xf8510000])
    columns.weight.set([.5, .25]); columns.weight_mean.set([.125, NaN])
    const compact = compactCartogramColumns(columns)
    for (const name of ['index_lower', 'index_upper', 'weight', 'weight_mean']) {
        const a = compact[name], b = columns[name]
        if (a.constructor !== b.constructor || a.buffer === buffer || a.byteLength !== a.buffer.byteLength) throw Error('not compact')
        if (!a.every((value, i) => Object.is(value, b[i]))) throw Error('changed values')
    }
    if ('x' in compact || 'label' in compact || compact._h3Strings !== columns._h3Strings) throw Error('wrong retained columns')
})

Deno.test('cartogram compaction keeps owned buffers and declines non-typed columns', () => {
    const columns = {index_lower: new Uint32Array([7]), index_upper: new Uint32Array([1]), weight: new Float32Array([1])}
    const compact = compactCartogramColumns(columns)
    if (compact.weight !== columns.weight || compact.index_lower !== columns.index_lower) throw Error('copied owned buffer')
    if (compactCartogramColumns({...columns, weight: [1]}) !== null) throw Error('accepted object array')
    if (compactCartogramColumns({index: ['abc'], weight: columns.weight}) !== null) throw Error('accepted string index')
})
