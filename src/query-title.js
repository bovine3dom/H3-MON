export function queryTitle(template, query, findClosestCity, controls = []) {
    if (!template || !query) return template
    const city = template.includes('{TOWN_NAME}') && Number.isFinite(query.lat) && Number.isFinite(query.lng)
        ? findClosestCity(query.lat, ((query.lng + 180) % 360 + 360) % 360 - 180) : null
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
