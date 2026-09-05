export function settingEnabled(value, fallback = false) {
    if (value == null) return fallback
    if (typeof value === 'boolean') return value
    return !['0', 'false', 'off', 'no'].includes(String(value).trim().toLowerCase())
}

export function leadingThrottleDebounce(callback, wait = 350) {
    let timer = null
    let trailingArgs = null
    const run = (...args) => {
        if (timer === null) callback(...args)
        else trailingArgs = args
        clearTimeout(timer)
        timer = setTimeout(() => {
            timer = null
            if (trailingArgs) {
                const args = trailingArgs
                trailingArgs = null
                callback(...args)
            }
        }, wait)
    }
    run.cancel = () => {
        clearTimeout(timer)
        timer = null
        trailingArgs = null
    }
    return run
}

export const SETTINGS_SCHEMA = [
    {
        key: 't',
        name: 'Title',
        description: 'Title shown in the browser tab and above the colour legend.',
        group: 'General',
        type: 'text',
        defaultValue: '',
        apply: 'throttle',
        refresh: 'render',
    },
    {
        key: 'c',
        name: 'Additional attribution',
        description: 'Comma-separated names added before the standard map attributions.',
        group: 'General',
        type: 'text',
        defaultValue: '',
        apply: 'throttle',
        refresh: 'render',
    },
    {
        key: 'colourScheme',
        name: 'Colour scheme',
        description: 'A D3 continuous colour interpolator. Automatic uses Spectral, or Rainbow when cyclical colours are enabled.',
        group: 'Colour and legend',
        type: 'colourScheme',
        defaultValue: '',
        apply: 'immediate',
        refresh: 'render',
    },
    {
        key: 'cyclical',
        name: 'Cyclical colours',
        description: 'Use a repeating rainbow scale when no explicit colour scheme is selected.',
        group: 'Colour and legend',
        type: 'boolean',
        defaultValue: false,
        apply: 'immediate',
        refresh: 'render',
    },
    {
        key: 'flip',
        name: 'Reverse colours',
        description: 'Reverse the direction of the active colour scale.',
        group: 'Colour and legend',
        type: 'boolean',
        defaultValue: false,
        apply: 'immediate',
        refresh: 'render',
    },
    {
        key: 'raw',
        name: 'Use raw values',
        description: 'Colour directly by the source value instead of converting values to quantiles.',
        group: 'Values',
        type: 'boolean',
        defaultValue: false,
        apply: 'immediate',
        refresh: 'data',
    },
    {
        key: 'trimFactor',
        name: 'Legend trim factor',
        description: 'Fraction trimmed from each end of the quantile legend. Must be at least 0 and less than 0.5.',
        group: 'Values',
        type: 'number',
        defaultValue: 0.01,
        min: 0,
        max: 0.499999,
        step: 0.001,
        apply: 'staged',
        refresh: 'data',
    },
    {
        key: 'quantileSource',
        name: 'Quantile source',
        description: 'Calculate colour quantiles from geographic map cells or aggregated cartogram cells.',
        group: 'Values',
        type: 'select',
        defaultValue: 'map',
        options: [
            {value: 'map', name: 'Geographic map'},
            {value: 'cartogram', name: 'Cartogram'},
        ],
        apply: 'immediate',
        refresh: 'data',
    },
    {
        key: 'scale',
        name: 'Scale labels',
        description: 'Optional numeric breakpoints and display labels used by the raw-value legend.',
        group: 'Values',
        type: 'scale',
        defaultValue: null,
        apply: 'throttle',
        refresh: 'render',
    },
    {
        key: 'trains',
        name: 'Railway speeds',
        description: 'Overlay OpenRailwayMap maximum-speed tiles on the geographic map.',
        group: 'Layers and cartogram',
        type: 'boolean',
        defaultValue: false,
        apply: 'immediate',
        refresh: 'render',
    },
    {
        key: 'cartogram',
        name: 'Cartogram weights',
        description: 'Use the default weights, disable the cartogram with “none”, or enter a weights filename from the data directory.',
        group: 'Layers and cartogram',
        type: 'text',
        defaultValue: '',
        placeholder: 'cartogram_weights.arrow',
        apply: 'staged',
        refresh: 'cartogram',
    },
    {
        key: 'defaultValue',
        name: 'Missing value',
        description: 'Optional numeric value used for missing contributors during cartogram aggregation.',
        group: 'Layers and cartogram',
        type: 'nullableNumber',
        defaultValue: null,
        apply: 'staged',
        refresh: 'data',
    },
    {
        key: 'infill',
        name: 'Infill empty cells',
        description: 'Allow the missing value to fill cartogram cells with no observed contributors.',
        group: 'Layers and cartogram',
        type: 'boolean',
        defaultValue: false,
        apply: 'immediate',
        refresh: 'data',
    },
]

export const SETTINGS_BY_KEY = new Map(SETTINGS_SCHEMA.map(setting => [setting.key, setting]))

function parseNumber(value) {
    if (typeof value === 'number') return value
    if (value === '') return value
    const number = Number(value)
    return Number.isFinite(number) ? number : value
}

export function parseSettingValue(setting, value) {
    if (setting.type === 'boolean') return settingEnabled(value, false)
    if (setting.type === 'number') return parseNumber(value)
    if (setting.type === 'nullableNumber') {
        if (value == null || value === '' || String(value).trim().toLowerCase() === 'null') return null
        return parseNumber(value)
    }
    if (setting.type === 'scale') {
        if (value == null || value === '') return value || null
        if (typeof value === 'object') return value
        if (!String(value).startsWith('json:')) return value
        try {
            const parsed = JSON.parse(String(value).slice(5))
            return parsed === null || parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : value
        } catch (_) {
            return value
        }
    }
    return value == null ? '' : String(value)
}

export function serializeSettingValue(setting, value) {
    if (setting.type === 'boolean') return settingEnabled(value, false) ? '1' : '0'
    if (setting.type === 'nullableNumber' && value == null) return 'null'
    if (setting.type === 'scale') return value == null ? 'json:null' : (typeof value === 'object' ? `json:${JSON.stringify(value)}` : String(value))
    return String(value ?? '')
}

export function readSettingLayers(metadata = {}, searchParams = new URLSearchParams()) {
    const query = Object.fromEntries(searchParams.entries())
    const overrides = {}
    for (const setting of SETTINGS_SCHEMA) {
        if (searchParams.has(setting.key)) overrides[setting.key] = parseSettingValue(setting, searchParams.get(setting.key))
    }
    return {
        metadata: {...metadata},
        overrides,
        settings: {...metadata, ...query, ...overrides},
    }
}

export function inheritedSettingValue(metadata, setting) {
    if (Object.prototype.hasOwnProperty.call(metadata, setting.key)) return parseSettingValue(setting, metadata[setting.key])
    return setting.defaultValue
}

export function effectiveSettingValue(metadata, overrides, setting) {
    if (Object.prototype.hasOwnProperty.call(overrides, setting.key)) return overrides[setting.key]
    return inheritedSettingValue(metadata, setting)
}

export function validateSettingValue(setting, value) {
    if (setting.type === 'number') {
        if (!Number.isFinite(value)) return `${setting.name} must be a number.`
        if (setting.min != null && value < setting.min) return `${setting.name} must be at least ${setting.min}.`
        if (setting.max != null && value > setting.max) return `${setting.name} must be less than 0.5.`
    }
    if (setting.type === 'nullableNumber' && value != null && !Number.isFinite(value)) {
        return `${setting.name} must be a number or left unused.`
    }
    if (setting.type === 'select' && !setting.options.some(option => option.value === value)) {
        return `${setting.name} has an unsupported value.`
    }
    if (setting.type === 'scale' && value != null) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return `${setting.name} must contain numeric breakpoints and labels.`
        if (!Object.keys(value).length) return `${setting.name} must contain at least one breakpoint.`
        for (const key of Object.keys(value)) {
            if (key.trim() === '' || !Number.isFinite(Number(key))) return `${setting.name} breakpoint “${key}” is not numeric.`
        }
    }
    return null
}

export function settingValuesEqual(left, right) {
    if (left === right) return true
    if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
    return JSON.stringify(left) === JSON.stringify(right)
}

export function updateUrlSettingOverrides(url, overrides) {
    for (const setting of SETTINGS_SCHEMA) {
        url.searchParams.delete(setting.key)
        if (Object.prototype.hasOwnProperty.call(overrides, setting.key)) {
            url.searchParams.set(setting.key, serializeSettingValue(setting, overrides[setting.key]))
        }
    }
    return url
}
