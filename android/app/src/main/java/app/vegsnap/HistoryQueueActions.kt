package app.vegsnap

import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext

/** Publication may be non-cancellable: join it before deletion so it cannot resurrect a result. */
internal suspend fun AnalysisQueueStore.deleteHistoryRetries(ids: Set<String>?, cancelRunning: (String) -> Job?,
    delete: suspend () -> Unit) = withHistoryMutation {
    withContext(NonCancellable) {
        val retries = jobs.value.filter { it.historyId != null && (ids == null || it.historyId in ids) }
        retries.forEach { job ->
            stop(job.id, AnalysisStatus.CANCELLED)
            cancelRunning(job.id)?.join()
            if (get(job.id) != null) check(remove(job.id)) { "Could not stop history retry" }
        }
        delete()
    }
}
