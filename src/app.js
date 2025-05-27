import {MapboxOverlay} from '@deck.gl/mapbox'
import {H3HexagonLayer, TileLayer} from '@deck.gl/geo-layers'
import {BitmapLayer} from '@deck.gl/layers'
import {CSVLoader} from '@loaders.gl/csv'
import {ArrowLoader} from '@loaders.gl/arrow'
import {load, parse} from '@loaders.gl/core'
import maplibregl from 'maplibre-gl'
import * as d3 from 'd3'
import 'maplibre-gl/dist/maplibre-gl.css'
import * as observablehq from './vendor/observablehq' // from https://observablehq.com/@d3/color-legend

window.load = load
window.parse = parse
window.ArrowLoader = ArrowLoader

let STYLE = ""
if (window.location.hostname == 'localhost'){
        STYLE = "https://api.maptiler.com/maps/toner-v2/style.json?key=Y4leWPnhJFGnTFFk1cru"
} else if (window.location.hostname == 'o.blanthorn.com')  {
        STYLE = "https://api.maptiler.com/maps/toner-v2/style.json?key=L7Sd3jHa1AR1dtyLCTgq"
} else {
        STYLE = "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json" // fall back to CARTO
}


// ok so one gotcha is that Uint arrays are weird - ensure everything is float64
const username = window.prompt("Enter ClickHouse username:")
const password = window.prompt("Enter ClickHouse password:")

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

let lastcalled = performance.now() - 1000
const params = new URLSearchParams(window.location.search)
// const file_name = `${params.has('data') ? params.get('data') : 'h3_data'}.csv`
// const meta_name = `${params.has('data') ? params.get('data') : 'meta'}.json`
// fetch(`data/${meta_name}`).then(r => r.json()).then(meta => {
//     bootstrap(meta)
// }).catch(_ => {
    bootstrap()
// })

function bootstrap(meta = {}){
    let requestNum = 0
    const settings = Object.assign({}, meta, Object.fromEntries(params.entries()))
    const doCyclical = settings.cyclical != undefined
    const flip = settings.flip != undefined
    const colourRamp = d3.scaleSequential(doCyclical ? d3.interpolateRainbow : d3.interpolateSpectral).domain(flip ? [1,0] : [0,1])
    const table_name = settings.table_name ? settings.table_name : "transitous_pop_within_60"
    const variable = settings.variable ? settings.variable : "pop_in_60"
    const ch = settings.ch ? settings.ch : "http://localhost:8123"
    const conditions = settings.conditions ? settings.conditions.split(",").map(c => c.split(":").reduce((l,r) => `${l} = '${r}'`)).join(" and ") : "true"
    // const file_path = `data/${file_name}`
    if (settings.t) document.title = settings.t

    /* convert from "rgba(r,g,b,a)" string to [r,g,b] */
    const getColour = v => Object.values(d3.color(colourRamp(v))).slice(0,-1)
    // const getColour = v => [...Object.values(d3.color(colourRamp(v))).slice(0,-1), Math.sqrt(v)*255] // with v as alpha too
    let reloadNum = 0
    const getHexData = async () => {

        const doQuantiles = settings.raw == undefined
        const trimFactor = settings.trimFactor ? settings.trimFactor : 0.01
        const valuekey = doQuantiles ? "quantile" : "value"
        const pos = map.getCenter()
        const bounds = map.getBounds()
        const south = bounds.getSouth()
        const north = bounds.getNorth()
        const west = bounds.getWest()
        const east = bounds.getEast()
        //  round(n / (10^(floor(log10(n))-1))) * (10^(floor(log10(n)) - 1))
        // const arrow_data = await parse(fetch(`${ch}/?query=
        //     with
        //     ${east} as east,
        //     ${west} as west,
        //     ${south} as south,
        //     ${north} as north,
        //     (
        //     select toUInt8(argMin(number, abs(geoDistance(east, south, west, north)/h3EdgeLengthM(toUInt8(number)) - 400))) from numbers(4, 11-4)
        //     ) as best_res
        //     select lower(right(hex(h3), -1)) index, round(percent_rank() over (order by q50 asc),2) value, round(q50 / exp10(floor(log10(q50) - 1))) * exp10(floor(log10(q50) - 1)) actual_value from (
        //         select median(${variable}) q50, geoToH3(lon, lat, best_res) h3
        //         from ${table_name}
        //         where true
        //         and lon between ${west - (east-west)} and ${east + (east-west)}
        //         and lat between ${south - (north-south)} and ${north + (north-south)}
        //         and ${conditions}
        //         group by h3
        //     )
        //     order by value
        //     format arrow settings output_format_arrow_compression_method = 'none'
        // `, {headers: new Headers({'Authorization': `Basic ${btoa(username+':'+password)}`})}), ArrowLoader)
        // window.arrow_data = arrow_data
        
        const arrow_data = await parse(await fetch(`http://localhost:50075/isochrone?x=${pos.lng}&y=${pos.lat}&t=1`), ArrowLoader)
        lastcalled = performance.now()
        window.arrow_data = arrow_data

        // return []

        // sack off quantile for now
        // if (doQuantiles) {
        //     const [getquantile, getvalue] = ecdf(arrow_data.data.value, trimFactor)
        //     data = raw_data.map(o => {return {...o, quantile: getquantile(o.value)}})
        //     makeLegend(getvalue)
        // } else {
        makeLegend()
        // }

        return new H3HexagonLayer({
            id: 'H3HexagonLayer',
            data: {src: arrow_data.data, length: arrow_data.data.value.length},
            extruded: false,
            stroked: false,
            getHexagon: (_, {index, data}) => data.src.index[index],
            getFillColor: (_, {index, data}) => getColour(data.src.value[index]),
            pickable: true
        })
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
        // // need to write our own tooltip etc for binary data
        // onClick: (info, event) => {
        //     if (info.layer && info.layer.id === 'H3HexagonLayer') {
        //         console.log('Clicked H3 index:', info.object);
        //     }
        // },
        // getTooltip,
        // // experimental stuff to improve perf on mobile
        // _pickable: false,
        // _typedArrayManagerProps: {overAlloc: 1, poolSize: 0},
    })

    map.addControl(mapOverlay)
    map.addControl(new maplibregl.NavigationControl())

    const update = () => {
        // only make request if more than 10ms since previous
        if ((performance.now() - lastcalled) < 50) {
            return
        }
        requestNum += 1
        const ourUpdate = requestNum
        getHexData().then(x=>{
            if (requestNum != ourUpdate) return
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
    l.innerText = "©\u00a0" + [...extra_c, "MapTiler",  "OpenStreetMap contributors"].filter(x=>x !== null).join(" ©\u00a0")
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
                // if (settings.scale) {
                    // const fmt = v => settings['scale'][Object.keys(settings['scale']).map(x => [x, Math.abs(x - v)]).sort((l,r)=>l[1] - r[1])[0][0]]
                    const d = window.arrow_data.data.actual_value
                    const l = d.length
                    const fmt = v => {
                        const val = d[Math.max(Math.min(Math.floor(l * v), l-1), 0)]
                        return val ? val.toLocaleString() : "0"
                    }
                    window.fmt = fmt
                    legend_options.tickFormat = fmt
                // }
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


    // try {
    //     const socket = new WebSocket(`ws://${window.location.hostname}:1990`)
    //     socket.addEventListener("open", (event) => {
    //         socket.send("ping")
    //         socket.send(`watch:${file_name}`)
    //     })
    //     // Update whenever you get a message (even if the message is "do not update")
    //     // nb: this means that the "pong" message is important
    //     socket.addEventListener("message", (event) => {
    //         console.log("Message from server:", event.data)
    //         if (event.data.startsWith("change") || event.data.startsWith("watching")) {
    //             setTimeout(update, 100) // give file some time to be written
    //         }
    //     })
    // } catch (e) {
    //     // // fall back to polling
    //     // // not sure i actually want to do this, it seems like a bad idea
    //     // console.log("Warning: websocket failed " + e + ", falling back to poll")
    //     // const update2 = () => {
    //     //     update()
    //     //     return setTimeout(update2, 5000)
    //     // }
    //     // update2()
    // }

    map.on('move', () => {
        update()
    })

    map.on('moveend', () => {
        humanMoved = true
        const pos = map.getCenter()
        const z = map.getZoom()
        window.location.hash = `x=${pos.lng.toFixed(4)}&y=${pos.lat.toFixed(4)}&z=${z.toFixed(4)}`
    })

    function ecdf(array, trimFactor=0.01){
        const mini_array = Array.from({length: Math.min(8192, array.length)}, () => Math.floor(Math.random()*array.length)).map(i => array[i]).sort((l,r) => l-r) // sort() sorts alphabetically otherwise
        const quantile = mini_array.map((v, position) => position + 1).map(v => v/mini_array.length) // +=v to weight by number rather than position
        return [target => quantile[mini_array.findIndex(v => v > target)] ?? 1, target => (mini_array[quantile.findIndex(v => Math.min(Math.max(trimFactor,v),1-trimFactor) > target)] ?? mini_array.slice(-1)[0])] // function to get quantile from value and value from quantile, with fudging to exclude top/bottom 1% from legend
    }
    
    update()
}

window.opensatellitemap = () => {
	const pos = Object.fromEntries(new URLSearchParams(window.location.hash.slice(1)))
	return window.open(`https://www.google.com/maps/@?api=1&map_action=map&center=${pos.y}%2C${pos.x}&zoom=${Math.ceil(pos.z)}&basemap=satellite`, "", "popup")
}

// bind to ctrl+m
window.addEventListener("keydown", e => {
    if (e.ctrlKey && e.key == "m") {
        window.opensatellitemap()
    }
})
