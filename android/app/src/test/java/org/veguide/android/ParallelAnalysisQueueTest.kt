package org.veguide.android

import java.io.File
import java.nio.file.Files
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ParallelAnalysisQueueTest {
    @Test fun `worker scope cancelled before launch cannot leave a phantom running claim`() = runBlocking {
        val root = Files.createTempDirectory("veguide-parallel-cold-cancel").toFile()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        try {
            val store = AnalysisQueueStore(root)
            val job = store.enqueue(CheckInput("product"), AppSettings(), emptyList())
            scope.cancel()
            val runner = AnalysisQueueRunner(store, { _, _ -> error("cancelled scope must not infer") }, { _, _ -> fail("must not publish") })
            val scheduler = ParallelAnalysisQueue(store, scope, runner) { }
            scheduler.fill(false, 3)
            assertEquals(0, scheduler.activeCount)
            assertEquals(AnalysisStatus.INTERRUPTED, store.get(job.id)?.status)
            store.retry(job.id)
            assertNotNull(store.next(false))
        } finally { scope.cancel(); scope.coroutineContext[Job]?.join(); root.deleteRecursively() }
    }

    @Test fun `three analyses overlap and cancelling one frees only its slot`() = runBlocking {
        val root = Files.createTempDirectory("veguide-parallel").toFile()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        try {
            val store = AnalysisQueueStore(root)
            val jobs = (1..4).map { store.enqueue(CheckInput("product $it"), AppSettings(), emptyList()) }
            val entered = Channel<String>(Channel.UNLIMITED)
            val changed = Channel<Unit>(Channel.CONFLATED)
            val gates = jobs.associate { it.id to CompletableDeferred<Unit>() }
            val published = ConcurrentHashMap<String, Int>()
            val runner = AnalysisQueueRunner(store, { job, progress ->
                progress(CheckStage.ANALYZING_PHOTO)
                entered.send(job.id)
                gates.getValue(job.id).await()
                JSONObject()
            }, { job, _ -> published.merge(job.id, 1, Int::plus) })
            val scheduler = ParallelAnalysisQueue(store, scope, runner) { changed.trySend(Unit) }
            scheduler.fill(false, 3)
            val started = withTimeout(5_000) { (1..3).map { entered.receive() }.toSet() }
            assertEquals(jobs.take(3).map { it.id }.toSet(), started)
            assertEquals(3, scheduler.activeCount)
            assertEquals(AnalysisStatus.QUEUED, store.get(jobs[3].id)?.status)
            scheduler.fill(false, 3)
            assertTrue(entered.tryReceive().isFailure)
            assertTrue(store.stop(jobs[0].id, AnalysisStatus.CANCELLED))
            scheduler.cancel(jobs[0].id)!!.join()
            assertEquals(AnalysisStatus.RUNNING, store.get(jobs[1].id)?.status)
            assertEquals(CheckStage.ANALYZING_PHOTO, store.get(jobs[2].id)?.stage)
            scheduler.fill(false, 3)
            assertEquals(jobs[3].id, withTimeout(5_000) { entered.receive() })
            jobs.drop(1).forEach { gates.getValue(it.id).complete(Unit) }
            withTimeout(5_000) { while (scheduler.activeCount != 0) changed.receive() }
            assertEquals(jobs.drop(1).map { it.id }.toSet(), published.keys)
            assertTrue(published.values.all { it == 1 })
            assertEquals(AnalysisStatus.CANCELLED, store.get(jobs[0].id)?.status)
        } finally { scope.cancel(); scope.coroutineContext[Job]?.join(); root.deleteRecursively() }
    }

    @Test fun `claims honor live limits and restart preserves all interrupted attempts`() {
        val root = Files.createTempDirectory("veguide-parallel-limits").toFile()
        try {
            val store = AnalysisQueueStore(root)
            repeat(12) { store.enqueue(CheckInput("product $it"), AppSettings(), emptyList()) }
            assertNotNull(store.next(false, 1))
            assertNull(store.next(false, 1))
            repeat(9) { assertNotNull(store.next(false, 99)) }
            assertNull(store.next(false, 99))
            val restored = AnalysisQueueStore(root).apply { initialize() }
            assertEquals(10, restored.jobs.value.count { it.status == AnalysisStatus.INTERRUPTED })
            assertEquals(2, restored.jobs.value.count { it.status == AnalysisStatus.QUEUED })
            val interrupted = restored.jobs.value.first { it.status == AnalysisStatus.INTERRUPTED }
            val queued = restored.jobs.value.filter { it.status == AnalysisStatus.QUEUED }.map { it.id }.toSet()
            restored.retry(interrupted.id)
            // Same-millisecond creation times do not promise filesystem ordering after restart.
            val claimed = List(3) { requireNotNull(restored.next(false, 3)) }
            assertEquals(queued + interrupted.id, claimed.map { it.id }.toSet())
            assertNull(restored.next(false, 3))
            val retry = claimed.single { it.id == interrupted.id }
            assertEquals(interrupted.attempt + 1, retry.attempt)
        } finally { root.deleteRecursively() }
    }

    @Test fun `retry waits until old cancelled coroutine releases its slot`() = runBlocking {
        val root = Files.createTempDirectory("veguide-parallel-retry").toFile()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val cleanup = CompletableDeferred<Unit>()
        try {
            val store = AnalysisQueueStore(root)
            val job = store.enqueue(CheckInput("product"), AppSettings(), emptyList())
            val entered = Channel<Int>(Channel.UNLIMITED)
            val runner = AnalysisQueueRunner(store, { attempt, _ ->
                entered.send(attempt.attempt)
                try { awaitCancellation() } finally { withContext(NonCancellable) { cleanup.await() } }
            }, { _, _ -> fail("cancelled attempts do not publish") })
            val scheduler = ParallelAnalysisQueue(store, scope, runner) { }
            scheduler.fill(false, 3)
            val originalAttempt = withTimeout(5_000) { entered.receive() }
            store.stop(job.id, AnalysisStatus.CANCELLED)
            val cancelled = scheduler.cancel(job.id)!!
            store.retry(job.id)
            scheduler.fill(false, 3)
            assertTrue(entered.tryReceive().isFailure)
            cleanup.complete(Unit)
            cancelled.join()
            scheduler.fill(false, 3)
            assertEquals(originalAttempt + 1, withTimeout(5_000) { entered.receive() })
            store.stop(job.id, AnalysisStatus.CANCELLED)
            scheduler.cancel(job.id)!!.join()
        } finally { cleanup.complete(Unit); scope.cancel(); scope.coroutineContext[Job]?.join(); root.deleteRecursively() }
    }
}
