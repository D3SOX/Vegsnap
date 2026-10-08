package app.vegsnap

import java.security.SecureRandom
import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

internal data class HostedAIStatus(val state: String = "signedout", val remaining: Int? = null, val busy: Boolean = false, val message: Int? = null, val enabled: Boolean? = null)
internal fun isHostedAIAppReturn(uri: String?): Boolean = uri == "vegsnap://ai/complete"
internal class HostedAIConnection(val baseUrl: String, val model: String, private val http: OkHttpClient = CheckRepository.defaultHttpClient()) {
    init { require(validEndpoint(baseUrl) && baseUrl.isNotBlank()) }
    suspend fun connect(installationId: String, existingToken: String = ""): String {
        require(installationId.matches(Regex("[a-f0-9]{64}")))
        val token = existingToken.takeIf { it.matches(Regex("[a-f0-9]{64}")) }
            ?: ByteArray(32).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it) }
        request(token, "POST", JSONObject().put("installationId", installationId))
        return token
    }
    fun browserUrl(token: String): String { require(token.matches(Regex("[a-f0-9]{64}"))); return "$baseUrl/#token=$token&client=android" }
    suspend fun status(token: String): HostedAIStatus {
        val result = try { request(token, "GET") } catch (error: AIProviderFailure) {
            if (error.reason == AIErrorCode.AUTHENTICATION) return HostedAIStatus(message = R.string.hosted_ai_error)
            throw error
        }
        val state = result.getString("state")
        require(state in setOf("pending", "connected") && result.get("remaining") is Number && result.get("expiresAt") is Number && result.get("enabled") is Boolean)
        return HostedAIStatus(state, result.getInt("remaining"), enabled = result.getBoolean("enabled"))
    }
    suspend fun disconnect(token: String) { request(token, "DELETE") }
    private suspend fun request(token: String, method: String, payload: JSONObject = JSONObject()): JSONObject = suspendCancellableCoroutine { continuation ->
        val path = if (method == "POST") "/api/connect" else "/api/session"
        val request = Request.Builder().url(baseUrl + path).header("Authorization", "Bearer $token")
            .method(method, if (method == "POST") payload.toString().toRequestBody("application/json".toMediaType()) else null).build()
        val call = http.newCall(request)
        continuation.invokeOnCancellation { call.cancel() }
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, error: java.io.IOException) { if (continuation.isActive) continuation.resumeWithException(error) }
            override fun onResponse(call: Call, response: Response) {
                response.use {
                    try {
                        if (!response.isSuccessful) throw providerHttpFailure(response.code, response.body.byteStream())
                        val bytes = response.body.byteStream().use { stream ->
                            val output = java.io.ByteArrayOutputStream()
                            val buffer = ByteArray(1024)
                            while (output.size() <= 4096) {
                                val count = stream.read(buffer, 0, minOf(buffer.size, 4097 - output.size()))
                                if (count < 0) break
                                output.write(buffer, 0, count)
                            }
                            output.toByteArray()
                        }
                        require(bytes.size <= 4096)
                        val result = JSONObject(String(bytes, Charsets.UTF_8))
                        if (continuation.isActive) continuation.resume(result)
                    } catch (error: Exception) { if (continuation.isActive) continuation.resumeWithException(error) }
                }
            }
        })
    }
}
