package app.vegsnap

import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.*

/** Claims are durable; a cancelled attempt keeps its slot until its coroutine has finished. */
internal class ParallelAnalysisQueue(
    private val store: AnalysisQueueStore,
    private val scope: CoroutineScope,
    private val runner: AnalysisQueueRunner,
    private val changed: () -> Unit,
) {
    private val running = ConcurrentHashMap<String, Job>()
    val activeCount: Int get() = running.size
    fun cancel(id: String): Job? = running[id]?.also { it.cancel() }
    fun cancelAll() { running.values.forEach { it.cancel() } }
    suspend fun fill(offline: Boolean, parallelChecks: Int) {
        val limit = parallelChecks.coerceIn(1, 10)
        while (running.size < limit) {
            currentCoroutineContext().ensureActive()
            val next = withContext(Dispatchers.IO) { store.next(offline, limit, running.keys.toSet()) } ?: break
            val task = scope.launch(Dispatchers.IO, start = CoroutineStart.LAZY) { runner.run(next) }
            running[next.id] = task
            task.invokeOnCompletion {
                // The runner's finally cannot execute when a lazy worker is cancelled before starting.
                try { store.interrupted(next.id, next.attempt) }
                finally { running.remove(next.id, task); changed() }
            }
            if (store.get(next.id)?.let { it.status == AnalysisStatus.RUNNING && it.attempt == next.attempt } != true) task.cancel() else task.start()
        }
    }
}
