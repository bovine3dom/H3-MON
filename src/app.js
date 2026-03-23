import {MapboxOverlay} from '@deck.gl/mapbox'
import {H3HexagonLayer, TileLayer} from '@deck.gl/geo-layers'
import {BitmapLayer, GeoJsonLayer} from '@deck.gl/layers'
import {CSVLoader} from '@loaders.gl/csv'
import {ArrowLoader} from '@loaders.gl/arrow'
import {ParquetWasmLoader} from '@loaders.gl/parquet'
import {load} from '@loaders.gl/core'
import maplibregl from 'maplibre-gl'
import * as d3 from 'd3'
import 'maplibre-gl/dist/maplibre-gl.css'
import * as observablehq from './vendor/observablehq' // from https://observablehq.com/@d3/color-legend

const PARQUET_WASM_URL = './parquet_wasm_bg.wasm'

const FORMATS = {
    csv:     {loader: CSVLoader,      kind: 'row',    layer: 'hex'},
    arrow:   {loader: ArrowLoader,    kind: 'column', layer: 'hex'},
    parquet: {loader: ParquetWasmLoader, kind: 'column', layer: 'hex', loadOptions: {shape: 'columnar-table', parquet: {wasmUrl: PARQUET_WASM_URL}}},
    geojson: {kind: 'row',            layer: 'geojson'},
    json:    {kind: 'row',            layer: 'geojson'},
}

//const STYLE = "http://localhost:1983/toner_ofm_moderatlist.json"
const STYLE = "https://compute.olie.science/fahrtle/toner_ofm_moderatlist.json"

const start_pos = {...{x: 0.45, y: 51.47, z: 4}, ...Object.fromEntries(new URLSearchParams(window.location.hash.slice(1)))}
const map = new maplibregl.Map({
    container: 'map',
    style: STYLE,
    center: [start_pos.x, start_pos.y],
    zoom: start_pos.z,
    bearing: 0,
    pitch: 0
})

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
const dataParam = params.get('data') || 'h3_data'
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
            for (const field of fields) {
                columnar[field] = []
            }
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
        if (doQuantiles && format.layer === 'hex') {
            const values = extractValues(raw, format.kind)
            const weights = extractWeights(raw, format.kind)
            const [getquantile, getvalue] = ecdf(values, trimFactor, weights)
            data = applyQuantiles(raw, format.kind, getquantile)
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
                const v = f.properties?.value ?? f.value ?? f.properties?.val
                return v != null ? getColour(v) : randomColour()
            }
            return new GeoJsonLayer({
                id: 'GeoJsonLayer',
                data: data,
                filled: true,
                stroked: true,
                getFillColor: getColor,
                getLineColor: [255, 255, 255, 100],
                getLineWidth: 1,
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
        if (format.kind === 'column' && window._columnData) {
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
            if (info.layer && info.layer.id === 'H3HexagonLayer') {
                console.log('Clicked H3 index:', info.object.index);
            }
        },
        getTooltip,
        // // experimental stuff to improve perf on mobile
        // _pickable: false,
        // _typedArrayManagerProps: {overAlloc: 1, poolSize: 0},
    })

    map.addControl(mapOverlay)
    map.addControl(new maplibregl.NavigationControl())

    const update = () => {
        getHexData().then(x=>{
            const layers = []
            layers.push(x)
            if (settings.trains) {
                layers.push(choochoo)
            }
            mapOverlay.setProps({layers})
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
        window.location.hash = `x=${pos.lng.toFixed(4)}&y=${pos.lat.toFixed(4)}&z=${z.toFixed(4)}`
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
