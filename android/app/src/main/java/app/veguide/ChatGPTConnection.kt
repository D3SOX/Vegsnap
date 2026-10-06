package app.veguide

import android.content.Context
import com.nimbusds.jose.JWSAlgorithm
import com.nimbusds.jose.crypto.ECDSAVerifier
import com.nimbusds.jose.crypto.RSASSAVerifier
import com.nimbusds.jose.jwk.JWKSet
import com.nimbusds.jose.jwk.ECKey
import com.nimbusds.jose.jwk.RSAKey
import com.nimbusds.jwt.SignedJWT
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import okhttp3.*
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.io.InputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.SocketTimeoutException
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

internal const val CHATGPT_ISSUER = "https://auth.openai.com"
internal const val CHATGPT_RESOURCE = "https://api.openai.com/v1"
internal const val CHATGPT_BOOTSTRAP = "dynamic_agent_client"
private const val CHATGPT_SCOPE = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct"

data class ChatGPTModel(val id: String, val name: String, val supportsVision: Boolean? = null)
data class ChatGPTStatus(val connected: Boolean = false, val email: String = "", val busy: Boolean = false,
    val message: Int? = null, val models: List<ChatGPTModel> = emptyList())
internal data class ChatGPTIdentity(val subject: String, val email: String)

internal fun oauthRandom(): String = Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(32).also { SecureRandom().nextBytes(it) })
// Sign-in requires a stable UUIDv4 URN, unlike the fresh opaque state/nonce/PKCE values.
internal fun chatGPTHostId(read: () -> String?, save: (String) -> Unit): String {
    val stored = read()
    if (stored != null) {
        require(stored.matches(Regex("urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", RegexOption.IGNORE_CASE))) {
            "Invalid ChatGPT host identifier. Reset only the id preference in chatgpt-host; history and credentials can be retained."
        }
        return stored
    }
    return "urn:uuid:${UUID.randomUUID()}".also(save)
}
internal fun pkceChallenge(verifier: String): String = Base64.getUrlEncoder().withoutPadding()
    .encodeToString(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.US_ASCII)))
internal fun chatGPTAuthorization(host: String, clientId: String, redirect: String, state: String, nonce: String, verifier: String): String {
    val url = "$CHATGPT_ISSUER/api/accounts/authorize".toHttpUrl().newBuilder()
    mapOf("client_id" to clientId, "ext_agent_host_id" to host, "response_type" to "code", "redirect_uri" to redirect,
        "scope" to CHATGPT_SCOPE, "resource" to CHATGPT_RESOURCE, "state" to state, "nonce" to nonce,
        "code_challenge_method" to "S256", "code_challenge" to pkceChallenge(verifier)).forEach { (key, value) -> url.addQueryParameter(key, value) }
    if (clientId == CHATGPT_BOOTSTRAP) url.addQueryParameter("agent_name_hint", "Veguide")
    return url.build().toString()
}
internal fun chatGPTCallback(target: String, state: String, returningId: String?): Pair<String, String> {
    require(target.startsWith("/auth/callback?")) { "Invalid callback path" }
    val url = "http://127.0.0.1$target".toHttpUrl()
    require(url.encodedPath == "/auth/callback" && url.fragment == null)
    require(url.queryParameterNames.all { url.queryParameterValues(it).size == 1 }) { "Repeated callback parameter" }
    require(url.queryParameter("state") == state) { "Invalid sign-in state" }
    require(url.queryParameter("error") == null) { "Sign-in declined" }
    val clientId = url.queryParameter("client_id") ?: returningId
    require(!clientId.isNullOrBlank() && clientId != CHATGPT_BOOTSTRAP) { "Issued client ID missing" }
    require(returningId == null || returningId == clientId) { "Registration changed" }
    val code = url.queryParameter("code")
    require(!code.isNullOrBlank()) { "Authorization code missing" }
    return code to clientId
}

internal fun verifyChatGPTIdentity(token: String, clientId: String, nonce: String?, keys: JWKSet, now: Long = System.currentTimeMillis()): ChatGPTIdentity {
    require(token.length <= 32_000)
    val jwt = SignedJWT.parse(token)
    val algorithm = jwt.header.algorithm
    require(algorithm == JWSAlgorithm.RS256 || algorithm == JWSAlgorithm.ES256) { "Unsupported identity signature" }
    val keyId = requireNotNull(jwt.header.keyID)
    val key = requireNotNull(keys.getKeyByKeyId(keyId)) { "Unknown identity key" }
    require(key.keyUse == null || key.keyUse.identifier() == "sig")
    require(key.algorithm == null || key.algorithm == algorithm)
    val verifier = when {
        algorithm == JWSAlgorithm.RS256 && key is RSAKey -> RSASSAVerifier(key.toRSAPublicKey())
        algorithm == JWSAlgorithm.ES256 && key is ECKey -> ECDSAVerifier(key.toECPublicKey())
        else -> error("Identity key algorithm mismatch")
    }
    require(jwt.verify(verifier)) { "Identity signature invalid" }
    val claims = jwt.jwtClaimsSet
    require(claims.issuer == CHATGPT_ISSUER && clientId in claims.audience)
    require(claims.audience.size <= 1 || claims.getStringClaim("azp") == clientId)
    require(requireNotNull(claims.expirationTime).time > now - 30_000)
    require(claims.notBeforeTime == null || claims.notBeforeTime.time <= now + 30_000)
    require(requireNotNull(claims.issueTime).time <= now + 30_000)
    require(!claims.subject.isNullOrBlank())
    require(nonce == null || claims.getStringClaim("nonce") == nonce)
    return ChatGPTIdentity(claims.subject, claims.getStringClaim("email").orEmpty())
}
internal fun chatGPTScopes(tokens: JSONObject, previous: JSONArray? = null): JSONArray {
    require(tokens.getString("token_type").equals("bearer", ignoreCase = true))
    require(tokens.getString("access_token").isNotBlank() && tokens.getLong("expires_in") in 1..31_536_000)
    val scopes = if (tokens.has("scope")) JSONArray(tokens.getString("scope").split(Regex("\\s+"))) else previous ?: JSONArray()
    require((0 until scopes.length()).any { scopes.getString(it) == "chatgpt.tokens.use.direct" }) { "ChatGPT plan usage not granted" }
    return scopes
}

internal fun refreshedChatGPTSession(previous: JSONObject, tokens: JSONObject, identity: ChatGPTIdentity?, now: Long = System.currentTimeMillis() / 1000): JSONObject {
    val scopes = chatGPTScopes(tokens, previous.getJSONArray("scopes"))
    val next = JSONObject(previous.toString())
    if (tokens.has("id_token")) {
        requireNotNull(identity)
        require(identity.subject == previous.getString("subject")) { "Account changed during refresh" }
        next.put("id_token", tokens.getString("id_token")).put("email", identity.email)
    }
    next.put("access_token", tokens.getString("access_token")).put("scopes", scopes)
        .put("expires_at", now + tokens.getLong("expires_in"))
    if (tokens.optString("refresh_token").isNotBlank()) next.put("refresh_token", tokens.getString("refresh_token"))
    return next
}

data class ChatGPTExtraction(val text: String, val research: JSONObject)

/** SSE output is usable only when the provider confirms completion, never just after a delta. */
internal fun readChatGPTStream(stream: InputStream, onResearchStarted: () -> Unit = {}, onDiagnostic: (String) -> Unit = {}): ChatGPTExtraction {
    val reader = stream.bufferedReader()
    val data = StringBuilder()
    val output = StringBuilder()
    var completed = false
    val completedItems = JSONArray()
    var research = JSONObject().put("searched", false).put("sources", JSONArray())
    var read = 0
    var eventType = ""
    var events = 0
    var terminalText = ""
    val doneText = StringBuilder()
    fun messageText(items: JSONArray): String = buildString {
        for (i in 0 until items.length()) {
            val item = items.optJSONObject(i) ?: continue
            if (item.optString("type") != "message") continue
            val parts = item.optJSONArray("content") ?: continue
            for (j in 0 until parts.length()) {
                val part = parts.optJSONObject(j) ?: continue
                if (part.optString("type") == "output_text") append(part.optString("text"))
            }
        }
    }
    fun event() {
        if (data.isEmpty()) return
        val value = data.toString().trim()
        data.setLength(0)
        if (value == "[DONE]") return
        val json = JSONObject(value)
        events++
        val type = json.optString("type").ifBlank { eventType }
        eventType = ""
        if (json.has("error") || type in setOf("response.failed", "response.incomplete", "error")) {
            onDiagnostic(streamFailureDiagnostic(json, type))
            throw providerStreamFailure(json, type)
        }
        when (type) {
            "response.output_text.delta" -> output.append(json.getString("delta"))
            "response.output_text.done" -> doneText.append(json.getString("text"))
            "response.web_search_call.in_progress", "response.web_search_call.searching" -> onResearchStarted()
            "response.output_item.done" -> {
                val item = json.optJSONObject("item")
                if (item?.optString("type") in setOf("web_search_call", "message")) completedItems.put(item)
                if (item?.optString("type") == "web_search_call") {
                    onResearchStarted()
                }
            }
            "response.completed" -> {
                val response = json.optJSONObject("response")
                if (response != null && response.optString("status", "completed") != "completed") {
                    onDiagnostic(streamFailureDiagnostic(json, type))
                    throw providerStreamFailure(json, type)
                }
                val finalItems = response?.optJSONArray("output") ?: JSONArray()
                terminalText = messageText(finalItems).ifBlank { messageText(completedItems) }
                for (index in 0 until finalItems.length()) completedItems.put(finalItems.get(index))
                // The terminal event may omit or repeat items already delivered by output_item.done.
                // Research is returned only after successful terminal completion; failed streams throw.
                research = responseResearch(JSONObject().put("output", completedItems))
                completed = true
            }
        }
        require(output.length <= 100_000 && terminalText.length <= 100_000 && doneText.length <= 100_000) { "ChatGPT output too large" }
    }
    // Character-at-a-time bounds prevent a single unterminated SSE line from allocating without limit.
    val line = StringBuilder()
    while (true) {
        val char = reader.read()
        if (char < 0) break
        require(++read <= 2_000_000) { "ChatGPT stream too large" }
        if (char == 10) {
            val value = line.toString().removeSuffix("\r")
            line.setLength(0)
            if (value.isEmpty()) { event(); if (completed) break }
            else if (value.startsWith("event:")) eventType = value.substring(6).trim()
            else if (value.startsWith("data:")) { if (data.isNotEmpty()) data.append('\n'); data.append(value.substring(5).trimStart()) }
        } else line.append(char.toChar())
    }
    if (line.startsWith("data:")) data.append(line.substring(5).trim())
    event()
    val text = terminalText.ifBlank { doneText.toString().ifBlank { output.toString() } }
    onDiagnostic("stream completed=$completed events=$events text_present=${text.isNotBlank()}")
    if (!completed) throw AIProviderFailure(AIErrorCode.INCOMPLETE)
    if (text.isBlank()) throw AIProviderFailure(AIErrorCode.INVALID_RESPONSE)
    return ChatGPTExtraction(text, research)
}

// All connections in this app share one credential vault and refresh-token rotation lock.
private val chatGPTAccountMutex = Mutex()
internal suspend fun <T> withChatGPTSession(loadSession: suspend () -> JSONObject, request: suspend (JSONObject) -> T): T {
    val session = chatGPTAccountMutex.withLock { loadSession() }
    currentCoroutineContext().ensureActive()
    return request(session)
}

/** Owns one account. Network destinations are fixed; API-key credentials use a separate vault. */
class ChatGPTConnection(private val context: Context) {
    private val vault = CredentialStore(context, "chatgpt")
    private val hostPreferences = context.getSharedPreferences("chatgpt-host", Context.MODE_PRIVATE)
    private val registrations = ChatGPTRegistrations(
        { hostPreferences.getString("registration", null) },
        { check(hostPreferences.edit().putString("registration", it).commit()) { "Cannot save ChatGPT registration" } },
    )
    private val mutex = chatGPTAccountMutex
    private val http = OkHttpClient.Builder().dispatcher(Dispatcher().apply { maxRequestsPerHost = 10 }).followRedirects(false).followSslRedirects(false)
        .connectTimeout(15, TimeUnit.SECONDS).readTimeout(90, TimeUnit.SECONDS).callTimeout(120, TimeUnit.SECONDS).build()
    private fun load(): JSONObject? = vault.read(CHATGPT_ISSUER).takeIf { it.isNotBlank() }?.let(::JSONObject)?.also { registrations.selected(it) }
    private fun save(session: JSONObject) = vault.save(CHATGPT_ISSUER, session.toString())
    suspend fun status(): ChatGPTStatus = withContext(Dispatchers.IO) { mutex.withLock {
        load()?.let { ChatGPTStatus(true, it.optString("email")) } ?: ChatGPTStatus()
    } }
    suspend fun disconnect() = withContext(Dispatchers.IO) { mutex.withLock { load(); vault.clear() } }
    suspend fun signIn(openBrowser: (String) -> Unit): ChatGPTStatus = withContext(Dispatchers.IO) { mutex.withLock {
        val previous = load()
        val registration = registrations.selected(previous)
        val returning = registration?.clientId
        val host = chatGPTHostId({ hostPreferences.getString("id", null) }) { check(hostPreferences.edit().putString("id", it).commit()) }
        val nonce = oauthRandom(); val state = oauthRandom(); val verifier = oauthRandom()
        val template = context.assets.open("auth-completion.html").bufferedReader().use { it.readText() }
        val callback = ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))
        val redirect = "http://127.0.0.1:${callback.localPort}/auth/callback"
        callback.use { listener ->
            listener.soTimeout = 500
            withContext(Dispatchers.Main) { openBrowser(chatGPTAuthorization(host, returning ?: CHATGPT_BOOTSTRAP, redirect, state, nonce, verifier)) }
            val deadline = System.nanoTime() + TimeUnit.MINUTES.toNanos(3)
            while (true) {
                currentCoroutineContext().ensureActive()
                if (System.nanoTime() >= deadline) throw ChatGPTSignInException(ChatGPTSignInStage.TIMEOUT)
                val socket = try { listener.accept() } catch (_: SocketTimeoutException) { continue }
                socket.use {
                    it.soTimeout = 1500
                    val requestText = StringBuilder()
                    try {
                        val stream = it.getInputStream()
                        while (requestText.length <= 16_384) {
                            currentCoroutineContext().ensureActive()
                            if (System.nanoTime() >= deadline) throw ChatGPTSignInException(ChatGPTSignInStage.TIMEOUT)
                            val c = stream.read()
                            if (c < 0) break
                            requestText.append(c.toChar())
                            if (requestText.endsWith("\r\n\r\n") || requestText.endsWith("\n\n")) break
                        }
                    } catch (error: ChatGPTSignInException) { throw error }
                    catch (_: IOException) { return@use }
                    val parts = requestText.lineSequence().first().trim().split(' ')
                    val target = parts.getOrNull(1).orEmpty()
                    val parsed = runCatching { require(requestText.length <= 16_384 && parts.firstOrNull() == "GET"); chatGPTCallback(target, state, returning) }
                    fun respond(accepted: Boolean) {
                        val page = chatGPTCompletionPage(template, accepted,
                            context.getString(if (accepted) R.string.chatgpt_browser_pending else R.string.chatgpt_browser_failed),
                            context.getString(if (accepted) R.string.chatgpt_browser_pending_message else R.string.chatgpt_browser_failure_message),
                            context.getString(R.string.chatgpt_browser_return), context.resources.configuration.locales[0].language)
                        sendChatGPTBrowserResponse(socket, chatGPTCompletionResponse(page, accepted))
                    }
                    if (parsed.isFailure) {
                        runCatching { respond(false) }
                        if (runCatching { "http://127.0.0.1$target".toHttpUrl().queryParameter("state") == state }.getOrDefault(false)) {
                            throw ChatGPTSignInException(ChatGPTSignInStage.CALLBACK)
                        }
                        return@use
                    }
                    val (code, clientId) = parsed.getOrThrow()
                    return@withLock completeChatGPTCallback({
                        // Retain the state-validated registration even if token exchange fails.
                        // It is not a connected session until tokens and identity are verified.
                        chatGPTSignInStage(ChatGPTSignInStage.STORAGE) { registrations.rememberIssued(clientId) }
                        val tokens = chatGPTSignInStage(ChatGPTSignInStage.EXCHANGE) {
                            json(Request.Builder().url("$CHATGPT_ISSUER/api/accounts/oauth/token").post(FormBody.Builder()
                                .add("grant_type", "authorization_code").add("client_id", clientId).add("code", code).add("code_verifier", verifier)
                                .add("redirect_uri", redirect).add("resource", CHATGPT_RESOURCE).build()).build())
                        }
                        val scopes = chatGPTSignInStage(ChatGPTSignInStage.GRANT) { chatGPTScopes(tokens) }
                        val identity = chatGPTSignInStage(ChatGPTSignInStage.IDENTITY) { identity(tokens.getString("id_token"), clientId, nonce) }
                        if (registration?.matchesSubject(identity.subject) == false) throw ChatGPTSignInException(ChatGPTSignInStage.ACCOUNT)
                        val session = chatGPTSignInStage(ChatGPTSignInStage.GRANT) {
                            require(tokens.getString("refresh_token").isNotBlank())
                            JSONObject().put("client_id", clientId).put("subject", identity.subject).put("email", identity.email)
                                .put("id_token", tokens.getString("id_token")).put("access_token", tokens.getString("access_token"))
                                .put("refresh_token", tokens.getString("refresh_token")).put("scopes", scopes)
                                .put("expires_at", System.currentTimeMillis() / 1000 + tokens.getLong("expires_in"))
                        }
                        currentCoroutineContext().ensureActive()
                        chatGPTSignInStage(ChatGPTSignInStage.STORAGE) {
                            registrations.verified(clientId, identity.subject)
                            save(session)
                        }
                        ChatGPTStatus(true, identity.email)
                    }, { respond(true) })
                }
            }
            @Suppress("UNREACHABLE_CODE")
            error("Sign-in listener closed")
        }
    } }
    private suspend fun identity(token: String, clientId: String, nonce: String?): ChatGPTIdentity {
        val keys = json(Request.Builder().url("$CHATGPT_ISSUER/.well-known/jwks.json").build())
        return verifyChatGPTIdentity(token, clientId, nonce, JWKSet.parse(keys.toString()))
    }
    private suspend fun activeSession(): JSONObject {
        val session = load() ?: throw AIProviderFailure(AIErrorCode.AUTHENTICATION)
        if (session.getLong("expires_at") > System.currentTimeMillis() / 1000 + 60) return session
        // Finish rotating-token storage even if the calling scan is cancelled halfway through refresh.
        return withContext(NonCancellable) {
            val tokens = json(Request.Builder().url("$CHATGPT_ISSUER/api/accounts/oauth/token").post(FormBody.Builder()
                .add("grant_type", "refresh_token").add("client_id", session.getString("client_id"))
                .add("refresh_token", session.getString("refresh_token")).add("resource", CHATGPT_RESOURCE).build()).build())
            val identity = if (tokens.has("id_token")) identity(tokens.getString("id_token"), session.getString("client_id"), null) else null
            val refreshed = refreshedChatGPTSession(session, tokens, identity)
            save(refreshed)
            refreshed
        }
    }

    suspend fun models(): List<ChatGPTModel> = withContext(Dispatchers.IO) { withChatGPTSession(::activeSession) { session ->
        val response = json(authorized("/models", session).build()).getJSONArray("models")
        (0 until response.length()).map { response.getJSONObject(it) }.filter { it.optString("visibility") == "list" }
            .map { ChatGPTModel(it.getString("slug"), it.getString("display_name"), knownModelVisionSupport(it.getString("slug"), it)) }
    } }
    suspend fun extract(model: String, prompt: String, text: String, images: List<String>, requireResearch: Boolean = false, onResearchStarted: () -> Unit = {}): ChatGPTExtraction = withContext(Dispatchers.IO) { withChatGPTSession(::activeSession) { session ->
        require(model.isNotBlank() && model.length <= 200 && text.length <= 32_000 && images.size <= 3)
        val content = JSONArray().put(JSONObject().put("type", "input_text").put("text", text.ifBlank { "Read the product labels in these photos." }))
        images.forEach { require(it.startsWith("data:image/jpeg;base64,") && it.length <= 4_000_000); content.put(JSONObject().put("type", "input_image").put("image_url", it)) }
        val body = JSONObject().put("model", model).put("instructions", prompt).put("store", false).put("stream", true)
            .put("tools", JSONArray().put(JSONObject().put("type", "web_search")))
            .put("include", JSONArray().put("web_search_call.action.sources"))
            .put("input", JSONArray().put(JSONObject().put("role", "user").put("content", content)))
        if (requireResearch) body.put("tool_choice", "required")
        request(authorized("/responses", session).post(body.toString().toRequestBody("application/json".toMediaType())).build()) { readChatGPTStream(it, onResearchStarted) { diagnostic -> android.util.Log.i("VeguideAI", diagnostic) } }
    } }
    private fun authorized(path: String, session: JSONObject) = Request.Builder().url(CHATGPT_RESOURCE + path)
        .header("Authorization", "Bearer ${session.getString("access_token")}")
    private suspend fun json(request: Request): JSONObject = request(request) { stream ->
        val bytes = stream.readBytesBounded(1_000_000)
        JSONObject(String(bytes, Charsets.UTF_8))
    }
    private suspend fun <T> request(request: Request, consume: (InputStream) -> T): T = suspendCancellableCoroutine { continuation ->
        val call = http.newCall(request)
        continuation.invokeOnCancellation { call.cancel() }
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) { if (continuation.isActive) continuation.resumeWithException(e) }
            override fun onResponse(call: Call, response: Response) { response.use {
                try {
                    if (!response.isSuccessful) throw providerHttpFailure(response.code, response.body.byteStream())
                    val result = consume(response.body.byteStream())
                    if (continuation.isActive) continuation.resume(result)
                } catch (e: Exception) { if (continuation.isActive) continuation.resumeWithException(e) }
            } }
        })
    }
}
private fun InputStream.readBytesBounded(limit: Int): ByteArray {
    val output = java.io.ByteArrayOutputStream()
    val buffer = ByteArray(8192)
    while (output.size() <= limit) { val read = read(buffer, 0, minOf(buffer.size, limit + 1 - output.size())); if (read < 0) break; output.write(buffer, 0, read) }
    require(output.size() <= limit) { "Response too large" }
    return output.toByteArray()
}
