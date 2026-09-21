export function queryTitle(template, query, findClosestCity, controls = [], latLngForIndex) {
    if (!template || !query) return template
    let city = null
    if (template.includes('{TOWN_NAME}')) {
        let origin = [query.lat, query.lng]
        if (latLngForIndex && query.index) {
            try { origin = latLngForIndex(query.index) } catch (_) { origin = [] }
        }
        if (Number.isFinite(origin[0]) && Number.isFinite(origin[1])) {
            city = findClosestCity(origin[0], ((origin[1] + 180) % 360 + 360) % 360 - 180)
        }
    }
    return template.replace(/\{([^{}]*)\}/g, (placeholder, token) => {
        if (token === 'TOWN_NAME') return city?.name || placeholder
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
