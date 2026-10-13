import {splitMapGet, splitMapHas, splitMapSet} from './split-index.js'

Deno.test('split index preserves all bits, values, and insertion status', () => {
    const root = new Map(), expected = new Map()
    const words = [0, 1, 0xfffff, 0x100000, 0x7fffffff, 0x80000000, 0xfffffffe, 0xffffffff]
    for (const lower of words) for (const upper of words) {
        const key = `${lower},${upper}`
        if (!splitMapSet(root, lower, upper, key)) throw Error('new key not inserted')
        expected.set(key, [lower, upper])
    }
    for (const [key, [lower, upper]] of expected) {
        if (!splitMapHas(root, lower, upper) || splitMapGet(root, lower, upper) !== key) throw Error('key collision')
        if (splitMapSet(root, lower, upper, null)) throw Error('duplicate insertion')
        if (!splitMapHas(root, lower, upper) || splitMapGet(root, lower, upper) !== null) throw Error('null lost')
    }
    if (splitMapHas(root, 123, 456) || splitMapGet(root, 123, 456) !== undefined) throw Error('missing key found')
})

Deno.test('split index groups H3 upper words without losing distinct cells', () => {
    const root = new Map()
    for (let i = 0; i < 10000; i++) splitMapSet(root, 0xffffffff, 0x08500000 + i, i)
    if (root.size !== 1) throw Error('too many prefix maps')
    for (let i = 0; i < 10000; i++) {
        if (splitMapGet(root, 0xffffffff, 0x08500000 + i) !== i) throw Error('H3 collision')
    }
})
