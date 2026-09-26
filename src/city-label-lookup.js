import {cellToLatLng, gridDisk} from 'h3-js'
import {findClosestCities} from 'tiny-geocoder'
import {mostPopulousCityInCell} from './city-label.js'

const CANDIDATE_LIMIT = 20
const cityForCellCache = new Map()

export function findMostPopulousCityForCell(index) {
    const key = String(index)
    if (cityForCellCache.has(key)) return cityForCellCache.get(key)
    const center = cellToLatLng(index)
    const neighbors = gridDisk(index, 1)
        .filter(cell => String(cell) !== key)
        .map(cellToLatLng)
    const candidates = findClosestCities(center[0], center[1], CANDIDATE_LIMIT)
    const city = mostPopulousCityInCell(candidates, center, neighbors)
    cityForCellCache.set(key, city)
    return city
}
