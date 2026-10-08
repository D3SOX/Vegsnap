package app.vegsnap

import android.net.Uri
import android.widget.Toast
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedCard
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.json.JSONObject

@Composable
internal fun CommunityRepliesSection(result: JSONObject, offline: Boolean) {
    val context = LocalContext.current
    val language = LocalConfiguration.current.locales[0].language
    val baseUrl = remember(context) { JSONObject(context.assets.open("community-service.json").bufferedReader().use { it.readText() }).optString("baseUrl") }
    val links = remember(result.toString(), language, baseUrl) { communityLinks(result, language, baseUrl) } ?: return
    val origin = links.submit.substringBefore("/submit#").toHttpUrl()
    val repository = remember(origin) { CommunityRepliesRepository(origin) }
    key(result.optString("id"), result.optJSONObject("identity")?.toString(), baseUrl) {
        CommunityRepliesViewer(result, offline, links, loadReplies = repository::search, open = { url ->
            runCatching { CustomTabsIntent.Builder().setShowTitle(true).build().launchUrl(context, Uri.parse(url)) }
                .onFailure { Toast.makeText(context, R.string.contact_open_failed, Toast.LENGTH_LONG).show() }
        })
    }
}

@Composable
internal fun CommunityRepliesViewer(
    result: JSONObject, offline: Boolean, links: CommunityLinks,
    loadReplies: suspend (CommunityLookup) -> CommunityReplyPage, open: (String) -> Unit,
) {
    val identity = result.optJSONObject("identity") ?: JSONObject()
    var lookup by remember { mutableStateOf(CommunityLookup(identity.optString("name"), identity.optString("brand"), identity.optString("barcode"), identity.optString("market"))) }
    var expanded by remember { mutableStateOf(false) }
    var editing by remember { mutableStateOf(false) }
    var request by remember { mutableIntStateOf(0) }
    var submitted by remember { mutableStateOf(lookup) }
    var loading by remember { mutableStateOf(false) }
    var page by remember { mutableStateOf<CommunityReplyPage?>(null) }
    var error by remember { mutableStateOf<Int?>(null) }
    fun find() {
        page = null
        error = null
        if (runCatching { lookup.parameters() }.isFailure) { editing = true; error = R.string.community_invalid_lookup; return }
        submitted = lookup
        editing = false
        loading = true
        request++
    }
    LaunchedEffect(request, offline, expanded) {
        if (offline || !expanded) { loading = false; page = null; error = null; return@LaunchedEffect }
        if (request == 0 || !loading) return@LaunchedEffect
        try { page = loadReplies(submitted) }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) { error = R.string.community_load_failed }
        finally { loading = false }
    }
    OutlinedCard(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(stringResource(R.string.community_replies), style = MaterialTheme.typography.titleMedium)
            Text(stringResource(R.string.community_notice), style = MaterialTheme.typography.bodySmall)
            Text(stringResource(R.string.community_lookup_notice), style = MaterialTheme.typography.bodySmall)
            if (offline) Text(stringResource(R.string.community_offline), style = MaterialTheme.typography.bodySmall)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                TextButton(onClick = { open(links.submit) }, enabled = !offline) { Text(stringResource(R.string.community_share)) }
                TextButton(onClick = { if (expanded) expanded = false else { expanded = true; find() } }, enabled = !offline) {
                    Text(stringResource(if (expanded) R.string.community_hide else R.string.community_view))
                }
            }
            if (expanded) {
                fun edit(value: CommunityLookup) { lookup = value; page = null; error = null }
                Text(listOf(lookup.name, lookup.brand, lookup.barcode, lookup.market).filter { it.isNotBlank() }.joinToString(" · "),
                    style = MaterialTheme.typography.bodySmall)
                if (editing) {
                    OutlinedTextField(lookup.name, { edit(lookup.copy(name = it.take(300))) }, label = { Text(stringResource(R.string.community_product_name)) },
                        modifier = Modifier.fillMaxWidth(), enabled = !loading && !offline, singleLine = true)
                    OutlinedTextField(lookup.brand, { edit(lookup.copy(brand = it.take(300))) }, label = { Text(stringResource(R.string.community_brand)) },
                        modifier = Modifier.fillMaxWidth(), enabled = !loading && !offline, singleLine = true)
                    OutlinedTextField(lookup.barcode, { edit(lookup.copy(barcode = it.take(40))) }, label = { Text(stringResource(R.string.community_barcode)) },
                        modifier = Modifier.fillMaxWidth(), enabled = !loading && !offline, singleLine = true)
                    OutlinedTextField(lookup.market, { edit(lookup.copy(market = it.take(2))) }, label = { Text(stringResource(R.string.community_market)) },
                        modifier = Modifier.fillMaxWidth(), enabled = !loading && !offline, singleLine = true)
                }
                FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    TextButton(onClick = { editing = !editing }, enabled = !loading && !offline) { Text(stringResource(R.string.community_edit_lookup)) }
                    TextButton(onClick = ::find, enabled = !loading && !offline) { Text(stringResource(R.string.community_find)) }
                }
                Column(Modifier.semantics { liveRegion = LiveRegionMode.Polite }, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (loading) Text(stringResource(R.string.community_loading), style = MaterialTheme.typography.bodySmall)
                    error?.let { Text(stringResource(it), color = MaterialTheme.colorScheme.error) }
                    page?.let { value ->
                        if (value.replies.isEmpty()) Text(stringResource(R.string.community_empty), style = MaterialTheme.typography.bodySmall)
                        else Text(stringResource(R.string.community_review_notice), style = MaterialTheme.typography.bodySmall)
                        value.replies.forEach { reply -> key(reply.id) { CommunityReplyCard(reply, links, open) } }
                        if (value.more) {
                            Text(stringResource(R.string.community_more), style = MaterialTheme.typography.bodySmall)
                            val queryResult = JSONObject().put("identity", JSONObject().put("name", submitted.name).put("brand", submitted.brand)
                                .put("barcode", submitted.barcode).put("market", submitted.market))
                            val website = communityLinks(queryResult, LocalConfiguration.current.locales[0].language, links.replies.substringBefore("/replies#"))!!.replies
                            TextButton(onClick = { open(website) }, enabled = !offline) { Text(stringResource(R.string.community_view_all)) }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun CommunityReplyCard(reply: CommunityReply, links: CommunityLinks, open: (String) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    OutlinedCard(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("${reply.brand} · ${reply.productName}", style = MaterialTheme.typography.titleSmall)
            CommunityReplyField(R.string.community_response_date, reply.repliedOn)
            CommunityReplyField(R.string.community_market, reply.market)
            if (reply.variant.isNotBlank()) CommunityReplyField(R.string.community_variant, reply.variant)
            CommunityReplyField(R.string.community_claim, stringResource(when (reply.claim) {
                "vegan" -> R.string.community_claim_vegan
                "not_vegan" -> R.string.community_claim_not_vegan
                else -> R.string.community_claim_inconclusive
            }))
            CommunityReplyField(R.string.community_scope, stringResource(when (reply.scope) {
                "whole_product" -> R.string.community_scope_product
                "ingredients" -> R.string.community_scope_ingredients
                else -> R.string.community_scope_processing
            }))
            CommunityReplyField(R.string.community_reviewed, reply.reviewedAt.take(10))
            TextButton(onClick = { expanded = !expanded }) { Text(stringResource(if (expanded) R.string.community_hide_reply else R.string.community_read_reply)) }
            if (expanded) {
                SelectionContainer {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        CommunityReplyField(R.string.community_question, reply.question)
                        CommunityReplyField(R.string.community_response, reply.reply)
                    }
                }
                if (!reply.evidencePublic) Text(stringResource(R.string.community_private_evidence), style = MaterialTheme.typography.bodySmall)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    if (reply.evidencePublic) TextButton(onClick = { open(links.replies.substringBefore("/replies#") + "/api/evidence/${reply.id}") }) {
                        Text(stringResource(R.string.community_evidence))
                    }
                    reply.sourceUrl?.let { url -> TextButton(onClick = { open(url) }) { Text(stringResource(R.string.community_source)) } }
                }
            }
        }
    }
}

@Composable
private fun CommunityReplyField(label: Int, value: String) {
    Column {
        Text(stringResource(label), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value, style = MaterialTheme.typography.bodyMedium)
    }
}
