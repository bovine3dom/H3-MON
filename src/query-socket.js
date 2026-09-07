// See docs/query-websocket.md for framing, scheduling and reconnect semantics.
// submit() is synchronous; callbacks receive the supplied context by reference.
// Results are Uint8Array Arrow IPC bytes; decoding belongs to the caller.
export function createQuerySocket({
    onResult,
    onError = () => {},
    WebSocketImpl = globalThis.WebSocket,
    setTimeout: schedule = globalThis.setTimeout,
    clearTimeout: cancel = globalThis.clearTimeout,
} = {}) {
    if (typeof onResult !== 'function' || typeof onError !== 'function') {
        throw new TypeError('Query socket callbacks must be functions')
    }
    const pending = new Map()
    let socket = null
    let endpoint
    let latest = null
    let queued = null
    let timer = null
    let nextId = 1
    let retryDelay = 250
    let reportedFailure = false
    let disposed = false

    function clearTimer() {
        if (timer !== null) cancel(timer)
        timer = null
    }

    function closeSocket() {
        const old = socket
        socket = null
        if (!old) return
        old.onopen = old.onmessage = old.onerror = old.onclose = null
        old.close()
    }

    function invalidate() {
        latest = queued = null
        pending.clear()
        clearTimer()
        retryDelay = 250
        reportedFailure = false
    }

    function suspend() {
        invalidate()
        closeSocket()
        endpoint = undefined
    }

    function fail(error) {
        closeSocket()
        pending.clear()
        clearTimer()
        queued = latest
        if (!latest || disposed) return
        timer = schedule(() => {
            timer = null
            connect()
        }, retryDelay)
        retryDelay = Math.min(retryDelay * 2, 8000)
        if (!reportedFailure) {
            reportedFailure = true
            onError(error, latest.context)
        }
    }

    function receive(data) {
        let id, bytes, error
        if (data instanceof ArrayBuffer) {
            if (data.byteLength <= 4) return
            id = new DataView(data).getUint32(0, false)
            bytes = new Uint8Array(data, 4)
        } else if (typeof data === 'string') {
            let message
            try { message = JSON.parse(data) } catch { return }
            if (!message || message.type !== 'error' || typeof message.message !== 'string') return
            id = message.id
            if (!Number.isInteger(id) || id < 0 || id > 0xffffffff) return
            error = new Error(message.message)
        } else return
        const request = pending.get(id)
        if (!request) return
        // Removing older entries also prevents out-of-order delivery and duplicates.
        for (const key of pending.keys()) {
            if (key > id) break
            pending.delete(key)
        }
        retryDelay = 250
        reportedFailure = false
        try {
            if (error) onError(error, request.context)
            else onResult(bytes, request.context)
        } finally {
            // Callbacks may reset, suspend, dispose, or replace the queued query.
            flush()
        }
    }

    function connect() {
        if (disposed || !latest || socket) return
        let current
        try {
            current = new WebSocketImpl(endpoint)
        } catch (error) {
            fail(error)
            return
        }
        socket = current
        current.binaryType = 'arraybuffer'
        current.onopen = () => { if (socket === current) flush() }
        current.onmessage = event => { if (socket === current) receive(event.data) }
        current.onerror = () => {
            if (socket === current) fail(new Error('Query WebSocket connection failed'))
        }
        current.onclose = () => {
            if (socket === current) fail(new Error('Query WebSocket connection closed'))
        }
    }

    function flush() {
        if (!queued || !socket || socket.readyState === 0) return
        if (socket.readyState !== 1) {
            fail(new Error('Query WebSocket is not open'))
            return
        }
        clearTimer()
        if (pending.size >= 256) return
        // WebSocket has no drain event. Poll only while congested, never throttle
        // an open, writable socket. One message may exceed this byte threshold.
        if (socket.bufferedAmount >= 65536) {
            timer = schedule(() => { timer = null; flush() }, 16)
            return
        }
        // Never reuse an ID on the same connection, including across resets.
        if (nextId > 0xffffffff) {
            closeSocket()
            pending.clear()
            nextId = 1
            connect()
            return
        }
        const id = nextId++
        const request = queued
        try {
            socket.send(JSON.stringify({type: 'query', id, url: request.url}))
        } catch (error) {
            fail(error)
            return
        }
        queued = null
        pending.set(id, request)
    }

    return {
        submit(socketURL, url, context, {reset = false} = {}) {
            if (disposed) throw new Error('Query socket is disposed')
            if (typeof socketURL !== 'string' || !socketURL || typeof url !== 'string') {
                throw new TypeError('Socket URL and query URL must be strings')
            }
            if (endpoint !== socketURL) {
                suspend()
                endpoint = socketURL
            } else if (reset) invalidate()
            latest = queued = {url, context}
            if (socket) flush()
            else if (timer === null) connect()
        },
        invalidate,
        suspend,
        dispose() {
            disposed = true
            suspend()
        },
    }
}
