import {rankitScale} from './rankit.js'

function assert(condition, message = 'Assertion failed') {
    if (!condition) throw new Error(message)
}
function near(actual, expected) {
    assert(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`)
}

Deno.test('rankit uses finite Blom scores, compresses the median and inverts original units', () => {
    const [colour, value, n] = rankitScale([50, 10, 40, 20, 30], null, 0)
    assert(n === 5)
    near(colour(10), 0)
    near(colour(20), 0.28927913318248033) // Independent normal-distribution reference.
    near(colour(30), 0.5)
    near(colour(40), 1 - colour(20))
    near(colour(50), 1)
    assert(colour(20) > 0.25 && colour(40) < 0.75)
    for (const x of [10, 15, 20, 30, 37, 50]) near(value(colour(x)), x)
    near(colour(-100), 0)
    near(colour(100), 1)
    for (const missing of [null, undefined, '', NaN, Infinity, 'bad']) {
        assert(colour(missing) === null && value(missing) === null)
    }
    const [extreme, extremeInverse] = rankitScale([-1e308, 1e308], null, 0)
    near(extreme(0), 0.5)
    near(extremeInverse(0.5), 0)
})

Deno.test('rankit shares tie midranks and is invariant to weight units', () => {
    const sample = [10, 10, 20, 30, 40]
    const [plain] = rankitScale(sample, null, 0)
    const [equal] = rankitScale(sample, [2, 2, 2, 2, 2], 0)
    const [weighted, inverse] = rankitScale(sample, [1, 2, 3, 4, 0], 0)
    const [scaled] = rankitScale(sample, [1e300, 2e300, 3e300, 4e300, 0], 0)
    const [fallback] = rankitScale(sample, [0, 0, 0, 0, 0], 0)
    for (const x of sample) {
        near(plain(x), equal(x))
        near(plain(x), fallback(x))
        near(weighted(x), scaled(x))
    }
    assert(plain(10) > 0 && plain(10) < plain(20))
    assert(weighted(10) < weighted(20) && weighted(20) < weighted(30))
    near(inverse(weighted(20)), 20)
    near(inverse(1), 30) // Zero-weight extremes do not determine the scale.
})

Deno.test('rankit handles empty, singleton, constant, trimmed and large samples', () => {
    const [empty, emptyInverse, n] = rankitScale([])
    assert(n === 0 && empty(1) === null && emptyInverse(0.5) === null)
    for (const sample of [[7], [7, 7, 7]]) {
        const [colour, value] = rankitScale(sample)
        near(colour(7), 0.5)
        near(value(0), 7)
        near(value(1), 7)
    }
    const sample = Array.from({length: 10000}, (_, i) => i)
    for (const trim of [0, 0.01, 0.499999]) {
        const [colour, value] = rankitScale(sample, null, trim)
        let previous = 0
        for (const x of sample) {
            const c = colour(x)
            assert(Number.isFinite(c) && c >= previous && c <= 1)
            previous = c
        }
        near(value(0), 0)
        near(value(1), 9999)
    }
})
