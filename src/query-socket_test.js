import {createQuerySocket} from './query-socket.js'

function assert(condition, message = 'Assertion failed') {
    if (!condition) throw new Error(message)
}

function frame(id, payload = [255, 0, 42]) {
    const bytes = new Uint8Array(4 + payload.length)
    new DataView(bytes.buffer).setUint32(0, id, false)
    bytes.set(payload, 4)
    return bytes.buffer
}

function fixture(callbacks = {}) {
    const sockets = [], timers = new Map(), results = [], errors = []
    let timerId = 0
    class Socket {
        constructor(url) {
            this.url = url
            this.readyState = 0
            this.bufferedAmount = 0
            this.sent = []
            sockets.push(this)
        }
        open() { this.readyState = 1; this.onopen?.() }
        send(value) {
            assert(this.readyState === 1)
            if (this.sendError) throw this.sendError
            this.sent.push(JSON.parse(value))
        }
        message(data) { this.onmessage?.({data}) }
        close() { this.readyState = 3; this.closed = true }
        disconnect() { this.readyState = 3; this.onclose?.() }
    }
    const client = createQuerySocket({
        WebSocketImpl: Socket,
        onResult: (bytes, context) => results.push({bytes, context}),
        onError: (error, context) => errors.push({error, context}),
        setTimeout: (fn, delay) => { timers.set(++timerId, {fn, delay}); return timerId },
        clearTimeout: id => timers.delete(id),
        ...callbacks,
    })
    function tick() {
        assert(timers.size === 1)
        const [id, {fn, delay}] = timers.entries().next().value
        timers.delete(id)
        fn()
        return delay
    }
    const submit = (context, options, endpoint = 'ws://one') => client.submit(endpoint, `query:${context.n}`, context, options)
    return {client, submit, sockets, timers, results, errors, tick}
}

Deno.test('connecting coalesces; open sends immediately and accepts slightly trailing results', () => {
    const f = fixture(), a = {n: 1}, b = {n: 2}, c = {n: 3}
    assert(f.submit(a) === undefined)
    f.submit(b)
    assert(f.sockets.length === 1)
    const s = f.sockets[0]
    assert(s.binaryType === 'arraybuffer' && s.sent.length === 0)
    s.open()
    assert(JSON.stringify(s.sent[0]) === JSON.stringify({type: 'query', id: 1, url: 'query:2'}))
    f.submit(c)
    assert(s.sent.length === 2 && f.timers.size === 0)
    s.message(frame(1))
    assert(f.results[0].context === b)
    assert(f.results[0].bytes instanceof Uint8Array)
    assert([...f.results[0].bytes].join() === '255,0,42')
    s.message(frame(2))
    s.message(frame(1))
    s.message(frame(2))
    assert(f.results.length === 2 && f.results[1].context === c)
    f.client.dispose()
})

Deno.test('newer delivery supersedes older results and errors; frames and IDs are validated', () => {
    const f = fixture()
    f.submit({n: 1})
    const s = f.sockets[0]
    s.open()
    const context = {n: 2}
    f.submit(context)
    for (const data of [null, {}, new Uint8Array(8), new ArrayBuffer(3), frame(2, []),
        '{', 'null', '[]', JSON.stringify({type: 'other', id: 2, message: 'x'}),
        ...[-1, 2.5, 4294967296, '2', null].map(id => JSON.stringify({type: 'error', id, message: 'x'})),
        JSON.stringify({type: 'error', id: 2, message: 3}), frame(999), frame(0)]) s.message(data)
    assert(f.results.length === 0 && f.errors.length === 0)
    s.message(JSON.stringify({type: 'error', id: 2, message: 'bad query'}))
    assert(f.errors.length === 1 && f.errors[0].context === context)
    assert(f.errors[0].error.message === 'bad query')
    s.message(frame(1))
    s.message(JSON.stringify({type: 'error', id: 1, message: 'old'}))
    assert(f.results.length === 0 && f.errors.length === 1)
    f.client.dispose()
})

Deno.test('capacity coalesces over 1500 moves without starving long-running requests', () => {
    const f = fixture()
    const contexts = Array.from({length: 1601}, (_, n) => ({n}))
    f.submit(contexts[0])
    const s = f.sockets[0]
    s.open()
    for (const context of contexts.slice(1)) f.submit(context)
    assert(s.sent.length === 256 && f.timers.size === 0)
    s.message(frame(999))
    assert(s.sent.length === 256)
    s.message(frame(1))
    assert(f.results[0].context === contexts[0])
    assert(s.sent.length === 257 && s.sent[256].url === 'query:1600')
    for (let id = 2; id <= 257; id++) s.message(frame(id))
    assert(f.results.length === 257 && f.timers.size === 0)
    for (let i = 0; i < 256; i++) assert(f.results[i].context === contexts[i])
    assert(f.results[256].context === contexts[1600])
    f.client.dispose()
})

Deno.test('capacity release respects callback resets and lifecycle changes for results and errors', () => {
    for (const error of [false, true]) {
        for (const action of ['reset', 'invalidate', 'suspend', 'dispose']) {
            const callback = () => {
                if (action === 'reset') f.submit({n: 999}, {reset: true})
                else f.client[action]()
            }
            const f = fixture({[error ? 'onError' : 'onResult']: callback})
            f.submit({n: 0})
            const s = f.sockets[0]
            s.open()
            for (let n = 1; n <= 256; n++) f.submit({n})
            s.message(error ? JSON.stringify({type: 'error', id: 1, message: 'query failed'}) : frame(1))
            assert(s.sent.length === (action === 'reset' ? 257 : 256))
            if (action === 'reset') assert(s.sent[256].url === 'query:999')
            assert(f.timers.size === 0)
            f.client.dispose()
        }
    }
})

Deno.test('capacity release still polls byte backpressure and query errors also free space', () => {
    const f = fixture()
    f.submit({n: 0})
    const s = f.sockets[0]
    s.open()
    s.bufferedAmount = 65536
    f.submit({n: 1})
    assert(f.timers.size === 1)
    s.bufferedAmount = 0
    for (let n = 2; n <= 256; n++) f.submit({n})
    s.bufferedAmount = 65536
    f.submit({n: 257})
    assert(s.sent.length === 256 && f.timers.size === 0)
    s.message(JSON.stringify({type: 'error', id: 1, message: 'query failed'}))
    assert(f.errors.length === 1 && s.sent.length === 256 && f.timers.size === 1)
    s.bufferedAmount = 0
    assert(f.tick() === 16)
    assert(s.sent.length === 257 && s.sent[256].url === 'query:257')
    f.client.dispose()
})

Deno.test('congestion retains latest only and does not delay writable submissions', () => {
    const f = fixture()
    f.submit({n: 1})
    const s = f.sockets[0]
    s.open()
    s.bufferedAmount = 65536
    for (let n = 2; n <= 20; n++) f.submit({n})
    assert(s.sent.length === 1 && f.timers.size === 1)
    assert(f.tick() === 16 && f.timers.size === 1)
    s.bufferedAmount = 0
    f.tick()
    assert(s.sent.length === 2 && s.sent[1].url === 'query:20')
    s.bufferedAmount = 65536
    f.submit({n: 21})
    s.bufferedAmount = 0
    f.submit({n: 22})
    assert(s.sent.length === 3 && s.sent[2].url === 'query:22' && f.timers.size === 0)
    f.client.dispose()
})

Deno.test('reset and invalidate forget outstanding work without replacing the endpoint socket', () => {
    const f = fixture()
    f.submit({n: 1})
    const s = f.sockets[0]
    s.open()
    f.submit({n: 2}, {reset: true})
    s.message(frame(1))
    s.message(frame(2))
    assert(f.results.length === 1 && f.results[0].context.n === 2 && f.sockets.length === 1)
    s.bufferedAmount = 65536
    f.submit({n: 3})
    f.client.invalidate()
    assert(f.timers.size === 0 && !s.closed)
    s.bufferedAmount = 0
    f.submit({n: 4})
    assert(s.sent[2].id === 3)
    f.client.invalidate()
    s.message(frame(3))
    s.disconnect()
    assert(f.results.length === 1 && f.timers.size === 0 && f.errors.length === 0)
    f.client.dispose()
})

Deno.test('endpoint change closes old connection and guards already queued events', () => {
    const f = fixture()
    f.submit({n: 1})
    const old = f.sockets[0]
    old.open()
    const message = old.onmessage, close = old.onclose, open = old.onopen
    f.submit({n: 2}, {}, 'ws://two')
    assert(old.closed && old.onmessage === null && f.sockets.length === 2)
    message({data: frame(1)})
    close()
    open()
    const s = f.sockets[1]
    s.open()
    s.message(frame(s.sent[0].id))
    assert(f.results.length === 1 && f.results[0].context.n === 2 && f.timers.size === 0)
    f.client.dispose()
})

Deno.test('reconnect replays latest with fresh ID, bounds backoff, and reports once per outage', () => {
    const f = fixture()
    f.submit({n: 1})
    let s = f.sockets[0]
    s.open()
    f.submit({n: 2})
    s.onerror()
    assert(f.errors.length === 1 && f.errors[0].context.n === 2)
    f.submit({n: 3})
    assert(f.sockets.length === 1)
    for (const delay of [250, 500, 1000, 2000, 4000, 8000, 8000]) {
        assert(f.tick() === delay)
        s = f.sockets.at(-1)
        s.open()
        assert(s.sent.length === 1 && s.sent[0].url === 'query:3' && s.sent[0].id > 2)
        s.disconnect()
    }
    assert(f.errors.length === 1)
    f.tick()
    s = f.sockets.at(-1)
    s.open()
    s.message(frame(s.sent[0].id))
    assert(f.results[0].context.n === 3)
    s.disconnect()
    assert(f.errors.length === 2 && f.tick() === 250)
    f.client.dispose()
    assert(f.timers.size === 0)
})

Deno.test('send failures retry; disposal detaches callbacks and cancels all work', () => {
    const f = fixture()
    f.submit({n: 1})
    const s = f.sockets[0]
    s.sendError = new Error('send failed')
    s.open()
    assert(f.errors[0].error === s.sendError && f.timers.size === 1)
    f.client.dispose()
    f.client.dispose()
    assert(f.timers.size === 0 && s.closed && s.onopen === null)
    let threw = false
    try { f.submit({n: 2}) } catch { threw = true }
    assert(threw)
})

Deno.test('disposal while connecting or congested blocks captured late events', () => {
    for (const congested of [false, true]) {
        const f = fixture()
        f.submit({n: 1})
        const s = f.sockets[0]
        if (congested) {
            s.open()
            s.bufferedAmount = 65536
            f.submit({n: 2})
        }
        const open = s.onopen, message = s.onmessage, error = s.onerror
        f.client.dispose()
        open()
        message({data: frame(1)})
        error()
        assert(s.closed && f.timers.size === 0 && f.results.length === 0 && f.errors.length === 0)
        assert(s.sent.length === (congested ? 1 : 0))
    }
})

Deno.test('constructor failures retry without spam and invalidation cancels retry', () => {
    let retry, failures = 0, attempts = 0, cancelled = false
    const context = {}
    const client = createQuerySocket({
        WebSocketImpl: class { constructor() { attempts++; throw new Error('unavailable') } },
        onResult: () => { throw new Error('Unexpected result') },
        onError: (error, actual) => {
            assert(error.message === 'unavailable' && actual === context)
            failures++
        },
        setTimeout: fn => { retry = fn; return 0 },
        clearTimeout: id => { assert(id === 0); cancelled = true },
    })
    client.submit('ws://one', 'query', context)
    retry()
    assert(attempts === 2 && failures === 1)
    client.invalidate()
    assert(cancelled)
    retry()
    assert(attempts === 2)
    client.dispose()
})

Deno.test('suspend cancels work and late handlers but accepts fresh submissions', () => {
    for (const state of ['connecting', 'congested', 'reconnecting']) {
        const f = fixture()
        f.submit({n: 1})
        const old = f.sockets[0]
        const open = old.onopen, message = old.onmessage, error = old.onerror, close = old.onclose
        if (state !== 'connecting') {
            old.open()
            if (state === 'reconnecting') old.disconnect()
            else {
                old.bufferedAmount = 65536
                f.submit({n: 2})
            }
            assert(f.timers.size === 1)
        }
        const failures = f.errors.length
        f.client.suspend()
        f.client.suspend()
        assert(old.closed && old.onopen === null && old.onmessage === null && f.timers.size === 0)
        const context = {n: 3}
        f.submit(context)
        open()
        message({data: frame(1)})
        error()
        close()
        assert(f.results.length === 0 && f.errors.length === failures && f.timers.size === 0)
        const current = f.sockets[1]
        current.open()
        assert(current.sent.length === 1 && current.sent[0].url === 'query:3')
        current.message(frame(current.sent[0].id))
        assert(f.results.length === 1 && f.results[0].context === context)
        f.client.dispose()
    }
})
