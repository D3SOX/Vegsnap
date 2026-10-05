package org.veguide.android

import kotlinx.coroutines.delay
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONObject

/** OFF product API allows 15 reads/minute/IP. Shared by passive scans and every queued check. */
class OpenFactsProductRequests(private val now: () -> Long = { System.nanoTime() / 1_000_000 },
    private val wait: suspend (Long) -> Unit = { delay(it) }) {
    private data class Cached(val json: String?, val until: Long)
    private val lock = Mutex()
    private val cache = linkedMapOf<String, Cached>()
    private var lastStarted: Long? = null
    suspend fun product(url: String, fetch: suspend () -> JSONObject?): JSONObject? = lock.withLock {
        val current = now()
        cache.entries.removeAll { it.value.until <= current }
        cache[url]?.let { return@withLock it.json?.let(::JSONObject) }
        lastStarted?.let { started -> val remaining = 4_100 - (current - started); if (remaining > 0) wait(remaining) }
        lastStarted = now()
        val response = fetch()
        cache[url] = Cached(response?.toString(), now() + if (response == null) 60_000 else 5 * 60_000)
        if (cache.size > 80) cache.remove(cache.keys.first())
        response?.let { JSONObject(it.toString()) }
    }
}
internal val openFactsProducts = OpenFactsProductRequests()
