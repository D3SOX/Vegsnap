package app.vegsnapp

import java.security.MessageDigest
import org.json.JSONObject

/** Registration identity survives local sign-out; it contains no tokens or account email. */
internal data class ChatGPTRegistration(val clientId: String, val subjectHash: String? = null) {
    fun matchesSubject(subject: String): Boolean = subjectHash == null || subjectHash == hashSubject(subject)
    fun json(): JSONObject = JSONObject().put("client_id", clientId).apply { subjectHash?.let { put("subject_hash", it) } }
}
internal class ChatGPTRegistrations(private val read: () -> String?, private val write: (String) -> Unit) {
    private fun validateClientId(clientId: String) {
        require(clientId != CHATGPT_BOOTSTRAP && clientId.matches(Regex("[A-Za-z0-9_-]{1,200}"))) { "Invalid issued ChatGPT client ID" }
    }
    private fun current(): ChatGPTRegistration? = read()?.let { value ->
        val json = JSONObject(value)
        val clientId = json.getString("client_id").also(::validateClientId)
        val subjectHash = json.optString("subject_hash").takeIf { it.isNotBlank() }
        require(subjectHash == null || subjectHash.matches(Regex("[a-f0-9]{64}"))) { "Invalid saved account binding" }
        ChatGPTRegistration(clientId, subjectHash)
    }
    private fun save(registration: ChatGPTRegistration): ChatGPTRegistration {
        val text = registration.json().toString()
        if (read() != text) write(text)
        return registration
    }
    fun selected(session: JSONObject?): ChatGPTRegistration? = session?.let {
        verified(it.getString("client_id"), it.getString("subject"))
    } ?: current()
    fun rememberIssued(clientId: String): ChatGPTRegistration {
        validateClientId(clientId)
        val existing = current()
        require(existing == null || existing.clientId == clientId) { "Registration changed" }
        return existing ?: save(ChatGPTRegistration(clientId))
    }
    fun verified(clientId: String, subject: String): ChatGPTRegistration {
        require(subject.isNotBlank())
        val issued = rememberIssued(clientId)
        val hash = hashSubject(subject)
        require(issued.matchesSubject(subject)) { "ChatGPT account changed" }
        return save(issued.copy(subjectHash = hash))
    }
}

private fun hashSubject(subject: String): String = MessageDigest.getInstance("SHA-256").digest(subject.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
