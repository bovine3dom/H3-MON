# Query WebSocket Protocol

An optional transport for metadata `onclick` and `onmove` hooks. This protocol is
independent of the development file-watcher socket. No query backend is bundled.

## Configuration

```json
{
  "onclick": {
    "socket": "wss://example.org/query",
    "url": "/data?index={index}",
    "resolution": 5
  }
}
```

`socket` is an absolute `ws://` or `wss://` URL without templates, fragments or
embedded credentials. Use `wss://` on HTTPS pages; it is not upgraded automatically.
`url` remains an HTTP(S)-style template without credentials or fragments. Relative
URLs resolve against the document base URI, not the socket endpoint. Only the
resolved path and query string are sent; the URL's origin is not a fetch target.
See [interaction endpoints](../readme.md#interaction-endpoints) for tokens and controls.

The same configuration works for `onmove`. Matching hooks reuse one connection.
Changing the endpoint closes the old connection. Omitting `socket` selects HTTP GET;
socket failure does not fall back to HTTP. The hook's `wait` controls movement scheduling.

## Messages

Each request is one WebSocket **text message** containing JSON:

```json
{"type":"query","id":42,"url":"/data?index=851fb467fffffff"}
```

`id` is a nonzero unsigned 32-bit integer (`1` through `4294967295`) encoded as a
JSON number. IDs increase, need not be contiguous and are never reused on a
connection; the client reconnects before wraparound. IDs are connection-local
correlation values. `url` is a path plus optional query string, not a full URL.

Success is one WebSocket **binary message**:

| Bytes | Contents |
|-------|----------|
| `0..3` | Request ID as unsigned 32-bit **big endian** (network byte order). |
| `4..end` | One complete, independently decodable Arrow IPC file or stream. |

Each payload includes its own schema and any required dictionaries; it cannot
depend on previous responses. Send the entire result in one WebSocket message,
not separate messages per Arrow batch. Required columns and reader compatibility
are described in [data format](../readme.md#data-format).

Failure is one WebSocket **text message**, with a matching ID and string message:

```json
{"type":"error","id":42,"message":"Unsupported query path"}
```

Send either one complete result or one error per processed ID, never progressive
results or both. Skipped pending queries need no reply. No application handshake,
acknowledgement, `done`, `cancel` or subscription message is required.
Malformed messages and unknown, duplicate or obsolete IDs are ignored.

## Server Scheduling

Keep one active calculation and one newest pending query per connection. Finish
active work even when movement submits newer queries; replace only the pending slot.
Serialize state changes while allowing calculation to run asynchronously:

```text
on valid query(q):
    pending = q
    start_if_idle()

start_if_idle():
    if closed or active or pending is empty: return
    active, pending = pending, empty
    calculate active asynchronously
    on completion:
        if closed: return
        send uint32_big_endian(active.id) + complete Arrow, or JSON error
        on send failure: close connection and discard pending work; return
        active = empty
        start_if_idle()

on close: discard pending work and any eventual active result
```

Connection failures replay the latest query with a new ID, so queries should be safe to repeat.
Movement can display a trailing result while newer work is pending. Explicit
clicks, changed controls and query-context changes invalidate obsolete client work
without cancelling server calculations. While connecting or congested, the client
keeps only the latest unsent query. Query errors retain the last good dataset and
offer Retry; they do not automatically reconnect a healthy socket.
Shared links store query context and raw controls, not socket IDs or Arrow results;
see [shared links](../readme.md#request-controls-and-shared-links).
