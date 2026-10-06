package app.veguide

import java.io.File
import java.util.UUID
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONObject

internal enum class AnalysisStatus { QUEUED, RUNNING, PAUSED, FAILED, INTERRUPTED, CANCELLED }
internal data class AnalysisJob(
    val id: String, val createdAt: Long, val input: CheckInput, val settings: AppSettings,
    val photoCount: Int, val status: AnalysisStatus = AnalysisStatus.QUEUED,
    val stage: CheckStage? = null, val startedAt: Long? = null, val result: String? = null, val attempt: Int = 0,
    val historyId: String? = null, val failureReason: AIErrorCode? = null,
) {
    val resultId: String get() = historyId ?: id
    val title: String get() = input.name.ifBlank { input.text.lineSequence().firstOrNull { it.isNotBlank() }.orEmpty() }.take(100)
}

/** A job becomes visible only after all sanitized photos and its request have been committed. */
internal class AnalysisQueueStore(private val root: File) {
    private val historyChanges = Mutex()
    suspend fun <T> withHistoryMutation(action: suspend () -> T): T = historyChanges.withLock { action() }
    private var loaded = false
    private val mutableJobs = MutableStateFlow<List<AnalysisJob>>(emptyList())
    val jobs = mutableJobs.asStateFlow()
    private fun directory(id: String): File { require(id.matches(Regex("[a-f0-9-]{36}"))); return File(root, id) }
    @Synchronized fun initialize() {
        if (loaded) return
        check(root.isDirectory || root.mkdirs())
        root.listFiles()?.filter { it.name.endsWith(".pending") }?.forEach { it.deleteRecursively() }
        val restored = root.listFiles().orEmpty().filter { it.isDirectory && it.name.matches(Regex("[a-f0-9-]{36}")) }.mapNotNull { folder ->
            runCatching {
                val job = decode(JSONObject(File(folder, "job.json").readText()))
                require(job.id == folder.name)
                require((0 until job.photoCount).all { File(folder, "$it.jpg").isFile })
                if (job.status == AnalysisStatus.RUNNING) job.copy(status = if (job.result != null) AnalysisStatus.QUEUED else AnalysisStatus.INTERRUPTED, stage = null) else job
            }.getOrNull()
        }.sortedBy { it.createdAt }
        restored.forEach(::write)
        mutableJobs.value = restored
        loaded = true
    }
    @Synchronized fun enqueue(input: CheckInput, settings: AppSettings, photos: List<ByteArray>): AnalysisJob =
        enqueueNew(input, settings, photos)

    @Synchronized fun enqueueHistory(historyId: String, input: CheckInput, settings: AppSettings, photos: List<ByteArray>): AnalysisJob {
        initialize()
        require(historyId.length in 1..100)
        mutableJobs.value.firstOrNull { it.historyId == historyId }?.let { existing ->
            if (existing.status in setOf(AnalysisStatus.RUNNING, AnalysisStatus.QUEUED)) return existing
            // Retry the durable snapshot, even if a result import has since changed the history entry.
            return existing.copy(settings = settings, status = AnalysisStatus.QUEUED, stage = null, startedAt = null, failureReason = null).also(::replace)
        }
        return enqueueNew(input, settings, photos, historyId)
    }

    private fun enqueueNew(input: CheckInput, settings: AppSettings, photos: List<ByteArray>, historyId: String? = null): AnalysisJob {
        initialize()
        require(mutableJobs.value.size < 30) { "Analysis queue is full" }
        require(photos.size <= 3 && photos.all { it.isNotEmpty() && it.size <= 8_000_000 })
        require(input.text.length <= 30_000)
        val id = UUID.randomUUID().toString()
        val job = AnalysisJob(id, System.currentTimeMillis(), input, settings, photos.size, historyId = historyId)
        val staging = File(root, "$id.pending")
        check(staging.mkdirs())
        try {
            photos.forEachIndexed { index, bytes -> File(staging, "$index.jpg").outputStream().use { it.write(bytes); it.fd.sync() } }
            File(staging, "job.json").outputStream().use { it.write(encode(job).toString().toByteArray()); it.fd.sync() }
            check(staging.renameTo(directory(id))) { "Cannot commit queued analysis" }
        } catch (error: Throwable) { staging.deleteRecursively(); throw error }
        mutableJobs.value = (mutableJobs.value + job).sortedBy { it.createdAt }
        return job
    }
    @Synchronized fun files(id: String): List<File> {
        val job = mutableJobs.value.firstOrNull { it.id == id } ?: return emptyList()
        return (0 until job.photoCount).map { File(directory(id), "$it.jpg") }
    }
    @Synchronized fun get(id: String): AnalysisJob? = mutableJobs.value.firstOrNull { it.id == id }
    @Synchronized fun next(offline: Boolean, parallelChecks: Int = 3, occupiedIds: Set<String> = emptySet()): AnalysisJob? {
        initialize()
        mutableJobs.value.filter { !it.settings.offline && it.result == null }.forEach { job ->
            if (offline && job.status == AnalysisStatus.QUEUED) replace(job.copy(status = AnalysisStatus.PAUSED))
            else if (!offline && job.status == AnalysisStatus.PAUSED) replace(job.copy(status = AnalysisStatus.QUEUED))
        }
        if (mutableJobs.value.count { it.status == AnalysisStatus.RUNNING } >= parallelChecks.coerceIn(1, 10)) return null
        val job = mutableJobs.value.firstOrNull { it.status == AnalysisStatus.QUEUED && it.id !in occupiedIds } ?: return null
        return job.copy(status = AnalysisStatus.RUNNING, startedAt = System.currentTimeMillis(), stage = CheckStage.PREPARING, attempt = job.attempt + 1, failureReason = null).also(::replace)
    }
    @Synchronized fun progress(id: String, attempt: Int, stage: CheckStage) { get(id)?.takeIf { it.status == AnalysisStatus.RUNNING && it.attempt == attempt }?.let { replace(it.copy(stage = stage)) } }
    @Synchronized fun checkpoint(id: String, attempt: Int, result: String): Boolean {
        val job = get(id)?.takeIf { it.status == AnalysisStatus.RUNNING && it.attempt == attempt } ?: return false
        replace(job.copy(result = result, stage = CheckStage.SAVING)); return true
    }
    @Synchronized fun stop(id: String, status: AnalysisStatus): Boolean {
        val job = get(id) ?: return false
        if (job.status !in listOf(AnalysisStatus.QUEUED, AnalysisStatus.RUNNING, AnalysisStatus.PAUSED)) return false
        if (job.stage == CheckStage.SAVING && job.result != null) return false
        replace(job.copy(status = status, stage = null)); return true
    }
    @Synchronized fun interrupted(id: String, attempt: Int) {
        get(id)?.takeIf { it.status == AnalysisStatus.RUNNING && it.attempt == attempt }?.let { replace(it.copy(status = if (it.result == null) AnalysisStatus.INTERRUPTED else AnalysisStatus.QUEUED, stage = null)) }
    }
    @Synchronized fun failed(id: String, attempt: Int, reason: AIErrorCode? = null) { get(id)?.takeIf { it.status == AnalysisStatus.RUNNING && it.attempt == attempt }?.let { replace(it.copy(status = AnalysisStatus.FAILED, stage = null, failureReason = reason)) } }
    @Synchronized fun retry(id: String) { get(id)?.takeIf { it.status != AnalysisStatus.RUNNING }?.let { replace(it.copy(status = AnalysisStatus.QUEUED, stage = null, startedAt = null, failureReason = null)) } }
    @Synchronized fun remove(id: String): Boolean {
        if (get(id)?.status == AnalysisStatus.RUNNING) return false
        deleteFiles(id); return true
    }
    @Synchronized fun finish(id: String, attempt: Int) {
        val job = get(id) ?: return
        check(job.status == AnalysisStatus.RUNNING && job.attempt == attempt && job.result != null)
        deleteFiles(id)
    }
    private fun deleteFiles(id: String) {
        check(directory(id).deleteRecursively()) { "Cannot remove queued analysis" }
        mutableJobs.value = mutableJobs.value.filterNot { it.id == id }
    }
    private fun replace(job: AnalysisJob) { write(job); mutableJobs.value = mutableJobs.value.map { if (it.id == job.id) job else it } }
    private fun write(job: AnalysisJob) {
        val temporary = File(directory(job.id), "job.new")
        temporary.outputStream().use { it.write(encode(job).toString().toByteArray()); it.fd.sync() }
        check(temporary.renameTo(File(directory(job.id), "job.json"))) { "Cannot save analysis progress" }
    }
    private fun encode(job: AnalysisJob): JSONObject = JSONObject().put("id", job.id).put("createdAt", job.createdAt)
        .put("photoCount", job.photoCount).put("status", job.status.name).put("stage", job.stage?.name)
        .put("startedAt", job.startedAt).put("result", job.result).put("attempt", job.attempt).put("historyId", job.historyId).put("failureReason", job.failureReason?.code)
        .put("input", JSONObject().put("text", job.input.text).put("category", job.input.category).put("complete", job.input.complete)
            .put("name", job.input.name).put("barcode", job.input.barcode).put("locale", job.input.locale).put("truncated", job.input.truncated))
        .put("settings", JSONObject().put("aiEnabled", job.settings.aiEnabled).put("baseUrl", job.settings.baseUrl)
            .put("model", job.settings.model).put("vision", job.settings.vision).put("offline", job.settings.offline)
            .put("connection", job.settings.connection).put("chatgptModel", job.settings.chatgptModel))
    private fun decode(value: JSONObject): AnalysisJob {
        val input = value.getJSONObject("input"); val settings = value.getJSONObject("settings")
        return AnalysisJob(value.getString("id"), value.getLong("createdAt"),
            CheckInput(input.getString("text"), input.getString("category"), if (input.has("complete")) input.getBoolean("complete") else null,
                input.getString("name"), input.getString("barcode"), input.getString("locale"), input.getBoolean("truncated")),
            AppSettings(aiEnabled = settings.getBoolean("aiEnabled"), baseUrl = settings.getString("baseUrl"), model = settings.getString("model"),
                vision = settings.getBoolean("vision"), offline = settings.getBoolean("offline"), connection = settings.getString("connection"), chatgptModel = settings.getString("chatgptModel")),
            value.getInt("photoCount").also { require(it in 0..3) }, AnalysisStatus.valueOf(value.getString("status")),
            if (value.has("stage")) CheckStage.valueOf(value.getString("stage")) else null,
            if (value.has("startedAt")) value.getLong("startedAt") else null,
            if (value.has("result")) value.getString("result") else null, value.optInt("attempt", 0),
            if (value.has("historyId")) value.getString("historyId").also { require(it.length in 1..100) } else null,
            AIErrorCode.entries.firstOrNull { it.code == value.optString("failureReason") })
    }
}
