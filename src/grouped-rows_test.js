import {groupedRows} from './grouped-rows.js'

Deno.test('grouped rows preserve order and share a compact buffer', () => {
    const cells = new Uint32Array([2, 0, 2, 2, 0])
    const groups = groupedRows(cells, 4)
    if (JSON.stringify(groups.map(group => Array.from(group))) !== '[[1,4],[],[0,2,3],[]]') throw Error('wrong groups')
    for (const group of groups) {
        if (!(group instanceof Uint32Array) || group.buffer !== groups[0].buffer) throw Error('not shared views')
    }
    if (groups[0].buffer.byteLength !== cells.length * 4) throw Error('spare allocation')
    if (groupedRows([], 0).length !== 0) throw Error('empty input')
})
