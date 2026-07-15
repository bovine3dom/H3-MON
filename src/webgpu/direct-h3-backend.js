import {createH3ComputeModule} from './h3-compute.js'

export const DIRECT_H3_VERTICES_PER_CELL = 24

const TRIANGLE_WORDS_PER_CELL = 8
const TRIANGLE_BYTES_PER_CELL = TRIANGLE_WORDS_PER_CELL * 4
const VALID_TRIANGLE = 0x80000000

const BUFFER_USAGE = globalThis.GPUBufferUsage || {
    MAP_READ: 0x0001,
    COPY_SRC: 0x0004,
    COPY_DST: 0x0008,
    UNIFORM: 0x0040,
    STORAGE: 0x0080,
}
const MAP_MODE = globalThis.GPUMapMode || {READ: 0x0001}
const SHADER_STAGE = globalThis.GPUShaderStage || {
    VERTEX: 0x1,
    FRAGMENT: 0x2,
    COMPUTE: 0x4,
}
const GPU_ERROR_FILTERS = ['out-of-memory', 'internal', 'validation']

export function pushGpuErrorScopes(device) {
    if (typeof device.pushErrorScope !== 'function' || typeof device.popErrorScope !== 'function') return null
    const pushed = []
    try {
        for (const filter of GPU_ERROR_FILTERS) {
            device.pushErrorScope(filter)
            pushed.push(filter)
        }
        return pushed
    } catch (error) {
        for (let i = pushed.length - 1; i >= 0; i--) void device.popErrorScope().catch(() => {})
        throw error
    }
}

export function popGpuErrorScopes(device, scopes) {
    if (!scopes) return Promise.resolve(null)
    const popped = []
    for (let i = scopes.length - 1; i >= 0; i--) {
        const filter = scopes[i]
        popped.push(Promise.resolve(device.popErrorScope()).then(error => ({filter, error})))
    }
    return Promise.all(popped).then(results => {
        for (const filter of GPU_ERROR_FILTERS) {
            const result = results.find(entry => entry.filter === filter && entry.error)
            if (result) return result.error
        }
        return null
    })
}

const TRIANGULATION_SHADER = /* wgsl */ `
const H3_RESULT_CAPACITY: u32 = 10u;
const H3_TRIANGLE_CAPACITY: u32 = 8u;
const H3_STATUS_SUCCESS: u32 = 0u;
const H3_VALID_TRIANGLE: u32 = 0x80000000u;
const H3_RELATIVE_EPSILON: f32 = 1e-5;

struct H3ComputeResult {
    boundary: array<vec2<f32>, 10>,
    count: u32,
    status: u32,
}

struct H3Triangles {
    words: array<u32, 8>,
}

struct H3Origin {
    high: vec2<f32>,
    low: vec2<f32>,
}

struct H3Validation {
    failureMask: atomic<u32>,
    firstFailure: atomic<u32>,
    statusMask: atomic<u32>,
    padding: u32,
}

@group(0) @binding(0) var<storage, read_write> h3Results: array<H3ComputeResult>;
@group(0) @binding(1) var<storage, read_write> h3Triangles: array<H3Triangles>;
@group(0) @binding(2) var<uniform> h3Origin: H3Origin;
@group(0) @binding(3) var<storage, read_write> h3Validation: H3Validation;

fn h3_cross(a: vec2<f32>, b: vec2<f32>, c: vec2<f32>) -> f32 {
    let ab = b - a;
    let ac = c - a;
    return ab.x * ac.y - ab.y * ac.x;
}

fn h3_cross_tolerance(a: vec2<f32>, b: vec2<f32>, c: vec2<f32>) -> f32 {
    let extent = max(max(abs(b - a), abs(c - a)), abs(c - b));
    let scale = max(extent.x, extent.y);
    return max(scale * scale * H3_RELATIVE_EPSILON, 1e-20);
}

fn h3_point_in_triangle(
    point: vec2<f32>,
    a: vec2<f32>,
    b: vec2<f32>,
    c: vec2<f32>,
    winding: f32
) -> bool {
    return h3_cross(a, b, point) * winding > h3_cross_tolerance(a, b, point) &&
        h3_cross(b, c, point) * winding > h3_cross_tolerance(b, c, point) &&
        h3_cross(c, a, point) * winding > h3_cross_tolerance(c, a, point);
}

fn h3_mark_failure(cell: u32, mask: u32) {
    atomicOr(&h3Validation.failureMask, mask);
    atomicMin(&h3Validation.firstFailure, cell);
}

fn h3_mark_status_failure(cell: u32, status: u32, mask: u32) {
    h3_mark_failure(cell, mask);
    atomicOr(&h3Validation.statusMask, 1u << min(status, 31u));
}

fn h3_pack_triangle(a: u32, b: u32, c: u32) -> u32 {
    return H3_VALID_TRIANGLE | a | (b << 4u) | (c << 8u);
}

@compute @workgroup_size(64)
fn h3TriangulateMain(@builtin(global_invocation_id) invocation: vec3<u32>) {
    let cell = invocation.x;
    if (cell >= arrayLength(&h3Results) || cell >= arrayLength(&h3Triangles)) {
        return;
    }

    var triangles: H3Triangles;
    var triangleIndex = 0u;
    loop {
        if (triangleIndex >= H3_TRIANGLE_CAPACITY) { break; }
        triangles.words[triangleIndex] = 0u;
        triangleIndex += 1u;
    }
    h3Triangles[cell] = triangles;

    var result = h3Results[cell];
    if (result.status != H3_STATUS_SUCCESS) {
        h3_mark_status_failure(cell, result.status, 1u);
        return;
    }
    if (result.count < 3u || result.count > H3_RESULT_CAPACITY) {
        h3_mark_failure(cell, 1u);
        return;
    }

    var points: array<vec2<f32>, 10>;
    var activeIndices: array<u32, 10>;
    let originX = h3Origin.high.x + h3Origin.low.x;
    let worldShift = round(originX - result.boundary[0].x);
    let firstAbsoluteY = result.boundary[0].y;
    var collapsedAtMercatorLimit = firstAbsoluteY == 0.0 || firstAbsoluteY == 1.0;
    var minimumPoint = vec2<f32>(1e30);
    var maximumPoint = vec2<f32>(-1e30);
    var pointIndex = 0u;
    loop {
        if (pointIndex >= result.count) { break; }
        var point = result.boundary[pointIndex];
        collapsedAtMercatorLimit = collapsedAtMercatorLimit && point.y == firstAbsoluteY;
        point.x += worldShift;
        point = (point - h3Origin.high) - h3Origin.low;
        if (any(point != point) || any(abs(point) > vec2<f32>(2.0))) {
            h3_mark_failure(cell, 2u);
            return;
        }
        points[pointIndex] = point;
        minimumPoint = min(minimumPoint, point);
        maximumPoint = max(maximumPoint, point);
        activeIndices[pointIndex] = pointIndex;
        result.boundary[pointIndex] = point;
        pointIndex += 1u;
    }

    if (collapsedAtMercatorLimit) {
        h3Results[cell] = result;
        return;
    }

    var activeCount = result.count;
    let coordinateTolerance = max(max(maximumPoint.x - minimumPoint.x, maximumPoint.y - minimumPoint.y) * H3_RELATIVE_EPSILON, 1e-12);
    var reductionPass = 0u;
    loop {
        if (activeCount <= 3u || reductionPass >= H3_RESULT_CAPACITY) { break; }
        var removedPoint = false;
        var candidate = 0u;
        loop {
            if (candidate >= activeCount) { break; }
            let previous = activeIndices[(candidate + activeCount - 1u) % activeCount];
            let current = activeIndices[candidate];
            let next = activeIndices[(candidate + 1u) % activeCount];
            if (
                all(abs(points[current] - points[next]) <= vec2<f32>(coordinateTolerance)) ||
                abs(h3_cross(points[previous], points[current], points[next])) <=
                    h3_cross_tolerance(points[previous], points[current], points[next])
            ) {
                var shift = candidate;
                loop {
                    if (shift + 1u >= activeCount) { break; }
                    activeIndices[shift] = activeIndices[shift + 1u];
                    shift += 1u;
                }
                activeCount -= 1u;
                removedPoint = true;
                break;
            }
            candidate += 1u;
        }
        if (!removedPoint) { break; }
        reductionPass += 1u;
    }

    var area = 0.0;
    var areaTolerance = 0.0;
    pointIndex = 1u;
    loop {
        if (pointIndex + 1u >= activeCount) { break; }
        area += h3_cross(
            points[activeIndices[0]],
            points[activeIndices[pointIndex]],
            points[activeIndices[pointIndex + 1u]]
        );
        areaTolerance += h3_cross_tolerance(
            points[activeIndices[0]],
            points[activeIndices[pointIndex]],
            points[activeIndices[pointIndex + 1u]]
        );
        pointIndex += 1u;
    }
    if (abs(area) <= areaTolerance) {
        h3_mark_failure(cell, 8u);
        return;
    }
    let winding = select(-1.0, 1.0, area > 0.0);

    triangleIndex = 0u;
    loop {
        if (activeCount <= 3u) { break; }
        var foundEar = false;
        var candidate = 0u;
        loop {
            if (candidate >= activeCount) { break; }
            let previousPosition = (candidate + activeCount - 1u) % activeCount;
            let nextPosition = (candidate + 1u) % activeCount;
            let previous = activeIndices[previousPosition];
            let current = activeIndices[candidate];
            let next = activeIndices[nextPosition];
            let a = points[previous];
            let b = points[current];
            let c = points[next];

            if (h3_cross(a, b, c) * winding > h3_cross_tolerance(a, b, c)) {
                var containsPoint = false;
                var otherPosition = 0u;
                loop {
                    if (otherPosition >= activeCount) { break; }
                    if (
                        otherPosition != previousPosition &&
                        otherPosition != candidate &&
                        otherPosition != nextPosition &&
                        h3_point_in_triangle(points[activeIndices[otherPosition]], a, b, c, winding)
                    ) {
                        containsPoint = true;
                        break;
                    }
                    otherPosition += 1u;
                }
                if (!containsPoint) {
                    triangles.words[triangleIndex] = h3_pack_triangle(previous, current, next);
                    triangleIndex += 1u;
                    var shift = candidate;
                    loop {
                        if (shift + 1u >= activeCount) { break; }
                        activeIndices[shift] = activeIndices[shift + 1u];
                        shift += 1u;
                    }
                    activeCount -= 1u;
                    foundEar = true;
                    break;
                }
            }
            candidate += 1u;
        }
        if (!foundEar) {
            h3_mark_failure(cell, 16u);
            return;
        }
    }

    if (activeCount != 3u || triangleIndex >= H3_TRIANGLE_CAPACITY) {
        h3_mark_failure(cell, 32u);
        return;
    }
    if (
        h3_cross(points[activeIndices[0]], points[activeIndices[1]], points[activeIndices[2]]) * winding <=
            h3_cross_tolerance(points[activeIndices[0]], points[activeIndices[1]], points[activeIndices[2]])
    ) {
        h3_mark_failure(cell, 64u);
        return;
    }
    triangles.words[triangleIndex] = h3_pack_triangle(activeIndices[0], activeIndices[1], activeIndices[2]);

    h3Results[cell] = result;
    h3Triangles[cell] = triangles;
}
`

const DIRECT_RENDER_SHADER = /* wgsl */ `
const H3_VERTICES_PER_CELL: u32 = 24u;
const H3_VALID_TRIANGLE: u32 = 0x80000000u;

struct StyleUniforms {
    transition: f32,
    highlightAmount: f32,
    highlightCell: u32,
    highlightColor: u32,
}

struct H3ComputeResult {
    boundary: array<vec2<f32>, 10>,
    count: u32,
    status: u32,
}

struct H3Triangles {
    words: array<u32, 8>,
}

@group(0) @binding(0) var<uniform> style: StyleUniforms;
@group(0) @binding(1) var<storage, read> colorsFrom: array<u32>;
@group(0) @binding(2) var<storage, read> colorsTo: array<u32>;
@group(0) @binding(3) var<storage, read> h3Results: array<H3ComputeResult>;
@group(0) @binding(4) var<storage, read> h3Triangles: array<H3Triangles>;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) @interpolate(flat) cell: u32,
}

@vertex
fn vertexMain(
    @builtin(vertex_index) vertexIndex: u32,
    @location(2) matrix0: vec4<f32>,
    @location(3) matrix1: vec4<f32>,
    @location(4) matrix2: vec4<f32>,
    @location(5) matrix3: vec4<f32>
) -> VertexOutput {
    let cell = vertexIndex / H3_VERTICES_PER_CELL;
    let emittedVertex = vertexIndex % H3_VERTICES_PER_CELL;
    let triangle = emittedVertex / 3u;
    let corner = emittedVertex % 3u;
    let word = h3Triangles[cell].words[triangle];

    var output: VertexOutput;
    output.cell = cell;
    output.position = vec4<f32>(2.0, 2.0, 1.0, 1.0);
    if ((word & H3_VALID_TRIANGLE) == 0u) {
        return output;
    }

    let result = h3Results[cell];
    let slot = (word >> (corner * 4u)) & 15u;
    if (result.status != 0u || slot >= result.count) {
        return output;
    }

    let matrix = mat4x4<f32>(matrix0, matrix1, matrix2, matrix3);
    let clip = matrix * vec4<f32>(result.boundary[slot], 0.0, 1.0);
    output.position = vec4<f32>(clip.xy, 0.5 * (clip.z + clip.w), clip.w);
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
    return vec4<f32>(color.rgb * color.a, color.a);
}
`

function align4(value) {
    return Math.max(4, Math.ceil(value / 4) * 4)
}

function createInitializedBuffer(device, descriptor, data) {
    const buffer = device.createBuffer({...descriptor, size: align4(Math.max(descriptor.size || 0, data.byteLength)), mappedAtCreation: true})
    try {
        new Uint8Array(buffer.getMappedRange()).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
        buffer.unmap()
        return buffer
    } catch (error) {
        buffer.destroy()
        throw error
    }
}

function splitOrigin(origin, label) {
    if (!origin || typeof origin.length !== 'number' || origin.length < 2) {
        throw new TypeError(`${label} must be [mercatorX, mercatorY]`)
    }
    const x = Number(origin[0])
    const y = Number(origin[1])
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new TypeError(`${label} coordinates must be finite`)
    const highX = Math.fround(x)
    const highY = Math.fround(y)
    return {x, y, data: new Float32Array([highX, highY, x - highX, y - highY])}
}

function directH3Error(id, validation) {
    const error = new Error(
        `Direct H3 chunk "${id}" failed GPU validation at cell ${validation[1]} ` +
        `(failure mask 0x${validation[0].toString(16)}, status mask 0x${validation[2].toString(16)})`,
    )
    error.name = 'DirectH3ValidationError'
    error.chunkId = id
    error.failureMask = validation[0]
    error.firstFailure = validation[1]
    error.statusMask = validation[2]
    return error
}

async function assertShaderCompiles(module, label) {
    if (typeof module.getCompilationInfo !== 'function') return
    const info = await module.getCompilationInfo()
    const errors = Array.from(info?.messages || []).filter(message => message.type === 'error')
    if (!errors.length) return
    const details = errors.map(message => `${message.lineNum}:${message.linePos} ${message.message}`).join('\n')
    const error = new Error(`${label} WGSL compilation failed${details ? `:\n${details}` : ''}`)
    error.name = 'GPUShaderCompilationError'
    error.compilationMessages = Array.from(info.messages)
    throw error
}

function checkedStorageBufferSize(device, cellCount) {
    const size = Math.max(TRIANGLE_BYTES_PER_CELL, cellCount * TRIANGLE_BYTES_PER_CELL)
    if (!Number.isSafeInteger(size)) throw new RangeError('Direct H3 triangle buffer size is unsafe')
    if (size > device.limits.maxBufferSize) {
        throw new RangeError(`Direct H3 triangles need ${size} bytes, exceeding maxBufferSize`)
    }
    if (size > device.limits.maxStorageBufferBindingSize) {
        throw new RangeError(`Direct H3 triangles need ${size} bytes, exceeding maxStorageBufferBindingSize`)
    }
    return size
}

async function createPipelines(device, format, sampleCount) {
    const triangulationLayout = device.createBindGroupLayout({
        label: 'direct-h3 triangulation bindings',
        entries: [
            {binding: 0, visibility: SHADER_STAGE.COMPUTE, buffer: {type: 'storage'}},
            {binding: 1, visibility: SHADER_STAGE.COMPUTE, buffer: {type: 'storage'}},
            {binding: 2, visibility: SHADER_STAGE.COMPUTE, buffer: {type: 'uniform'}},
            {binding: 3, visibility: SHADER_STAGE.COMPUTE, buffer: {type: 'storage'}},
        ],
    })
    const renderLayout = device.createBindGroupLayout({
        label: 'direct-h3 render bindings',
        entries: [
            {binding: 0, visibility: SHADER_STAGE.FRAGMENT, buffer: {type: 'uniform'}},
            {binding: 1, visibility: SHADER_STAGE.FRAGMENT, buffer: {type: 'read-only-storage'}},
            {binding: 2, visibility: SHADER_STAGE.FRAGMENT, buffer: {type: 'read-only-storage'}},
            {binding: 3, visibility: SHADER_STAGE.VERTEX, buffer: {type: 'read-only-storage'}},
            {binding: 4, visibility: SHADER_STAGE.VERTEX, buffer: {type: 'read-only-storage'}},
        ],
    })
    const triangulationModule = device.createShaderModule({label: 'direct-h3 triangulation shader', code: TRIANGULATION_SHADER})
    const renderModule = device.createShaderModule({label: 'direct-h3 render shader', code: DIRECT_RENDER_SHADER})
    await Promise.all([
        assertShaderCompiles(triangulationModule, 'Direct H3 triangulation'),
        assertShaderCompiles(renderModule, 'Direct H3 rendering'),
    ])
    const triangulationDescriptor = {
        label: 'direct-h3 triangulation pipeline',
        layout: device.createPipelineLayout({bindGroupLayouts: [triangulationLayout]}),
        compute: {module: triangulationModule, entryPoint: 'h3TriangulateMain'},
    }
    const renderDescriptor = {
        label: 'direct-h3 render pipeline',
        layout: device.createPipelineLayout({bindGroupLayouts: [renderLayout]}),
        vertex: {
            module: renderModule,
            entryPoint: 'vertexMain',
            buffers: [{
                arrayStride: 64,
                stepMode: 'instance',
                attributes: [
                    {shaderLocation: 2, offset: 0, format: 'float32x4'},
                    {shaderLocation: 3, offset: 16, format: 'float32x4'},
                    {shaderLocation: 4, offset: 32, format: 'float32x4'},
                    {shaderLocation: 5, offset: 48, format: 'float32x4'},
                ],
            }],
        },
        fragment: {
            module: renderModule,
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
    const createCompute = typeof device.createComputePipelineAsync === 'function'
        ? device.createComputePipelineAsync(triangulationDescriptor)
        : Promise.resolve(device.createComputePipeline(triangulationDescriptor))
    const createRender = typeof device.createRenderPipelineAsync === 'function'
        ? device.createRenderPipelineAsync(renderDescriptor)
        : Promise.resolve(device.createRenderPipeline(renderDescriptor))
    const [triangulationPipeline, renderPipeline] = await Promise.all([createCompute, createRender])
    return {triangulationLayout, triangulationPipeline, renderLayout, renderPipeline}
}

export class DirectH3Backend {
    constructor(device, compute, pipelines) {
        this.device = device
        this.compute = compute
        this.renderPipeline = pipelines.renderPipeline
        this._renderLayout = pipelines.renderLayout
        this._triangulationLayout = pipelines.triangulationLayout
        this._triangulationPipeline = pipelines.triangulationPipeline
        this.state = 'ready'
    }

    createChunk(id, ids, origin, {styleBuffer, colorFromBuffer, colorToBuffer}) {
        if (this.state !== 'ready') throw new Error(`Direct H3 backend is ${this.state}`)
        const lower = ids?.lower
        const upper = ids?.upper
        if (!(lower instanceof Uint32Array) || !(upper instanceof Uint32Array) || lower.length !== upper.length) {
            throw new TypeError('Direct H3 ids require equal-length Uint32Array lower and upper words')
        }
        const cellCount = lower.length
        const split = splitOrigin(origin, 'origin')
        const triangleBufferSize = checkedStorageBufferSize(this.device, cellCount)
        let batch, triangleBuffer, originBuffer, validationBuffer, readbackBuffer
        let scopes = null
        try {
            scopes = pushGpuErrorScopes(this.device)
            batch = this.compute.uploadIds(lower, upper)
            triangleBuffer = this.device.createBuffer({
                label: `direct-h3 ${id} triangles`,
                size: triangleBufferSize,
                usage: BUFFER_USAGE.STORAGE,
            })
            originBuffer = createInitializedBuffer(this.device, {
                label: `direct-h3 ${id} origin`,
                usage: BUFFER_USAGE.UNIFORM,
            }, split.data)
            validationBuffer = createInitializedBuffer(this.device, {
                label: `direct-h3 ${id} validation`,
                usage: BUFFER_USAGE.STORAGE | BUFFER_USAGE.COPY_SRC,
            }, new Uint32Array([0, 0xffffffff, 0, 0]))
            readbackBuffer = this.device.createBuffer({
                label: `direct-h3 ${id} validation readback`,
                size: 16,
                usage: BUFFER_USAGE.COPY_DST | BUFFER_USAGE.MAP_READ,
            })
            const triangulationBindGroup = this.device.createBindGroup({
                label: `direct-h3 ${id} triangulation bindings`,
                layout: this._triangulationLayout,
                entries: [
                    {binding: 0, resource: {buffer: batch.outputBuffer}},
                    {binding: 1, resource: {buffer: triangleBuffer}},
                    {binding: 2, resource: {buffer: originBuffer}},
                    {binding: 3, resource: {buffer: validationBuffer}},
                ],
            })
            const renderBindGroup = this.device.createBindGroup({
                label: `direct-h3 ${id} render bindings`,
                layout: this._renderLayout,
                entries: [
                    {binding: 0, resource: {buffer: styleBuffer}},
                    {binding: 1, resource: {buffer: colorFromBuffer}},
                    {binding: 2, resource: {buffer: colorToBuffer}},
                    {binding: 3, resource: {buffer: batch.outputBuffer}},
                    {binding: 4, resource: {buffer: triangleBuffer}},
                ],
            })

            batch.dispatch()
            if (cellCount) {
                const encoder = this.device.createCommandEncoder({label: `direct-h3 ${id} triangulation`})
                const pass = encoder.beginComputePass({label: `direct-h3 ${id} triangulation pass`})
                pass.setPipeline(this._triangulationPipeline)
                pass.setBindGroup(0, triangulationBindGroup)
                pass.dispatchWorkgroups(Math.ceil(cellCount / 64))
                pass.end()
                encoder.copyBufferToBuffer(validationBuffer, 0, readbackBuffer, 0, 16)
                this.device.queue.submit([encoder.finish()])
            }

            const scopeError = popGpuErrorScopes(this.device, scopes)
            scopes = null
            let destroyed = false
            const cleanupTransient = () => {
                originBuffer?.destroy()
                validationBuffer?.destroy()
                readbackBuffer?.destroy()
                originBuffer = validationBuffer = readbackBuffer = null
            }
            const validation = cellCount
                ? readbackBuffer.mapAsync(MAP_MODE.READ, 0, 16).then(() => {
                    const result = new Uint32Array(4)
                    result.set(new Uint32Array(readbackBuffer.getMappedRange(0, 16)))
                    readbackBuffer.unmap()
                    if (result[0]) throw directH3Error(id, result)
                })
                : Promise.resolve()
            const ready = Promise.all([validation, scopeError]).then(([, gpuError]) => {
                if (gpuError) throw gpuError
                if (!destroyed) batch.idBuffer.destroy()
                return true
            }).finally(cleanupTransient)

            return {
                cellCount,
                originX: split.x,
                originY: split.y,
                renderBindGroup,
                ready,
                destroy() {
                    if (destroyed) return
                    destroyed = true
                    cleanupTransient()
                    batch.destroy()
                    triangleBuffer.destroy()
                },
            }
        } catch (error) {
            if (scopes) void popGpuErrorScopes(this.device, scopes).catch(() => {})
            readbackBuffer?.destroy()
            validationBuffer?.destroy()
            originBuffer?.destroy()
            triangleBuffer?.destroy()
            batch?.destroy()
            throw error
        }
    }

    destroy() {
        if (this.state === 'destroyed') return
        this.state = 'destroyed'
        this.compute.destroy({destroyDevice: false})
    }
}

export async function createDirectH3Backend(device, format, sampleCount) {
    const compute = await createH3ComputeModule({device})
    try {
        const pipelines = await createPipelines(device, format, sampleCount)
        return new DirectH3Backend(device, compute, pipelines)
    } catch (error) {
        compute.destroy({destroyDevice: false})
        throw error
    }
}
