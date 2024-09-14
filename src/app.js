import {MapboxOverlay} from '@deck.gl/mapbox'
import {MVTLayer} from '@deck.gl/geo-layers'
import {CSVLoader} from '@loaders.gl/csv'
import {load} from '@loaders.gl/core'
import maplibregl from 'maplibre-gl'
import * as d3 from 'd3'
import 'maplibre-gl/dist/maplibre-gl.css'
import * as observablehq from './vendor/observablehq' // from https://observablehq.com/@d3/color-legend

const start_pos = {...{x: 0.45, y: 51.47, z: 4}, ...Object.fromEntries(new URLSearchParams(window.location.hash.slice(1)))}
const map = new maplibregl.Map({
    container: 'map',
    style: 'https://api.maptiler.com/maps/toner-v2/style.json?key=Y4leWPnhJFGnTFFk1cru', // only authorised for localhost
    center: [start_pos.x, start_pos.y],
    zoom: start_pos.z,
    bearing: 0,
    pitch: 0
})

const colourRamp = d3.scaleSequential(d3.interpolateSpectral).domain([0,1])

/* convert from "rgba(r,g,b,a)" string to [r,g,b] */
const getColour = v => Object.values(d3.color(colourRamp(v))).slice(0,-1)
let reloadNum = 0
const getIrisData = csvmap => {
    return new MVTLayer({
    id: 'IrisLayer',
    minZoom: 0,
    maxZoom: 9,
    data: '/data/shapefiles/CONTOURS-IRIS_2-1_SHP_LAMB93_FXX-2020/tiles/{z}/{x}/{y}.pbf',
    extruded: false,
    stroked: true,
    getFillColor: d => {
        const v = csvmap.get(parseInt(d.properties.CODE_IRIS))
        return v == undefined ? [255, 255, 255, 0] : getColour(v)
    },
    pickable: true
})}

function getTooltip({object}) {
    const toDivs = kv => {
        return `<div>${kv[0]}: ${typeof(kv[1]) == "number" ? parseFloat(kv[1].toPrecision(3)) : kv[1]}</div>` // parseFloat is a hack to bin scientific notation
    }
    return object && {
        // html: `<div>${(object.value).toPrecision(2)}</div>`,
        html: Object.entries({...object.properties, percent_zero_voitures: csvmap.get(parseInt(object.properties.CODE_IRIS))}).map(toDivs).join(" "),
        style: {
            backgroundColor: '#fff',
            fontFamily: 'sans-serif',
            fontSize: '0.8em',
            padding: '0.5em',
            // fontColor: 'black',
        }
    }
}

const mapOverlay = new MapboxOverlay({
    interleaved: false,
    onClick: (info, event) => {
        if (info.layer) {
            console.log(info.object);
        }
    },
    getTooltip,
})

map.addControl(mapOverlay)
map.addControl(new maplibregl.NavigationControl())

let csvmap = new Map()
const update = async () => {
    const csvdata = (await load("/data/iris_data.csv", CSVLoader)).data
    csvmap = new Map(csvdata.map(r => [r.IRIS, r.perc_voit]))
    mapOverlay.setProps({layers:[getIrisData(csvmap)]})
}
update()


window.d3 = d3
window.observablehq = observablehq

const params = new URLSearchParams(window.location.search)
const l = document.getElementById("attribution")
l.innerText = "© " + ["INSEE", "MapTiler",  "OpenStreetMap contributors"].filter(x=>x !== null).join(" © ")
// todo: read impressum from metadata too
async function makeLegend() {
    try {
        const d = await (await fetch("/data/meta.json")).json()
        const fmt = v => d['scale'][Object.keys(d['scale']).map(x => [x, Math.abs(x - v)]).sort((l,r)=>l[1] - r[1])[0][0]]
        l.insertBefore(observablehq.legend({color: colourRamp, title: params.get('t'), tickFormat: fmt}), l.firstChild)
    } catch (e) {
        console.warn(e)
        l.insertBefore(observablehq.legend({color: colourRamp, title: params.get('t')}), l.firstChild)
    }
}
makeLegend()
map.on('moveend', () => {
    const pos = map.getCenter()
    const z = map.getZoom()
    window.location.hash = `x=${pos.lng}&y=${pos.lat}&z=${z}`
})
