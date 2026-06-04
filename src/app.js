import {MapboxOverlay} from '@deck.gl/mapbox'
import {H3HexagonLayer, TileLayer} from '@deck.gl/geo-layers'
import {BitmapLayer, GeoJsonLayer} from '@deck.gl/layers'
import {CSVLoader} from '@loaders.gl/csv'
import {ArrowLoader} from '@loaders.gl/arrow'
import {ParquetWasmLoader} from '@loaders.gl/parquet'
import {load} from '@loaders.gl/core'
import maplibregl from 'maplibre-gl'
import * as d3 from 'd3'
import {cellToBoundary, cellToLatLng, latLngToCell, getResolution, cellToParent} from 'h3-js'
import 'maplibre-gl/dist/maplibre-gl.css'
import * as observablehq from './vendor/observablehq' // from https://observablehq.com/@d3/color-legend
import {getCitiesStartsWith} from 'tiny-geocoder'
import perspective from '@perspective-dev/client'
import PERSPECTIVE_SERVER_WASM from "@perspective-dev/server/dist/wasm/perspective-server.wasm"
import PERSPECTIVE_CLIENT_WASM from "@perspective-dev/client/dist/wasm/perspective-js.wasm"
import {render_cartogram} from './cartogram'

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

function findClosestHex(targetLat, targetLng) {
    let best = null
    let bestDist = Infinity
    for (const pt of h3toXY.values()) {
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

perspective.init_server(fetch(PERSPECTIVE_SERVER_WASM))
perspective.init_client(fetch(PERSPECTIVE_CLIENT_WASM))

const ps = perspective.worker()

const cartogramInit = (async () => {
    const worker = await ps
    const arrow_resp = await fetch('data/cartogram.arrow')
    const cartogram_table = await worker.table(await arrow_resp.arrayBuffer())

    const rawView = await cartogram_table.view({columns: ['index', 'x', 'y']})
    const rawCols = await rawView.to_columns()
    rawView.delete()
    cartoRes = getResolution(rawCols.index[0])
    h3toXY = new Map()
    for (let i = 0; i < rawCols.index.length; i++) {
        const hex = rawCols.index[i]
        const x = rawCols.x[i]
        const y = rawCols.y[i]
        const existing = h3toXY.get(hex)
        if (existing) {
            existing.cells.push([x, y])
        } else {
            const [lat, lng] = cellToLatLng(hex)
            h3toXY.set(hex, {cells: [[x, y]], lat, lng})
        }
    }

    return {worker, cartogram_table}
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
})()

const PARQUET_WASM_URL = './parquet_wasm_bg.wasm'

const FORMATS = {
    csv:     {loader: CSVLoader,      kind: 'row',    layer: 'hex'},
    arrow:   {loader: ArrowLoader,    kind: 'column', layer: 'hex'},
    parquet: {loader: ParquetWasmLoader, kind: 'column', layer: 'hex', loadOptions: {shape: 'columnar-table', parquet: {wasmUrl: PARQUET_WASM_URL}}},
    geojson: {kind: 'row',            layer: 'geojson'},
}

//const STYLE = "http://localhost:1983/toner_ofm_moderatlist.json"
const STYLE = {version: 8, sources: {
    basemap: {type: 'geojson', data: 'ne_basemap/basemap.geojson'}
}, layers: [
    {id: 'background', type: 'background', paint: {'background-color': '#e8f4f8'}},
    //{id: 'basemap-fill', type: 'fill', source: 'basemap', paint: {'fill-color': '#f5f5f5'}},
    {id: 'basemap-outline', type: 'line', source: 'basemap', paint: {'line-color': '#000', 'line-width': 2}},
], glyphs: 'https://fonts.openmaptiles.org/{fontstack}/{range}.pbf'}

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

const toggleBtn = document.getElementById('toggle-pane')
const mql = window.matchMedia('(orientation: portrait)')
const isPortrait = () => mql.matches
const setPane = (open) => {
    document.body.classList.toggle('pane-open', open)
    toggleBtn.textContent = isPortrait() ? (open ? '˄' : '˅') : (open ? '‹' : '›')
    toggleBtn.setAttribute('aria-label', open ? 'Close side pane' : 'Open side pane')
    requestAnimationFrame(() => map.resize())
}
setPane(true)
toggleBtn.addEventListener('click', () => setPane(!document.body.classList.contains('pane-open')))
mql.addEventListener('change', () => setPane(document.body.classList.contains('pane-open')))
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

const params = new URLSearchParams(window.location.search)
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
            const quantiles = Array.from(raw.value).map(getquantile)
            return {...raw, quantile: quantiles}
        }
        return raw.map(o => ({...o, quantile: getquantile(o.value)}))
    }

    let reloadNum = 0
    const getHexData = async () => {

        const doQuantiles = settings.raw == undefined
        const trimFactor = settings.trimFactor ? settings.trimFactor : 0.01

        if (format.layer === 'hex' && (ext === 'arrow' || ext === 'csv')) {
            const {worker, cartogram_table} = await cartogramInit
            const resp = await fetch(`${file_path}?v=${++reloadNum}`)
            const buf = ext === 'csv' ? await resp.text() : await resp.arrayBuffer()
            const userTable = await worker.table(buf)
            const schema = await userTable.schema()

            const hasWeight = schema.hasOwnProperty('weight')
            const viewCols = ['index', 'value']
            if (hasWeight) viewCols.push('weight')
            const dataView = await userTable.view({columns: viewCols})
            const dataCols = await dataView.to_columns()
            dataView.delete()

            if (dataCols.index.length && String(dataCols.index[0]).startsWith('0')) {
                dataCols.index = dataCols.index.map(h => String(h).slice(1))
            }

            const values = dataCols.value
            const weights = hasWeight ? dataCols.weight : null
            let valuekey = 'value'
            let getvalueFn

            if (doQuantiles) {
                const [getquantile, getvalue] = ecdf(values, trimFactor, weights)
                getvalueFn = getvalue
                dataCols.quantile = values.map(v => getquantile(v))
                valuekey = 'quantile'
                makeLegend(getvalueFn)
            } else {
                makeLegend()
            }

            window._columnData = dataCols
            window.raw_data = dataCols
            const accessors = hexAccessors('column', 'index', valuekey, getColour)
            const dataWrap = {src: dataCols, length: dataCols.value.length}
            const deckLayer = new H3HexagonLayer({
                id: 'H3HexagonLayer', data: dataWrap,
                extruded: false, stroked: false, ...accessors, elevationScale: 20, pickable: true
            })

            if (schema.hasOwnProperty('index')) {
                const firstIndex = dataCols.index[0]
                const h3res = getResolution(String(firstIndex))

                cartoAggCols = null
                let cartoDataCol = null

                if (h3res === cartoRes) {
                    const hasPopulation = schema.hasOwnProperty('population')
                    const enhancedTable = await worker.table(dataCols)
                    const joinedTable = await worker.join(cartogram_table, enhancedTable, 'index')
                    const expressions = {'_code': '"code"/1000'}
                    const aggregates = {'_code': 'dominant', 'label': 'dominant', 'x': 'first', 'y': 'first', 'index': 'join'}
                    const columns = ['x', 'y', '_code', 'label', 'index']
                    const meanCol = valuekey === 'quantile' ? 'quantile_mean' : 'value_mean'

                    if (hasWeight) {
                        expressions[meanCol] = `"weight" * "${valuekey}"`
                    } else {
                        expressions[meanCol] = `"${valuekey}"`
                    }
                    aggregates[meanCol] = 'mean'
                    columns.push(meanCol)

                    if (hasWeight && hasPopulation) {
                        expressions.wp = '"weight" * "population" / (150000 * 2)'
                        aggregates.wp = 'sum'
                        columns.push('wp')
                    }

                    const aggView = await joinedTable.view({expressions, columns, aggregates, group_by: ['x', 'y'], group_rollup_mode: 'flat'})
                    const aggCols = await aggView.to_columns()
                    aggView.delete()

                    aggCols.code = aggCols._code
                    cartoAggCols = aggCols
                    cartoDataCol = meanCol

                    joinedTable.delete()
                    enhancedTable.delete()
                } else if (h3res > cartoRes) {
                    const hasPopulation = schema.hasOwnProperty('population')
                    dataCols.parent = dataCols.index.map(h => cellToParent(h, cartoRes))

                    const aggExpr = {}
                    const aggAgg = {'parent': 'first'}
                    const aggCols2 = ['parent']
                    const parentMeanCol = valuekey === 'quantile' ? 'quantile_mean' : 'value_mean'

                    if (hasWeight) {
                        aggExpr[parentMeanCol] = `"weight" * "${valuekey}"`
                    } else {
                        aggExpr[parentMeanCol] = `"${valuekey}"`
                    }
                    aggAgg[parentMeanCol] = 'mean'
                    aggCols2.push(parentMeanCol)

                    if (hasWeight && hasPopulation) {
                        aggExpr.wp = '"weight" * "population" / (150000 * 2)'
                        aggAgg.wp = 'sum'
                        aggCols2.push('wp')
                    }

                    const parentTable = await worker.table(dataCols)
                    const groupView = await parentTable.view({expressions: aggExpr, columns: aggCols2, aggregates: aggAgg, group_by: ['parent'], group_rollup_mode: 'flat'})
                    const grouped = await groupView.to_columns()
                    groupView.delete()
                    parentTable.delete()

                    delete grouped.__ROW_PATH__
                    grouped.index = grouped.parent
                    delete grouped.parent
                    delete dataCols.parent

                    const enhancedTable = await worker.table(grouped)
                    const joinedTable = await worker.join(cartogram_table, enhancedTable, 'index')
                    const expressions = {'_code': '"code"/1000'}
                    const aggregates = {'_code': 'dominant', 'label': 'dominant', 'x': 'first', 'y': 'first', 'index': 'join'}
                    const columns = ['x', 'y', '_code', 'label', 'index']

                    aggregates[parentMeanCol] = 'mean'
                    columns.push(parentMeanCol)

                    if (hasWeight && hasPopulation) {
                        aggregates.wp = 'sum'
                        columns.push('wp')
                    }

                    const aggView = await joinedTable.view({expressions, columns, aggregates, group_by: ['x', 'y'], group_rollup_mode: 'flat'})
                    const aggCols = await aggView.to_columns()
                    aggView.delete()

                    aggCols.code = aggCols._code
                    cartoAggCols = aggCols
                    cartoDataCol = parentMeanCol

                    joinedTable.delete()
                    enhancedTable.delete()
                }

                if (cartoAggCols) {
                    if (!cartogramApi) {
                        cartogramApi = render_cartogram('#cartogram', cartoAggCols, {
                            draw_outline: false,
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
                    } else {
                        cartogramApi.highlightCells([])
                        cartogramApi.updateData(cartoAggCols, cartoDataCol)
                    }
                    document.body.classList.add('cartogram-ready')
                }
            }

            userTable.delete()
            return deckLayer
        }

        let loaded
        if (format.layer === 'geojson') {
            const resp = await fetch(`${file_path}?v=${++reloadNum}`)
            loaded = {data: await resp.json()}
        } else {
            loaded = await load(`${file_path}?v=${++reloadNum}`, format.loader, format.loadOptions)
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
            const [getquantile, getvalue] = ecdf(values, trimFactor, weights)
            if (format.layer === 'hex') {
                data = applyQuantiles(raw, format.kind, getquantile)
            } else {
                // assign quantile to each feature
                data = {
                    ...raw,
                    features: raw.features.map(f => ({...f, properties: {...f.properties, quantile: getquantile(f.properties?.value ?? f.value ?? f.properties?.val)}}))
                }
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
            return new H3HexagonLayer({
                id: 'H3HexagonLayer',
                data: dataWrap,
                extruded: false,
                stroked: false,
                ...accessors,
                elevationScale: 20,
                pickable: true
            })
        }

        if (format.layer === 'geojson') {
            const randomColour = () => [Math.random()*255, Math.random()*255, Math.random()*255, 200]
            const getColor = f => {
                const v = valuekey === 'quantile' ? f.properties?.quantile : (f.properties?.value ?? f.value ?? f.properties?.val)
                return v != null ? getColour(v) : randomColour()
            }
            return new GeoJsonLayer({
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
        onClick: (info, event) => {
            if (info.layer && info.layer.id === 'H3HexagonLayer' && info.index >= 0 && window._columnData) {
                const h3Index = window._columnData.index[info.index]
                hex([h3Index], {fit: false, highlight: true})
                const res = getResolution(h3Index)
                const parent = res === cartoRes ? h3Index : cellToParent(h3Index, cartoRes)
                const xy = h3toXY ? h3toXY.get(parent) : null
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
        map.flyTo({center: [lng, lat], zoom: 10})
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
        mapOverlay.setProps({layers})
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


    try {
        const socket = new WebSocket(`ws://${window.location.hostname}:1990`)
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
    } catch (e) {
        // // fall back to polling
        // // not sure i actually want to do this, it seems like a bad idea
        // console.log("Warning: websocket failed " + e + ", falling back to poll")
        // const update2 = () => {
        //     update()
        //     return setTimeout(update2, 5000)
        // }
        // update2()
    }

    map.on('moveend', () => {
        humanMoved = true
        const pos = map.getCenter()
        const z = map.getZoom()
        history.replaceState(null, '', `#x=${pos.lng.toFixed(4)}&y=${pos.lat.toFixed(4)}&z=${z.toFixed(4)}`)
        if (hex_flying) return
        const h3map = h3toXY
        const api = cartogramApi
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
            if (!pt) pt = findClosestHex(c.lat, c.lng)
            if (!pt) continue
            const b = getH3Bounds(pt)
            if (b.xMin < xMin) xMin = b.xMin
            if (b.yMin < yMin) yMin = b.yMin
            if (b.xMax > xMax) xMax = b.xMax
            if (b.yMax > yMax) yMax = b.yMax
        }
        if (xMin === Infinity) return
        api.fitToBounds([[xMin, yMin, xMax, yMax]])
    })

    function ecdf(array, trimFactor=0.01, weights=null) {
        const sampleSize = Math.min(8192, array.length)
        const indices = Array.from({length: sampleSize}, () => Math.floor(Math.random()*array.length))
        const pairs = indices.map(i => [array[i], weights ? weights[i] : 1])
        pairs.sort((a, b) => a[0] - b[0])
        const mini_array = pairs.map(([v]) => v)
        const sortedWeights = pairs.map(([, w]) => w)
        let cumW = 0
        const totalW = sortedWeights.reduce((s, w) => s + w, 0)
        const quantile = sortedWeights.map(w => { cumW += w; return cumW / totalW })
        
        return [target => quantile[mini_array.findIndex(v => v > target)] ?? 1, target => (mini_array[quantile.findIndex(v => Math.min(Math.max(trimFactor,v),1-trimFactor) > target)] ?? mini_array.slice(-1)[0])]
    }
}
