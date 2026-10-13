// Keep all 64 bits. A 12-bit prefix and a 52-bit integer are exact Numbers.
// H3 cells share prefixes, so this avoids a Map for each upper 32-bit word.
const lowKey = (lower, upper) => (upper & 0xfffff) * 0x100000000 + (lower >>> 0)

export function splitMapGet(root, lower, upper) {
    return root.get(upper >>> 20)?.get(lowKey(lower, upper))
}

export function splitMapHas(root, lower, upper) {
    return root.get(upper >>> 20)?.has(lowKey(lower, upper)) ?? false
}

export function splitMapSet(root, lower, upper, value) {
    const prefix = upper >>> 20
    let values = root.get(prefix)
    if (!values) root.set(prefix, values = new Map())
    const key = lowKey(lower, upper)
    const isNew = !values.has(key)
    values.set(key, value)
    return isNew
}
