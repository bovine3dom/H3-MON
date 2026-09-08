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
        refresh: 'render',
    },
    {
        key: 'c',
        name: 'Attribution',
        group: 'General',
        type: 'text',
        defaultValue: '',
        refresh: 'render',
    },
    {
        key: 'colourScheme',
        name: 'Colour scheme',
        description: 'Automatic uses Spectral, or Rainbow with cyclical colours.',
        group: 'Colour',
        type: 'colourScheme',
        defaultValue: '',
        refresh: 'render',
    },
    {
        key: 'cyclical',
        name: 'Cyclical colours',
        description: 'Use Rainbow when the colour scheme is Automatic.',
        group: 'Colour',
        type: 'boolean',
        defaultValue: false,
        refresh: 'render',
    },
    {
        key: 'flip',
        name: 'Reverse colours',
        group: 'Colour',
        type: 'boolean',
        defaultValue: false,
        refresh: 'render',
    },
    {
        key: 'colourScale',
        name: 'Colour scale',
        description: 'Mapping of values to colours: quantile makes the scale linear in ranking; rankit applies a normal transform to the quantile scale, compressing the median and stretching the outliers; linear is, er, linear; raw is a linear scale between 0 and 1.',
        group: 'Values',
        type: 'select',
        defaultValue: 'quantile',
        options: [
            {value: 'quantile', name: 'Quantile'},
            {value: 'rankit', name: 'Rankit'},
            {value: 'linear', name: 'Linear'},
            {value: 'raw', name: 'Raw'},
        ],
        refresh: 'data',
    },
    {
        key: 'raw',
        hidden: true,
        type: 'boolean',
        defaultValue: false,
        refresh: 'data',
    },
    {
        key: 'linear',
        hidden: true,
        type: 'boolean',
        defaultValue: false,
        refresh: 'data',
    },
    {
        key: 'rankit',
        hidden: true,
        type: 'boolean',
        defaultValue: false,
        refresh: 'data',
    },
    {
        key: 'legendBounds',
        name: 'Legend bounds',
        description: 'Freeze the current minimum and maximum as a fixed linear numeric scale. Unfreeze to restore automatic scaling.',
        group: 'Values',
        type: 'legendBounds',
        defaultValue: null,
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
        refresh: 'data',
    },
    {
        key: 'quantileSource',
        name: 'Quantile source',
        description: 'Get ranks from the map or cartogram for quantile/rankit scales.',
        group: 'Values',
        type: 'select',
        defaultValue: 'map',
        options: [
            {value: 'map', name: 'Geographic map'},
            {value: 'cartogram', name: 'Cartogram'},
        ],
        refresh: 'data',
    },
    {
        key: 'scale',
        name: 'Scale labels',
        description: 'Map numeric values to legend labels in raw-value mode.',
        group: 'Values',
        type: 'scale',
        defaultValue: null,
        refresh: 'render',
    },
    {
        key: 'crosshair',
        name: 'Centre crosshair',
        description: 'Mark the centre of the map with a cross.',
        group: 'Map and cartogram',
        type: 'boolean',
        defaultValue: true,
        refresh: 'render',
    },
    {
        key: 'trains',
        name: 'Railway speeds',
        group: 'Map and cartogram',
        type: 'boolean',
        defaultValue: false,
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
        refresh: 'cartogram',
    },
    {
        key: 'defaultValue',
        name: 'Missing value',
        description: 'Value used for missing contributors of nearby cells when aggregating the cartogram.',
        group: 'Map and cartogram',
        type: 'nullableNumber',
        defaultValue: null,
        refresh: 'data',
    },
    {
        key: 'infill',
        name: 'Fill empty cells',
        description: 'Use the "Missing value" even where no neighbouring cells exist.',
        group: 'Map and cartogram',
        type: 'boolean',
        defaultValue: false,
        refresh: 'data',
    },
    {
        key: 'requireCompleteCoverage',
        name: 'Require complete coverage',
        description: 'Leave a cartogram cell empty if any positive-weight contributor is missing, including expected children. Overrides Missing value and Fill empty cells.',
        group: 'Map and cartogram',
        type: 'boolean',
        defaultValue: false,
        refresh: 'data',
    },
]

export const SETTINGS_BY_KEY = new Map(SETTINGS_SCHEMA.map(setting => [setting.key, setting]))

const LEGACY_COLOUR_SCALES = ['raw', 'linear', 'rankit']

export function colourScale(settings = {}, overrides = {}) {
    const valid = value => SETTINGS_BY_KEY.get('colourScale').options.some(option => option.value === value)
    if (valid(overrides.colourScale)) return overrides.colourScale
    // A legacy query flag selects the legacy rules, even when it disables a mode.
    const legacyQuery = LEGACY_COLOUR_SCALES.some(key => Object.prototype.hasOwnProperty.call(overrides, key))
    if (!legacyQuery && valid(settings.colourScale)) return settings.colourScale
    const merged = {...settings, ...overrides}
    return LEGACY_COLOUR_SCALES.find(key => settingEnabled(merged[key])) || 'quantile'
}

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
        settings: {...metadata, ...query, ...overrides, colourScale: colourScale(metadata, {...query, ...overrides})},
    }
}

export function inheritedSettingValue(metadata, setting) {
    if (setting.key === 'colourScale') return colourScale(metadata)
    if (Object.prototype.hasOwnProperty.call(metadata, setting.key)) return parseSettingValue(setting, metadata[setting.key])
    return setting.defaultValue
}

export function effectiveSettingValue(metadata, overrides, setting) {
    if (setting.key === 'colourScale') return colourScale(metadata, overrides)
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
    // Selector edits remove aliases from the draft, including with a subset schema.
    if (schema.some(setting => setting.key === 'colourScale')) {
        for (const key of LEGACY_COLOUR_SCALES) {
            if (!Object.prototype.hasOwnProperty.call(overrides, key)) url.searchParams.delete(key)
        }
    }
    for (const setting of schema) {
        if (Object.prototype.hasOwnProperty.call(overrides, setting.key)) {
            if (!url.searchParams.has(setting.key) || !settingValuesEqual(parseSettingValue(setting, url.searchParams.get(setting.key)), overrides[setting.key])) {
                url.searchParams.set(setting.key, serializeSettingValue(setting, overrides[setting.key]))
            }
        } else url.searchParams.delete(setting.key)
    }
    return url
}
