import {MapboxOverlay} from '@deck.gl/mapbox'
import {H3HexagonLayer} from '@deck.gl/geo-layers'
import {CSVLoader} from '@loaders.gl/csv'
import maplibregl from 'maplibre-gl'
import * as d3 from 'd3'
import 'maplibre-gl/dist/maplibre-gl.css'
import * as observablehq from './vendor/observablehq' // from https://observablehq.com/@d3/color-legend
import * as aq from 'arquero'
import * as h3 from 'h3-js'

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
// const getColour = v => Object.values(d3.color(colourRamp(v))).slice(0,-1)
const getColour = v => [...Object.values(d3.color(colourRamp(v))).slice(0,-1), Math.sqrt(v)*255] // with v as alpha too
let reloadNum = 0
const getHexData = (dfo) => new H3HexagonLayer({
    id: 'H3HexagonLayer',
    data: dfo,
    extruded: false,
    stroked: false,
    getHexagon: d => d.index,
    getFillColor: d => getColour(d.value),
    getElevation: d => (1-d.value)*1000,
    elevationScale: 20,
    pickable: true
})


const getHighlightData = (df) => new H3HexagonLayer({
    id: 'selectedHex',
    data: df.objects(),
    extruded: false,
    stroked: false,
    getHexagon: d => d.index,
    getFillColor: d => [0, 255, 0, 100],
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
// df.derive({h3_5: aq.escape(d => h3.cellToParent(d.index, 5))}).groupby('h3_5').rollup({value: d => ag.op.mean(d.value)}).objects() // todo: aggregate at sensible zoom level. with some occlusion culling? aq.addFunction is roughly just as slow so don't bother

const mapOverlay = new MapboxOverlay({
    interleaved: false,
    onClick: (info, event) => {
        if (info.layer && info.layer.id === 'H3HexagonLayer') {
            console.log('Clicked H3 index:', info.object.index)
            let radius = 15  // todo make a nice slider etc
            let filterTable = aq.table({index: h3.gridDisk(info.object.index, radius)})
            let dt = df.semijoin(filterTable, 'index')
            dt = dt.orderby('real_value').derive({cumsum: aq.rolling(d => op.sum(d.real_value))}) // get cumulative sum
                .derive({quantile: d => d.cumsum / op.sum(d.real_value)}) // normalise to get quantiles
                .derive({median_dist: d => aq.op.abs(d.quantile - 0.5)}) // get distance to median
                .orderby('median_dist') // sort by it
            window.dt = dt
            console.log(`Approx median density at radius ${h3.getHexagonEdgeLengthAvg(h3.getResolution(dt.get('index', 0)), 'km') * 2 * radius + 1} km:`, dt.get('real_value', 0))
            console.log("Approx population: ", dt.rollup({total: d => aq.op.mean(d.real_value)}).get('total') * dt.size * h3.getHexagonAreaAvg(h3.getResolution(dt.get('index', 0)), 'km2'))
            mapOverlay.setProps({layers:[getHexData(dfo), getHighlightData(dt)]})
            // hexagon diameter = 2x edge length => distance k -> 1 + k*edge_length*2
            // agrees with tom forth pop around point numbers :D
            // maybe worth swapping to https://human-settlement.emergency.copernicus.eu/ghs_pop2023.php anyway

        }
    },
    getTooltip,
})

map.addControl(mapOverlay)
map.addControl(new maplibregl.NavigationControl())

const what2grab = () => {
    let res, disk
    const z = Math.floor(map.getZoom())
    if (z < 5) {
        res = 5
        disk = 15
    } else if (z < 8) {
        res = 7
        disk = 10
    } else if (z < 100) {
        res = 9
        disk = 1
    }
    return {res, disk}
}

let PARENTS = []
const update = async () => {
    const pos = map.getCenter()
    const g = what2grab()
    const s = h3.gridDisk(h3.latLngToCell(pos.lat,pos.lng,3), g.disk)
    if (PARENTS.sort().join() == s.sort().join()) {
        return
    }
    PARENTS = s

    // TODO: suppress 404 errors
    Promise.allSettled(s.map(i => aq.loadArrow(`/data/JRC_POPULATION_2018_H3_by_rnd/res=${g.res}/h3_3=${i}/part0.arrow`))).then(a => a.filter(x => x.status == "fulfilled")).then(a => a.map(x=>x.value)).then(a => a[0].concat(a.slice(1))).then(df => {window.df = df; window.dfo = df.objects(); mapOverlay.setProps({layers:[getHexData(dfo)]})})
}
update()

window.d3 = d3
window.observablehq = observablehq
window.aq = aq
window.h3 = h3
window.update = update

// aq.loadCSV('/data/h3_data.csv').then(x => window.df = x)

const params = new URLSearchParams(window.location.search)
const l = document.getElementById("attribution")
l.innerText = "© " + [params.get('c'), "MapTiler",  "OpenStreetMap contributors"].filter(x=>x !== null).join(" © ")
l.insertBefore(observablehq.legend({color: colourRamp, title: params.get('t')}), l.firstChild)

map.on('moveend', () => {
    const pos = map.getCenter()
    const z = map.getZoom()
    window.location.hash = `x=${pos.lng}&y=${pos.lat}&z=${z}`
    setTimeout(x => {
        const npos = map.getCenter()
        if ((pos.lng == npos.lng) && (pos.lat == npos.lat)) {
            console.log("updating")
            update() // todo: only update if parents have changed
        }
    }, 1000)
})

// data storage: probably big enough that hetzner might get sad? should be able to stick on backblaze b2 and proxy via cloudflare to get free egress https://www.backblaze.com/docs/cloud-storage-deliver-public-backblaze-b2-content-through-cloudflare-cdn . from the end of that guide should be able to make cloudflare host the whole thing actually
