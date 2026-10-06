package app.vegsnapp

import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** Explicit public lookup; never sends history, photos, provider credentials or cookies. */
internal class CommunityRepliesRepository(
    private val origin: HttpUrl,
    private val http: OkHttpClient = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
        .connectTimeout(15, TimeUnit.SECONDS).callTimeout(30, TimeUnit.SECONDS).build(),
) {
    suspend fun search(lookup: CommunityLookup): CommunityReplyPage {
        val url = origin.newBuilder().encodedPath("/api/replies").query(null).fragment(null).apply {
            lookup.parameters().forEach { (key, value) -> addQueryParameter(key, value) }
        }.build()
        val body = suspendCancellableCoroutine<String> { continuation ->
            val call = http.newCall(Request.Builder().url(url).header("Cache-Control", "no-store").build())
            continuation.invokeOnCancellation { call.cancel() }
            call.enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) {
                    if (continuation.isActive) continuation.resumeWithException(e)
                }
                override fun onResponse(call: Call, response: Response) {
                    response.use {
                        try {
                            if (!it.isSuccessful) throw IOException("Community service unavailable")
                            val bytes = it.body.byteStream().use { stream ->
                                val output = java.io.ByteArrayOutputStream()
                                val buffer = ByteArray(8192)
                                while (true) {
                                    val size = stream.read(buffer)
                                    if (size < 0) break
                                    if (output.size() + size > 4_000_000) throw IOException("Community response too large")
                                    output.write(buffer, 0, size)
                                }
                                output.toByteArray()
                            }
                            if (continuation.isActive) continuation.resume(bytes.toString(Charsets.UTF_8))
                        } catch (error: Exception) {
                            if (continuation.isActive) continuation.resumeWithException(error)
                        }
                    }
                }
            })
        }
        return parseCommunityReplies(body)
    }
}
