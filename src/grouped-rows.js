// Return row-index views in one buffer, in the original row order.
export function groupedRows(rowCell, cellCount) {
    const counts = new Uint32Array(cellCount)
    for (const cell of rowCell) counts[cell]++
    const rows = new Uint32Array(rowCell.length)
    const groups = new Array(cellCount)
    let offset = 0
    for (let cell = 0; cell < cellCount; cell++) {
        groups[cell] = rows.subarray(offset, offset + counts[cell])
        offset += counts[cell]
    }
    counts.fill(0)
    for (let row = 0; row < rowCell.length; row++) {
        const cell = rowCell[row]
        groups[cell][counts[cell]++] = row
    }
    return groups
}
