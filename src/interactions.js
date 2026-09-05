import {leadingThrottleDebounce, settingEnabled} from './settings.js'

export function createInteractions({getSettings, getValues, request, onError = () => {}, baseURL}) {
    let moveConfig = null
    let moveTask = null
    let lastURL = null
    let lastAction = null

    function readConfig(key) {
        const config = getSettings()?.[key]
        if (config == null || ['boolean', 'string'].includes(typeof config) && !settingEnabled(config)) return null
        if (typeof config !== 'object' || Array.isArray(config) || typeof config.url !== 'string' || !config.url.trim()
            || config.resolution !== undefined && (!Number.isInteger(config.resolution) || config.resolution < 0 || config.resolution > 15)
            || config.wait !== undefined && (!Number.isFinite(config.wait) || config.wait < 0 || config.wait > 60000)) {
            throw new Error(`Invalid ${key} configuration`)
        }
        return {url: config.url, resolution: config.resolution, wait: config.wait ?? 350}
    }

    async function deliver(url, config) {
        try {
            if (config && (JSON.stringify(readConfig('onmove')) !== JSON.stringify(config) || url === lastURL)) return
            lastURL = url
            if (await request(url) === false && lastURL === url) lastURL = null
        } catch (error) {
            if (lastURL === url) lastURL = null
            onError(error)
        }
    }

    function cancel() {
        moveTask?.cancel()
        moveTask = null
        moveConfig = null
        lastURL = null
    }

    function run(key, point) {
        lastAction = {key, point: point && typeof point === 'object' ? {...point} : point}
        try {
            const config = readConfig(key)
            const moving = key === 'onmove'
            if (moving && JSON.stringify(config) !== JSON.stringify(moveConfig)) {
                moveTask?.cancel()
                moveConfig = config
                moveTask = config && leadingThrottleDebounce(url => deliver(url, config), config.wait)
            }
            if (!config) return
            if (!moving) cancel()
            const values = getValues(config, point)
            if (values == null) return
            const template = config.url.replace(/\{([^{}]*)\}/g, (_, token) => {
                if (!['index', 'index_lower', 'index_upper', 'lat', 'lng', 'zoom'].includes(token) || !Object.hasOwn(values, token)) {
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
            if (moving) moveTask(url.href)
            else deliver(url.href)
        } catch (error) {
            if (key === 'onmove') cancel()
            onError(error)
        }
    }

    return {
        click: point => run('onclick', point), move: point => run('onmove', point), cancel,
        retry: () => { if (lastAction) { cancel(); run(lastAction.key, lastAction.point) } },
    }
}
