// Compose query, settings and camera edits before the next history write.
export function createURLState(browser, wait = 150) {
    let pending = null
    let timer = null
    let lastWrite = -Infinity
    let observedURL = browser.location.href

    const cancel = () => {
        browser.clearTimeout(timer)
        timer = null
        pending = null
    }
    const read = () => {
        if (browser.location.href !== observedURL) cancel()
        observedURL = browser.location.href
        return new URL(pending ?? observedURL)
    }
    const write = () => {
        const url = read().href
        cancel()
        if (url === browser.location.href) return
        browser.history.replaceState(browser.history.state, '', url)
        observedURL = browser.location.href
        lastWrite = browser.performance.now()
    }
    const replace = url => {
        pending = url.href
        if (timer !== null) return
        const delay = lastWrite + wait - browser.performance.now()
        if (delay <= 0) write()
        else timer = browser.setTimeout(write, delay)
    }
    for (const event of ['popstate', 'hashchange', 'pagehide']) browser.addEventListener(event, cancel)
    return {read, replace}
}
