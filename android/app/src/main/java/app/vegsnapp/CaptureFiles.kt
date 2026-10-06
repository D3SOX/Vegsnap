package app.vegsnapp

import android.content.Context
import java.io.File

/** One cleanup per process, shared by all activity/view-model instances. */
internal class CaptureFileStore(private val cacheDir: File) {
    private var initialized = false
    @Synchronized fun clearPreviousProcess() {
        if (initialized) return
        cacheDir.listFiles()?.filter { it.name.startsWith("scan-") }?.forEach { it.delete() }
        initialized = true
    }
    @Synchronized fun create(): File {
        clearPreviousProcess()
        return File.createTempFile("scan-", ".jpg", cacheDir)
    }
    fun deleteOwned(file: File) {
        if (file.parentFile == cacheDir && file.name.startsWith("scan-") && file.extension == "jpg") file.delete()
    }
}
internal object CaptureFiles {
    private var instance: CaptureFileStore? = null
    @Synchronized fun get(context: Context): CaptureFileStore = instance
        ?: CaptureFileStore(context.cacheDir).also { instance = it }
}
