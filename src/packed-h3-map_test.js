import {createPackedH3Map} from './packed-h3-map.js'

const callbacks = {
    parseIndex: value => value.split(':').map(Number),
    formatIndex: (lo, hi) => `${lo}:${hi}`,
    center: ([lo]) => lo === 7 ? [30, 40] : [10, 20],
}
const equal = (actual, expected) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw Error(`${JSON.stringify(actual)} != ${JSON.stringify(expected)}`)
}

Deno.test('packed H3 adjacency keeps bounds, row order, duplicates, and index words', () => {
    let centerCalls = 0
    const map = createPackedH3Map({
        lower: [0xffffffff, 7n, 0xffffffff, 0xffffffff],
        upper: [0x08510000, 0xf8510000n, 0x08510000, 0x08510000],
        x: [1, 8, -3.25, 2], y: [4, 6, 5, -1], cells: new Uint16Array([10, 11, 12, 12]),
    }, {...callbacks, center: index => { centerCalls++; return callbacks.center(index) }})
    equal(map.size, 2)
    equal(Array.from(map.keys()), ['4294967295:139526144', '7:4166057984'])
    const a = map.getSplit(0xffffffff, 0x08510000), b = map.get('7:4166057984')
    equal([a.xMin, a.xMax, a.yMin, a.yMax], [-3.25, 2, -1, 5])
    equal(Array.from(a.cellIndices), [10, 12, 12])
    equal(Array.from(b.cellIndices), [11])
    if (!(a.cellIndices instanceof Uint16Array) || a.cellIndices.buffer !== b.cellIndices.buffer) throw Error('not packed')
    equal(map.get([0xffffffff, 0x08510000]).upper, a.upper)
    equal(Array.from(map, ([words]) => words), [[0xffffffff, 0x08510000], [7, 0xf8510000]])
    equal(map.getSplit(1, 2), undefined)
    equal(map.closest(20, 30).lower, 0xffffffff) // Keep first source on an exact tie.
    equal(map.closest(32, 41).lower, 7)
    equal(centerCalls, 2)
    equal([map.getSplit(7, 0xf8510000).lat, map.getSplit(7, 0xf8510000).lng], [30, 40])
})

Deno.test('packed H3 bounds retain the full Int16 coordinate range', () => {
    const map = createPackedH3Map({lower: [7, 7], upper: [1, 1],
        x: new Int16Array([-32768, 32767]), y: new Int16Array([32767, -32768])}, callbacks)
    const a = map.getSplit(7, 1)
    equal([a.xMin, a.xMax, a.yMin, a.yMax], [-32768, 32767, -32768, 32767])
})

Deno.test('packed H3 map handles empty input and uses row indexes without cells', () => {
    const map = createPackedH3Map({lower: [7, 7], upper: [1, 1], x: [0, 1], y: [2, 3]}, callbacks)
    equal(Array.from(map.getSplit(7, 1).cellIndices), [0, 1])
    equal(createPackedH3Map({lower: [], upper: [], x: [], y: []}, callbacks).closest(0, 0), null)
    let threw = false
    try { createPackedH3Map({lower: [1], upper: [], x: [], y: []}, callbacks) } catch { threw = true }
    if (!threw) throw Error('accepted mismatched columns')
})
