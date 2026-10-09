package app.vegsnap

import java.io.File
import java.nio.file.Files
import kotlinx.coroutines.*
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class AnalysisQueueTest {
    private fun withStore(test: suspend CoroutineScope.(File, AnalysisQueueStore) -> Unit) = runBlocking {
        val root = Files.createTempDirectory("vegsnap-queue").toFile()
        try { test(root, AnalysisQueueStore(File(root, "queue"))) }
        finally { root.deleteRecursively() }
    }
    @Test fun `enqueue snapshots independent inputs and sanitized files without credentials`() = withStore { root, store ->
        val input = CheckInput("water, oats", "food", true, locale = "de", market = "SE", autoMarket = false)
        val settings = AppSettings(connection = "api", model = "vision-model", baseUrl = "https://api.example/v1", autoCountry = false, fallbackCountry = "SE")
        val photo = byteArrayOf(1, 2, 3)
        val first = store.enqueue(input, settings, listOf(photo))
        photo[0] = 9
        val second = store.enqueue(input.copy(text = "cotton", category = "clothing", complete = false), settings.copy(model = "another-model"), emptyList())
        val restored = AnalysisQueueStore(File(root, "queue")).apply { initialize() }
        assertEquals(input, restored.get(first.id)?.input)
        assertEquals(false, restored.get(first.id)?.settings?.autoCountry)
        assertEquals("SE", restored.get(first.id)?.settings?.fallbackCountry)
        assertEquals(settings.model, restored.get(first.id)?.settings?.model)
        assertEquals("another-model", restored.get(second.id)?.settings?.model)
        assertArrayEquals(byteArrayOf(1, 2, 3), restored.files(first.id).single().readBytes())
        val saved = JSONObject(File(root, "queue/${first.id}/job.json").readText())
        assertEquals(setOf("aiEnabled", "baseUrl", "model", "vision", "offline", "connection", "chatgptModel", "autoCountry", "fallbackCountry"), saved.getJSONObject("settings").keys().asSequence().toSet())
        assertFalse(saved.toString().contains("token", ignoreCase = true))
    }
    @Test fun `failed enqueue never publishes a job or damages an existing one`() = withStore { _, store ->
        val first = store.enqueue(CheckInput("water"), AppSettings(), listOf(byteArrayOf(1)))
        try { store.enqueue(CheckInput("milk"), AppSettings(), listOf(byteArrayOf())); fail("empty photo must fail") } catch (_: IllegalArgumentException) { }
        assertEquals(listOf(first.id), store.jobs.value.map { it.id })
        assertEquals(1, store.files(first.id).size)
        repeat(29) { store.enqueue(CheckInput("water"), AppSettings(), emptyList()) }
        try { store.enqueue(CheckInput("too many"), AppSettings(), emptyList()); fail("bounded queue") } catch (_: IllegalArgumentException) { }
        assertEquals(30, store.jobs.value.size)
    }
    @Test fun `serial claims skip paused network checks but allow offline checks`() = withStore { _, store ->
        val network = store.enqueue(CheckInput("network"), AppSettings(), emptyList())
        val local = store.enqueue(CheckInput("water"), AppSettings(offline = true), emptyList())
        assertEquals(local.id, store.next(offline = true, parallelChecks = 1)?.id)
        assertEquals(AnalysisStatus.PAUSED, store.get(network.id)?.status)
        assertNull(store.next(offline = false, parallelChecks = 1))
        store.stop(local.id, AnalysisStatus.CANCELLED)
        store.remove(local.id)
        assertEquals(network.id, store.next(offline = false, parallelChecks = 1)?.id)
    }
    @Test fun `process restart marks active work interrupted and keeps queued photos`() = withStore { root, store ->
        val first = store.enqueue(CheckInput("one"), AppSettings(), listOf(byteArrayOf(1)))
        val second = store.enqueue(CheckInput("two"), AppSettings(), listOf(byteArrayOf(2)))
        assertEquals(first.id, store.next(false)?.id)
        val restored = AnalysisQueueStore(File(root, "queue")).apply { initialize() }
        assertEquals(AnalysisStatus.INTERRUPTED, restored.get(first.id)?.status)
        assertEquals(AnalysisStatus.QUEUED, restored.get(second.id)?.status)
        assertArrayEquals(byteArrayOf(1), restored.files(first.id).single().readBytes())
        assertEquals(second.id, restored.next(false)?.id)
    }
    @Test fun `cancelling one running job preserves the next job and retry reuses photos`() = withStore { _, store ->
        val first = store.enqueue(CheckInput("one"), AppSettings(), listOf(byteArrayOf(1)))
        val second = store.enqueue(CheckInput("two"), AppSettings(), listOf(byteArrayOf(2)))
        val entered = CompletableDeferred<Unit>()
        val runner = AnalysisQueueRunner(store, { _, _ -> entered.complete(Unit); awaitCancellation() }, { _, _ -> fail("cancelled result must not publish") })
        val task = launch { runner.run(store.next(false)!!) }
        entered.await()
        assertTrue(store.stop(first.id, AnalysisStatus.CANCELLED))
        task.cancelAndJoin()
        assertEquals(AnalysisStatus.CANCELLED, store.get(first.id)?.status)
        assertEquals(second.id, store.next(false)?.id)
        store.stop(second.id, AnalysisStatus.CANCELLED)
        store.retry(first.id)
        assertEquals(first.id, store.next(false)?.id)
        assertArrayEquals(byteArrayOf(1), store.files(first.id).single().readBytes())
    }
    @Test fun `checkpoint publication retries without a second inference or duplicate result`() = withStore { root, store ->
        val job = store.enqueue(CheckInput("one"), AppSettings(), listOf(byteArrayOf(1)))
        var inferences = 0
        val firstRunner = AnalysisQueueRunner(store, { _, progress -> inferences++; progress(CheckStage.ANALYZING_TEXT); JSONObject().put("id", "provider-id") }, { _, _ -> error("simulated Room failure") })
        firstRunner.run(store.next(false)!!)
        assertEquals(AnalysisStatus.FAILED, store.get(job.id)?.status)
        val restored = AnalysisQueueStore(File(root, "queue")).apply { initialize(); retry(job.id) }
        val published = mutableMapOf<String, String>()
        AnalysisQueueRunner(restored, { _, _ -> inferences++; error("must use checkpoint") }, { queued, result ->
            assertEquals(queued.id, result.getString("id")); published[queued.id] = result.toString()
            assertEquals(1, restored.files(queued.id).size)
        }).run(restored.next(false)!!)
        assertEquals(1, inferences)
        assertEquals(1, published.size)
        assertTrue(restored.jobs.value.isEmpty())
        assertFalse(File(root, "queue/${job.id}").exists())
    }
    @Test fun `offline cancellation cannot later overwrite paused or cancelled state`() = withStore { _, store ->
        val job = store.enqueue(CheckInput("one"), AppSettings(), emptyList())
        store.next(false)
        store.stop(job.id, AnalysisStatus.PAUSED)
        store.interrupted(job.id, store.get(job.id)!!.attempt)
        assertEquals(AnalysisStatus.PAUSED, store.get(job.id)?.status)
        store.stop(job.id, AnalysisStatus.CANCELLED)
        assertFalse(store.stop(job.id, AnalysisStatus.PAUSED))
        assertEquals(AnalysisStatus.CANCELLED, store.get(job.id)?.status)
    }
    @Test fun `cancelled claim cannot start inference and old attempts cannot affect retry`() = withStore { _, store ->
        val queued = store.enqueue(CheckInput("one"), AppSettings(), emptyList())
        val old = store.next(false)!!
        store.stop(queued.id, AnalysisStatus.CANCELLED)
        var analyzed = false
        AnalysisQueueRunner(store, { _, _ -> analyzed = true; JSONObject() }, { _, _ -> fail("cancelled") }).run(old)
        assertFalse(analyzed)
        store.retry(queued.id)
        val current = store.next(false)!!
        assertTrue(current.attempt > old.attempt)
        store.progress(old.id, old.attempt, CheckStage.SEARCHING_WEB)
        assertFalse(store.checkpoint(old.id, old.attempt, "{}"))
        store.failed(old.id, old.attempt)
        store.interrupted(old.id, old.attempt)
        assertEquals(AnalysisStatus.RUNNING, store.get(current.id)?.status)
        assertEquals(CheckStage.PREPARING, store.get(current.id)?.stage)
        assertFalse(store.remove(current.id))
    }
    @Test fun `process death after result checkpoint resumes only publication`() = withStore { root, store ->
        val queued = store.enqueue(CheckInput("one"), AppSettings(), listOf(byteArrayOf(1)))
        val running = store.next(false)!!
        assertTrue(store.checkpoint(running.id, running.attempt, JSONObject().put("id", queued.id).toString()))
        val restored = AnalysisQueueStore(File(root, "queue")).apply { initialize() }
        assertEquals(AnalysisStatus.QUEUED, restored.get(queued.id)?.status)
        var published = false
        AnalysisQueueRunner(restored, { _, _ -> error("must not call AI twice") }, { _, _ -> published = true }).run(restored.next(true)!!)
        assertTrue(published)
        assertTrue(restored.jobs.value.isEmpty())
    }

}
