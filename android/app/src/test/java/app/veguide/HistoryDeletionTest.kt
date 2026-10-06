package app.veguide

import java.io.File
import java.nio.file.Files
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.*
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class HistoryDeletionTest {
    @Test fun `deleting history waits for publishing retry then removes it without cancelling new checks`() = runBlocking {
        val root = Files.createTempDirectory("veguide-delete-retry").toFile()
        val releasePublication = CompletableDeferred<Unit>()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        try {
            val queue = AnalysisQueueStore(File(root, "queue"))
            val photos = HistoryPhotoStore(File(root, "photos"))
            val input = CheckInput("water")
            val rows = ConcurrentHashMap<String, HistoryEntry>()
            rows["history"] = HistoryEntry("history", "original", "old", "{}")
            photos.save("history", listOf(byteArrayOf(1)), input) { }
            val retry = queue.enqueueHistory("history", input, AppSettings(), listOf(byteArrayOf(1)))
            val fresh = queue.enqueue(CheckInput("new independent check"), AppSettings(), listOf(byteArrayOf(2)))
            val publishing = CompletableDeferred<Unit>()
            val runner = AnalysisQueueRunner(queue, { _, _ -> JSONObject().put("title", "new result").put("checkedAt", "now") }, { job, result ->
                publishing.complete(Unit)
                releasePublication.await()
                publishAnalysisResult(job, result, photos, { queue.files(job.id).map { it.readBytes() } }, rows::containsKey) { rows[it.id] = it }
            })
            val task = scope.launch { runner.run(queue.next(false, 1)!!) }
            withTimeout(5_000) { publishing.await() }
            val cancelling = CompletableDeferred<Unit>()
            val deletion = async {
                queue.deleteHistoryRetries(setOf("history"), { id ->
                    assertEquals(retry.id, id)
                    cancelling.complete(Unit)
                    task.also { it.cancel() }
                }) { photos.delete("history") { rows.remove("history") } }
            }
            withTimeout(5_000) { cancelling.await() }
            assertFalse(deletion.isCompleted)
            assertTrue(rows.containsKey("history"))
            assertEquals(1, photos.files("history").size)
            releasePublication.complete(Unit)
            withTimeout(5_000) { deletion.await() }
            assertFalse(rows.containsKey("history"))
            assertTrue(photos.files("history").isEmpty())
            assertNull(queue.get(retry.id))
            assertEquals(AnalysisStatus.QUEUED, queue.get(fresh.id)?.status)
            assertArrayEquals(byteArrayOf(2), queue.files(fresh.id).single().readBytes())
        } finally { releasePublication.complete(Unit); scope.cancel(); scope.coroutineContext[Job]?.join(); root.deleteRecursively() }
    }

    @Test fun `delete all stops history retries only and stale retry creation waits for deletion`() = runBlocking {
        val root = Files.createTempDirectory("veguide-delete-all").toFile()
        val finish = CompletableDeferred<Unit>()
        try {
            val queue = AnalysisQueueStore(root)
            queue.enqueueHistory("one", CheckInput("water"), AppSettings(), emptyList())
            queue.enqueueHistory("two", CheckInput("salt"), AppSettings(), emptyList())
            val fresh = queue.enqueue(CheckInput("new"), AppSettings(), emptyList())
            val entered = CompletableDeferred<Unit>()
            var historyExists = true
            val deletion = launch {
                queue.deleteHistoryRetries(null, { null }) { entered.complete(Unit); finish.await(); historyExists = false }
            }
            withTimeout(5_000) { entered.await() }
            val lateRetry = async {
                queue.withHistoryMutation {
                    if (historyExists) queue.enqueueHistory("one", CheckInput("stale result"), AppSettings(), emptyList()) else null
                }
            }
            yield()
            assertFalse(lateRetry.isCompleted)
            finish.complete(Unit)
            withTimeout(5_000) { deletion.join() }
            assertNull(lateRetry.await())
            assertEquals(listOf(fresh.id), queue.jobs.value.map { it.id })
        } finally { finish.complete(Unit); root.deleteRecursively() }
    }
}
