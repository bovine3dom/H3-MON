import {MapboxOverlay} from '@deck.gl/mapbox'
import {H3HexagonLayer} from '@deck.gl/geo-layers'
import {CSVLoader} from '@loaders.gl/csv'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'

const map = new maplibregl.Map({
    container: 'map',
    style: 'https://api.maptiler.com/maps/toner-v2/style.json?key=Y4leWPnhJFGnTFFk1cru', // only authorised for localhost
    center: [0.45, 51.47],
    zoom: 4,
    bearing: 0,
    pitch: 0
})

const getHexData = () => new H3HexagonLayer({
    id: 'H3HexagonLayer',
    data: '/data/h3_data.csv',
    loaders: [CSVLoader],
    extruded: false,
    getHexagon: d => d.index,
    getFillColor: d => [255, d.value * 255, 0],
    getElevation: d => d.count,
    elevationScale: 20,
    pickable: true
})

const mapOverlay = new MapboxOverlay({
    interleaved: false,
})

map.addControl(mapOverlay)
map.addControl(new maplibregl.NavigationControl())
console.log(CSVLoader)

const update = () => mapOverlay.setProps({layers:[getHexData()]})
update()
setTimeout(update, 5000)
