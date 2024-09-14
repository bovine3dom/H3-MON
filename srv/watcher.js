import {serveDir} from "https://deno.land/std@0.224.0/http/file_server.ts"

// file server
Deno.serve({port:1983}, req => {
    return serveDir(req, {fsRoot: `${Deno.cwd()}/www/`})
})
