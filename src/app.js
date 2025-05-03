import {MapboxOverlay} from '@deck.gl/mapbox'
import {H3HexagonLayer} from '@deck.gl/geo-layers'
import {CSVLoader} from '@loaders.gl/csv'
import {load} from '@loaders.gl/core'
import maplibregl from 'maplibre-gl'
import * as d3 from 'd3'
import 'maplibre-gl/dist/maplibre-gl.css'
import * as observablehq from './vendor/observablehq' // from https://observablehq.com/@d3/color-legend

let STYLE = ""
if (window.location.hostname == 'localhost'){
        STYLE = "https://api.maptiler.com/maps/toner-v2/style.json?key=Y4leWPnhJFGnTFFk1cru"
} else if (window.location.hostname == 'o.blanthorn.com')  {
        STYLE = "https://api.maptiler.com/maps/toner-v2/style.json?key=L7Sd3jHa1AR1dtyLCTgq"
} else {
        STYLE = "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json" // fall back to CARTO
}

const start_pos = {...{x: 0.45, y: 51.47, z: 4}, ...Object.fromEntries(new URLSearchParams(window.location.hash.slice(1)))}
const map = new maplibregl.Map({
    container: 'map',
    style: STYLE,
    center: [start_pos.x, start_pos.y],
    zoom: start_pos.z,
    bearing: 0,
    pitch: 0
})

const params = new URLSearchParams(window.location.search)
const file_name = `${params.has('data') ? params.get('data') : 'h3_data'}.csv`
const meta_name = `${params.has('data') ? params.get('data') : 'meta'}.json`
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
    // const getColour = v => [...Object.values(d3.color(colourRamp(v))).slice(0,-1), Math.sqrt(v)*255] // with v as alpha too
    let reloadNum = 0
    const getHexData = async () => {

        const doQuantiles = settings.raw == undefined
        const trimFactor = settings.trimFactor ? settings.trimFactor : 0.01
        const valuekey = doQuantiles ? "quantile" : "value"
        const raw_data = (await load(`${file_path}?v=${++reloadNum}`, CSVLoader)).data
        let data = raw_data
        if (doQuantiles) {
            const [getquantile, getvalue] = ecdf(raw_data.map(r => r.value), trimFactor)
            data = raw_data.map(o => {return {...o, quantile: getquantile(o.value)}})
            makeLegend(getvalue)
        } else {
            makeLegend()
        }

        return new H3HexagonLayer({
            id: 'H3HexagonLayer',
            data: data,
            extruded: false,
            stroked: false,
            getHexagon: d => d.index,
            getFillColor: d => getColour(d[valuekey]),
            getElevation: d => d[valuekey]*30,
            elevationScale: 20,
            pickable: true
        })
    }

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
        onClick: (info, event) => {
            if (info.layer && info.layer.id === 'H3HexagonLayer') {
                console.log('Clicked H3 index:', info.object.index);
            }
        },
        getTooltip,
    })

    map.addControl(mapOverlay)
    map.addControl(new maplibregl.NavigationControl())

    const update = () => {
        getHexData().then(x=>mapOverlay.setProps({layers:[x]}))
    }

    window.d3 = d3
    window.observablehq = observablehq

    const l = document.getElementById("attribution")
    const extra_c = settings.c ? settings.c.split(",") : []
    l.innerText = "© " + [...extra_c, "MapTiler",  "OpenStreetMap contributors"].filter(x=>x !== null).join(" © ")
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
                const d = await (await fetch("/data/meta.json")).json()
                const fmt = v => d['scale'][Object.keys(d['scale']).map(x => [x, Math.abs(x - v)]).sort((l,r)=>l[1] - r[1])[0][0]]
                window.fmt = fmt
                const legend = observablehq.legend({color: colourRamp, title: settings.t, tickFormat: fmt})
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
        const pos = map.getCenter()
        const z = map.getZoom()
        window.location.hash = `x=${pos.lng.toFixed(4)}&y=${pos.lat.toFixed(4)}&z=${z.toFixed(4)}`
    })

    function ecdf(array, trimFactor=0.01){
        const mini_array = Array.from({length: Math.min(8192, array.length)}, () => Math.floor(Math.random()*array.length)).map(i => array[i]).sort((l,r) => l-r) // sort() sorts alphabetically otherwise
        const quantile = mini_array.map((v, position) => position + 1).map(v => v/mini_array.length) // +=v to weight by number rather than position
        return [target => quantile[mini_array.findIndex(v => v > target)] ?? 1, target => (mini_array[quantile.findIndex(v => Math.min(Math.max(trimFactor,v),1-trimFactor) > target)] ?? mini_array.slice(-1)[0])] // function to get quantile from value and value from quantile, with fudging to exclude top/bottom 1% from legend
    }
}
