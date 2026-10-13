import {splitMapGet, splitMapSet} from './split-index.js'

// Keep source-to-target adjacency and bounds in typed buffers, not per-source arrays.
export function createPackedH3Map({lower, upper, x, y, cells}, {parseIndex, formatIndex, center}) {
    const rows = lower.length
    if ([upper, x, y].some(column => column.length !== rows) || cells && cells.length !== rows) throw Error('H3 column length mismatch')
    const lookup = new Map(), counts = [], sourceRow = new Uint32Array(rows)
    let low = [], high = [], xMin = [], xMax = [], yMin = [], yMax = []
    for (let row = 0; row < rows; row++) {
        const lo = Number(lower[row]), hi = Number(upper[row]), cx = Number(x[row]), cy = Number(y[row])
        let i = splitMapGet(lookup, lo, hi)
        if (i === undefined) {
            i = low.length
            splitMapSet(lookup, lo, hi, i)
            low.push(lo); high.push(hi); counts.push(0)
            xMin.push(cx); xMax.push(cx); yMin.push(cy); yMax.push(cy)
        }
        sourceRow[row] = i
        counts[i]++
        if (cx < xMin[i]) xMin[i] = cx
        if (cx > xMax[i]) xMax[i] = cx
        if (cy < yMin[i]) yMin[i] = cy
        if (cy > yMax[i]) yMax[i] = cy
    }
    const size = low.length, offsets = new Uint32Array(size + 1)
    for (let i = 0; i < size; i++) offsets[i + 1] = offsets[i] + counts[i]
    const next = offsets.slice(0, size)
    const adjacency = cells instanceof Uint16Array ? new Uint16Array(rows) : new Uint32Array(rows)
    for (let row = 0; row < rows; row++) {
        const i = sourceRow[row]
        adjacency[next[i]++] = cells ? cells[row] : row
    }
    low = Uint32Array.from(low); high = Uint32Array.from(high)
    const Bounds = x instanceof Int16Array && y instanceof Int16Array ? Int16Array : Float64Array
    xMin = Bounds.from(xMin); xMax = Bounds.from(xMax)
    yMin = Bounds.from(yMin); yMax = Bounds.from(yMax)
    let centers = null
    const entry = i => i === undefined ? undefined : ({
        lower: low[i], upper: high[i], cellIndices: adjacency.subarray(offsets[i], offsets[i + 1]),
        xMin: xMin[i], xMax: xMax[i], yMin: yMin[i], yMax: yMax[i],
        lat: centers?.[2 * i], lng: centers?.[2 * i + 1],
    })
    return {
        split: true, size,
        get(index) {
            const [lo, hi] = Array.isArray(index) ? index : parseIndex(String(index))
            return entry(splitMapGet(lookup, lo, hi))
        },
        getSplit(lo, hi) { return entry(splitMapGet(lookup, lo, hi)) },
        *keys() {
            for (let i = 0; i < size; i++) yield formatIndex(low[i], high[i])
        },
        *[Symbol.iterator]() {
            for (let i = 0; i < size; i++) yield [[low[i], high[i]], entry(i)]
        },
        closest(lat, lng) {
            if (!centers) {
                centers = new Float64Array(size * 2)
                const split = [0, 0]
                for (let i = 0; i < size; i++) {
                    split[0] = low[i]; split[1] = high[i]
                    centers.set(center(split), i * 2)
                }
            }
            let best, distance = Infinity
            for (let i = 0; i < size; i++) {
                const d = (centers[2 * i] - lat) ** 2 + (centers[2 * i + 1] - lng) ** 2
                if (d < distance) { distance = d; best = i }
            }
            return entry(best) ?? null
        },
    }
}
