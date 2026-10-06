package app.vegsnapp

import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** Sanitized copies belong to the result, never to a gallery URI or the temporary camera cache. */
internal class HistoryPhotoStore(private val root: File) {
    private val writes = Mutex()
    private fun directory(id: String): File = File(root,
        MessageDigest.getInstance("SHA-256").digest(id.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) })

    fun files(id: String): List<File> = directory(id).listFiles()
        ?.filter { it.isFile && it.name.matches(Regex("[0-2]\\.jpg")) }?.sortedBy { it.name }.orEmpty()

    fun input(id: String): CheckInput? {
        val file = File(directory(id), "input.json")
        if (!file.isFile || file.length() > 150_000) return null
        return runCatching { decodeDraftInput(JSONObject(file.readText())) }.getOrNull()
    }

    suspend fun save(id: String, photos: List<ByteArray>, input: CheckInput? = null, persist: suspend () -> Unit) = writes.withLock {
        require(photos.size <= 3)
        val target = directory(id)
        check(!target.exists()) { "History photo ID already exists" }
        try {
            if (photos.isNotEmpty() || input != null) {
                check(target.mkdirs()) { "Cannot create history photo directory" }
                photos.forEachIndexed { index, bytes ->
                    require(bytes.isNotEmpty())
                    File(target, "$index.jpg").outputStream().use { it.write(bytes); it.fd.sync() }
                }
            }
            if (input != null) File(target, "input.json").outputStream().use {
                it.write(encodeDraftInput(input).toString().toByteArray(Charsets.UTF_8)); it.fd.sync()
            }
            persist()
        } catch (error: Throwable) {
            target.deleteRecursively()
            throw error
        }
    }

    suspend fun delete(id: String, persist: suspend () -> Unit) = writes.withLock {
        persist()
        directory(id).deleteRecursively()
    }

    suspend fun clear(persist: suspend () -> Unit) = writes.withLock {
        persist()
        root.deleteRecursively()
    }

    /** Also removes incomplete writes left by process termination. */
    suspend fun prune(readIds: suspend () -> List<String>) = writes.withLock {
        val keep = readIds().map { directory(it).name }.toSet()
        root.listFiles()?.filter { it.name !in keep }?.forEach { it.deleteRecursively() }
    }

    suspend fun importResults(ids: List<String>, persist: suspend () -> Unit) = writes.withLock {
        persist()
        // An imported result with the same ID must not inherit unrelated previous photo evidence.
        ids.forEach { directory(it).deleteRecursively() }
    }
}
