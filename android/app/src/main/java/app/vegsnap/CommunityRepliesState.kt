package app.vegsnap

import androidx.compose.runtime.*
import androidx.compose.ui.platform.LocalContext
import kotlinx.coroutines.CancellationException
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.json.JSONObject

internal class CommunityRepliesState(val original: CommunityLookup) {
    var lookup by mutableStateOf(original)
    var submitted by mutableStateOf(original)
    var editing by mutableStateOf(false)
    var expanded by mutableStateOf(true)
    var request by mutableIntStateOf(1)
    var loading by mutableStateOf(false)
    var page by mutableStateOf<CommunityReplyPage?>(null)
    var error by mutableStateOf<Int?>(null)
    var hidden by mutableStateOf<Set<String>>(emptySet())
    var confirmed by mutableStateOf<Set<String>>(emptySet())
    fun marketCorrection(): String? {
        val market = lookup.market.trim().uppercase(java.util.Locale.ROOT)
        return market.takeIf { validProductMarket(it) && it != original.market && lookup.copy(market = original.market) == original }
    }
    fun find() {
        page = null; confirmed = emptySet(); error = null
        if (runCatching { lookup.parameters() }.isFailure) { editing = true; error = R.string.community_invalid_lookup; return }
        submitted = lookup; editing = false; request++
    }
    fun appliedReplies(): List<CommunityReply> {
        if (page?.more == true) return emptyList()
        // Editing a lookup must not attach an unrelated product's evidence to the open scan.
        if (submitted.market.trim().uppercase(java.util.Locale.ROOT) != original.market.trim().uppercase(java.util.Locale.ROOT)) return emptyList()
        if (original.barcode.isNotBlank() && submitted.barcode.filter(Char::isDigit).padStart(14, '0') != original.barcode.filter(Char::isDigit).padStart(14, '0')) return emptyList()
        fun key(value: String) = java.text.Normalizer.normalize(value, java.text.Normalizer.Form.NFKC).lowercase(java.util.Locale.ROOT).trim().replace(Regex("\\s+"), " ")
        if (original.name.isNotBlank() && key(original.name) != key(submitted.name) || original.brand.isNotBlank() && key(original.brand) != key(submitted.brand)) return emptyList()
        return (page?.replies.orEmpty() + page?.candidates.orEmpty().filter { it.id in confirmed }.map { it.copy(match = "name") }).filter { it.id !in hidden }
    }
}

@Composable
internal fun rememberCommunityRepliesState(result: JSONObject, offline: Boolean,
    loadReplies: suspend (CommunityLookup) -> CommunityReplyPage): CommunityRepliesState {
    val context = LocalContext.current
    val identity = result.optJSONObject("identity") ?: JSONObject()
    val state = remember(result.optString("id"), identity.toString()) { CommunityRepliesState(CommunityLookup(
        identity.optString("name"), identity.optString("brand"), identity.optString("barcode"), identity.optString("market"))).apply { hidden = HiddenCommunityReplies(context).ids() } }
    LaunchedEffect(state, state.request, offline) {
        state.page = null; state.confirmed = emptySet(); state.error = null
        if (offline) { state.loading = false; return@LaunchedEffect }
        if (runCatching { state.submitted.parameters() }.isFailure) {
            state.editing = true; state.error = R.string.community_invalid_lookup; return@LaunchedEffect
        }
        state.loading = true
        try { state.page = loadReplies(state.submitted) }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) { state.error = R.string.community_load_failed }
        finally { state.loading = false }
    }
    return state
}

@Composable
internal fun rememberCommunityReplies(result: JSONObject, offline: Boolean): CommunityRepliesState? {
    val context = LocalContext.current
    val baseUrl = remember(context) { JSONObject(context.assets.open("community-service.json").bufferedReader().use { it.readText() }).optString("baseUrl") }
    val links = communityLinks(result, "en", baseUrl) ?: return null
    val repository = remember(baseUrl) { CommunityRepliesRepository(links.submit.substringBefore("/submit#").toHttpUrl()) }
    return rememberCommunityRepliesState(result, offline, repository::search)
}
