import {MapboxOverlay} from '@deck.gl/mapbox'
import {H3HexagonLayer} from '@deck.gl/geo-layers'
import {CSVLoader} from '@loaders.gl/csv'
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
// const getColour = v => [...Object.values(d3.color(colourRamp(v))).slice(0,-1), Math.sqrt(v)*255] // with v as alpha too
let reloadNum = 0
const getHexData = () => new H3HexagonLayer({
    id: 'H3HexagonLayer',
    data: `/data/h3_data.csv?v=${++reloadNum}`,
    loaders: [CSVLoader],
    extruded: false,
    stroked: false,
    getHexagon: d => d.index,
    getFillColor: d => getColour(d.value),
    getElevation: d => (1-d.value)*1000,
    elevationScale: 20,
    pickable: true
})

function getTooltip({object}) {
    const toDivs = kv => {
        return `<div>${kv[0]}: ${typeof(kv[1]) == "number" ? parseFloat(kv[1].toPrecision(3)) : kv[1]}</div>` // parseFloat is a hack to bin scientific notation
    }
    return object && {
        // html: `<div>${(object.value).toPrecision(2)}</div>`,
        html: Object.entries(object).map(toDivs).join(" "),
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
    // onClick: (info, event) => {
    //     if (info.layer && info.layer.id === 'H3HexagonLayer') {
    //         console.log('Clicked H3 index:', info.object.index);
    //     }
    // },
    getTooltip,
})

map.addControl(mapOverlay)
map.addControl(new maplibregl.NavigationControl())

const update = () => {
    mapOverlay.setProps({layers:[getHexData()]})
}
update()

window.d3 = d3
window.observablehq = observablehq

const params = new URLSearchParams(window.location.search)
const l = document.getElementById("attribution")
l.innerText = "© " + [params.get('c'), "MapTiler",  "OpenStreetMap contributors"].filter(x=>x !== null).join(" © ")
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


try {
    const socket = new WebSocket("ws://localhost:1990")
    socket.addEventListener("open", (event) => {
        socket.send("ping")
    })
    // Update whenever you get a message (even if the message is "do not update")
    socket.addEventListener("message", (event) => {
        setTimeout(update, 100) // give file some time to be written
        console.log("Message from server:", event.data)
    })
} catch (e) {
    // fall back to polling
    console.log("Warning: websocket failed " + e + ", falling back to poll")
    const update2 = () => {
        update()
        return setTimeout(update2, 5000)
    }
    update2()
}

map.on('moveend', () => {
    const pos = map.getCenter()
    const z = map.getZoom()
    window.location.hash = `x=${pos.lng}&y=${pos.lat}&z=${z}`
})
