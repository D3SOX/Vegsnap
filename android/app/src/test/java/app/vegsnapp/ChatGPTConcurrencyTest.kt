package app.vegsnapp

import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ChatGPTConcurrencyTest {
    @Test fun `refresh is serialized while three actual request bodies can overlap`() = runBlocking {
        val refreshStarted = CompletableDeferred<Unit>()
        val finishRefresh = CompletableDeferred<Unit>()
        val finishRequests = CompletableDeferred<Unit>()
        val requests = Channel<Unit>(Channel.UNLIMITED)
        var refreshed = false
        var refreshes = 0
        val tasks = (1..3).map {
            async {
                withChatGPTSession(loadSession = {
                    if (!refreshed) {
                        refreshes++
                        refreshStarted.complete(Unit)
                        finishRefresh.await()
                        refreshed = true
                    }
                    JSONObject().put("fresh", true)
                }, request = { session ->
                    assertTrue(session.getBoolean("fresh"))
                    requests.send(Unit)
                    finishRequests.await()
                    "completed"
                })
            }
        }
        try {
            withTimeout(5_000) { refreshStarted.await() }
            yield()
            assertEquals(1, refreshes)
            finishRefresh.complete(Unit)
            withTimeout(5_000) { repeat(3) { requests.receive() } }
            assertTrue(tasks.all { it.isActive })
            assertEquals(1, refreshes)
            finishRequests.complete(Unit)
            assertEquals(listOf("completed", "completed", "completed"), tasks.awaitAll())
        } finally { finishRefresh.complete(Unit); finishRequests.complete(Unit); tasks.forEach { it.cancel() } }
    }
}
