import {MapboxOverlay} from '@deck.gl/mapbox'
import {H3HexagonLayer, TileLayer} from '@deck.gl/geo-layers'
import {BitmapLayer, GeoJsonLayer } from '@deck.gl/layers'
import {PackedH3FillTransition, PackedH3HexagonLayer, packH3Geometry} from 'faster-h3-for-deckgl'
import {CSVLoader} from '@loaders.gl/csv'
import {ArrowLoader} from '@loaders.gl/arrow'
import {ParquetWasmLoader} from '@loaders.gl/parquet'
import {load, parse} from '@loaders.gl/core'
import maplibregl from 'maplibre-gl'
import * as d3 from 'd3'
import {cellToBoundary, cellToLatLng, latLngToCell, getResolution, cellToParent, cellToChildren, h3IndexToSplitLong, splitLongToH3Index} from 'h3-js'
import {assertMercatorProjection, createMapLibreMatrixLayer, createPackedH3Renderer, DIRECT_H3_MAX_ZOOM as H3_DIRECT_MAX_ZOOM} from './webgpu/packed-h3-renderer.js'
import 'maplibre-gl/dist/maplibre-gl.css'
import * as observablehq from './vendor/observablehq' // from https://observablehq.com/@d3/color-legend
import {getCitiesStartsWith} from 'tiny-geocoder'
import {render_cartogram} from './cartogram'

const params = new URLSearchParams(window.location.search)
function settingEnabled(value, fallback = false) {
    if (value == null) return fallback
    if (typeof value === 'boolean') return value
    return !['0', 'false', 'off', 'no'].includes(String(value).trim().toLowerCase())
}

function flagEnabled(name) {
    return params.has(name) && settingEnabled(params.get(name), true)
}
function rendererSetting(value) {
    const renderer = String(value || 'deck').trim().toLowerCase()
    return ['auto', 'webgpu', 'deck'].includes(renderer) ? renderer : 'deck'
}
function webgpuGeometrySetting(value) {
    return String(value || 'packed').trim().toLowerCase() === 'compute' ? 'compute' : 'packed'
}
const perfEnabled = flagEnabled('perf')
const svgPerfEnabled = flagEnabled('svgperf')
let perfSocket = null
function parseH3Precision(value) {
    if (value == null || value === '') return undefined
    if (String(value).toLowerCase() === 'auto') return 'auto'
    return settingEnabled(value, false)
}
const h3Precision = parseH3Precision(params.get('h3precision')) ?? true
function h3LayerProps() {
    return {highPrecision: h3Precision}
}
const syncDebugEnabled = flagEnabled('sync') || perfEnabled
function syncLog(label, details) {
    if (syncDebugEnabled) console.info(`[sync] ${label}`, details || {})
}
function svgPerfLog(label, details) {
    if (svgPerfEnabled) console.info(`[svgperf] ${label}`, details || {})
}
const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now())
const loadProgress = {
    root: document.getElementById('load-progress'),
    bar: document.getElementById('load-progress-bar'),
    label: document.getElementById('load-progress-label'),
    percent: document.getElementById('load-progress-percent'),
    value: 0,
    completedWork: 0,
    totalWork: 0,
    active: new Map(),
    nextTaskId: 1,
    timer: null,
    estimates: {},
    complete: false,
    finishToken: 0,
}

const LOAD_PROGRESS_ESTIMATE_KEY = 'h3mon-load-progress-estimates-v1'
const LOAD_PROGRESS_DEFAULTS = {
    'cartogram.weights.fetch': 35,
    'cartogram.weights.arrayBuffer': 1000,
    'cartogram.weights.arrow_parse': 5,
    'cartogram.weights.column.x': 2,
    'cartogram.weights.column.y': 2,
    'cartogram.weights.column.code': 2,
    'cartogram.weights.column.index_lower': 2,
    'cartogram.weights.column.index_upper': 2,
    'cartogram.weights.column.weight': 2,
    'cartogram.weights.column.weight_mean': 2,
    'cartogram.cells.precompute': 250,
    'data.fetch': 20,
    'data.read_arrayBuffer': 220,
    'data.read_text': 80,
    'data.arrow_parse': 10,
    'data.csv_parse': 80,
    'data.csv_to_columns': 50,
    'data.arrow_column.median': 2,
    'data.arrow_column.index': 320,
    'data.arrow_column.index_lower': 2,
    'data.arrow_column.index_upper': 2,
    'data.arrow_column.value': 2,
    'data.quantile.ecdf': 15,
    'data.quantile.assign': 25,
    'data.h3_row_lookup.build': 100,
    'cartogram.js_group.data_map': 100,
    'cartogram.js_group.accumulate': 650,
    'cartogram.js_group.output': 5,
    'cartogram.child_rollup.data_map': 200,
    'cartogram.child_rollup.accumulate': 1500,
    'cartogram.child_rollup.output': 10,
    'cartogram.parent_downproject.data_map': 100,
    'cartogram.parent_downproject.project': 650,
    'cartogram.parent_downproject.output': 5,
    'cartogram.h3_to_xy.build': 950,
    'cartogram.quantile.ecdf': 15,
    'cartogram.quantile.assign_data': 25,
    'cartogram.quantile.assign_cartogram': 10,
    'cartogram.render.call': 750,
    'deck.hex_layer.create': 5,
    'deck.geojson_layer.create': 20,
    'deck.set_layers': 5,
    'deck.after_render': 650,
}
const LOAD_PROGRESS_DEFAULT_PROFILE = [
    'cartogram.weights.fetch',
    'cartogram.weights.arrayBuffer',
    'cartogram.weights.arrow_parse',
    'cartogram.weights.column.x',
    'cartogram.weights.column.y',
    'cartogram.weights.column.code',
    'cartogram.weights.column.index_lower',
    'cartogram.weights.column.index_upper',
    'cartogram.weights.column.weight',
    'cartogram.weights.column.weight_mean',
    'cartogram.cells.precompute',
    'data.fetch',
    'data.read_arrayBuffer',
    'data.arrow_parse',
    'data.arrow_column.median',
    'data.arrow_column.index',
    'data.arrow_column.index_lower',
    'data.arrow_column.index_upper',
    'data.arrow_column.value',
    'data.quantile.ecdf',
    'data.quantile.assign',
    'data.h3_row_lookup.build',
    'cartogram.js_group.data_map',
    'cartogram.js_group.accumulate',
    'cartogram.js_group.output',
    'cartogram.h3_to_xy.build',
    'cartogram.quantile.ecdf',
    'cartogram.quantile.assign_data',
    'cartogram.quantile.assign_cartogram',
    'cartogram.render.call',
    'deck.hex_layer.create',
    'deck.set_layers',
    'deck.after_render',
]
const LOAD_PROGRESS_NO_CARTOGRAM_PROFILE = LOAD_PROGRESS_DEFAULT_PROFILE.filter(label => !label.startsWith('cartogram.'))
let loadProgressProfile = LOAD_PROGRESS_DEFAULT_PROFILE
const LOAD_PROGRESS_LABELS = {
    'cartogram.weights.fetch': 'Loading cartogram weights',
    'cartogram.weights.arrayBuffer': 'Downloading cartogram weights',
    'cartogram.weights.arrow_parse': 'Parsing cartogram weights',
    'cartogram.weights.column.x': 'Reading cartogram coordinates',
    'cartogram.weights.column.y': 'Reading cartogram coordinates',
    'cartogram.weights.column.code': 'Reading cartogram borders',
    'cartogram.weights.column.index_lower': 'Reading cartogram H3 indexes',
    'cartogram.weights.column.index_upper': 'Reading cartogram H3 indexes',
    'cartogram.weights.column.weight': 'Reading cartogram weights',
    'cartogram.weights.column.weight_mean': 'Reading cartogram weights',
    'cartogram.cells.precompute': 'Preparing cartogram cells',
    'data.fetch': 'Loading data',
    'data.read_arrayBuffer': 'Downloading data',
    'data.read_text': 'Downloading data',
    'data.arrow_parse': 'Parsing data',
    'data.csv_parse': 'Parsing CSV data',
    'data.csv_to_columns': 'Converting CSV columns',
    'data.arrow_column.median': 'Reading data columns',
    'data.arrow_column.index': 'Decoding H3 indexes',
    'data.arrow_column.index_lower': 'Reading H3 indexes',
    'data.arrow_column.index_upper': 'Reading H3 indexes',
    'data.arrow_column.value': 'Reading values',
    'data.quantile.ecdf': 'Calculating quantiles',
    'data.quantile.assign': 'Assigning quantiles',
    'data.h3_row_lookup.build': 'Indexing map cells',
    'cartogram.js_group.data_map': 'Indexing data by H3',
    'cartogram.js_group.accumulate': 'Aggregating cartogram cells',
    'cartogram.js_group.output': 'Preparing cartogram values',
    'cartogram.child_rollup.data_map': 'Indexing child H3 data',
    'cartogram.child_rollup.accumulate': 'Rolling up child H3 cells',
    'cartogram.child_rollup.output': 'Preparing child rollup values',
    'cartogram.parent_downproject.data_map': 'Indexing parent H3 data',
    'cartogram.parent_downproject.project': 'Projecting parent H3 values',
    'cartogram.parent_downproject.output': 'Preparing parent projection values',
    'cartogram.h3_to_xy.build': 'Preparing map/cartogram links',
    'cartogram.quantile.ecdf': 'Calculating cartogram quantiles',
    'cartogram.quantile.assign_data': 'Assigning map colours',
    'cartogram.quantile.assign_cartogram': 'Assigning cartogram colours',
    'cartogram.render.call': 'Drawing cartogram',
    'deck.hex_layer.create': 'Preparing map layer',
    'deck.geojson_layer.create': 'Preparing GeoJSON layer',
    'deck.set_layers': 'Rendering map',
    'deck.after_render': 'Drawing H3 layer',
}

function loadProgressEstimates() {
    try {
        return {...LOAD_PROGRESS_DEFAULTS, ...JSON.parse(localStorage.getItem(LOAD_PROGRESS_ESTIMATE_KEY) || '{}')}
    } catch (_) {
        return {...LOAD_PROGRESS_DEFAULTS}
    }
}

function saveProgressEstimate(label, elapsed) {
    if (!LOAD_PROGRESS_DEFAULTS[label]) return
    const old = loadProgress.estimates[label] || LOAD_PROGRESS_DEFAULTS[label]
    loadProgress.estimates[label] = Math.max(1, old * 0.75 + elapsed * 0.25)
    try {
        localStorage.setItem(LOAD_PROGRESS_ESTIMATE_KEY, JSON.stringify(loadProgress.estimates))
    } catch (_) {}
}

function configureLoadProgress(labels = loadProgressProfile) {
    loadProgressProfile = labels
    loadProgress.estimates = loadProgressEstimates()
    loadProgress.completedWork = 0
    loadProgress.active.clear()
    loadProgress.totalWork = labels.reduce((sum, label) => sum + (loadProgress.estimates[label] || LOAD_PROGRESS_DEFAULTS[label] || 0), 0)
}

function nextPaint() {
    if (typeof requestAnimationFrame === 'undefined') return Promise.resolve()
    return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
}

async function yieldToPaint(label) {
    setLoadStage(label)
    await nextPaint()
}

function setLoadProgress(value, label) {
    if (!loadProgress.root) return
    loadProgress.value = Math.max(loadProgress.value, Math.min(100, Math.max(0, value)))
    const rounded = loadProgress.value >= 100 ? 100 : Math.floor(loadProgress.value)
    if (label) loadProgress.label.textContent = label
    loadProgress.percent.textContent = `${rounded}%`
    loadProgress.bar.style.width = `${loadProgress.value}%`
    loadProgress.root.setAttribute('aria-valuenow', String(rounded))
    if (label) loadProgress.root.setAttribute('aria-label', label)
    document.body.classList.remove('load-complete')
}

function setLoadStage(label) {
    if (!loadProgress.root || !label) return
    loadProgress.label.textContent = label
    loadProgress.root.setAttribute('aria-label', label)
    document.body.classList.remove('load-complete')
}

function renderLoadProgress(label) {
    if (!loadProgress.root || !loadProgress.totalWork) return
    const activeWork = [...loadProgress.active.values()].reduce((sum, task) => {
        const elapsed = now() - task.startedAt
        return sum + Math.min(task.estimate * 0.95, elapsed)
    }, 0)
    const value = Math.min(99, ((loadProgress.completedWork + activeWork) / loadProgress.totalWork) * 100)
    setLoadProgress(value, label)
}

function startLoadTask(label) {
    if (!loadProgress.root || loadProgress.complete || !LOAD_PROGRESS_LABELS[label]) return null
    const id = loadProgress.nextTaskId++
    const estimate = loadProgress.estimates[label] || LOAD_PROGRESS_DEFAULTS[label] || 1
    loadProgress.active.set(id, {label, estimate, startedAt: now()})
    setLoadStage(LOAD_PROGRESS_LABELS[label])
    renderLoadProgress(LOAD_PROGRESS_LABELS[label])
    if (!loadProgress.timer) {
        loadProgress.timer = setInterval(() => renderLoadProgress(), 100)
    }
    return id
}

function finishLoadTask(id, elapsed) {
    if (!id) return
    const task = loadProgress.active.get(id)
    if (!task) return
    loadProgress.active.delete(id)
    loadProgress.completedWork += task.estimate
    saveProgressEstimate(task.label, elapsed)
    if (loadProgress.active.size === 0 && loadProgress.timer) {
        clearInterval(loadProgress.timer)
        loadProgress.timer = null
    }
    renderLoadProgress(LOAD_PROGRESS_LABELS[task.label])
}

function resetLoadProgress(label = 'Loading…') {
    if (!loadProgress.root) return
    loadProgress.finishToken++
    loadProgress.value = 0
    configureLoadProgress()
    loadProgress.complete = false
    loadProgress.bar.style.width = '0%'
    loadProgress.percent.textContent = '0%'
    loadProgress.label.textContent = label
    loadProgress.root.setAttribute('aria-valuenow', '0')
    loadProgress.root.setAttribute('aria-label', label)
    document.body.classList.remove('load-complete')
}

function finishLoadProgress() {
    if (!loadProgress.root) return
    if (loadProgress.timer) {
        clearInterval(loadProgress.timer)
        loadProgress.timer = null
    }
    loadProgress.active.clear()
    loadProgress.completedWork = loadProgress.totalWork
    loadProgress.complete = true
    const finishToken = ++loadProgress.finishToken
    setLoadStage('Finishing render')
    loadProgress.bar.style.width = '100%'

    let settled = false
    const markReady = () => {
        if (settled) return
        settled = true
        loadProgress.bar.removeEventListener('transitionend', onTransitionEnd)
        if (finishToken !== loadProgress.finishToken) return
        loadProgress.value = 100
        loadProgress.percent.textContent = '100%'
        loadProgress.label.textContent = 'Ready'
        loadProgress.root.setAttribute('aria-valuenow', '100')
        loadProgress.root.setAttribute('aria-label', 'Ready')
        setTimeout(() => {
            if (finishToken === loadProgress.finishToken && loadProgress.complete) document.body.classList.add('load-complete')
        }, 700)
    }
    const onTransitionEnd = event => {
        if (event.target === loadProgress.bar && event.propertyName === 'width') markReady()
    }
    loadProgress.bar.addEventListener('transitionend', onTransitionEnd)
    setTimeout(markReady, 400)
}

async function waitWithLoadProgress(promise, label) {
    setLoadStage(label)
    return promise
}

function perfTimer(label, details) {
    const progressTask = startLoadTask(label)
    const start = now()
    return (extra) => {
        const elapsed = now() - start
        finishLoadTask(progressTask, elapsed)
        logPerf(label, elapsed, details, extra)
    }
}

function detailPerfTimer(label, details) {
    const start = now()
    return extra => logPerf(label, now() - start, details, extra)
}

function logPerf(label, elapsed, details, extra) {
    if (!perfEnabled) return
    const merged = {...(details || {}), ...(extra || {})}
    if (Object.keys(merged).length) {
        console.info(`[perf] ${label}: ${elapsed.toFixed(1)}ms`, merged)
    } else {
        console.info(`[perf] ${label}: ${elapsed.toFixed(1)}ms`)
    }
    if (label === 'data.reload.total') {
        sendPerfTelemetry(label, {...merged, durationMs: Number(elapsed.toFixed(1))})
    }
}

function sendPerfTelemetry(event, details) {
    if (!perfEnabled || perfSocket?.readyState !== WebSocket.OPEN) return
    try {
        perfSocket.send(`perf:${JSON.stringify({event, timestamp: new Date().toISOString(), ...details})}`)
    } catch (error) {
        console.warn('[perf] Failed to submit telemetry', error)
    }
}

async function measurePerf(label, details, fn) {
    if (typeof details === 'function') {
        fn = details
        details = null
    }
    const done = perfTimer(label, details)
    try {
        return await fn()
    } finally {
        done()
    }
}

async function parseArrowTable(buf, label, details = {}) {
    const table = await measurePerf(label, details, () => ArrowLoader.parseSync(buf, {arrow: {shape: 'arrow-table'}}))
    return table.data
}

async function parseCsvRows(text) {
    const parsed = await measurePerf('data.csv_parse', {bytes: text.length}, () => parse(text, CSVLoader))
    return parsed.data || parsed
}

function rowsToColumns(rows) {
    const fields = []
    const seen = new Set()
    for (const row of rows) {
        for (const field of Object.keys(row)) {
            if (!seen.has(field)) {
                seen.add(field)
                fields.push(field)
            }
        }
    }
    const cols = {}
    for (const field of fields) cols[field] = new Array(rows.length)
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i]
        for (const field of fields) cols[field][i] = row[field] === '' ? null : (row[field] ?? null)
    }
    return cols
}

function columnValue(column, i) {
    return column && typeof column.get === 'function' ? column.get(i) : column[i]
}

function columnLength(column) {
    return column ? column.length : 0
}

async function materializeArrowColumn(table, name, labelPrefix) {
    const column = table.getChild(name)
    if (!column) return null
    const label = `${labelPrefix}.${name}`
    const estimate = loadProgress.estimates[label] || LOAD_PROGRESS_DEFAULTS[label] || 0
    if (estimate > 50) await yieldToPaint(LOAD_PROGRESS_LABELS[label])
    return measurePerf(label, {rows: column.length}, () => column.toArray())
}

async function materializeArrowColumns(table, names, labelPrefix) {
    const cols = {}
    for (const name of names) {
        const column = await materializeArrowColumn(table, name, labelPrefix)
        if (column) cols[name] = column
    }
    return cols
}

function normalizeLng360(lng) {
    return ((lng % 360) + 360) % 360
}

function wrappedLngBounds(longitudes, referenceLng = 0) {
    longitudes.sort((a, b) => a - b)

    let largestGap = longitudes[0] + 360 - longitudes[longitudes.length - 1]
    let gapStart = longitudes.length - 1
    for (let i = 0; i < longitudes.length - 1; i++) {
        const gap = longitudes[i + 1] - longitudes[i]
        if (gap > largestGap) {
            largestGap = gap
            gapStart = i
        }
    }

    let west
    let east
    if (gapStart === longitudes.length - 1) {
        west = longitudes[0]
        east = longitudes[longitudes.length - 1]
    } else {
        west = longitudes[gapStart + 1]
        east = longitudes[gapStart] + 360
    }

    const center = (west + east) / 2
    const shift = Math.round((referenceLng - center) / 360) * 360
    return [west + shift, east + shift]
}

function unwrapLng(lng, referenceLng = 0) {
    return lng + Math.round((referenceLng - lng) / 360) * 360
}

function percentile(values, p) {
    values.sort((a, b) => a - b)
    const i = Math.min(values.length - 1, Math.max(0, Math.floor((values.length - 1) * p)))
    return values[i]
}

function computeH3Bounds(indices, options = {}) {
    if (typeof options === 'number') options = {referenceLng: options}
    const referenceLng = options.referenceLng || 0
    const trim = Math.min(Math.max(options.trim || 0, 0), 0.49)
    const centersByH3 = new Map()
    const centerRows = []
    let invalidCount = 0
    let emptyCount = 0

    for (const idx of indices) {
        if (!idx) {
            emptyCount++
            continue
        }
        let center = centersByH3.get(idx)
        if (center === undefined) {
            try {
                const [lat, lng] = cellToLatLng(idx)
                center = {lat, lng, unwrappedLng: unwrapLng(lng, referenceLng)}
            } catch (e) {
                invalidCount++
                center = null
                console.warn('Invalid H3 index:', idx, e)
            }
            centersByH3.set(idx, center)
        }
        if (center) centerRows.push({h: idx, ...center})
    }

    if (!centerRows.length) return null

    let candidateH3 = new Set()
    for (const [h, center] of centersByH3) {
        if (center) candidateH3.add(h)
    }

    let trimMeta = null
    if (trim > 0 && centerRows.length > 2) {
        const minLatTrim = percentile(centerRows.map(r => r.lat), trim)
        const maxLatTrim = percentile(centerRows.map(r => r.lat), 1 - trim)
        const minLngTrim = percentile(centerRows.map(r => r.unwrappedLng), trim)
        const maxLngTrim = percentile(centerRows.map(r => r.unwrappedLng), 1 - trim)
        const trimmedCandidates = new Set()
        let keptRows = 0
        for (const row of centerRows) {
            if (row.lat < minLatTrim || row.lat > maxLatTrim ||
                row.unwrappedLng < minLngTrim || row.unwrappedLng > maxLngTrim) continue
            trimmedCandidates.add(row.h)
            keptRows++
        }
        if (trimmedCandidates.size) {
            candidateH3 = trimmedCandidates
            trimMeta = {
                trim,
                centerRows: centerRows.length,
                keptRows,
                trimmedRows: centerRows.length - keptRows,
                keptUniqueH3: candidateH3.size,
                centerLngSpan: maxLngTrim - minLngTrim,
                centerLatSpan: maxLatTrim - minLatTrim,
                centerBounds: [[minLngTrim, minLatTrim], [maxLngTrim, maxLatTrim]],
            }
        }
    }

    let minLat = 90, maxLat = -90
    const longitudes = []
    let boundaryInvalidCount = 0
    for (const idx of candidateH3) {
        try {
            const boundary = cellToBoundary(idx, true)
            for (const [lng, lat] of boundary) {
                if (lat < minLat) minLat = lat
                if (lat > maxLat) maxLat = lat
                longitudes.push(normalizeLng360(lng))
            }
        } catch (e) {
            boundaryInvalidCount++
            console.warn('Invalid H3 index:', idx, e)
        }
    }
    if (minLat === 90 || !longitudes.length) return null
    const [minLng, maxLng] = wrappedLngBounds(longitudes, referenceLng)
    const bounds = [[minLng, minLat], [maxLng, maxLat]]
    return {
        bounds,
        meta: {
            inputH3: indices.length,
            uniqueH3: centersByH3.size - invalidCount,
            fitUniqueH3: candidateH3.size,
            emptyH3: emptyCount,
            invalidH3: invalidCount + boundaryInvalidCount,
            vertices: longitudes.length,
            referenceLng,
            lngSpan: maxLng - minLng,
            latSpan: maxLat - minLat,
            ...trimMeta,
        },
    }
}

let highlightLayer = null
let renderLayers = null
let updateVisibleH3Chunks = null
let hex_flying = false
let hexFlyToken = 0
let h3toXY = null
let cartogramApi = null
let cartogramEnabled = false
let cartogramInit = null
let cartogramWeightsFile = null
let cartoAggCols = null
let cartoRes = 5
let dataH3Res = null
let cartogramAgg = null
let cartogramRawCols = null
let h3toXYPromise = null
const MAX_CARTOGRAM_RESOLUTION_GAP = 2

function addCount(counts, value) {
    counts.set(value, (counts.get(value) || 0) + 1)
}

function dominant(counts) {
    let best = null
    let bestCount = -1
    for (const [value, count] of counts) {
        if (count > bestCount) {
            best = value
            bestCount = count
        }
    }
    return best
}

function dominantLabel(statsByLabel) {
    let best = null
    let bestCount = -1
    let bestProminence = null
    for (const [label, stats] of statsByLabel) {
        if ((stats.prominence != null && (bestProminence == null || stats.prominence > bestProminence)) ||
            (stats.prominence === bestProminence && stats.count > bestCount)) {
            best = label
            bestCount = stats.count
            bestProminence = stats.prominence
        }
    }
    return best
}

function toNumber(value) {
    return typeof value === 'bigint' ? Number(value) : value
}

function toFiniteNumber(value) {
    if (value == null) return null
    if (typeof value === 'string') {
        value = value.trim()
        if (value === '') return null
    }
    if (!['bigint', 'number', 'string'].includes(typeof value)) return null
    const number = Number(value)
    return Number.isFinite(number) ? number : null
}

function toStringValue(value) {
    return typeof value === 'bigint' ? value.toString() : String(value)
}

const H3_INDEX_LOWER = 'index_lower'
const H3_INDEX_UPPER = 'index_upper'
const COLOUR_PALETTE_SIZE = 1024
const QUANTILE_SAMPLE_SIZE = 8192
const COLOUR_TRANSITION_DURATION = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 1000
const H3_CHUNK_LOAD_PADDING = 0.5
const H3_CHUNK_RETAIN_PADDING = 0.75
const H3_CHUNK_MAX_COUNT = 512
const H3_DIRECT_MAX_RESOLUTION = 10

function hasSplitH3Index(cols) {
    return Boolean(cols && cols[H3_INDEX_LOWER] && cols[H3_INDEX_UPPER])
}

function hasH3Index(cols) {
    return hasSplitH3Index(cols) || Boolean(cols && cols.index)
}

function h3RowCount(cols) {
    return hasSplitH3Index(cols) ? columnLength(cols[H3_INDEX_LOWER]) : columnLength(cols.index)
}

function splitH3IndexAt(cols, i, target = [0, 0]) {
    target[0] = toNumber(columnValue(cols[H3_INDEX_LOWER], i))
    target[1] = toNumber(columnValue(cols[H3_INDEX_UPPER], i))
    return target
}

function h3IndexInputAt(cols, i, target = [0, 0]) {
    return hasSplitH3Index(cols) ? splitH3IndexAt(cols, i, target) : toStringValue(columnValue(cols.index, i))
}

function h3IndexStringAt(cols, i) {
    if (hasSplitH3Index(cols)) {
        return splitLongToH3Index(
            toNumber(columnValue(cols[H3_INDEX_LOWER], i)),
            toNumber(columnValue(cols[H3_INDEX_UPPER], i))
        )
    }
    return toStringValue(columnValue(cols.index, i))
}

function ensureH3StringColumn(cols, label = 'h3.index_strings.from_split') {
    if (!hasSplitH3Index(cols)) return cols.index || null
    if (cols._h3Strings) return cols._h3Strings
    const rows = h3RowCount(cols)
    const doneStrings = perfTimer(label, {rows})
    const strings = new Array(rows)
    for (let i = 0; i < rows; i++) strings[i] = h3IndexStringAt(cols, i)
    cols._h3Strings = strings
    doneStrings()
    return strings
}

function splitMapGet(root, lower, upper) {
    const byLower = root.get(upper)
    return byLower ? byLower.get(lower) : undefined
}

function splitMapHas(root, lower, upper) {
    const byLower = root.get(upper)
    return byLower ? byLower.has(lower) : false
}

function splitMapSet(root, lower, upper, value) {
    let byLower = root.get(upper)
    if (!byLower) {
        byLower = new Map()
        root.set(upper, byLower)
    }
    const isNew = !byLower.has(lower)
    byLower.set(lower, value)
    return isNew
}

function createSplitH3ToXYMap() {
    const root = new Map()
    const entries = []
    return {
        split: true,
        entries,
        size: 0,
        get(h3) {
            const split = Array.isArray(h3) ? h3 : h3IndexToSplitLong(String(h3))
            return splitMapGet(root, split[0], split[1])
        },
        getSplit(lower, upper) {
            return splitMapGet(root, lower, upper)
        },
        setSplit(lower, upper, entry) {
            if (splitMapSet(root, lower, upper, entry)) {
                entries.push(entry)
                this.size++
            }
        },
        *keys() {
            for (const entry of entries) yield splitLongToH3Index(entry.lower, entry.upper)
        },
        *[Symbol.iterator]() {
            for (const entry of entries) yield [[entry.lower, entry.upper], entry]
        },
    }
}

function addH3MapCell(map, split, lower, upper, h3, cellIndex, x, y) {
    let entry = split ? map.getSplit(lower, upper) : map.get(h3)
    if (!entry) {
        entry = split
            ? {lower, upper, cellIndices: [], xMin: x, xMax: x, yMin: y, yMax: y}
            : {cellIndices: [], xMin: x, xMax: x, yMin: y, yMax: y}
        if (split) map.setSplit(lower, upper, entry)
        else map.set(h3, entry)
    } else {
        if (x < entry.xMin) entry.xMin = x
        if (x > entry.xMax) entry.xMax = x
        if (y < entry.yMin) entry.yMin = y
        if (y > entry.yMax) entry.yMax = y
    }
    entry.cellIndices.push(cellIndex)
    return entry
}

function h3EntryCellCount(entry) {
    return entry?.cellIndices ? entry.cellIndices.length : (entry?.cells?.length ?? 0)
}

const HTML_ESCAPES = {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}
function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, c => HTML_ESCAPES[c])
}

const XY_KEY_BASE = 1048576
function xyKey(x, y) {
    return Math.abs(y) < XY_KEY_BASE ? x * XY_KEY_BASE + y : `${x},${y}`
}

function buildCartogramAggregation(rawCols) {
    const rowCount = h3RowCount(rawCols)
    const done = perfTimer('cartogram.cells.precompute', {rows: rowCount, h3Index: hasSplitH3Index(rawCols) ? 'split' : 'string'})
    const weights = rawCols.weight_mean || rawCols.weight || null
    const prominenceCol = rawCols.prominence
    const populationCol = rawCols.population
    let weightValues = null
    const cellByKey = new Map()
    const rowCell = new Uint32Array(rowCount)
    const x = []
    const y = []
    const code = []
    const label = []
    const prominence = []
    const index = []
    const anchorIndex = []
    const h3RowsByCell = []
    const codeCounts = []
    const labelStats = []

    const doneGroupXY = detailPerfTimer('cartogram.cells.group_xy', {rows: rowCount})
    for (let i = 0; i < rowCount; i++) {
        const cx = toNumber(rawCols.x[i])
        const cy = toNumber(rawCols.y[i])
        const key = xyKey(cx, cy)
        let cellIndex = cellByKey.get(key)
        if (cellIndex === undefined) {
            cellIndex = x.length
            cellByKey.set(key, cellIndex)
            x.push(cx)
            y.push(cy)
            h3RowsByCell.push([])
            codeCounts.push(new Map())
            labelStats.push(new Map())
        }
        rowCell[i] = cellIndex
        h3RowsByCell[cellIndex].push(i)

        if (rawCols.code && rawCols.code[i] != null) addCount(codeCounts[cellIndex], toNumber(rawCols.code[i]) / 1000)
        if (rawCols.label && (!rawCols.label.isValid || rawCols.label.isValid(i))) {
            const labelValue = columnValue(rawCols.label, i)
            if (labelValue != null && labelValue !== '') {
                let stats = labelStats[cellIndex].get(labelValue)
                if (!stats) labelStats[cellIndex].set(labelValue, stats = {count: 0, prominence: null})
                stats.count++
                let prominenceValue = prominenceCol ? toFiniteNumber(columnValue(prominenceCol, i)) : null
                if (prominenceValue == null && populationCol) prominenceValue = toFiniteNumber(columnValue(populationCol, i))
                if (prominenceValue != null && (stats.prominence == null || prominenceValue > stats.prominence)) stats.prominence = prominenceValue
            }
        }
    }
    doneGroupXY({cells: x.length})

    if (weights) {
        const doneWeightValues = detailPerfTimer('cartogram.weights.values_precompute', {rows: rowCount})
        weightValues = new Float64Array(rowCount)
        let invalidWeights = 0
        for (let i = 0; i < rowCount; i++) {
            const weight = toFiniteNumber(weights[i])
            if (weight == null) {
                weightValues[i] = NaN
                invalidWeights++
            } else {
                weightValues[i] = weight
            }
        }
        doneWeightValues({invalidWeights})
    }

    const doneOutput = detailPerfTimer('cartogram.cells.output', {cells: x.length})
    for (let i = 0; i < x.length; i++) {
        const cellLabel = dominantLabel(labelStats[i])
        code.push(dominant(codeCounts[i]))
        label.push(cellLabel)
        prominence.push(labelStats[i].get(cellLabel)?.prominence ?? null)
        index.push('')
        anchorIndex.push('')
    }
    doneOutput()

    done({cells: x.length, strategy: 'numeric-xy-key'})
    return {
        h3Cols: rawCols,
        weights,
        weightValues,
        rowCell,
        h3RowsByCell,
        cellH3StringCache: [],
        x,
        y,
        code,
        label,
        prominence,
        index,
        anchorIndex,
    }
}

function buildH3ToXY(rawCols) {
    const rowCount = h3RowCount(rawCols)
    const doneIndex = perfTimer('cartogram.h3_to_xy.build', {rows: rowCount, h3Index: hasSplitH3Index(rawCols) ? 'split' : 'string'})
    const split = hasSplitH3Index(rawCols)
    const map = split ? createSplitH3ToXYMap() : new Map()
    if (split) {
        for (let i = 0; i < rowCount; i++) {
            const lower = toNumber(columnValue(rawCols[H3_INDEX_LOWER], i))
            const upper = toNumber(columnValue(rawCols[H3_INDEX_UPPER], i))
            const x = toNumber(rawCols.x[i])
            const y = toNumber(rawCols.y[i])
            addH3MapCell(map, true, lower, upper, null, cartogramAgg?.rowCell?.[i] ?? i, x, y)
        }
    } else {
        const h3Strings = ensureH3StringColumn(rawCols, 'cartogram.h3_strings.from_split')
        for (let i = 0; i < rowCount; i++) {
            const hex = toStringValue(columnValue(h3Strings, i))
            const x = toNumber(rawCols.x[i])
            const y = toNumber(rawCols.y[i])
            addH3MapCell(map, false, null, null, hex, cartogramAgg?.rowCell?.[i] ?? i, x, y)
        }
    }
    h3toXY = map
    doneIndex({uniqueH3: map.size})
    return map
}

async function ensureH3ToXY() {
    if (h3toXY) return h3toXY
    if (!cartogramInit) return null
    if (!cartogramRawCols) await cartogramInit
    if (!cartogramRawCols) return null
    if (!h3toXYPromise) h3toXYPromise = Promise.resolve().then(() => buildH3ToXY(cartogramRawCols))
    return h3toXYPromise
}

function cartogramCellH3Strings(cellIndex) {
    if (!cartogramAgg || !cartogramAgg.h3RowsByCell) return []
    const cached = cartogramAgg.cellH3StringCache[cellIndex]
    if (cached) return cached
    const rows = cartogramAgg.h3RowsByCell[cellIndex] || []
    const strings = new Array(rows.length)
    for (let i = 0; i < rows.length; i++) strings[i] = h3IndexStringAt(cartogramAgg.h3Cols, rows[i])
    cartogramAgg.cellH3StringCache[cellIndex] = strings
    cartogramAgg.index[cellIndex] = strings.join(', ')
    cartogramAgg.anchorIndex[cellIndex] = strings[0] || ''
    return strings
}

function cartogramCellsH3Strings(cellIndexes) {
    const refs = []
    for (const cellIndex of cellIndexes) refs.push(...cartogramCellH3Strings(cellIndex))
    return refs
}

function cartogramCellsAnchorH3Strings(cellIndexes) {
    const refs = []
    for (const cellIndex of cellIndexes) {
        const strings = cartogramCellH3Strings(cellIndex)
        if (strings[0]) refs.push(strings[0])
    }
    return refs
}

function hex(hexes, options = {}) {
    const {fit = false, padding = 200, highlight = true, fitTrim = 0} = options
    if (!hexes || hexes.length === 0) {
        highlightLayer = null
        renderLayers && renderLayers()
        return
    }
    // const indices = hexes.map(h => {
    //     if (typeof h === 'bigint') return h.toString(16)
    //     if (typeof h === 'number') return BigInt(h).toString(16)
    //     return String(h)
    // })
    if (highlight) {
        highlightLayer = new H3HexagonLayer({
            id: 'hex-highlight',
            data: hexes,
            ...h3LayerProps(),
            getHexagon: d => d,
            getFillColor: [255, 0, 0, 255], // it'd be neat to colour by weight but it's a tiny bit tricky
            getLineColor: [0, 0, 0, 255], // doesn't seem to do anything?
            getLineWidth: 10,
            coverage: 0.6,
            extruded: false,
            pickable: false,
        })
        renderLayers && renderLayers()
    }
    if (fit) {
        const centerBefore = map.getCenter()
        const zoomBefore = map.getZoom()
        const computedBounds = computeH3Bounds(hexes, {referenceLng: centerBefore.lng, trim: fitTrim})
        if (computedBounds) {
            const {bounds, meta} = computedBounds
            const camera = typeof map.cameraForBounds === 'function' ? map.cameraForBounds(bounds, {padding}) : null
            syncLog('cartogram->map.fit.request', {
                ...meta,
                bounds,
                padding,
                centerBefore: {lng: centerBefore.lng, lat: centerBefore.lat},
                zoomBefore,
                camera: camera ? {center: camera.center, zoom: camera.zoom} : null,
            })
            const flyToken = ++hexFlyToken
            hex_flying = true
            map.stop()
            map.fitBounds(bounds, {padding})
            map.once('moveend', () => {
                const centerAfter = map.getCenter()
                syncLog('cartogram->map.fit.moveend', {
                    flyToken,
                    currentFlyToken: hexFlyToken,
                    accepted: flyToken === hexFlyToken,
                    centerAfter: {lng: centerAfter.lng, lat: centerAfter.lat},
                    zoomAfter: map.getZoom(),
                })
                if (flyToken === hexFlyToken) hex_flying = false
            })
        } else {
            syncLog('cartogram->map.fit.skip_no_bounds', {inputH3: hexes.length})
        }
    }
}

function findClosestHex(targetLat, targetLng, h3map = h3toXY) {
    let best = null
    let bestDist = Infinity
    for (const [hex, pt] of h3map) {
        if (pt.lat == null || pt.lng == null) {
            const [lat, lng] = cellToLatLng(hex)
            pt.lat = lat
            pt.lng = lng
        }
        const d = (pt.lat - targetLat) ** 2 + (pt.lng - targetLng) ** 2
        if (d < bestDist) {
            bestDist = d
            best = pt
        }
    }
    return best
}

function getH3Bounds(entry) {
    if (entry && entry.xMin != null) {
        return {xMin: entry.xMin, xMax: entry.xMax, yMin: entry.yMin, yMax: entry.yMax}
    }
    let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity
    for (const [x, y] of entry.cells) {
        if (x < xMin) xMin = x
        if (x > xMax) xMax = x
        if (y < yMin) yMin = y
        if (y > yMax) yMax = y
    }
    return {xMin, xMax, yMin, yMax}
}

function cartoH3sForDataH3(h3Index) {
    const h3 = Array.isArray(h3Index) ? splitLongToH3Index(h3Index[0], h3Index[1]) : String(h3Index)
    const res = getResolution(h3Index)
    if (res === cartoRes) return [h3]
    return res > cartoRes ? [cellToParent(h3, cartoRes)] : cellToChildren(h3, cartoRes)
}

const PARQUET_WASM_URL = './parquet_wasm_bg.wasm'

const FORMATS = {
    csv:     {loader: CSVLoader,      kind: 'row',    layer: 'hex'},
    arrow:   {loader: ArrowLoader,    kind: 'column', layer: 'hex'},
    parquet: {loader: ParquetWasmLoader, kind: 'column', layer: 'hex', loadOptions: {shape: 'columnar-table', parquet: {wasmUrl: PARQUET_WASM_URL}}},
    geojson: {kind: 'row',            layer: 'geojson'},
}

const dataParam = params.get('data') || 'h3_data'
const dotIdx = dataParam.lastIndexOf('.')
const ext = dotIdx >= 0 ? dataParam.slice(dotIdx + 1).toLowerCase() : 'csv'
const format = FORMATS[ext] || FORMATS.csv
if (!FORMATS[ext] && dotIdx >= 0) console.warn(`Unknown extension ".${ext}", falling back to csv`)
const file_name = dotIdx >= 0 ? dataParam : `${dataParam}.csv`
const base_name = dotIdx >= 0 ? dataParam.slice(0, dotIdx) : dataParam
const meta_name = `${base_name}.json`

async function reportDevicePerf(requestedRenderer, renderer, adapter) {
    const gpu = navigator.gpu
    const webgpu = {apiAvailable: Boolean(gpu), adapterAvailable: false}
    if (gpu) {
        try {
            adapter ||= await gpu.requestAdapter()
            webgpu.adapterAvailable = Boolean(adapter)
            if (adapter) {
                let info = adapter.info
                if (!info && adapter.requestAdapterInfo) {
                    try { info = await adapter.requestAdapterInfo() } catch (_) {}
                }
                if (info) {
                    webgpu.adapterInfo = {vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description}
                }
                const isFallbackAdapter = info?.isFallbackAdapter ?? adapter.isFallbackAdapter
                if (typeof isFallbackAdapter === 'boolean') webgpu.isFallbackAdapter = isFallbackAdapter
            }
        } catch (error) {
            webgpu.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
        }
    }

    sendPerfTelemetry('device', {
        file: file_name,
        requestedRenderer,
        renderer,
        userAgent: navigator.userAgent,
        platform: navigator.userAgentData?.platform || navigator.platform,
        hardwareConcurrency: navigator.hardwareConcurrency,
        deviceMemoryGb: navigator.deviceMemory,
        screen: {width: screen.width, height: screen.height, colorDepth: screen.colorDepth, pixelRatio: window.devicePixelRatio},
        webgpu,
    })
}

function cartogramFile(value) {
    if (value == null || value === '') return 'cartogram_weights.arrow'
    const file = String(value).trim()
    const lower = file.toLowerCase()
    if (lower === 'none') return null
    if (!file || ['auto', 'default', '1', 'true', 'on', 'yes'].includes(lower)) return 'cartogram_weights.arrow'
    return file.split('/').pop().includes('.') ? file : `${file}.arrow`
}

function cartogramFileForData(value, preferHilo = false) {
    const file = cartogramFile(value)
    if (!file || !preferHilo || /_hilo\.[^/.]+$/.test(file)) return file
    return file.replace(/(\.[^/.]+)$/, '_hilo$1')
}

function loadCartogramWeights(cartogramWeightsFile) {
    return (async () => {
        const doneInit = perfTimer('cartogram.init.total')
        setLoadStage('Loading cartogram weights')
        const arrow_resp = await measurePerf('cartogram.weights.fetch', {file: cartogramWeightsFile}, () => fetch(`data/${cartogramWeightsFile}`))
        if (!arrow_resp.ok) throw new Error(`Failed to load ${cartogramWeightsFile}: HTTP ${arrow_resp.status}`)
        const arrow_buf = await measurePerf('cartogram.weights.arrayBuffer', () => arrow_resp.arrayBuffer())
        setLoadStage('Parsing cartogram weights')
        const rawTable = await parseArrowTable(arrow_buf, 'cartogram.weights.arrow_parse', {bytes: arrow_buf.byteLength})
        const rawCols = {
            x: await materializeArrowColumn(rawTable, 'x', 'cartogram.weights.column'),
            y: await materializeArrowColumn(rawTable, 'y', 'cartogram.weights.column'),
            code: await materializeArrowColumn(rawTable, 'code', 'cartogram.weights.column'),
            label: rawTable.getChild('label'),
            prominence: rawTable.getChild('prominence'),
            population: rawTable.getChild('population'),
            index: rawTable.getChild('index'),
            index_lower: await materializeArrowColumn(rawTable, H3_INDEX_LOWER, 'cartogram.weights.column'),
            index_upper: await materializeArrowColumn(rawTable, H3_INDEX_UPPER, 'cartogram.weights.column'),
            weight: await materializeArrowColumn(rawTable, 'weight', 'cartogram.weights.column'),
            weight_mean: await materializeArrowColumn(rawTable, 'weight_mean', 'cartogram.weights.column'),
        }
        cartoRes = getResolution(h3IndexInputAt(rawCols, 0))
        cartogramRawCols = rawCols
        await yieldToPaint('Preparing cartogram cells')
        cartogramAgg = buildCartogramAggregation(rawCols)
        setLoadStage('Cartogram weights ready')
        doneInit({rows: h3RowCount(rawCols), cells: cartogramAgg.x.length, cartoRes, file: cartogramWeightsFile, h3Index: hasSplitH3Index(rawCols) ? 'split' : 'string'})

        return {}
        // next steps:
        // 0) debug why on earth labels are showing up in multiple places even though they are unique in mapping.arrow. ditto for country borders?
        // 1) draw the cartogram in a new pane with borders
        // 3) link cartogram <-> map
        // (e.g. click on cartogram -> draw h3 that contribute to that cell * weight;
        // zoom/move cartogram -> zoom/move map based on bbox of cartogram ... might be worth pre-computing lat/lon?)
        // 2) aggregate actual data into the cartogram. your current spec is index: string, which is incompatible with the cartogram spec of h3: uint64. so fix that first. then join and profit
        // high-resolution H3 data is rolled up into cartogram-resolution parents before aggregation.
        // 4) reduce duplication of effort: reuse quantiles and data.
        // 5) investigate aggregation of non-h3 5 data. sum/mean/median? exercise for reader
        // 7) try to work out why legend has flipped between the two
        // 8) add tooltip to cartogram cells
        // done ^
        //
        // 6) change opacity of cells with bad 'wp' (london etc seems totally wrong useless)
        // 9) make legend respect flip, etc.
        // 10) make tooltip look up quantiles in legend so they're pretty printed?
        // 11) investigate random extra stuff in the legend. stop dividing code by 1000?
        // 12) reinstate 'wp' from cartogram.arrow
    })()
}

const STYLE = "./toner_ofm_moderatlist.json"
//const STYLE = {version: 8, sources: {
//    basemap: {type: 'geojson', data: 'ne_basemap/basemap.geojson'}
//}, layers: [
//    {id: 'background', type: 'background', paint: {'background-color': '#e8f4f8'}},
//    //{id: 'basemap-fill', type: 'fill', source: 'basemap', paint: {'fill-color': '#f5f5f5'}},
//    {id: 'basemap-outline', type: 'line', source: 'basemap', paint: {'line-color': '#000', 'line-width': 2}},
//], glyphs: 'https://fonts.openmaptiles.org/{fontstack}/{range}.pbf'}

const start_pos = {...{x: 0.45, y: 51.47, z: 4}, ...Object.fromEntries(new URLSearchParams(window.location.hash.slice(1)))}
const map = new maplibregl.Map({
    container: 'map',
    style: STYLE,
    center: [start_pos.x, start_pos.y],
    zoom: start_pos.z,
    bearing: 0,
    pitch: 0
})

window.m = map

const leftExpand = document.getElementById('leftExpand')
const rightExpand = document.getElementById('rightExpand')
const mql = window.matchMedia('(orientation: portrait)')
const isPortrait = () => mql.matches
const setPane = (open) => {
    document.body.classList.toggle('pane-open', open)
    if (!open) document.body.classList.remove('pane-full')
    leftExpand.textContent = isPortrait() ? (open ? '˄' : '˅') : (open ? '‹' : '›')
    leftExpand.setAttribute('aria-label', open ? 'Close side pane' : 'Open side pane')
    requestAnimationFrame(() => map.resize())
}
const setFull = (full) => {
    document.body.classList.toggle('pane-full', full)
    if (full) document.body.classList.add('pane-open')
    rightExpand.textContent = isPortrait() ? (full ? '˄' : '˅') : (full ? '‹' : '›')
    rightExpand.setAttribute('aria-label', full ? 'Collapse side pane' : 'Expand side pane to full')
    requestAnimationFrame(() => map.resize())
}
setPane(true)
rightExpand.textContent = isPortrait() ? '˅' : '›'
rightExpand.setAttribute('aria-label', 'Expand side pane to full')
leftExpand.addEventListener('click', () => setPane(!document.body.classList.contains('pane-open')))
rightExpand.addEventListener('click', () => setFull(!document.body.classList.contains('pane-full')))
mql.addEventListener('change', () => setPane(document.body.classList.contains('pane-open')))

const helpBtn = document.getElementById('helpBtn')
const helpPopup = document.getElementById('helpPopup')
const helpClose = document.getElementById('helpClose')
helpBtn.addEventListener('click', () => {
    helpPopup.classList.toggle('open')
})
helpClose.addEventListener('click', () => helpPopup.classList.remove('open'))
document.addEventListener('click', (e) => {
    if (!helpPopup.classList.contains('open')) return
    if (helpPopup.contains(e.target) || helpBtn.contains(e.target)) return
    helpPopup.classList.remove('open')
})
window.addEventListener('resize', () => map.resize())
window.addEventListener('orientationchange', () => map.resize())

const mapContainer = map.getContainer()
let keyboardTarget = 'map'
let mapGestureStarted = false
let mapGestureMoved = false
let mapWheelResetTimer = null
let mapProgrammaticSyncReason = null
let mapMovePerf = null

function eventStartedInMap(event) {
    const target = event && event.target
    return !!target && mapContainer.contains(target)
}

function markMapGestureStart(event) {
    if (!eventStartedInMap(event)) return
    if (!mapGestureStarted) mapGestureMoved = false
    mapGestureStarted = true
}

function clearInactiveMapGesture() {
    if (!mapGestureMoved) mapGestureStarted = false
}

function syncCartogramAfterNextMapMove(reason) {
    if (!cartogramEnabled) return
    hexFlyToken++
    map.stop()
    hex_flying = false
    mapProgrammaticSyncReason = reason
}

mapContainer.addEventListener('pointerdown', markMapGestureStart, {capture: true, passive: true})
mapContainer.addEventListener('wheel', (event) => {
    markMapGestureStart(event)
    clearTimeout(mapWheelResetTimer)
    mapWheelResetTimer = setTimeout(clearInactiveMapGesture, 250)
}, {capture: true, passive: true})
window.addEventListener('pointerup', clearInactiveMapGesture, {capture: true, passive: true})
window.addEventListener('pointercancel', clearInactiveMapGesture, {capture: true, passive: true})

map.on('movestart', (event) => {
    updateVisibleH3Chunks?.()
    const original = event && event.originalEvent
    if (mapGestureStarted || eventStartedInMap(original)) {
        mapGestureMoved = true
        keyboardTarget = 'map'
    }
    if (svgPerfEnabled) {
        const center = map.getCenter()
        mapMovePerf = {
            startedAt: now(),
            lastLogAt: now(),
            moves: 0,
            originalEventType: original ? original.type : null,
            originalInMap: eventStartedInMap(original),
            gestureStarted: mapGestureStarted,
            startCenter: {lng: center.lng, lat: center.lat},
            startZoom: map.getZoom(),
        }
        svgPerfLog('map.movestart', mapMovePerf)
    }
})

map.on('move', (event) => {
    updateVisibleH3Chunks?.()
    if (!svgPerfEnabled || !mapMovePerf) return
    mapMovePerf.moves++
    const t = now()
    if (t - mapMovePerf.lastLogAt < 250) return
    mapMovePerf.lastLogAt = t
    const center = map.getCenter()
    const original = event && event.originalEvent
    svgPerfLog('map.move', {
        elapsedMs: t - mapMovePerf.startedAt,
        moves: mapMovePerf.moves,
        originalEventType: original ? original.type : null,
        mapGestureStarted,
        mapGestureMoved,
        cartogramEnabled,
        hasCartogramApi: !!cartogramApi,
        center: {lng: center.lng, lat: center.lat},
        zoom: map.getZoom(),
    })
})

const KEYBOARD_PAN_SPEED = 400
const KEYBOARD_ZOOM_SPEED = 1
const KEYBOARD_KEYS = new Set(['arrowup', 'w', 'arrowdown', 's', 'arrowleft', 'a', 'arrowright', 'd', 'q', 'e'])
const heldKeyboardKeys = new Set()
let keyboardFrame = null
let keyboardFrameTime = 0
let keyboardMoveTarget = null
let keyboardMoved = false

function finishKeyboardMove() {
    if (keyboardFrame !== null) cancelAnimationFrame(keyboardFrame)
    keyboardFrame = null
    const target = keyboardMoveTarget
    keyboardMoveTarget = null
    const moved = keyboardMoved
    keyboardMoved = false
    if (!target || !moved) return

    if (target === 'cartogram') {
        cartogramApi?.finishMove()
    } else {
        syncCartogramAfterNextMapMove('keyboard')
        map.fire('moveend')
    }
}

function moveWithKeyboard(timestamp) {
    const elapsed = Math.min((timestamp - keyboardFrameTime) / 1000, 0.25)
    keyboardFrameTime = timestamp
    const panX = (heldKeyboardKeys.has('arrowright') || heldKeyboardKeys.has('d') ? 1 : 0) -
        (heldKeyboardKeys.has('arrowleft') || heldKeyboardKeys.has('a') ? 1 : 0)
    const panY = (heldKeyboardKeys.has('arrowdown') || heldKeyboardKeys.has('s') ? 1 : 0) -
        (heldKeyboardKeys.has('arrowup') || heldKeyboardKeys.has('w') ? 1 : 0)
    const zoom = (heldKeyboardKeys.has('e') ? 1 : 0) - (heldKeyboardKeys.has('q') ? 1 : 0)
    const panScale = panX && panY ? Math.SQRT1_2 : 1
    const pan = [panX * KEYBOARD_PAN_SPEED * elapsed * panScale, panY * KEYBOARD_PAN_SPEED * elapsed * panScale]

    if (panX || panY || zoom) {
        keyboardMoved = true
        if (keyboardMoveTarget === 'cartogram' && cartogramApi) {
            cartogramApi.moveBy(pan, 2 ** (zoom * KEYBOARD_ZOOM_SPEED * elapsed))
        } else {
            const center = map.project(map.getCenter())
            map.jumpTo({
                center: map.unproject([center.x + pan[0], center.y + pan[1]]),
                zoom: map.getZoom() + zoom * KEYBOARD_ZOOM_SPEED * elapsed,
            }, {keyboardMoving: true})
        }
    }
    keyboardFrame = requestAnimationFrame(moveWithKeyboard)
}

document.addEventListener('keydown', event => {
    const target = event.target
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || helpPopup.classList.contains('open') ||
        target instanceof Element && target.closest('input, textarea, select, button, a, [contenteditable]:not([contenteditable="false"])')) return

    const key = event.key.toLowerCase()
    if (!KEYBOARD_KEYS.has(key)) return

    event.preventDefault()
    event.stopPropagation()
    heldKeyboardKeys.add(key)
    if (keyboardFrame === null) {
        keyboardMoveTarget = keyboardTarget === 'cartogram' && cartogramApi ? 'cartogram' : 'map'
        keyboardTarget = keyboardMoveTarget
        map.stop()
        cartogramApi?.stop()
        keyboardFrameTime = performance.now()
        keyboardFrame = requestAnimationFrame(moveWithKeyboard)
    }
}, true)

document.addEventListener('keyup', event => {
    const key = event.key.toLowerCase()
    if (!heldKeyboardKeys.delete(key)) return
    event.preventDefault()
    event.stopPropagation()
    if (!heldKeyboardKeys.size) finishKeyboardMove()
}, true)

function releaseKeyboard() {
    heldKeyboardKeys.clear()
    finishKeyboardMove()
}
window.addEventListener('blur', releaseKeyboard)
document.addEventListener('visibilitychange', () => document.hidden && releaseKeyboard())

    window.addEventListener("hashchange", () => {
        const pos = Object.fromEntries(new URLSearchParams(window.location.hash.slice(1)))
        const longitude = pos.x ? pos.x : 0.45
        const latitude = pos.y ? pos.y : 51.47
    const zoom = pos.z ? pos.z : 4
    syncCartogramAfterNextMapMove('hashchange')
    map.flyTo({
        center: [longitude, latitude],
        zoom: zoom,
        bearing: 0,
        pitch: 0
    })
})

fetch(`data/${meta_name}`).then(r => r.json()).then(meta => {
    bootstrap(meta)
}).catch(_ => {
    bootstrap()
})

function bootstrap(meta = {}){
    const settings = Object.assign({}, meta, Object.fromEntries(params.entries()))
    const requestedRenderer = rendererSetting(settings.renderer)
    const webgpuGeometryMode = webgpuGeometrySetting(settings.h3gpu)
    cartogramInit = null
    cartogramWeightsFile = null
    cartogramEnabled = cartogramFile(settings.cartogram) !== null
    configureLoadProgress(cartogramEnabled ? LOAD_PROGRESS_DEFAULT_PROFILE : LOAD_PROGRESS_NO_CARTOGRAM_PROFILE)
    if (!cartogramEnabled) {
        cartogramRawCols = null
        cartogramAgg = null
        cartoAggCols = null
        h3toXY = null
        h3toXYPromise = null
        document.body.classList.remove('cartogram-ready')
    }
    const infill = settingEnabled(settings.infill, false)
    const doCyclical = settingEnabled(settings.cyclical, false)
    const flip = settingEnabled(settings.flip, false)
    const showTrains = settingEnabled(settings.trains, false)
    const colourRamp = d3.scaleSequential(doCyclical ? d3.interpolateRainbow : d3.interpolateSpectral).domain(flip ? [1,0] : [0,1])
    const file_path = `data/${file_name}`
    let h3DataRowLookup = null
    const mapHoverTooltip = document.createElement('div')
    mapHoverTooltip.className = 'h3-hover-tooltip'
    mapHoverTooltip.style.display = 'none'
    mapContainer.appendChild(mapHoverTooltip)
    let hoveredMapH3 = null
    let pendingMapHover = null
    let mapHoverRaf = null
    let suppressMapHoverUntil = 0
    const sidePane = document.getElementById('side-pane')
    const cartogramContainer = document.getElementById('cartogram')
    if (settings.t) document.title = settings.t

    function rectDetails(element) {
        if (!element) return null
        const rect = element.getBoundingClientRect()
        return {x: rect.x, y: rect.y, width: rect.width, height: rect.height}
    }

    function cartogramLayoutDetails() {
        return {
            cartogramReady: document.body.classList.contains('cartogram-ready'),
            paneOpen: document.body.classList.contains('pane-open'),
            paneFull: document.body.classList.contains('pane-full'),
            sidePane: rectDetails(sidePane),
            cartogram: rectDetails(cartogramContainer),
            canvas: rectDetails(cartogramContainer?.querySelector('canvas')),
            map: rectDetails(mapContainer),
        }
    }

    async function ensureCartogramPaneLaidOut(reason) {
        const wasReady = document.body.classList.contains('cartogram-ready')
        document.body.classList.add('cartogram-ready')
        svgPerfLog('cartogram.layout.ready', {reason, wasReady, beforePaint: cartogramLayoutDetails()})
        await nextPaint()
        map.resize()
        await nextPaint()
        svgPerfLog('cartogram.layout.ready_after_paint', {reason, wasReady, afterPaint: cartogramLayoutDetails()})
    }

    const transparentColour = [0, 0, 0, 0]
    const transparentCss = 'rgba(0,0,0,0)'
    const parsedColourCache = new Map()
    function parseColour(css) {
        let cached = parsedColourCache.get(css)
        if (cached) return cached
        const colour = d3.color(css)
        cached = colour ? [colour.r, colour.g, colour.b, Math.round((colour.opacity ?? 1) * 255)] : transparentColour
        parsedColourCache.set(css, cached)
        return cached
    }
    const colourPaletteCss = new Array(COLOUR_PALETTE_SIZE)
    const colourPaletteRgba = new Uint8Array(COLOUR_PALETTE_SIZE * 4)
    const colourTransition = {duration: COLOUR_TRANSITION_DURATION, easing: d3.easeCubicInOut}
    const packedH3FillTransition = COLOUR_TRANSITION_DURATION
        ? new PackedH3FillTransition(colourTransition)
        : null
    let colourVersion = 0
    let activeH3Layer = null
    let activeWebgpuChunkSet = null
    let viewportQuantileState = null
    let activeH3Renderer = 'deck'
    let stopFrameRateTelemetry = null
    let webgpuRenderer = null
    let webgpuMatrixLayer = null
    let webgpuRendererInit = null
    let webgpuRendererGeneration = 0
    let webgpuFallback = null
    let webgpuFailure = null
    let nextH3ChunkSetId = 1
    const h3DeckDataCache = new WeakMap()
    const ownedWebgpuLayers = new WeakSet()
    const removingWebgpuLayers = new WeakSet()
    const webgpuMatrixLayerId = 'webgpu-packed-h3-matrix'
    function startFrameRateTelemetry() {
        let frames = 0
        let startedAt = now()
        const countFrame = () => frames++
        map.on('render', countFrame)
        const interval = setInterval(() => {
            const endedAt = now()
            const durationMs = endedAt - startedAt
            sendPerfTelemetry('framerate', {
                file: file_name,
                requestedRenderer,
                renderer: activeH3Renderer,
                source: 'maplibre.render',
                durationMs: Number(durationMs.toFixed(1)),
                frames,
                fps: Number((frames * 1000 / durationMs).toFixed(1)),
                visibilityState: document.visibilityState,
            })
            frames = 0
            startedAt = endedAt
        }, 5000)
        return () => {
            map.off('render', countFrame)
            clearInterval(interval)
        }
    }
    for (let i = 0; i < COLOUR_PALETTE_SIZE; i++) {
        const css = colourRamp(i / (COLOUR_PALETTE_SIZE - 1)) ?? transparentCss
        const rgba = parseColour(css)
        colourPaletteCss[i] = css
        const offset = i * 4
        colourPaletteRgba[offset] = rgba[0]
        colourPaletteRgba[offset + 1] = rgba[1]
        colourPaletteRgba[offset + 2] = rgba[2]
        colourPaletteRgba[offset + 3] = rgba[3]
    }
    function colourPaletteIndex(number) {
        return number >= 0 && number <= 1 ? Math.round(number * (COLOUR_PALETTE_SIZE - 1)) : -1
    }
    const getCssColour = v => {
        const number = toFiniteNumber(v)
        if (number == null) return transparentCss
        const paletteIndex = colourPaletteIndex(number)
        return paletteIndex >= 0 ? colourPaletteCss[paletteIndex] : (colourRamp(number) ?? transparentCss)
    }
    const writeColourForValue = (v, target, offset = 0) => {
        const number = toFiniteNumber(v)
        if (number == null) {
            target[offset] = 0
            target[offset + 1] = 0
            target[offset + 2] = 0
            target[offset + 3] = 0
            return target
        }
        const paletteIndex = colourPaletteIndex(number)
        if (paletteIndex >= 0) {
            const paletteOffset = paletteIndex * 4
            target[offset] = colourPaletteRgba[paletteOffset]
            target[offset + 1] = colourPaletteRgba[paletteOffset + 1]
            target[offset + 2] = colourPaletteRgba[paletteOffset + 2]
            target[offset + 3] = colourPaletteRgba[paletteOffset + 3]
            return target
        }
        const colour = parseColour(colourRamp(number) ?? transparentCss)
        target[offset] = colour[0]
        target[offset + 1] = colour[1]
        target[offset + 2] = colour[2]
        target[offset + 3] = colour[3]
        return target
    }
    const getColour = v => writeColourForValue(v, [0, 0, 0, 0])
    function rowH3IndexInput(row, indexkey, target = [0, 0]) {
        if (row && row[H3_INDEX_LOWER] != null && row[H3_INDEX_UPPER] != null) {
            target[0] = toNumber(row[H3_INDEX_LOWER])
            target[1] = toNumber(row[H3_INDEX_UPPER])
            return target
        }
        return toStringValue(row[indexkey])
    }

    function h3IndexAt(data, kind, indexkey, i, target = [0, 0]) {
        if (kind === 'column') return h3IndexInputAt(data, i, target)
        return rowH3IndexInput(data[i], indexkey, target)
    }

    function h3IdWordsForRows(data, kind, rowIndices) {
        const lower = new Uint32Array(rowIndices.length)
        const upper = new Uint32Array(rowIndices.length)
        const target = [0, 0]
        for (let i = 0; i < rowIndices.length; i++) {
            const input = h3IndexAt(data, kind, 'index', rowIndices[i], target)
            const words = typeof input === 'string' ? h3IndexToSplitLong(input) : input
            lower[i] = Number(words[0]) >>> 0
            upper[i] = Number(words[1]) >>> 0
        }
        return {lower, upper}
    }

    function h3DeckSource(kind, data) {
        const rows = kind === 'column' ? h3RowCount(data) : data.length
        let dataWrap = kind === 'column' ? h3DeckDataCache.get(data) : data
        if (!dataWrap || dataWrap.length !== rows) {
            dataWrap = kind === 'column' ? {src: data, length: rows} : data
            if (kind === 'column') h3DeckDataCache.set(data, dataWrap)
        }
        return dataWrap
    }

    function deckHexAccessors(kind, indexkey, valuekey, writeColourValue) {
        if (kind === 'column') {
            return {
                getHexagon: (_, {index, data, target}) => h3IndexInputAt(data.src, index, target),
                getFillColor: (_, {index, data, target}) => {
                    const column = data.src[valuekey]
                    return writeColourValue(column ? columnValue(column, index) : null, target)
                }
            }
        }
        return {
            getHexagon: (d, {target} = {}) => rowH3IndexInput(d, indexkey, target),
            getFillColor: (d, {target} = {}) => writeColourValue(d[valuekey], target || [0, 0, 0, 0])
        }
    }

    function chunkHexAccessors(kind, indexkey, valuekey, writeColourValue) {
        if (kind === 'column') {
            return {
                getHexagon: (_, {index, data, target}) => h3IndexInputAt(data.src, data.rowIndices[index], target),
                getFillColor: (_, {index, data, target}) => {
                    const column = data.src[valuekey]
                    const v = column ? columnValue(column, data.rowIndices[index]) : null
                    return writeColourValue(v, target)
                }
            }
        }
        return {
            getHexagon: (_, {index, data, target}) => rowH3IndexInput(data.src[data.rowIndices[index]], indexkey, target),
            getFillColor: (_, {index, data, target}) => writeColourValue(data.src[data.rowIndices[index]][valuekey], target || [0, 0, 0, 0])
        }
    }

    function createH3Layer(data, kind, valuekey) {
        const accessors = deckHexAccessors(kind, 'index', valuekey, writeColourForValue)
        const layer = new PackedH3HexagonLayer({
            id: 'H3HexagonLayer',
            data: h3DeckSource(kind, data),
            ...accessors,
            extensions: packedH3FillTransition ? [packedH3FillTransition] : [],
            updateTriggers: {getFillColor: [colourVersion]},
            pickable: false,
        })
        activeH3Layer = {layer}
        return layer
    }

    function waitForMapStyle() {
        if (map.getStyle()) return Promise.resolve()
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => finish(new Error('MapLibre style load timed out')), 15000)
            const finish = error => {
                clearTimeout(timer)
                cleanup()
                if (error) reject(error)
                else resolve()
            }
            const onLoad = () => {
                finish()
            }
            const onRemove = () => finish(new Error('MapLibre map was removed before its style loaded'))
            const cleanup = () => {
                map.off('style.load', onLoad)
                map.off('remove', onRemove)
            }
            map.on('style.load', onLoad)
            map.on('remove', onRemove)
        })
    }

    function webgpuChunkColors(chunkSet, chunk) {
        const colors = new Uint8Array(chunk.data.length * 4)
        for (let i = 0; i < chunk.data.length; i++) {
            const rowIndex = chunk.data.rowIndices[i]
            const value = chunkSet.kind === 'column'
                ? columnValue(chunkSet.data[chunkSet.valuekey], rowIndex)
                : chunkSet.data[rowIndex][chunkSet.valuekey]
            writeColourForValue(value, colors, i * 4)
        }
        return colors
    }

    function removeWebgpuMatrixLayer(layer = webgpuMatrixLayer) {
        if (webgpuMatrixLayer === layer) webgpuMatrixLayer = null
        if (!layer || !ownedWebgpuLayers.delete(layer)) return
        removingWebgpuLayers.add(layer)
        try {
            if (map.getLayer(layer.id)) map.removeLayer(layer.id)
        } finally {
            removingWebgpuLayers.delete(layer)
        }
    }

    function destroyWebgpuRenderer(renderer = webgpuRenderer, layer = webgpuMatrixLayer) {
        if (webgpuRenderer === renderer) {
            webgpuRenderer = null
            webgpuRendererInit = null
        }
        try {
            removeWebgpuMatrixLayer(layer)
        } catch (cleanupError) {
            console.warn('Failed to remove WebGPU H3 layer', cleanupError)
        }
        try {
            renderer?.destroy()
        } catch (cleanupError) {
            console.warn('Failed to destroy WebGPU H3 renderer', cleanupError)
        }
    }

    function explicitWebgpuFailure() {
        if (requestedRenderer !== 'webgpu' || activeH3Renderer !== 'failed') return null
        return webgpuFailure || new Error('WebGPU H3 renderer failed')
    }

    async function fallBackToDeck(error, renderer = webgpuRenderer, layer = webgpuMatrixLayer, generation = webgpuRendererGeneration) {
        if (generation !== webgpuRendererGeneration || (webgpuRenderer && renderer && webgpuRenderer !== renderer)) return false
        if (webgpuFallback) return webgpuFallback
        const chunkSet = activeH3Renderer === 'webgpu' ? activeWebgpuChunkSet : null
        webgpuRendererGeneration++
        webgpuFailure = error
        destroyWebgpuRenderer(renderer, layer)
        if (requestedRenderer === 'webgpu') {
            if (chunkSet?.committed) {
                releaseWebgpuChunkSet(chunkSet, null)
                activeWebgpuChunkSet = null
                activeH3Renderer = 'failed'
                mainLayers = []
                await renderLayers?.(false)
            }
            console.error('WebGPU H3 renderer failed', error)
            setLoadProgress(100, 'WebGPU renderer failed')
            return false
        }
        console.warn('WebGPU H3 renderer unavailable; using deck', error)
        activeH3Renderer = 'deck'
        const fallback = (async () => {
            if (chunkSet?.committed && activeWebgpuChunkSet === chunkSet) {
                releaseWebgpuChunkSet(chunkSet, null)
                activeWebgpuChunkSet = null
                const deckLayer = createH3Layer(chunkSet.data, chunkSet.kind, chunkSet.valuekey)
                mainLayers = [deckLayer]
                await renderLayers?.(false, true)
            }
            return true
        })()
        webgpuFallback = fallback
        try {
            return await fallback
        } finally {
            if (webgpuFallback === fallback) webgpuFallback = null
        }
    }

    async function ensureH3Renderer() {
        if (requestedRenderer === 'deck') return 'deck'
        if (webgpuRenderer) return 'webgpu'
        if (webgpuFallback) {
            await webgpuFallback
            return 'deck'
        }
        if (requestedRenderer === 'auto' && webgpuFailure) return 'deck'
        if (!webgpuRendererInit) {
            const generation = ++webgpuRendererGeneration
            let initialization
            initialization = Promise.resolve().then(async () => {
                const done = perfTimer('webgpu.renderer.init')
                let renderer = null
                let layer = null
                try {
                    await waitForMapStyle()
                    if (generation !== webgpuRendererGeneration) throw new Error('WebGPU renderer initialization was superseded')
                    assertMercatorProjection(map)
                    if (map.getLayer(webgpuMatrixLayerId)) throw new Error(`MapLibre layer "${webgpuMatrixLayerId}" already exists`)
                    renderer = await createPackedH3Renderer({
                        mapCanvas: map.getCanvas(),
                        requestRender: () => map.triggerRepaint(),
                        transitionDuration: COLOUR_TRANSITION_DURATION,
                        enableH3Compute: webgpuGeometryMode === 'compute',
                        onError: (rendererError, failedRenderer) => {
                            return fallBackToDeck(rendererError, failedRenderer, layer, generation)
                        },
                        onDeviceLost: (info, failedRenderer) => {
                            const loss = new Error(info?.message || info?.reason || 'WebGPU device lost')
                            return fallBackToDeck(loss, failedRenderer, layer, generation)
                        },
                    })
                    if (!renderer) throw new Error('WebGPU adapter or canvas context unavailable')
                    if (generation !== webgpuRendererGeneration) throw new Error('WebGPU renderer initialization was superseded')
                    if (renderer.state !== 'ready') throw new Error(`WebGPU H3 renderer is ${renderer.state}`)
                    layer = createMapLibreMatrixLayer(renderer, {
                        id: webgpuMatrixLayerId,
                        destroyOnRemove: true,
                        onRenderError: (renderError, failedRenderer) => {
                            return fallBackToDeck(renderError, failedRenderer, layer, generation)
                        },
                        onLayerRemove: failedRenderer => {
                            if (removingWebgpuLayers.has(layer)) return
                            ownedWebgpuLayers.delete(layer)
                            return fallBackToDeck(new Error('MapLibre removed the WebGPU H3 matrix layer'), failedRenderer, layer, generation)
                        },
                    })
                    ownedWebgpuLayers.add(layer)
                    map.addLayer(layer)
                    if (!map.getLayer(layer.id)) throw new Error(`MapLibre failed to add layer "${layer.id}"`)
                    webgpuRenderer = renderer
                    webgpuMatrixLayer = layer
                    webgpuFailure = null
                    done({renderer: 'webgpu'})
                    return 'webgpu'
                } catch (error) {
                    done({renderer: 'deck', failed: true})
                    if (webgpuRendererInit === initialization) webgpuRendererInit = null
                    await fallBackToDeck(error, renderer, layer, generation)
                    if (requestedRenderer === 'webgpu') throw error
                    return 'deck'
                }
            })
            webgpuRendererInit = initialization
        }
        return webgpuRendererInit
    }

    function configuredH3ChunkResolution(dataResolution) {
        const value = settings.h3chunkres
        if (value != null && ['off', 'false', 'none'].includes(String(value).trim().toLowerCase())) return null
        if (value != null && value !== '') {
            const resolution = Number(value)
            if (Number.isInteger(resolution) && resolution >= 0 && resolution < dataResolution) return resolution
            console.warn(`Ignoring invalid h3chunkres=${value}; expected an integer from 0 to ${dataResolution - 1}, or "off"`)
        }
        return dataResolution > 0 ? Math.max(0, dataResolution - 5) : null
    }

    function stringH3Parent(h3Index, resolution) {
        let hex = h3Index.toLowerCase()
        if (hex.length === 16 && hex[0] === '0') hex = hex.slice(1)
        // A parent retains its prefix and sets every unused 3-bit child digit to 7.
        const trailingBits = 3 * (15 - resolution)
        const trailingChars = Math.floor(trailingBits / 4)
        const partialBits = trailingBits % 4
        const boundary = hex.length - trailingChars - (partialBits ? 1 : 0)
        let parent = hex.slice(0, boundary)
        if (partialBits) parent += (parseInt(hex[boundary], 16) | (2 ** partialBits - 1)).toString(16)
        parent += 'f'.repeat(trailingChars)
        return parent[0] + resolution.toString(16) + parent.slice(2)
    }

    function groupH3Rows(data, kind, rows, chunkResolution, resolutions = null) {
        const groups = new Map()
        const splitGroups = new Map()
        const h3Target = [0, 0]
        for (let i = 0; i < rows; i++) {
            const h3Index = h3IndexAt(data, kind, 'index', i, h3Target)
            const sourceResolution = getResolution(h3Index)
            resolutions?.add(sourceResolution)
            let chunkKey = 'all'
            let group = chunkResolution == null ? groups.get(chunkKey) : null
            let splitUpper = null
            let splitLower
            if (chunkResolution != null) {
                if (typeof h3Index === 'string') {
                    const hex = h3Index.length === 16 && h3Index[0] === '0' ? h3Index.slice(1) : h3Index
                    chunkKey = stringH3Parent(hex, Math.min(chunkResolution, sourceResolution))
                    group = groups.get(chunkKey)
                } else {
                    let [lower, upper] = h3Index
                    lower >>>= 0
                    const parentResolution = Math.min(chunkResolution, sourceResolution)
                    // The resolution occupies bits 20-23 of the upper word; unused digits are low bits.
                    upper = ((upper >>> 0) & ~(15 << 20)) | (parentResolution << 20)
                    const trailingBits = 3 * (15 - parentResolution)
                    if (trailingBits >= 32) {
                        lower = 0xffffffff
                        upper |= 2 ** (trailingBits - 32) - 1
                    } else {
                        lower |= 2 ** trailingBits - 1
                    }
                    lower >>>= 0
                    upper >>>= 0
                    splitUpper = upper
                    splitLower = lower
                    group = splitGroups.get(upper)?.get(lower)
                    if (!group) {
                        chunkKey = splitLongToH3Index(lower, upper)
                        group = groups.get(chunkKey)
                    }
                }
            }
            if (!group) {
                group = {key: chunkKey, rows: []}
                groups.set(chunkKey, group)
            }
            if (splitUpper != null) {
                let byLower = splitGroups.get(splitUpper)
                if (!byLower) splitGroups.set(splitUpper, byLower = new Map())
                byLower.set(splitLower, group)
            }
            group.rows.push(i)
        }
        return groups
    }

    function mapBoundsWithPadding(padding = 0) {
        const bounds = map.getBounds()
        if (!bounds) return null
        const rawWest = bounds.getWest()
        let longitudeSpan = bounds.getEast() - rawWest
        while (longitudeSpan < 0) longitudeSpan += 360
        const longitudeCenter = rawWest + longitudeSpan / 2
        longitudeSpan = Math.min(360, longitudeSpan * (1 + padding * 2))

        const rawSouth = bounds.getSouth()
        const rawNorth = bounds.getNorth()
        const latitudeCenter = (rawSouth + rawNorth) / 2
        const latitudeSpan = Math.min(180, (rawNorth - rawSouth) * (1 + padding * 2))
        return {
            west: longitudeCenter - longitudeSpan / 2,
            east: longitudeCenter + longitudeSpan / 2,
            south: Math.max(-90, latitudeCenter - latitudeSpan / 2),
            north: Math.min(90, latitudeCenter + latitudeSpan / 2),
            longitudeSpan,
        }
    }

    function chunkIntersectsBounds(chunk, bounds) {
        if (!bounds || chunk.bounds.north < bounds.south || chunk.bounds.south > bounds.north) return false
        if (bounds.longitudeSpan >= 360 || chunk.bounds.longitudeSpan >= 360) return true
        const viewportCenter = (bounds.west + bounds.east) / 2
        const chunkCenter = (chunk.bounds.west + chunk.bounds.east) / 2
        const shift = Math.round((viewportCenter - chunkCenter) / 360) * 360
        return chunk.bounds.west + shift <= bounds.east && chunk.bounds.east + shift >= bounds.west
    }

    function packedChunkBounds(geometry, chunkKey) {
        if (chunkKey === 'all') return {west: -180, east: 180, south: -90, north: 90, longitudeSpan: 360}
        const [, referenceLongitude] = cellToLatLng(chunkKey)
        let west = Infinity, east = -Infinity, south = Infinity, north = -Infinity
        for (let i = 0; i < geometry.positions.length; i += 2) {
            const rawLongitude = geometry.positions[i]
            const longitude = referenceLongitude + ((rawLongitude - referenceLongitude + 540) % 360) - 180
            const latitude = geometry.positions[i + 1]
            if (longitude < west) west = longitude
            if (longitude > east) east = longitude
            if (latitude < south) south = latitude
            if (latitude > north) north = latitude
        }
        return {west, east, south, north, longitudeSpan: east - west}
    }

    function h3ChunkBounds(chunkKey) {
        if (chunkKey === 'all') return {west: -180, east: 180, south: -90, north: 90, longitudeSpan: 360}
        const [, referenceLongitude] = cellToLatLng(chunkKey)
        let west = Infinity, east = -Infinity, south = Infinity, north = -Infinity
        for (const [rawLongitude, latitude] of cellToBoundary(chunkKey, true)) {
            const longitude = referenceLongitude + ((rawLongitude - referenceLongitude + 540) % 360) - 180
            if (longitude < west) west = longitude
            if (longitude > east) east = longitude
            if (latitude < south) south = latitude
            if (latitude > north) north = latitude
        }
        const longitudePadding = (east - west) / 2
        const latitudePadding = (north - south) / 2
        west -= longitudePadding
        east += longitudePadding
        south -= latitudePadding
        north += latitudePadding
        if (south <= -90 || north >= 90) {
            return {west: -180, east: 180, south: Math.max(-90, south), north: Math.min(90, north), longitudeSpan: 360}
        }
        return {west, east, south, north, longitudeSpan: east - west}
    }

    function ensurePackedChunkGeometry(chunkSet, chunk) {
        if (chunk.geometry) return chunk.geometry
        chunk.geometry = packH3Geometry(chunk.data, {getHexagon: chunkSet.accessors.getHexagon})
        return chunk.geometry
    }

    function ensureH3ChunkIds(chunkSet, chunk) {
        chunk.ids ||= h3IdWordsForRows(chunkSet.data, chunkSet.kind, chunk.data.rowIndices)
        return chunk.ids
    }

    function ensureH3ChunkOrigin(chunk) {
        if (!chunk.origin) {
            if (chunk.key === 'all') {
                chunk.origin = [0.5, 0.5]
            } else {
                const [lat, lng] = cellToLatLng(chunk.key)
                const origin = maplibregl.MercatorCoordinate.fromLngLat({lat, lng})
                chunk.origin = [origin.x, origin.y]
            }
        }
        return chunk.origin
    }

    async function uploadWebgpuChunks(renderer, chunkSet, chunks, uploaded) {
        const uploadedColourVersion = colourVersion
        for (const chunk of chunks) {
            const colors = webgpuChunkColors(chunkSet, chunk)
            if (webgpuGeometryMode === 'compute') {
                renderer.addH3Chunk(
                    chunk.rendererId,
                    ensureH3ChunkIds(chunkSet, chunk),
                    colors,
                    {origin: ensureH3ChunkOrigin(chunk), visible: false},
                )
            } else {
                renderer.addChunk(chunk.rendererId, ensurePackedChunkGeometry(chunkSet, chunk), colors, {visible: false})
            }
            chunk.resident = true
            uploaded.push(chunk)
        }
        await renderer.waitForChunks(chunks.map(chunk => chunk.rendererId))
        if (renderer !== webgpuRenderer) throw webgpuFailure || new Error('WebGPU H3 renderer changed during chunk upload')
        if (uploadedColourVersion !== colourVersion) {
            for (const chunk of chunks) {
                renderer.updateColors(chunk.rendererId, webgpuChunkColors(chunkSet, chunk), {duration: 0})
            }
        }
    }

    function removeWebgpuChunks(renderer, chunks, deactivate = false) {
        for (const chunk of chunks) {
            if (chunk.resident) renderer?.removeChunk(chunk.rendererId)
            chunk.resident = false
            if (deactivate) chunk.active = false
        }
    }

    async function selectWebgpuChunks(chunkSet, retainCurrent = true) {
        const renderer = webgpuRenderer
        if (!renderer) throw new Error('WebGPU H3 renderer is unavailable')
        const releaseVersion = chunkSet.releaseVersion
        if (webgpuGeometryMode === 'compute' && map.getZoom() > H3_DIRECT_MAX_ZOOM) {
            const error = new Error(`Direct WebGPU H3 rendering is limited to zoom ${H3_DIRECT_MAX_ZOOM} pending high-precision output`)
            error.name = 'DirectH3PrecisionError'
            throw error
        }
        const startedAt = now()
        const loadBounds = mapBoundsWithPadding(H3_CHUNK_LOAD_PADDING)
        const retainBounds = retainCurrent ? mapBoundsWithPadding(H3_CHUNK_RETAIN_PADDING) : null
        let selected = []
        const retained = new Set()
        for (const chunk of chunkSet.chunks) {
            if (chunkIntersectsBounds(chunk, loadBounds)) {
                selected.push(chunk)
            } else if (retainBounds && chunk.active && chunkIntersectsBounds(chunk, retainBounds)) {
                selected.push(chunk)
                retained.add(chunk)
            }
        }
        if (webgpuGeometryMode === 'compute' && retained.size &&
            renderer.directCellCount + selected.filter(chunk => !chunk.resident).reduce((sum, chunk) => sum + chunk.data.length, 0) > renderer.maxDirectCells) {
            selected = selected.filter(chunk => !retained.has(chunk))
        }
        if (selected.length === chunkSet.activeChunks.length && selected.every((chunk, i) => chunk === chunkSet.activeChunks[i])) return false

        const nextChunks = new Set(selected)
        const previousActiveChunks = chunkSet.activeChunks
        const removed = previousActiveChunks.filter(chunk => !nextChunks.has(chunk))
        const added = selected.filter(chunk => !chunk.resident)
        const uploaded = []
        const evictBeforeUpload = webgpuGeometryMode === 'compute' && removed.length &&
            renderer.directCellCount + added.reduce((sum, chunk) => sum + chunk.data.length, 0) > renderer.maxDirectCells
        if (evictBeforeUpload) {
            removeWebgpuChunks(renderer, removed, true)
            chunkSet.activeChunks = previousActiveChunks.filter(chunk => nextChunks.has(chunk))
        }
        try {
            await uploadWebgpuChunks(renderer, chunkSet, added, uploaded)
        } catch (error) {
            removeWebgpuChunks(renderer, uploaded)
            if (releaseVersion !== chunkSet.releaseVersion) return false
            if (evictBeforeUpload) {
                const restored = []
                try {
                    await uploadWebgpuChunks(renderer, chunkSet, removed, restored)
                    renderer.setChunksVisible(removed.map(chunk => chunk.rendererId))
                    for (const chunk of removed) chunk.active = true
                    chunkSet.activeChunks = previousActiveChunks
                } catch (_) {
                    removeWebgpuChunks(renderer, restored)
                }
            }
            throw error
        }
        if (releaseVersion !== chunkSet.releaseVersion) {
            removeWebgpuChunks(renderer, uploaded)
            return false
        }
        renderer.setChunksVisible(added.map(chunk => chunk.rendererId))
        removeWebgpuChunks(renderer, removed, true)
        for (const chunk of added) chunk.active = true
        chunkSet.activeChunks = selected
        logPerf('webgpu.h3_chunks.select', now() - startedAt, {
            chunks: selected.length,
            rows: selected.reduce((sum, chunk) => sum + chunk.data.length, 0),
            totalChunks: chunkSet.chunks.length,
        })
        if (chunkSet.committed) await renderLayers(false)
        return true
    }

    function releaseWebgpuChunkSet(chunkSet, renderer = webgpuRenderer) {
        if (!chunkSet) return
        chunkSet.releaseVersion++
        removeWebgpuChunks(renderer, chunkSet.chunks, true)
        chunkSet.activeChunks = []
        chunkSet.committed = false
    }

    let chunkSelectionFrame = null
    let chunkSelectionPromise = Promise.resolve()
    let chunkSelectionPending = false
    let webgpuCommitRunning = false
    function selectActiveWebgpuChunks() {
        if (webgpuCommitRunning) {
            chunkSelectionPending = true
            return
        }
        chunkSelectionPending = false
        const chunkSet = activeWebgpuChunkSet
        chunkSelectionPromise = chunkSelectionPromise.then(async () => {
            if (chunkSet && activeWebgpuChunkSet === chunkSet && activeH3Renderer === 'webgpu') {
                const renderer = webgpuRenderer
                const layer = webgpuMatrixLayer
                const generation = webgpuRendererGeneration
                try {
                    await selectWebgpuChunks(chunkSet)
                } catch (error) {
                    await fallBackToDeck(error, renderer, layer, generation)
                }
            }
        }).catch(error => {
            console.error('WebGPU H3 chunk selection failed', error)
        })
    }

    updateVisibleH3Chunks = immediate => {
        if (immediate) {
            if (chunkSelectionFrame !== null) cancelAnimationFrame(chunkSelectionFrame)
            chunkSelectionFrame = null
            selectActiveWebgpuChunks()
            return
        }
        if (chunkSelectionFrame !== null) return
        chunkSelectionFrame = requestAnimationFrame(() => {
            chunkSelectionFrame = null
            selectActiveWebgpuChunks()
        })
    }

    function createWebgpuChunkSet(data, kind, valuekey) {
        const chunkSetId = nextH3ChunkSetId++
        const rows = kind === 'column' ? h3RowCount(data) : data.length
        const accessors = chunkHexAccessors(kind, 'index', valuekey, writeColourForValue)
        const dataResolution = rows ? getResolution(h3IndexAt(data, kind, 'index', 0)) : null
        const resolutions = new Set()
        let chunkResolution = dataResolution == null ? null : configuredH3ChunkResolution(dataResolution)
        if (dataResolution != null) dataH3Res = dataResolution

        const doneGroup = detailPerfTimer('deck.h3_chunks.group', {rows, dataResolution, chunkResolution})
        let groups = groupH3Rows(data, kind, rows, chunkResolution, resolutions)
        if (settings.h3chunkres == null || settings.h3chunkres === '') {
            while (groups.size > H3_CHUNK_MAX_COUNT && chunkResolution > 0) {
                chunkResolution--
                groups = groupH3Rows(data, kind, rows, chunkResolution)
            }
        }
        if (groups.size > H3_CHUNK_MAX_COUNT) console.warn(`H3 chunking created ${groups.size} chunks; consider a lower h3chunkres`)
        doneGroup({chunks: groups.size, chunkResolution})

        const donePrepare = detailPerfTimer('webgpu.h3_chunks.prepare', {rows, chunks: groups.size, chunkResolution, geometry: webgpuGeometryMode})
        const chunks = []
        let vertices = 0
        let triangles = 0
        for (const group of groups.values()) {
            const rowIndices = Uint32Array.from(group.rows)
            group.rows = null
            const chunkData = {src: data, rowIndices, length: rowIndices.length}
            const geometry = webgpuGeometryMode === 'packed'
                ? packH3Geometry(chunkData, {getHexagon: accessors.getHexagon})
                : null
            if (geometry) {
                vertices += geometry.vertexCount
                triangles += geometry.triangleCount
            }
            chunks.push({
                key: group.key,
                rendererId: `${chunkSetId}:${group.key}`,
                data: chunkData,
                ids: null,
                origin: null,
                geometry,
                bounds: geometry ? packedChunkBounds(geometry, group.key) : h3ChunkBounds(group.key),
                active: false,
                resident: false,
            })
        }
        chunks.sort((a, b) => a.key.localeCompare(b.key))
        donePrepare({vertices, triangles})

        const chunkSet = {
            isWebgpuH3: true,
            data,
            rowCount: rows,
            dataResolution,
            resolutions: [...resolutions].sort((a, b) => a - b),
            kind,
            valuekey,
            accessors,
            chunks,
            activeChunks: [],
            committed: false,
            releaseVersion: 0,
        }
        return chunkSet
    }

    async function createMainH3Renderable(data, kind, valuekey) {
        if (requestedRenderer === 'deck') return createH3Layer(data, kind, valuekey)
        if (webgpuGeometryMode === 'packed') {
            const renderer = await ensureH3Renderer()
            return renderer === 'webgpu'
                ? createWebgpuChunkSet(data, kind, valuekey)
                : createH3Layer(data, kind, valuekey)
        }
        const chunkSet = createWebgpuChunkSet(data, kind, valuekey)
        const unsupported = chunkSet.resolutions.filter(resolution => resolution > H3_DIRECT_MAX_RESOLUTION)
        if (unsupported.length) {
            const error = new Error(
                `Direct WebGPU H3 rendering supports resolutions 0-${H3_DIRECT_MAX_RESOLUTION}; ` +
                `received ${unsupported.join(', ')}`,
            )
            error.name = 'DirectH3UnsupportedResolutionError'
            if (requestedRenderer === 'webgpu') throw error
            console.warn('Direct WebGPU H3 renderer unavailable; using deck', error)
            return createH3Layer(data, kind, valuekey)
        }
        const renderer = await ensureH3Renderer()
        return renderer === 'webgpu'
            ? chunkSet
            : createH3Layer(data, kind, valuekey)
    }

    function refreshH3LayerColours() {
        if (activeH3Renderer === 'webgpu') {
            const active = activeWebgpuChunkSet
            if (!active?.committed || !webgpuRenderer) return Promise.resolve()
            colourVersion++
            const renderer = webgpuRenderer
            const rendererLayer = webgpuMatrixLayer
            const rendererGeneration = webgpuRendererGeneration
            try {
                for (const chunk of active.activeChunks) {
                    renderer.updateColors(chunk.rendererId, webgpuChunkColors(active, chunk))
                }
            } catch (error) {
                return fallBackToDeck(error, renderer, rendererLayer, rendererGeneration).then(() => {
                    if (requestedRenderer === 'webgpu') throw error
                })
            }
            return renderLayers(false)
        }

        const active = activeH3Layer
        const layerIndex = active ? mainLayers.indexOf(active.layer) : -1
        if (layerIndex < 0) return Promise.resolve()

        colourVersion++
        const layer = active.layer.clone({updateTriggers: {getFillColor: [colourVersion]}})
        active.layer = layer
        mainLayers = mainLayers.slice()
        mainLayers[layerIndex] = layer
        return renderLayers(false)
    }

    function buildH3Centers(data, kind) {
        if (data._h3Centers) return data._h3Centers
        const rows = kind === 'column' ? h3RowCount(data) : data.length
        const doneCenters = detailPerfTimer('data.quantile.h3_centers', {rows})
        const centers = new Float32Array(rows * 2)
        const h3Target = [0, 0]
        for (let i = 0; i < rows; i++) {
            const [lat, lng] = cellToLatLng(h3IndexAt(data, kind, 'index', i, h3Target))
            const offset = i * 2
            centers[offset] = lng
            centers[offset + 1] = lat
        }
        data._h3Centers = centers
        doneCenters()
        return centers
    }

    function longitudeInBounds(lng, west, east) {
        let span = east - west
        while (span < 0) span += 360
        if (span >= 360) return true
        return ((lng - west) % 360 + 360) % 360 <= span
    }

    function visibleMapQuantileSample(state) {
        const bounds = map.getBounds()
        if (!bounds) return null
        const west = bounds.getWest()
        const east = bounds.getEast()
        const south = bounds.getSouth()
        const north = bounds.getNorth()
        const centers = buildH3Centers(state.data, state.kind)
        const values = []
        const weights = state.weights ? [] : null
        let visible = 0

        for (let i = 0; i < centers.length / 2; i++) {
            const offset = i * 2
            if (centers[offset + 1] < south || centers[offset + 1] > north || !longitudeInBounds(centers[offset], west, east)) continue
            const value = toFiniteNumber(columnValue(state.values, i))
            if (value == null) continue
            const sampleIndex = visible < QUANTILE_SAMPLE_SIZE ? visible : Math.floor(Math.random() * (visible + 1))
            visible++
            if (sampleIndex >= QUANTILE_SAMPLE_SIZE) continue
            values[sampleIndex] = value
            if (weights) weights[sampleIndex] = columnValue(state.weights, i)
        }
        return {values, weights, visible}
    }

    function assignMapQuantiles(state, getquantile) {
        if (state.kind === 'column') {
            state.data.quantile = assignQuantiles(state.values, getquantile, state.data.quantile)
            return
        }
        for (const row of state.data) row.quantile = getquantile(row.value)
    }

    function updateViewportQuantiles(source, visibleIndices = null) {
        const state = viewportQuantileState
        if (!state || state.source !== source) return
        if (activeH3Renderer === 'webgpu') {
            if (!activeWebgpuChunkSet?.committed || activeWebgpuChunkSet.data !== state.data) return
        } else if (!activeH3Layer || !mainLayers.includes(activeH3Layer.layer)) {
            return
        }

        let sample
        if (source === 'cartogram') {
            const values = {length: visibleIndices.length, get: i => columnValue(state.cartogramValues, visibleIndices[i])}
            sample = {values, weights: null, visible: visibleIndices.length}
        } else {
            sample = visibleMapQuantileSample(state)
        }
        if (!sample) return

        const doneEcdf = detailPerfTimer('viewport.quantile.ecdf', {source, visible: sample.visible})
        const [getquantile, getvalue, sampleSize] = ecdf(sample.values, state.trimFactor, sample.weights)
        doneEcdf()
        if (!sampleSize) return
        const doneAssign = detailPerfTimer('viewport.quantile.assign', {source, rows: state.values.length})
        assignMapQuantiles(state, getquantile)
        if (state.cartogramValues) {
            cartoAggCols.carto_quantile = assignQuantiles(state.cartogramValues, getquantile, cartoAggCols.carto_quantile)
            cartogramApi?.updateData(cartoAggCols, 'carto_quantile')
        }
        doneAssign()
        makeLegend(getvalue)
        void refreshH3LayerColours().catch(error => console.error('Failed to refresh H3 colours', error))
    }

    function extractValues(raw, kind) {
        if (kind === 'column') return raw.value
        return {length: raw.length, get: i => raw[i].value}
    }

    function extractWeights(raw, kind) {
        if (kind === 'column') return raw.weight || null
        return raw.length > 0 && Object.prototype.hasOwnProperty.call(raw[0], 'weight') ? {length: raw.length, get: i => raw[i].weight} : null
    }

    function applyQuantiles(raw, kind, getquantile) {
        if (kind === 'column') {
            const quantiles = assignQuantiles(raw.value, getquantile)
            return {...raw, quantile: quantiles}
        }
        return raw.map(o => ({...o, quantile: getquantile(o.value)}))
    }

    function assignQuantiles(values, getquantile, quantiles = new Array(values.length)) {
        for (let i = 0; i < values.length; i++) quantiles[i] = getquantile(values[i])
        return quantiles
    }

    function getDefaultValue() {
        const defaultValue = settings.defaultValue ?? null // in metadata json, specify defaultValue for missing data aggregation into cartogram
        if (defaultValue == null || defaultValue === '' || defaultValue === 'null') return null
        const parsed = Number(defaultValue)
        return Number.isNaN(parsed) ? null : parsed
    }

    function indexValuesByH3(sourceCols, sourceValueKey, perfLabel, perfDetails = {}, useSplitIndex = hasSplitH3Index(sourceCols)) {
        const sourceValues = sourceCols[sourceValueKey]
        const sourceRows = h3RowCount(sourceCols)
        const split = useSplitIndex && hasSplitH3Index(sourceCols)
        const doneDataMap = perfTimer(perfLabel, {rows: sourceRows, h3Index: split ? 'split' : 'string', ...perfDetails})
        const valuesByH3 = split ? {
            split: true,
            root: new Map(),
            entries: 0,
            has(lower, upper) { return splitMapHas(this.root, lower, upper) },
            get(lower, upper) { return splitMapGet(this.root, lower, upper) },
            set(lower, upper, value) {
                if (splitMapSet(this.root, lower, upper, value)) this.entries++
            },
        } : new Map()
        let sourceObserved = 0
        let sourceMissing = 0
        if (split) {
            const lowerCol = sourceCols[H3_INDEX_LOWER]
            const upperCol = sourceCols[H3_INDEX_UPPER]
            for (let i = 0; i < sourceRows; i++) {
                const value = toFiniteNumber(columnValue(sourceValues, i))
                valuesByH3.set(toNumber(columnValue(lowerCol, i)), toNumber(columnValue(upperCol, i)), value)
                if (value == null) sourceMissing++
                else sourceObserved++
            }
        } else {
            const sourceIndex = ensureH3StringColumn(sourceCols, `${perfLabel}.h3_strings`)
            for (let i = 0; i < sourceRows; i++) {
                const value = toFiniteNumber(columnValue(sourceValues, i))
                valuesByH3.set(toStringValue(columnValue(sourceIndex, i)), value)
                if (value == null) sourceMissing++
                else sourceObserved++
            }
        }
        doneDataMap({entries: split ? valuesByH3.entries : valuesByH3.size, sourceObserved, sourceMissing})
        return valuesByH3
    }

    function indexFiniteSplitValuesByH3(sourceCols, sourceValueKey, perfLabel, perfDetails = {}) {
        const sourceValues = sourceCols[sourceValueKey]
        const sourceRows = h3RowCount(sourceCols)
        const lowerCol = sourceCols[H3_INDEX_LOWER]
        const upperCol = sourceCols[H3_INDEX_UPPER]
        const doneDataMap = perfTimer(perfLabel, {rows: sourceRows, h3Index: 'split', ...perfDetails})
        const root = new Map()
        const valuesByH3 = {
            split: true,
            root,
            entries: 0,
        }
        let sourceObserved = 0
        let sourceMissing = 0
        let entries = 0
        for (let i = 0; i < sourceRows; i++) {
            const value = toFiniteNumber(sourceValues[i])
            if (value == null) {
                sourceMissing++
                continue
            }
            if (splitMapSet(root, toNumber(lowerCol[i]), toNumber(upperCol[i]), value)) entries++
            sourceObserved++
        }
        valuesByH3.entries = entries
        doneDataMap({entries: valuesByH3.entries, sourceObserved, sourceMissing})
        return valuesByH3
    }

    function projectedH3Columns(indexes, values, sourceValueKey, perfLabel) {
        const doneOutput = perfTimer(perfLabel, {rows: indexes.length})
        const grouped = {index: indexes, [sourceValueKey]: values}
        doneOutput()
        return grouped
    }

    async function cartoProjectionBuffers() {
        const h3map = await ensureH3ToXY()
        const cartoH3s = Array.from(h3map.keys())
        return {
            cartoH3s,
            indexes: new Array(cartoH3s.length),
        }
    }

    function cartoProjectionConfig(h3res) {
        const isChildRollup = h3res > cartoRes
        return {
            source: isChildRollup ? 'child-rollup' : 'parent-downproject',
            dataMapLabel: isChildRollup ? 'cartogram.child_rollup.data_map' : 'cartogram.parent_downproject.data_map',
            projectLabel: isChildRollup ? 'cartogram.child_rollup.accumulate' : 'cartogram.parent_downproject.project',
            outputLabel: isChildRollup ? 'cartogram.child_rollup.output' : 'cartogram.parent_downproject.output',
            dataMapDetails: isChildRollup ? {} : {sourceRes: h3res, cartoRes},
            projectDetails: cartoH3s => isChildRollup
                ? {cartoH3s: cartoH3s.length, cartoRes, h3res}
                : {cartoH3s: cartoH3s.length, sourceRes: h3res, cartoRes},
            contributorsFor: cartoH3 => isChildRollup ? cellToChildren(cartoH3, h3res) : [cellToParent(cartoH3, h3res)],
            fillMissingContributors: isChildRollup,
        }
    }

    function aggregateTargetMeans(targetCount, valuesBySource, forEachContributor, options = {}) {
        const {
            defaultNumber = null,
            fillMissingContributors = false,
            getWeight = () => 1,
            infillMissing = false,
            trackSourceCoverage = false,
        } = options
        const numerator = new Float64Array(targetCount)
        const denominator = new Float64Array(targetCount)
        const observedByTarget = new Uint8Array(targetCount)
        const missingWeightByTarget = fillMissingContributors && defaultNumber != null ? new Float64Array(targetCount) : null
        const missingCountByTarget = missingWeightByTarget ? new Uint32Array(targetCount) : null
        const missingValidCountByTarget = missingWeightByTarget ? new Uint32Array(targetCount) : null
        const invalidMissingWeightByTarget = missingWeightByTarget ? new Uint32Array(targetCount) : null
        const coveredSourceH3s = trackSourceCoverage ? new Set() : null
        const observedSourceH3s = trackSourceCoverage ? new Set() : null

        let contributorRows = 0
        let contributorsCoveredByInput = 0
        let targetsWithObservedData = 0
        let contributorValuesObserved = 0
        let contributorValuesDefaulted = 0
        let contributorValuesUsed = 0
        let invalidWeights = 0

        forEachContributor((targetIndex, sourceH3, contributor, sourceH3Upper) => {
            contributorRows++
            const splitSource = valuesBySource.split && sourceH3Upper != null
            const hasSource = splitSource ? valuesBySource.has(sourceH3, sourceH3Upper) : valuesBySource.has(sourceH3)
            const value = hasSource ? (splitSource ? valuesBySource.get(sourceH3, sourceH3Upper) : valuesBySource.get(sourceH3)) : null
            if (hasSource) {
                contributorsCoveredByInput++
                if (coveredSourceH3s) coveredSourceH3s.add(splitSource ? splitLongToH3Index(sourceH3, sourceH3Upper) : sourceH3)
            }
            if (value == null) {
                if (missingWeightByTarget) {
                    missingCountByTarget[targetIndex]++
                    const weight = getWeight(contributor, targetIndex, sourceH3)
                    if (weight == null) {
                        invalidMissingWeightByTarget[targetIndex]++
                    } else {
                        missingWeightByTarget[targetIndex] += weight
                        missingValidCountByTarget[targetIndex]++
                    }
                }
                return
            }

            contributorValuesObserved++
            if (!observedByTarget[targetIndex]) {
                observedByTarget[targetIndex] = 1
                targetsWithObservedData++
            }
            if (observedSourceH3s) observedSourceH3s.add(splitSource ? splitLongToH3Index(sourceH3, sourceH3Upper) : sourceH3)

            const weight = getWeight(contributor, targetIndex, sourceH3)
            if (weight == null) {
                invalidWeights++
                return
            }
            numerator[targetIndex] += value * weight
            denominator[targetIndex] += weight
            contributorValuesUsed++
        })

        if (missingWeightByTarget) {
            for (let i = 0; i < targetCount; i++) {
                if (!missingCountByTarget[i] || (!infillMissing && !observedByTarget[i])) continue
                numerator[i] += defaultNumber * missingWeightByTarget[i]
                denominator[i] += missingWeightByTarget[i]
                contributorValuesDefaulted += missingCountByTarget[i]
                contributorValuesUsed += missingValidCountByTarget[i]
                invalidWeights += invalidMissingWeightByTarget[i]
            }
        }

        const values = new Array(targetCount)
        let targetsWithData = 0
        let targetsMissing = 0
        for (let i = 0; i < targetCount; i++) {
            if (denominator[i]) {
                values[i] = numerator[i] / denominator[i]
                targetsWithData++
            } else {
                values[i] = null
                targetsMissing++
            }
        }

        return {
            values,
            contributorRows,
            contributorsMissing: contributorRows - contributorValuesObserved,
            contributorsCoveredByInput,
            targetsWithObservedData,
            targetsWithData,
            targetsMissing,
            contributorValuesObserved,
            contributorValuesDefaulted,
            contributorValuesUsed,
            invalidWeights,
            coveredSourceH3s,
            observedSourceH3s,
        }
    }

    function aggregateSameResolutionSplitCartogram(valuesByH3, cellCount, cartogramRows) {
        const numerator = new Float64Array(cellCount)
        const denominator = new Float64Array(cellCount)
        const observedByTarget = new Uint8Array(cellCount)
        const values = new Array(cellCount)
        const rowCell = cartogramAgg.rowCell
        const lowerCol = cartogramAgg.h3Cols[H3_INDEX_LOWER]
        const upperCol = cartogramAgg.h3Cols[H3_INDEX_UPPER]
        const weightValues = cartogramAgg.weightValues
        const valuesRoot = valuesByH3.root

        let targetsWithObservedData = 0
        let contributorValuesObserved = 0
        let contributorValuesUsed = 0
        let invalidWeights = 0

        for (let i = 0; i < cartogramRows; i++) {
            const targetIndex = rowCell[i]
            const value = splitMapGet(valuesRoot, toNumber(lowerCol[i]), toNumber(upperCol[i]))
            if (value == null) continue

            contributorValuesObserved++
            if (!observedByTarget[targetIndex]) {
                observedByTarget[targetIndex] = 1
                targetsWithObservedData++
            }

            const weight = weightValues ? weightValues[i] : 1
            if (!Number.isFinite(weight)) {
                invalidWeights++
                continue
            }
            numerator[targetIndex] += value * weight
            denominator[targetIndex] += weight
            contributorValuesUsed++
        }

        let targetsWithData = 0
        let targetsMissing = 0
        for (let i = 0; i < cellCount; i++) {
            if (denominator[i]) {
                values[i] = numerator[i] / denominator[i]
                targetsWithData++
            } else {
                values[i] = null
                targetsMissing++
            }
        }

        return {
            values,
            contributorRows: cartogramRows,
            contributorsMissing: cartogramRows - contributorValuesObserved,
            contributorsCoveredByInput: contributorValuesObserved,
            targetsWithObservedData,
            targetsWithData,
            targetsMissing,
            contributorValuesObserved,
            contributorValuesDefaulted: 0,
            contributorValuesUsed,
            invalidWeights,
            coveredSourceH3s: null,
            observedSourceH3s: null,
        }
    }

    function groupCartogramWithMap(sourceCols, sourceValueKey, perfDetails = {}) {
        const doneGroup = perfTimer('cartogram.js_group.total', perfDetails)
        const defaultValue = getDefaultValue()
        const defaultNumber = toFiniteNumber(defaultValue)
        const meanCol = sourceValueKey === 'quantile' ? 'quantile_mean' : 'value_mean'
        const useSplitJoin = hasSplitH3Index(sourceCols) && hasSplitH3Index(cartogramAgg.h3Cols)
        const useFastSplitJoin = useSplitJoin && defaultNumber == null
        const valuesByH3 = useFastSplitJoin
            ? indexFiniteSplitValuesByH3(sourceCols, sourceValueKey, 'cartogram.js_group.data_map')
            : indexValuesByH3(sourceCols, sourceValueKey, 'cartogram.js_group.data_map', {}, useSplitJoin)

        const cellCount = cartogramAgg.x.length
        const weightValues = cartogramAgg.weightValues
        const weights = cartogramAgg.weights
        const cartogramRows = h3RowCount(cartogramAgg.h3Cols)
        const split = valuesByH3.split && hasSplitH3Index(cartogramAgg.h3Cols)
        const doneAccum = perfTimer('cartogram.js_group.accumulate', {rows: cartogramRows, cells: cellCount})
        const aggregated = useFastSplitJoin
            ? aggregateSameResolutionSplitCartogram(valuesByH3, cellCount, cartogramRows)
            : aggregateTargetMeans(
                cellCount,
                valuesByH3,
                split ? visit => {
                    const lowerCol = cartogramAgg.h3Cols[H3_INDEX_LOWER]
                    const upperCol = cartogramAgg.h3Cols[H3_INDEX_UPPER]
                    for (let i = 0; i < cartogramRows; i++) {
                        visit(
                            cartogramAgg.rowCell[i],
                            toNumber(columnValue(lowerCol, i)),
                            i,
                            toNumber(columnValue(upperCol, i))
                        )
                    }
                } : visit => {
                    const cartogramH3s = ensureH3StringColumn(cartogramAgg.h3Cols, 'cartogram.js_group.h3_strings')
                    for (let i = 0; i < cartogramRows; i++) {
                        visit(cartogramAgg.rowCell[i], toStringValue(columnValue(cartogramH3s, i)), i)
                    }
                },
                {
                    defaultNumber,
                    fillMissingContributors: defaultNumber != null,
                    infillMissing: infill,
                    getWeight: i => weightValues ? (Number.isFinite(weightValues[i]) ? weightValues[i] : null) : (weights ? toFiniteNumber(weights[i]) : 1),
                }
            )
        doneAccum({
            infill,
            defaultValue: defaultNumber,
            cellsWithObservedData: aggregated.targetsWithObservedData,
            h3Observed: aggregated.contributorValuesObserved,
            h3Missing: aggregated.contributorsMissing,
            h3Defaulted: aggregated.contributorValuesDefaulted,
            h3ValuesUsed: aggregated.contributorValuesUsed,
            invalidWeights: aggregated.invalidWeights,
        })

        const doneOutput = perfTimer('cartogram.js_group.output', {cells: cellCount})
        const aggCols = {
            x: cartogramAgg.x,
            y: cartogramAgg.y,
            _code: cartogramAgg.code,
            code: cartogramAgg.code,
            label: cartogramAgg.label,
            prominence: cartogramAgg.prominence,
            index: cartogramAgg.index,
            [meanCol]: aggregated.values,
        }
        doneOutput()
        doneGroup({
            rows: cellCount,
            defaultValue: defaultNumber,
            infill,
            cellsWithData: aggregated.targetsWithData,
            cellsMissing: aggregated.targetsMissing,
            cellsWithObservedData: aggregated.targetsWithObservedData,
        })
        return {aggCols, meanCol}
    }

    async function projectH3ToCartoResolution(dataCols, sourceValueKey, h3res) {
        const config = cartoProjectionConfig(h3res)
        const defaultValue = getDefaultValue()
        const defaultNumber = config.fillMissingContributors ? toFiniteNumber(defaultValue) : null
        const valuesBySource = indexValuesByH3(dataCols, sourceValueKey, config.dataMapLabel, config.dataMapDetails, false)
        const {cartoH3s, indexes} = await cartoProjectionBuffers()

        const doneProject = perfTimer(config.projectLabel, config.projectDetails(cartoH3s))
        const aggregated = aggregateTargetMeans(
            cartoH3s.length,
            valuesBySource,
            visit => {
                for (let i = 0; i < cartoH3s.length; i++) {
                    indexes[i] = cartoH3s[i]
                    for (const contributor of config.contributorsFor(cartoH3s[i])) visit(i, contributor)
                }
            },
            {
                defaultNumber,
                fillMissingContributors: config.fillMissingContributors,
                infillMissing: infill,
                trackSourceCoverage: true,
            }
        )

        if (config.source === 'child-rollup') {
            doneProject({
                childRows: aggregated.contributorRows,
                infill,
                defaultValue: defaultNumber,
                parentsWithData: aggregated.targetsWithData,
                parentsMissing: aggregated.targetsMissing,
                parentsWithObservedData: aggregated.targetsWithObservedData,
                childValuesObserved: aggregated.contributorValuesObserved,
                childValuesDefaulted: aggregated.contributorValuesDefaulted,
                childValuesUsed: aggregated.contributorValuesUsed,
            })
        } else {
            doneProject({
                parentsCovered: aggregated.coveredSourceH3s.size,
                parentsObserved: aggregated.observedSourceH3s.size,
                childrenCoveredByInput: aggregated.contributorsCoveredByInput,
                childrenWithObservedData: aggregated.targetsWithObservedData,
                childrenMissing: aggregated.targetsMissing,
            })
        }

        const grouped = projectedH3Columns(indexes, aggregated.values, sourceValueKey, config.outputLabel)
        return {grouped, source: config.source}
    }

    let reloadNum = 0
    const getHexData = async publishLayer => {
        const doneGetHexData = perfTimer('data.reload.total', {file: file_name, ext, layer: format.layer})
        viewportQuantileState = null
        h3DataRowLookup = null
        hideMapHoverTooltip()
        if (!loadProgress.totalWork) configureLoadProgress()
        setLoadStage('Loading data')

        const doQuantiles = !settingEnabled(settings.raw, false)
        const trimFactor = settings.trimFactor ? settings.trimFactor : 0.01
        const useCartogramQuantiles = cartogramEnabled && settings.quantileSource === 'cartogram'

        if (format.layer === 'hex' && (ext === 'arrow' || ext === 'csv')) {
            const reload = ++reloadNum
            const resp = await measurePerf('data.fetch', {file: file_path, reload}, () => fetch(`${file_path}?v=${reload}`))
            const buf = await measurePerf(ext === 'csv' ? 'data.read_text' : 'data.read_arrayBuffer', () => ext === 'csv' ? resp.text() : resp.arrayBuffer())
            setLoadStage('Parsing data')
            let dataCols
            let schema
            if (ext === 'arrow') {
                const dataTable = await parseArrowTable(buf, 'data.arrow_parse', {bytes: buf.byteLength})
                const fields = dataTable.schema.fields.map(f => f.name)
                dataCols = await materializeArrowColumns(dataTable, fields, 'data.arrow_column')
                schema = dataCols
            } else {
                const rows = await parseCsvRows(buf)
                dataCols = await measurePerf('data.csv_to_columns', {rows: rows.length}, () => rowsToColumns(rows))
                schema = dataCols
            }
            setLoadStage('Data parsed')

            const hasWeight = schema.hasOwnProperty('weight')

            if (dataCols.index && dataCols.index.length && String(dataCols.index[0]).startsWith('0')) {
                const doneIndexNormalize = perfTimer('data.index_normalize', {rows: dataCols.index.length})
                dataCols.index = dataCols.index.map(h => String(h).slice(1))
                doneIndexNormalize()
            }

            const values = dataCols.value
            const weights = hasWeight ? dataCols.weight : null
            const schemaHasH3Index = hasH3Index(schema)
            const dataHasSplitH3Index = hasSplitH3Index(schema)
            const cartogramReady = cartogramEnabled && schemaHasH3Index
                ? measurePerf('cartogram.init.await', {dataH3Index: dataHasSplitH3Index ? 'split' : 'string'}, () => {
                    if (!cartogramInit) {
                        cartogramWeightsFile = cartogramFileForData(settings.cartogram, dataHasSplitH3Index)
                        cartogramInit = loadCartogramWeights(cartogramWeightsFile)
                    }
                    return cartogramInit
                })
                : null
            cartogramReady?.catch(() => {})
            const h3res = schemaHasH3Index && h3RowCount(dataCols) ? getResolution(h3IndexInputAt(dataCols, 0)) : null
            dataH3Res = h3res
            const valuekey = doQuantiles ? 'quantile' : 'value'
            let getquantileFn
            let getvalueFn
            let cartoValueCol = null

            window._columnData = dataCols
            window.raw_data = dataCols

            if (doQuantiles) {
                setLoadStage('Calculating quantiles')
                const doneEcdf = perfTimer('data.quantile.ecdf', {rows: values.length, weighted: !!weights})
                const [getquantile, getvalue] = ecdf(values, trimFactor, weights)
                doneEcdf()
                getquantileFn = getquantile
                getvalueFn = getvalue
                const doneQuantileAssign = perfTimer('data.quantile.assign', {rows: values.length})
                dataCols.quantile = assignQuantiles(values, getquantile)
                doneQuantileAssign()
                makeLegend(getvalueFn)
                setLoadStage('Quantiles ready')
            } else {
                makeLegend()
            }

            setLoadStage('Preparing map layer')
            const mapRenderable = await measurePerf(
                'deck.hex_layer.create',
                {rows: dataCols.value.length, renderer: requestedRenderer, pickable: false, h3Index: hasSplitH3Index(dataCols) ? 'split' : 'string'},
                () => createMainH3Renderable(dataCols, 'column', valuekey),
            )
            // Cartogram I/O must not delay the geographic map.
            await publishLayer(mapRenderable)

            const failCartogram = error => {
                cartoValueCol = null
                cartogramInit = null
                cartogramRawCols = null
                cartogramAgg = null
                cartoAggCols = null
                h3toXY = null
                h3toXYPromise = null
                document.body.classList.remove('cartogram-ready')
                console.warn('Cartogram unavailable; map loaded without it', error)
            }

            let cartogramAvailable = !!cartogramReady
            if (cartogramReady) {
                try {
                    await waitWithLoadProgress(cartogramReady, 'Waiting for cartogram weights')
                } catch (error) {
                    cartogramAvailable = false
                    failCartogram(error)
                }
            }
            const resolutionGap = h3res == null ? 0 : h3res - cartoRes
            const loadCartogram = cartogramAvailable && resolutionGap <= MAX_CARTOGRAM_RESOLUTION_GAP
            if (cartogramAvailable && !loadCartogram) {
                console.warn(`Skipping cartogram: source H3 resolution ${h3res} is ${resolutionGap} levels finer than cartogram resolution ${cartoRes} (maximum ${MAX_CARTOGRAM_RESOLUTION_GAP}; up to ~${7 ** resolutionGap} source cells per cartogram cell)`)
                cartoAggCols = null
                document.body.classList.remove('cartogram-ready')
            }

            if (loadCartogram) try {
                await yieldToPaint('Aggregating cartogram')

                cartoAggCols = null
                let cartoDataCol = null

                if (h3res === cartoRes) {
                    const result = groupCartogramWithMap(dataCols, 'value', {source: 'same-resolution', rows: h3RowCount(dataCols), h3Index: hasSplitH3Index(dataCols) ? 'split' : 'string'})
                    cartoAggCols = result.aggCols
                    cartoDataCol = result.meanCol
                } else {
                    const {grouped, source} = await projectH3ToCartoResolution(dataCols, 'value', h3res)
                    const result = groupCartogramWithMap(grouped, 'value', {source, rows: h3RowCount(grouped), h3Index: hasSplitH3Index(grouped) ? 'split' : 'string'})
                    cartoAggCols = result.aggCols
                    cartoDataCol = result.meanCol
                }

                if (cartoAggCols) {
                    await yieldToPaint('Preparing map/cartogram links')
                    const h3map = await measurePerf('cartogram.h3_to_xy.await_render', () => ensureH3ToXY())
                    setLoadStage('Preparing cartogram colours')
                    cartoValueCol = cartoDataCol

                    if (useCartogramQuantiles && doQuantiles) {
                        const cartoValues = cartoAggCols[cartoDataCol]
                        const doneCartoEcdf = perfTimer('cartogram.quantile.ecdf', {rows: cartoValues.length})
                        const [getquantile, getvalue] = ecdf(cartoValues, trimFactor)
                        doneCartoEcdf()
                        getquantileFn = getquantile
                        getvalueFn = getvalue
                    }
                    if (doQuantiles && getquantileFn) {
                        const cartoValues = cartoAggCols[cartoValueCol]
                        const doneCartoQuantiles = perfTimer('cartogram.quantile.assign_cartogram', {rows: cartoValues.length})
                        cartoAggCols.carto_quantile = assignQuantiles(cartoValues, getquantileFn)
                        doneCartoQuantiles()
                        cartoDataCol = 'carto_quantile'
                    }
                    if (useCartogramQuantiles && doQuantiles) {
                        const doneDataQuantiles = perfTimer('cartogram.quantile.assign_data', {rows: values.length})
                        dataCols.quantile = assignQuantiles(values, getquantileFn)
                        doneDataQuantiles()
                        await refreshH3LayerColours()
                        makeLegend(getvalueFn)
                    }

                    if (!cartogramApi) {
                        setLoadStage('Showing cartogram pane')
                        await ensureCartogramPaneLaidOut('initial-render')
                        await yieldToPaint('Drawing cartogram')
                        const doneRenderCartogram = perfTimer('cartogram.render.call', {rows: cartoAggCols.x.length})
                        cartogramApi = render_cartogram('#cartogram', cartoAggCols, {
                            perf: perfEnabled,
                            svgPerf: svgPerfEnabled,
                            debug: syncDebugEnabled,
                            draw_outline: false,
                            get_color: getCssColour,
                            color_transition_duration: COLOUR_TRANSITION_DURATION,
                            include_outer_borders: true,
                            data_col: cartoDataCol,
                            onviewchange_callback: (data, visibleIndices) => updateViewportQuantiles('cartogram', visibleIndices),
                            onclick_callback: (data, event, i) => {
                                if (updateRunning) return
                                try {
                                    syncLog('cartogram.click.callback', {
                                        row: i,
                                        eventType: event?.type,
                                        cartogramEnabled,
                                        hasApi: !!cartogramApi,
                                        hasAggCols: !!cartoAggCols,
                                        dataH3Res,
                                        cartoRes,
                                    })
                                    if (cartogramApi) cartogramApi.highlightCells([i])
                                    const cartoRefs = cartogramCellH3Strings(i)
                                    syncLog('cartogram.click.resolve', {
                                        row: i,
                                        cartoH3Refs: cartoRefs.length,
                                        firstCartoRefs: cartoRefs.slice(0, 5),
                                        cartoRes,
                                        dataH3Res,
                                    })
                                    if (cartoRefs.length) hex(cartoRefs, {fit: true})
                                    else syncLog('cartogram.click.skip_no_carto_refs', {row: i})
                                } catch (e) {
                                    console.warn('Cartogram click failed', {row: i, cartoRes, dataH3Res}, e)
                                }
                            },
                            onmove_callback: (data, visibleIndices) => {
                                if (updateRunning) return
                                keyboardTarget = 'cartogram'
                                const contributorH3 = cartogramCellsH3Strings(visibleIndices)
                                const anchorH3 = cartogramCellsAnchorH3Strings(visibleIndices)
                                const fitH3 = anchorH3.length ? anchorH3 : contributorH3
                                syncLog('cartogram->map.visible', {
                                    visibleRows: visibleIndices.length,
                                    contributorH3Refs: contributorH3.length,
                                    contributorUniqueH3: new Set(contributorH3).size,
                                    anchorH3Refs: anchorH3.length,
                                    anchorUniqueH3: new Set(anchorH3).size,
                                    fitMode: anchorH3.length ? 'anchors' : 'contributors',
                                    fitH3Refs: fitH3.length,
                                    fitUniqueH3: new Set(fitH3).size,
                                    firstRows: visibleIndices.slice(0, 10),
                                    firstContributorH3: contributorH3.slice(0, 10),
                                    firstAnchorH3: anchorH3.slice(0, 10),
                                })
                                hex(fitH3, {fit: true, padding: 0, highlight: false, fitTrim: 0.01})
                            }
                        })
                        doneRenderCartogram()
                        setLoadStage('Fitting cartogram to map')
                        await nextPaint()
                        svgPerfLog('cartogram.initial_fit.layout', cartogramLayoutDetails())
                        fitCartogramToMapBounds(cartogramApi, h3map)
                    } else {
                        setLoadStage('Updating cartogram')
                        const doneUpdateCartogram = perfTimer('cartogram.update.call', {rows: cartoAggCols.x.length})
                        cartogramApi.highlightCells([])
                        cartogramApi.updateData(cartoAggCols, cartoDataCol)
                        doneUpdateCartogram()
                    }
                    document.body.classList.add('cartogram-ready')
                    setLoadStage('Rendering map')
                }
            } catch (error) {
                const rendererError = explicitWebgpuFailure()
                if (rendererError) throw rendererError
                failCartogram(error)
            }

            if (doQuantiles && getquantileFn) {
                viewportQuantileState = {
                    source: useCartogramQuantiles && cartoValueCol ? 'cartogram' : 'map',
                    trimFactor,
                    data: dataCols,
                    kind: 'column',
                    values,
                    weights,
                    cartogramValues: cartoValueCol ? cartoAggCols[cartoValueCol] : null,
                }
            }

            doneGetHexData({rows: dataCols.value.length, cartogramRows: cartoAggCols ? cartoAggCols.x.length : 0, h3Index: hasSplitH3Index(dataCols) ? 'split' : 'string'})
            return mapRenderable
        }

        let loaded
        const reload = ++reloadNum
        if (format.layer === 'geojson') {
            const resp = await measurePerf('data.fetch', {file: file_path, reload}, () => fetch(`${file_path}?v=${reload}`))
            loaded = {data: await measurePerf('data.read_json', () => resp.json())}
        } else {
            loaded = await measurePerf('data.load', {file: file_path, reload}, () => load(`${file_path}?v=${reload}`, format.loader, format.loadOptions))
        }
        let raw = loaded.data
        window.raw_data = raw
        setLoadStage('Data loaded')

        if (raw && raw.batches && raw.schema) {
            setLoadStage('Converting data columns')
            const table = raw
            const fields = table.schema.fields.map(f => f.name)
            const columnar = {}
            for (const field of fields) columnar[field] = []
            for (const batch of table.batches) {
                batch.data.children.forEach((child, i) => {
                    const name = fields[i]
                    if (child.dictionary) {
                        const dict = child.dictionary.values
                        const indices = child.values
                        const decoded = Array.from(indices, idx => dict[idx])
                        columnar[name] = columnar[name].concat(decoded)
                    } else if (child.valueOffsets && child.values) {
                        const offsets = child.valueOffsets
                        const bytes = child.values
                        const decoder = new TextDecoder()
                        for (let j = 0; j < offsets.length - 1; j++) {
                            const start = offsets[j]
                            const end = offsets[j + 1]
                            columnar[name].push(decoder.decode(bytes.subarray(start, end)))
                        }
                    } else if (child.values) {
                        columnar[name] = columnar[name].concat(Array.from(child.values))
                    }
                })
            }
            raw = columnar
        }

        let data
        let valuekey = 'value'
        if (doQuantiles && (format.layer === 'hex' || format.layer === 'geojson')) {
            setLoadStage('Calculating quantiles')
            let values, weights
            if (format.layer === 'hex') {
                values = extractValues(raw, format.kind)
                weights = extractWeights(raw, format.kind)
            } else {
                // geojson
                values = raw.features.map(f => f.properties?.value ?? f.value ?? f.properties?.val)
                weights = raw.features.map(f => f.properties?.weight ?? f.weight).filter(x => x != null)
                if (weights.length !== values.length) {
                    if (weights.length !== 0) console.warn(`Weights and values have different lengths`)
                    weights = null
                }
            }
            const doneEcdf = perfTimer('data.quantile.ecdf', {rows: values.length, weighted: !!weights})
            const [getquantile, getvalue] = ecdf(values, trimFactor, weights)
            doneEcdf()
            if (format.layer === 'hex') {
                const doneQuantileAssign = perfTimer('data.quantile.assign', {rows: values.length})
                data = applyQuantiles(raw, format.kind, getquantile)
                doneQuantileAssign()
            } else {
                // assign quantile to each feature
                const doneQuantileAssign = perfTimer('data.quantile.assign', {rows: raw.features.length})
                data = {
                    ...raw,
                    features: raw.features.map(f => ({...f, properties: {...f.properties, quantile: getquantile(f.properties?.value ?? f.value ?? f.properties?.val)}}))
                }
                doneQuantileAssign()
            }
            valuekey = 'quantile'
            makeLegend(getvalue)
            if (format.layer === 'hex') {
                viewportQuantileState = {
                    source: 'map',
                    trimFactor,
                    data,
                    kind: format.kind,
                    values,
                    weights,
                    cartogramValues: null,
                }
            }
            setLoadStage('Quantiles ready')
        } else {
            data = raw
            makeLegend()
        }

        if (format.layer === 'hex') {
            setLoadStage('Preparing map layer')
            if (format.kind === 'column') window._columnData = data
            const rows = format.kind === 'column' ? data.value.length : data.length
            const layer = await measurePerf('deck.hex_layer.create', {rows, renderer: requestedRenderer, pickable: false, h3Index: format.kind === 'column' && hasSplitH3Index(data) ? 'split' : 'string'}, () => createMainH3Renderable(data, format.kind, valuekey))
            await publishLayer(layer)
            doneGetHexData({rows, h3Index: format.kind === 'column' && hasSplitH3Index(data) ? 'split' : 'string'})
            return layer
        }

        if (format.layer === 'geojson') {
            setLoadStage('Preparing GeoJSON layer')
            const getColor = f => {
                const v = valuekey === 'quantile' ? f.properties?.quantile : (f.properties?.value ?? f.value ?? f.properties?.val)
                return getColour(v)
            }
            const doneGeoJsonLayer = perfTimer('deck.geojson_layer.create', {rows: data.features.length})
            const layer = new GeoJsonLayer({
                id: 'GeoJsonLayer',
                data: data,
                filled: true,
                stroked: true,
                getFillColor: getColor,
                getLineColor: f => { const rgba = getColor(f); return rgba[3] === 0 ? rgba : [...rgba.slice(0,3), 255] },
                getLineWidth: 1000,
                lineWidthMinPixels: 1,
                lineJointRounded: true,
                lineCapRounded: true,
                lineWidthMaxPixels: 4,
                lineWidthUnits: 'meters',
                lineBillboard: true,
                transitions: {getFillColor: colourTransition, getLineColor: colourTransition},
                pickable: false
            })
            doneGeoJsonLayer()
            await publishLayer(layer)
            doneGetHexData({rows: data.features.length})
            return layer
        }
    }

    const choochoo = new TileLayer({
        id: 'OpenRailwayMapLayer',
        data: 'https://tiles.openrailwaymap.org/maxspeed/{z}/{x}/{y}.png',
        maxZoom: 19,
        minZoom: 0,

        renderSubLayers: props => {
            const {boundingBox} = props.tile;

            return new BitmapLayer(props, {
                data: null,
                image: props.data,
                bounds: [boundingBox[0][0], boundingBox[0][1], boundingBox[1][0], boundingBox[1][1]]
            })
        },
        pickable: false
    })

    function splitH3LookupSlot(lower, upper, mask) {
        let hash = Math.imul(lower ^ (lower >>> 16), 0x45d9f3b)
        hash ^= Math.imul(upper ^ (upper >>> 16), 0x119de1f3)
        return (hash ^ (hash >>> 16)) & mask
    }

    function buildH3DataRowLookup(cols = window._columnData) {
        if (!cols || !hasH3Index(cols)) return null
        const rows = h3RowCount(cols)
        const split = hasSplitH3Index(cols)
        const doneLookup = perfTimer('data.h3_row_lookup.build', {rows, h3Index: split ? 'split' : 'string'})
        if (split) {
            let capacity = 1
            while (capacity < rows * 1.5) capacity *= 2
            const mask = capacity - 1
            const lowerBySlot = new Uint32Array(capacity)
            const upperBySlot = new Uint32Array(capacity)
            const rowBySlot = new Uint32Array(capacity)
            const lowerCol = cols[H3_INDEX_LOWER]
            const upperCol = cols[H3_INDEX_UPPER]
            for (let i = 0; i < rows; i++) {
                const lower = toNumber(columnValue(lowerCol, i)) >>> 0
                const upper = toNumber(columnValue(upperCol, i)) >>> 0
                let slot = splitH3LookupSlot(lower, upper, mask)
                while (rowBySlot[slot] && (lowerBySlot[slot] !== lower || upperBySlot[slot] !== upper)) slot = (slot + 1) & mask
                if (!rowBySlot[slot]) {
                    lowerBySlot[slot] = lower
                    upperBySlot[slot] = upper
                    rowBySlot[slot] = i + 1
                }
            }
            doneLookup({capacity})
            return {split: true, lowerBySlot, upperBySlot, rowBySlot, mask}
        }

        const map = new Map()
        for (let i = 0; i < rows; i++) {
            const h3 = h3IndexStringAt(cols, i)
            if (!map.has(h3)) map.set(h3, i)
        }
        doneLookup()
        return {split: false, map}
    }

    function lookupDataRowForH3(h3Index) {
        if (!window._columnData) return null
        if (!h3DataRowLookup) h3DataRowLookup = buildH3DataRowLookup(window._columnData)
        if (!h3DataRowLookup) return null
        if (h3DataRowLookup.split) {
            const [rawLower, rawUpper] = h3IndexToSplitLong(String(h3Index))
            const lower = rawLower >>> 0
            const upper = rawUpper >>> 0
            const {lowerBySlot, upperBySlot, rowBySlot, mask} = h3DataRowLookup
            let slot = splitH3LookupSlot(lower, upper, mask)
            while (rowBySlot[slot]) {
                if (lowerBySlot[slot] === lower && upperBySlot[slot] === upper) return rowBySlot[slot] - 1
                slot = (slot + 1) & mask
            }
            return null
        }
        return h3DataRowLookup.map.get(String(h3Index)) ?? null
    }

    function formatDataValue(v) {
        if (v == null) return ''
        if (typeof v === 'number') return parseFloat(v.toPrecision(4)).toLocaleString()
        if (typeof v === 'object') return JSON.stringify(v)
        return v
    }

    function mapTooltipHtml(h3Index, rowIndex) {
        const cols = window._columnData
        const rows = [['index', h3Index]]
        if (cols && rowIndex != null) {
            const preferred = ['value', 'quantile', 'weight', 'weight_mean']
            const used = new Set(['index', H3_INDEX_LOWER, H3_INDEX_UPPER, ...preferred])
            for (const key of preferred) {
                if (cols[key]) rows.push([key, columnValue(cols[key], rowIndex)])
            }
            for (const key of Object.keys(cols)) {
                if (used.has(key) || key.startsWith('_')) continue
                rows.push([key, columnValue(cols[key], rowIndex)])
            }
        }
        return rows
            .filter(([, value]) => value != null && value !== '')
            .map(([key, value]) => `<div><strong>${escapeHtml(key)}</strong>: ${escapeHtml(formatDataValue(value))}</div>`)
            .join('')
    }

    function hideMapHoverTooltip() {
        pendingMapHover = null
        if (mapHoverRaf !== null) {
            cancelAnimationFrame(mapHoverRaf)
            mapHoverRaf = null
        }
        hoveredMapH3 = null
        mapHoverTooltip.style.display = 'none'
    }

    function positionMapHoverTooltip(point) {
        const rect = mapContainer.getBoundingClientRect()
        const cursorX = rect.left + point.x
        const cursorY = rect.top + point.y
        const width = mapHoverTooltip.offsetWidth
        const height = mapHoverTooltip.offsetHeight
        const preferredLeft = cursorX + 12
        const preferredTop = cursorY + 12
        const left = preferredLeft + width <= window.innerWidth - 8 ? preferredLeft : cursorX - width - 12
        const top = preferredTop + height <= window.innerHeight - 8 ? preferredTop : cursorY - height - 12
        mapHoverTooltip.style.left = `${Math.max(8, left)}px`
        mapHoverTooltip.style.top = `${Math.max(8, top)}px`
    }

    function updateMapHoverTooltip() {
        mapHoverRaf = null
        const hover = pendingMapHover
        pendingMapHover = null
        if (!hover || updateRunning || dataH3Res == null || (typeof map.isMoving === 'function' && map.isMoving())) {
            hideMapHoverTooltip()
            return
        }
        try {
            const h3Index = latLngToCell(hover.lat, hover.lng, dataH3Res)
            if (h3Index !== hoveredMapH3) {
                const rowIndex = lookupDataRowForH3(h3Index)
                if (rowIndex == null) {
                    hideMapHoverTooltip()
                    return
                }
                hoveredMapH3 = h3Index
                mapHoverTooltip.innerHTML = mapTooltipHtml(h3Index, rowIndex)
                mapHoverTooltip.style.display = 'block'
            }
            positionMapHoverTooltip(hover.point)
        } catch (_) {
            hideMapHoverTooltip()
        }
    }

    function scheduleMapHoverTooltip(event) {
        if (now() < suppressMapHoverUntil || event.originalEvent?.sourceCapabilities?.firesTouchEvents) {
            hideMapHoverTooltip()
            return
        }
        pendingMapHover = {
            point: {x: event.point.x, y: event.point.y},
            lat: event.lngLat.lat,
            lng: event.lngLat.lng,
        }
        if (mapHoverRaf === null) mapHoverRaf = requestAnimationFrame(updateMapHoverTooltip)
    }

    async function focusCartogramForH3(h3Index) {
        hex([h3Index], {fit: false, highlight: true})
        if (!cartogramEnabled || !cartogramApi || !cartoAggCols) return
        const cartoH3s = cartoH3sForDataH3(h3Index)
        const h3map = await ensureH3ToXY()
        if (!h3map || !cartogramApi || !cartoAggCols) return

        const rowSet = new Set()
        const cells = []
        let xMin = Infinity, yMin = Infinity, xMax = -Infinity, yMax = -Infinity
        for (const cartoH3 of cartoH3s) {
            const entry = h3map.get(cartoH3)
            if (!entry) continue
            const bounds = getH3Bounds(entry)
            if (bounds.xMin < xMin) xMin = bounds.xMin
            if (bounds.yMin < yMin) yMin = bounds.yMin
            if (bounds.xMax > xMax) xMax = bounds.xMax
            if (bounds.yMax > yMax) yMax = bounds.yMax
            if (entry.cellIndices) {
                for (const cellIndex of entry.cellIndices) rowSet.add(cellIndex)
            } else if (entry.cells) {
                cells.push(...entry.cells)
            }
        }

        if (!rowSet.size && cells.length) {
            const cellSet = new Set(cells.map(([x, y]) => `${x},${y}`))
            for (let i = 0; i < cartoAggCols.x.length; i++) {
                if (cellSet.has(`${cartoAggCols.x[i]},${cartoAggCols.y[i]}`)) rowSet.add(i)
            }
        }
        if (!rowSet.size || xMin === Infinity) return

        cartogramApi.highlightCells(Array.from(rowSet))
        const padding = 20
        cartogramApi.fitToBounds([[xMin - padding, yMin - padding, xMax + padding, yMax + padding]])
    }

    const mapOverlay = new MapboxOverlay({
        interleaved: false,
        _pickable: false,
        // // experimental stuff to improve perf on mobile
        // _typedArrayManagerProps: {overAlloc: 1, poolSize: 0},
    })

    map.addControl(mapOverlay)
    map.addControl(new maplibregl.NavigationControl())

    map.on('mousemove', scheduleMapHoverTooltip)
    map.on('movestart', hideMapHoverTooltip)
    mapContainer.addEventListener('mouseleave', hideMapHoverTooltip)
    mapContainer.addEventListener('touchstart', () => {
        suppressMapHoverUntil = now() + 1000
        hideMapHoverTooltip()
    }, {capture: true, passive: true})
    mapContainer.addEventListener('mousemove', event => {
        if (event.target?.closest?.('#search-container, .maplibregl-ctrl, .pane-btn')) hideMapHoverTooltip()
    }, {capture: true})

    mapContainer.addEventListener('click', async event => {
        hideMapHoverTooltip()
        if (updateRunning || dataH3Res == null || event.button !== 0) return
        const target = event.target
        if (target?.closest && target.closest('#search-container, .maplibregl-ctrl, .maplibregl-popup, .pane-btn')) return
        try {
            const rect = mapContainer.getBoundingClientRect()
            const point = {x: event.clientX - rect.left, y: event.clientY - rect.top}
            const lngLat = map.unproject([point.x, point.y])
            const h3Index = latLngToCell(lngLat.lat, lngLat.lng, dataH3Res)
            syncLog('map.click.h3_fallback', {h3Index, dataH3Res})
            await focusCartogramForH3(h3Index)
        } catch (e) {
            console.warn('Failed to focus cartogram from map click', e)
        }
    }, {capture: true})

    const searchInput = document.getElementById('city-search')
    const resultsDiv = document.getElementById('city-results')
    let highlightedIdx = -1

    function selectCity(div) {
        if (!div) return
        const lat = parseFloat(div.dataset.lat)
        const lng = parseFloat(div.dataset.lng)
        syncCartogramAfterNextMapMove('city-search')
        map.flyTo({center: [lng, lat], zoom: 7})
        searchInput.value = div.textContent
        resultsDiv.style.display = 'none'
        highlightedIdx = -1
    }

    function highlightItem(idx) {
        Array.from(resultsDiv.children).forEach((el, i) => el.classList.toggle('highlighted', i === idx))
    }

    searchInput.addEventListener('input', () => {
        const query = searchInput.value.trim()
        if (query.length < 2) {
            resultsDiv.style.display = 'none'
            return
        }
        const cities = getCitiesStartsWith(query, 10, true)
        if (cities.length === 0) {
            resultsDiv.style.display = 'none'
            return
        }
        highlightedIdx = -1
        resultsDiv.innerHTML = cities.map(c =>
            `<div data-lat="${c.latitude}" data-lng="${c.longitude}">${c.name} (population: ${Number((c.population ?? 0).toPrecision(2)).toLocaleString()})</div>`
        ).join('')
        resultsDiv.style.display = 'block'
    })

    searchInput.addEventListener('keydown', e => {
        const items = resultsDiv.children
        if (items.length === 0) return
        if (e.key === 'ArrowDown') {
            e.preventDefault()
            highlightedIdx = (highlightedIdx + 1) % items.length
            highlightItem(highlightedIdx)
        } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            highlightedIdx = highlightedIdx <= 0 ? items.length - 1 : highlightedIdx - 1
            highlightItem(highlightedIdx)
        } else if (e.key === 'Enter') {
            e.preventDefault()
            const idx = highlightedIdx >= 0 ? highlightedIdx : 0
            selectCity(items[idx])
        } else if (e.key === 'Escape') {
            resultsDiv.style.display = 'none'
            highlightedIdx = -1
        }
    })

    resultsDiv.addEventListener('click', e => {
        selectCity(e.target.closest('div'))
    })
    document.addEventListener('click', e => {
        if (!e.target.closest('#search-container')) {
            resultsDiv.style.display = 'none'
            highlightedIdx = -1
        }
    })

    let mainLayers = []
    let deckRenderWaiters = []

    function onDeckAfterRender() {
        const waiters = deckRenderWaiters
        deckRenderWaiters = []
        for (const resolve of waiters) resolve()
    }

    function waitForNextDeckRender(timeout = 5000, trackProgress = true, rejectOnTimeout = false) {
        const done = (trackProgress ? perfTimer : detailPerfTimer)('deck.after_render')
        return new Promise((resolve, reject) => {
            let settled = false
            let timer = null
            let remaining = timeout
            let visibleSince = null
            const finish = error => {
                if (settled) return
                settled = true
                clearTimeout(timer)
                document.removeEventListener('visibilitychange', armTimer)
                map.off('remove', onRemove)
                const index = deckRenderWaiters.indexOf(finish)
                if (index >= 0) deckRenderWaiters.splice(index, 1)
                done()
                if (error) reject(error)
                else resolve()
            }
            const armTimer = () => {
                if (visibleSince !== null) remaining -= now() - visibleSince
                visibleSince = null
                clearTimeout(timer)
                if (document.hidden) return
                visibleSince = now()
                timer = setTimeout(() => {
                    const error = new Error(`Deck render timed out after ${timeout} visible ms`)
                    error.name = 'TimeoutError'
                    finish(rejectOnTimeout ? error : null)
                }, Math.max(0, remaining))
            }
            const onRemove = () => finish(new Error('MapLibre map was removed before deck rendered'))
            document.addEventListener('visibilitychange', armTimer)
            map.on('remove', onRemove)
            deckRenderWaiters.push(finish)
            armTimer()
        })
    }

    async function waitForWebgpuRender(renderer) {
        try {
            return await renderer.waitForRender({timeout: 5000})
        } catch (error) {
            if (error.name !== 'TimeoutError' || renderer.state !== 'ready') throw error
            renderer.requestRender()
            return renderer.waitForRender({timeout: 5000})
        }
    }

    renderLayers = (trackProgress = true, requireDeckFrame = false) => {
        const layers = [...mainLayers]
        if (highlightLayer) layers.push(highlightLayer)
        if (showTrains) {
            layers.push(choochoo)
        }
        const deckRendered = layers.length ? waitForNextDeckRender(5000, trackProgress, requireDeckFrame) : null
        const waitingWebgpuRenderer = activeH3Renderer === 'webgpu' ? webgpuRenderer : null
        const waitingWebgpuLayer = webgpuMatrixLayer
        const waitingWebgpuGeneration = webgpuRendererGeneration
        const webgpuRendered = waitingWebgpuRenderer
            ? waitForWebgpuRender(waitingWebgpuRenderer).catch(async error => {
                if (webgpuRenderer === waitingWebgpuRenderer) {
                    await fallBackToDeck(error, waitingWebgpuRenderer, waitingWebgpuLayer, waitingWebgpuGeneration)
                } else if (webgpuFallback) {
                    await webgpuFallback
                }
                if (requestedRenderer !== 'auto') throw error
            })
            : null
        const doneSetLayers = (trackProgress ? perfTimer : detailPerfTimer)('deck.set_layers', {layers: layers.length})
        mapOverlay.setProps({layers, onAfterRender: onDeckAfterRender})
        waitingWebgpuRenderer?.requestRender()
        doneSetLayers()
        return Promise.all([deckRendered, webgpuRendered].filter(Boolean))
    }

    let updateRunning = false
    let updatePending = false

    const updateOnce = async () => {
        const doneMapReady = perfTimer('app.load_to_map_ready', {file: file_name, ext, layer: format.layer, renderer: requestedRenderer, pickable: false, cartogramWeightsFile})
        if (loadProgress.complete) resetLoadProgress('Reloading data')
        const publishEarly = mainLayers.length === 0 && !activeWebgpuChunkSet?.committed
        deferLegend = !publishEarly
        pendingLegend = null
        const previousState = {
            activeH3Layer,
            activeWebgpuChunkSet,
            activeH3Renderer,
            viewportQuantileState,
            h3DataRowLookup,
            dataH3Res,
            cartogramInit,
            cartogramWeightsFile,
            cartogramRawCols,
            cartogramAgg,
            cartoAggCols,
            cartoRes,
            h3toXY,
            h3toXYPromise,
            cartogramApi,
            cartogramRenderState: cartogramApi?.snapshotState(),
            cartogramReady: document.body.classList.contains('cartogram-ready'),
            columnData: window._columnData,
            rawData: window.raw_data,
            layers: mainLayers,
            legend: legendDiv.lastElementChild,
        }
        let mapReady = false
        const publishLayer = async layer => {
            commitPendingLegend()
            const previousWebgpuSet = activeWebgpuChunkSet
            let renderable = layer
            let requireDeckFrame = false
            webgpuCommitRunning = true
            try {
                await chunkSelectionPromise
                if (renderable?.isWebgpuH3) {
                    const renderer = webgpuRenderer
                    const rendererLayer = webgpuMatrixLayer
                    const rendererGeneration = webgpuRendererGeneration
                    let previousReleased = false
                    try {
                        try {
                            await selectWebgpuChunks(renderable, false)
                        } catch (error) {
                            if (error.name !== 'DirectH3CapacityError' || !previousWebgpuSet || previousWebgpuSet === renderable) throw error
                            releaseWebgpuChunkSet(previousWebgpuSet)
                            previousReleased = true
                            await selectWebgpuChunks(renderable, false)
                        }
                        if (!previousReleased && previousWebgpuSet && previousWebgpuSet !== renderable) releaseWebgpuChunkSet(previousWebgpuSet)
                    } catch (error) {
                        await fallBackToDeck(error, renderer, rendererLayer, rendererGeneration)
                        if (webgpuFallback) await webgpuFallback
                        if (requestedRenderer === 'webgpu') throw error
                        renderable = createH3Layer(renderable.data, renderable.kind, renderable.valuekey)
                        requireDeckFrame = true
                    }
                }
                if (renderable?.isWebgpuH3) {
                    activeWebgpuChunkSet = renderable
                    activeH3Renderer = 'webgpu'
                    activeH3Layer = null
                    renderable.committed = true
                    mainLayers = []
                } else {
                    if (previousWebgpuSet) releaseWebgpuChunkSet(previousWebgpuSet)
                    activeWebgpuChunkSet = null
                    activeH3Renderer = 'deck'
                    if (activeH3Layer?.layer !== renderable) activeH3Layer = null
                    mainLayers = renderable ? [renderable] : []
                }
            } finally {
                webgpuCommitRunning = false
            }
            await renderLayers(true, requireDeckFrame)
            if (chunkSelectionPending && activeH3Renderer === 'webgpu') updateVisibleH3Chunks(true)
            if (!mapReady) {
                const layerData = renderable?.isWebgpuH3 ? renderable.data : renderable?.props?.data
                const layerSource = layerData?.src || layerData
                doneMapReady({
                    rows: renderable?.rowCount ?? layerData?.length ?? null,
                    chunks: renderable?.chunks?.length ?? null,
                    visibleChunks: renderable?.activeChunks?.length ?? null,
                    renderer: activeH3Renderer,
                    h3Index: hasSplitH3Index(layerSource) ? 'split' : 'string',
                })
                mapReady = true
            }
        }

        try {
            const layer = await getHexData(publishLayer)
            if (!mapReady) {
                await publishLayer(layer)
            }
            if (!h3DataRowLookup && dataH3Res != null && window._columnData) {
                await yieldToPaint('Indexing map cells')
                h3DataRowLookup = buildH3DataRowLookup(window._columnData)
            }
            const rendererError = explicitWebgpuFailure()
            if (rendererError) throw rendererError
            if (perfEnabled && !stopFrameRateTelemetry && perfSocket?.readyState === WebSocket.OPEN) {
                void reportDevicePerf(requestedRenderer, activeH3Renderer, webgpuRenderer?.adapter)
                stopFrameRateTelemetry = startFrameRateTelemetry()
            }
            finishLoadProgress()
        } catch (e) {
            if (!mapReady) doneMapReady({failed: true})
            webgpuCommitRunning = true
            await chunkSelectionPromise
            if (activeWebgpuChunkSet && activeWebgpuChunkSet !== previousState.activeWebgpuChunkSet) {
                releaseWebgpuChunkSet(activeWebgpuChunkSet)
            }
            const failedCartogramApi = cartogramApi
            try {
                if (failedCartogramApi === previousState.cartogramApi) {
                    failedCartogramApi?.restoreState(previousState.cartogramRenderState)
                } else {
                    failedCartogramApi?.destroy()
                }
            } catch (cartogramRestoreError) {
                console.error('Failed to restore previous cartogram', cartogramRestoreError)
            }
            activeH3Layer = previousState.activeH3Layer
            activeWebgpuChunkSet = previousState.activeWebgpuChunkSet
            activeH3Renderer = previousState.activeH3Renderer
            viewportQuantileState = previousState.viewportQuantileState
            h3DataRowLookup = previousState.h3DataRowLookup
            dataH3Res = previousState.dataH3Res
            cartogramInit = previousState.cartogramInit
            cartogramWeightsFile = previousState.cartogramWeightsFile
            cartogramRawCols = previousState.cartogramRawCols
            cartogramAgg = previousState.cartogramAgg
            cartoAggCols = previousState.cartoAggCols
            cartoRes = previousState.cartoRes
            h3toXY = previousState.h3toXY
            h3toXYPromise = previousState.h3toXYPromise
            cartogramApi = previousState.cartogramApi
            const cartogramVisibilityChanged = document.body.classList.contains('cartogram-ready') !== previousState.cartogramReady
            document.body.classList.toggle('cartogram-ready', previousState.cartogramReady)
            if (cartogramVisibilityChanged) requestAnimationFrame(() => map.resize())
            window._columnData = previousState.columnData
            window.raw_data = previousState.rawData
            deferLegend = false
            pendingLegend = null
            legendVersion++
            legendDiv.replaceChildren(...(previousState.legend ? [previousState.legend] : []))
            let requireRestoredDeckFrame = false
            try {
                if (activeWebgpuChunkSet && previousState.activeH3Renderer === 'webgpu') {
                    const restoredRenderer = await ensureH3Renderer()
                    if (restoredRenderer === 'webgpu') {
                        activeH3Renderer = 'webgpu'
                        await selectWebgpuChunks(activeWebgpuChunkSet, false)
                        activeWebgpuChunkSet.committed = true
                        mainLayers = []
                    } else {
                        const previousWebgpuSet = activeWebgpuChunkSet
                        releaseWebgpuChunkSet(previousWebgpuSet, null)
                        activeWebgpuChunkSet = null
                        activeH3Renderer = 'deck'
                        mainLayers = [createH3Layer(previousWebgpuSet.data, previousWebgpuSet.kind, previousWebgpuSet.valuekey)]
                        requireRestoredDeckFrame = true
                    }
                } else {
                    mainLayers = previousState.layers
                }
                await renderLayers(false, requireRestoredDeckFrame)
            } catch (restoreError) {
                console.error('Failed to restore previous renderer', restoreError)
                if (previousState.activeH3Renderer === 'deck') {
                    activeWebgpuChunkSet = null
                    activeH3Renderer = 'deck'
                    activeH3Layer = previousState.activeH3Layer
                    mainLayers = previousState.layers
                    try {
                        await renderLayers(false)
                    } catch (deckRestoreError) {
                        console.error('Failed to redraw previous deck renderer', deckRestoreError)
                    }
                } else {
                    activeWebgpuChunkSet = null
                    activeH3Renderer = 'failed'
                    mainLayers = []
                }
            } finally {
                webgpuCommitRunning = false
            }
            console.error(e)
            setLoadProgress(100, 'Load failed')
            loadProgress.complete = true
        }
    }

    const update = async () => {
        if (updateRunning) {
            updatePending = true
            return
        }
        updateRunning = true
        try {
            do {
                updatePending = false
                await updateOnce()
            } while (updatePending)
        } finally {
            updateRunning = false
            if (chunkSelectionPending) updateVisibleH3Chunks(true)
        }
    }

    window.d3 = d3
    window.observablehq = observablehq

    const l = document.getElementById("attribution")
    const extra_c = settings.c ? settings.c.split(",") : []
    if (showTrains) extra_c.push("OpenRailwayMap")
    l.innerText = "©\u00a0" + [...extra_c, "OpenFreeMap", "Natural Earth", "openwaters.io et al.", "Mapterhorn", "OpenStreetMap contributors", "Our World in Data", "GeoNames"].filter(x=>x !== null).join(" ©\u00a0")
    const legendDiv = document.createElement('div')
    legendDiv.id = "observable_legend"
    l.insertBefore(legendDiv, l.firstChild)
    let legendVersion = 0
    let deferLegend = false
    let pendingLegend = null
    // todo: read impressum from metadata too
    function replaceLegend(legend) {
        if (deferLegend) {
            pendingLegend = legend
            return
        }
        const previous = legendDiv.lastElementChild
        const version = ++legendVersion
        if (!previous || !COLOUR_TRANSITION_DURATION) {
            legendDiv.replaceChildren(legend)
            return
        }

        legend.style.opacity = 0
        legendDiv.append(legend)
        d3.select(legend).transition()
            .duration(COLOUR_TRANSITION_DURATION)
            .ease(d3.easeCubicInOut)
            .style('opacity', 1)
            .on('end', () => {
                if (version === legendVersion) legendDiv.replaceChildren(legend)
            })
    }

    function commitPendingLegend() {
        deferLegend = false
        if (!pendingLegend) return
        const legend = pendingLegend
        pendingLegend = null
        replaceLegend(legend)
    }

    async function makeLegend(fmt) {
        try {
            if (fmt !== undefined) {
                const legend = observablehq.legend({color: colourRamp, title: settings.t, tickFormat: v => parseFloat(fmt(v).toPrecision(2)).toLocaleString()})
                replaceLegend(legend)
            } else {
                const legend_options = {color: colourRamp, title: settings.t}
                if (settings.scale) {
                    const fmt = v => settings['scale'][Object.keys(settings['scale']).map(x => [x, Math.abs(x - v)]).sort((l,r)=>l[1] - r[1])[0][0]]
                    window.fmt = fmt
                    legend_options.tickFormat = fmt
                }
                const legend = observablehq.legend(legend_options)
                replaceLegend(legend)
            }
        } catch(e) {
            console.warn(e)
            const legend = observablehq.legend({color: colourRamp, title: settings.t})
            replaceLegend(legend)
        }
    }

    try {
        const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
        const host = window.location.hostname.includes(':') ? `[${window.location.hostname}]` : window.location.hostname
        const socket = new WebSocket(`${protocol}://${host}:1990`)
        let updateStarted = false
        let updateTimer = null
        const startUpdate = (delay = 0) => {
            updateStarted = true
            clearTimeout(updateTimer)
            updateTimer = setTimeout(() => {
                updateTimer = null
                update()
            }, delay)
        }
        const stopPerfTelemetry = () => {
            if (perfSocket === socket) perfSocket = null
            stopFrameRateTelemetry?.()
            stopFrameRateTelemetry = null
        }
        socket.addEventListener("error", () => {
            console.warn("WebSocket error, automatic updates disabled")
            stopPerfTelemetry()
            if (!updateStarted) startUpdate()
        })
        socket.addEventListener("open", () => {
            socket.send("ping")
            socket.send(`watch:${file_name}`)
            if (perfEnabled) perfSocket = socket
        })
        socket.addEventListener("message", (event) => {
            const message = String(event.data)
            if (message.startsWith("change") || message.startsWith("watching")) {
                startUpdate(100) // give file some time to be written
            } else if (message.startsWith("remove:") || message.startsWith("error:")) {
                stopPerfTelemetry()
            }
        })
        socket.addEventListener("close", stopPerfTelemetry)
    } catch (e) {
        console.warn("WebSocket unavailable, automatic updates disabled", e)
        update()
    }

    function fitCartogramToMapBounds(api = cartogramApi, h3map = h3toXY) {
        const fitStart = svgPerfEnabled ? now() : 0
        if (hex_flying) {
            syncLog('map->cartogram.skip_hex_flying')
            svgPerfLog('map->cartogram.fit.skip', {reason: 'hex_flying'})
            return
        }
        if (!h3map || !api) {
            syncLog('map->cartogram.skip_missing_state', {hasH3Map: !!h3map, hasApi: !!api})
            svgPerfLog('map->cartogram.fit.skip', {reason: 'missing_state', hasH3Map: !!h3map, hasApi: !!api})
            return
        }
        const bounds = map.getBounds()
        if (!bounds) {
            syncLog('map->cartogram.skip_no_bounds')
            svgPerfLog('map->cartogram.fit.skip', {reason: 'no_bounds'})
            return
        }
        const corners = [
            bounds.getNorthWest(),
            bounds.getNorthEast(),
            bounds.getSouthWest(),
            bounds.getSouthEast(),
        ]
        let xMin = Infinity, yMin = Infinity, xMax = -Infinity, yMax = -Infinity
        const cornerMatches = []
        for (const c of corners) {
            const h = latLngToCell(c.lat, c.lng, cartoRes)
            let pt = h3map.get(h)
            let fallback = false
            if (!pt) {
                pt = findClosestHex(c.lat, c.lng, h3map)
                fallback = true
            }
            if (!pt) continue
            const b = getH3Bounds(pt)
            cornerMatches.push({lat: c.lat, lng: c.lng, h, fallback, cells: h3EntryCellCount(pt), bounds: b})
            if (b.xMin < xMin) xMin = b.xMin
            if (b.yMin < yMin) yMin = b.yMin
            if (b.xMax > xMax) xMax = b.xMax
            if (b.yMax > yMax) yMax = b.yMax
        }
        if (xMin === Infinity) {
            syncLog('map->cartogram.skip_no_corner_matches', {mapBounds: bounds.toArray ? bounds.toArray() : null})
            svgPerfLog('map->cartogram.fit.skip', {reason: 'no_corner_matches', elapsedMs: now() - fitStart, mapBounds: bounds.toArray ? bounds.toArray() : null})
            return
        }
        const cartogramBounds = [[xMin, yMin, xMax, yMax]]
        syncLog('map->cartogram.fit.request', {
            mapBounds: bounds.toArray ? bounds.toArray() : null,
            cornerMatches,
            cartogramBounds,
        })
        svgPerfLog('map->cartogram.fit.compute', {
            elapsedMs: now() - fitStart,
            mapBounds: bounds.toArray ? bounds.toArray() : null,
            cornerMatches: cornerMatches.length,
            fallbackCorners: cornerMatches.filter(x => x.fallback).length,
            h3MapSize: h3map.size,
            cartogramBounds,
        })
        api.fitToBounds(cartogramBounds)
        svgPerfLog('map->cartogram.fit.call', {elapsedMs: now() - fitStart})
    }

    map.on('moveend', (event) => {
        updateVisibleH3Chunks?.(true)
        const original = event && event.originalEvent
        const originalInMap = eventStartedInMap(original)
        const programmaticSyncReason = mapProgrammaticSyncReason
        const shouldSyncCartogram = mapGestureMoved || originalInMap || !!programmaticSyncReason
        const movePerf = mapMovePerf
        mapMovePerf = null
        mapGestureStarted = false
        mapGestureMoved = false
        mapProgrammaticSyncReason = null
        clearTimeout(mapWheelResetTimer)
        if (event.keyboardMoving) return
        const pos = map.getCenter()
        const z = map.getZoom()
        history.replaceState(null, '', `#x=${pos.lng.toFixed(4)}&y=${pos.lat.toFixed(4)}&z=${z.toFixed(4)}`)
        syncLog('map.moveend', {
            originalEventType: original ? original.type : null,
            originalInMap,
            programmaticSyncReason,
            shouldSyncCartogram,
            hex_flying,
            center: {lng: pos.lng, lat: pos.lat},
            zoom: z,
        })
        if (svgPerfEnabled && movePerf) {
            svgPerfLog('map.moveend', {
                elapsedMs: now() - movePerf.startedAt,
                moves: movePerf.moves,
                startCenter: movePerf.startCenter,
                startZoom: movePerf.startZoom,
                originalEventType: original ? original.type : null,
                originalInMap,
                programmaticSyncReason,
                shouldSyncCartogram,
                cartogramEnabled,
                hasCartogramApi: !!cartogramApi,
                hex_flying,
                center: {lng: pos.lng, lat: pos.lat},
                zoom: z,
            })
        }
        updateViewportQuantiles('map')
        if (cartogramEnabled && shouldSyncCartogram) fitCartogramToMapBounds()
    })

    function upperBound(array, target) {
        let lo = 0
        let hi = array.length
        while (lo < hi) {
            const mid = (lo + hi) >> 1
            if (array[mid] > target) hi = mid
            else lo = mid + 1
        }
        return lo
    }

    function upperBoundClamped(array, target, min, max) {
        let lo = 0
        let hi = array.length
        while (lo < hi) {
            const mid = (lo + hi) >> 1
            const value = Math.min(Math.max(min, array[mid]), max)
            if (value > target) hi = mid
            else lo = mid + 1
        }
        return lo
    }

    function ecdf(array, trimFactor=0.01, weights=null) {
        const values = []
        const sampledWeights = weights ? [] : null
        const store = (rowIndex, sampleIndex, value = toFiniteNumber(columnValue(array, rowIndex))) => {
            if (value == null) return false
            values[sampleIndex] = value
            if (sampledWeights) {
                const weight = toFiniteNumber(columnValue(weights, rowIndex))
                sampledWeights[sampleIndex] = weight != null && weight >= 0 ? weight : 0
            }
            return true
        }
        const reservoirSample = () => {
            values.length = 0
            if (sampledWeights) sampledWeights.length = 0
            let validCount = 0
            for (let i = 0; i < array.length; i++) {
                const value = toFiniteNumber(columnValue(array, i))
                if (value == null) continue
                const sampleIndex = validCount < QUANTILE_SAMPLE_SIZE ? validCount : Math.floor(Math.random() * (validCount + 1))
                validCount++
                if (sampleIndex < QUANTILE_SAMPLE_SIZE) store(i, sampleIndex, value)
            }
        }

        if (array.length <= QUANTILE_SAMPLE_SIZE * 4) {
            reservoirSample()
        } else {
            const sampledRows = new Set()
            const maxAttempts = QUANTILE_SAMPLE_SIZE * 32
            let attempts = 0
            while (values.length < QUANTILE_SAMPLE_SIZE && sampledRows.size < array.length && attempts++ < maxAttempts) {
                const rowIndex = Math.floor(Math.random() * array.length)
                if (sampledRows.has(rowIndex)) continue
                sampledRows.add(rowIndex)
                store(rowIndex, values.length)
            }
            if (values.length < Math.min(QUANTILE_SAMPLE_SIZE / 2, array.length)) reservoirSample()
        }
        if (!values.length) return [() => null, () => null, 0]

        const unweighted = () => {
            values.sort((a, b) => a - b)
            return [
                target => {
                    const value = toFiniteNumber(target)
                    return value == null ? null : upperBound(values, value) / values.length
                },
                target => {
                    const quantile = toFiniteNumber(target)
                    if (quantile == null) return null
                    if (quantile < trimFactor) return values[0]
                    if (quantile >= 1 - trimFactor) return values[values.length - 1]
                    return values[Math.min(values.length - 1, Math.floor(quantile * values.length))]
                },
                values.length,
            ]
        }
        if (!sampledWeights) return unweighted()

        const pairs = values.map((value, i) => [value, sampledWeights[i]])
        pairs.sort((a, b) => a[0] - b[0])
        const sortedValues = new Array(pairs.length)
        const cumulativeWeights = new Float64Array(pairs.length)
        let maxWeight = 0
        for (const weight of sampledWeights) if (weight > maxWeight) maxWeight = weight
        if (!(maxWeight > 0)) return unweighted()
        let cumW = 0
        for (let i = 0; i < pairs.length; i++) {
            sortedValues[i] = pairs[i][0]
            cumW += pairs[i][1] / maxWeight
            cumulativeWeights[i] = cumW
        }
        for (let i = 0; i < cumulativeWeights.length; i++) cumulativeWeights[i] /= cumW

        return [
            target => {
                const value = toFiniteNumber(target)
                if (value == null) return null
                const index = upperBound(sortedValues, value)
                return index ? cumulativeWeights[index - 1] : 0
            },
            target => {
                const quantile = toFiniteNumber(target)
                return quantile == null ? null : (sortedValues[upperBoundClamped(cumulativeWeights, quantile, trimFactor, 1 - trimFactor)] ?? sortedValues[sortedValues.length - 1])
            },
            values.length,
        ]
    }
}
