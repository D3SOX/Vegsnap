package app.veguide

import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.InputStream
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

const val OCR_MODEL_REVISION = "87416418657359cb625c412a48b6e1d6d41c29bd"
data class OcrLanguage(val code: String, val tag: String, val nativeName: String, val bytes: Long, val sha256: String, val bundled: Boolean = false) {
    val url get() = "https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/$OCR_MODEL_REVISION/$code.traineddata"
}

// Every optional model is downloaded from this fixed revision and verified before installation.
val OCR_LANGUAGES = listOf(
    OcrLanguage("eng", "en", "English", 4113088, "7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2", true),
    OcrLanguage("deu", "de", "Deutsch", 1525436, "19d219bbb6672c869d20a9636c6816a81eb9a71796cb93ebe0cb1530e2cdb22d", true),
    OcrLanguage("swe", "sv", "Svenska", 4167034, "f7304988d41f833efebcc2d529df54b1903ecebbc3da1faabd19a0fddd4fe586"),
    OcrLanguage("dan", "da", "Dansk", 2580059, "acb1fd074487a31d1294fcdfd7d7c673467ffd8aeacb2ccd61ebcbf04eb4e2fa"),
    OcrLanguage("nor", "no", "Norsk", 3610079, "0451eb4f8049ae78196806bf878a389a2f40f1386fe038568cf4441226ba6ef2"),
    OcrLanguage("fin", "fi", "Suomi", 7865732, "61a04cd62b507c3d9ae0e1cda399e6715ebf49dea9df47897c8acdcd3bd3e13c"),
    OcrLanguage("fra", "fr", "Français", 1130365, "ced037562e8c80c13122dece28dd477d399af80911a28791a66a63ac1e3445ca"),
    OcrLanguage("spa", "es", "Español", 2294433, "6f2e04d02774a18f01bed44b1111f2cd7f3ba7ac9dc4373cd3f898a40ea6b464"),
    OcrLanguage("ita", "it", "Italiano", 2701314, "b8f89e1e785118dac4d51ae042c029a64edb5c3ee42ef73027a6d412748d8827"),
    OcrLanguage("por", "pt", "Português", 1982756, "c4932b937207a9514b7514d518b931a99938c02a28a5a5a553f8599ed58b7deb"),
    OcrLanguage("nld", "nl", "Nederlands", 6050296, "ced0e5e046a84c908a6aa7accbef9a232c4a5d9a8276691b81c6ee64d02963f6"),
    OcrLanguage("pol", "pl", "Polski", 4765518, "c4476cdbc0e33d898d32345122b7be1cbf85ace15f920f06c7714756e1ef79b2"),
    OcrLanguage("ukr", "uk", "Українська", 3825102, "d59e53e2bded32f4445f124b4b00240fcac7e8044c003ab822ccb94f0b3db59b"),
    OcrLanguage("rus", "ru", "Русский", 3861738, "e16e5e036cce1d9ec2b00063cf8b54472625b9e14d893a169e2b0dedeb4df225"),
    OcrLanguage("tur", "tr", "Türkçe", 4550554, "7393381111e1152420fc4092cb44eef4237580d21b92bf30d7d221aad192c6b7"),
    OcrLanguage("ara", "ar", "العربية", 1432056, "e3206d3dc87fd50c24a0fb9f01838615911d25168f4e64415244b67d2bb3e729"),
    OcrLanguage("jpn", "ja", "日本語", 2471260, "1f5de9236d2e85f5fdf4b3c500f2d4926f8d9449f28f5394472d9e8d83b91b4d"),
    OcrLanguage("kor", "ko", "한국어", 1677415, "6b85e11d9bbf07863b97b3523b1b112844c43e713df8b66418a081fd1060b3b2"),
    OcrLanguage("chi_sim", "zh-Hans", "简体中文", 2469156, "a5fcb6f0db1e1d6d8522f39db4e848f05984669172e584e8d76b6b3141e1f730"),
    OcrLanguage("chi_tra", "zh-Hant", "繁體中文", 2366642, "529c5b5797d64b126065cd55f2bb4c7fd7b15790798091b1ff259941a829330b"),
)

data class OcrLanguageState(
    val ready: Boolean = false,
    val installed: Set<String> = emptySet(),
    val selected: Set<String> = setOf("eng", "deu"),
    val downloading: String? = null,
    val downloadedBytes: Long = 0,
)

fun interface OcrModelDownload {
    suspend fun read(language: OcrLanguage, consume: (InputStream) -> Unit)
}

class HttpOcrModelDownload(private val http: OkHttpClient = OkHttpClient.Builder()
    .followRedirects(false).followSslRedirects(false).connectTimeout(15, TimeUnit.SECONDS)
    .readTimeout(20, TimeUnit.SECONDS).callTimeout(3, TimeUnit.MINUTES).build()) : OcrModelDownload {
    override suspend fun read(language: OcrLanguage, consume: (InputStream) -> Unit) = coroutineScope {
        val call = http.newCall(Request.Builder().url(language.url).build())
        // Cancellation closes a blocked socket. The caller retains its lock until I/O has stopped.
        val cancellation = launch(start = CoroutineStart.UNDISPATCHED) {
            try { awaitCancellation() } finally { call.cancel() }
        }
        try {
            withContext(Dispatchers.IO) {
                call.execute().use { response ->
                    check(response.isSuccessful) { "OCR download failed" }
                    val body = requireNotNull(response.body)
                    val length = body.contentLength()
                    require(length == -1L || length == language.bytes) { "Unexpected model size" }
                    consume(body.byteStream())
                }
            }
        } finally { cancellation.cancel() }
    }
}

/** Owns files and selection independently of provider settings. All native readers share this lock. */
class OcrLanguages(
    private val root: File,
    private val bundledSource: (String) -> InputStream,
    private val download: OcrModelDownload = HttpOcrModelDownload(),
    val catalog: List<OcrLanguage> = OCR_LANGUAGES,
) {
    private val mutex = Mutex()
    @Volatile private var downloadJob: Job? = null
    private val mutableState = MutableStateFlow(OcrLanguageState())
    val state = mutableState.asStateFlow()
    private val folder get() = File(root, "tessdata")
    private val selectionFile get() = File(root, "selected-languages")
    private fun file(language: OcrLanguage) = File(folder, "${language.code}.traineddata")
    private fun model(code: String) = catalog.single { it.code == code }

    suspend fun initialize() = withContext(Dispatchers.IO) { mutex.withLock { initializeLocked() } }

    private suspend fun initializeLocked() {
        if (state.value.ready) return
        check(folder.mkdirs() || folder.isDirectory)
        folder.listFiles()?.filter { it.name.endsWith(".download") }?.forEach { it.delete() }
        val installed = mutableSetOf<String>()
        for (language in catalog) {
            currentCoroutineContext().ensureActive()
            val target = file(language)
            if (target.exists() && !valid(target, language)) check(target.delete())
            if (language.bundled && !target.exists()) {
                val context = currentCoroutineContext()
                bundledSource(language.code).use { source -> install(language, source) { context.ensureActive() } }
            }
            if (target.exists()) installed += language.code
        }
        val saved = if (selectionFile.exists()) selectionFile.readText().lines().toSet() else emptySet()
        val selected = saved.intersect(installed).ifEmpty { catalog.filter { it.bundled }.map { it.code }.toSet().intersect(installed) }
        check(selected.isNotEmpty()) { "No OCR languages available" }
        saveSelection(selected)
        mutableState.value = OcrLanguageState(ready = true, installed = installed, selected = selected)
    }

    suspend fun setSelected(code: String, enabled: Boolean) = withContext(Dispatchers.IO) { mutex.withLock {
        initializeLocked()
        require(code in state.value.installed)
        val selected = if (enabled) state.value.selected + code else state.value.selected - code
        require(selected.isNotEmpty()) { "Keep at least one OCR language enabled" }
        saveSelection(selected)
        mutableState.update { it.copy(selected = selected) }
    } }

    suspend fun download(code: String, offline: Boolean) = withContext(Dispatchers.IO) { mutex.withLock {
        require(!offline) { "Downloads are unavailable in offline mode" }
        initializeLocked()
        val language = model(code)
        require(!language.bundled)
        if (code in state.value.installed) return@withLock
        mutableState.update { it.copy(downloading = code, downloadedBytes = 0) }
        val context = currentCoroutineContext()
        downloadJob = context.job
        try {
            download.read(language) { source -> install(language, source) { context.ensureActive() } }
            // Installation is verified and complete. Selection is only changed after a successful download.
            context.ensureActive()
            val selected = state.value.selected + code
            saveSelection(selected)
            mutableState.update { it.copy(installed = it.installed + code, selected = selected) }
        } catch (error: Exception) {
            file(language).delete()
            throw error
        } finally {
            downloadJob = null
            mutableState.update { it.copy(downloading = null, downloadedBytes = 0) }
        }
    } }

    fun cancelDownload() { downloadJob?.cancel() }
    suspend fun cancelAndJoinDownload() { downloadJob?.cancelAndJoin() }

    suspend fun remove(code: String) = withContext(Dispatchers.IO) { mutex.withLock {
        initializeLocked()
        val language = model(code)
        require(!language.bundled)
        val selected = state.value.selected - code
        require(selected.isNotEmpty()) { "Keep at least one OCR language enabled" }
        // Persist and publish the safe selection before touching a previously active model.
        saveSelection(selected)
        mutableState.update { it.copy(selected = selected) }
        if (file(language).exists()) check(file(language).delete())
        mutableState.update { it.copy(installed = it.installed - code) }
    } }

    /** The exact same initialized model set shown in Settings is passed to Tesseract. */
    suspend fun <T> withModels(recognize: (File, String) -> T): T = withContext(Dispatchers.IO) { mutex.withLock {
        initializeLocked()
        val languages = catalog.filter { it.code in state.value.selected }.joinToString("+") { it.code }
        recognize(root, languages)
    } }

    private fun saveSelection(selected: Set<String>) {
        val temporary = File(root, "selected-languages.tmp")
        try {
            temporary.writeText(catalog.filter { it.code in selected }.joinToString("\n") { it.code })
            check(temporary.renameTo(selectionFile)) { "Cannot save OCR selection" }
        } finally { temporary.delete() }
    }

    private fun valid(target: File, language: OcrLanguage): Boolean = target.length() == language.bytes &&
        target.inputStream().use { source ->
            val digest = MessageDigest.getInstance("SHA-256")
            val buffer = ByteArray(64 * 1024)
            while (true) { val count = source.read(buffer); if (count < 0) break; digest.update(buffer, 0, count) }
            digest.digest().hex() == language.sha256
        }

    private fun install(language: OcrLanguage, source: InputStream, ensureActive: () -> Unit) {
        val temporary = File(folder, "${language.code}.download")
        try {
            val digest = MessageDigest.getInstance("SHA-256")
            var total = 0L
            temporary.outputStream().use { output ->
                val buffer = ByteArray(64 * 1024)
                while (true) {
                    ensureActive()
                    val count = source.read(buffer)
                    if (count < 0) break
                    total += count
                    require(total <= language.bytes) { "OCR model exceeds expected size" }
                    digest.update(buffer, 0, count)
                    output.write(buffer, 0, count)
                    if (!language.bundled) mutableState.update { it.copy(downloadedBytes = total) }
                }
                ensureActive()
                require(total == language.bytes && digest.digest().hex() == language.sha256) { "OCR model integrity check failed" }
                output.fd.sync()
            }
            ensureActive()
            check(temporary.renameTo(file(language))) { "Cannot install OCR model" }
        } finally { temporary.delete() }
    }
}
private fun ByteArray.hex() = joinToString("") { "%02x".format(it) }
