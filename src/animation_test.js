import {animationSequence, createAnimationPlayer} from './animation.js'
import {createRequestControls} from './request-controls.js'
const assert = (value, message = 'Assertion failed') => { if (!value) throw new Error(message) }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const number = {type: 'number', min: 0, max: 10}
const config = {start: 0, end: 1, step: 0.3, step_rate: 30}
Deno.test('arithmetic frames include endpoints and validate rate, direction and bounds', () => {
    const sequence = animationSequence(number, config)
    assert(sequence.count === 5 && sequence.value(4) === 1 && sequence.value(3) === 0.3 * 3)
    assert(sequence.index(1) === 4 && animationSequence(number, {...config, end: 1e-20, step: 1}).count === 2)
    assert(animationSequence(number, {...config, start: 1, end: 0, step: -0.3}).value(4) === 0)
    for (const patch of [{step_rate: 0}, {step_rate: Infinity}, {step: 0}, {step: -1}, {end: 11}, {end: NaN}]) {
        let failed = false
        try { animationSequence(number, {...config, ...patch}) } catch { failed = true }
        assert(failed, JSON.stringify(patch))
    }
})
Deno.test('time uses seconds, crosses midnight, wraps extended hours and keeps one equal-end frame', () => {
    const make = (start, end, step = 3600) => animationSequence({type: 'time'}, {start, end, step, step_rate: 2})
    const sequence = make('23:00', '01:30')
    assert(sequence.count === 4 && sequence.value(1) === '00:00:00' && sequence.value(3) === '01:30:00')
    assert(make('00:00', '00:00').count === 1)
    assert(make('00:00', '24:00').count === 25)
    assert(make('23:00', '26:00').value(3) === '02:00:00')
    assert(sequence.index('00:00') === 1)
    for (const step of [0, -1, 0.5]) {
        let failed = false
        try { make('23:00', '24:00', step) } catch { failed = true }
        assert(failed)
    }
})
Deno.test('buffer holds late frames, retries interrupted presentation, loops and cancels stale origins', async () => {
    let origin = 1, release, outstanding = 0, maximum = 0, blocked = true
    const shown = [], requested = [], errors = []
    const player = createAnimationPlayer({
        prepare: value => ({value, origin}),
        fetchFrame: async (packet, signal) => {
            maximum = Math.max(maximum, ++outstanding); requested.push(packet)
            try {
                if (blocked) await new Promise((resolve, reject) => {
                    release = resolve
                    signal.addEventListener('abort', () => reject(new Error('cancelled')), {once: true})
                })
                return {...packet, bytes: new Uint8Array(1)}
            } finally { outstanding-- }
        },
        present: async frame => { shown.push(frame); return shown.length !== 1 },
        onError: error => errors.push(error),
    })
    try {
        player.start(animationSequence(number, {start: 0, end: 1, step: 1, step_rate: 60}), 0)
        await delay(35); assert(shown.length === 0)
        origin = 2; player.invalidate(); blocked = false; release()
        await delay(180)
        assert(maximum === 1 && shown.length >= 4 && errors.length === 0)
        assert(shown.every(frame => frame.origin === 2))
        assert(shown.slice(0, 4).map(frame => frame.value).join() === '0,0,1,0')
        player.pause(); const count = shown.length
        await delay(35); assert(shown.length === count && requested.length < 140)
    } finally { player.pause() }
})
Deno.test('wrapped time bounds are checked before playback over at most one period', () => {
    const setting = {type: 'time', min: '01:00', max: '23:00'}
    let failed = false
    try { animationSequence(setting, {start: '23:00', end: '01:00', step: 3600, step_rate: 2}) } catch { failed = true }
    assert(failed)
    const sequence = animationSequence(setting, {start: '12:00', end: '24000012:00', step: 86400, step_rate: 2})
    assert(sequence.count === 1000001 && sequence.value(999999) === '12:00:00')
    const controls = createRequestControls({time: {label: 'Time', type: 'time', default: '12:00',
        animate: {start: '12:00', end: '12:00:03', step: 1, step_rate: 2}}})
    assert(controls.schema[0].step === 'any')
})
Deno.test('prefetch errors follow all preceding valid frames and stop further fetches', async () => {
    const shown = [], requested = [], failure = new Error('frame 2 failed')
    let finish
    const done = new Promise(resolve => { finish = resolve })
    const player = createAnimationPlayer({
        prepare: value => ({value}),
        fetchFrame: async ({value}) => {
            requested.push(value)
            if (value === 2) throw failure
            return {value, bytes: new Uint8Array(1)}
        },
        present: async frame => { shown.push(frame.value); return true },
        onError: error => { shown.push(error); finish() },
    })
    try {
        player.start(animationSequence(number, {start: 0, end: 3, step: 1, step_rate: 60}), 0)
        await done
        assert(shown.length === 3 && shown[0] === 0 && shown[1] === 1 && shown[2] === failure)
        assert(requested.join() === '0,1,2')
    } finally { player.pause() }
})
