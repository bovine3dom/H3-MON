/*
 * Standalone WebGPU H3 4.4 cell-to-boundary compute API.
 *
 * The shader is derived from luma.gl (MIT, commit 01dd287e7bf8c2a3e65d46173a9785063266ba10)
 * and H3 4.4.1 (Apache-2.0). See h3-compute-wgsl.js and h3-compute-NOTICES.md.
 */

import {H3_COMPUTE_WGSL} from './h3-compute-wgsl.js'

/**
 * GPU output record (88-byte stride): ten `vec2<f32>` values at bytes 0-79,
 * `count: u32` at byte 80, and `status: u32` at byte 84. Coordinates are
 * normalized Web Mercator; x is unwrapped around the cell center and may be
 * outside [0, 1], while y is clamped to [0, 1]. Every unused or failed slot is
 * NaN. Only read slots below `count` when status is `SUCCESS`.
 */
export const H3_COMPUTE_BOUNDARY_SLOTS = 10
export const H3_COMPUTE_OUTPUT_STRIDE = 88
export const H3_COMPUTE_WORKGROUP_SIZE = 64

export const H3_COMPUTE_STATUS = Object.freeze({
    SUCCESS: 0,
    INVALID_ID: 1,
    UNSUPPORTED_RESOLUTION: 2,
    TOPOLOGY_OVERFLOW: 3,
    FACE_TRANSFORM_FAILED: 4,
    NUMERIC_FAILURE: 5,
})

export const H3_COMPUTE_STATUS_NAMES = Object.freeze([
    'success',
    'invalid-id',
    'unsupported-resolution',
    'topology-overflow',
    'face-transform-failed',
    'numeric-failure',
])

const BUFFER_USAGE = globalThis.GPUBufferUsage || {
    MAP_READ: 0x0001,
    COPY_SRC: 0x0004,
    COPY_DST: 0x0008,
    STORAGE: 0x0080,
}
const MAP_MODE = globalThis.GPUMapMode || {READ: 0x0001}
const SHADER_STAGE = globalThis.GPUShaderStage || {COMPUTE: 0x0004}

function assertUint32Array(value, label) {
    if (!(value instanceof Uint32Array)) throw new TypeError(`${label} must be a Uint32Array`)
    return value
}

function prepareIdWords(idsOrLower, upper) {
    if (upper !== undefined) {
        const lower = assertUint32Array(idsOrLower, 'lower')
        upper = assertUint32Array(upper, 'upper')
        if (lower.length !== upper.length) throw new RangeError('lower and upper must have equal lengths')
        const words = new Uint32Array(lower.length * 2)
        for (let index = 0; index < lower.length; index++) {
            words[index * 2] = lower[index]
            words[index * 2 + 1] = upper[index]
        }
        return words
    }

    if (idsOrLower && typeof idsOrLower === 'object' && !(idsOrLower instanceof Uint32Array)) {
        if (idsOrLower.lower === undefined || idsOrLower.upper === undefined) {
            throw new TypeError('Split ids must provide both lower and upper Uint32Arrays')
        }
        return prepareIdWords(idsOrLower.lower, idsOrLower.upper)
    }

    const words = assertUint32Array(idsOrLower, 'ids')
    if (words.length % 2 !== 0) {
        throw new RangeError('Interleaved ids must contain [lower, upper] pairs')
    }
    return words.slice()
}

function createInitializedBuffer(device, descriptor, data) {
    const buffer = device.createBuffer({...descriptor, mappedAtCreation: true})
    try {
        new Uint8Array(buffer.getMappedRange()).set(
            new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
        )
        buffer.unmap()
        return buffer
    } catch (error) {
        buffer.destroy()
        throw error
    }
}

function normalizeCompilationMessages(info) {
    return Object.freeze(Array.from(info?.messages || [], message => Object.freeze({
        type: message.type,
        message: message.message,
        lineNum: Number(message.lineNum || 0),
        linePos: Number(message.linePos || 0),
        offset: Number(message.offset || 0),
        length: Number(message.length || 0),
    })))
}

function compilationError(messages) {
    const details = messages
        .filter(message => message.type === 'error')
        .map(message => `${message.lineNum}:${message.linePos} ${message.message}`)
        .join('\n')
    const error = new Error(`H3 compute WGSL compilation failed${details ? `:\n${details}` : ''}`)
    error.name = 'GPUShaderCompilationError'
    error.compilationMessages = messages
    return error
}

async function createPipeline(device) {
    const bindGroupLayout = device.createBindGroupLayout({
        label: 'h3-compute bindings',
        entries: [
            {binding: 0, visibility: SHADER_STAGE.COMPUTE, buffer: {type: 'read-only-storage'}},
            {binding: 1, visibility: SHADER_STAGE.COMPUTE, buffer: {type: 'storage'}},
        ],
    })
    const pipelineLayout = device.createPipelineLayout({
        label: 'h3-compute pipeline layout',
        bindGroupLayouts: [bindGroupLayout],
    })
    const shaderModule = device.createShaderModule({
        label: 'h3-compute H3 4.4.1 boundary shader',
        code: H3_COMPUTE_WGSL,
    })
    const compilationInfo = typeof shaderModule.getCompilationInfo === 'function'
        ? await shaderModule.getCompilationInfo()
        : null
    const compilationMessages = normalizeCompilationMessages(compilationInfo)
    if (compilationMessages.some(message => message.type === 'error')) {
        throw compilationError(compilationMessages)
    }

    const descriptor = {
        label: 'h3-compute boundary pipeline',
        layout: pipelineLayout,
        compute: {module: shaderModule, entryPoint: 'h3ComputeMain'},
    }
    const pipeline = typeof device.createComputePipelineAsync === 'function'
        ? await device.createComputePipelineAsync(descriptor)
        : device.createComputePipeline(descriptor)
    return {bindGroupLayout, compilationMessages, pipeline, shaderModule}
}

function emptyReadback() {
    return Object.freeze({
        cellCount: 0,
        mercator: new Float32Array(),
        counts: new Uint32Array(),
        statuses: new Uint32Array(),
        raw: new ArrayBuffer(0),
    })
}

function decodeReadback(raw, cellCount) {
    const mercator = new Float32Array(cellCount * H3_COMPUTE_BOUNDARY_SLOTS * 2)
    const counts = new Uint32Array(cellCount)
    const statuses = new Uint32Array(cellCount)
    const view = new DataView(raw)

    for (let cell = 0; cell < cellCount; cell++) {
        const recordOffset = cell * H3_COMPUTE_OUTPUT_STRIDE
        const coordinateOffset = cell * H3_COMPUTE_BOUNDARY_SLOTS * 2
        for (let component = 0; component < H3_COMPUTE_BOUNDARY_SLOTS * 2; component++) {
            mercator[coordinateOffset + component] = view.getFloat32(recordOffset + component * 4, true)
        }
        counts[cell] = view.getUint32(recordOffset + 80, true)
        statuses[cell] = view.getUint32(recordOffset + 84, true)
    }
    return Object.freeze({cellCount, mercator, counts, statuses, raw})
}

async function mapReadbackBuffer(buffer, byteLength, cellCount) {
    try {
        await buffer.mapAsync(MAP_MODE.READ, 0, byteLength)
        const raw = new ArrayBuffer(byteLength)
        new Uint8Array(raw).set(new Uint8Array(buffer.getMappedRange(0, byteLength)))
        buffer.unmap()
        return decodeReadback(raw, cellCount)
    } finally {
        buffer.destroy()
    }
}

export class H3ComputeBatch {
    constructor(module, {bindGroup, idBuffer, outputBuffer, count, inputByteLength, outputByteLength}) {
        this.module = module
        this.bindGroup = bindGroup
        this.idBuffer = idBuffer
        this.outputBuffer = outputBuffer
        this.count = count
        this.inputByteLength = inputByteLength
        this.outputByteLength = outputByteLength
        this.dispatched = false
        this.destroyed = false
    }

    dispatch(options) {
        return this.module.dispatch(this, options)
    }

    readback() {
        return this.module.readback(this)
    }

    destroy() {
        if (this.destroyed) return
        this.destroyed = true
        this.module?._batches.delete(this)
        this.idBuffer.destroy()
        this.outputBuffer.destroy()
    }
}

export class H3ComputeModule {
    constructor({adapter, bindGroupLayout, compilationMessages, device, ownsDevice, pipeline, shaderModule}) {
        this.adapter = adapter
        this.device = device
        this.pipeline = pipeline
        this.shaderModule = shaderModule
        this.compilationMessages = compilationMessages
        this.state = 'ready'
        this.lossInfo = null
        this._bindGroupLayout = bindGroupLayout
        this._ownsDevice = ownsDevice
        this._batches = new Set()
        this._terminalError = null

        device.lost?.then(info => {
            if (this.state !== 'ready') return
            this.state = 'lost'
            this.lossInfo = info
            this._terminalError = new Error(`WebGPU device lost: ${info.message || info.reason || 'unknown reason'}`)
        })
    }

    _assertReady() {
        if (this.state !== 'ready') {
            throw this._terminalError || new Error(`H3 compute module is ${this.state}`)
        }
    }

    _assertBatch(batch) {
        this._assertReady()
        if (!(batch instanceof H3ComputeBatch) || batch.module !== this) {
            throw new TypeError('batch was not created by this H3 compute module')
        }
        if (batch.destroyed) throw new Error('H3 compute batch is destroyed')
    }

    _checkBufferSize(byteLength, label) {
        const maxBufferSize = Number(this.device.limits?.maxBufferSize ?? Infinity)
        const maxStorageSize = Number(this.device.limits?.maxStorageBufferBindingSize ?? Infinity)
        if (byteLength > maxBufferSize) {
            throw new RangeError(`${label} needs ${byteLength} bytes, exceeding maxBufferSize`)
        }
        if (byteLength > maxStorageSize) {
            throw new RangeError(`${label} needs ${byteLength} bytes, exceeding maxStorageBufferBindingSize`)
        }
    }

    /**
     * Upload split H3 IDs. Call as `uploadIds(lower, upper)`, with
     * `{lower, upper}`, or with an interleaved `[lower, upper, ...]`
     * Uint32Array. The returned batch exposes both GPU buffers.
     */
    uploadIds(idsOrLower, upper) {
        this._assertReady()
        const words = prepareIdWords(idsOrLower, upper)
        const count = words.length / 2
        const inputByteLength = count * 8
        const outputByteLength = count * H3_COMPUTE_OUTPUT_STRIDE
        const allocatedInputBytes = Math.max(8, inputByteLength)
        const allocatedOutputBytes = Math.max(H3_COMPUTE_OUTPUT_STRIDE, outputByteLength)
        this._checkBufferSize(allocatedInputBytes, 'H3 ID buffer')
        this._checkBufferSize(allocatedOutputBytes, 'H3 boundary output buffer')

        let idBuffer
        let outputBuffer
        try {
            idBuffer = createInitializedBuffer(this.device, {
                label: 'h3-compute little-endian ID words',
                size: allocatedInputBytes,
                usage: BUFFER_USAGE.STORAGE,
            }, words)
            outputBuffer = this.device.createBuffer({
                label: 'h3-compute boundary records',
                size: allocatedOutputBytes,
                usage: BUFFER_USAGE.STORAGE | BUFFER_USAGE.COPY_SRC,
            })
            const bindGroup = this.device.createBindGroup({
                label: 'h3-compute batch bindings',
                layout: this._bindGroupLayout,
                entries: [
                    {binding: 0, resource: {buffer: idBuffer}},
                    {binding: 1, resource: {buffer: outputBuffer}},
                ],
            })
            const batch = new H3ComputeBatch(this, {
                bindGroup,
                idBuffer,
                outputBuffer,
                count,
                inputByteLength,
                outputByteLength,
            })
            this._batches.add(batch)
            return batch
        } catch (error) {
            idBuffer?.destroy()
            outputBuffer?.destroy()
            throw error
        }
    }

    /** Submit one work item per ID. Set `readback: true` to receive decoded CPU arrays. */
    dispatch(batch, {readback = false} = {}) {
        this._assertBatch(batch)
        if (batch.count === 0) {
            batch.dispatched = true
            return readback ? Promise.resolve(emptyReadback()) : batch
        }

        const workgroupCount = Math.ceil(batch.count / H3_COMPUTE_WORKGROUP_SIZE)
        const workgroupLimit = Number(this.device.limits?.maxComputeWorkgroupsPerDimension ?? Infinity)
        if (workgroupCount > workgroupLimit) {
            throw new RangeError(`H3 batch needs ${workgroupCount} workgroups, exceeding maxComputeWorkgroupsPerDimension`)
        }

        const readbackBuffer = readback ? this.device.createBuffer({
            label: 'h3-compute readback',
            size: batch.outputByteLength,
            usage: BUFFER_USAGE.COPY_DST | BUFFER_USAGE.MAP_READ,
        }) : null
        try {
            const encoder = this.device.createCommandEncoder({label: 'h3-compute dispatch'})
            const pass = encoder.beginComputePass({label: 'h3-compute boundary pass'})
            pass.setPipeline(this.pipeline)
            pass.setBindGroup(0, batch.bindGroup)
            pass.dispatchWorkgroups(workgroupCount)
            pass.end()
            if (readbackBuffer) {
                encoder.copyBufferToBuffer(
                    batch.outputBuffer,
                    0,
                    readbackBuffer,
                    0,
                    batch.outputByteLength,
                )
            }
            this.device.queue.submit([encoder.finish()])
            batch.dispatched = true
        } catch (error) {
            readbackBuffer?.destroy()
            throw error
        }
        return readbackBuffer
            ? mapReadbackBuffer(readbackBuffer, batch.outputByteLength, batch.count)
            : batch
    }

    /** Copy a previously dispatched batch to a temporary MAP_READ buffer. */
    readback(batch) {
        this._assertBatch(batch)
        if (!batch.dispatched) throw new Error('H3 compute batch has not been dispatched')
        if (batch.count === 0) return Promise.resolve(emptyReadback())

        const buffer = this.device.createBuffer({
            label: 'h3-compute readback',
            size: batch.outputByteLength,
            usage: BUFFER_USAGE.COPY_DST | BUFFER_USAGE.MAP_READ,
        })
        try {
            const encoder = this.device.createCommandEncoder({label: 'h3-compute readback copy'})
            encoder.copyBufferToBuffer(batch.outputBuffer, 0, buffer, 0, batch.outputByteLength)
            this.device.queue.submit([encoder.finish()])
        } catch (error) {
            buffer.destroy()
            throw error
        }
        return mapReadbackBuffer(buffer, batch.outputByteLength, batch.count)
    }

    destroy({destroyDevice = this._ownsDevice} = {}) {
        if (this.state === 'destroyed') return
        this.state = 'destroyed'
        for (const batch of Array.from(this._batches)) batch.destroy()
        if (destroyDevice) this.device.destroy()
    }
}

export function isH3ComputeWebGPUSupported(gpu = globalThis.navigator?.gpu) {
    return Boolean(gpu)
}

/**
 * Initialize the H3 compute shader and pipeline. A supplied `device` remains
 * caller-owned. Without one, this requests an adapter/device and returns null
 * when WebGPU or an adapter is unavailable.
 */
export async function createH3ComputeModule(options = {}) {
    let {adapter = null, device = null} = options
    let ownsDevice = false
    if (!device) {
        if (!adapter) {
            const gpu = options.gpu || globalThis.navigator?.gpu
            if (!gpu) return null
            adapter = await gpu.requestAdapter({
                powerPreference: options.powerPreference,
                forceFallbackAdapter: options.forceFallbackAdapter,
            })
        }
        if (!adapter) return null
        device = await adapter.requestDevice(options.deviceDescriptor)
        ownsDevice = true
    }

    try {
        const pipelineResources = await createPipeline(device)
        return new H3ComputeModule({
            adapter,
            device,
            ownsDevice,
            ...pipelineResources,
        })
    } catch (error) {
        if (ownsDevice) device.destroy()
        throw error
    }
}
