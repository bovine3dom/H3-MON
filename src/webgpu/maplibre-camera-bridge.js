// MapLibre 5.24 camera bridge for a WebGPU canvas layered above the map.
// This custom layer only reads frame state; it never changes WebGL state or draws.

export const MAX_MERCATOR_LATITUDE = 85.051129
export const MAPLIBRE_WORLD_SIZE_AT_ZOOM_ZERO = 512

function finiteNumber(value, name) {
    if (!Number.isFinite(value)) throw new TypeError(`${name} must be finite`)
    return value
}

function nonNegativeNumber(value, name) {
    finiteNumber(value, name)
    if (value < 0) throw new RangeError(`${name} must not be negative`)
    return value
}

/** Copy a column-major 4x4 matrix before MapLibre reuses it. */
export function copyMatrix4(matrix, name = 'matrix') {
    if (!matrix || matrix.length !== 16) throw new TypeError(`${name} must contain 16 values`)

    const copy = new Float64Array(16)
    for (let index = 0; index < 16; index++) {
        copy[index] = finiteNumber(Number(matrix[index]), `${name}[${index}]`)
    }
    return copy
}

/**
 * Convert longitude/latitude to MapLibre's normalized Mercator square.
 * x and y are in [0, 1]; worldOffset preserves unwrapped longitudes.
 */
export function lngLatToNormalizedMercator(longitude, latitude) {
    const lng = finiteNumber(longitude, 'longitude')
    const lat = Math.max(-MAX_MERCATOR_LATITUDE, Math.min(MAX_MERCATOR_LATITUDE, finiteNumber(latitude, 'latitude')))
    const unwrappedX = (lng + 180) / 360
    const worldOffset = Math.floor(unwrappedX)
    if (!Number.isSafeInteger(worldOffset)) throw new RangeError('longitude produces an unsafe world offset')

    const latitudeRadians = lat * Math.PI / 180
    const y = (1 - Math.asinh(Math.tan(latitudeRadians)) / Math.PI) / 2
    return Object.freeze({
        x: unwrappedX - worldOffset,
        y: Math.max(0, Math.min(1, y)),
        worldOffset,
    })
}

/** Return [x, y, z] normalized Mercator coordinates for one wrapped world. */
export function mercatorWithWorldOffset(mercator, worldOffset = mercator?.worldOffset ?? 0) {
    if (!Number.isInteger(worldOffset)) throw new TypeError('worldOffset must be an integer')
    const x = finiteNumber(mercator?.x, 'mercator.x')
    const y = finiteNumber(mercator?.y, 'mercator.y')
    const z = finiteNumber(mercator?.z ?? 0, 'mercator.z')
    return new Float64Array([x + worldOffset, y, z])
}

/** Choose the copy of a normalized x coordinate nearest an unwrapped reference x. */
export function nearestMercatorWorldOffset(normalizedX, referenceWorldX) {
    return Math.round(finiteNumber(referenceWorldX, 'referenceWorldX') - finiteNumber(normalizedX, 'normalizedX'))
}

export function mapLibreWorldSize(zoom) {
    const worldSize = MAPLIBRE_WORLD_SIZE_AT_ZOOM_ZERO * 2 ** finiteNumber(zoom, 'zoom')
    if (!Number.isFinite(worldSize) || worldSize <= 0) throw new RangeError('zoom produces an invalid world size')
    return worldSize
}

/**
 * Coordinates for the captured modelViewProjectionMatrix: x/y are world
 * pixels and z is elevation in meters. Prefer webgpuMercatorProjectionMatrix
 * when normalized Mercator coordinates are already available.
 */
export function mercatorToMapLibreWorld(mercator, zoom, options = {}) {
    const worldOffset = options.worldOffset ?? mercator?.worldOffset ?? 0
    const elevationMeters = finiteNumber(options.elevationMeters ?? 0, 'elevationMeters')
    const normalized = mercatorWithWorldOffset(mercator, worldOffset)
    const worldSize = mapLibreWorldSize(zoom)
    return new Float64Array([normalized[0] * worldSize, normalized[1] * worldSize, elevationMeters])
}

/**
 * Pre-multiply a WebGL clip matrix by the z correction for WebGPU.
 * WebGL uses z in [-w, w], while WebGPU uses z in [0, w]. x/y are unchanged.
 * The Float32Array result can be written directly to a WebGPU uniform buffer.
 */
export function webglToWebGPUClipMatrix(matrix) {
    const source = copyMatrix4(matrix)
    const result = new Float32Array(16)
    for (let column = 0; column < 4; column++) {
        const offset = column * 4
        result[offset] = source[offset]
        result[offset + 1] = source[offset + 1]
        result[offset + 2] = 0.5 * (source[offset + 2] + source[offset + 3])
        result[offset + 3] = source[offset + 3]
    }
    return result
}

/** Pure canvas sizing helper, including MapLibre's possibly clamped DPR. */
export function computeCanvasMetrics({
    cssWidth,
    cssHeight,
    pixelWidth,
    pixelHeight,
    requestedPixelRatio = 1,
}) {
    cssWidth = nonNegativeNumber(cssWidth, 'cssWidth')
    cssHeight = nonNegativeNumber(cssHeight, 'cssHeight')
    pixelWidth = nonNegativeNumber(pixelWidth, 'pixelWidth')
    pixelHeight = nonNegativeNumber(pixelHeight, 'pixelHeight')
    requestedPixelRatio = finiteNumber(requestedPixelRatio, 'requestedPixelRatio')
    if (requestedPixelRatio <= 0) throw new RangeError('requestedPixelRatio must be positive')

    const pixelRatioX = cssWidth > 0 ? pixelWidth / cssWidth : requestedPixelRatio
    const pixelRatioY = cssHeight > 0 ? pixelHeight / cssHeight : requestedPixelRatio
    return Object.freeze({
        cssWidth,
        cssHeight,
        pixelWidth,
        pixelHeight,
        requestedPixelRatio,
        pixelRatio: Math.min(pixelRatioX, pixelRatioY),
        pixelRatioX,
        pixelRatioY,
    })
}

export function captureMapLibreCanvasMetrics(map, gl) {
    if (!map || typeof map.getCanvas !== 'function') throw new TypeError('map must be a MapLibre map')
    const canvas = map.getCanvas()
    const rect = typeof canvas.getBoundingClientRect === 'function' ? canvas.getBoundingClientRect() : null
    return computeCanvasMetrics({
        cssWidth: canvas.clientWidth || rect?.width || 0,
        cssHeight: canvas.clientHeight || rect?.height || 0,
        pixelWidth: gl?.drawingBufferWidth ?? canvas.width,
        pixelHeight: gl?.drawingBufferHeight ?? canvas.height,
        requestedPixelRatio: typeof map.getPixelRatio === 'function' ? map.getPixelRatio() : 1,
    })
}

/** An omitted style projection is MapLibre's default Mercator projection. */
export function mapLibreProjectionType(map) {
    if (!map || typeof map.getProjection !== 'function') throw new TypeError('map must expose getProjection()')
    return map.getProjection()?.type ?? 'mercator'
}

function unsupportedProjectionError(projectionType) {
    const error = new Error(`WebGPU camera bridge supports Mercator only; received ${projectionType}`)
    error.name = 'UnsupportedProjectionError'
    error.projectionType = projectionType
    return error
}

export function assertMercatorProjection(map) {
    const projectionType = mapLibreProjectionType(map)
    if (projectionType !== 'mercator') throw unsupportedProjectionError(projectionType)
    return projectionType
}

/** Schedule outside the custom layer while retaining the current browser paint. */
export function scheduleCameraCallback(callback) {
    if (typeof callback !== 'function') throw new TypeError('callback must be a function')
    if (typeof queueMicrotask === 'function') queueMicrotask(callback)
    else Promise.resolve().then(callback)
}

function captureCameraFrame(map, gl, renderInput, sequence) {
    const modelViewProjectionMatrix = copyMatrix4(
        renderInput?.modelViewProjectionMatrix,
        'modelViewProjectionMatrix',
    )
    const mercatorProjectionMatrix = copyMatrix4(
        renderInput?.defaultProjectionData?.mainMatrix,
        'defaultProjectionData.mainMatrix',
    )
    const zoom = finiteNumber(map.getZoom(), 'map zoom')
    const center = map.getCenter()

    return Object.freeze({
        sequence,
        projectionType: 'mercator',
        zoom,
        worldSize: mapLibreWorldSize(zoom),
        centerMercator: lngLatToNormalizedMercator(center.lng, center.lat),
        canvas: captureMapLibreCanvasMetrics(map, gl),
        modelViewProjectionMatrix,
        webgpuModelViewProjectionMatrix: webglToWebGPUClipMatrix(modelViewProjectionMatrix),
        mercatorProjectionMatrix,
        webgpuMercatorProjectionMatrix: webglToWebGPUClipMatrix(mercatorProjectionMatrix),
    })
}

/**
 * Create a MapLibre 5.24 no-op custom layer that bridges camera state to a
 * separate WebGPU overlay. onFrame is deferred and receives the latest frame
 * if a custom scheduler coalesces multiple MapLibre renders.
 *
 * @param {{
 *   id?: string,
 *   onFrame: (frame: object) => void,
 *   onUnsupportedProjection?: (error: Error) => void,
 *   schedule?: (callback: () => void) => unknown,
 * }} options
 * @returns {import('maplibre-gl').CustomLayerInterface}
 */
export function createMapLibreCameraCaptureLayer(options = {}) {
    const {
        id = 'webgpu-camera-capture',
        onFrame,
        onUnsupportedProjection,
        schedule = scheduleCameraCallback,
    } = options
    if (typeof id !== 'string' || !id) throw new TypeError('id must be a non-empty string')
    if (typeof onFrame !== 'function') throw new TypeError('onFrame must be a function')
    if (onUnsupportedProjection !== undefined && typeof onUnsupportedProjection !== 'function') {
        throw new TypeError('onUnsupportedProjection must be a function')
    }
    if (typeof schedule !== 'function') throw new TypeError('schedule must be a function')

    let map = null
    let latestFrame = null
    let scheduledToken = null
    let unsupportedProjection = null
    let sequence = 0

    function discardPendingFrame() {
        latestFrame = null
        scheduledToken = null
    }

    function reportUnsupportedProjection(projectionType) {
        discardPendingFrame()
        if (unsupportedProjection === projectionType) return
        unsupportedProjection = projectionType
        const error = unsupportedProjectionError(projectionType)
        if (onUnsupportedProjection) onUnsupportedProjection(error)
        else throw error
    }

    function queueLatestFrame() {
        if (scheduledToken) return
        const token = {}
        scheduledToken = token
        try {
            schedule(() => {
                if (scheduledToken !== token) return
                scheduledToken = null
                const frame = latestFrame
                latestFrame = null
                if (frame) onFrame(frame)
            })
        } catch (error) {
            if (scheduledToken === token) scheduledToken = null
            throw error
        }
    }

    return {
        id,
        type: 'custom',
        renderingMode: '2d',

        onAdd(nextMap) {
            map = nextMap
            sequence = 0
            unsupportedProjection = null
            const projectionType = mapLibreProjectionType(map)
            if (projectionType !== 'mercator') reportUnsupportedProjection(projectionType)
        },

        render(gl, renderInput) {
            if (!map) return
            const projectionType = mapLibreProjectionType(map)
            if (projectionType !== 'mercator') {
                reportUnsupportedProjection(projectionType)
                return
            }

            unsupportedProjection = null
            latestFrame = captureCameraFrame(map, gl, renderInput, ++sequence)
            queueLatestFrame()
        },

        onRemove() {
            map = null
            unsupportedProjection = null
            discardPendingFrame()
        },
    }
}

/** Pure, opt-in smoke checks for projection math and sizing assumptions. */
export function runCameraProjectionSelfChecks() {
    const failures = []
    const check = (condition, message) => {
        if (!condition) failures.push(message)
    }
    const close = (left, right) => Math.abs(left - right) < 1e-6

    const nullIsland = lngLatToNormalizedMercator(0, 0)
    check(close(nullIsland.x, 0.5) && close(nullIsland.y, 0.5), 'Null Island must project to (0.5, 0.5)')

    const wrapped = lngLatToNormalizedMercator(540, 0)
    check(close(wrapped.x, 0) && wrapped.worldOffset === 2, 'unwrapped longitude must preserve its world offset')

    const identity = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
    const corrected = webglToWebGPUClipMatrix(identity)
    const nearDepth = -corrected[10] + corrected[14]
    const farDepth = corrected[10] + corrected[14]
    check(close(nearDepth, 0) && close(farDepth, 1), 'clip correction must map WebGL depth [-1, 1] to WebGPU [0, 1]')

    const canvas = computeCanvasMetrics({cssWidth: 400, cssHeight: 200, pixelWidth: 800, pixelHeight: 400})
    check(close(canvas.pixelRatio, 2), 'canvas DPR must derive from backing and CSS dimensions')

    const world = mercatorToMapLibreWorld(nullIsland, 0)
    check(close(world[0], 256) && close(world[1], 256), 'zoom-zero Mercator world must be 512 pixels')

    return Object.freeze({ok: failures.length === 0, failures: Object.freeze(failures)})
}
