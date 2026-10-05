package org.veguide.android

import android.app.Application
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import androidx.room.Room
import java.io.File
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.first
import org.json.JSONObject

internal object ApplicationAnalysisQueue {
    private var instance: AnalysisQueueStore? = null
    @Volatile var cancelRunning: ((String) -> Job?)? = null
    @Volatile var networkPaused = false
    @Synchronized fun get(context: Context): AnalysisQueueStore = instance ?: AnalysisQueueStore(File(context.noBackupFilesDir, "analysis-queue")).also { instance = it }
}
internal object ApplicationHistoryDatabase {
    private var instance: HistoryDatabase? = null
    @Synchronized fun get(context: Context): HistoryDatabase = instance ?: Room.databaseBuilder(context.applicationContext, HistoryDatabase::class.java, "history.db").build().also { instance = it }
}

/** Result checkpointing means a crash after inference retries local publication, never inference. */
internal class AnalysisQueueRunner(private val store: AnalysisQueueStore,
    private val analyze: suspend (AnalysisJob, (CheckStage) -> Unit) -> JSONObject,
    private val publish: suspend (AnalysisJob, JSONObject) -> Unit) {
    suspend fun run(job: AnalysisJob) {
        try {
            currentCoroutineContext().ensureActive()
            if (store.get(job.id)?.let { it.status == AnalysisStatus.RUNNING && it.attempt == job.attempt } != true) return
            val result = job.result?.let(::JSONObject) ?: analyze(job) { store.progress(job.id, job.attempt, it) }.put("id", job.resultId)
            if (job.historyId != null && result.optString("aiStatus") == "failed") {
                val code = result.optJSONObject("aiError")?.optString("code")
                throw AIProviderFailure(AIErrorCode.entries.firstOrNull { it.code == code } ?: AIErrorCode.UNKNOWN)
            }
            currentCoroutineContext().ensureActive()
            if (!store.checkpoint(job.id, job.attempt, result.toString())) return
            withContext(NonCancellable) { publish(job, result); store.finish(job.id, job.attempt) }
        } catch (error: CancellationException) {
            withContext(NonCancellable) { store.interrupted(job.id, job.attempt) }
            throw error
        } catch (error: Exception) { store.failed(job.id, job.attempt, (error as? AIProviderFailure)?.reason) }
    }
}

/** Exact-snapshot retries replace only the database row; the original photos remain authoritative. */
internal suspend fun publishAnalysisResult(job: AnalysisJob, result: JSONObject, historyPhotos: HistoryPhotoStore,
    photos: () -> List<ByteArray>, exists: suspend (String) -> Boolean, persist: suspend (HistoryEntry) -> Unit) {
    val entry = HistoryEntry(job.resultId, result.getString("title"), result.getString("checkedAt"), result.toString())
    if (exists(job.resultId)) {
        if (job.historyId != null) persist(entry)
    } else {
        // Recover files left by a previous process before its Room transaction committed.
        historyPhotos.delete(job.resultId) { }
        historyPhotos.save(job.resultId, photos(), job.input) { persist(entry) }
    }
}

class AnalysisQueueService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val store by lazy { ApplicationAnalysisQueue.get(this) }
    private var draining: Job? = null
    @Volatile private var scheduler: ParallelAnalysisQueue? = null
    private val changes = Channel<Unit>(Channel.CONFLATED)
    private var latestStartId = 0
    private var stopped = false
    private var observer: Job? = null
    private var settingsObserver: Job? = null
    private var wakeLock: PowerManager.WakeLock? = null
    override fun onBind(intent: Intent?): IBinder? = null
    override fun onCreate() {
        super.onCreate()
        getSystemService(NotificationManager::class.java).createNotificationChannel(NotificationChannel(CHANNEL, getString(R.string.queue_channel), NotificationManager.IMPORTANCE_LOW))
        ApplicationAnalysisQueue.cancelRunning = { id -> scheduler?.cancel(id) }
        observer = scope.launch { store.jobs.collect { jobs ->
            changes.trySend(Unit)
            if (!stopped) ServiceCompat.startForeground(this@AnalysisQueueService, NOTIFICATION, notification(jobs), if (Build.VERSION.SDK_INT >= 29) ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC else 0)
        } }
        settingsObserver = scope.launch { SettingsStore(this@AnalysisQueueService).flow.collect { settings ->
            if (settings.offline) {
                store.jobs.value.filter { it.status == AnalysisStatus.RUNNING && !it.settings.offline }.forEach { job ->
                    if (withContext(Dispatchers.IO) { store.stop(job.id, AnalysisStatus.PAUSED) }) scheduler?.cancel(job.id)
                }
            }
            changes.trySend(Unit)
        } }
    }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        latestStartId = startId
        stopped = false
        ServiceCompat.startForeground(this, NOTIFICATION, notification(store.jobs.value), if (Build.VERSION.SDK_INT >= 29) ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC else 0)
        changes.trySend(Unit)
        if (draining?.isActive != true) draining = scope.launch { drain() }
        return START_NOT_STICKY
    }
    private suspend fun drain() {
        try {
            withContext(Dispatchers.IO) { store.initialize() }
            val application = application as Application
            val languages = ApplicationOcrLanguages.get(application)
            val processor = PhotoProcessor(application, languages)
            val historyPhotos = ApplicationHistoryPhotos.get(application)
            val database = ApplicationHistoryDatabase.get(application)
            val repository = CheckRepository(application, ChatGPTConnection(application))
            val runner = AnalysisQueueRunner(store, analyze = { job, progress ->
                languages.initialize()
                val photos = store.files(job.id).map { PreparedPhoto(it.readBytes()) }
                val token = CredentialStore(application).read(job.settings.baseUrl)
                withTimeout(5 * 60_000L) {
                    repository.check(job.input, photos, job.settings, token, progress) { prepared ->
                        prepared.map { ensureActive(); processor.recognizePhoto(it) }
                    }
                }
            }, publish = { job, result ->
                publishAnalysisResult(job, result, historyPhotos,
                    photos = { store.files(job.id).map { it.readBytes() } },
                    exists = { database.history().find(it) != null }, persist = { database.history().save(it) })
            })
            val parallel = ParallelAnalysisQueue(store, scope, runner) { changes.trySend(Unit) }
            scheduler = parallel
            while (currentCoroutineContext().isActive) {
                val checkedStartId = latestStartId
                val settings = SettingsStore(this).flow.first()
                parallel.fill(settings.offline || ApplicationAnalysisQueue.networkPaused, settings.parallelChecks)
                if (parallel.activeCount == 0) {
                    // Fast local jobs may finish while fill is launching its final slot.
                    if (store.jobs.value.any { it.status == AnalysisStatus.QUEUED &&
                        (!settings.offline && !ApplicationAnalysisQueue.networkPaused || it.settings.offline || it.result != null) }) continue
                    if (latestStartId != checkedStartId || !stopSelfResult(checkedStartId)) continue
                    stopped = true
                    stopForeground(STOP_FOREGROUND_REMOVE)
                    return
                }
                // Renew while work progresses. Each individual check has a five-minute timeout.
                if (wakeLock == null) wakeLock = (getSystemService(POWER_SERVICE) as PowerManager)
                    .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "veguide:analysis").apply { setReferenceCounted(false) }
                wakeLock?.acquire(6 * 60_000L)
                changes.receive()
            }
        } catch (error: CancellationException) { throw error }
        catch (error: Exception) {
            stopped = true
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelfResult(latestStartId)
        } finally {
            scheduler?.cancelAll()
            scheduler = null
            wakeLock?.let { if (it.isHeld) it.release() }; wakeLock = null
        }
    }
    private fun notification(jobs: List<AnalysisJob>): Notification {
        val active = jobs.count { it.status == AnalysisStatus.RUNNING }
        val waiting = jobs.count { it.status == AnalysisStatus.QUEUED || it.status == AnalysisStatus.PAUSED }
        val count = active + waiting
        val intent = Intent(this, MainActivity::class.java).setAction(ACTION_HISTORY).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        val pending = PendingIntent.getActivity(this, 1, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        return NotificationCompat.Builder(this, CHANNEL).setSmallIcon(R.drawable.ic_veguide_foreground)
            .setContentTitle(getString(R.string.queue_notification)).setContentText(getString(R.string.queue_parallel_status, active, waiting))
            .setSubText(resources.getQuantityString(R.plurals.queue_count, count, count))
            .setContentIntent(pending).setOngoing(true).setOnlyAlertOnce(true).setProgress(0, 0, true)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE).build()
    }
    override fun onTimeout(startId: Int, fgsType: Int) {
        scheduler?.cancelAll(); draining?.cancel()
        stopForeground(STOP_FOREGROUND_REMOVE); stopSelf()
    }
    override fun onDestroy() {
        stopped = true
        ApplicationAnalysisQueue.cancelRunning = null
        scope.cancel()
        wakeLock?.let { if (it.isHeld) it.release() }; wakeLock = null
        super.onDestroy()
    }
    companion object {
        const val ACTION_HISTORY = "org.veguide.android.ANALYSIS_HISTORY"
        private const val CHANNEL = "analysis"
        private const val NOTIFICATION = 201
        fun start(context: Context) { ContextCompat.startForegroundService(context, Intent(context, AnalysisQueueService::class.java)) }
    }
}
