/**
 * Standalone WebGPU overlay for `faster-h3-for-deckgl` packed H3 geometry.
 *
 * The renderer owns a transparent, pointer-transparent canvas placed directly
 * above a MapLibre canvas. It does not share MapLibre's WebGL context. A small
 * custom-layer bridge snapshots MapLibre's Mercator model-view-projection
 * matrix and submits the WebGPU overlay in the same map frame:
 *
 * ```js
 * const renderer = await createPackedH3Renderer({
 *     mapCanvas: map.getCanvas(),
 *     transitionDuration: 300,
 * })
 * if (renderer) {
 *     renderer.addChunk('0', packedGeometry, rgbaBytes)
 *     map.addLayer(createMapLibreMatrixLayer(renderer))
 *     await renderer.waitForRender()
 * }
 * ```
 *
 * Geometry must contain interleaved Float64 `[lng, lat]` `positions`, global
 * Uint32 triangle `indices`, and Uint32 `startIndices` with one range per
 * source cell. Colors are supplied once per source cell, in that same order.
 * A compact Uint32 cell ID beside each vertex lets the fragment shader fetch a
 * packed RGBA8 color without expanding colors over vertices or triangles.
 *
 * Longitude/latitude is projected once on the CPU. Positions are stored as
 * f32 offsets from a per-chunk Mercator origin; that origin is folded into each
 * matrix in float64 before its f32 upload. Keep source chunks geographically
 * local for the best high-zoom precision. Latitudes are clamped to Web
 * Mercator's limits. The renderer is Mercator-only, is always composited above
 * the complete map canvas, and does not provide picking or share map depth,
 * terrain occlusion, globe projection, or MapLibre style-layer order. Device
 * loss is terminal; recreate the renderer in `onDeviceLost` if desired.
 * WebGPU absence is non-fatal: `createPackedH3Renderer()` returns `null`.
 */

const MAX_MERCATOR_LATITUDE = 85.0511287798066
const MAPLIBRE_WORLD_SIZE_AT_ZOOM_ZERO = 512
const NO_HIGHLIGHT = 0xffffffff
const STYLE_UNIFORM_SIZE = 16
const MATRIX_SIZE = 16
const MATRIX_BYTES = MATRIX_SIZE * 4

const BUFFER_USAGE = globalThis.GPUBufferUsage || {
    COPY_DST: 0x0008,
    INDEX: 0x0010,
    VERTEX: 0x0020,
    UNIFORM: 0x0040,
    STORAGE: 0x0080,
}
const SHADER_STAGE = globalThis.GPUShaderStage || {
    VERTEX: 0x1,
    FRAGMENT: 0x2,
}
const TEXTURE_USAGE = globalThis.GPUTextureUsage || {
    RENDER_ATTACHMENT: 0x10,
}
const SHADER_SOURCE = /* wgsl */ `
struct StyleUniforms {
    transition: f32,
    highlightAmount: f32,
    highlightCell: u32,
    highlightColor: u32,
}

@group(0) @binding(0) var<uniform> style: StyleUniforms;
@group(0) @binding(1) var<storage, read> colorsFrom: array<u32>;
@group(0) @binding(2) var<storage, read> colorsTo: array<u32>;

struct VertexInput {
    @location(0) position: vec2<f32>,
    @location(1) cell: u32,
    @location(2) matrix0: vec4<f32>,
    @location(3) matrix1: vec4<f32>,
    @location(4) matrix2: vec4<f32>,
    @location(5) matrix3: vec4<f32>,
}

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) @interpolate(flat) cell: u32,
}

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    let matrix = mat4x4<f32>(input.matrix0, input.matrix1, input.matrix2, input.matrix3);
    let clip = matrix * vec4<f32>(input.position, 0.0, 1.0);
    var output: VertexOutput;
    // This canvas is depthless. A midpoint z converts the GL matrix's depth
    // range into WebGPU's range without changing x, y, or perspective.
    output.position = vec4<f32>(clip.xy, clip.w * 0.5, clip.w);
    output.cell = input.cell;
    return output;
}

fn unpackRgba8(value: u32) -> vec4<f32> {
    return vec4<f32>(
        f32(value & 255u),
        f32((value >> 8u) & 255u),
        f32((value >> 16u) & 255u),
        f32((value >> 24u) & 255u)
    ) / 255.0;
}

@fragment
fn fragmentMain(@location(0) @interpolate(flat) cell: u32) -> @location(0) vec4<f32> {
    var color = mix(unpackRgba8(colorsFrom[cell]), unpackRgba8(colorsTo[cell]), style.transition);
    if (cell == style.highlightCell) {
        color = mix(color, unpackRgba8(style.highlightColor), style.highlightAmount);
    }

    // The render target and browser compositor both use premultiplied alpha.
    return vec4<f32>(color.rgb * color.a, color.a);
}
`

function now() {
    return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()
}

function align4(value) {
    return Math.max(4, Math.ceil(value / 4) * 4)
}

function finiteNumber(value, label) {
    const number = Number(value)
    if (!Number.isFinite(number)) throw new TypeError(`${label} must be finite`)
    return number
}

function byte(value, label) {
    return Math.min(255, Math.max(0, Math.round(finiteNumber(value, label))))
}

function packRgba(r, g, b, a) {
    return (r | (g << 8) | (b << 16) | (a << 24)) >>> 0
}

function packSingleColor(color, label = 'color') {
    if (!color || typeof color.length !== 'number' || color.length < 3) {
        throw new TypeError(`${label} must be an [r, g, b] or [r, g, b, a] array`)
    }
    return packRgba(
        byte(color[0], `${label}[0]`),
        byte(color[1], `${label}[1]`),
        byte(color[2], `${label}[2]`),
        color[3] == null ? 255 : byte(color[3], `${label}[3]`),
    )
}

function packColors(colors, cellCount) {
    if (!colors || typeof colors.length !== 'number') {
        throw new TypeError('colors must be a flat RGBA array or one RGBA array per source cell')
    }

    const packed = new Uint32Array(cellCount)
    const first = colors[0]
    const nested = cellCount > 0 && first != null && typeof first !== 'number' && typeof first.length === 'number'
    if (nested) {
        if (colors.length !== cellCount) {
            throw new RangeError(`Expected ${cellCount} cell colors, received ${colors.length}`)
        }
        for (let i = 0; i < cellCount; i++) packed[i] = packSingleColor(colors[i], `colors[${i}]`)
        return packed
    }

    if (colors.length !== cellCount * 4) {
        throw new RangeError(`Expected ${cellCount * 4} flat RGBA channels, received ${colors.length}`)
    }
    for (let i = 0; i < cellCount; i++) {
        const offset = i * 4
        packed[i] = packRgba(
            byte(colors[offset], `colors[${offset}]`),
            byte(colors[offset + 1], `colors[${offset + 1}]`),
            byte(colors[offset + 2], `colors[${offset + 2}]`),
            byte(colors[offset + 3], `colors[${offset + 3}]`),
        )
    }
    return packed
}

function colorsEqual(a, b) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false
    }
    return true
}

function easeTransition(value) {
    const t = Math.min(1, Math.max(0, value))
    return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2
}

function mixPackedColors(from, to, amount) {
    const mixed = new Uint32Array(from.length)
    const inverse = 1 - amount
    for (let i = 0; i < mixed.length; i++) {
        const a = from[i]
        const b = to[i]
        mixed[i] = packRgba(
            Math.round((a & 255) * inverse + (b & 255) * amount),
            Math.round(((a >>> 8) & 255) * inverse + ((b >>> 8) & 255) * amount),
            Math.round(((a >>> 16) & 255) * inverse + ((b >>> 16) & 255) * amount),
            Math.round((a >>> 24) * inverse + (b >>> 24) * amount),
        )
    }
    return mixed
}

function mercatorX(lng) {
    return (180 + lng) / 360
}

function mercatorY(lat) {
    const clamped = Math.min(MAX_MERCATOR_LATITUDE, Math.max(-MAX_MERCATOR_LATITUDE, lat))
    return (180 - 180 / Math.PI * Math.log(Math.tan(Math.PI / 4 + clamped * Math.PI / 360))) / 360
}

function validateGeometry(geometry) {
    if (!geometry || typeof geometry !== 'object') throw new TypeError('geometry is required')
    const {positions, indices, startIndices} = geometry
    if (!(positions instanceof Float64Array)) throw new TypeError('geometry.positions must be a Float64Array')
    if (!(indices instanceof Uint32Array)) throw new TypeError('geometry.indices must be a Uint32Array')
    if (!(startIndices instanceof Uint32Array)) throw new TypeError('geometry.startIndices must be a Uint32Array')
    if (positions.length % 2 !== 0) throw new RangeError('geometry.positions must contain [lng, lat] pairs')
    if (indices.length % 3 !== 0) throw new RangeError('geometry.indices length must be divisible by 3')
    if (startIndices.length === 0) throw new RangeError('geometry.startIndices must include a final sentinel')

    const cellCount = startIndices.length - 1
    const vertexCount = positions.length / 2
    const triangleCount = indices.length / 3
    if (geometry.length != null && geometry.length !== cellCount) {
        throw new RangeError(`geometry.length is ${geometry.length}, but startIndices describes ${cellCount} cells`)
    }
    if (geometry.vertexCount != null && geometry.vertexCount !== vertexCount) {
        throw new RangeError(`geometry.vertexCount is ${geometry.vertexCount}, but positions contains ${vertexCount} vertices`)
    }
    if (geometry.triangleCount != null && geometry.triangleCount !== triangleCount) {
        throw new RangeError(`geometry.triangleCount is ${geometry.triangleCount}, but indices contains ${triangleCount} triangles`)
    }
    if (startIndices[0] !== 0 || startIndices[cellCount] !== vertexCount) {
        throw new RangeError('startIndices must begin at 0 and end at the position vertex count')
    }
    if (cellCount >= NO_HIGHLIGHT) throw new RangeError('A chunk cannot contain 2^32 - 1 source cells')

    for (let cell = 0; cell < cellCount; cell++) {
        if (startIndices[cell] > startIndices[cell + 1]) {
            throw new RangeError(`startIndices is not monotonic at source cell ${cell}`)
        }
    }
    return {positions, indices, startIndices, cellCount, vertexCount, triangleCount}
}

function prepareGeometry(geometry) {
    const validated = validateGeometry(geometry)
    const {positions, indices, startIndices, cellCount, vertexCount, triangleCount} = validated
    const projected = new Float64Array(vertexCount * 2)
    const vertexCells = new Uint32Array(vertexCount)
    let referenceX = null
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity

    for (let cell = 0; cell < cellCount; cell++) {
        const start = startIndices[cell]
        const end = startIndices[cell + 1]
        if (start === end) continue

        const referenceLng = finiteNumber(positions[start * 2], `positions[${start * 2}]`)
        let meanX = 0
        for (let vertex = start; vertex < end; vertex++) {
            let lng = finiteNumber(positions[vertex * 2], `positions[${vertex * 2}]`)
            const lat = finiteNumber(positions[vertex * 2 + 1], `positions[${vertex * 2 + 1}]`)
            if (lat < -90 || lat > 90) throw new RangeError(`Latitude ${lat} is outside [-90, 90]`)
            lng += Math.round((referenceLng - lng) / 360) * 360
            const x = mercatorX(lng)
            projected[vertex * 2] = x
            projected[vertex * 2 + 1] = mercatorY(lat)
            meanX += x
            vertexCells[vertex] = cell
        }

        meanX /= end - start
        if (referenceX === null) referenceX = meanX - Math.floor(meanX)
        const worldShift = Math.round(referenceX - meanX)
        for (let vertex = start; vertex < end; vertex++) {
            const offset = vertex * 2
            const x = projected[offset] + worldShift
            const y = projected[offset + 1]
            projected[offset] = x
            if (x < minX) minX = x
            if (x > maxX) maxX = x
            if (y < minY) minY = y
            if (y > maxY) maxY = y
        }
    }

    for (let triangle = 0; triangle < triangleCount; triangle++) {
        const offset = triangle * 3
        const a = indices[offset]
        const b = indices[offset + 1]
        const c = indices[offset + 2]
        if (a >= vertexCount || b >= vertexCount || c >= vertexCount) {
            throw new RangeError(`Triangle ${triangle} references a vertex outside geometry.positions`)
        }
        const cell = vertexCells[a]
        if (vertexCells[b] !== cell || vertexCells[c] !== cell) {
            throw new RangeError(`Triangle ${triangle} crosses source-cell ranges and cannot have one cell color`)
        }
    }

    const originX = vertexCount ? (minX + maxX) / 2 : 0.5
    const originY = vertexCount ? (minY + maxY) / 2 : 0.5
    const vertexData = new ArrayBuffer(vertexCount * 12)
    const localPositions = new Float32Array(vertexData)
    const localCells = new Uint32Array(vertexData)
    for (let i = 0; i < vertexCount; i++) {
        localPositions[i * 3] = projected[i * 2] - originX
        localPositions[i * 3 + 1] = projected[i * 2 + 1] - originY
        localCells[i * 3 + 2] = vertexCells[i]
    }

    return {
        ...validated,
        vertexData,
        originX,
        originY,
    }
}

function dataBytes(data) {
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    if (data instanceof ArrayBuffer) return new Uint8Array(data)
    throw new TypeError('GPU buffer data must be an ArrayBuffer or typed array')
}

function createBuffer(device, label, usage, data, minimumSize = 4) {
    const bytes = dataBytes(data)
    const buffer = device.createBuffer({
        label,
        size: align4(Math.max(minimumSize, bytes.byteLength)),
        usage,
        mappedAtCreation: true,
    })
    try {
        new Uint8Array(buffer.getMappedRange()).set(bytes)
        buffer.unmap()
    } catch (error) {
        buffer.destroy()
        throw error
    }
    return buffer
}

function prepareWorldCopies(value) {
    if (value === false) value = 0
    if (value === true || value == null) value = 1

    if (typeof value === 'number') {
        if (!Number.isInteger(value) || value < 0) throw new RangeError('worldCopies must be a non-negative radius')
        return value
    }

    if (typeof value === 'string' || !value || typeof value[Symbol.iterator] !== 'function') {
        throw new TypeError('worldCopies must be false, true, a radius, or an iterable of world indices')
    }
    const copies = []
    const seen = new Set()
    for (const entry of value) {
        const copy = finiteNumber(entry, 'world copy')
        if (!Number.isInteger(copy)) throw new RangeError('World copy indices must be integers')
        if (!seen.has(copy)) {
            seen.add(copy)
            copies.push(copy)
        }
    }
    return copies
}

function worldCopiesForChunk(config, centerMercatorX, originX) {
    if (typeof config !== 'number') return config
    const centerCopy = Math.round(centerMercatorX - originX)
    const copies = []
    for (let copy = centerCopy - config; copy <= centerCopy + config; copy++) copies.push(copy)
    return copies
}

function copyLocalMatrix(matrix, x, y, worldSize, target, offset) {
    for (let row = 0; row < 4; row++) {
        target[offset + row] = matrix[row] * worldSize
        target[offset + 4 + row] = matrix[4 + row] * worldSize
        target[offset + 8 + row] = matrix[8 + row]
        target[offset + 12 + row] = (
            matrix[row] * x * worldSize + matrix[4 + row] * y * worldSize + matrix[12 + row]
        )
    }
}

function matrixSnapshot(matrix) {
    if (!matrix || matrix.length !== MATRIX_SIZE) throw new TypeError('modelViewProjectionMatrix must contain 16 numbers')
    const snapshot = new Float64Array(MATRIX_SIZE)
    for (let i = 0; i < MATRIX_SIZE; i++) snapshot[i] = finiteNumber(matrix[i], `modelViewProjectionMatrix[${i}]`)
    return snapshot
}

function createOverlayCanvas(mapCanvas, options) {
    if (!mapCanvas || typeof mapCanvas.getContext !== 'function' || !mapCanvas.ownerDocument) {
        throw new TypeError('mapCanvas must be a DOM canvas')
    }
    const parent = mapCanvas.parentElement
    if (!parent) throw new Error('mapCanvas must be attached to a parent element')

    const canvas = mapCanvas.ownerDocument.createElement('canvas')
    canvas.className = options.className || 'webgpu-packed-h3-overlay'
    canvas.setAttribute('aria-hidden', 'true')
    canvas.style.position = 'absolute'
    canvas.style.display = 'block'
    canvas.style.pointerEvents = 'none'
    canvas.style.background = 'transparent'
    canvas.style.mixBlendMode = options.mixBlendMode || 'multiply'
    canvas.style.border = '0'
    canvas.style.padding = '0'
    canvas.style.margin = '0'
    canvas.style.zIndex = String(options.zIndex ?? 1)
    parent.appendChild(canvas)
    return canvas
}

function createPipeline(device, format, sampleCount) {
    const bindGroupLayout = device.createBindGroupLayout({
        label: 'packed-h3 bindings',
        entries: [
            {binding: 0, visibility: SHADER_STAGE.FRAGMENT, buffer: {type: 'uniform'}},
            {binding: 1, visibility: SHADER_STAGE.FRAGMENT, buffer: {type: 'read-only-storage'}},
            {binding: 2, visibility: SHADER_STAGE.FRAGMENT, buffer: {type: 'read-only-storage'}},
        ],
    })
    const module = device.createShaderModule({label: 'packed-h3 shader', code: SHADER_SOURCE})
    const layout = device.createPipelineLayout({label: 'packed-h3 pipeline layout', bindGroupLayouts: [bindGroupLayout]})
    const descriptor = {
        label: 'packed-h3 pipeline',
        layout,
        vertex: {
            module,
            entryPoint: 'vertexMain',
            buffers: [
                {
                    arrayStride: 12,
                    stepMode: 'vertex',
                    attributes: [
                        {shaderLocation: 0, offset: 0, format: 'float32x2'},
                        {shaderLocation: 1, offset: 8, format: 'uint32'},
                    ],
                },
                {
                    arrayStride: MATRIX_BYTES,
                    stepMode: 'instance',
                    attributes: [
                        {shaderLocation: 2, offset: 0, format: 'float32x4'},
                        {shaderLocation: 3, offset: 16, format: 'float32x4'},
                        {shaderLocation: 4, offset: 32, format: 'float32x4'},
                        {shaderLocation: 5, offset: 48, format: 'float32x4'},
                    ],
                },
            ],
        },
        fragment: {
            module,
            entryPoint: 'fragmentMain',
            targets: [{
                format,
                blend: {
                    color: {operation: 'add', srcFactor: 'one', dstFactor: 'one-minus-src-alpha'},
                    alpha: {operation: 'add', srcFactor: 'one', dstFactor: 'one-minus-src-alpha'},
                },
            }],
        },
        primitive: {topology: 'triangle-list', cullMode: 'none'},
        multisample: {count: sampleCount},
    }
    const pipelinePromise = typeof device.createRenderPipelineAsync === 'function'
        ? device.createRenderPipelineAsync(descriptor)
        : Promise.resolve(device.createRenderPipeline(descriptor))
    return pipelinePromise.then(pipeline => ({pipeline, bindGroupLayout}))
}

class PackedH3Renderer {
    constructor({adapter, device, context, canvas, mapCanvas, format, pipeline, bindGroupLayout, options}) {
        this.adapter = adapter
        this.device = device
        this.context = context
        this.canvas = canvas
        this.mapCanvas = mapCanvas
        this.format = format
        this._sampleCount = options.sampleCount
        this._msaaTexture = null
        this.state = 'ready'
        this.lossInfo = null

        this._pipeline = pipeline
        this._bindGroupLayout = bindGroupLayout
        this._transitionDuration = Math.max(0, finiteNumber(options.transitionDuration ?? 0, 'transitionDuration'))
        this._worldCopiesConfig = prepareWorldCopies(options.worldCopies)
        this._centerMercatorX = 0.5
        this._requestRenderCallback = options.requestRender || null
        this._onDeviceLost = options.onDeviceLost || null
        this._chunks = new Map()
        this._highlight = null
        this._matrix = null
        this._worldSize = null
        this._matrixBuffer = null
        this._matrixCapacity = 0
        this._matrixStaging = null
        this._waiters = []
        this._frame = 0
        this._needsRender = true
        this._requestQueued = false
        this._terminalError = null

        this._syncCanvasSize()

        const ownerWindow = mapCanvas.ownerDocument.defaultView
        const ResizeObserverClass = ownerWindow?.ResizeObserver || globalThis.ResizeObserver
        this._resizeObserver = ResizeObserverClass ? new ResizeObserverClass(() => this._markDirty()) : null
        this._resizeObserver?.observe(mapCanvas)

        device.lost.then(info => this._handleDeviceLoss(info))
        this._scheduleRenderRequest()
    }

    _assertReady() {
        if (this.state !== 'ready') throw this._terminalError || new Error(`Packed H3 renderer is ${this.state}`)
    }

    _checkBufferSize(byteLength, label, storage = false) {
        const size = align4(byteLength)
        if (size > this.device.limits.maxBufferSize) {
            throw new RangeError(`${label} needs ${size} bytes, exceeding maxBufferSize`)
        }
        if (storage && size > this.device.limits.maxStorageBufferBindingSize) {
            throw new RangeError(`${label} needs ${size} bytes, exceeding maxStorageBufferBindingSize`)
        }
    }

    _createBindGroup(chunk) {
        return this.device.createBindGroup({
            label: `packed-h3 ${chunk.id} bindings`,
            layout: this._bindGroupLayout,
            entries: [
                {binding: 0, resource: {buffer: chunk.styleBuffer}},
                {binding: 1, resource: {buffer: chunk.colorFromBuffer}},
                {binding: 2, resource: {buffer: chunk.colorToBuffer}},
            ],
        })
    }

    _destroyChunk(chunk) {
        chunk.positionBuffer.destroy()
        chunk.indexBuffer.destroy()
        chunk.colorFromBuffer.destroy()
        chunk.colorToBuffer.destroy()
        chunk.styleBuffer.destroy()
    }

    _releaseGpuResources() {
        for (const chunk of this._chunks.values()) this._destroyChunk(chunk)
        this._chunks.clear()
        this._matrixBuffer?.destroy()
        this._matrixBuffer = null
        this._matrixCapacity = 0
        this._matrixStaging = null
        this._msaaTexture?.destroy()
        this._msaaTexture = null
        this.context.unconfigure?.()
    }

    _currentColors(chunk, timestamp) {
        if (chunk.transitionDuration <= 0) return chunk.colorsTo
        const progress = (timestamp - chunk.transitionStart) / chunk.transitionDuration
        if (progress >= 1) {
            chunk.transitionDuration = 0
            chunk.colorsFrom = chunk.colorsTo
            return chunk.colorsTo
        }
        return mixPackedColors(chunk.colorsFrom, chunk.colorsTo, easeTransition(progress))
    }

    _markDirty() {
        if (this.state !== 'ready') return false
        this._needsRender = true
        return this._scheduleRenderRequest()
    }

    _scheduleRenderRequest() {
        if (this.state !== 'ready' || !this._requestRenderCallback || this._requestQueued) return false
        this._requestQueued = true
        const run = () => {
            if (!this._requestQueued) return
            this._requestQueued = false
            if (this.state === 'ready' && this._requestRenderCallback) this._requestRenderCallback()
        }
        if (typeof queueMicrotask === 'function') queueMicrotask(run)
        else Promise.resolve().then(run)
        return true
    }

    _syncCanvasSize() {
        const width = this.mapCanvas.width
        const height = this.mapCanvas.height
        if (width > this.device.limits.maxTextureDimension2D || height > this.device.limits.maxTextureDimension2D) {
            throw new RangeError(`MapLibre canvas ${width}x${height} exceeds WebGPU maxTextureDimension2D`)
        }

        let changed = false
        if (this.canvas.width !== width) {
            this.canvas.width = width
            changed = true
        }
        if (this.canvas.height !== height) {
            this.canvas.height = height
            changed = true
        }

        const cssWidth = this.mapCanvas.style.width || `${this.mapCanvas.clientWidth}px`
        const cssHeight = this.mapCanvas.style.height || `${this.mapCanvas.clientHeight}px`
        const left = `${this.mapCanvas.offsetLeft}px`
        const top = `${this.mapCanvas.offsetTop}px`
        if (this.canvas.style.width !== cssWidth) {
            this.canvas.style.width = cssWidth
            changed = true
        }
        if (this.canvas.style.height !== cssHeight) {
            this.canvas.style.height = cssHeight
            changed = true
        }
        if (this.canvas.style.left !== left) {
            this.canvas.style.left = left
            changed = true
        }
        if (this.canvas.style.top !== top) {
            this.canvas.style.top = top
            changed = true
        }

        if (changed) {
            this._msaaTexture?.destroy()
            this._msaaTexture = null
            if (width && height && this._sampleCount > 1) {
                this._msaaTexture = this.device.createTexture({
                    label: 'packed-h3 multisample target',
                    size: [width, height],
                    format: this.format,
                    sampleCount: this._sampleCount,
                    usage: TEXTURE_USAGE.RENDER_ATTACHMENT,
                })
            }
        }

        return changed
    }

    _ensureMatrixCapacity(entryCount) {
        if (entryCount <= this._matrixCapacity) return
        let capacity = Math.max(1, this._matrixCapacity)
        while (capacity < entryCount) capacity *= 2
        const byteLength = capacity * MATRIX_BYTES
        this._checkBufferSize(byteLength, 'World-copy matrix buffer')
        const next = this.device.createBuffer({
            label: 'packed-h3 world-copy matrices',
            size: byteLength,
            usage: BUFFER_USAGE.VERTEX | BUFFER_USAGE.COPY_DST,
        })
        this._matrixBuffer?.destroy()
        this._matrixBuffer = next
        this._matrixCapacity = capacity
        this._matrixStaging = new Float32Array(capacity * MATRIX_SIZE)
    }

    _rejectWaiters(error) {
        const waiters = this._waiters.splice(0)
        for (const waiter of waiters) waiter.reject(error)
    }

    _finishWaiters(frame) {
        const waiters = this._waiters.splice(0)
        if (!waiters.length) return
        let completion
        try {
            completion = typeof this.device.queue.onSubmittedWorkDone === 'function'
                ? this.device.queue.onSubmittedWorkDone()
                : Promise.resolve()
        } catch (error) {
            for (const waiter of waiters) waiter.reject(error)
            return
        }
        completion.then(() => {
            if (this.state === 'ready') {
                for (const waiter of waiters) waiter.resolve(frame)
            } else {
                const error = this._terminalError || new Error(`Packed H3 renderer is ${this.state}`)
                for (const waiter of waiters) waiter.reject(error)
            }
        }, error => {
            for (const waiter of waiters) waiter.reject(error)
        })
    }

    _handleDeviceLoss(info) {
        if (this.state !== 'ready') return
        this.state = 'lost'
        this.lossInfo = info
        this._terminalError = new Error(`WebGPU device lost: ${info.message || info.reason || 'unknown reason'}`)
        this._requestQueued = false
        this._requestRenderCallback = null
        this._resizeObserver?.disconnect()
        this._rejectWaiters(this._terminalError)
        this._releaseGpuResources()
        this.canvas.style.visibility = 'hidden'
        if (this._onDeviceLost) {
            try {
                this._onDeviceLost(info, this)
            } catch (error) {
                console.error('Packed H3 onDeviceLost callback failed', error)
            }
        }
    }

    /**
     * Add one packed geometry chunk. `colors` is either a flat sequence of
     * `cellCount * 4` RGBA byte channels or one RGB/RGBA array per source cell.
     * Source-cell order is exactly the order represented by `startIndices`.
     */
    addChunk(id, geometry, colors) {
        this._assertReady()
        if (typeof id !== 'string' || !id) throw new TypeError('Chunk id must be a non-empty string')
        if (this._chunks.has(id)) throw new Error(`Chunk "${id}" already exists`)

        const prepared = prepareGeometry(geometry)
        const packedColors = packColors(colors, prepared.cellCount)
        this._checkBufferSize(prepared.vertexData.byteLength, `Chunk "${id}" vertices`)
        this._checkBufferSize(prepared.indices.byteLength, `Chunk "${id}" indices`)
        this._checkBufferSize(packedColors.byteLength, `Chunk "${id}" colors`, true)

        const buffers = []
        try {
            const positionBuffer = createBuffer(this.device, `packed-h3 ${id} vertices`, BUFFER_USAGE.VERTEX, prepared.vertexData)
            buffers.push(positionBuffer)
            const indexBuffer = createBuffer(this.device, `packed-h3 ${id} indices`, BUFFER_USAGE.INDEX, prepared.indices)
            buffers.push(indexBuffer)
            const colorFromBuffer = createBuffer(
                this.device,
                `packed-h3 ${id} colors from`,
                BUFFER_USAGE.STORAGE | BUFFER_USAGE.COPY_DST,
                packedColors,
            )
            buffers.push(colorFromBuffer)
            const colorToBuffer = createBuffer(
                this.device,
                `packed-h3 ${id} colors to`,
                BUFFER_USAGE.STORAGE | BUFFER_USAGE.COPY_DST,
                packedColors,
            )
            buffers.push(colorToBuffer)
            const styleBuffer = this.device.createBuffer({
                label: `packed-h3 ${id} style`,
                size: STYLE_UNIFORM_SIZE,
                usage: BUFFER_USAGE.UNIFORM | BUFFER_USAGE.COPY_DST,
            })
            buffers.push(styleBuffer)

            const styleStaging = new ArrayBuffer(STYLE_UNIFORM_SIZE)
            const chunk = {
                id,
                cellCount: prepared.cellCount,
                indexCount: prepared.indices.length,
                originX: prepared.originX,
                originY: prepared.originY,
                positionBuffer,
                indexBuffer,
                colorFromBuffer,
                colorToBuffer,
                styleBuffer,
                styleStaging,
                styleFloats: new Float32Array(styleStaging),
                styleUints: new Uint32Array(styleStaging),
                colorsFrom: packedColors,
                colorsTo: packedColors,
                transitionStart: 0,
                transitionDuration: 0,
                bindGroup: null,
                matrixByteOffset: 0,
                frameWorldCopies: [],
            }
            chunk.bindGroup = this._createBindGroup(chunk)
            this._chunks.set(id, chunk)
        } catch (error) {
            for (const buffer of buffers) buffer.destroy()
            throw error
        }

        this._markDirty()
        return this
    }

    /** Remove a chunk and immediately destroy all of its GPU buffers. */
    removeChunk(id) {
        const chunk = this._chunks.get(id)
        if (!chunk) return false
        this._destroyChunk(chunk)
        this._chunks.delete(id)
        if (this._highlight?.chunkId === id) this._highlight = null
        this._markDirty()
        return true
    }

    /**
     * Replace one RGBA color per source cell. `duration` is milliseconds; the
     * default is the renderer's `transitionDuration`. Interrupted transitions
     * continue from their currently displayed, byte-quantized colors.
     */
    updateColors(id, colors, {duration = this._transitionDuration} = {}) {
        this._assertReady()
        const chunk = this._chunks.get(id)
        if (!chunk) throw new Error(`Unknown chunk "${id}"`)
        duration = Math.max(0, finiteNumber(duration, 'duration'))

        const target = packColors(colors, chunk.cellCount)
        const timestamp = now()
        const current = this._currentColors(chunk, timestamp)
        const animate = duration > 0 && !colorsEqual(current, target)
        chunk.colorsFrom = animate ? current : target
        chunk.colorsTo = target
        chunk.transitionStart = timestamp
        chunk.transitionDuration = animate ? duration : 0
        if (target.byteLength) {
            this.device.queue.writeBuffer(chunk.colorFromBuffer, 0, chunk.colorsFrom)
            this.device.queue.writeBuffer(chunk.colorToBuffer, 0, target)
        }
        this._markDirty()
        return this
    }

    /**
     * Highlight one source cell, or pass `null` to clear. The object shape is
     * `{chunkId, cellIndex, color?: [r,g,b,a], amount?: 0..1}`.
     */
    setHighlight(highlight) {
        this._assertReady()
        if (highlight == null) {
            this._highlight = null
        } else {
            const chunk = this._chunks.get(highlight.chunkId)
            if (!chunk) throw new Error(`Unknown chunk "${highlight.chunkId}"`)
            if (!Number.isInteger(highlight.cellIndex) || highlight.cellIndex < 0 || highlight.cellIndex >= chunk.cellCount) {
                throw new RangeError(`Highlight cellIndex must be in [0, ${chunk.cellCount})`)
            }
            const amount = finiteNumber(highlight.amount ?? 0.65, 'highlight.amount')
            this._highlight = {
                chunkId: highlight.chunkId,
                cellIndex: highlight.cellIndex,
                color: packSingleColor(highlight.color || [255, 255, 255, 255], 'highlight.color'),
                amount: Math.min(1, Math.max(0, amount)),
            }
        }
        this._markDirty()
        return this
    }

    /**
     * Snapshot a MapLibre Mercator model-view-projection matrix for a later
     * `render()`. A numeric `worldCopies` value is a radius around
     * `centerMercatorX`; an iterable supplies exact integer world indices.
     * MapLibre's matrix uses world pixels, so `worldSize` is required on the
     * first snapshot (`512 * 2 ** map.getZoom()`).
     */
    setModelViewProjectionMatrix(matrix, options = {}) {
        this._assertReady()
        this._setView(matrix, options)
        this._markDirty()
        return this
    }

    _setView(matrix, options) {
        const snapshot = matrixSnapshot(matrix)
        const worldCopiesConfig = options.worldCopies !== undefined
            ? prepareWorldCopies(options.worldCopies)
            : this._worldCopiesConfig
        let centerMercatorX = this._centerMercatorX
        let worldSize = this._worldSize
        if (options.worldSize !== undefined) {
            worldSize = finiteNumber(options.worldSize, 'worldSize')
            if (worldSize <= 0) throw new RangeError('worldSize must be positive')
        }
        if (worldSize === null) throw new TypeError('worldSize is required with a MapLibre modelViewProjectionMatrix')
        if (options.centerMercatorX !== undefined) {
            centerMercatorX = finiteNumber(options.centerMercatorX, 'centerMercatorX')
        }
        this._matrix = snapshot
        this._worldCopiesConfig = worldCopiesConfig
        this._centerMercatorX = centerMercatorX
        this._worldSize = worldSize
    }

    /** Set or replace the callback used to request the host's next map frame. */
    setRequestRender(callback) {
        if (callback != null && typeof callback !== 'function') throw new TypeError('requestRender callback must be a function')
        this._requestRenderCallback = callback
        if (callback && this._needsRender) this._scheduleRenderRequest()
        return this
    }

    /** Request a host frame through the configured callback. */
    requestRender() {
        return this._markDirty()
    }

    /** Synchronize the overlay's backing and CSS dimensions to MapLibre. */
    resize() {
        this._assertReady()
        const changed = this._syncCanvasSize()
        if (changed) this._markDirty()
        return changed
    }

    /**
     * Submit a transparent clear and all chunks. Passing a matrix snapshots it
     * without causing a second repaint request, which is ideal inside a
     * MapLibre custom layer's `render` callback. Returns false after loss or
     * destruction, or while the backing canvas has zero area.
     */
    render(matrix, options = {}) {
        if (this.state !== 'ready') return false
        if (matrix !== undefined) this._setView(matrix, options)
        this._requestQueued = false
        this._syncCanvasSize()
        if (!this.canvas.width || !this.canvas.height) return false

        const drawChunks = []
        let matrixCount = 0
        if (this._matrix) {
            for (const chunk of this._chunks.values()) {
                if (!chunk.indexCount) continue
                chunk.frameWorldCopies = worldCopiesForChunk(
                    this._worldCopiesConfig,
                    this._centerMercatorX,
                    chunk.originX,
                )
                if (!chunk.frameWorldCopies.length) continue
                drawChunks.push(chunk)
                matrixCount += chunk.frameWorldCopies.length
            }
        }
        if (matrixCount) {
            this._ensureMatrixCapacity(matrixCount)
            let matrixIndex = 0
            for (const chunk of drawChunks) {
                chunk.matrixByteOffset = matrixIndex * MATRIX_BYTES
                for (const worldCopy of chunk.frameWorldCopies) {
                    copyLocalMatrix(
                        this._matrix,
                        chunk.originX + worldCopy,
                        chunk.originY,
                        this._worldSize,
                        this._matrixStaging,
                        matrixIndex * MATRIX_SIZE,
                    )
                    matrixIndex++
                }
            }
            this.device.queue.writeBuffer(this._matrixBuffer, 0, this._matrixStaging, 0, matrixCount * MATRIX_SIZE)
        }

        const timestamp = now()
        let transitioning = false
        for (const chunk of drawChunks) {
            let progress = 1
            if (chunk.transitionDuration > 0) {
                const rawProgress = (timestamp - chunk.transitionStart) / chunk.transitionDuration
                if (rawProgress < 1) {
                    progress = easeTransition(rawProgress)
                    transitioning = true
                } else {
                    chunk.transitionDuration = 0
                    chunk.colorsFrom = chunk.colorsTo
                }
            }

            const highlighted = this._highlight?.chunkId === chunk.id
            chunk.styleFloats[0] = progress
            chunk.styleFloats[1] = highlighted ? this._highlight.amount : 0
            chunk.styleUints[2] = highlighted ? this._highlight.cellIndex : NO_HIGHLIGHT
            chunk.styleUints[3] = highlighted ? this._highlight.color : 0
            this.device.queue.writeBuffer(chunk.styleBuffer, 0, chunk.styleStaging)
        }

        try {
            const encoder = this.device.createCommandEncoder({label: 'packed-h3 frame'})
            const canvasView = this.context.getCurrentTexture().createView()
            const pass = encoder.beginRenderPass({
                label: 'packed-h3 transparent overlay',
                colorAttachments: [{
                    view: this._msaaTexture ? this._msaaTexture.createView() : canvasView,
                    resolveTarget: this._msaaTexture ? canvasView : undefined,
                    clearValue: {r: 0, g: 0, b: 0, a: 0},
                    loadOp: 'clear',
                    storeOp: this._msaaTexture ? 'discard' : 'store',
                }],
            })
            if (matrixCount) {
                pass.setPipeline(this._pipeline)
                for (const chunk of drawChunks) {
                    pass.setBindGroup(0, chunk.bindGroup)
                    pass.setVertexBuffer(0, chunk.positionBuffer)
                    pass.setVertexBuffer(1, this._matrixBuffer, chunk.matrixByteOffset)
                    pass.setIndexBuffer(chunk.indexBuffer, 'uint32')
                    pass.drawIndexed(chunk.indexCount, chunk.frameWorldCopies.length)
                }
            }
            pass.end()
            this.device.queue.submit([encoder.finish()])
        } catch (error) {
            this._rejectWaiters(error)
            throw error
        }

        const frame = ++this._frame
        this._needsRender = transitioning
        this._finishWaiters(frame)
        if (transitioning) this._scheduleRenderRequest()
        return true
    }

    /** Submit only a transparent clear, retaining chunks and the matrix. */
    clear() {
        if (this.state !== 'ready') return false
        const matrix = this._matrix
        this._matrix = null
        try {
            return this.render()
        } finally {
            this._matrix = matrix
        }
    }

    /**
     * Resolve with the next submitted frame number after its GPU work finishes.
     * This requests a host frame but does not invent a render loop when no
     * `requestRender` callback is configured.
     */
    waitForRender() {
        if (this.state !== 'ready') return Promise.reject(this._terminalError || new Error(`Packed H3 renderer is ${this.state}`))
        const promise = new Promise((resolve, reject) => this._waiters.push({resolve, reject}))
        this._markDirty()
        return promise
    }

    /** Destroy every GPU resource, detach observers, and remove the overlay. */
    destroy() {
        if (this.state === 'destroyed') return
        this.state = 'destroyed'
        this._terminalError = new Error('Packed H3 renderer was destroyed')
        this._requestQueued = false
        this._requestRenderCallback = null
        this._resizeObserver?.disconnect()
        this._rejectWaiters(this._terminalError)
        this._releaseGpuResources()
        this.device.destroy()
        this.canvas.remove()
    }
}

/** Return true when this browser exposes the WebGPU entry point. */
export function isWebGPUSupported() {
    return Boolean(globalThis.navigator?.gpu)
}

/**
 * Initialize the adapter, device, premultiplied WebGPU canvas context, and
 * render pipeline. Returns `null` when WebGPU, an adapter, or a `webgpu` canvas
 * context is unavailable. Other initialization failures are reported by a
 * rejected promise.
 *
 * Options:
 * - `mapCanvas` (required): `map.getCanvas()`.
 * - `requestRender`: callback such as `() => map.triggerRepaint()`.
 * - `transitionDuration`: default color transition duration in milliseconds.
 * - `worldCopies`: false, true, integer radius, or exact world-index iterable.
 * - `powerPreference`, `forceFallbackAdapter`, `deviceDescriptor`: WebGPU init.
 * - `onDeviceLost(info, renderer)`: terminal device-loss notification.
 * - `className`, `zIndex`: overlay canvas presentation hooks.
 */
export async function createPackedH3Renderer(options = {}) {
    if (!isWebGPUSupported()) return null
    const {mapCanvas} = options
    if (!mapCanvas) throw new TypeError('createPackedH3Renderer requires mapCanvas')
    if (options.requestRender != null && typeof options.requestRender !== 'function') {
        throw new TypeError('requestRender must be a function')
    }
    if (options.onDeviceLost != null && typeof options.onDeviceLost !== 'function') {
        throw new TypeError('onDeviceLost must be a function')
    }
    const sampleCount = options.sampleCount ?? 4
    if (![1, 4].includes(sampleCount)) throw new RangeError('sampleCount must be 1 or 4')
    options = {...options, sampleCount}

    const gpu = globalThis.navigator.gpu
    const adapter = await gpu.requestAdapter({
        powerPreference: options.powerPreference,
        forceFallbackAdapter: options.forceFallbackAdapter,
    })
    if (!adapter) return null

    let device
    let canvas
    let context
    try {
        device = await adapter.requestDevice(options.deviceDescriptor)
        canvas = createOverlayCanvas(mapCanvas, options)
        context = canvas.getContext('webgpu')
        if (!context) {
            canvas.remove()
            device.destroy()
            return null
        }
        const format = gpu.getPreferredCanvasFormat()
        context.configure({device, format, alphaMode: 'premultiplied'})
        const {pipeline, bindGroupLayout} = await createPipeline(device, format, sampleCount)
        return new PackedH3Renderer({
            adapter,
            device,
            context,
            canvas,
            mapCanvas,
            format,
            pipeline,
            bindGroupLayout,
            options,
        })
    } catch (error) {
        context?.unconfigure?.()
        canvas?.remove()
        device?.destroy()
        throw error
    }
}

/**
 * Create a MapLibre custom layer that snapshots
 * `renderArgs.modelViewProjectionMatrix`, renders the WebGPU canvas, and wires
 * renderer repaint requests to `map.triggerRepaint()`. It is a synchronization
 * hook only: the separate canvas remains above all MapLibre style layers.
 *
 * `worldCopies` defaults to radius 1 around the current unwrapped map world.
 * Set `destroyOnRemove` when the layer exclusively owns the renderer.
 */
export function createMapLibreMatrixLayer(renderer, {
    id = 'webgpu-packed-h3-matrix',
    worldCopies = 1,
    destroyOnRemove = false,
} = {}) {
    if (!renderer || typeof renderer.render !== 'function') throw new TypeError('A packed H3 renderer is required')
    worldCopies = prepareWorldCopies(worldCopies)
    let map = null
    return {
        id,
        type: 'custom',
        renderingMode: '2d',
        onAdd(mapInstance) {
            map = mapInstance
            renderer.setRequestRender(() => map?.triggerRepaint())
            renderer.requestRender()
        },
        render(_gl, renderArgs) {
            const matrix = renderArgs?.modelViewProjectionMatrix
            if (!matrix || renderer.state !== 'ready') return
            const longitude = Number(map?.getCenter().lng) || 0
            const worldSize = MAPLIBRE_WORLD_SIZE_AT_ZOOM_ZERO * 2 ** map.getZoom()
            renderer.render(matrix, {
                worldCopies,
                centerMercatorX: (longitude + 180) / 360,
                worldSize,
            })
        },
        onRemove() {
            renderer.setRequestRender(null)
            if (destroyOnRemove) {
                renderer.destroy()
            } else {
                try {
                    renderer.clear()
                } catch (error) {
                    console.warn('Failed to clear packed H3 overlay', error)
                }
            }
            map = null
        },
    }
}
