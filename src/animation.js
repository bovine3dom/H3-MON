export function animationSequence(setting, config) {
    const fail = message => { throw new Error(message) }
    if (!config || typeof config !== 'object') fail('Animation requires start, end, step and step_rate.')
    const {step, step_rate: rate} = config
    if (!Number.isFinite(rate) || rate <= 0) fail('FPS must be finite and positive.')
    const time = setting.type === 'time'
    const seconds = value => {
        if (typeof value !== 'string' || !/^\d{2,}:[0-5]\d(?::[0-5]\d)?$/.test(value)) fail('Use HH:MM[:SS] for animation endpoints.')
        return value.split(':').reduce((sum, part, i) => sum + Number(part) * [3600, 60, 1][i], 0)
    }
    let start = time ? seconds(config.start) : config.start
    let end = time ? seconds(config.end) : config.end
    if (!['number', 'time'].includes(setting.type) || !Number.isFinite(start) || !Number.isFinite(end)) fail('Animation endpoints must be finite.')
    if (time && end < start) end += Math.ceil((start - end) / 86400) * 86400
    if (!Number.isFinite(step) || step === 0 || time && (!Number.isInteger(step) || step < 0)
        || end !== start && Math.sign(step) !== Math.sign(end - start)) fail(time ? 'Time step must be positive integer seconds.' : 'Step must be nonzero and point toward the end.')
    const span = (end - start) / step
    const last = span === 0 ? 0 : Math.max(1, Math.ceil(span - Number.EPSILON * Math.max(1, Math.abs(span)) * 4))
    if (!Number.isSafeInteger(last) || last < 0 || time && (!Number.isSafeInteger(start) || !Number.isSafeInteger(end))) fail('Animation range is too large.')
    const value = index => {
        let v = index === last ? end : start + index * step
        if (time) {
            v = ((v % 86400) + 86400) % 86400
            v = [Math.floor(v / 3600), Math.floor(v / 60) % 60, v % 60].map(n => String(n).padStart(2, '0')).join(':')
        }
        const numeric = time ? seconds(v) : v
        if (!Number.isFinite(numeric) || setting.min != null && numeric < (time ? seconds(setting.min) : setting.min)
            || setting.max != null && numeric > (time ? seconds(setting.max) : setting.max)) fail('Animation frame is outside the control bounds.')
        return v
    }
    value(0); value(last)
    if (time && (setting.min != null || setting.max != null) && Math.floor(start / 86400) !== Math.floor(end / 86400)) {
        // Clock values repeat after at most one period, even for multi-day ranges.
        let a = step, b = 86400
        while (b) [a, b] = [b, a % b]
        for (let i = 1; i < Math.min(last, 86400 / a); i++) value(i)
    }
    return {rate, count: last + 1, value, index(current) {
        let v = time ? seconds(current) : Number(current)
        if (time && v < start) v += Math.ceil((start - v) / 86400) * 86400
        if (v < Math.min(start, end) || v > Math.max(start, end)) return 0
        if (v === end) return last
        const i = Math.round((v - start) / step)
        return Number.isSafeInteger(i) && i >= 0 && i <= last ? i : 0
    }}
}

// One producer and one presenter. A failed presentation retains the same cursor.
export function createAnimationPlayer({prepare, fetchFrame, present, onError, latency = () => 0}) {
    let generation = 0, controller, timer, sequence, cursor = 0, queue = [], fetching = false, presenting = false
    let active = false, due = 0, bytes = 0, run = 0
    function invalidate() {
        generation++
        controller?.abort()
        queue = []; bytes = 0
    }
    function pause() { active = false; run++; clearTimeout(timer); invalidate() }
    async function fill() {
        if (!active || fetching || queue.at(-1)?.error) return
        fetching = true
        const token = generation
        controller = new AbortController()
        try {
            const count = Math.min(sequence.count, 240, Math.max(1, Math.ceil(sequence.rate * 2) + Math.ceil(sequence.rate * Math.min(2000, latency() || 0) / 1000)))
            while (active && token === generation && queue.length < count && bytes < 64 * 1024 * 1024) {
                const index = (cursor + queue.length) % sequence.count
                const packet = prepare(sequence.value(index))
                if (!packet) break
                const frame = await fetchFrame(packet, controller.signal)
                if (token !== generation) break
                queue.push(frame); bytes += frame.bytes.byteLength
            }
        } catch (error) { if (token === generation && active) queue.push({error}) }
        finally { fetching = false }
    }
    async function tick() {
        if (!active) return
        const session = run
        void fill()
        if (!presenting && queue.length && performance.now() >= due) {
            presenting = true
            const token = generation, frame = queue[0]
            try {
                if (frame.error) throw frame.error
                if (await present(frame) && active && token === generation) {
                    queue.shift(); bytes -= frame.bytes.byteLength
                    cursor = (cursor + 1) % sequence.count
                    due = performance.now() + 1000 / sequence.rate
                }
            } catch (error) { if (token === generation && active) { pause(); onError(error) } }
            finally { presenting = false }
        }
        if (active && session === run) timer = setTimeout(tick, 16)
    }
    return {pause, invalidate, start(next, current) {
        pause(); sequence = next; cursor = sequence.index(current); due = 0; active = true; void tick()
    }}
}
