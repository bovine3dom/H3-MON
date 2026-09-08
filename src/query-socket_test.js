import {createQuerySocket} from './query-socket.js'

function assert(condition, message = 'Assertion failed') {
    if (!condition) throw new Error(message)
}

function frame(id) {
    const bytes = new Uint8Array([0, 0, 0, 0, 255, 0, 42])
    new DataView(bytes.buffer).setUint32(0, id, false)
    return bytes.buffer
}

function fixture() {
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
        send(value) { assert(this.readyState === 1); this.sent.push(JSON.parse(value)) }
        message(data) { this.onmessage?.({data}) }
        close() { this.readyState = 3 }
        disconnect() { this.close(); this.onclose?.() }
    }
    const client = createQuerySocket({
        WebSocketImpl: Socket,
        onResult: (bytes, context) => results.push({bytes, context}),
        onError: (error, context) => errors.push({error, context}),
        setTimeout: (fn, delay) => { timers.set(++timerId, {fn, delay}); return timerId },
        clearTimeout: id => timers.delete(id),
    })
    function tick() {
        assert(timers.size === 1)
        const [id, {fn, delay}] = timers.entries().next().value
        timers.delete(id)
        fn()
        return delay
    }
    const submit = n => client.submit('ws://example.test', `query:${n}`, {n})
    return {client, submit, sockets, timers, results, errors, tick}
}

Deno.test('connecting coalesces and ordered results preserve binary payloads, ignoring stale frames', () => {
    const f = fixture()
    f.submit(0)
    f.submit(1)
    const s = f.sockets[0]
    assert(f.sockets.length === 1 && s.sent.length === 0 && s.binaryType === 'arraybuffer')
    s.open()
    assert(JSON.stringify(s.sent[0]) === JSON.stringify({type: 'query', id: 1, url: 'query:1'}))
    f.submit(2)
    s.message(frame(1))
    assert(f.results[0].context.n === 1 && [...f.results[0].bytes].join() === '255,0,42')
    for (const data of ['{', new ArrayBuffer(3), frame(999)]) s.message(data)
    s.message(JSON.stringify({type: 'error', id: 2, message: 'bad query'}))
    s.message(frame(1))
    s.message(frame(2))
    assert(f.results.length === 1 && f.errors.length === 1)
    assert(f.errors[0].context.n === 2 && f.errors[0].error.message === 'bad query')
    f.client.dispose()
})

Deno.test('actual capacity retains only the latest pending query without starving results', () => {
    const f = fixture()
    f.submit(0)
    const s = f.sockets[0]
    s.open()
    for (let n = 1; n <= 1600; n++) f.submit(n)
    assert(s.sent.length === 256 && f.timers.size === 0)
    s.message(frame(999))
    assert(s.sent.length === 256)
    s.message(frame(1))
    assert(f.results[0].context.n === 0)
    assert(s.sent.length === 257 && s.sent[256].url === 'query:1600')
    s.message(frame(257))
    s.message(frame(256))
    assert(f.results.length === 2 && f.results[1].context.n === 1600)
    f.client.dispose()
})

Deno.test('byte backpressure polls latest work; invalidation and disposal cancel it', () => {
    const f = fixture()
    f.submit(1)
    const s = f.sockets[0]
    s.open()
    s.bufferedAmount = 65536
    f.submit(2)
    f.submit(3)
    assert(s.sent.length === 1 && f.tick() === 16 && f.timers.size === 1)
    s.bufferedAmount = 0
    f.tick()
    assert(s.sent.length === 2 && s.sent[1].url === 'query:3')
    s.bufferedAmount = 65536
    f.submit(4)
    f.client.invalidate()
    s.message(frame(2))
    assert(f.results.length === 0 && f.timers.size === 0 && s.readyState === 1)
    f.submit(5)
    const lateMessage = s.onmessage
    f.client.dispose()
    lateMessage({data: frame(1)})
    assert(s.readyState === 3 && s.onmessage === null && f.timers.size === 0 && f.results.length === 0)
    let threw = false
    try { f.submit(6) } catch { threw = true }
    assert(threw)
})

Deno.test('reconnect sends latest with a fresh ID and rejects old-connection delivery', () => {
    const f = fixture()
    f.submit(1)
    const old = f.sockets[0]
    old.open()
    const lateMessage = old.onmessage
    old.disconnect()
    f.submit(2)
    assert(f.errors.length === 1 && f.sockets.length === 1 && f.tick() === 250)
    const current = f.sockets[1]
    current.open()
    assert(current.sent.length === 1 && current.sent[0].url === 'query:2' && current.sent[0].id > 1)
    lateMessage({data: frame(1)})
    current.message(frame(current.sent[0].id))
    assert(f.results.length === 1 && f.results[0].context.n === 2)
    current.disconnect()
    assert(f.errors.length === 2)
    f.client.dispose()
    assert(f.timers.size === 0)
})
