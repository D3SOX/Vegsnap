package app.vegsnapp

/** An in-progress retry owns the history card's destination, while its prior result stays saved. */
internal fun activeHistoryRetry(historyId: String, jobs: List<AnalysisJob>): AnalysisJob? = jobs.firstOrNull {
    it.historyId == historyId && it.status in setOf(AnalysisStatus.QUEUED, AnalysisStatus.RUNNING, AnalysisStatus.PAUSED)
}
