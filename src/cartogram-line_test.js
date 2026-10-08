import {strokeCoverage, projectStroke} from './cartogram-line.js'

function assert(condition, message = 'Assertion failed') {
    if (!condition) throw new Error(message)
}

Deno.test('stroke coverage includes cells between endpoints and respects gaps', () => {
    const coverage = strokeCoverage([0, 2, 4, 2], [0, 0, 0, 4], [-2, 0], [6, 0])
    assert(coverage.size === 3)
    for (const cell of [0, 1, 2]) assert(coverage.get(cell) === 1)
    assert(strokeCoverage([0], [0], [10, 10], [12, 12]).size === 0)
})

Deno.test('coverage uses area fractions, including round ends and zero-length strokes', () => {
    assert(strokeCoverage([0], [0], [-2, 1], [2, 1]).get(0) === 0.5)
    assert(strokeCoverage([0], [0], [0, 0], [0, 0]).get(0) === 0.75)
    assert(strokeCoverage([0], [0], [-2, 0], [2, 0]).get(0) === 1)
})

Deno.test('stroke direction and axis do not change coverage', () => {
    const forward = strokeCoverage([0, 2, 4], [0, 0, 0], [0, 0], [0.5, 0])
    const reverse = strokeCoverage([0, 2, 4], [0, 0, 0], [0.5, 0], [0, 0])
    const vertical = strokeCoverage([0, 0, 0], [0, 2, 4], [0, 0], [0, 0.5])
    assert(JSON.stringify([...forward]) === JSON.stringify([...reverse]))
    assert(JSON.stringify([...forward]) === JSON.stringify([...vertical]))
    assert(forward.get(0) === 0.875 && forward.get(1) === 0.125)
})

Deno.test('projection sums source weights without renormalizing the footprint', () => {
    const ids = ['a', 'b', 'a', 'c'], weights = [0.25, 1, 0.5, 1]
    const data = projectStroke(new Map([[0, 1], [1, 0.5]]), [[0, 1], [2], [3]],
        row => weights[row], row => ids[row])
    assert(data.length === 2)
    assert(data.find(row => row.index === 'a').weight === 0.5)
    assert(data.find(row => row.index === 'b').weight === 1)
    assert(projectStroke(new Map(), [], () => 1, () => 'a').length === 0)
})

Deno.test('invalid and non-positive weights cannot create a footprint', () => {
    const weights = [NaN, Infinity, -1, 0, null, 0.4]
    const data = projectStroke(new Map([[0, 0.5]]), [[0, 1, 2, 3, 4, 5]],
        row => weights[row], row => String(row))
    assert(data.length === 1 && data[0].index === '5' && data[0].weight === 0.2)
})
