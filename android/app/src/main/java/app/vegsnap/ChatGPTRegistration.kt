package app.vegsnap

import java.security.MessageDigest
import org.json.JSONArray
import org.json.JSONObject

/** Verified account labels survive local sign-out; renewable credentials do not. */
internal data class ChatGPTRegistration(val clientId: String, val subjectHash: String? = null, val email: String = "") {
    fun matchesSubject(subject: String): Boolean = subjectHash == null || subjectHash == hashSubject(subject)
    fun json(): JSONObject = JSONObject().put("client_id", clientId).apply {
        subjectHash?.let { put("subject_hash", it) }
        if (email.isNotBlank()) put("email", email)
    }
}
internal class ChatGPTRegistrations(private val read: () -> String?, private val write: (String) -> Unit) {
    private fun validateClientId(clientId: String) {
        require(clientId != CHATGPT_BOOTSTRAP && clientId.matches(Regex("[A-Za-z0-9_-]{1,200}"))) { "Invalid issued ChatGPT client ID" }
    }
    private fun parse(json: JSONObject): ChatGPTRegistration {
        val clientId = json.getString("client_id").also(::validateClientId)
        val subjectHash = json.optString("subject_hash").takeIf { it.isNotBlank() }
        require(subjectHash == null || subjectHash.matches(Regex("[a-f0-9]{64}"))) { "Invalid saved account binding" }
        return ChatGPTRegistration(clientId, subjectHash, json.optString("email"))
    }
    private fun stored(): Pair<String?, List<ChatGPTRegistration>> {
        val json = read()?.let(::JSONObject) ?: return null to emptyList()
        // The single-registration format is already on main; retain those account bindings.
        if (!json.has("registrations")) return parse(json).let { it.clientId to listOf(it) }
        val entries = json.getJSONArray("registrations")
        val accounts = (0 until entries.length()).map { parse(entries.getJSONObject(it)) }
        val selected = json.optString("selected_client_id").takeIf { it.isNotBlank() }
        require(accounts.map { it.clientId }.distinct().size == accounts.size &&
            (if (selected == null) accounts.isEmpty() else accounts.any { it.clientId == selected })) {
            "Invalid saved ChatGPT registrations"
        }
        return selected to accounts
    }
    fun accounts(): List<ChatGPTRegistration> = stored().second
    private fun current(): ChatGPTRegistration? = stored().let { (selected, accounts) -> accounts.find { it.clientId == selected } }
    private fun save(registration: ChatGPTRegistration): ChatGPTRegistration {
        val accounts = accounts().toMutableList()
        val index = accounts.indexOfFirst { it.clientId == registration.clientId }
        if (index < 0) accounts += registration else accounts[index] = registration
        persist(registration.clientId, accounts)
        return registration
    }
    private fun persist(selected: String?, accounts: List<ChatGPTRegistration>) {
        val text = JSONObject().put("selected_client_id", selected)
            .put("registrations", JSONArray(accounts.map { it.json() })).toString()
        if (read() != text) write(text)
    }
    fun remove(clientId: String) {
        val (selected, accounts) = stored()
        val remaining = accounts.filterNot { it.clientId == clientId }
        if (remaining.size == accounts.size) return
        persist(if (selected == clientId) remaining.firstOrNull()?.clientId else selected, remaining)
    }
    fun remove(clientId: String, activeSession: JSONObject?, clearCredentials: () -> Unit) {
        // A crash between these writes may retain a disconnected label, never orphan active credentials.
        if (activeSession?.optString("client_id") == clientId) clearCredentials()
        remove(clientId)
    }
    fun selected(session: JSONObject?): ChatGPTRegistration? = session?.let {
        verified(it.getString("client_id"), it.getString("subject"), it.optString("email"))
    } ?: current()
    fun forSignIn(session: JSONObject?, newAccount: Boolean = false, clientId: String? = null): ChatGPTRegistration? {
        val selected = selected(session)
        require(!newAccount || clientId == null)
        if (newAccount) return null
        return if (clientId == null) selected else requireNotNull(accounts().find { it.clientId == clientId }) { "Unknown ChatGPT account" }
    }
    fun rememberIssued(clientId: String, newAccount: Boolean = false): ChatGPTRegistration {
        validateClientId(clientId)
        val accounts = accounts()
        val existing = accounts.find { it.clientId == clientId }
        require(newAccount || accounts.isEmpty() || existing != null) { "Registration changed" }
        return save(existing ?: ChatGPTRegistration(clientId))
    }
    fun verified(clientId: String, subject: String, email: String = ""): ChatGPTRegistration {
        require(subject.isNotBlank())
        validateClientId(clientId)
        val accounts = accounts()
        val issued = accounts.find { it.clientId == clientId } ?: run {
            require(accounts.isEmpty()) { "Registration changed" }
            ChatGPTRegistration(clientId)
        }
        val hash = hashSubject(subject)
        require(issued.matchesSubject(subject)) { "ChatGPT account changed" }
        return save(issued.copy(subjectHash = hash, email = email.ifBlank { issued.email }))
    }
}

private fun hashSubject(subject: String): String = MessageDigest.getInstance("SHA-256").digest(subject.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
