import {leadingThrottleDebounce, settingEnabled} from './settings.js'

export function centralLinkedH3(indices, latLngForIndex) {
    const points = [...new Set(indices)].sort().map(index => {
        const [lat, lng] = latLngForIndex(index).map(degrees => degrees * Math.PI / 180)
        return {index, vector: [Math.cos(lat) * Math.cos(lng), Math.cos(lat) * Math.sin(lng), Math.sin(lat)]}
    })
    if (!points.length) return null
    // Unit vectors keep clusters spanning the antimeridian centred on those cells.
    const centre = [0, 0, 0]
    for (const {vector} of points) for (let axis = 0; axis < 3; axis++) centre[axis] += vector[axis]
    let best = points[0].index, bestScore = -Infinity
    for (const {index, vector} of points) {
        const score = vector.reduce((sum, value, axis) => sum + value * centre[axis], 0)
        if (score > bestScore) { best = index; bestScore = score }
    }
    return best
}

export function createInteractions({getSettings, getReplaySettings = getSettings, getValues, request, onError = () => {}, baseURL}) {
    let moveConfig = null
    let moveTask = null
    let lastKey = null
    let lastAction = null
    let lastDelivery = Promise.resolve(false)

    function readConfig(key, settings = getSettings()) {
        const config = settings?.[key]
        if (config == null || ['boolean', 'string'].includes(typeof config) && !settingEnabled(config)) return null
        if (typeof config !== 'object' || Array.isArray(config) || typeof config.url !== 'string' || !config.url.trim()
            || config.resolution !== undefined && (!Number.isInteger(config.resolution) || config.resolution < 0 || config.resolution > 15)
            || config.wait !== undefined && (!Number.isFinite(config.wait) || config.wait < 0 || config.wait > 60000)
            || ['focus', 'highlight'].some(key => config[key] !== undefined && typeof config[key] !== 'boolean')) {
            throw new Error(`Invalid ${key} configuration`)
        }
        let socket
        if (config.socket !== undefined) {
            if (typeof config.socket !== 'string' || !/^wss?:\/\//i.test(config.socket) || /[{}#]/.test(config.socket)) {
                throw new Error(`Invalid ${key} socket URL: expected an absolute WS(S) URL without templates or fragments`)
            }
            const endpoint = new URL(config.socket)
            if (!['ws:', 'wss:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
                throw new Error(`Invalid ${key} socket URL: credentials are not allowed`)
            }
            socket = endpoint.href
        }
        return {url: config.url, socket, resolution: config.resolution, wait: config.wait ?? (socket ? 0 : 350), focus: config.focus ?? true, highlight: config.highlight ?? true}
    }

    function deliver({url, context}, config, force = false) {
        if (config && JSON.stringify(readConfig('onmove')) !== JSON.stringify(config)) return Promise.resolve(false)
        // Ignore untemplated pan/zoom changes, but retain transport and query-state identity.
        const key = JSON.stringify([url, context.socket, context.event, context.manual,
            context.values.index, context.values._inputs, context.point?.cartogram])
        if (!force && key === lastKey) return lastDelivery
        lastKey = key
        lastDelivery = (async () => {
            try {
                const success = await request(url, context) !== false
                if (!success && lastKey === key) lastKey = null
                return success
            } catch (error) {
                if (lastKey === key) lastKey = null
                onError(error)
                return false
            }
        })()
        return lastDelivery
    }

    function cancel() {
        moveTask?.cancel()
        moveTask = null
        moveConfig = null
        lastKey = null
    }

    function run(key, point, {manual = false, force = true} = {}) {
        const action = {key, point: point && typeof point === 'object' ? {...point} : point}
        try {
            const config = readConfig(key, manual ? getReplaySettings() : getSettings())
            const moving = key === 'onmove' && !manual
            if (moving && JSON.stringify(config) !== JSON.stringify(moveConfig)) {
                moveTask?.cancel()
                moveConfig = config
                moveTask = config && config.wait > 0 ? leadingThrottleDebounce(packet => {
                    try { deliver(packet, config) } catch (error) { cancel(); onError(error) }
                }, config.wait) : null
            }
            if (!config) return Promise.resolve(false)
            lastAction = action
            if (!moving) {
                moveTask?.cancel()
                moveTask = null
                moveConfig = null
            }
            const values = getValues(config, point)
            if (values == null) return Promise.resolve(false)
            const template = config.url.replace(/\{([^{}]*)\}/g, (_, token) => {
                if ((!['index', 'index_lower', 'index_upper', 'lat', 'lng', 'zoom'].includes(token) && !/^controls\.[A-Za-z][A-Za-z0-9_]*$/.test(token)) || !Object.hasOwn(values, token)) {
                    throw new Error(`Unknown or missing interaction token: ${token}`)
                }
                const value = values[token]
                if (typeof value !== 'string' && typeof value !== 'number' || typeof value === 'number' && !Number.isFinite(value)) {
                    throw new Error(`Invalid interaction value: ${token}`)
                }
                return encodeURIComponent(value)
            })
            if (/[{}]/.test(template)) throw new Error('Unresolved interaction token')
            const url = new URL(template, baseURL)
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
                throw new Error('Interaction URLs must use HTTP(S) without credentials')
            }
            if (config.socket && url.href.includes('#')) throw new Error('Socket query URLs must not contain fragments')
            const packet = {url: config.socket ? url.pathname + url.search : url.href,
                context: {event: key, point: lastAction.point, values, socket: config.socket, manual}}
            if (moving && moveTask) moveTask(packet)
            else if (moving) return deliver(packet, config)
            else return deliver(packet, null, force)
        } catch (error) {
            lastAction = action
            if (key === 'onmove') cancel()
            onError(error)
            return Promise.resolve(false)
        }
    }

    return {
        click: point => run('onclick', point), move: point => run('onmove', point), cancel,
        retry: () => lastAction && run(lastAction.key, lastAction.point, {manual: true}),
        replay: (key, point, options) => run(key, point, {...options, manual: true}),
    }
}
