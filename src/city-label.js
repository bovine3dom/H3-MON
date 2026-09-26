function distanceSquared([lat1, lng1], [lat2, lng2]) {
    const radians = Math.PI / 180
    const deltaLat = (lat2 - lat1) * radians
    const deltaLng = (((lng2 - lng1 + 540) % 360) - 180) * radians
    const sinLat = Math.sin(deltaLat / 2)
    const sinLng = Math.sin(deltaLng / 2)
    return sinLat * sinLat + Math.cos(lat1 * radians) * Math.cos(lat2 * radians) * sinLng * sinLng
}

export function mostPopulousCityInCell(cities, center, neighbors) {
    let best
    for (const city of cities) {
        if (!Number.isFinite(city?.latitude) || !Number.isFinite(city?.longitude)
            || !Number.isFinite(city?.population) || city.population <= (best?.population ?? -Infinity)) continue
        const location = [city.latitude, city.longitude]
        const distanceToCell = distanceSquared(location, center)
        if (neighbors.every(neighbor => distanceToCell < distanceSquared(location, neighbor))) best = city
    }
    return best
}
