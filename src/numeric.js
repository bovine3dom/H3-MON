export function toFiniteNumber(value) {
    if (value == null) return null
    if (typeof value === 'string') {
        value = value.trim()
        if (value === '') return null
    }
    if (!['bigint', 'number', 'string'].includes(typeof value)) return null
    const number = Number(value)
    return Number.isFinite(number) ? number : null
}

export function addWeightedValue(numerators, denominators, index, value, weight) {
    if (!Number.isFinite(value) || !Number.isFinite(weight)) return false
    numerators[index] += value * weight
    denominators[index] += weight
    return true
}

export function weightedMean(numerators, denominators, index) {
    return denominators[index] ? numerators[index] / denominators[index] : null
}
