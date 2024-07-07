import {serveDir} from "https://deno.land/std@0.224.0/http/file_server.ts"

// web socket for watching CSV
Deno.serve({port: 1990}, (req) => {
    if (req.headers.get("upgrade") != "websocket") {
        return new Response(null, { status: 501 })
    }

    const { socket, response } = Deno.upgradeWebSocket(req)

    socket.addEventListener("open", () => {
        console.log("a client connected!")
    })

    socket.addEventListener("message", (event) => {
        if (event.data === "ping") {
            socket.send("pong")
        }
    })

    // Loop over file system events
    async function watchcsv() {
        const watcher = Deno.watchFs(`${Deno.cwd()}/www/data/h3_data.csv`)
        for await (const event of watcher) {
            // Filter out "access" and "any" events to reduce unnecessary refreshes
            if (event.kind === "access" || event.kind === "any") {
                continue
            }
            if (event.kind === "modify") {
                // Refresh or reload your application
                console.log("File modified, reloading...") // should add a timeout here because it gets spammed sometimes
                socket.send("file changed")
            }

            if (event.kind === "remove") {
                // restart the watcher because it breaks for some reason
                console.log("File modified, reloading...")
                watcher.close()
                await watchcsv()
            }
        }
    }
    watchcsv()

    return response
})

// file server
Deno.serve({port:1983}, req => {
    return serveDir(req, {fsRoot: `${Deno.cwd()}/www/`})
})
