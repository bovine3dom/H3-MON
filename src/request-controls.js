import {parseSettingValue, validateSettingValue} from './settings.js'

// Definitions must come from trusted metadata, never URL-merged settings.
export function createRequestControls(definitions = {}) {
    const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
    const time = value => typeof value === 'string' && [5, 8].includes(value.length) && /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(value)
        ? Number(value.slice(0, 2)) * 3600 + Number(value.slice(3, 5)) * 60 + Number(value.slice(6) || 0) : NaN
    if (!record(definitions)) throw new Error('Request controls must be an object of field definitions')

    const fields = Object.entries(definitions).map(([id, definition]) => {
        const fail = message => { throw new Error(`Request control "${id}": ${message}`) }
        if (!/^[A-Za-z]/.test(id) || /[^A-Za-z0-9_]/.test(id) || ['constructor', 'prototype', '__proto__'].includes(id)) fail('invalid field id')
        if (!record(definition)) fail('definition must be an object')
        if (typeof definition.label !== 'string' || !definition.label.trim()) fail('label must be a nonempty string')
        if (!['number', 'time', 'text', 'select', 'boolean'].includes(definition.type)) fail('unsupported type')
        if (!Object.hasOwn(definition, 'default')) fail('default is required')
        if (Object.hasOwn(definition, 'unit') && (typeof definition.unit !== 'string' || !definition.unit.trim())) fail('unit must be a nonempty string')
        if (Object.hasOwn(definition, 'help') && typeof definition.help !== 'string') fail('help must be a string')
        const setting = {
            key: `p.${id}`,
            name: definition.label + (definition.unit ? ` (${definition.unit})` : ''),
            group: 'Request',
            type: definition.type,
            refresh: 'request',
        }
        if (Object.hasOwn(definition, 'help')) setting.description = definition.help
        for (const bound of ['min', 'max']) {
            if (!Object.hasOwn(definition, bound)) continue
            const valid = setting.type === 'number' ? Number.isFinite(definition[bound])
                : setting.type === 'time' && Number.isFinite(time(definition[bound]))
            if (!valid) fail(`${bound} must be a valid number or time matching the field type`)
            setting[bound] = definition[bound]
        }
        if (setting.min != null && setting.max != null
            && (setting.type === 'time' ? time(setting.min) > time(setting.max) : setting.min > setting.max)) fail('min must not exceed max')
        if (Object.hasOwn(definition, 'step')) {
            if (!['number', 'time'].includes(setting.type)
                || definition.step !== 'any' && (!Number.isFinite(definition.step) || definition.step <= 0)) fail('step must be positive or "any" for a number or time field')
            setting.step = definition.step
        }
        if (setting.type === 'select') {
            if (!Array.isArray(definition.options) || !definition.options.length) fail('options must be a nonempty array')
            setting.options = definition.options.map(option => {
                if (!record(option) || typeof option.value !== 'string' || typeof option.label !== 'string' || !option.label.trim()) fail('options require string values and nonempty labels')
                return {value: option.value, name: option.label}
            })
            if (new Set(setting.options.map(option => option.value)).size !== setting.options.length) fail('option values must be unique')
        } else if (Object.hasOwn(definition, 'options')) fail('options are only supported for select fields')

        function parse(input) {
            if (setting.type === 'number') {
                if (typeof input !== 'number' && (typeof input !== 'string' || !input.trim())) fail('value must be a number')
            } else if (setting.type === 'boolean') {
                if (!['boolean', 'string'].includes(typeof input) && !Number.isFinite(input)) fail('value must be a boolean flag')
            } else if (typeof input !== 'string') fail('value must be a string')
            const value = parseSettingValue(setting, input)
            const error = validateSettingValue(setting, value)
            if (error) fail(error)
            if (setting.type === 'time') {
                if (!Number.isFinite(time(value))) fail('value must be a 24-hour time in HH:MM or HH:MM:SS format')
                if (setting.min != null && time(value) < time(setting.min)) fail(`value must be at least ${setting.min}`)
                if (setting.max != null && time(value) > time(setting.max)) fail(`value must be at most ${setting.max}`)
            }
            return value
        }
        setting.defaultValue = parse(definition.default)
        function compile(name) {
            if (typeof definition[name] !== 'string') fail(`${name} must be a JavaScript function expression string`)
            try {
                const fn = new Function('"use strict"; return (' + definition[name] + ')')()
                if (typeof fn !== 'function') throw new Error(`${name} must evaluate to a function`)
                return fn
            } catch (error) {
                fail(`invalid ${name} ${name === 'encode' ? 'converter' : 'predicate'}: ${error?.message ?? String(error)}`)
            }
        }
        const convert = Object.hasOwn(definition, 'encode') ? compile('encode') : value => value
        if (Object.hasOwn(definition, 'showIf')) {
            const showIf = compile('showIf')
            setting.showIf = values => {
                let visible
                try {
                    visible = showIf(values)
                } catch (error) {
                    fail(`showIf failed: ${error?.message ?? String(error)}`)
                }
                if (visible instanceof Promise) visible.catch(() => {})
                if (typeof visible !== 'boolean') fail('showIf must return a boolean')
                return visible
            }
        }
        return {id, setting, parse, convert, fail}
    })

    function values(settings = {}) {
        if (!record(settings)) throw new Error('Request control settings must be an object')
        return Object.freeze(Object.fromEntries(fields.map(({id, setting, parse}) => [
            id, Object.hasOwn(settings, setting.key) ? parse(settings[setting.key]) : setting.defaultValue,
        ])))
    }

    function encode(settings) {
        const inputs = values(settings)
        return Object.fromEntries(fields.map(({id, convert, fail}) => {
            let value
            try {
                value = convert(inputs[id], inputs)
            } catch (error) {
                fail(`encode failed: ${error?.message ?? String(error)}`)
            }
            // Reject async outputs without leaving an unhandled rejection behind.
            if (value instanceof Promise) value.catch(() => {})
            if (!['string', 'number', 'boolean'].includes(typeof value) || typeof value === 'number' && !Number.isFinite(value)) {
                fail('encode must return a string, finite number or boolean')
            }
            return [`controls.${id}`, String(value)]
        }))
    }

    return {schema: fields.map(({setting}) => setting), values, encode}
}
