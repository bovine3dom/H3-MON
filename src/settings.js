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
        group: 'General',
        type: 'text',
        defaultValue: '',
        apply: 'throttle',
        refresh: 'render',
    },
    {
        key: 'c',
        name: 'Attribution',
        description: 'Separate additional attribution names with commas.',
        group: 'General',
        type: 'text',
        defaultValue: '',
        apply: 'throttle',
        refresh: 'render',
    },
    {
        key: 'colourScheme',
        name: 'Colour scheme',
        description: 'Automatic uses Spectral, or Rainbow with cyclical colours.',
        group: 'Colour',
        type: 'colourScheme',
        defaultValue: '',
        apply: 'immediate',
        refresh: 'render',
    },
    {
        key: 'cyclical',
        name: 'Cyclical colours',
        description: 'Use Rainbow when the colour scheme is Automatic.',
        group: 'Colour',
        type: 'boolean',
        defaultValue: false,
        apply: 'immediate',
        refresh: 'render',
    },
    {
        key: 'flip',
        name: 'Reverse colours',
        group: 'Colour',
        type: 'boolean',
        defaultValue: false,
        apply: 'immediate',
        refresh: 'render',
    },
    {
        key: 'raw',
        name: 'Raw values',
        description: 'Use values directly on the 0..1 colour scale. Overrides Linear and Rankit colours; ignored with frozen legend bounds.',
        group: 'Values',
        type: 'boolean',
        defaultValue: false,
        apply: 'immediate',
        refresh: 'data',
    },
    {
        key: 'linear',
        name: 'Linear colours',
        description: 'Spread colours linearly across the trimmed value range. Uses Trim fraction and Quantile source. Overrides Rankit; ignored with Raw values or frozen legend bounds.',
        group: 'Values',
        type: 'boolean',
        defaultValue: false,
        apply: 'immediate',
        refresh: 'data',
    },
    {
        key: 'rankit',
        name: 'Rankit colours',
        description: 'Normal-score ranks give tails more colour space and compress the median. Ignored with Linear colours, Raw values or frozen legend bounds.',
        group: 'Values',
        type: 'boolean',
        defaultValue: false,
        apply: 'immediate',
        refresh: 'data',
    },
    {
        key: 'legendBounds',
        name: 'Legend bounds',
        description: 'Freeze the current minimum and maximum as a fixed linear numeric scale. Unfreeze to restore automatic scaling.',
        group: 'Values',
        type: 'legendBounds',
        defaultValue: null,
        apply: 'immediate',
        refresh: 'data',
    },
    {
        key: 'trimFactor',
        name: 'Trim fraction',
        description: '0.01 trims 1% from each end of the colour distribution.',
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
        description: 'Base colours on values visible in the map or cartogram.',
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
        description: 'Map numeric values to legend labels in raw-value mode.',
        group: 'Values',
        type: 'scale',
        defaultValue: null,
        apply: 'throttle',
        refresh: 'render',
    },
    {
        key: 'crosshair',
        name: 'Centre crosshair',
        description: 'Mark the geographic query centre when movement requests are enabled.',
        group: 'Map and cartogram',
        type: 'boolean',
        defaultValue: true,
        apply: 'immediate',
        refresh: 'render',
    },
    {
        key: 'trains',
        name: 'Railway speeds',
        group: 'Map and cartogram',
        type: 'boolean',
        defaultValue: false,
        apply: 'immediate',
        refresh: 'render',
    },
    {
        key: 'cartogram',
        name: 'Cartogram weights',
        description: 'Leave blank for default weights, enter a filename, or use "none" to hide the cartogram.',
        group: 'Map and cartogram',
        type: 'text',
        defaultValue: '',
        placeholder: 'cartogram_weights.arrow',
        apply: 'staged',
        refresh: 'cartogram',
    },
    {
        key: 'defaultValue',
        name: 'Missing value',
        description: 'Value used for missing contributors when aggregating the cartogram.',
        group: 'Map and cartogram',
        type: 'nullableNumber',
        defaultValue: null,
        apply: 'staged',
        refresh: 'data',
    },
    {
        key: 'infill',
        name: 'Fill empty cells',
        description: 'Apply Missing value even where no observations exist.',
        group: 'Map and cartogram',
        type: 'boolean',
        defaultValue: false,
        apply: 'immediate',
        refresh: 'data',
    },
]

export const SETTINGS_BY_KEY = new Map(SETTINGS_SCHEMA.map(setting => [setting.key, setting]))

function parseNumber(value) {
    if (typeof value === 'number') return value
    if (String(value).trim() === '') return value
    const number = Number(value)
    return Number.isFinite(number) ? number : value
}

export function parseSettingValue(setting, value) {
    if (setting.type === 'legendBounds') {
        if (typeof value !== 'string') return value
        try { return JSON.parse(value) } catch (_) { return value }
    }
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
    if (setting.type === 'legendBounds') return JSON.stringify(value)
    if (setting.type === 'boolean') return settingEnabled(value, false) ? '1' : '0'
    if (setting.type === 'nullableNumber' && value == null) return 'null'
    if (setting.type === 'scale') return value == null ? 'json:null' : (typeof value === 'object' ? `json:${JSON.stringify(value)}` : String(value))
    return String(value ?? '')
}

export function readSettingLayers(metadata = {}, searchParams = new URLSearchParams(), schema = SETTINGS_SCHEMA) {
    const query = Object.fromEntries(searchParams.entries())
    const overrides = {}
    for (const setting of schema) {
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
    if (setting.type === 'legendBounds' && value != null && !fixedLegendScale(value)) {
        return `${setting.name} must be two finite numbers in ascending order.`
    }
    if (setting.type === 'number') {
        if (!Number.isFinite(value)) return `${setting.name} must be a number.`
        if (setting.min != null && value < setting.min) return `${setting.name} must be at least ${setting.min}.`
        if (setting.max != null && value > setting.max) return `${setting.name} must be at most ${setting.max}.`
    }
    if (setting.type === 'time' && (typeof value !== 'string' || ![5, 8].includes(value.length) || !/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(value))) {
        return `${setting.name} must be a 24-hour time.`
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

export function fixedLegendScale(bounds) {
    if (!Array.isArray(bounds) || bounds.length !== 2 || !bounds.every(Number.isFinite) || bounds[0] > bounds[1]) return null
    const [min, max] = bounds
    return [
        value => value == null || value === '' || !Number.isFinite(Number(value)) ? null
            : min === max ? (Number(value) < min ? 0 : Number(value) > max ? 1 : 0.5)
            : Math.max(0, Math.min(1, (Number(value) - min) / (max - min))),
        fraction => min * (1 - fraction) + max * fraction,
    ]
}

export function settingValuesEqual(left, right) {
    if (left === right) return true
    if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
    return JSON.stringify(left) === JSON.stringify(right)
}

export function updateUrlSettingOverrides(url, overrides, schema = SETTINGS_SCHEMA) {
    for (const setting of schema) {
        url.searchParams.delete(setting.key)
        if (Object.prototype.hasOwnProperty.call(overrides, setting.key)) {
            url.searchParams.set(setting.key, serializeSettingValue(setting, overrides[setting.key]))
        }
    }
    return url
}
