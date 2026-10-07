package app.vegsnapp

import android.app.Application
import android.net.Uri
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import androidx.room.Room
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONObject

data class ScanState(val text: String = "", val photos: List<Uri> = emptyList(), val category: String = "other",
    val complete: Boolean = false, val busy: Boolean = false, val capturing: Boolean = false,
    val result: String? = null, val message: Int? = null, val textTruncated: Boolean = false,
    val checkStage: CheckStage? = null, val checkStartedAt: Long? = null,
    val focusedJob: String? = null, val notificationRequest: Int = 0,
    val name: String = "", val barcode: String = "", val cameraBarcode: String = "", val photoBarcode: String = "", val barcodeLookingUp: Boolean = false) {
    fun forCheck(photosOnly: Boolean): ScanState = if (photosOnly) copy(text = "", name = "", barcode = photoBarcode, complete = false, textTruncated = false) else copy(barcode = barcode.ifBlank { photoBarcode })
    fun withText(value: String, replace: Boolean = false): ScanState {
        val bounded = boundedProductText(value)
        // Editing a displayed prefix does not restore the omitted suffix. Clearing/replacing starts afresh.
        return copy(text = bounded.text, textTruncated = bounded.truncated || !replace && value.isNotBlank() && textTruncated)
    }
}

class VegsnapViewModel(application: Application) : AndroidViewModel(application) {
    private val database = ApplicationHistoryDatabase.get(application)
    private val offlineDatabase = ApplicationOfflineDatabase.get(application)
    internal val offlineData = offlineDatabase.state
    private val mutableOfflineBusy = MutableStateFlow(false)
    internal val offlineDataBusy = mutableOfflineBusy.asStateFlow()
    private val mutableOfflineMessage = MutableStateFlow<Int?>(null)
    internal val offlineDataMessage = mutableOfflineMessage.asStateFlow()
    private val regionalPacks = RegionalPacks(java.io.File(application.noBackupFilesDir, "regional-downloads"), offlineDatabase)
    internal val regionalPackState = regionalPacks.state
    private var offlineDownloadJob: Job? = null
    private val queueStore = ApplicationAnalysisQueue.get(application)
    internal val queuedJobs = queueStore.jobs
    private val historyPhotos = ApplicationHistoryPhotos.get(application)
    private val preferences = SettingsStore(application)
    private val credentials = CredentialStore(application)
    private val chatGPT = ChatGPTConnection(application)
    private var authJob: Job? = null
    private val mutableChatGPT = MutableStateFlow(ChatGPTStatus())
    val chatGPTState = mutableChatGPT.asStateFlow()
    private val ocrLanguages = ApplicationOcrLanguages.get(application)
    val ocrState = ocrLanguages.state
    private var ocrJob: Job? = null
    private val mutableOcrMessage = MutableStateFlow<Int?>(null)
    val ocrMessage = mutableOcrMessage.asStateFlow()
    private val processor = PhotoProcessor(application, ocrLanguages)
    private var checkJob: Job? = null
    private var barcodeJob: Job? = null
    private val barcodeCoordinator = BarcodeScanCoordinator()
    private val barcodeRepository by lazy { CheckRepository(application) }
    private var disconnectingChatGPT = false
    private val mutableSettings = MutableStateFlow(AppSettings())
    val settings = mutableSettings.asStateFlow()
    private val mutableApiToken = MutableStateFlow("")
    val apiToken = mutableApiToken.asStateFlow()
    private val settingsReady = CompletableDeferred<Unit>()
    private val settingsWrites = Mutex()
    private var pendingSettingsWrites = 0
    private var settingsEditVersion = 0L
    val history = database.history().observe().stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())
    private val focusedResultIds = java.util.concurrent.ConcurrentHashMap<String, String>()
    private val mutableState = MutableStateFlow(ScanState())
    val state = mutableState.asStateFlow()
    private val mutableTab = MutableStateFlow("scan")
    val tab = mutableTab.asStateFlow()
    var hasSharedInput = false
    init {
        viewModelScope.launch(Dispatchers.IO) { offlineDatabase.initialize() }
        viewModelScope.launch(Dispatchers.IO) { regionalPacks.initialize() }
        viewModelScope.launch {
            combine(queuedJobs, history) { jobs, entries -> jobs to entries }.collect { (jobs, _) ->
                val focused = state.value.focusedJob ?: return@collect
                if (jobs.none { it.id == focused }) {
                    // Room's observed list may still contain the old version when a same-ID retry finishes.
                    val entry = withContext(Dispatchers.IO) { database.history().find(focusedResultIds[focused] ?: focused) }
                    entry?.let {
                        update { if (it.focusedJob == focused) it.copy(focusedJob = null, result = entry.json) else it }
                        focusedResultIds.remove(focused)
                    }
                }
            }
        }
        viewModelScope.launch {
            try { ocrLanguages.initialize() }
            catch (error: CancellationException) { throw error }
            catch (error: Exception) { mutableOcrMessage.value = R.string.ocr_error }
        }
        viewModelScope.launch {
        withContext(Dispatchers.IO) { CaptureFiles.get(application).clearPreviousProcess() }
        try {
            withContext(Dispatchers.IO) { historyPhotos.prune { database.history().ids() } }
            withContext(Dispatchers.IO) { queueStore.initialize() }
            val loaded = preferences.flow.first()
            mutableSettings.value = withDetectedVision(loaded)
            update { it.copy(category = loaded.defaultCategory) }
            mutableApiToken.value = withContext(Dispatchers.IO) { credentials.read(loaded.baseUrl) }
            if (!hasSharedInput) mutableTab.value = if (loaded.startTab == "last") loaded.lastTab else loaded.startTab
            if (queuedJobs.value.any { it.status == AnalysisStatus.QUEUED || it.status == AnalysisStatus.PAUSED && !loaded.offline }) startQueue()
        } catch (error: CancellationException) { throw error }
        catch (error: Exception) { update { it.copy(message = R.string.settings_error) } }
        finally { settingsReady.complete(Unit) }
        launch {
            preferences.flow.collect {
                if (pendingSettingsWrites == 0) refreshSavedSettings()
            }
        }
        mutableChatGPT.value = chatGPT.status()
    } }
    fun setOcrLanguage(code: String, enabled: Boolean) = ocrOperation { ocrLanguages.setSelected(code, enabled) }
    fun downloadOcrLanguage(code: String) = ocrOperation { ocrLanguages.download(code, settings.value.offline) }
    fun removeOcrLanguage(code: String) = ocrOperation { ocrLanguages.remove(code) }
    fun cancelOcrDownload() { ocrLanguages.cancelDownload(); ocrJob?.cancel() }
    private fun ocrOperation(action: suspend () -> Unit) {
        if (ocrJob?.isActive == true) return
        ocrJob = viewModelScope.launch {
            mutableOcrMessage.value = null
            try { action() }
            catch (error: CancellationException) { throw error }
            catch (error: Exception) { mutableOcrMessage.value = R.string.ocr_error }
        }
    }
    internal fun cameraBarcodeScanning(active: Boolean) {
        barcodeCoordinator.configure(active, settings.value.offline, allowOfflineLookup = true)
        if (!active || settings.value.offline) { barcodeJob?.cancel(); update { it.copy(barcodeLookingUp = false) } }
    }
    internal fun detectCameraBarcode(code: String) {
        if (!settingsReady.isCompleted) return
        val observation = barcodeCoordinator.observe(code) ?: return
        barcodeJob?.cancel()
        update { it.copy(cameraBarcode = observation.barcode, barcodeLookingUp = observation.lookup) }
        if (!observation.lookup) return
        val input = CheckInput(category = state.value.category, barcode = observation.barcode,
            locale = appLocale())
        barcodeJob = viewModelScope.launch {
            try {
                val result = withTimeout(60_000) { barcodeRepository.lookupBarcode(input, offline = settings.value.offline) }
                if (result == null || !barcodeCoordinator.accepts(observation) || state.value.capturing || state.value.photos.isNotEmpty()) return@launch
                val json = result.toString()
                val savedInput = input.copy(name = result.getJSONObject("identity").optString("name"), category = result.getString("category"))
                withContext(Dispatchers.IO) {
                    historyPhotos.save(result.getString("id"), emptyList(), savedInput) {
                        database.history().save(HistoryEntry(result.getString("id"), result.getString("title"), result.getString("checkedAt"), json))
                    }
                }
                if (barcodeCoordinator.accepts(observation) && !state.value.capturing && state.value.photos.isEmpty()) update { it.copy(result = json) }
            } catch (error: CancellationException) { throw error }
            catch (_: Exception) { /* Keep the scanned identifier for the user's explicit photo check. */ }
            finally { if (state.value.cameraBarcode == observation.barcode) update { it.copy(barcodeLookingUp = false) } }
        }
    }
    internal fun clearCameraBarcode() {
        barcodeJob?.cancel(); barcodeCoordinator.clear()
        update { it.copy(cameraBarcode = "", photoBarcode = "", barcodeLookingUp = false) }
    }
    fun selectTab(tab: String) { mutableTab.value = tab; updateSettings { it.copy(lastTab = tab) } }
    fun update(transform: (ScanState) -> ScanState) { mutableState.update(transform) }
    fun addPhotos(uris: List<Uri>) {
        if (state.value.busy) return
        update { it.copy(photos = (it.photos + uris).distinct().take(3),
            message = if ((it.photos + uris).distinct().size > 3) R.string.photo_limit else it.message) }
    }
    fun sharedPhotos(uris: List<Uri>) { hasSharedInput = true; addPhotos(uris); selectTab("manual") }
    fun removePhoto(uri: Uri) {
        if (state.value.busy || state.value.capturing) return
        update { val photos = it.photos - uri; it.copy(photos = photos, photoBarcode = if (photos.isEmpty()) "" else it.photoBarcode) }
        deleteTemporaryPhoto(uri)
    }
    private fun deleteTemporaryPhoto(uri: Uri) {
        if (uri.scheme != "file") return
        val file = java.io.File(uri.path ?: "")
        CaptureFiles.get(getApplication()).deleteOwned(file)
    }
    fun clearPhotos() {
        if (state.value.busy || state.value.capturing) return
        state.value.photos.forEach(::deleteTemporaryPhoto)
        update { it.copy(photos = emptyList(), photoBarcode = "") }
    }
    fun sharedText(text: String) { hasSharedInput = true; update { it.withText(text, replace = true) }; selectTab("manual") }
    fun updateSettings(transform: (AppSettings) -> AppSettings) = viewModelScope.launch(start = CoroutineStart.UNDISPATCHED) {
        settingsReady.await()
        val previous = settings.value
        val value = withDetectedVision(transform(previous))
        if (value == previous) return@launch
        mutableSettings.value = value
        if (value.defaultCategory != previous.defaultCategory) update {
            if (it.text.isBlank() && it.name.isBlank() && it.barcode.isBlank() && it.photos.isEmpty()) it.copy(category = value.defaultCategory) else it
        }
        if (value.offline && !previous.offline) {
            barcodeJob?.cancel(); barcodeCoordinator.configure(false, true)
            ApplicationAnalysisQueue.networkPaused = true
            authJob?.cancel()
            pauseNetworkQueue()
            ocrLanguages.cancelDownload()
            ocrJob?.cancel()
            regionalPacks.cancel()
            offlineDownloadJob?.cancel()
        }
        val endpointChanged = value.baseUrl != previous.baseUrl
        if (endpointChanged) mutableApiToken.value = ""
        pendingSettingsWrites++
        settingsEditVersion++
        try {
            settingsWrites.withLock {
                if (endpointChanged) withContext(Dispatchers.IO) { credentials.clear() }
                if (value.offline && !previous.offline) {
                    ocrLanguages.cancelAndJoinDownload(); ocrJob?.cancelAndJoin()
                    regionalPacks.cancelAndJoin(); offlineDownloadJob?.cancelAndJoin()
                }
                preferences.save(value)
                if (!value.offline && previous.offline) { ApplicationAnalysisQueue.networkPaused = false; startQueue() }
            }
        } catch (error: CancellationException) { throw error }
        catch (error: Exception) { update { it.copy(message = R.string.settings_error) } }
        finally { finishSettingsWrite() }
    }
    fun updateApiToken(endpoint: String, token: String) = viewModelScope.launch(start = CoroutineStart.UNDISPATCHED) {
        settingsReady.await()
        if (endpoint != settings.value.baseUrl) return@launch
        mutableApiToken.value = token
        pendingSettingsWrites++
        settingsEditVersion++
        try {
            settingsWrites.withLock {
                // An old field callback must never save its token against a newly selected provider.
                if (endpoint == settings.value.baseUrl) withContext(Dispatchers.IO) { credentials.save(endpoint, token) }
            }
        } catch (error: CancellationException) { throw error }
        catch (error: Exception) { update { it.copy(message = R.string.settings_error) } }
        finally { finishSettingsWrite() }
    }
    private fun withDetectedVision(value: AppSettings): AppSettings =
        value.copy(vision = modelVisionSupport(value, mutableChatGPT.value.models) ?: true)
    private fun acceptSavedSettings(saved: AppSettings) {
        if (saved.baseUrl != settings.value.baseUrl) mutableApiToken.value = ""
        mutableSettings.value = withDetectedVision(saved)
        ApplicationAnalysisQueue.networkPaused = saved.offline
    }
    private suspend fun finishSettingsWrite() {
        pendingSettingsWrites--
        if (pendingSettingsWrites != 0) return
        refreshSavedSettings()
    }
    private suspend fun refreshSavedSettings() {
        val version = settingsEditVersion
        try {
            val saved = preferences.flow.first()
            if (pendingSettingsWrites == 0 && settingsEditVersion == version) acceptSavedSettings(saved)
        } catch (error: CancellationException) { throw error }
        catch (error: Exception) { update { it.copy(message = R.string.settings_error) } }
    }
    fun disconnect() = viewModelScope.launch {
        stopConnectionQueue("api", settings.value.baseUrl)
        updateApiToken(settings.value.baseUrl, "").join()
        updateSettings { it.copy(aiEnabled = false) }.join()
    }
    fun returnFromChatGPT() {
        // Preserve the explicit route if preferences are still loading on a cold start.
        hasSharedInput = true
        selectTab("settings")
    }
    fun connectChatGPT(newAccount: Boolean = false, accountId: String? = null, openBrowser: (String) -> Unit) {
        if (disconnectingChatGPT || settings.value.offline || chatGPTState.value.busy) return
        authJob = viewModelScope.launch {
            mutableChatGPT.update { it.copy(busy = true, message = null) }
            try {
                mutableChatGPT.value = chatGPT.signIn(newAccount, accountId, openBrowser).copy(busy = true)
                try {
                    val models = chatGPT.models()
                    mutableChatGPT.update { it.copy(models = models) }
                    updateSettings { it }.join()
                } catch (error: CancellationException) { throw error }
                catch (error: Exception) { mutableChatGPT.update { it.copy(message = R.string.chatgpt_models_error) } }
            } catch (error: CancellationException) { throw error }
            catch (error: Exception) { mutableChatGPT.update { it.copy(message = chatGPTSignInMessage(error)) } }
            finally { withContext(NonCancellable) {
                // Even cancellation may follow a saved registration or completed credential write.
                val refreshed = try { chatGPT.status() } catch (error: CancellationException) { throw error }
                    catch (_: Exception) { null }
                mutableChatGPT.update { current ->
                    refreshed?.copy(message = current.message,
                        models = if (current.selectedAccount == refreshed.selectedAccount) current.models else emptyList())
                        ?: current.copy(busy = false)
                }
            } }
        }
    }
    fun loadChatGPTModels() {
        if (disconnectingChatGPT || settings.value.offline || chatGPTState.value.busy) return
        authJob = viewModelScope.launch {
            mutableChatGPT.update { it.copy(busy = true, message = null) }
            try { val models = chatGPT.models()
                mutableChatGPT.update { it.copy(models = models) }
                updateSettings { it }.join() }
            catch (error: CancellationException) { throw error }
            catch (error: Exception) { mutableChatGPT.update { it.copy(message = R.string.chatgpt_models_error) } }
            finally { mutableChatGPT.update { it.copy(busy = false) } }
        }
    }
    fun cancelChatGPT() { authJob?.cancel() }
    fun disconnectChatGPT() {
        if (disconnectingChatGPT) return
        disconnectingChatGPT = true
        val auth = authJob
        val scan = checkJob
        auth?.cancel()
        scan?.cancel()
        viewModelScope.launch {
            try {
                auth?.join()
                scan?.join()
                stopConnectionQueue("chatgpt")
                chatGPT.disconnect()
                mutableChatGPT.value = chatGPT.status()
                updateSettings { it.copy(aiEnabled = false, chatgptModel = "") }.join()
            } catch (error: CancellationException) { throw error }
            catch (error: Exception) { mutableChatGPT.update { it.copy(message = R.string.chatgpt_error) } }
            finally { disconnectingChatGPT = false }
        }
    }

    fun check() = performCheck(photosOnly = false)
    fun checkPhotos() = performCheck(photosOnly = true)
    private fun performCheck(photosOnly: Boolean) {
        if (disconnectingChatGPT || !settingsReady.isCompleted || state.value.busy || state.value.capturing) return
        if (photosOnly && state.value.photos.isEmpty() || !photosOnly && state.value.text.isBlank() && state.value.name.isBlank() && state.value.barcode.isBlank() && state.value.photos.isEmpty()) return
        val snapshot = state.value.forCheck(photosOnly)
        val connection = settings.value
        checkJob = viewModelScope.launch {
            update { it.copy(busy = true, message = null, result = null, focusedJob = null, checkStage = CheckStage.PREPARING,
                notificationRequest = it.notificationRequest + 1) }
            try {
                settingsReady.await()
                settingsWrites.withLock { }
                val photos = withContext(Dispatchers.IO) { snapshot.photos.map { ensureActive(); processor.prepare(it) } }
                val input = CheckInput(snapshot.text, snapshot.category, snapshot.complete.takeIf { it },
                    name = snapshot.name, barcode = snapshot.barcode,
                    locale = appLocale(), truncated = snapshot.textTruncated)
                ensureActive()
                withContext(NonCancellable) {
                    val job = withContext(Dispatchers.IO) { queueStore.enqueue(input, connection, photos.map { it.jpeg }) }
                    // Commit and clear form together, even if Cancel arrives during the file rename.
                    update { it.copy(photos = it.photos - snapshot.photos.toSet(), category = settings.value.defaultCategory,
                        text = if (photosOnly) it.text else "", name = if (photosOnly) it.name else "",
                        barcode = if (photosOnly) it.barcode else "", cameraBarcode = "", photoBarcode = "", barcodeLookingUp = false, complete = if (photosOnly) it.complete else false,
                        textTruncated = if (photosOnly) it.textTruncated else false, focusedJob = job.id) }
                    snapshot.photos.forEach(::deleteTemporaryPhoto)
                    startQueue()
                }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) { update { it.copy(message = R.string.queue_save_error) } }
            finally { update { it.copy(busy = false, checkStage = null, checkStartedAt = null) } }
        }
    }
    private fun startQueue() {
        try { AnalysisQueueService.start(getApplication()) }
        catch (error: Exception) {
            update { it.copy(message = R.string.queue_start_error) }
            viewModelScope.launch(Dispatchers.IO) {
                queuedJobs.value.filter { it.status == AnalysisStatus.QUEUED }.forEach { queueStore.stop(it.id, AnalysisStatus.INTERRUPTED) }
            }
        }
    }
    fun cancel() { checkJob?.cancel() }
    internal fun focusJob(id: String) {
        queueStore.get(id)?.historyId?.let { focusedResultIds[id] = it }
        update { it.copy(focusedJob = id, result = null) }
        viewModelScope.launch {
            // A fast/local retry may finish between enqueue returning and this screen focusing it.
            if (queueStore.get(id) == null) {
                val entry = withContext(Dispatchers.IO) { database.history().find(focusedResultIds[id] ?: id) }
                if (entry != null) {
                    update { if (it.focusedJob == id) it.copy(focusedJob = null, result = entry.json) else it }
                    focusedResultIds.remove(id)
                }
            }
        }
    }
    fun dismissProgress() { update { it.copy(focusedJob = null) } }
    internal fun retryJob(id: String) = viewModelScope.launch(Dispatchers.IO) {
        try { queueStore.retry(id); withContext(Dispatchers.Main) { focusJob(id); startQueue() } }
        catch (error: Exception) { update { it.copy(message = R.string.queue_save_error) } }
    }
    internal fun cancelJob(id: String) = viewModelScope.launch(Dispatchers.IO) {
        try { if (queueStore.stop(id, AnalysisStatus.CANCELLED)) ApplicationAnalysisQueue.cancelRunning?.invoke(id) }
        catch (error: Exception) { update { it.copy(message = R.string.queue_save_error) } }
    }
    internal fun removeJob(id: String) = viewModelScope.launch(Dispatchers.IO) {
        try {
            if (!queueStore.remove(id)) return@launch
            update { if (it.focusedJob == id) it.copy(focusedJob = null) else it }
        } catch (error: Exception) { update { it.copy(message = R.string.queue_save_error) } }
    }
    private suspend fun stopConnectionQueue(connection: String, endpoint: String? = null) = withContext(Dispatchers.IO) {
        queuedJobs.value.filter { it.settings.connection == connection && (endpoint == null || it.settings.baseUrl == endpoint) }.forEach { job ->
            if (queueStore.stop(job.id, AnalysisStatus.CANCELLED)) ApplicationAnalysisQueue.cancelRunning?.invoke(job.id)?.join()
        }
    }
    private fun pauseNetworkQueue() = viewModelScope.launch(Dispatchers.IO) {
        queuedJobs.value.filter { !it.settings.offline && it.status in listOf(AnalysisStatus.QUEUED, AnalysisStatus.RUNNING) }.forEach { job ->
            if (queueStore.stop(job.id, AnalysisStatus.PAUSED)) ApplicationAnalysisQueue.cancelRunning?.invoke(job.id)
        }
    }
    internal suspend fun queuedPhotos(id: String): List<Uri> = withContext(Dispatchers.IO) { queueStore.files(id).map(Uri::fromFile) }
    fun openQueueHistory() { hasSharedInput = true; dismissProgress(); selectTab("history") }
    fun open(entry: HistoryEntry) {
        val retry = activeHistoryRetry(entry.id, queuedJobs.value)
        if (retry != null) {
            // Keep the destination even if the job finishes before focusJob reads the queue.
            focusedResultIds[retry.id] = entry.id
            focusJob(retry.id)
        } else update { it.copy(result = entry.json, focusedJob = null) }
    }
    suspend fun savedPhotos(id: String): List<Uri> = withContext(Dispatchers.IO) { historyPhotos.files(id).map(Uri::fromFile) }
    fun retryHistory(result: JSONObject) {
        if (state.value.busy || state.value.capturing || disconnectingChatGPT) return
        viewModelScope.launch {
            try {
                settingsReady.await()
                settingsWrites.withLock { }
                val sendToAI = canSendBarcodeToAI(result)
                val connection = settings.value.let { if (sendToAI) it.copy(aiEnabled = true) else it }
                if (sendToAI) {
                    if (connection.offline) return@launch
                    val configured = if (connection.connection == "chatgpt") chatGPTState.value.connected && connection.chatgptModel.isNotBlank()
                        else validEndpoint(connection.baseUrl) && connection.model.isNotBlank()
                    if (!configured) {
                        update { it.copy(result = null) }
                        selectTab("settings")
                        return@launch
                    }
                }
                val id = result.getString("id")
                val job = withContext(Dispatchers.IO) {
                    queueStore.withHistoryMutation {
                        if (database.history().find(id) == null) null
                        else {
                            val input = historyPhotos.input(id) ?: recheckInput(result)
                            queueStore.enqueueHistory(id, input, connection, historyPhotos.files(id).map { it.readBytes() })
                        }
                    }
                } ?: return@launch
                focusedResultIds[job.id] = id
                focusJob(job.id)
                startQueue()
            } catch (error: CancellationException) { throw error }
            catch (error: Exception) { update { it.copy(message = R.string.queue_save_error) } }
        }
    }

    fun recheck(result: JSONObject) {
        if (state.value.busy || state.value.capturing) return
        viewModelScope.launch {
            try {
                val id = result.getString("id")
                val restored = recheckInput(result)
                val original = withContext(Dispatchers.IO) { historyPhotos.input(id) }
                val input = original?.copy(name = original.name.ifBlank { restored.name },
                    barcode = original.barcode.ifBlank { restored.barcode }) ?: restored
                val photos = savedPhotos(id)
                if (state.value.busy || state.value.capturing) return@launch
                clearPhotos()
                update { it.copy(text = input.text, name = input.name, barcode = input.barcode, photos = photos,
                    category = input.category, complete = input.complete == true, result = null,
                    textTruncated = input.truncated, focusedJob = null) }
                selectTab("manual")
            } catch (error: CancellationException) { throw error }
            catch (error: Exception) { update { it.copy(message = R.string.history_error) } }
        }
    }
    fun delete(id: String) = historyOperation {
        queueStore.deleteHistoryRetries(setOf(id), { ApplicationAnalysisQueue.cancelRunning?.invoke(it) }) {
            historyPhotos.delete(id) { database.history().delete(id) }
        }
        dismissDeletedHistory(setOf(id))
    }
    fun deleteAll() = historyOperation {
        // Delete the history visible at invocation, not new checks that finish while retries are stopped.
        val ids = database.history().ids()
        queueStore.deleteHistoryRetries(null, { ApplicationAnalysisQueue.cancelRunning?.invoke(it) }) {
            ids.forEach { id -> historyPhotos.delete(id) { database.history().delete(id) } }
        }
        dismissDeletedHistory(ids.toSet())
    }
    private fun dismissDeletedHistory(ids: Set<String>) {
        update { current ->
            val resultId = current.result?.let { runCatching { JSONObject(it).optString("id") }.getOrNull() }
            val focusedId = current.focusedJob?.let { focusedResultIds[it] ?: it }
            current.copy(result = current.result.takeUnless { resultId != null && resultId in ids },
                focusedJob = current.focusedJob.takeUnless { focusedId != null && focusedId in ids })
        }
        focusedResultIds.entries.removeAll { it.value in ids }
    }
    private fun historyOperation(action: suspend () -> Unit) = viewModelScope.launch(Dispatchers.IO) {
        try { action() }
        catch (error: CancellationException) { throw error }
        catch (error: Exception) { update { it.copy(message = R.string.history_error) } }
    }
    internal fun importOfflinePack(uri: Uri) = viewModelScope.launch(Dispatchers.IO) {
        if (!mutableOfflineBusy.compareAndSet(false, true)) return@launch
        mutableOfflineMessage.value = null
        try {
            val stream = getApplication<Application>().contentResolver.openInputStream(uri) ?: error("Cannot read pack")
            offlineDatabase.import(stream)
        } catch (error: CancellationException) { throw error }
        catch (_: Exception) { mutableOfflineMessage.value = R.string.offline_pack_error }
        finally { mutableOfflineBusy.value = false }
    }
    internal fun removeOfflinePack(id: String) = viewModelScope.launch(Dispatchers.IO) {
        if (!mutableOfflineBusy.compareAndSet(false, true)) return@launch
        mutableOfflineMessage.value = null
        try { offlineDatabase.removeImported(id) }
        catch (error: CancellationException) { throw error }
        catch (_: Exception) { mutableOfflineMessage.value = R.string.offline_pack_error }
        finally { mutableOfflineBusy.value = false }
    }
    internal fun refreshRegionalPacks(url: String) = regionalOperation(catalog = true) { regionalPacks.refresh(url.trim(), settings.value.offline) }
    internal fun downloadRegionalPack(id: String) = regionalOperation(catalog = false) { regionalPacks.install(id, settings.value.offline) }
    internal fun cancelRegionalDownload() { regionalPacks.cancel(); offlineDownloadJob?.cancel() }
    private fun regionalOperation(catalog: Boolean, action: suspend () -> Unit) {
        if (settings.value.offline || !mutableOfflineBusy.compareAndSet(false, true)) return
        mutableOfflineMessage.value = null
        offlineDownloadJob = viewModelScope.launch(start = CoroutineStart.UNDISPATCHED) {
            try { action() }
            catch (error: CancellationException) { throw error }
            catch (error: Exception) { mutableOfflineMessage.value = regionalPackErrorMessage(error, catalog) }
            finally { mutableOfflineBusy.value = false }
        }
    }
    private fun appLocale(): String = if (getApplication<Application>().resources.configuration.locales[0].language == "de") "de" else "en"
    fun export(uri: Uri) { viewModelScope.launch(Dispatchers.IO) {
        runCatching { getApplication<Application>().contentResolver.openOutputStream(uri)?.bufferedWriter()?.use { it.write(HistoryTransfer.export(history.value, appLocale())) } }
            .onFailure { update { it.copy(message = R.string.network_error) } }
    } }
    fun import(uri: Uri) { viewModelScope.launch(Dispatchers.IO) {
        runCatching {
            val stream = getApplication<Application>().contentResolver.openInputStream(uri) ?: error("Cannot read file")
            val text = stream.bufferedReader().use { reader ->
                val output = StringBuilder()
                val buffer = CharArray(8192)
                while (true) { val count = reader.read(buffer); if (count < 0) break; output.append(buffer, 0, count); require(output.length <= 5_000_000) }
                output.toString()
            }
            val entries = HistoryTransfer.parse(text, appLocale())
            historyPhotos.importResults(entries.map { it.id }) { database.history().saveAll(entries) }
        }.onFailure { update { it.copy(message = R.string.network_error) } }
    } }
}

internal object ApplicationHistoryPhotos {
    private var instance: HistoryPhotoStore? = null
    @Synchronized fun get(application: Application): HistoryPhotoStore = instance
        ?: HistoryPhotoStore(java.io.File(application.noBackupFilesDir, "history-photos")).also { instance = it }
}

/** Sharing can create another activity; every activity must use the same model-file lock and state. */
internal object ApplicationOcrLanguages {
    private var instance: OcrLanguages? = null
    @Synchronized fun get(application: Application): OcrLanguages = instance ?: OcrLanguages(
        java.io.File(application.noBackupFilesDir, "ocr"),
        { language -> application.assets.open("tessdata/$language.traineddata") },
    ).also { instance = it }
}
