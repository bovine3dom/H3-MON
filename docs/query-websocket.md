# Query WebSocket Protocol

## Configuration

Add `socket` to an `onclick` or `onmove` hook:

```json
{
  "onclick": {
    "socket": "wss://example.org/query",
    "url": "/data?index={index}",
    "resolution": 5
  }
}
```

Use an absolute `ws://` or `wss://` address for `socket`, without placeholders, credentials or a fragment.
Use `wss://` if the page uses HTTPS.

Use an HTTP(S) URL template for `url`. Do not include credentials or a fragment.
The client resolves relative URLs against the page's base URI, not the socket address.
It sends only the path and query string.
See [interaction endpoints](../readme.md#interaction-endpoints) for placeholders and movement settings.

Hooks with the same socket address share one connection.
The client closes the connection when the socket address changes.
Without `socket`, the client uses HTTP GET. It does not switch to HTTP after a socket failure.

## Request

Send each request as one JSON text message:

```json
{"type":"query","id":42,"url":"/data?index=851fb467fffffff"}
```

Use a JSON number from `1` to `4294967295` for `id`. Increase it for each request. You can skip numbers.
Do not reuse an ID on the same connection. Open a new connection before the ID exceeds the maximum.

The `url` contains a path and an optional query string, not a full URL.

## Response

For each processed request, send one result or one error. Do not send both or send partial results.

Send a result as one binary message:

| Bytes | Content |
|-------|---------|
| `0..3` | Request ID: unsigned 32-bit integer, big-endian byte order. |
| `4..end` | Complete Arrow IPC file or stream. |

Include the schema and all necessary dictionaries in each result.
Do not refer to data in earlier results. Do not send Arrow batches as separate WebSocket messages.
See [data format](../readme.md#data-format) for column and encoding requirements.

Send an error as one JSON text message. Use the request ID and a string for `message`:

```json
{"type":"error","id":42,"message":"Unsupported query path"}
```

The client ignores malformed responses and responses with unknown, duplicate or obsolete IDs.
No other application messages are required.

## Server Operation

Keep one active request and one pending request for each connection.

1. Start the calculation if no request is active.
2. If a request is active, keep the new request as pending. Replace any earlier pending request without a response.
3. Finish the active calculation. Do not restart it when a new request arrives.
4. Send the result or error. Then start the pending request, if present.
5. If the connection closes or a send fails, discard pending work and do not send further results.

Update request state serially. Run calculations asynchronously.

## Client Operation

After a connection failure, the client reconnects and sends the latest query with a new ID. Make queries safe to repeat.
While the connection opens or cannot accept more requests, the client keeps only the latest unsent query.

During movement, the client can display a result while a newer request is pending.
Clicks and changes to controls or query configuration cause the client to reject results from the previous query context.
They do not cancel calculations on the server.

A query error leaves the last successful dataset on display and lets the user select Retry.
It does not cause the client to reconnect.
