import {MapboxOverlay} from '@deck.gl/mapbox'
import {H3HexagonLayer, TileLayer} from '@deck.gl/geo-layers'
import {BitmapLayer, GeoJsonLayer} from '@deck.gl/layers'
import {CSVLoader} from '@loaders.gl/csv'
import {ArrowLoader} from '@loaders.gl/arrow'
import {ParquetWasmLoader} from '@loaders.gl/parquet'
import {load} from '@loaders.gl/core'
import maplibregl from 'maplibre-gl'
import * as d3 from 'd3'
import {cellToBoundary, cellToLatLng, latLngToCell, getResolution, cellToParent, cellToChildren} from 'h3-js'
import 'maplibre-gl/dist/maplibre-gl.css'
import * as observablehq from './vendor/observablehq' // from https://observablehq.com/@d3/color-legend
import {getCitiesStartsWith} from 'tiny-geocoder'
import perspective from '@perspective-dev/client'
import PERSPECTIVE_SERVER_WASM from "@perspective-dev/server/dist/wasm/perspective-server.wasm"
import PERSPECTIVE_CLIENT_WASM from "@perspective-dev/client/dist/wasm/perspective-js.wasm"
import {render_cartogram} from './cartogram'

const params = new URLSearchParams(window.location.search)
const perfEnabled = params.has('perf') && !['0', 'false', 'off', 'no'].includes((params.get('perf') || '').toLowerCase())
const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now())
function perfTimer(label, details) {
    if (!perfEnabled) return () => {}
    const start = now()
    return (extra) => {
        const elapsed = now() - start
        const merged = {...(details || {}), ...(extra || {})}
        if (Object.keys(merged).length) {
            console.info(`[perf] ${label}: ${elapsed.toFixed(1)}ms`, merged)
        } else {
            console.info(`[perf] ${label}: ${elapsed.toFixed(1)}ms`)
        }
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

function columnValue(column, i) {
    return column && typeof column.get === 'function' ? column.get(i) : column[i]
}

function columnLength(column) {
    return column ? column.length : 0
}

async function materializeArrowColumn(table, name, labelPrefix) {
    const column = table.getChild(name)
    if (!column) return null
    return measurePerf(`${labelPrefix}.${name}`, {rows: column.length}, () => column.toArray())
}

async function materializeArrowColumns(table, names, labelPrefix) {
    const cols = {}
    for (const name of names) {
        const column = await materializeArrowColumn(table, name, labelPrefix)
        if (column) cols[name] = column
    }
    return cols
}

function computeH3Bounds(indices) {
    let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180
    for (const idx of indices) {
        try {
            const boundary = cellToBoundary(idx, true)
            for (const [lat, lng] of boundary) {
                if (lat < minLat) minLat = lat
                if (lat > maxLat) maxLat = lat
                if (lng < minLng) minLng = lng
                if (lng > maxLng) maxLng = lng
            }
        } catch (e) {
            console.warn('Invalid H3 index:', idx, e)
        }
    }
    if (minLat === 90) return null
    return [[minLat, minLng], [maxLat, maxLng]]
}

let highlightLayer = null
let renderLayers = null
let hex_flying = false
let h3toXY = null
let cartogramApi = null
let cartoAggCols = null
let cartoRes = 5
let cartogramAgg = null
let cartogramRawCols = null
let h3toXYPromise = null

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

function toNumber(value) {
    return typeof value === 'bigint' ? Number(value) : value
}

function toStringValue(value) {
    return typeof value === 'bigint' ? value.toString() : String(value)
}

const XY_KEY_BASE = 1048576
function xyKey(x, y) {
    return Math.abs(y) < XY_KEY_BASE ? x * XY_KEY_BASE + y : `${x},${y}`
}

function buildCartogramAggregation(rawCols) {
    const rowCount = columnLength(rawCols.index)
    const done = perfTimer('cartogram.cells.precompute', {rows: rowCount})
    const cellByKey = new Map()
    const rowCell = new Uint32Array(rowCount)
    const x = []
    const y = []
    const code = []
    const label = []
    const index = []
    const codeCounts = []
    const labelCounts = []

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
            codeCounts.push(new Map())
            labelCounts.push(new Map())
        }
        rowCell[i] = cellIndex

        if (rawCols.code && rawCols.code[i] != null) addCount(codeCounts[cellIndex], toNumber(rawCols.code[i]) / 1000)
        if (rawCols.label && (!rawCols.label.isValid || rawCols.label.isValid(i))) {
            const labelValue = columnValue(rawCols.label, i)
            if (labelValue != null && labelValue !== '') addCount(labelCounts[cellIndex], labelValue)
        }
    }

    for (let i = 0; i < x.length; i++) {
        code.push(dominant(codeCounts[i]))
        label.push(dominant(labelCounts[i]))
        index.push('')
    }

    done({cells: x.length, strategy: 'numeric-xy-key'})
    return {
        h3ByRow: rawCols.index,
        weights: rawCols.weight_mean || rawCols.weight || null,
        rowCell,
        x,
        y,
        code,
        label,
        index,
    }
}

function buildH3ToXY(rawCols) {
    const rowCount = columnLength(rawCols.index)
    const doneIndex = perfTimer('cartogram.h3_to_xy.build', {rows: rowCount})
    const map = new Map()
    const indexParts = cartogramAgg ? Array.from({length: cartogramAgg.x.length}, () => []) : null
    for (let i = 0; i < rowCount; i++) {
        const hex = toStringValue(columnValue(rawCols.index, i))
        const x = toNumber(rawCols.x[i])
        const y = toNumber(rawCols.y[i])
        const existing = map.get(hex)
        if (existing) {
            existing.cells.push([x, y])
        } else {
            map.set(hex, {cells: [[x, y]]})
        }
        if (indexParts) indexParts[cartogramAgg.rowCell[i]].push(hex)
    }
    if (indexParts) {
        for (let i = 0; i < indexParts.length; i++) cartogramAgg.index[i] = indexParts[i].join(', ')
    }
    h3toXY = map
    doneIndex({uniqueH3: map.size, cellIndexes: !!indexParts})
    return map
}

async function ensureH3ToXY() {
    if (h3toXY) return h3toXY
    if (!cartogramRawCols) await cartogramInit
    if (!h3toXYPromise) h3toXYPromise = Promise.resolve().then(() => buildH3ToXY(cartogramRawCols))
    return h3toXYPromise
}

function hex(hexes, options = {}) {
    const {fit = false, padding = 200, highlight = true} = options
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
            getHexagon: d => d,
            getFillColor: [255, 0, 0, 255], // it'd be neat to colour by weight but it's a tiny bit tricky
            getLineColor: [0, 0, 0, 255], // doesn't seem to do anything?
            getLineWidth: 10,
            stroked: true,
            extruded: false,
            pickable: false,
        })
        renderLayers && renderLayers()
    }
    if (fit) {
        const bounds = computeH3Bounds(hexes)
        if (bounds) {
            hex_flying = true
            map.fitBounds(bounds, {padding})
            map.once('moveend', () => { hex_flying = false })
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
    let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity
    for (const [x, y] of entry.cells) {
        if (x < xMin) xMin = x
        if (x > xMax) xMax = x
        if (y < yMin) yMin = y
        if (y > yMax) yMax = y
    }
    return {xMin, xMax, yMin, yMax}
}

let perspectiveWorkerPromise = null
async function getPerspectiveWorker() {
    if (!perspectiveWorkerPromise) {
        perspective.init_server(fetch(PERSPECTIVE_SERVER_WASM))
        perspective.init_client(fetch(PERSPECTIVE_CLIENT_WASM))
        perspectiveWorkerPromise = perspective.worker()
    }
    const worker = await measurePerf('perspective.worker.ready', () => perspectiveWorkerPromise)
    window.ps = worker
    return worker
}

const cartogramInit = (async () => {
    const doneInit = perfTimer('cartogram.init.total')
    const arrow_resp = await measurePerf('cartogram.weights.fetch', () => fetch('data/cartogram_weights.arrow'))
    const arrow_buf = await measurePerf('cartogram.weights.arrayBuffer', () => arrow_resp.arrayBuffer())
    const rawTable = await parseArrowTable(arrow_buf, 'cartogram.weights.arrow_parse', {bytes: arrow_buf.byteLength})
    const rawCols = {
        x: await materializeArrowColumn(rawTable, 'x', 'cartogram.weights.column'),
        y: await materializeArrowColumn(rawTable, 'y', 'cartogram.weights.column'),
        code: await materializeArrowColumn(rawTable, 'code', 'cartogram.weights.column'),
        label: rawTable.getChild('label'),
        index: rawTable.getChild('index'),
        weight: await materializeArrowColumn(rawTable, 'weight', 'cartogram.weights.column'),
        weight_mean: await materializeArrowColumn(rawTable, 'weight_mean', 'cartogram.weights.column'),
    }
    cartoRes = getResolution(toStringValue(columnValue(rawCols.index, 0)))
    cartogramRawCols = rawCols
    cartogramAgg = buildCartogramAggregation(rawCols)
    doneInit({rows: columnLength(rawCols.index), cells: cartogramAgg.x.length, cartoRes})

    return {}
    // next steps:
    // 0) debug why on earth labels are showing up in multiple places even though they are unique in mapping.arrow. ditto for country borders?
    // 1) draw the cartogram in a new pane with borders
    // 3) link cartogram <-> map
    // (e.g. click on cartogram -> draw h3 that contribute to that cell * weight;
    // zoom/move cartogram -> zoom/move map based on bbox of cartogram ... might be worth pre-computing lat/lon?)
    // 2) aggregate actual data into the cartogram. your current spec is index: string, which is incompatible with the cartogram spec of h3: uint64. so fix that first. then join and profit
    // worth doing a smell test on index[0] to see if it is resolution 5. for now, reject all other resolutions and don't show the cartogram. (which implies also: don't load perspective)
    // probably easiest to demand strings in the input? but if we need to, "0x" + BigInt(h3s).toString(16) would work ... if perpsective doesn't support joins we are kind of buggered right?
    // worker.join() exists https://perspective-dev.github.io/browser/classes/dist_wasm_perspective-js.d.ts.Client.html#join
    // left - The left source table (a [Table] instance or a table name string).
    // right - The right source table (a [Table] instance or a table name string).
    // on - The column name to join on. Must exist in both tables with the same type.
    // options - Optional join configuration: { join_type?: "inner" | "left" | "outer", name?: string }.
    // 4) reduce duplication of effort: reuse quantiles, data. _probably_ best to use perspective's .to_arrow()?
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

const PARQUET_WASM_URL = './parquet_wasm_bg.wasm'

const FORMATS = {
    csv:     {loader: CSVLoader,      kind: 'row',    layer: 'hex'},
    arrow:   {loader: ArrowLoader,    kind: 'column', layer: 'hex'},
    parquet: {loader: ParquetWasmLoader, kind: 'column', layer: 'hex', loadOptions: {shape: 'columnar-table', parquet: {wasmUrl: PARQUET_WASM_URL}}},
    geojson: {kind: 'row',            layer: 'geojson'},
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

let humanMoved = false
window.addEventListener("hashchange", () => {
    if (humanMoved) {
        humanMoved = false
        return
    }
    const pos = Object.fromEntries(new URLSearchParams(window.location.hash.slice(1)))
    const longitude = pos.x ? pos.x : 0.45
    const latitude = pos.y ? pos.y : 51.47
    const zoom = pos.z ? pos.z : 4
    map.flyTo({
        center: [longitude, latitude],
        zoom: zoom,
        bearing: 0,
        pitch: 0
    })
})

const dataParam = params.get('data') || 'out_string_quantile.arrow'
// const dataParam = params.get('data') || 'h3_data'
const dotIdx = dataParam.lastIndexOf('.')
const ext = dotIdx >= 0 ? dataParam.slice(dotIdx + 1).toLowerCase() : 'csv'
const format = FORMATS[ext] || FORMATS.csv
if (!FORMATS[ext] && dotIdx >= 0) console.warn(`Unknown extension ".${ext}", falling back to csv`)
const file_name = dotIdx >= 0 ? dataParam : `${dataParam}.csv`
const base_name = dotIdx >= 0 ? dataParam.slice(0, dotIdx) : dataParam
const meta_name = `${base_name}.json`
fetch(`data/${meta_name}`).then(r => r.json()).then(meta => {
    bootstrap(meta)
}).catch(_ => {
    bootstrap()
})

function bootstrap(meta = {}){
    const settings = Object.assign({}, meta, Object.fromEntries(params.entries()))
    const doCyclical = settings.cyclical != undefined
    const flip = settings.flip != undefined
    const colourRamp = d3.scaleSequential(doCyclical ? d3.interpolateRainbow : d3.interpolateSpectral).domain(flip ? [1,0] : [0,1])
    const file_path = `data/${file_name}`
    if (settings.t) document.title = settings.t

    /* convert from "rgba(r,g,b,a)" string to [r,g,b] */
    const getColour = v => Object.values(d3.color(colourRamp(v))).slice(0,-1)

    function hexAccessors(kind, indexkey, valuekey, getColour) {
        if (kind === 'column') {
            return {
                getHexagon: (_, {index, data}) => data.src[indexkey][index],
                getFillColor: (_, {index, data, target}) => {
                    const v = data.src[valuekey][index]
                    const colour = getColour(v)
                    target[0] = 255*v
                    target[1] = 255*v
                    target[2] = 255*v
                    target[3] = 255
                    return colour
                }
            }
        }
        return {
            getHexagon: d => d.index,
            getFillColor: d => getColour(d[valuekey])
        }
    }

    function extractValues(raw, kind) {
        if (kind === 'column') return Array.from(raw.value)
        return raw.map(r => r.value)
    }

    function extractWeights(raw, kind) {
        if (kind === 'column') return raw.weight ? Array.from(raw.weight) : null
        return raw.length > 0 && raw[0].weight != null ? raw.map(r => r.weight) : null
    }

    function applyQuantiles(raw, kind, getquantile) {
        if (kind === 'column') {
            const quantiles = assignQuantiles(raw.value, getquantile)
            return {...raw, quantile: quantiles}
        }
        return raw.map(o => ({...o, quantile: getquantile(o.value)}))
    }

    function assignQuantiles(values, getquantile) {
        const quantiles = new Array(values.length)
        for (let i = 0; i < values.length; i++) quantiles[i] = getquantile(values[i])
        return quantiles
    }

    function getDefaultValue() {
        const defaultValue = settings.defaultValue ?? null // in metadata json, specify defaultValue for missing data aggregation into cartogram
        if (defaultValue == null || defaultValue === '' || defaultValue === 'null') return null
        const parsed = Number(defaultValue)
        return Number.isNaN(parsed) ? null : parsed
    }

    function groupCartogramWithMap(sourceCols, sourceValueKey, perfDetails = {}) {
        const doneGroup = perfTimer('cartogram.js_group.total', perfDetails)
        const defaultValue = getDefaultValue()
        const meanCol = sourceValueKey === 'quantile' ? 'quantile_mean' : 'value_mean'
        const sourceIndex = sourceCols.index
        const sourceValues = sourceCols[sourceValueKey]

        const sourceRows = columnLength(sourceIndex)
        const doneDataMap = perfTimer('cartogram.js_group.data_map', {rows: sourceRows})
        const valuesByH3 = new Map()
        for (let i = 0; i < sourceRows; i++) {
            valuesByH3.set(String(columnValue(sourceIndex, i)), columnValue(sourceValues, i))
        }
        doneDataMap({entries: valuesByH3.size})

        const cellCount = cartogramAgg.x.length
        const numerator = new Float64Array(cellCount)
        const denominator = new Float64Array(cellCount)
        const weights = cartogramAgg.weights
        const cartogramRows = columnLength(cartogramAgg.h3ByRow)
        const doneAccum = perfTimer('cartogram.js_group.accumulate', {rows: cartogramRows, cells: cellCount})
        for (let i = 0; i < cartogramRows; i++) {
            let value = valuesByH3.get(String(columnValue(cartogramAgg.h3ByRow, i)))
            if (value == null) value = defaultValue
            if (value == null) continue
            value = toNumber(value)
            const weight = weights ? toNumber(weights[i]) : 1
            if (weight == null) continue
            const cellIndex = cartogramAgg.rowCell[i]
            numerator[cellIndex] += value * weight
            denominator[cellIndex] += weight
        }
        doneAccum()

        const doneOutput = perfTimer('cartogram.js_group.output', {cells: cellCount})
        const values = new Array(cellCount)
        for (let i = 0; i < cellCount; i++) {
            values[i] = denominator[i] ? numerator[i] / denominator[i] : null
        }
        const aggCols = {
            x: cartogramAgg.x,
            y: cartogramAgg.y,
            _code: cartogramAgg.code,
            code: cartogramAgg.code,
            label: cartogramAgg.label,
            index: cartogramAgg.index,
            [meanCol]: values,
        }
        doneOutput()
        doneGroup({rows: cellCount, defaultValue})
        return {aggCols, meanCol}
    }

    let reloadNum = 0
    const getHexData = async () => {
        const doneGetHexData = perfTimer('data.reload.total', {file: file_name, ext, layer: format.layer})

        const doQuantiles = settings.raw == undefined
        const trimFactor = settings.trimFactor ? settings.trimFactor : 0.01
        const useCartogramQuantiles = settings.quantileSource === 'cartogram'

        if (format.layer === 'hex' && (ext === 'arrow' || ext === 'csv')) {
            const cartogramReady = measurePerf('cartogram.init.await', () => cartogramInit)
            const reload = ++reloadNum
            const resp = await measurePerf('data.fetch', {file: file_path, reload}, () => fetch(`${file_path}?v=${reload}`))
            const buf = await measurePerf(ext === 'csv' ? 'data.read_text' : 'data.read_arrayBuffer', () => ext === 'csv' ? resp.text() : resp.arrayBuffer())
            let userTable = null
            let dataCols
            let schema
            if (ext === 'arrow') {
                const dataTable = await parseArrowTable(buf, 'data.arrow_parse', {bytes: buf.byteLength})
                const fields = dataTable.schema.fields.map(f => f.name)
                dataCols = await materializeArrowColumns(dataTable, fields, 'data.arrow_column')
                schema = dataCols
            } else {
                const worker = await getPerspectiveWorker()
                userTable = await measurePerf('data.user_table', {bytes: buf.length}, () => worker.table(buf))
                schema = await measurePerf('data.schema', () => userTable.schema())
                const dataView = await measurePerf('data.view', () => userTable.view())
                dataCols = await measurePerf('data.to_columns', () => dataView.to_columns())
                dataView.delete()
            }

            const hasWeight = schema.hasOwnProperty('weight')

            if (dataCols.index.length && String(dataCols.index[0]).startsWith('0')) {
                const doneIndexNormalize = perfTimer('data.index_normalize', {rows: dataCols.index.length})
                dataCols.index = dataCols.index.map(h => String(h).slice(1))
                doneIndexNormalize()
            }

            const values = dataCols.value
            const weights = hasWeight ? dataCols.weight : null
            let valuekey = 'value'
            let getvalueFn

            if (doQuantiles && !useCartogramQuantiles) {
                const doneEcdf = perfTimer('data.quantile.ecdf', {rows: values.length, weighted: !!weights})
                const [getquantile, getvalue] = ecdf(values, trimFactor, weights)
                doneEcdf()
                getvalueFn = getvalue
                const doneQuantileAssign = perfTimer('data.quantile.assign', {rows: values.length})
                dataCols.quantile = assignQuantiles(values, getquantile)
                doneQuantileAssign()
                valuekey = 'quantile'
                makeLegend(getvalueFn)
            } else if (!doQuantiles) {
                makeLegend()
            }

            window._columnData = dataCols
            window.raw_data = dataCols
            let deckLayer

            if (!useCartogramQuantiles || !doQuantiles) {
                const doneDeckLayer = perfTimer('deck.hex_layer.create', {rows: dataCols.value.length})
                const accessors = hexAccessors('column', 'index', valuekey, getColour)
                const dataWrap = {src: dataCols, length: dataCols.value.length}
                deckLayer = new H3HexagonLayer({
                    id: 'H3HexagonLayer', data: dataWrap,
                    extruded: false, stroked: false, ...accessors, elevationScale: 20, pickable: true
                })
                doneDeckLayer()
            }

            if (schema.hasOwnProperty('index')) {
                await cartogramReady
                const firstIndex = dataCols.index[0]
                const h3res = getResolution(String(firstIndex))

                cartoAggCols = null
                let cartoDataCol = null

                if (h3res === cartoRes) {
                    const result = groupCartogramWithMap(dataCols, valuekey, {source: 'same-resolution', rows: dataCols.index.length})
                    cartoAggCols = result.aggCols
                    cartoDataCol = result.meanCol
                } else if (h3res > cartoRes) {
                    const defaultValue = getDefaultValue()
                    const worker = await getPerspectiveWorker()
                    const h3map = await ensureH3ToXY()
                    const cartoH3s = Array.from(h3map.keys())
                    const doneChildPairs = perfTimer('cartogram.child_pairs.build', {cartoH3s: cartoH3s.length, cartoRes, h3res})
                    const childPairs = cartoH3s.flatMap(h =>
                        cellToChildren(h, h3res).map(child => ({child, cartoH3: h}))
                    )
                    doneChildPairs({rows: childPairs.length})
                    const childTable = await measurePerf('cartogram.child_table', {rows: childPairs.length}, () => worker.table(childPairs))
                    const dataSubset = {child: dataCols.index, [valuekey]: dataCols[valuekey]}
                    const dataTable = await measurePerf('cartogram.child_data_table', {rows: dataCols.index.length}, () => worker.table(dataSubset))
                    const joined = await measurePerf('cartogram.child_join', {childRows: childPairs.length, dataRows: dataCols.index.length}, () => worker.join(childTable, dataTable, 'child', {join_type: 'left'}))
                    const fillExpr = {["_" + valuekey]: `coalesce("${valuekey}", float(${defaultValue}))`}
                    const groupView = await measurePerf('cartogram.child_group.view', () => joined.view({
                        expressions: fillExpr,
                        columns: ['cartoH3', "_" + valuekey],
                        aggregates: {["_" + valuekey]: 'mean', "cartoH3": 'first'},
                        group_by: ['cartoH3'],
                        group_rollup_mode: 'flat'
                    }))
                    const grouped = await measurePerf('cartogram.child_group.to_columns', () => groupView.to_columns())
                    groupView.delete()
                    joined.delete()
                    childTable.delete()
                    dataTable.delete()
                    const doneChildGroupNormalize = perfTimer('cartogram.child_group.normalize', {rows: grouped.cartoH3.length})
                    delete grouped.__ROW_PATH__
                    grouped.index = grouped.cartoH3
                    delete grouped.cartoH3
                    grouped[valuekey] = grouped["_" + valuekey]
                    delete grouped["_" + valuekey]
                    doneChildGroupNormalize()
                    const result = groupCartogramWithMap(grouped, valuekey, {source: 'child-rollup', rows: grouped.index.length})
                    cartoAggCols = result.aggCols
                    cartoDataCol = result.meanCol
                }

                if (cartoAggCols) {
                    const h3map = await measurePerf('cartogram.h3_to_xy.await_render', () => ensureH3ToXY())

                    if (useCartogramQuantiles && doQuantiles) {
                        const cartoValues = cartoAggCols[cartoDataCol]
                        const doneCartoEcdf = perfTimer('cartogram.quantile.ecdf', {rows: cartoValues.length})
                        const [getquantile, getvalue] = ecdf(cartoValues, trimFactor)
                        doneCartoEcdf()
                        getvalueFn = getvalue
                        const doneDataQuantiles = perfTimer('cartogram.quantile.assign_data', {rows: values.length})
                        dataCols.quantile = assignQuantiles(values, getquantile)
                        doneDataQuantiles()
                        const doneCartoQuantiles = perfTimer('cartogram.quantile.assign_cartogram', {rows: cartoValues.length})
                        cartoAggCols['carto_quantile'] = assignQuantiles(cartoValues, getquantile)
                        doneCartoQuantiles()
                        cartoDataCol = 'carto_quantile'
                        valuekey = 'quantile'
                        makeLegend(getvalueFn)
                    }

                    if (!cartogramApi) {
                        const doneRenderCartogram = perfTimer('cartogram.render.call', {rows: cartoAggCols.x.length})
                        cartogramApi = render_cartogram('#cartogram', cartoAggCols, {
                            perf: perfEnabled,
                            draw_outline: false,
                            get_color: z => colourRamp(z) ?? 'rgba(255,255,255,0)',
                            include_outer_borders: true,
                            data_col: cartoDataCol,
                            onclick_callback: (data, event, i) => {
                                if (cartogramApi) cartogramApi.highlightCells([])
                                if (data.index && data.index[i]) {
                                    hex(data.index[i].split(", ").filter(x => x))
                                }
                            },
                            onmove_callback: ((() => {
                                const t = 1000
                                let last = 0, timer = null, lastArgs
                                function fire(data, visibleIndices) {
                                    if (data.index) {
                                        hex(visibleIndices.flatMap(i => data.index[i] ? data.index[i].split(", ").filter(x => x) : []), {fit: true, padding: 0, highlight: false})
                                    }
                                }
                                return (data, visibleIndices) => {
                                    lastArgs = [data, visibleIndices]
                                    const now = Date.now()
                                    if (now - last >= t) { last = now; clearTimeout(timer); timer = null; fire(...lastArgs) }
                                    else if (!timer) { timer = setTimeout(() => { timer = null; last = Date.now(); fire(...lastArgs) }, t - (now - last)) }
                                }
                            }))()
                        })
                        doneRenderCartogram()
                        fitCartogramToMapBounds(cartogramApi, h3map)
                    } else {
                        const doneUpdateCartogram = perfTimer('cartogram.update.call', {rows: cartoAggCols.x.length})
                        cartogramApi.highlightCells([])
                        cartogramApi.updateData(cartoAggCols, cartoDataCol)
                        doneUpdateCartogram()
                    }
                    document.body.classList.add('cartogram-ready')
                }
            }

            if (!cartoAggCols && useCartogramQuantiles && doQuantiles) {
                const doneEcdf = perfTimer('data.quantile.ecdf', {rows: values.length, weighted: !!weights, fallback: 'no-cartogram'})
                const [getquantile, getvalue] = ecdf(values, trimFactor, weights)
                doneEcdf()
                getvalueFn = getvalue
                const doneQuantileAssign = perfTimer('data.quantile.assign', {rows: values.length, fallback: 'no-cartogram'})
                dataCols.quantile = assignQuantiles(values, getquantile)
                doneQuantileAssign()
                valuekey = 'quantile'
                makeLegend(getvalueFn)
            }

            if (!deckLayer) {
                const doneDeckLayer = perfTimer('deck.hex_layer.create', {rows: dataCols.value.length})
                const accessors = hexAccessors('column', 'index', valuekey, getColour)
                const dataWrap = {src: dataCols, length: dataCols.value.length}
                deckLayer = new H3HexagonLayer({
                    id: 'H3HexagonLayer', data: dataWrap,
                    extruded: false, stroked: false, ...accessors, elevationScale: 20, pickable: true
                })
                doneDeckLayer()
            }

            if (userTable) userTable.delete()
            doneGetHexData({rows: dataCols.value.length, cartogramRows: cartoAggCols ? cartoAggCols.x.length : 0})
            return deckLayer
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

        if (raw && raw.batches && raw.schema) {
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
        } else {
            data = raw
            makeLegend()
        }

        if (format.layer === 'hex') {
            const accessors = hexAccessors(format.kind, 'index', valuekey, getColour)
            const dataWrap = format.kind === 'column'
                ? {src: data, length: data.value.length}
                : data
            if (format.kind === 'column') window._columnData = data
            const rows = format.kind === 'column' ? data.value.length : data.length
            const doneDeckLayer = perfTimer('deck.hex_layer.create', {rows})
            const layer = new H3HexagonLayer({
                id: 'H3HexagonLayer',
                data: dataWrap,
                extruded: false,
                stroked: false,
                ...accessors,
                elevationScale: 20,
                pickable: true
            })
            doneDeckLayer()
            doneGetHexData({rows})
            return layer
        }

        if (format.layer === 'geojson') {
            const randomColour = () => [Math.random()*255, Math.random()*255, Math.random()*255, 200]
            const getColor = f => {
                const v = valuekey === 'quantile' ? f.properties?.quantile : (f.properties?.value ?? f.value ?? f.properties?.val)
                return v != null ? getColour(v) : randomColour()
            }
            const doneGeoJsonLayer = perfTimer('deck.geojson_layer.create', {rows: data.features.length})
            const layer = new GeoJsonLayer({
                id: 'GeoJsonLayer',
                data: data,
                filled: true,
                stroked: true,
                getFillColor: getColor,
                getLineColor: f => { const rgb = getColor(f); return [...rgb.slice(0,3), 255] },
                getLineWidth: 1000,
                lineWidthMinPixels: 1,
                lineJointRounded: true,
                lineCapRounded: true,
                lineWidthMaxPixels: 4,
                lineWidthUnits: 'meters',
                lineBillboard: true,
                pickable: true
            })
            doneGeoJsonLayer()
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

    function getTooltip({object, index}) {
        if (index < 0) return null
        let row
        if (window._columnData) {
            row = Object.fromEntries(
                Object.keys(window._columnData).filter(k => k !== 'quantile').map(k => [k, window._columnData[k][index]])
            )
        } else if (object && object.type === 'Feature') {
            row = object.properties || {}
        } else if (object) {
            row = object
        } else {
            return null
        }
        const fmtVal = v => {
            if (v == null) return ''
            if (typeof v === 'number') return parseFloat(v.toPrecision(3)).toLocaleString()
            if (typeof v === 'object') return JSON.stringify(v)
            return v
        }
        const toDivs = kv => `<div>${kv[0]}: ${fmtVal(kv[1])}</div>`
        return {
            html: Object.entries(row).filter(([,v]) => v != null && v !== '').map(toDivs).join(" "),
            style: {
                backgroundColor: '#fff',
                fontFamily: 'sans-serif',
                fontSize: '0.8em',
                padding: '0.5em',
            }
        }
    }

    const mapOverlay = new MapboxOverlay({
        interleaved: false,
        onClick: async (info, event) => {
            if (info.layer && info.layer.id === 'H3HexagonLayer' && info.index >= 0 && window._columnData) {
                const h3Index = window._columnData.index[info.index]
                hex([h3Index], {fit: false, highlight: true})
                const res = getResolution(h3Index)
                const parent = res === cartoRes ? h3Index : cellToParent(h3Index, cartoRes)
                const h3map = await ensureH3ToXY()
                const xy = h3map ? h3map.get(parent) : null
                if (xy && cartogramApi && cartoAggCols) {
                    const cellSet = new Set(xy.cells.map(([x, y]) => `${x},${y}`))
                    const rowIndices = []
                    for (let i = 0; i < cartoAggCols.x.length; i++) {
                        if (cellSet.has(`${cartoAggCols.x[i]},${cartoAggCols.y[i]}`)) {
                            rowIndices.push(i)
                        }
                    }
                    if (rowIndices.length > 0) {
                        cartogramApi.highlightCells(rowIndices)
                        const b = getH3Bounds(xy)
                        const padding = 20
                        cartogramApi.fitToBounds([[b.xMin - padding, b.yMin - padding, b.xMax + padding, b.yMax + padding]])
                    }
                }
            }
        },
        getTooltip,
        // // experimental stuff to improve perf on mobile
        // _pickable: false,
        // _typedArrayManagerProps: {overAlloc: 1, poolSize: 0},
    })

    map.addControl(mapOverlay)
    map.addControl(new maplibregl.NavigationControl())

    const searchInput = document.getElementById('city-search')
    const resultsDiv = document.getElementById('city-results')
    let highlightedIdx = -1

    function selectCity(div) {
        if (!div) return
        const lat = parseFloat(div.dataset.lat)
        const lng = parseFloat(div.dataset.lng)
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

    renderLayers = () => {
        const layers = [...mainLayers]
        if (highlightLayer) layers.push(highlightLayer)
        if (settings.trains) {
            layers.push(choochoo)
        }
        const doneSetLayers = perfTimer('deck.set_layers', {layers: layers.length})
        mapOverlay.setProps({layers})
        doneSetLayers()
    }

    const update = () => {
        getHexData().then(x => {
            mainLayers = [x]
            renderLayers()
        })
    }

    window.d3 = d3
    window.observablehq = observablehq

    const l = document.getElementById("attribution")
    const extra_c = settings.c ? settings.c.split(",") : []
    if (settings.trains) extra_c.push("OpenRailwayMap")
    l.innerText = "©\u00a0" + [...extra_c, "OpenFreeMap", "Natural Earth", "GEBCO", "Mapterhorn", "OpenStreetMap contributors"].filter(x=>x !== null).join(" ©\u00a0")
    const legendDiv = document.createElement('div')
    legendDiv.id = "observable_legend"
    l.insertBefore(legendDiv, l.firstChild)
    // todo: read impressum from metadata too
    async function makeLegend(fmt) {
        try {
            if (fmt !== undefined) {
                const legend = observablehq.legend({color: colourRamp, title: settings.t, tickFormat: v => parseFloat(fmt(v).toPrecision(2)).toLocaleString()})
                legendDiv.innerHTML = ""
                legendDiv.insertBefore(legend, legendDiv.firstChild)
            } else {
                const legend_options = {color: colourRamp, title: settings.t}
                if (settings.scale) {
                    const fmt = v => settings['scale'][Object.keys(settings['scale']).map(x => [x, Math.abs(x - v)]).sort((l,r)=>l[1] - r[1])[0][0]]
                    window.fmt = fmt
                    legend_options.tickFormat = fmt
                }
                const legend = observablehq.legend(legend_options)
                legendDiv.innerHTML = ""
                legendDiv.insertBefore(legend, legendDiv.firstChild)
            }
        } catch(e) {
            console.warn(e)
            const legend = observablehq.legend({color: colourRamp, title: settings.t})
            legendDiv.innerHTML = ""
            legendDiv.insertBefore(legend, legendDiv.firstChild)
        }
    }


    const socket = new WebSocket(`ws://${window.location.hostname}:1990`)
    socket.addEventListener("error", (event) => {
        console.warn("WebSocket error, automatic updates disabled")
        update()
    })
    socket.addEventListener("open", (event) => {
        socket.send("ping")
        socket.send(`watch:${file_name}`)
    })
    // Update whenever you get a message (even if the message is "do not update")
    // nb: this means that the "pong" message is important
    socket.addEventListener("message", (event) => {
        console.log("Message from server:", event.data)
        if (event.data.startsWith("change") || event.data.startsWith("watching")) {
            setTimeout(update, 100) // give file some time to be written
        }
    })

    function fitCartogramToMapBounds(api = cartogramApi, h3map = h3toXY) {
        if (hex_flying) return
        if (!h3map || !api) return
        const bounds = map.getBounds()
        if (!bounds) return
        const corners = [
            bounds.getNorthWest(),
            bounds.getNorthEast(),
            bounds.getSouthWest(),
            bounds.getSouthEast(),
        ]
        let xMin = Infinity, yMin = Infinity, xMax = -Infinity, yMax = -Infinity
        for (const c of corners) {
            const h = latLngToCell(c.lat, c.lng, cartoRes)
            let pt = h3map.get(h)
            if (!pt) pt = findClosestHex(c.lat, c.lng, h3map)
            if (!pt) continue
            const b = getH3Bounds(pt)
            if (b.xMin < xMin) xMin = b.xMin
            if (b.yMin < yMin) yMin = b.yMin
            if (b.xMax > xMax) xMax = b.xMax
            if (b.yMax > yMax) yMax = b.yMax
        }
        if (xMin === Infinity) return
        api.fitToBounds([[xMin, yMin, xMax, yMax]])
    }

    map.on('moveend', () => {
        humanMoved = true
        const pos = map.getCenter()
        const z = map.getZoom()
        history.replaceState(null, '', `#x=${pos.lng.toFixed(4)}&y=${pos.lat.toFixed(4)}&z=${z.toFixed(4)}`)
        fitCartogramToMapBounds()
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
        const valid = []
        const validWeights = []
        for (let i = 0; i < array.length; i++) {
            if (array[i] != null) {
                valid.push(array[i])
                if (weights) validWeights.push(weights[i])
            }
        }
        const sampleSize = Math.min(8192, valid.length)
        if (sampleSize === 0) return [() => null, () => null]
        const indices = Array.from({length: sampleSize}, () => Math.floor(Math.random()*valid.length))
        const pairs = indices.map(i => [valid[i], validWeights.length ? validWeights[i] : 1])
        pairs.sort((a, b) => a[0] - b[0])
        const mini_array = pairs.map(([v]) => v)
        const sortedWeights = pairs.map(([, w]) => w)
        let cumW = 0
        const totalW = sortedWeights.reduce((s, w) => s + w, 0)
        const quantile = sortedWeights.map(w => { cumW += w; return cumW / totalW })
        
        return [
            target => target == null ? null : quantile[upperBound(mini_array, target)] ?? 1,
            target => target == null ? null : (mini_array[upperBoundClamped(quantile, target, trimFactor, 1 - trimFactor)] ?? mini_array[mini_array.length - 1])
        ]
    }
}
