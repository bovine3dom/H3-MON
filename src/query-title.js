export function queryTitle(template, query, findClosestCity, controls = [], latLngForIndex, findCityForCell) {
    if (!template || !query) return template
    let townNames = []
    if (template.includes('{TOWN_NAME}')) {
        const origins = query.origins || [query]
        townNames = origins.map(originQuery => {
            if (findCityForCell && originQuery.index) {
                try {
                    const city = findCityForCell(originQuery.index)
                    if (city?.name) return city.name
                } catch (_) {}
            }
            let origin = [originQuery.lat, originQuery.lng]
            if (latLngForIndex && originQuery.index) {
                try { origin = latLngForIndex(originQuery.index) } catch (_) { origin = [] }
            }
            if (!Number.isFinite(origin[0]) || !Number.isFinite(origin[1])) return null
            return findClosestCity(origin[0], ((origin[1] + 180) % 360 + 360) % 360 - 180)?.name || null
        }).filter(Boolean)
    }
    const townName = townNames.length > 2
        ? `${townNames.slice(0, -1).join(', ')}, and ${townNames.at(-1)}`
        : townNames.join(' and ')
    return template.replace(/\{([^{}]*)\}/g, (placeholder, token) => {
        if (token === 'TOWN_NAME') return townName || placeholder
        const control = /^controls\.([A-Za-z][A-Za-z0-9_]*)$/.exec(token)
        const values = control ? query._inputs : query
        const key = control ? control[1] : token
        if (!control && !['index', 'index_lower', 'index_upper', 'lat', 'lng', 'zoom'].includes(key)
            || !values || !Object.hasOwn(values, key)) return placeholder
        const value = values[key]
        if (control) {
            const setting = controls.find(setting => setting.key === `p.${key}` && setting.type === 'select')
            const option = setting?.options.find(option => option.value === value)
            if (option) return option.name
        }
        return typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)
            ? String(value) : placeholder
    })
}
