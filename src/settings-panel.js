import {
    SETTINGS_SCHEMA,
    effectiveSettingValue,
    leadingThrottleDebounce,
    parseSettingValue,
    settingEnabled,
    settingValuesEqual,
    validateSettingValue,
} from './settings.js'
import './settings-panel.css'

function element(tag, className, text) {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text != null) node.textContent = text
    return node
}

function makeScaleControl(value) {
    const root = element('div', 'scale-editor')
    const enabledLabel = element('label', 'setting-checkbox')
    const enabled = document.createElement('input')
    enabled.type = 'checkbox'
    enabledLabel.append(enabled)
    const rows = element('div', 'scale-rows')
    const add = element('button', 'scale-add', 'Add breakpoint')
    add.type = 'button'
    root.append(enabledLabel, rows, add)

    function addRow(key = '', label = '') {
        const row = element('div', 'scale-row')
        const breakpoint = document.createElement('input')
        breakpoint.type = 'number'
        breakpoint.step = 'any'
        breakpoint.placeholder = 'Value'
        breakpoint.setAttribute('aria-label', 'Scale breakpoint')
        breakpoint.value = key
        const display = document.createElement('input')
        display.type = 'text'
        display.placeholder = 'Label'
        display.setAttribute('aria-label', 'Scale label')
        display.value = label
        const remove = element('button', '', '×')
        remove.type = 'button'
        remove.setAttribute('aria-label', 'Remove breakpoint')
        remove.addEventListener('click', () => {
            row.remove()
            root.dispatchEvent(new Event('settingchange', {bubbles: true}))
        })
        row.append(breakpoint, display, remove)
        rows.append(row)
    }

    function write(nextValue) {
        rows.replaceChildren()
        enabled.checked = nextValue != null
        rows.hidden = !enabled.checked
        add.hidden = !enabled.checked
        if (nextValue && typeof nextValue === 'object' && !Array.isArray(nextValue)) {
            for (const [key, label] of Object.entries(nextValue)) addRow(key, label)
        } else if (nextValue != null) {
            addRow('', String(nextValue))
        }
    }

    function read() {
        if (!enabled.checked) return null
        const scale = {}
        for (const row of rows.children) {
            const [breakpoint, display] = row.querySelectorAll('input')
            scale[breakpoint.value] = display.value
        }
        return scale
    }

    enabled.addEventListener('change', () => {
        rows.hidden = !enabled.checked
        add.hidden = !enabled.checked
        if (enabled.checked && !rows.children.length) addRow()
        root.dispatchEvent(new Event('settingchange', {bubbles: true}))
    })
    rows.addEventListener('input', () => root.dispatchEvent(new Event('settingchange', {bubbles: true})))
    add.addEventListener('click', () => {
        addRow()
        rows.lastElementChild.querySelector('input').focus()
        root.dispatchEvent(new Event('settingchange', {bubbles: true}))
    })
    write(value)
    return {node: root, read, write}
}

function makeControl(setting, value, colourSchemes, getLegendBounds) {
    if (setting.type === 'legendBounds') {
        const root = element('div')
        const button = element('button')
        button.type = 'button'
        const bounds = element('div', 'setting-description')
        let current
        const write = next => {
            current = next
            button.textContent = next == null ? 'Freeze legend' : 'Unfreeze legend'
            button.setAttribute('aria-label', button.textContent)
            bounds.textContent = Array.isArray(next) ? next.join(' to ') : ''
        }
        button.addEventListener('click', () => {
            const next = current == null ? getLegendBounds?.() : null
            if (current == null && next == null) return
            write(next)
            root.dispatchEvent(new Event('settingchange', {bubbles: true}))
        })
        root.append(button, bounds)
        write(value)
        return {node: root, read: () => current, write}
    }
    if (setting.type === 'scale') return makeScaleControl(value)

    if (setting.type === 'boolean') {
        const input = document.createElement('input')
        input.type = 'checkbox'
        input.checked = settingEnabled(value, setting.defaultValue)
        return {
            node: input,
            event: 'change',
            read: () => input.checked,
            write: nextValue => { input.checked = settingEnabled(nextValue, setting.defaultValue) },
        }
    }

    if (setting.type === 'select' || setting.type === 'colourScheme') {
        const select = document.createElement('select')
        const options = setting.type === 'colourScheme'
            ? [{value: '', name: 'Automatic'}, ...colourSchemes.map(name => ({value: name, name: name.replace(/^interpolate/, '')}))]
            : setting.options
        for (const option of options) {
            const node = document.createElement('option')
            node.value = option.value
            node.textContent = option.name
            select.append(node)
        }
        if (value != null && !options.some(option => option.value === String(value))) {
            const legacy = document.createElement('option')
            legacy.value = String(value)
            legacy.textContent = `${value} (legacy)`
            select.append(legacy)
        }
        select.value = value ?? setting.defaultValue
        return {
            node: select,
            event: 'change',
            read: () => select.value,
            write: nextValue => { select.value = nextValue ?? setting.defaultValue },
        }
    }

    if (setting.type === 'nullableNumber') {
        const wrapper = element('div', 'setting-control-row')
        const enabledLabel = element('label', 'setting-checkbox')
        const enabled = document.createElement('input')
        enabled.type = 'checkbox'
        enabled.setAttribute('aria-label', `Use ${setting.name}`)
        enabledLabel.append(enabled)
        const input = document.createElement('input')
        input.type = 'number'
        input.step = 'any'
        input.setAttribute('aria-label', setting.name)
        const write = nextValue => {
            enabled.checked = nextValue != null && nextValue !== ''
            input.disabled = !enabled.checked
            input.value = enabled.checked ? nextValue : ''
        }
        enabled.addEventListener('change', () => {
            input.disabled = !enabled.checked
            if (enabled.checked && input.value === '') input.value = '0'
            wrapper.dispatchEvent(new Event('settingchange', {bubbles: true}))
        })
        input.addEventListener('input', () => wrapper.dispatchEvent(new Event('settingchange', {bubbles: true})))
        wrapper.append(enabledLabel, input)
        write(value)
        return {
            node: wrapper,
            read: () => enabled.checked ? parseSettingValue(setting, input.value) : null,
            write,
        }
    }

    const input = document.createElement('input')
    input.type = ['number', 'time'].includes(setting.type) ? setting.type : 'text'
    if (setting.type === 'time') {
        input.step = 60
        input.required = true
    }
    if (setting.min != null) input.min = setting.min
    if (setting.max != null) input.max = setting.max
    if (setting.step != null) input.step = setting.step
    if (setting.placeholder) input.placeholder = setting.placeholder
    input.value = value ?? setting.defaultValue
    return {
        node: input,
        event: setting.apply === 'immediate' ? 'change' : 'input',
        read: () => parseSettingValue(setting, input.value),
        write: nextValue => { input.value = nextValue ?? setting.defaultValue },
    }
}

export function createSettingsPanel({metadata, overrides, colourSchemes, onApply, getLegendBounds, schema = SETTINGS_SCHEMA}) {
    const form = document.getElementById('settingsForm')
    const fieldsRoot = document.getElementById('settingsFields')
    const applyButton = document.getElementById('settingsApply')
    const resetAllButton = document.getElementById('settingsResetAll')
    const status = document.getElementById('settingsStatus')
    let appliedOverrides = {...overrides}
    let draftOverrides = {...overrides}
    let applyToken = 0
    let commitQueue = Promise.resolve()
    let requestTimer = null
    const fields = new Map()
    const throttles = new Map()
    const failedSettings = new Set()
    const requestSettings = schema.filter(setting => setting.refresh === 'request')

    applyButton.textContent = 'Apply'
    resetAllButton.textContent = 'Reset'

    const hasOverride = (values, key) => Object.prototype.hasOwnProperty.call(values, key)
    const fieldValue = setting => effectiveSettingValue(metadata, draftOverrides, setting)
    const isChanged = setting => {
        const draftHas = hasOverride(draftOverrides, setting.key)
        const appliedHas = hasOverride(appliedOverrides, setting.key)
        return draftHas !== appliedHas || draftHas && !settingValuesEqual(draftOverrides[setting.key], appliedOverrides[setting.key])
    }

    function refreshField(setting) {
        const field = fields.get(setting.key)
        field.reset.hidden = !hasOverride(draftOverrides, setting.key)
        const input = field.control.node
        const error = ((setting.type === 'time' || input.validity?.rangeUnderflow || input.validity?.rangeOverflow) && input.validationMessage) ||
            validateSettingValue(setting, field.control.read())
        field.error.textContent = error || ''
        field.error.hidden = !error
        const targets = field.control.node.matches('input, select, textarea')
            ? [field.control.node]
            : field.control.node.querySelectorAll('input, select, textarea')
        for (const target of targets) {
            target.setAttribute('aria-describedby', field.error.id)
            target.setAttribute('aria-invalid', String(!!error))
        }
        return !error
    }

    function pendingSettings() {
        return schema.filter(setting => setting.refresh !== 'request' &&
            (failedSettings.has(setting.key) || setting.apply === 'staged' && isChanged(setting)))
    }

    function refreshActions() {
        const pending = pendingSettings()
        const invalid = pending.some(setting => !refreshField(setting))
        applyButton.hidden = !pending.length
        applyButton.disabled = !pending.length || invalid
        resetAllButton.disabled = !Object.keys(draftOverrides).length && !Object.keys(appliedOverrides).length && !failedSettings.size
        resetAllButton.hidden = resetAllButton.disabled
        applyButton.parentElement.hidden = applyButton.hidden && resetAllButton.hidden && !status.textContent
    }

    function edited(setting, cancelQueued = false) {
        const field = fields.get(setting.key)
        field.version++
        if (cancelQueued) field.cancelledVersion = field.version - 1
        failedSettings.delete(setting.key)
        applyToken++
        status.textContent = ''
        if (setting.refresh === 'request') clearTimeout(requestTimer)
    }

    function snapshot(settings) {
        return {
            settings,
            overrides: {...draftOverrides},
            versions: new Map(settings.map(setting => [setting.key, fields.get(setting.key).version])),
            token: ++applyToken,
        }
    }

    async function performCommit({settings, overrides, versions, token}) {
        if (settings.some(setting => setting.refresh === 'request' && versions.get(setting.key) !== fields.get(setting.key).version)) return
        settings = settings.filter(setting => versions.get(setting.key) > fields.get(setting.key).cancelledVersion)
        if (!settings.length) return
        if (settings.some(setting => validateSettingValue(setting, effectiveSettingValue(metadata, overrides, setting)))) return
        // Merge only this commit's captured fields, not a later draft or stale unrelated values.
        for (const setting of settings) {
            if (hasOverride(overrides, setting.key)) appliedOverrides[setting.key] = overrides[setting.key]
            else delete appliedOverrides[setting.key]
        }
        refreshActions()
        try {
            await onApply({...appliedOverrides}, settings)
            for (const setting of settings) {
                if (versions.get(setting.key) === fields.get(setting.key).version) failedSettings.delete(setting.key)
            }
            if (token === applyToken) status.textContent = ''
        } catch (error) {
            if (error?.name === 'AbortError') return
            for (const setting of settings) {
                if (versions.get(setting.key) === fields.get(setting.key).version) failedSettings.add(setting.key)
            }
            if (token === applyToken) status.textContent = error?.message || 'Update failed'
        } finally {
            refreshActions()
        }
    }

    function commit(values) {
        const run = () => performCommit(values)
        commitQueue = commitQueue.then(run, run)
        return commitQueue
    }

    function schedule(setting) {
        const valid = refreshField(setting)
        refreshActions()
        if (setting.refresh === 'request') {
            // One trailing debounce validates and submits the whole request together.
            const validRequest = requestSettings.map(refreshField).every(Boolean)
            if (!validRequest) return
            const values = snapshot(requestSettings)
            requestTimer = setTimeout(() => performCommit(values), 350)
        } else if (!valid) {
            throttles.get(setting.key).cancel()
            fields.get(setting.key).cancelledVersion = fields.get(setting.key).version
        } else if (setting.apply === 'throttle') {
            throttles.get(setting.key)(snapshot([setting]))
        } else if (setting.apply !== 'staged') {
            commit(snapshot([setting]))
        }
    }

    function changed(setting) {
        edited(setting)
        draftOverrides[setting.key] = fields.get(setting.key).control.read()
        schedule(setting)
    }

    const groups = new Map()
    for (const setting of schema) {
        let group = groups.get(setting.group)
        if (!group) {
            group = document.createElement('fieldset')
            group.className = 'settings-group'
            group.append(element('legend', '', setting.group))
            groups.set(setting.group, group)
            fieldsRoot.append(group)
        }

        const root = element('div', 'setting-field')
        if (setting.type === 'scale') root.classList.add('setting-field-wide')
        const name = element('label', 'setting-name', setting.name)
        const controlRow = element('div', 'setting-control-row')
        const control = makeControl(setting, fieldValue(setting), colourSchemes, getLegendBounds)
        const reset = element('button', 'setting-reset', 'Reset')
        const error = element('div', 'setting-error')
        const focusTarget = control.node.matches('input, select, textarea, button') ? control.node : control.node.querySelector('input, select, textarea, button')
        const controlId = `setting-${setting.key}`
        reset.type = 'button'
        reset.setAttribute('aria-label', `Reset ${setting.name}`)
        error.id = `${controlId}-error`
        error.setAttribute('aria-live', 'polite')
        if (focusTarget) {
            focusTarget.id = controlId
            name.htmlFor = controlId
        }
        controlRow.append(control.node)
        root.append(name, controlRow, reset, error)
        if (setting.description) {
            const help = element('details', 'setting-help')
            const summary = element('summary', '', '?')
            summary.setAttribute('aria-label', `Help for ${setting.name}`)
            help.append(summary, element('p', 'setting-description', setting.description))
            root.append(help)
        }
        group.append(root)
        fields.set(setting.key, {control, focusTarget, reset, error, version: 0, cancelledVersion: -1})
        throttles.set(setting.key, leadingThrottleDebounce(commit))

        if (control.event) control.node.addEventListener(control.event, () => changed(setting))
        else control.node.addEventListener('settingchange', () => changed(setting))
        reset.addEventListener('click', () => {
            edited(setting, true)
            throttles.get(setting.key).cancel()
            delete draftOverrides[setting.key]
            control.write(fieldValue(setting))
            schedule(setting)
            focusTarget?.focus()
        })
        refreshField(setting)
    }

    form.addEventListener('submit', event => {
        event.preventDefault()
        if (applyButton.disabled) return
        status.textContent = ''
        commit(snapshot(pendingSettings()))
    })
    resetAllButton.addEventListener('click', () => {
        for (const throttle of throttles.values()) throttle.cancel()
        clearTimeout(requestTimer)
        const changedSettings = schema.filter(setting => hasOverride(appliedOverrides, setting.key) || failedSettings.has(setting.key))
        draftOverrides = {}
        for (const setting of schema) {
            edited(setting, true)
            fields.get(setting.key).control.write(fieldValue(setting))
            refreshField(setting)
        }
        appliedOverrides = {}
        refreshActions()
        commit(snapshot(changedSettings.filter(setting => setting.refresh !== 'request')))
        if (changedSettings.some(setting => setting.refresh === 'request')) schedule(requestSettings[0])
    })
    refreshActions()

    function refreshCompleted({requests = true} = {}) {
        const recovered = schema.filter(setting => failedSettings.has(setting.key) &&
            (['data', 'cartogram'].includes(setting.refresh) || requests && setting.refresh === 'request'))
        for (const setting of recovered) failedSettings.delete(setting.key)
        refreshActions()
        if (recovered.length && !failedSettings.size) status.textContent = ''
    }

    return {
        focusFirst: () => fields.get(schema[0]?.key)?.focusTarget?.focus(),
        getOverrides: () => ({...draftOverrides}),
        refreshCompleted,
    }
}
