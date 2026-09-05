function validateQuery(query) {
    const fail = () => { throw new Error('Invalid saved query: expected an event, H3 origin and finite coordinates') }
    if (!query || typeof query !== 'object' || Array.isArray(query)) fail()
    if (Object.keys(query).some(key => !['event', 'index', 'lat', 'lng', 'zoom', 'cartogram'].includes(key))) fail()
    if (!['onclick', 'onmove'].includes(query.event) || typeof query.index !== 'string' || query.index.length !== 15 || !/^8[0-9a-f]{14}$/.test(query.index)) fail()
    if (!Number.isFinite(query.lat) || Math.abs(query.lat) > 90 || !Number.isFinite(query.lng) || Math.abs(query.lng) > 180) fail()
    if (!Number.isFinite(query.zoom) || query.zoom < 0 || query.zoom > 24) fail()
    if (query.cartogram !== undefined && (!Array.isArray(query.cartogram) || query.cartogram.length !== 2 || !query.cartogram.every(Number.isFinite))) fail()
    return {...query, ...(query.cartogram ? {cartogram: [...query.cartogram]} : {})}
}

export function readQueryState(searchParams) {
    if (!searchParams.has('query')) return null
    if (searchParams.getAll('query').length !== 1) throw new Error('Duplicate saved query')
    let query
    try { query = JSON.parse(searchParams.get('query')) }
    catch (_) { throw new Error('Invalid saved query JSON') }
    return validateQuery(query)
}

export function writeQueryState(url, query) {
    url.searchParams.set('query', JSON.stringify(validateQuery(query)))
    return url
}
