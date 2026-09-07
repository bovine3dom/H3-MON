export function queryTitle(template, query, findClosestCity) {
    if (!template?.includes('{TOWN_NAME}') || !Number.isFinite(query?.lat) || !Number.isFinite(query?.lng)) return template
    const city = findClosestCity(query.lat, ((query.lng + 180) % 360 + 360) % 360 - 180)
    return city?.name ? template.replaceAll('{TOWN_NAME}', () => city.name) : template
}
