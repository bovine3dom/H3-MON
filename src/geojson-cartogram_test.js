import {aggregateGeoJSONCartogram, geoJSONFeatureBounds} from './geojson-cartogram.js'

const geojson = {
    type: 'FeatureCollection',
    features: [
        {type: 'Feature', properties: {id: 'FEATURE-A', value: 10}, geometry: {type: 'Polygon', coordinates: [[[-2, -1], [-1, -1], [-1, 0], [-2, 0], [-2, -1]]]}},
        {type: 'Feature', properties: {id: 'FEATURE-B', value: 30}, geometry: {type: 'Polygon', coordinates: [[[3, 4], [5, 4], [5, 6], [3, 6], [3, 4]]]}},
    ],
}

Deno.test('GeoJSON values aggregate onto cartogram cells with target weights', () => {
    const {cartogram, links} = aggregateGeoJSONCartogram(geojson, {
        source_id: ['FEATURE-A', 'FEATURE-B', 'FEATURE-A'],
        x: [0, 0, 2],
        y: [0, 0, 2],
        code: [250, 250, 250],
        weight_mean: [0.25, 0.75, 1],
        label: [null, 'Town B', 'Town A'],
        prominence: [null, 2100, 300],
    })
    if (JSON.stringify(Array.from(cartogram.value_mean)) !== '[25,10]') throw Error('wrong weighted means')
    if (JSON.stringify(Array.from(cartogram.label)) !== '["Town B","Town A"]') throw Error('wrong city labels')
    if (JSON.stringify(Array.from(cartogram.x)) !== '[0,2]') throw Error('wrong target cells')
    if (JSON.stringify(links.featureToCells.get('FEATURE-A')) !== '[0,1]') throw Error('wrong feature-to-cell links')
    if (JSON.stringify(links.cellToFeatures) !== '[["FEATURE-A","FEATURE-B"],["FEATURE-A"]]') throw Error('wrong cell-to-feature links')
    if (links.featureById.get('FEATURE-B') !== geojson.features[1]) throw Error('wrong feature lookup')
    if (JSON.stringify(links.featureBoundsById.get('FEATURE-B')) !== '[3,4,5,6]') throw Error('wrong feature bounds')
})

Deno.test('GeoJSON cartogram skips missing values and renormalizes weights', () => {
    const data = {
        ...geojson,
        features: [
            geojson.features[0],
            {...geojson.features[1], properties: {...geojson.features[1].properties, value: null}},
        ],
    }
    const result = aggregateGeoJSONCartogram(data, {
        source_id: ['FEATURE-A', 'FEATURE-B'],
        x: [0, 0],
        y: [0, 0],
        weight_mean: [0.25, 0.75],
    })
    if (result.missingValueRows !== 1) throw Error('missing value row was not counted')
    if (JSON.stringify(Array.from(result.cartogram.value_mean)) !== '[10]') throw Error('missing value affected the mean')
    if (!result.links.featureById.has('FEATURE-B')) throw Error('missing-value feature was dropped')
    if (result.links.featureToCells.has('FEATURE-B')) throw Error('missing-value feature received a cartogram link')
})

Deno.test('GeoJSON bounds cover polygon and geometry collection coordinates', () => {
    const features = [
        {geometry: {type: 'MultiPolygon', coordinates: [[[[2, 3], [4, 3], [4, 5], [2, 3]]], [[[-8, -6], [-7, -6], [-7, -4], [-8, -6]]]]}},
        {geometry: {type: 'GeometryCollection', geometries: [{type: 'Point', coordinates: [9, 10]}]}},
    ]
    if (JSON.stringify(geoJSONFeatureBounds(features)) !== '[-8,-6,9,10]') throw Error('wrong GeoJSON bounds')
})

Deno.test('GeoJSON cartogram rejects source IDs absent from the GeoJSON', () => {
    let rejected = false
    try {
        aggregateGeoJSONCartogram(geojson, {
            source_id: ['MISSING'], x: [0], y: [0], weight_mean: [1],
        })
    } catch {
        rejected = true
    }
    if (!rejected) throw Error('missing source was accepted')
})
