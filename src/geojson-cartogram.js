import {addWeightedValue, toFiniteNumber, weightedMean} from './numeric.js'

export function geoJSONFeatureBounds(features) {
    let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity
    const add = (longitude, latitude) => {
        if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return
        west = Math.min(west, longitude)
        south = Math.min(south, latitude)
        east = Math.max(east, longitude)
        north = Math.max(north, latitude)
    }
    const visitCoordinates = coordinates => {
        if (!Array.isArray(coordinates)) return
        if (coordinates.length >= 2 && typeof coordinates[0] === 'number' && typeof coordinates[1] === 'number') {
            add(coordinates[0], coordinates[1])
            return
        }
        for (const coordinate of coordinates) visitCoordinates(coordinate)
    }
    const visitGeometry = geometry => {
        if (geometry?.type === 'GeometryCollection') {
            for (const child of geometry.geometries || []) visitGeometry(child)
        } else {
            visitCoordinates(geometry?.coordinates)
        }
    }
    for (const feature of features || []) {
        const bbox = feature?.bbox
        if (Array.isArray(bbox) && bbox.length >= 4 && bbox.slice(0, 4).every(Number.isFinite)) {
            add(bbox[0], bbox[1])
            add(bbox[2], bbox[3])
        } else {
            visitGeometry(feature?.geometry)
        }
    }
    return west === Infinity ? null : [west, south, east, north]
}

export function aggregateGeoJSONCartogram(data, mapping, idProperty = 'id', sourceIdColumn = 'source_id') {
    if (data?.type !== 'FeatureCollection' || !Array.isArray(data.features)) {
        throw new Error('Expected a GeoJSON FeatureCollection')
    }
    if (!mapping[sourceIdColumn] || !mapping.x || !mapping.y || !mapping.weight_mean) {
        throw new Error(`GeoJSON cartogram mapping needs ${sourceIdColumn}, x, y, and weight_mean columns`)
    }

    const values = new Map()
    const featureById = new Map()
    const featureBoundsById = new Map()
    for (const feature of data.features) {
        const id = feature.properties?.[idProperty] ?? feature.id
        if (id == null) continue
        const key = String(id)
        featureById.set(key, feature)
        const bounds = geoJSONFeatureBounds([feature])
        if (bounds) featureBoundsById.set(key, bounds)
        const value = toFiniteNumber(feature.properties?.value ?? feature.value ?? feature.properties?.val)
        if (value != null) values.set(key, value)
    }

    const cells = new Map()
    const numerators = []
    const denominators = []
    const targetIndicesByFeature = new Map()
    let unmatched = 0
    let missingValueRows = 0
    for (let i = 0; i < mapping[sourceIdColumn].length; i++) {
        const id = String(mapping[sourceIdColumn][i])
        if (!featureById.has(id)) {
            unmatched++
            continue
        }
        const value = values.get(id)
        if (value == null) {
            missingValueRows++
            continue
        }
        const x = toFiniteNumber(mapping.x[i])
        const y = toFiniteNumber(mapping.y[i])
        const weight = toFiniteNumber(mapping.weight_mean[i])
        if (x == null || y == null || weight == null || weight <= 0) {
            throw new Error(`Invalid GeoJSON cartogram row for ${id}`)
        }
        const key = `${x},${y}`
        let cell = cells.get(key)
        if (!cell) {
            cell = {x, y, index: cells.size, code: 0, label: null, prominence: null}
            numerators[cell.index] = 0
            denominators[cell.index] = 0
            cells.set(key, cell)
        }
        if (!addWeightedValue(numerators, denominators, cell.index, value, weight)) {
            throw new Error(`Invalid GeoJSON cartogram row for ${id}`)
        }
        let targetIndices = targetIndicesByFeature.get(id)
        if (!targetIndices) targetIndicesByFeature.set(id, targetIndices = new Set())
        targetIndices.add(cell.index)
        const label = mapping.label?.[i]
        const prominence = toFiniteNumber(mapping.prominence?.[i])
        if (label != null && label !== '' && (cell.prominence == null || prominence > cell.prominence)) {
            cell.label = String(label)
            cell.prominence = prominence ?? 0
        }
        if (mapping.code) cell.code = toFiniteNumber(mapping.code[i]) ?? cell.code
    }
    if (unmatched) throw new Error(`GeoJSON cartogram mapping has ${unmatched} unmatched source rows`)
    if (!cells.size) throw new Error('GeoJSON cartogram mapping has no source rows with numeric values')

    const rows = [...cells.values()]
    const featureToCells = new Map()
    const cellToFeatures = rows.map(() => [])
    for (const [id, indices] of targetIndicesByFeature) {
        featureToCells.set(id, [...indices])
        for (const index of indices) cellToFeatures[index].push(id)
    }
    return {
        missingValueRows,
        links: {featureById, featureBoundsById, featureToCells, cellToFeatures},
        cartogram: {
            x: Int32Array.from(rows, row => row.x),
            y: Int32Array.from(rows, row => row.y),
            code: Uint16Array.from(rows, row => row.code),
            label: rows.map(row => row.label),
            prominence: rows.map(row => row.prominence),
            value_mean: Float64Array.from(rows, row => weightedMean(numerators, denominators, row.index)),
        },
    }
}
