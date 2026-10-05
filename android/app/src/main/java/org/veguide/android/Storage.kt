package org.veguide.android

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.datastore.preferences.core.*
import androidx.datastore.preferences.preferencesDataStore
import androidx.room.*
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import org.json.JSONArray
import org.json.JSONObject
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

@Entity(tableName = "checks")
data class HistoryEntry(@PrimaryKey val id: String, val title: String, val checkedAt: String, val json: String)
@Dao
interface HistoryDao {
    @Query("SELECT * FROM checks ORDER BY checkedAt DESC") fun observe(): Flow<List<HistoryEntry>>
    @Query("SELECT id FROM checks") suspend fun ids(): List<String>
    @Query("SELECT * FROM checks WHERE id = :id") suspend fun find(id: String): HistoryEntry?
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun save(entry: HistoryEntry)
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun saveAll(entries: List<HistoryEntry>)
    @Query("DELETE FROM checks WHERE id = :id") suspend fun delete(id: String)
    @Query("DELETE FROM checks") suspend fun clear()
}
@Database(entities = [HistoryEntry::class], version = 1, exportSchema = false)
abstract class HistoryDatabase : RoomDatabase() { abstract fun history(): HistoryDao }

data class AppSettings(
    val aiEnabled: Boolean = true, val baseUrl: String = "https://api.openai.com/v1",
    val model: String = "", val vision: Boolean = true,
    val startTab: String = "scan", val lastTab: String = "scan", val offline: Boolean = false,
    val connection: String = "chatgpt", val chatgptModel: String = "", val defaultCategory: String = "other", val parallelChecks: Int = 3,
)
internal fun appSettingsFromPreferences(p: Preferences): AppSettings = AppSettings(
    p[booleanPreferencesKey("ai")] ?: true, p[stringPreferencesKey("url")] ?: "https://api.openai.com/v1",
    p[stringPreferencesKey("model")] ?: "", p[booleanPreferencesKey("vision")] ?: true,
    p[stringPreferencesKey("start")] ?: "scan", p[stringPreferencesKey("last")] ?: "scan",
    p[booleanPreferencesKey("offline")] ?: false,
    p[stringPreferencesKey("connection")] ?: "chatgpt", p[stringPreferencesKey("chatgptModel")] ?: "",
    p[stringPreferencesKey("defaultCategory")]?.takeIf { it in setOf("other", "food", "drink", "cosmetics", "household", "clothing", "shoes") } ?: "other",
    (p[androidx.datastore.preferences.core.intPreferencesKey("parallelChecks")] ?: 3).coerceIn(1, 10),
)
private val Context.settingsDataStore by preferencesDataStore("settings")
class SettingsStore(private val context: Context) {
    val flow = context.settingsDataStore.data.map(::appSettingsFromPreferences)
    suspend fun save(settings: AppSettings) { context.settingsDataStore.edit {
        it[booleanPreferencesKey("ai")] = settings.aiEnabled
        it[stringPreferencesKey("url")] = settings.baseUrl
        it[stringPreferencesKey("model")] = settings.model
        it[booleanPreferencesKey("vision")] = settings.vision
        it[stringPreferencesKey("start")] = settings.startTab
        it[stringPreferencesKey("last")] = settings.lastTab
        it[booleanPreferencesKey("offline")] = settings.offline
        it[stringPreferencesKey("connection")] = settings.connection
        it[stringPreferencesKey("chatgptModel")] = settings.chatgptModel
        it[stringPreferencesKey("defaultCategory")] = settings.defaultCategory
        it[androidx.datastore.preferences.core.intPreferencesKey("parallelChecks")] = settings.parallelChecks.coerceIn(1, 10)
    } }
}

/** Key material stays in Android Keystore. Ciphertext is bound to its exact API endpoint. */
class CredentialStore(context: Context, namespace: String = "api") {
    private val preferences = context.getSharedPreferences("credential-$namespace", Context.MODE_PRIVATE)
    private val alias = "veguide-$namespace-v1"
    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        return (store.getKey(alias, null) as? SecretKey) ?: KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
            generateKey()
        }
    }
    fun save(endpoint: String, token: String) {
        if (token.isBlank()) { clear(); return }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        cipher.updateAAD(endpoint.toByteArray())
        val encrypted = cipher.doFinal(token.toByteArray())
        preferences.edit().putString("endpoint", endpoint)
            .putString("iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
            .putString("ciphertext", Base64.encodeToString(encrypted, Base64.NO_WRAP)).commit().also { check(it) { "Cannot save credentials" } }
    }
    fun read(endpoint: String): String {
        if (preferences.getString("endpoint", null) != endpoint) return ""
        val iv = preferences.getString("iv", null) ?: return ""
        val encrypted = preferences.getString("ciphertext", null) ?: return ""
        return runCatching {
            Cipher.getInstance("AES/GCM/NoPadding").run {
                init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)))
                updateAAD(endpoint.toByteArray())
                String(doFinal(Base64.decode(encrypted, Base64.NO_WRAP)))
            }
        }.getOrElse { clear(); "" }
    }
    fun clear() { check(preferences.edit().clear().commit()) { "Cannot clear credentials" } }
}

object HistoryTransfer {
    fun export(entries: List<HistoryEntry>, locale: String = "en"): String = JSONObject().put("schemaVersion", 1)
        .put("exportedAt", java.time.Instant.now().toString())
        .put("results", JSONArray(entries.map { publicResult(JSONObject(it.json), locale) })).toString(2)
    private fun publicResult(result: JSONObject, locale: String): JSONObject {
        val clean = JSONObject()
        listOf("schemaVersion", "id", "outcome", "basis", "title", "summary", "category", "identity", "findings", "evidence", "questions", "warnings", "crossContact", "companyConcerns", "checkedAt", "usedAI", "aiStatus", "webSearchStatus")
            .forEach { field -> if (result.has(field)) clean.put(field, result.get(field)) }
        // Never trust a transferred message or extra fields in an error envelope.
        if (clean.optString("aiStatus") == "failed") {
            val code = result.optJSONObject("aiError")?.optString("code")
            AIErrorCode.entries.firstOrNull { it.code == code }?.let { clean.put("aiError", it.json(locale)) }
        }
        return clean
    }
    fun parse(text: String, locale: String = "en"): List<HistoryEntry> {
        require(text.toByteArray().size <= 5_000_000) { "History file exceeds 5 MB" }
        val document = JSONObject(text)
        require(document.getInt("schemaVersion") == 1)
        val results = document.getJSONArray("results")
        require(results.length() <= 1000)
        return (0 until results.length()).map { index ->
            val result = results.getJSONObject(index)
            require(result.getInt("schemaVersion") == 1)
            require(result.getString("outcome") in setOf("vegan", "not_vegan", "uncertain", "conflicting"))
            require(result.getString("id").length in 1..100)
            require(result.getString("title").length <= 500)
            require(result.get("summary") is String && result.getString("summary").length <= 30_000)
            require(result.getString("basis") in setOf("composition", "insufficient", "certified", "manufacturer", "packaging", "research"))
            if (result.has("webSearchStatus")) require(result.optString("webSearchStatus") in setOf("searched", "not_used", "unsupported"))
            if (result.has("aiStatus")) require(result.optString("aiStatus") in setOf("not_needed", "disabled", "offline", "unconfigured", "vision_disabled", "failed", "text", "images"))
            require(result.getString("category") in setOf("food", "drink", "cosmetics", "household", "clothing", "shoes", "other"))
            for (field in listOf("warnings", "questions", "crossContact")) {
                val values = result.getJSONArray(field)
                require(values.length() <= 100)
                for (i in 0 until values.length()) require(values.get(i) is String && values.getString(i).length <= 30_000)
            }
            for (field in listOf("findings", "evidence", "companyConcerns")) {
                val values = result.getJSONArray(field)
                require(values.length() <= 1000)
                for (i in 0 until values.length()) {
                    val item = values.getJSONObject(i)
                    val names = when (field) {
                        "findings" -> listOf("term", "status", "explanation", "evidenceId")
                        "evidence" -> listOf("id", "kind", "title", "excerpt", "retrievedAt")
                        else -> listOf("company", "category", "description", "sourceUrl", "reviewedAt", "status")
                    }
                    names.forEach { require(item.get(it) is String && item.getString(it).length <= 30_000) }
                    if (field == "findings" && (item.has("displayTerm") || item.has("displayLocale"))) {
                        require(item.opt("displayTerm") is String && item.getString("displayTerm").isNotBlank() && item.getString("displayTerm").length <= 300)
                        require(item.optString("displayLocale") in setOf("en", "de"))
                    }
                }
            }
            java.time.Instant.parse(result.getString("checkedAt"))
            val clean = publicResult(result, locale)
            HistoryEntry(clean.getString("id"), clean.getString("title"), clean.getString("checkedAt"), clean.toString())
        }
    }
}
