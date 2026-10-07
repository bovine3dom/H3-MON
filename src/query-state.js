const MASKED_QUERY = /^q2([omc])([0-9a-f]{1,2})(?:_(.*))?$/
const QUERY_FIELDS = [['index', 1], ['lat', 2], ['lng', 4], ['zoom', 8]]
const CARTOGRAM_BIT = 16

function invalidEncoding() { throw new Error('Invalid saved query encoding') }

function validateQuery(query) {
    const fail = () => { throw new Error('Invalid saved query: expected an event, H3 origin and finite coordinates') }
    if (!query || typeof query !== 'object' || Array.isArray(query)) fail()
    if (Object.keys(query).some(key => !['event', 'index', 'lat', 'lng', 'zoom', 'cartogram'].includes(key))) fail()
    if (!['onclick', 'onmove', 'onchange'].includes(query.event)) fail()
    if (Object.hasOwn(query, 'index') && (typeof query.index !== 'string' || query.index.length !== 15 || !/^8[0-9a-f]{14}$/.test(query.index))) fail()
    if (Object.hasOwn(query, 'lat') && (!Number.isFinite(query.lat) || Math.abs(query.lat) > 90)) fail()
    if (Object.hasOwn(query, 'lng') && (!Number.isFinite(query.lng) || Math.abs(query.lng) > 180)) fail()
    if (Object.hasOwn(query, 'zoom') && (!Number.isFinite(query.zoom) || query.zoom < 0 || query.zoom > 24)) fail()
    if (query.cartogram !== undefined && (!Array.isArray(query.cartogram) || query.cartogram.length !== 2 || !query.cartogram.every(Number.isFinite))) fail()
    return {...query, ...(query.cartogram ? {cartogram: [...query.cartogram]} : {})}
}

function compactQuery(query) {
    let mask = 0
    const fields = []
    for (const [name, bit] of QUERY_FIELDS) {
        if (!Object.hasOwn(query, name)) continue
        mask |= bit
        fields.push(query[name])
    }
    if (query.cartogram) {
        mask |= CARTOGRAM_BIT
        fields.push(...query.cartogram)
    }
    return `q2${{onclick: 'o', onmove: 'm', onchange: 'c'}[query.event]}${mask.toString(16)}${fields.length ? `_${fields.join('_')}` : ''}`
}

function numberField(field) {
    const value = Number(field)
    if (!field || !Number.isFinite(value)) invalidEncoding()
    return value
}

function expandMaskedQuery(value) {
    const match = MASKED_QUERY.exec(value)
    if (!match) invalidEncoding()
    const mask = Number.parseInt(match[2], 16)
    const fields = match[3] ? match[3].split('_') : []
    const expected = QUERY_FIELDS.reduce((count, [, bit]) => count + (mask & bit ? 1 : 0), mask & CARTOGRAM_BIT ? 2 : 0)
    if (mask & ~31 || fields.length !== expected) invalidEncoding()
    const query = {event: {o: 'onclick', m: 'onmove', c: 'onchange'}[match[1]]}
    let offset = 0
    for (const [name, bit] of QUERY_FIELDS) {
        if (!(mask & bit)) continue
        query[name] = name === 'index' ? fields[offset++] : numberField(fields[offset++])
    }
    if (mask & CARTOGRAM_BIT) query.cartogram = [numberField(fields[offset++]), numberField(fields[offset++])]
    return query
}

export function decodeQueryState(value) {
    let query
    if (MASKED_QUERY.test(value)) query = expandMaskedQuery(value)
    else {
        try { query = JSON.parse(value) }
        catch (_) { throw new Error('Invalid saved query JSON') }
    }
    return validateQuery(query)
}

export function encodeQueryState(query) {
    return compactQuery(validateQuery(query))
}

export function readQueryState(searchParams) {
    if (!searchParams.has('query')) return null
    if (searchParams.getAll('query').length !== 1) throw new Error('Duplicate saved query')
    return decodeQueryState(searchParams.get('query'))
}

export function readQueryOrigins(searchParams) {
    return searchParams.getAll('multiOrigin').flatMap(value => value.split('*')).map(value => {
        const query = /^8[0-9a-f]{14}$/.test(value)
            ? {event: 'onclick', index: value}
            : decodeQueryState(value)
        if (query.event !== 'onclick') throw new Error('Saved origins must use on-click queries')
        return query
    })
}

export function writeQueryOrigins(url, origins) {
    const encoded = origins.map(origin => {
        const query = validateQuery(origin)
        if (query.event !== 'onclick') throw new Error('Saved origins must use on-click queries')
        const hasExtraFields = ['lat', 'lng', 'zoom', 'cartogram'].some(key => Object.hasOwn(query, key))
        return query.index && !hasExtraFields ? query.index : compactQuery(query)
    })
    url.searchParams.delete('multiOrigin')
    if (encoded.length) url.searchParams.set('multiOrigin', encoded.join('*'))
    return url
}

export function writeQueryState(url, query) {
    url.searchParams.set('query', encodeQueryState(query))
    return url
}
