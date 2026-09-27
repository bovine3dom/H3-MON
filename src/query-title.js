export function queryTitle(template, query, findClosestCity, controls = [], latLngForIndex, findCityForCell, contexts = {}) {
    if (!template || !query) return template
    let townNames = []
    if (template.includes('{TOWN_NAME}') || template.includes('{remote.query.TOWN_NAME}')) {
        const origins = query.origins || [query]
        townNames = origins.map(originQuery => {
            if (findCityForCell && originQuery.index) {
                try {
                    const city = findCityForCell(originQuery.index)
                    if (city?.name) return city.name
                } catch (_) {}
            }
            let origin = [originQuery.lat, originQuery.lng]
            if (latLngForIndex && originQuery.index) {
                try { origin = latLngForIndex(originQuery.index) } catch (_) { origin = [] }
            }
            if (!Number.isFinite(origin[0]) || !Number.isFinite(origin[1])) return null
            return findClosestCity(origin[0], ((origin[1] + 180) % 360 + 360) % 360 - 180)?.name || null
        }).filter(Boolean)
    }
    const townName = townNames.length > 2
        ? `${townNames.slice(0, -1).join(', ')}, and ${townNames.at(-1)}`
        : townNames.join(' and ')
    const controlSettings = new Map(controls.map(setting => [setting.key.slice(2), setting]))
    const clientValues = contexts.client?.values || {}
    const clientSettings = new Map((contexts.client?.schema || []).map(setting => [setting.key, setting]))
    const remoteValues = contexts.remote?.values || {}
    const remoteSettings = new Map((contexts.remote?.schema || []).map(setting => [setting.key, setting]))
    const remoteKeys = new Set(['index', 'index_lower', 'index_upper', 'lat', 'lng', 'zoom'])

    function controlVisible(setting, values) {
        if (!setting?.showIf) return true
        try { return setting.showIf(values) } catch (_) { return true }
    }

    function formatValue(value) {
        if (value === null) return 'null'
        if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return String(value)
        if (value && typeof value === 'object') {
            try { return JSON.stringify(value) } catch (_) {}
        }
        return null
    }

    function resolveReference(namespace, key) {
        let values, setting, showIfValues, lookupKey = key
        if (namespace === 'remote' && key.startsWith('query.')) {
            lookupKey = key.slice(6)
            if (lookupKey === 'TOWN_NAME') return townName ? {matched: true, value: townName, raw: townName} : {matched: false}
            if (!remoteKeys.has(lookupKey)) return {matched: false}
            values = query
        } else if (namespace === 'remote') {
            values = remoteValues
            setting = remoteSettings.get(key)
            showIfValues = query._inputs
        } else if (namespace === 'controls') {
            values = query._inputs
            setting = controlSettings.get(key)
            showIfValues = query._inputs
        } else {
            values = clientValues
            setting = clientSettings.get(key)
            showIfValues = contexts.client?.showIfValues || values
        }
        if (!values || !Object.hasOwn(values, lookupKey)) return {matched: false}
        if (setting?.showIf && !controlVisible(setting, showIfValues)) return {matched: true, hidden: true}
        const raw = values[lookupKey]
        const option = setting?.options?.find(option => option.value === raw)
        const value = formatValue(option ? option.name : raw)
        const control = namespace === 'controls' || !!setting?.remoteControl || !!option
        return value === null ? {matched: false} : {matched: true, value, raw, control}
    }

    function parseLiteral(value) {
        if (/^"(?:[^"\\]|\\.)*"$/.test(value)) {
            try { return {valid: true, value: JSON.parse(value)} } catch (_) { return {valid: false} }
        }
        const singleQuoted = /^'([^'\\]*)'$/.exec(value)
        if (singleQuoted) return {valid: true, value: singleQuoted[1]}
        if (value === 'true' || value === 'false') return {valid: true, value: value === 'true'}
        if (value === 'null') return {valid: true, value: null}
        if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) {
            const number = Number(value)
            if (Number.isFinite(number)) return {valid: true, value: number}
        }
        return {valid: false}
    }

    function resolveCondition(token) {
        const condition = /^(client|remote|controls)\.([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*)\s*(===|!==|==|!=|>=|<=|>|<)\s*(.*?)$/.exec(token)
        if (!condition) return {matched: false}
        const [, namespace, key, operator, literal] = condition
        const left = resolveReference(namespace, key)
        const parsed = parseLiteral(literal)
        if (!left.matched || !parsed.valid) return {matched: false}
        if (left.hidden) return {matched: true, condition: true, hidden: true}
        const right = parsed.value
        let visible
        switch (operator) {
            case '===': visible = left.raw === right; break
            case '!==': visible = left.raw !== right; break
            case '==': visible = left.raw == right; break
            case '!=': visible = left.raw != right; break
            case '>': visible = left.raw > right; break
            case '>=': visible = left.raw >= right; break
            case '<': visible = left.raw < right; break
            case '<=': visible = left.raw <= right; break
        }
        return {matched: true, condition: true, hidden: !visible}
    }

    function resolve(token) {
        if (token === 'TOWN_NAME') return townName ? {matched: true, value: townName} : {matched: false}
        const qualified = /^(client|remote|controls)\.([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*)$/.exec(token)
        if (qualified) return resolveReference(qualified[1], qualified[2])
        return remoteKeys.has(token) ? resolveReference('remote', `query.${token}`) : {matched: false}
    }

    function render(text, before = '') {
        let output = '', matched = false, hidden = false
        for (let i = 0; i < text.length;) {
            if (text[i] !== '{') {
                output += text[i++]
                continue
            }
            let depth = 1, end = i + 1
            for (; end < text.length && depth; end++) {
                if (text[end] === '{') depth++
                else if (text[end] === '}') depth--
            }
            if (depth) {
                output += text.slice(i)
                break
            }
            const original = text.slice(i, end)
            const inner = text.slice(i + 1, end - 1)
            const condition = resolveCondition(inner)
            const direct = condition.matched ? condition : resolve(inner)
            let result
            if (direct.matched) {
                let value = direct.condition || direct.hidden ? '' : direct.value
                const context = before + output
                if (direct.control && value && context.trim() && !/[.!?]\s*$/.test(context)) {
                    const first = Array.from(value)[0]
                    value = first.toLowerCase() + value.slice(first.length)
                }
                result = {text: value, matched: true, hidden: !!direct.hidden}
                if (direct.condition && !direct.hidden) {
                    const spaces = /^[ \t]+/.exec(text.slice(end))?.[0] || ''
                    if (spaces && /[ \t]$/.test(output)) end += spaces.length
                    else if (!spaces) output = output.replace(/[ \t]+$/, '')
                }
            } else {
                const nested = render(inner, before + output)
                result = nested.matched
                    ? {text: nested.hidden ? '' : nested.text, matched: true, hidden: nested.hidden}
                    : {text: original, matched: false, hidden: false}
            }
            output += result.text
            matched ||= result.matched
            hidden ||= result.hidden
            i = end
        }
        return {text: output, matched, hidden}
    }

    return render(template).text
}
