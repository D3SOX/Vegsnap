package app.vegsnap

import android.content.Context
import androidx.core.content.edit
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONObject
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

internal fun contentServiceOrigin(context: Context): HttpUrl? {
    val base = JSONObject(context.assets.open("community-service.json").bufferedReader().use { it.readText() }).optString("baseUrl")
    return publicEvidenceUrl(base)?.toHttpUrlOrNull()?.takeIf { it.isHttps && it.username.isEmpty() && it.password.isEmpty() }
}

internal data class ContentReport(val kind: String, val contentId: String = "", val text: String = "", val reason: String) {
    fun json(): JSONObject {
        require(kind in setOf("ai", "community") && reason.isNotBlank() && reason.length <= 2000 && text.length <= 8000)
        require(if (kind == "ai") contentId.isEmpty() && text.isNotBlank() else
            text.isEmpty() && contentId.matches(Regex("[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")))
        return JSONObject().put("kind", kind).put("contentId", contentId).put("text", text.trim()).put("reason", reason.trim())
    }
}

internal class ContentReportsRepository(
    private val origin: HttpUrl,
    private val http: OkHttpClient = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
        .connectTimeout(15, TimeUnit.SECONDS).callTimeout(30, TimeUnit.SECONDS).build(),
) {
    suspend fun submit(report: ContentReport): String {
        val request = Request.Builder().url(origin.newBuilder().encodedPath("/api/reports").query(null).fragment(null).build())
            .header("Cache-Control", "no-store").post(report.json().toString().toRequestBody("application/json".toMediaType())).build()
        return suspendCancellableCoroutine { continuation ->
            val call = http.newCall(request)
            continuation.invokeOnCancellation { call.cancel() }
            call.enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) {
                    if (continuation.isActive) continuation.resumeWithException(e)
                }
                override fun onResponse(call: Call, response: Response) {
                    response.use {
                        try {
                            if (it.code != 201) throw IOException("Report service unavailable")
                            val bytes = it.body.byteStream().use { stream ->
                                val output = java.io.ByteArrayOutputStream()
                                val buffer = ByteArray(1024)
                                while (true) {
                                    val size = stream.read(buffer)
                                    if (size < 0) break
                                    if (output.size() + size > 4096) throw IOException("Report response too large")
                                    output.write(buffer, 0, size)
                                }
                                output.toByteArray()
                            }
                            if (bytes.size > 4096) throw IOException("Report response too large")
                            val id = JSONObject(bytes.toString(Charsets.UTF_8)).getString("id")
                            require(id.matches(Regex("[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")))
                            if (continuation.isActive) continuation.resume(id)
                        } catch (error: Exception) {
                            if (continuation.isActive) continuation.resumeWithException(error)
                        }
                    }
                }
            })
        }
    }
}

/** Anonymous reviewed replies have no contributor profiles; users can block individual records. */
internal class HiddenCommunityReplies(context: Context) {
    private val preferences = context.getSharedPreferences("hidden-community-replies", Context.MODE_PRIVATE)
    fun ids(): Set<String> = preferences.getStringSet("ids", emptySet())!!.toSet()
    fun hide(id: String): Set<String> = (ids() + id).also { preferences.edit { putStringSet("ids", it) } }
    fun clear() { preferences.edit { remove("ids") } }
}
