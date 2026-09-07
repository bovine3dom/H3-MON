# Query WebSocket Protocol

This specifies the client implemented in [`src/query-socket.js`](../src/query-socket.js),
[`src/interactions.js`](../src/interactions.js) and [`src/app.js`](../src/app.js).
No query WebSocket backend implementation is included. The server pseudocode below
is language-agnostic implementation guidance, not a bundled service.

## Configuration

Metadata `onclick` and `onmove` hooks require `url` and optionally accept `socket`:

```json
{
  "onclick": {
    "socket": "wss://api.example.com/query",
    "url": "/reachable?index={index}&budget_s=10800&encoding=split",
    "resolution": 5,
    "focus": false,
    "highlight": true
  },
  "onmove": {
    "socket": "wss://api.example.com/query",
    "url": "/reachable?index={index}&budget_s=10800&encoding=split",
    "resolution": 5,
    "wait": 0
  }
}
```

- `socket` must be an absolute `ws://` or `wss://` URL, without templates, fragments
  or embedded username/password. The client normalizes it as a URL.
- `url` remains an HTTP(S)-style template, without embedded credentials. Relative
  URLs resolve against the document base URI, not the socket endpoint. Socket queries
  reject fragments. After substitution, only `pathname + search` is transmitted:
  `https://other.example/reachable?index=abc` sends `/reachable?index=abc` to the
  configured socket. It does not fetch `other.example`.
- Supported tokens are `{index}`, `{index_lower}`, `{index_upper}`, `{lat}`, `{lng}`,
  `{zoom}` and `{controls.<id>}`. Values are URL-encoded; unknown/missing tokens are
  errors. See [interaction endpoints](../readme.md#interaction-endpoints) for H3,
  focus/highlight and control semantics.
- `wait` is a finite number from `0` to `60000` milliseconds. It defaults to `0`
  with `socket`, or `350` without it. Zero bypasses movement scheduling; positive
  values use leading throttle-debounce with a trailing latest position. Clicks and
  manual replay bypass movement scheduling. Controls retain their separate 350 ms
  trailing debounce. Unchanged automatic query contexts are deduplicated.
- Omitting `socket` selects HTTP GET. Socket failure does not fall back to HTTP.

There is one query lane and at most one active query endpoint connection per app,
not a connection pool. Matching `onclick` and `onmove` endpoints reuse the connection.
Changing the socket endpoint closes the old connection and forgets its requests.
This protocol is separate from the development file-watcher socket on port 1990;
its `ping` and `watch:` messages do not belong here.

## Messages

Each request is one WebSocket **text message** containing JSON:

```json
{"type":"query","id":42,"url":"/reachable?index=851fb467fffffff&budget_s=10800&encoding=split"}
```

`id` is a nonzero unsigned 32-bit integer (`1` through `4294967295`), represented as
a JSON number. IDs increase as messages are sent, are not reused on a connection,
and need not be contiguous. Before wrapping, the client opens a new connection and
restarts at `1`. Treat IDs as connection-local correlation values, not user/session
identifiers or exactly-once execution keys. `url` is a path plus optional query string.
No click/move flag or client context is sent separately.

A successful query produces one WebSocket **binary message**:

| Byte Offset | Contents |
|-------------|----------|
| `0..3` | The request ID as uint32, **big endian** (network byte order). |
| `4..end` | One complete, independently decodable Arrow IPC file or stream. |

For ID `42`, the prefix is hexadecimal `00 00 00 2a`, followed immediately by Arrow
bytes. The prefix is not part of Arrow. Include the complete schema and any required
dictionaries in each payload; do not rely on a preceding response. Send the entire
payload as one WebSocket message, not separate messages per Arrow batch or chunk.
The dataset needs `value` and either string `index` or unsigned `index_lower` and
`index_upper` columns. Follow the [existing reader compatibility guidance](../readme.md#rail-routing-example):
uncompressed IPC and non-dictionary-encoded string columns.

A failed query instead produces one WebSocket **text message**:

```json
{"type":"error","id":42,"message":"Unsupported query path"}
```

`message` must be a string and `id` must identify the request. Send either the full
binary result or the JSON error, never both and never multiple progressive results
for an ID. Pending queries skipped by latest-only scheduling need no response.
There is no application `hello`, acknowledgement, `done`, `cancel`, subscription,
or protocol negotiation message required by this client.

Malformed frames, unrecognized text messages and unknown IDs are silently ignored.
This includes zero, duplicate, superseded and invalidated IDs. A recognized reply
(success or query error) frees all retained contexts with IDs less than or equal to
the received ID, so older replies arriving afterward are ignored too. After delivering
the reply callback, the client flushes the latest queued query if capacity permits.
Framing validation does not validate Arrow: decoding failures are handled by the app's
error path.

## Server Scheduling

Use one active calculation plus **one newest pending query per connection**. Finish
the active calculation and send its result even if newer movement arrived. Replace
the pending slot on every new query. Do not cancel and restart active work on every
motion: sustained movement could otherwise prevent any result from completing.

The following pseudocode assumes connection events and completion callbacks execute
serially (or under an equivalent lock). Calculation runs asynchronously so incoming
messages can replace the pending slot. `validate_and_authorize` checks the message,
path, parameters and caller permissions before any work is scheduled.

```text
on connection accepted:
    closed = false
    active = null
    pending = null

on text message received(text):
    query = validate_and_authorize(text)
    # Invalid requests: send a correlated error if a valid ID is available;
    # otherwise reject/close according to server policy. Do not enqueue them.
    if query is invalid: return
    pending = query                    # discard the previous pending query
    start_if_idle()

start_if_idle():
    if closed or active != null or pending == null: return
    active = pending
    pending = null
    query = active                     # capture this exact query for completion
    asynchronously calculate_and_encode_full_arrow(query.url), then:
        on serialized completion(outcome):
            if closed: return
            if outcome succeeded:
                send_binary(uint32_big_endian(query.id) + outcome.arrow_bytes)
            else:
                send_text(JSON({type: "error", id: query.id,
                                message: safe_error_message(outcome)}))
            # If sending fails, close/clean up instead of starting more work.
            active = null
            start_if_idle()

on connection closed or send failure:
    closed = true
    pending = null
    release connection resources
    stop active work if supported, or discard its eventual completion
```

For example, while `42` runs, arrivals `43`, `44`, `45` replace the pending slot.
Send the result for `42`, then calculate `45`; no response is needed for `43` or `44`.
An error for `42` also releases the active slot so `45` can run. Never wait for client
acknowledgements or contiguous IDs. Reconnects can repeat a calculation, so queries
should be read-only or otherwise safe to replay. Bound server resources and outbound
queues independently; the client's send threshold is not server flow control.

## Results And Lifetime

Sending a newer movement query does not by itself suppress an older reply. A
slightly trailing result can display while newer work is pending, provided its
context is still retained and no newer reply has superseded it. Rendering similarly
finishes an active result while retaining only the newest waiting result. This is
not a guarantee that every result will display or a bound on result age.

Explicit clicks, manual Retry/replay, changed control inputs, switching hook context
(including click to movement), and endpoint/transport changes invalidate old client
contexts. Old replies cannot restore that earlier selection or dataset. Invalidation
forgets requests and queued results and aborts obsolete client loading; it does not
send cancellation or stop server calculations. Same-endpoint invalidation keeps the
socket open. Invalid interaction configuration also invalidates outstanding work.
Presentation-only settings need not invalidate the query.

The connection opens lazily on the first query and remains open after a response.
On connection creation, send, error or close failure, the client clears on-wire
contexts and retries with exponential delays of `250 ms`, `500 ms`, `1 s`, `2 s`,
`4 s`, then at most `8 s`. Only the latest submitted query is replayed with a new ID;
new submissions replace that replay candidate during the wait. Even an already
answered latest query can be replayed after a later disconnect. A recognized reply
(success or query error), or invalidation, resets backoff to `250 ms`. Merely opening
the connection does not reset backoff. There is no retry-count limit.

Connection failures are reported once until a recognized reply or reset. A server
query error does not reconnect or automatically resend that query on the healthy
socket. The app shows errors only for its latest socket source, retains the previous
good dataset and offers Retry. Retry resubmits the last interaction as a fresh manual
query. Successful displayed results update the title and selection; pending or failed
queries do not. On `pagehide`, the app cancels pending interaction delivery, invalidates
socket work and clears request status. For the back/forward cache (`event.persisted`),
it suspends the transport, closing the connection and cancelling retry timers without
permanently disposing it. A persisted `pageshow` replays the last query, if one exists.
Non-persisted `pagehide` permanently disposes the transport.

The client has a **256 outstanding on-wire context window**, plus the latest query.
At capacity, it stops sending and coalesces submissions into one latest unsent query;
it does not evict outstanding contexts. A recognized reply frees window capacity and
triggers a flush. Keeping contexts prevents result starvation during long computations
and sustained movement, without a time-based transport throttle.
While connecting or congested, the client also keeps only the latest unsent query.
At `bufferedAmount >= 65536` (64 KiB), sending waits and polls every `16 ms` until
writable. One message may exceed this threshold. Polling happens only during byte
congestion, not while waiting for window capacity. An open, writable socket sends
immediately when the window has space. These limits do not bound response sizes or
server resources, and there is no separate acknowledgement/credit message.

There is no application query timeout, heartbeat/liveness deadline, progressive
result assembly, or automatic retry of malformed/undecodable responses. A server
that stays connected without responding can leave a query waiting indefinitely.

## Sharing And Security

Shared links store the query origin/event/zoom and raw `p.<id>` control values, not
socket IDs, connections or Arrow results. Replay uses the dataset's declared metadata
hook, including its `socket`, even if the automatic hook is disabled. It preserves
the saved camera rather than repeating click focus. The recipient must still have
access to the metadata, endpoint and required authentication. See [shared links](../readme.md#request-controls-and-shared-links).

- Use `wss://` from HTTPS pages; a `ws://` endpoint is not upgraded automatically.
- Validate the browser handshake `Origin` against an explicit allowlist on the server.
  Do not treat HTTP CORS configuration as WebSocket authorization or Origin as identity.
- Authenticate connections and authorize every dispatched query. The current client
  has no custom authentication message or configurable request headers; arrange
  authentication at the handshake/deployment layer, for example a suitable session.
- Dispatch the supplied path to allowlisted server handlers. Do not interpret it as
  an arbitrary fetch target, filesystem path or executable query. Validate parameters,
  resource limits and access rights even though the normal client validates its inputs.
- Do not put shared secrets in metadata, socket URLs, hook URLs or control values:
  these can be exposed through shared links, browser history and logs. URL-embedded
  username/password is rejected, but query parameters are not a secret store.
- Return safe error messages without credentials or internal details. Trust metadata
  as application code when using control converters, as described in the README.
