import {
    SETTINGS_SCHEMA,
    effectiveSettingValue,
    leadingThrottleDebounce,
    parseSettingValue,
    settingEnabled,
    settingValuesEqual,
    validateSettingValue,
} from './settings.js'

function element(tag, className, text) {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text != null) node.textContent = text
    return node
}

function makeScaleControl(value) {
    const root = element('div', 'scale-editor')
    const enabledLabel = element('label', 'setting-checkbox scale-enabled')
    const enabled = document.createElement('input')
    enabled.type = 'checkbox'
    enabledLabel.append(enabled, document.createTextNode('Use custom labels'))
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

function makeControl(setting, value, colourSchemes) {
    if (setting.type === 'scale') return makeScaleControl(value)

    if (setting.type === 'boolean') {
        const label = element('label', 'setting-checkbox')
        const input = document.createElement('input')
        input.type = 'checkbox'
        input.checked = settingEnabled(value, setting.defaultValue)
        label.append(input, document.createTextNode('Enabled'))
        return {
            node: label,
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
        enabledLabel.append(enabled, document.createTextNode('Use value'))
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
    input.type = setting.type === 'number' ? 'number' : 'text'
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

export function createSettingsPanel({metadata, overrides, colourSchemes, onApply}) {
    const form = document.getElementById('settingsForm')
    const fieldsRoot = document.getElementById('settingsFields')
    const applyButton = document.getElementById('settingsApply')
    const resetAllButton = document.getElementById('settingsResetAll')
    const status = document.getElementById('settingsStatus')
    let appliedOverrides = {...overrides}
    let draftOverrides = {...overrides}
    let applyToken = 0
    let applying = 0
    let commitQueue = Promise.resolve()
    const fields = new Map()
    const throttles = new Map()
    const failedSettings = new Set()

    const hasOverride = (values, key) => Object.prototype.hasOwnProperty.call(values, key)
    const fieldValue = setting => effectiveSettingValue(metadata, draftOverrides, setting)
    const isChanged = setting => {
        const draftHas = hasOverride(draftOverrides, setting.key)
        const appliedHas = hasOverride(appliedOverrides, setting.key)
        return draftHas !== appliedHas || draftHas && !settingValuesEqual(draftOverrides[setting.key], appliedOverrides[setting.key])
    }

    function fieldSource(setting) {
        if (isChanged(setting)) return hasOverride(draftOverrides, setting.key) ? 'Pending URL override' : 'Pending reset to metadata'
        if (failedSettings.has(setting.key)) return 'URL override; refresh pending'
        if (hasOverride(draftOverrides, setting.key)) return 'URL override'
        if (Object.prototype.hasOwnProperty.call(metadata, setting.key)) return 'Inherited from metadata'
        return 'Built-in default'
    }

    function refreshField(setting) {
        const field = fields.get(setting.key)
        const overridden = hasOverride(draftOverrides, setting.key)
        field.root.classList.toggle('overridden', overridden)
        field.reset.hidden = !overridden
        field.source.textContent = fieldSource(setting)
        const error = validateSettingValue(setting, field.control.read())
        field.error.textContent = error || ''
        field.error.hidden = !error
        for (const target of field.describedTargets) target.setAttribute('aria-invalid', String(!!error))
    }

    function pendingSettings() {
        return SETTINGS_SCHEMA.filter(setting => failedSettings.has(setting.key) || setting.apply === 'staged' && isChanged(setting))
    }

    function refreshActions() {
        const pending = pendingSettings()
        const invalid = pending.some(setting => validateSettingValue(setting, fields.get(setting.key).control.read()))
        applyButton.disabled = !pending.length || invalid
        applyButton.textContent = pending.length ? `Apply ${pending.length} pending` : 'Apply pending'
        if (pending.length) status.textContent = `${pending.length} change${pending.length === 1 ? '' : 's'} waiting`
        else if (!applying && / waiting$/.test(status.textContent)) status.textContent = ''
    }

    function readField(setting) {
        const field = fields.get(setting.key)
        const value = field.control.read()
        draftOverrides[setting.key] = value
        refreshField(setting)
        refreshActions()
        return !validateSettingValue(setting, value)
    }

    async function performCommit(settings) {
        if (!settings.length) return
        const invalid = settings.some(setting => validateSettingValue(setting, fields.get(setting.key).control.read()))
        if (invalid) {
            status.textContent = 'Fix invalid settings first'
            return
        }
        for (const setting of settings) {
            if (hasOverride(draftOverrides, setting.key)) appliedOverrides[setting.key] = draftOverrides[setting.key]
            else delete appliedOverrides[setting.key]
            refreshField(setting)
        }
        refreshActions()
        const token = ++applyToken
        applying++
        status.textContent = 'Updating…'
        try {
            await onApply({...appliedOverrides}, settings)
            for (const setting of settings) failedSettings.delete(setting.key)
            refreshActions()
            if (token === applyToken && !pendingSettings().length) status.textContent = 'Up to date'
        } catch (error) {
            for (const setting of settings) {
                failedSettings.add(setting.key)
                refreshField(setting)
            }
            refreshActions()
            if (token === applyToken) status.textContent = error?.message || 'Update failed'
        } finally {
            applying--
        }
    }

    function commit(settings) {
        const run = () => performCommit(settings)
        commitQueue = commitQueue.then(run, run)
        return commitQueue
    }

    function changed(setting) {
        if (!readField(setting)) {
            throttles.get(setting.key).cancel()
            return
        }
        if (setting.apply === 'staged') return
        if (setting.apply === 'throttle') throttles.get(setting.key)()
        else commit([setting])
    }

    const groups = new Map()
    for (const setting of SETTINGS_SCHEMA) {
        let group = groups.get(setting.group)
        if (!group) {
            group = document.createElement('fieldset')
            group.className = 'settings-group'
            group.append(element('legend', '', setting.group))
            groups.set(setting.group, group)
            fieldsRoot.append(group)
        }

        const root = element('div', 'setting-field')
        const heading = element('div', 'setting-heading')
        const name = element('label', 'setting-name', setting.name)
        const key = element('code', 'setting-key', setting.key)
        const description = element('p', 'setting-description', setting.description)
        const controlRow = element('div', 'setting-control-row')
        const control = makeControl(setting, fieldValue(setting), colourSchemes)
        const reset = element('button', 'setting-reset', 'Use metadata')
        const source = element('div', 'setting-source')
        const error = element('div', 'setting-error')
        const focusTarget = control.node.matches('input, select, textarea, button') ? control.node : control.node.querySelector('input, select, textarea, button')
        const controlId = `setting-${setting.key}`
        const descriptionId = `${controlId}-description`
        const errorId = `${controlId}-error`
        const describedTargets = control.node.matches('input, select, textarea')
            ? [control.node]
            : Array.from(control.node.querySelectorAll('input, select, textarea'))
        reset.type = 'button'
        description.id = descriptionId
        error.id = errorId
        if (focusTarget) {
            focusTarget.id = controlId
            name.htmlFor = controlId
        }
        for (const target of describedTargets) target.setAttribute('aria-describedby', `${descriptionId} ${errorId}`)
        heading.append(name, key)
        controlRow.append(control.node, reset)
        root.append(heading, description, controlRow, source, error)
        group.append(root)
        fields.set(setting.key, {root, control, focusTarget, reset, source, error, describedTargets})
        throttles.set(setting.key, leadingThrottleDebounce(() => commit([setting])))

        if (control.event) control.node.addEventListener(control.event, () => changed(setting))
        else control.node.addEventListener('settingchange', () => changed(setting))
        reset.addEventListener('click', () => {
            throttles.get(setting.key).cancel()
            delete draftOverrides[setting.key]
            control.write(fieldValue(setting))
            refreshField(setting)
            refreshActions()
            if (setting.apply !== 'staged') commit([setting])
        })
        refreshField(setting)
    }

    form.addEventListener('submit', event => {
        event.preventDefault()
        commit(pendingSettings())
    })
    resetAllButton.addEventListener('click', () => {
        for (const throttle of throttles.values()) throttle.cancel()
        draftOverrides = {}
        for (const setting of SETTINGS_SCHEMA) {
            fields.get(setting.key).control.write(fieldValue(setting))
            refreshField(setting)
        }
        const changedSettings = SETTINGS_SCHEMA.filter(setting => hasOverride(appliedOverrides, setting.key) || failedSettings.has(setting.key))
        appliedOverrides = {}
        refreshActions()
        commit(changedSettings)
    })
    refreshActions()

    function refreshCompleted() {
        const recovered = SETTINGS_SCHEMA.filter(setting => failedSettings.has(setting.key) && (setting.refresh === 'data' || setting.refresh === 'cartogram'))
        for (const setting of recovered) {
            failedSettings.delete(setting.key)
            refreshField(setting)
        }
        refreshActions()
        if (recovered.length && !pendingSettings().length && !applying) status.textContent = 'Up to date'
    }

    return {
        focusFirst: () => fields.get(SETTINGS_SCHEMA[0].key)?.focusTarget?.focus(),
        refreshCompleted,
    }
}
