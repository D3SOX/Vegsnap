package app.vegsnap

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedCard
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import org.json.JSONObject

@Composable
internal fun CompanyConcernSection(result: JSONObject, showHeading: Boolean = true) {
    if (showHeading) Text(stringResource(R.string.concerns), style = MaterialTheme.typography.titleMedium)
    val concerns = result.optJSONArray("companyConcerns")
    if (concerns == null || concerns.length() == 0) {
        Text(stringResource(if (result.optJSONObject("identity")?.optString("brand").isNullOrBlank()) R.string.company_unknown_brand else R.string.company_no_record), style = MaterialTheme.typography.bodySmall)
        return
    }
    Text(stringResource(R.string.company_separate_verdict), style = MaterialTheme.typography.bodySmall)
    for (index in 0 until concerns.length()) {
        val item = concerns.optJSONObject(index) ?: continue
        OutlinedCard { Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(item.optString("company"), style = MaterialTheme.typography.titleSmall)
            Text(stringResource(if (item.optString("scope") == "parent") R.string.company_parent_of else R.string.company_direct_match,
                item.optString("matchedBrand", item.optString("company"))), style = MaterialTheme.typography.bodySmall)
            Text(stringResource(when (item.optString("category")) {
                "animal_testing" -> R.string.company_animal_testing
                "animal_welfare_lobbying" -> R.string.company_lobbying
                else -> R.string.company_exploitation
            }) + " · " + stringResource(when (item.optString("status")) {
                "resolved" -> R.string.company_resolved
                "disputed" -> R.string.company_disputed
                else -> R.string.company_current
            }), style = MaterialTheme.typography.labelLarge)
            Text(item.optString("description"), style = MaterialTheme.typography.bodySmall)
            if (item.optString("sourceDate").isNotBlank()) Text(stringResource(R.string.company_source_date, item.getString("sourceDate").take(10)), style = MaterialTheme.typography.labelSmall)
            Text(stringResource(R.string.company_reviewed, item.optString("reviewedAt").take(10)), style = MaterialTheme.typography.labelSmall)
            CompanySourceLink(item.optString("sourceUrl"), stringResource(R.string.company_concern_source))
            if (item.optString("scope") == "parent") {
                CompanySourceLink(item.optString("ownershipSourceUrl"), stringResource(R.string.company_ownership_source))
                Text(stringResource(R.string.company_ownership_reviewed, item.optString("ownershipReviewedAt").take(10)), style = MaterialTheme.typography.labelSmall)
            }
        } }
    }
}

@Composable
private fun CompanySourceLink(value: String, label: String) {
    val uri = value.toHttpUrlOrNull()?.takeIf { it.isHttps && it.username.isEmpty() && it.password.isEmpty() } ?: return
    val handler = LocalUriHandler.current
    TextButton(onClick = { runCatching { handler.openUri(uri.toString()) } }) { Text("$label · ${uri.host}") }
}
