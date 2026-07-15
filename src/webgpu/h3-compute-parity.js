/*
 * Browser-testable parity helpers for the standalone H3 WebGPU compute module.
 * Source attribution and license notices are in h3-compute-NOTICES.md.
 */

import {
    H3_COMPUTE_BOUNDARY_SLOTS,
    H3_COMPUTE_STATUS,
    H3_COMPUTE_STATUS_NAMES,
    createH3ComputeModule,
} from './h3-compute.js'

export const H3_COMPUTE_PARITY_DEFAULT_TOLERANCE = 1e-7

const MAX_MERCATOR_LATITUDE = 85.0511287798066

function finiteNumber(value, label) {
    const number = Number(value)
    if (!Number.isFinite(number)) throw new TypeError(`${label} must be finite`)
    return number
}

function coordinatePair(value, coordinateOrder, label) {
    if (value && typeof value === 'object' && !Array.isArray(value) && !ArrayBuffer.isView(value)) {
        if (coordinateOrder === 'mercator') {
            return [finiteNumber(value.x, `${label}.x`), finiteNumber(value.y, `${label}.y`)]
        }
        const latitude = value.lat ?? value.latitude
        const longitude = value.lng ?? value.lon ?? value.longitude
        return coordinateOrder === 'lat-lng'
            ? [finiteNumber(latitude, `${label}.latitude`), finiteNumber(longitude, `${label}.longitude`)]
            : [finiteNumber(longitude, `${label}.longitude`), finiteNumber(latitude, `${label}.latitude`)]
    }
    if (!value || typeof value.length !== 'number' || value.length < 2) {
        throw new TypeError(`${label} must contain two coordinates`)
    }
    return [finiteNumber(value[0], `${label}[0]`), finiteNumber(value[1], `${label}[1]`)]
}

function degreesToMercator(longitude, latitude) {
    latitude = Math.max(-MAX_MERCATOR_LATITUDE, Math.min(MAX_MERCATOR_LATITUDE, latitude))
    const latitudeRadians = latitude * Math.PI / 180
    return [
        (longitude + 180) / 360,
        (1 - Math.log(Math.tan(Math.PI / 4 + latitudeRadians / 2)) / Math.PI) / 2,
    ]
}

function prepareCpuBoundary(boundary, {coordinates, coordinateOrder, dropClosingVertex}) {
    if (!boundary || typeof boundary.length !== 'number') {
        throw new TypeError('CPU boundary must be an array of coordinate pairs')
    }
    const points = Array.from(boundary, (value, index) => {
        const pair = coordinatePair(value, coordinates === 'mercator' ? 'mercator' : coordinateOrder, `boundary[${index}]`)
        if (coordinates === 'mercator') return pair
        const [longitude, latitude] = coordinateOrder === 'lat-lng' ? [pair[1], pair[0]] : pair
        return degreesToMercator(longitude, latitude)
    })
    if (dropClosingVertex && points.length > 1) {
        const first = points[0]
        const last = points[points.length - 1]
        const longitudeDelta = Math.abs(first[0] - last[0])
        if ((longitudeDelta < 1e-12 || Math.abs(longitudeDelta - 1) < 1e-12) && Math.abs(first[1] - last[1]) < 1e-12) {
            points.pop()
        }
    }
    return points
}

function statusName(status) {
    return H3_COMPUTE_STATUS_NAMES[status] || `unknown-${status}`
}

/**
 * Compare decoded GPU readback with supplied CPU boundaries. CPU coordinates
 * default to h3-js order `[latitude, longitude]` in degrees. Set
 * `coordinateOrder: 'lng-lat'`, or `coordinates: 'mercator'`, as needed.
 */
export function compareH3ComputeReadback(readback, cpuBoundaries, options = {}) {
    if (!readback || typeof readback.cellCount !== 'number') throw new TypeError('readback is required')
    if (!cpuBoundaries || typeof cpuBoundaries.length !== 'number') {
        throw new TypeError('cpuBoundaries must contain one entry per GPU cell')
    }
    if (cpuBoundaries.length !== readback.cellCount) {
        throw new RangeError(`Expected ${readback.cellCount} CPU boundaries, received ${cpuBoundaries.length}`)
    }

    const coordinates = options.coordinates ?? 'degrees'
    const coordinateOrder = options.coordinateOrder ?? 'lat-lng'
    const tolerance = finiteNumber(options.tolerance ?? H3_COMPUTE_PARITY_DEFAULT_TOLERANCE, 'tolerance')
    const maxFailures = options.maxFailures ?? 100
    const dropClosingVertex = options.dropClosingVertex ?? true
    const expectedStatuses = options.expectedStatuses
    if (!['degrees', 'mercator'].includes(coordinates)) {
        throw new RangeError("coordinates must be 'degrees' or 'mercator'")
    }
    if (!['lat-lng', 'lng-lat'].includes(coordinateOrder)) {
        throw new RangeError("coordinateOrder must be 'lat-lng' or 'lng-lat'")
    }
    if (tolerance < 0) throw new RangeError('tolerance must not be negative')
    if (!Number.isInteger(maxFailures) || maxFailures < 1) throw new RangeError('maxFailures must be a positive integer')
    if (expectedStatuses && expectedStatuses.length !== readback.cellCount) {
        throw new RangeError('expectedStatuses must contain one status per GPU cell')
    }

    const failures = []
    let failureCount = 0
    let supportedCells = 0
    let unsupportedCells = 0
    let comparedPoints = 0
    let maxError = 0
    const fail = failure => {
        failureCount++
        if (failures.length < maxFailures) failures.push(Object.freeze(failure))
    }

    for (let cell = 0; cell < readback.cellCount; cell++) {
        const boundary = cpuBoundaries[cell]
        const expectedStatus = Number(expectedStatuses?.[cell] ?? (
            boundary == null ? H3_COMPUTE_STATUS.UNSUPPORTED_RESOLUTION : H3_COMPUTE_STATUS.SUCCESS
        ))
        const actualStatus = readback.statuses[cell]
        const count = readback.counts[cell]
        const coordinateOffset = cell * H3_COMPUTE_BOUNDARY_SLOTS * 2

        if (actualStatus !== expectedStatus) {
            fail({
                cell,
                kind: 'status',
                expected: statusName(expectedStatus),
                actual: statusName(actualStatus),
            })
        }

        if (actualStatus !== H3_COMPUTE_STATUS.SUCCESS) {
            unsupportedCells++
            if (count !== 0) fail({cell, kind: 'unsupported-count', expected: 0, actual: count})
            for (let component = 0; component < H3_COMPUTE_BOUNDARY_SLOTS * 2; component++) {
                if (!Number.isNaN(readback.mercator[coordinateOffset + component])) {
                    fail({cell, kind: 'unsupported-slot', component, actual: readback.mercator[coordinateOffset + component]})
                    break
                }
            }
            continue
        }

        supportedCells++
        if (boundary == null) {
            fail({cell, kind: 'unexpected-supported-boundary'})
            continue
        }
        let expectedPoints
        try {
            expectedPoints = prepareCpuBoundary(boundary, {coordinates, coordinateOrder, dropClosingVertex})
        } catch (error) {
            fail({cell, kind: 'cpu-boundary', message: error.message})
            continue
        }
        if (count !== expectedPoints.length) {
            fail({cell, kind: 'count', expected: expectedPoints.length, actual: count})
        }

        const pointCount = Math.min(count, expectedPoints.length, H3_COMPUTE_BOUNDARY_SLOTS)
        for (let point = 0; point < pointCount; point++) {
            const actualX = readback.mercator[coordinateOffset + point * 2]
            const actualY = readback.mercator[coordinateOffset + point * 2 + 1]
            let [expectedX, expectedY] = expectedPoints[point]
            const finite = Number.isFinite(actualX) && Number.isFinite(actualY)
            if (finite) expectedX += Math.round(actualX - expectedX)
            const xError = finite ? Math.abs(actualX - expectedX) : Infinity
            const yError = finite ? Math.abs(actualY - expectedY) : Infinity
            const error = Math.max(xError, yError)
            maxError = Math.max(maxError, error)
            comparedPoints++
            if (!finite || error > tolerance) {
                fail({
                    cell,
                    point,
                    kind: 'coordinate',
                    expected: [expectedX, expectedY],
                    actual: [actualX, actualY],
                    error,
                })
            }
        }
        for (let point = count; point < H3_COMPUTE_BOUNDARY_SLOTS; point++) {
            const x = readback.mercator[coordinateOffset + point * 2]
            const y = readback.mercator[coordinateOffset + point * 2 + 1]
            if (!Number.isNaN(x) || !Number.isNaN(y)) {
                fail({cell, point, kind: 'unused-slot', actual: [x, y]})
                break
            }
        }
    }

    return Object.freeze({
        ok: failureCount === 0,
        cellCount: readback.cellCount,
        supportedCells,
        unsupportedCells,
        comparedPoints,
        maxError,
        tolerance,
        failureCount,
        failures: Object.freeze(failures),
    })
}

export function assertH3ComputeParity(readback, cpuBoundaries, options) {
    const report = compareH3ComputeReadback(readback, cpuBoundaries, options)
    if (!report.ok) {
        const first = report.failures[0]
        const error = new Error(`H3 WebGPU parity failed ${report.failureCount} time(s); first: ${JSON.stringify(first)}`)
        error.name = 'H3ComputeParityError'
        error.report = report
        throw error
    }
    return report
}

/**
 * Upload, dispatch, read back, and compare in a browser. Pass either an
 * existing `compute` module or `computeOptions` for temporary initialization.
 */
export async function runH3ComputeParity({
    compute = null,
    computeOptions,
    ids,
    lower,
    upper,
    cpuBoundaries,
    compareOptions,
} = {}) {
    const ownsCompute = !compute
    compute ||= await createH3ComputeModule(computeOptions)
    if (!compute) throw new Error('WebGPU is unavailable')
    let batch
    try {
        batch = ids === undefined ? compute.uploadIds(lower, upper) : compute.uploadIds(ids)
        const readback = await batch.dispatch({readback: true})
        const report = compareH3ComputeReadback(readback, cpuBoundaries, compareOptions)
        return Object.freeze({report, readback})
    } finally {
        batch?.destroy()
        if (ownsCompute) compute.destroy()
    }
}
