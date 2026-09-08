import {rankitScale} from './rankit.js'

function assert(condition, message = 'Assertion failed') {
    if (!condition) throw new Error(message)
}
function near(actual, expected) {
    assert(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`)
}

Deno.test('rankit has finite Blom scores and inverts original units', () => {
    const [colour, value, n] = rankitScale([50, 10, 40, 20, 30], null, 0)
    assert(n === 5)
    near(colour(20), 0.28927913318248033) // Independent normal-distribution reference.
    near(colour(30), 0.5)
    near(colour(40), 1 - colour(20))
    for (const x of [10, 15, 20, 30, 37, 50]) near(value(colour(x)), x)
    assert(colour(-100) === 0 && colour(100) === 1)
    for (const missing of [null, '', NaN, Infinity]) assert(colour(missing) === null && value(missing) === null)
    const [extreme, inverse] = rankitScale([-1e308, 1e308], null, 0)
    near(extreme(0), 0.5)
    near(inverse(0.5), 0)
})

Deno.test('ties share midranks; weights and degenerate samples retain useful inverses', () => {
    const sample = [10, 10, 20, 30, 40]
    const [plain] = rankitScale(sample, null, 0)
    const [weighted, inverse] = rankitScale(sample, [1, 2, 3, 4, 0], 0)
    const [scaled] = rankitScale(sample, [10, 20, 30, 40, 0], 0)
    assert(plain(10) > 0 && plain(10) < plain(20))
    for (const x of sample) near(weighted(x), scaled(x))
    near(inverse(weighted(20)), 20)
    near(inverse(1), 30)
    const [empty, emptyInverse, n] = rankitScale([])
    assert(n === 0 && empty(1) === null && emptyInverse(0.5) === null)
    for (const sample of [[7], [7, 7, 7]]) {
        const [colour, value] = rankitScale(sample)
        near(colour(7), 0.5)
        near(value(1), 7)
    }
})
