import { serveDir } from "https://deno.land/std@0.224.0/http/file_server.ts";
import { debounce } from "https://deno.land/std@0.224.0/async/debounce.ts";
import { delay } from "https://deno.land/std@0.224.0/async/delay.ts"; // <-- Import delay
import { resolve, normalize } from "https://deno.land/std@0.224.0/path/mod.ts";

const WS_PORT = 1990;
const HTTP_PORT = 1983;
const WATCH_DIR_NAME = "data";
const DEBOUNCE_MS = 200;
const OVERWRITE_CHECK_DELAY_MS = 300; // Delay in ms to wait after remove event
const BASE_WWW_PATH = resolve(Deno.cwd(), "www");
const WATCH_DIR_PATH = resolve(BASE_WWW_PATH, WATCH_DIR_NAME);

console.log(`Serving files from: ${BASE_WWW_PATH}`);
console.log(`Watching files within: ${WATCH_DIR_PATH}`);
console.log(`WebSocket server running on port ${WS_PORT}`);
console.log(`HTTP server running on port ${HTTP_PORT}`);

const fileSubscriptions = new Map<string, Set<WebSocket>>();
const fileWatchers = new Map<string, Deno.FsWatcher>();
const debouncedNotifiers = new Map<string, () => void>();
const clientWatchTargets = new Map<WebSocket, string>();


// check for .. etc
async function validateAndResolvePath(relativePath: string): Promise<string | null> {
    try {
        const normalizedRelativePath = normalize(relativePath);
        if (normalizedRelativePath.startsWith("..") || normalizedRelativePath.startsWith("/")) {
             console.warn(`Rejected invalid path navigation: ${relativePath}`);
             return null;
        }
        const absolutePath = resolve(WATCH_DIR_PATH, normalizedRelativePath);
        if (!absolutePath.startsWith(WATCH_DIR_PATH)) {
            console.warn(`Rejected path outside watch directory: ${relativePath} -> ${absolutePath}`);
            return null;
        }
        return absolutePath;
    } catch (error) {
        console.error(`Error resolving path "${relativePath}":`, error);
        return null;
    }
}


// Starts watching a file if it's not already being watched (or restarts it)
async function ensureFileWatcher(filePath: string) {
    if (fileWatchers.has(filePath)) {
        return; 
    }

    console.log(`Starting watcher for: ${filePath}`);
    try {
        const watcher = Deno.watchFs(filePath);
        fileWatchers.set(filePath, watcher);

        const debouncedSend = debounce(() => {
            const subscribers = fileSubscriptions.get(filePath);
            if (!subscribers || subscribers.size === 0) {
                return;
            }

            console.log(`Debounced: Notifying ${subscribers.size} clients about change in: ${filePath}`);
            const message = `change:${filePath.replace(BASE_WWW_PATH, "")}`; // Send relative path

            // Make a copy in case a socket disconnects during iteration
            const subscribersSnapshot = new Set(subscribers);
            for (const socket of subscribersSnapshot) {
                if (fileSubscriptions.get(filePath)?.has(socket) && socket.readyState === WebSocket.OPEN) {
                    socket.send(message);
                } else {
                     console.log("Skipping send to client with non-OPEN state or no longer subscribed.");
                }
            }
        }, DEBOUNCE_MS);
        debouncedNotifiers.set(filePath, debouncedSend);

        (async () => {
            console.log(`Watcher event loop started for ${filePath}`);
            try {
                 for await (const event of watcher) {
                    // Filter out "access" and "any" events
                    if (event.kind === "access" || event.kind === "any") {
                        continue;
                    }

                    if (event.kind === "modify") {
                        console.log(`File modified: ${filePath}`);
                        debouncedNotifiers.get(filePath)?.();
                    }

                    // sometimes modified files get removed then recreated, so check for that
                    if (event.kind === "remove") {
                        console.log(`File remove event detected: ${filePath}. Checking for overwrite within ${OVERWRITE_CHECK_DELAY_MS}ms...`);
                        const subscribersSnapshot = new Set(fileSubscriptions.get(filePath) ?? []);
                        try {
                            watcher.close();
                        } catch (e) { console.warn(`Non-critical error closing watcher during remove handling for ${filePath}: ${e.message}`); }
                        fileWatchers.delete(filePath);
                        debouncedNotifiers.delete(filePath);

                        await delay(OVERWRITE_CHECK_DELAY_MS);

                        let fileExists = false;
                        try {
                            await Deno.stat(filePath);
                            fileExists = true;
                        } catch (error) {
                            if (error instanceof Deno.errors.NotFound) {
                                // genuinely gone :(
                            } else {
                                console.error(`Error checking file existence for ${filePath} post-remove:`, error);
                            }
                            fileExists = false;
                        }

                        if (fileExists) {
                            console.log(`File reappeared (likely overwrite): ${filePath}. Restarting watcher and notifying modify.`);
                            await ensureFileWatcher(filePath);

                            const newDebouncer = debouncedNotifiers.get(filePath);
                            if (newDebouncer) {
                                newDebouncer();
                            } else {
                                console.warn(`Could not find new debouncer for ${filePath} after restarting watcher. Manually notifying.`);
                                const message = `change:${filePath.replace(BASE_WWW_PATH, "")}`;
                                for (const socket of subscribersSnapshot) {
                                    if (fileSubscriptions.get(filePath)?.has(socket) && socket.readyState === WebSocket.OPEN) {
                                        socket.send(message);
                                    }
                                }
                            }
                        } else {
                            console.log(`File confirmed removed: ${filePath}. Notifying clients.`);
                            if (subscribersSnapshot.size > 0) {
                                const removeMsg = `remove:${filePath.replace(BASE_WWW_PATH, "")}`;
                                for (const socket of subscribersSnapshot) {
                                    if (clientWatchTargets.get(socket) === filePath) {
                                        if (socket.readyState === WebSocket.OPEN) {
                                            socket.send(removeMsg);
                                        }
                                        clientWatchTargets.delete(socket);
                                    }
                                }
                            }
                            fileSubscriptions.delete(filePath);
                            console.log(`Subscriptions list cleaned for removed file: ${filePath}`);
                        }

                        console.log(`Exiting event loop for closed watcher instance of ${filePath} after remove/overwrite check.`);
                        break;
                    }
                 }
            } catch (error) {
                 console.error(`Error in watcher loop for ${filePath}:`, error);
                 try { watcher.close(); } catch(e) { /* ;) */ }
                 fileWatchers.delete(filePath);
                 debouncedNotifiers.delete(filePath);

                 const subscribers = fileSubscriptions.get(filePath);
                 if (subscribers) {
                       const errorMsg = `error:${filePath.replace(BASE_WWW_PATH, "")}:WatcherFailed`;
                       const subsSnapshot = new Set(subscribers);
                       fileSubscriptions.delete(filePath);
                       for (const socket of subsSnapshot) {
                           if (socket.readyState === WebSocket.OPEN) socket.send(errorMsg);
                           clientWatchTargets.delete(socket);
                       }
                 }
            } finally {
                console.log(`Watcher loop processing finished for an instance of ${filePath}`);
                 if (fileWatchers.get(filePath) === watcher) {
                     console.warn(`Watcher loop ended for ${filePath} but watcher was still in map. Cleaning up.`);
                     try { watcher.close(); } catch(e) { /* 😎 */ }
                     fileWatchers.delete(filePath);
                     debouncedNotifiers.delete(filePath);
                 }
            }
        })();

    } catch (error) {
        console.error(`Failed to start watcher for ${filePath}:`, error);
        fileWatchers.delete(filePath);
        debouncedNotifiers.delete(filePath);

        const subscribers = fileSubscriptions.get(filePath);
        if(subscribers) {
            const errorMsg = `error:${filePath.replace(BASE_WWW_PATH, "")}:FailedToWatch`;
            const subsSnapshot = new Set(subscribers);
            fileSubscriptions.delete(filePath);
            for(const socket of subsSnapshot) {
                 if (socket.readyState === WebSocket.OPEN) socket.send(errorMsg);
                 clientWatchTargets.delete(socket);
            }
        }
    }
}

function removeSubscription(socket: WebSocket) {
    const watchingFilePath = clientWatchTargets.get(socket);
    if (!watchingFilePath) return;

    clientWatchTargets.delete(socket);

    const subscribers = fileSubscriptions.get(watchingFilePath);
    if (subscribers) {
        subscribers.delete(socket);
        console.log(`Client removed. Remaining subscribers for ${watchingFilePath}: ${subscribers.size}`);

        if (subscribers.size === 0) {
            console.log(`Last client disconnected for ${watchingFilePath}. Stopping watcher.`);
            fileSubscriptions.delete(watchingFilePath);

            const watcher = fileWatchers.get(watchingFilePath);
            if (watcher) {
                 try {
                    watcher.close();
                 } catch (e) { console.warn(`Non-critical error closing watcher during unsubscribe cleanup for ${watchingFilePath}: ${e.message}`); }
                 fileWatchers.delete(watchingFilePath);
            }
            debouncedNotifiers.delete(watchingFilePath);
        }
    }
}


Deno.serve({ port: WS_PORT }, (req) => {
    if (req.headers.get("upgrade") !== "websocket") {
        return new Response("Expected websocket upgrade", { status: 400 });
    }
    const { socket, response } = Deno.upgradeWebSocket(req);

    socket.addEventListener("open", () => console.log("Client connected. Waiting for 'watch:' message."));

    socket.addEventListener("message", async (event) => {
        const message = event.data;
        if (message === "ping") {
            if (socket.readyState === WebSocket.OPEN) socket.send("pong");
            return;
        }

        if (typeof message === "string" && message.startsWith("watch:")) {
            const requestedRelativePath = message.substring("watch:".length).trim();
            console.log(`Client requested watch for: ${requestedRelativePath}`);

            const absolutePath = await validateAndResolvePath(requestedRelativePath);
            if (!absolutePath) {
                if (socket.readyState === WebSocket.OPEN) socket.send(`error:Invalid path: ${requestedRelativePath}`);
                return;
            }

            removeSubscription(socket);

            if (!fileSubscriptions.has(absolutePath)) {
                fileSubscriptions.set(absolutePath, new Set());
            }
            fileSubscriptions.get(absolutePath)?.add(socket);
            clientWatchTargets.set(socket, absolutePath);

            console.log(`Client now watching: ${absolutePath}. Total subscribers: ${fileSubscriptions.get(absolutePath)?.size}`);

            await ensureFileWatcher(absolutePath);

             if (socket.readyState === WebSocket.OPEN) {
                 const relativePathForClient = absolutePath.replace(BASE_WWW_PATH, "");
                 socket.send(`watching:${relativePathForClient}`);
             }

        } else {
            console.log("Received unknown message:", message);
             if (socket.readyState === WebSocket.OPEN) socket.send("error:Unknown command");
        }
    });

    socket.addEventListener("close", () => {
        console.log("Client disconnected.");
        removeSubscription(socket);
    });

    socket.addEventListener("error", (event) => {
        console.error("WebSocket error:", event instanceof ErrorEvent ? event.message : event.type);
        removeSubscription(socket);
    });

    return response;
});


Deno.serve({ port: HTTP_PORT }, (req) => {
    return serveDir(req, {
        fsRoot: BASE_WWW_PATH,
        //urlRoot: "",
        //enableCors: true,
        quiet: false, // shh
    });
});
