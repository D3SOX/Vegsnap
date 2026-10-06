package app.vegsnapp

import java.io.File
import java.nio.file.Files
import kotlinx.coroutines.*
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class HistoryRetryTest {
    private fun withStores(test: suspend (AnalysisQueueStore, HistoryPhotoStore) -> Unit) = runBlocking {
        val root = Files.createTempDirectory("vegsnap-history-retry").toFile()
        try { test(AnalysisQueueStore(File(root, "queue")), HistoryPhotoStore(File(root, "history"))) }
        finally { root.deleteRecursively() }
    }
    private fun result(title: String, aiStatus: String = "images") = JSONObject().put("title", title)
        .put("checkedAt", "2026-10-06T12:00:00Z").put("aiStatus", aiStatus)

    @Test fun `same history retry replaces one result and keeps original photos and input`() = withStores { queue, photos ->
        val historyId = "imported/history:one"
        val input = CheckInput("water, salt", "food", true)
        val originalPhoto = byteArrayOf(1, 2, 3)
        val rows = mutableMapOf(historyId to HistoryEntry(historyId, "old", "old", "{}"))
        photos.save(historyId, listOf(originalPhoto), input) { }
        val retry = queue.enqueueHistory(historyId, input, AppSettings(), listOf(originalPhoto))
        val repeated = queue.enqueueHistory(historyId, CheckInput("unrelated"), AppSettings(), listOf(byteArrayOf(9)))
        assertEquals(retry.id, repeated.id)
        assertEquals(1, queue.jobs.value.size)
        val restored = AnalysisQueueStore(requireNotNull(requireNotNull(queue.files(retry.id).single().parentFile).parentFile)).apply { initialize() }
        assertEquals(historyId, restored.get(retry.id)?.historyId)
        assertEquals(historyId, restored.get(retry.id)?.resultId)
        assertEquals("old", rows.getValue(historyId).title)
        val runner = AnalysisQueueRunner(queue, { _, _ -> result("updated") }, { job, result ->
            publishAnalysisResult(job, result, photos, { queue.files(job.id).map { it.readBytes() } }, rows::containsKey) { rows[it.id] = it }
        })
        runner.run(queue.next(false)!!)
        assertEquals(setOf(historyId), rows.keys)
        assertEquals("updated", rows.getValue(historyId).title)
        assertEquals(historyId, JSONObject(rows.getValue(historyId).json).getString("id"))
        assertArrayEquals(originalPhoto, photos.files(historyId).single().readBytes())
        assertEquals(input, photos.input(historyId))
        assertTrue(queue.jobs.value.isEmpty())
    }

    @Test fun `failed transport preserves previous result and retry snapshot until successful retry`() = withStores { queue, photos ->
        val input = CheckInput("original", "other")
        val bytes = byteArrayOf(1, 2)
        val historyId = "previous"
        photos.save(historyId, listOf(bytes), input) { }
        val rows = mutableMapOf(historyId to HistoryEntry(historyId, "previous vegan result", "old", "{}"))
        val retry = queue.enqueueHistory(historyId, input, AppSettings(), listOf(bytes))
        var publishCalls = 0
        AnalysisQueueRunner(queue, { _, _ -> result("uncertain", "failed").put("aiError", JSONObject()
            .put("code", "quota").put("message", "RAW PROVIDER SECRET MUST NEVER BE PERSISTED")) }, { _, _ -> publishCalls++ }).run(queue.next(false)!!)
        assertEquals(0, publishCalls)
        assertEquals(AnalysisStatus.FAILED, queue.get(retry.id)?.status)
        assertEquals(AIErrorCode.QUOTA, queue.get(retry.id)?.failureReason)
        val saved = File(requireNotNull(queue.files(retry.id).single().parentFile), "job.json").readText()
        assertFalse(saved.contains("RAW PROVIDER SECRET"))
        val restored = AnalysisQueueStore(requireNotNull(requireNotNull(queue.files(retry.id).single().parentFile).parentFile)).apply { initialize() }
        assertEquals(AIErrorCode.QUOTA, restored.get(retry.id)?.failureReason)
        assertEquals("previous vegan result", rows.getValue(historyId).title)
        assertArrayEquals(bytes, photos.files(historyId).single().readBytes())
        val resumed = queue.enqueueHistory(historyId, CheckInput("changed"), AppSettings(), emptyList())
        assertEquals(input, resumed.input)
        assertNull(resumed.failureReason)
        assertEquals(1, resumed.photoCount)
        assertArrayEquals(bytes, queue.files(retry.id).single().readBytes())
        AnalysisQueueRunner(queue, { _, _ -> result("new evidence") }, { job, result ->
            publishAnalysisResult(job, result, photos, { queue.files(job.id).map { it.readBytes() } }, rows::containsKey) { rows[it.id] = it }
        }).run(queue.next(false)!!)
        assertEquals("new evidence", rows.getValue(historyId).title)
        assertEquals(1, rows.size)
    }

    @Test fun `database failure keeps previous result and checkpoints retry without second inference`() = withStores { queue, photos ->
        val input = CheckInput("water")
        photos.save("history", listOf(byteArrayOf(7)), input) { }
        val retry = queue.enqueueHistory("history", input, AppSettings(), listOf(byteArrayOf(7)))
        var analyses = 0
        AnalysisQueueRunner(queue, { _, _ -> analyses++; result("new") }, { job, result ->
            publishAnalysisResult(job, result, photos, { error("must keep original photos") }, { true }) { error("Room transaction failed") }
        }).run(queue.next(false)!!)
        assertEquals(AnalysisStatus.FAILED, queue.get(retry.id)?.status)
        assertNotNull(queue.get(retry.id)?.result)
        assertArrayEquals(byteArrayOf(7), photos.files("history").single().readBytes())
        queue.enqueueHistory("history", input, AppSettings(), emptyList())
        var saved: HistoryEntry? = null
        AnalysisQueueRunner(queue, { _, _ -> analyses++; error("must publish checkpoint") }, { job, result ->
            publishAnalysisResult(job, result, photos, { error("must keep original photos") }, { true }) { saved = it }
        }).run(queue.next(false)!!)
        assertEquals(1, analyses)
        assertEquals("history", saved?.id)
        assertEquals("new", saved?.title)
    }

    @Test fun `reopening a history card follows its durable retry until completion without replacing old evidence`() = withStores { queue, _ ->
        val entry = HistoryEntry("history-one", "Previous result", "old", "{\"summary\":\"original evidence\"}")
        assertNull(activeHistoryRetry(entry.id, queue.jobs.value))
        val retry = queue.enqueueHistory(entry.id, CheckInput("water"), AppSettings(), emptyList())
        queue.enqueueHistory("another-entry", CheckInput("different"), AppSettings(), emptyList())
        assertEquals(retry.id, activeHistoryRetry(entry.id, queue.jobs.value)?.id)
        val running = requireNotNull(queue.next(false))
        assertEquals(AnalysisStatus.RUNNING, activeHistoryRetry(entry.id, queue.jobs.value)?.status)
        // Closing a sheet changes no durable job: the same history card must reopen this job.
        assertEquals(retry.id, activeHistoryRetry(entry.id, queue.jobs.value)?.id)
        assertEquals("{\"summary\":\"original evidence\"}", entry.json)
        queue.stop(running.id, AnalysisStatus.PAUSED)
        assertEquals(retry.id, activeHistoryRetry(entry.id, queue.jobs.value)?.id)
        queue.retry(running.id)
        val resumed = requireNotNull(queue.next(false))
        queue.checkpoint(resumed.id, resumed.attempt, result("updated").toString())
        assertEquals(resumed.id, activeHistoryRetry(entry.id, queue.jobs.value)?.id)
        queue.finish(resumed.id, resumed.attempt)
        assertNull(activeHistoryRetry(entry.id, queue.jobs.value))
        assertNotNull(activeHistoryRetry("another-entry", queue.jobs.value))
    }
    @Test fun `failed or cancelled retry keeps saved result available from its history card`() = withStores { queue, _ ->
        val retry = queue.enqueueHistory("history", CheckInput("water"), AppSettings(), emptyList())
        for (status in listOf(AnalysisStatus.FAILED, AnalysisStatus.INTERRUPTED, AnalysisStatus.CANCELLED)) {
            assertTrue(queue.stop(retry.id, status))
            assertNull(activeHistoryRetry("history", queue.jobs.value))
            queue.retry(retry.id)
        }
    }
    @Test fun `concurrent repeat taps claim only one durable history retry`() = withStores { queue, _ ->
        val jobs = coroutineScope { (1..10).map { async(Dispatchers.Default) {
            queue.enqueueHistory("same history", CheckInput("water"), AppSettings(), emptyList())
        } }.awaitAll() }
        assertEquals(1, jobs.map { it.id }.distinct().size)
        assertEquals(1, queue.jobs.value.size)
        assertEquals("same history", queue.next(false)?.resultId)
        assertNull(queue.next(false))
    }
}
