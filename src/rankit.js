// Acklam's inverse standard-normal approximation (absolute error < 1e-8 here).
function probit(p) {
    if (p > 0.5) return -probit(1 - p)
    if (p < 0.02425) {
        const q = Math.sqrt(-2 * Math.log(p))
        return (((((-0.007784894002430293 * q - 0.3223964580411365) * q - 2.400758277161838) * q - 2.549732539343734) * q + 4.374664141464968) * q + 2.938163982698783)
            / ((((0.007784695709041462 * q + 0.3224671290700398) * q + 2.445134137142996) * q + 3.754408661907416) * q + 1)
    }
    const q = p - 0.5, r = q * q
    return (((((-39.69683028665376 * r + 220.9460984245205) * r - 275.9285104469687) * r + 138.357751867269) * r - 30.66479806614716) * r + 2.506628277459239) * q
        / (((((-54.47609879822406 * r + 161.5858368580409) * r - 155.6989798598866) * r + 66.80131188771972) * r - 13.28068155288572) * r + 1)
}

// Input is the ECDF's finite sample, with nonnegative, finite weights.
export function rankitScale(sample, weights = null, trimFactor = 0.01) {
    let maxWeight = 0
    if (weights) for (const weight of weights) maxWeight = Math.max(maxWeight, weight)
    const pairs = sample.map((value, i) => [value, maxWeight ? weights[i] / maxWeight : 1])
        .filter(([, weight]) => weight > 0).sort((a, b) => a[0] - b[0])
    const n = pairs.length
    if (!n) return [() => null, () => null, 0]
    const total = pairs.reduce((sum, pair) => sum + pair[1], 0)
    // Midrank r = n * midpoint cumulative mass + 1/2; Blom p = (r-3/8)/(n+1/4).
    // Normalize against the finite untied extreme ranks, not infinite probits at 0/1.
    const tail = Math.max(0.625 / (n + 0.25), Math.min(0.499999, Number(trimFactor) || 0))
    const extent = -probit(tail)
    const values = [], colours = []
    let cumulative = 0
    for (let i = 0; i < n;) {
        const value = pairs[i][0]
        let mass = 0
        do { mass += pairs[i++][1] } while (i < n && pairs[i][0] === value)
        const p = (n * (cumulative + mass / 2) / total + 0.125) / (n + 0.25)
        values.push(value)
        colours.push(extent === 0 ? 0.5 : Math.max(0, Math.min(1,
            (probit(Math.max(tail, Math.min(1 - tail, p))) + extent) / (2 * extent))))
        cumulative += mass
    }
    // Piecewise-linear inversion keeps ticks in source units; clipped plateaus use endpoints.
    const interpolate = (xs, ys, target) => {
        if (target == null || target === '' || !Number.isFinite(Number(target))) return null
        target = Number(target)
        if (target <= xs[0]) return ys[0]
        if (target >= xs[xs.length - 1]) return ys[ys.length - 1]
        let lo = 0, hi = xs.length - 1
        while (hi - lo > 1) {
            const mid = (lo + hi) >> 1
            if (xs[mid] <= target) lo = mid
            else hi = mid
        }
        const span = xs[hi] - xs[lo]
        const fraction = Number.isFinite(span) ? (target - xs[lo]) / span
            : (target / 2 - xs[lo] / 2) / (xs[hi] / 2 - xs[lo] / 2)
        return ys[lo] * (1 - fraction) + ys[hi] * fraction
    }
    return [value => interpolate(values, colours, value), colour => interpolate(colours, values, colour), n]
}
