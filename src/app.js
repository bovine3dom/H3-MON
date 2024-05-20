import {MapboxOverlay} from '@deck.gl/mapbox'
import {H3HexagonLayer} from '@deck.gl/geo-layers'
import {CSVLoader} from '@loaders.gl/csv'
import maplibregl from 'maplibre-gl'
import * as d3 from 'd3'
import 'maplibre-gl/dist/maplibre-gl.css'

const map = new maplibregl.Map({
    container: 'map',
    style: 'https://api.maptiler.com/maps/toner-v2/style.json?key=Y4leWPnhJFGnTFFk1cru', // only authorised for localhost
    center: [0.45, 51.47],
    zoom: 4,
    bearing: 0,
    pitch: 0
})

const colourRamp = d3.scaleSequential(d3.interpolateSpectral).domain([0,1])

/* convert from "rgba(r,g,b,a)" string to [r,g,b] */
const getColour = v => Object.values(d3.color(colourRamp(v))).slice(0,-1)
let reloadNum = 0
const getHexData = () => new H3HexagonLayer({
    id: 'H3HexagonLayer',
    data: `/data/h3_data.csv?v=${++reloadNum}`,
    loaders: [CSVLoader],
    extruded: false,
    getHexagon: d => d.index,
    getFillColor: d => getColour(d.value),
    getElevation: d => (1-d.value)*1000,
    elevationScale: 20,
    pickable: true
})

const mapOverlay = new MapboxOverlay({
    interleaved: false,
})

map.addControl(mapOverlay)
map.addControl(new maplibregl.NavigationControl())

const update = () => {
    mapOverlay.setProps({layers:[getHexData()]})
}
update()

window.d3 = d3

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
