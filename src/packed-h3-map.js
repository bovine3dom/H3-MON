import {splitMapGet, splitMapSet} from './split-index.js'

// Keep source-to-target adjacency and bounds in typed buffers, not per-source arrays.
export function createPackedH3Map({lower, upper, x, y, cells}, {parseIndex, formatIndex, center}) {
    const rows = lower.length
    if ([upper, x, y].some(column => column.length !== rows) || cells && cells.length !== rows) throw Error('H3 column length mismatch')
    const lookup = new Map(), counts = [], sourceRow = new Uint32Array(rows)
    for (let row = 0; row < rows; row++) {
        const lo = Number(lower[row]), hi = Number(upper[row])
        let i = splitMapGet(lookup, lo, hi)
        if (i === undefined) {
            i = counts.length
            splitMapSet(lookup, lo, hi, i)
            counts.push(0)
        }
        sourceRow[row] = i
        counts[i]++
    }
    const size = counts.length, offsets = new Uint32Array(size + 1)
    for (let i = 0; i < size; i++) offsets[i + 1] = offsets[i] + counts[i]
    const next = offsets.slice(0, size)
    const adjacency = cells instanceof Uint16Array ? new Uint16Array(rows) : new Uint32Array(rows)
    const low = new Uint32Array(size), high = new Uint32Array(size)
    const Bounds = x instanceof Int16Array && y instanceof Int16Array ? Int16Array : Float64Array
    const xMin = new Bounds(size), xMax = new Bounds(size), yMin = new Bounds(size), yMax = new Bounds(size)
    for (let row = 0; row < rows; row++) {
        const i = sourceRow[row], cx = Number(x[row]), cy = Number(y[row])
        if (next[i] === offsets[i]) {
            low[i] = Number(lower[row]); high[i] = Number(upper[row])
            xMin[i] = xMax[i] = cx; yMin[i] = yMax[i] = cy
        } else {
            if (cx < xMin[i]) xMin[i] = cx
            if (cx > xMax[i]) xMax[i] = cx
            if (cy < yMin[i]) yMin[i] = cy
            if (cy > yMax[i]) yMax[i] = cy
        }
        adjacency[next[i]++] = cells ? cells[row] : row
    }
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
