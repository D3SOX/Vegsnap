package app.vegsnapp

import android.content.Intent
import android.net.Uri
import android.widget.Toast
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedCard
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import org.json.JSONObject

@Composable
internal fun CommunityRepliesSection(result: JSONObject, offline: Boolean) {
    val context = LocalContext.current
    val language = LocalConfiguration.current.locales[0].language
    val baseUrl = remember(context) { JSONObject(context.assets.open("community-service.json").bufferedReader().use { it.readText() }).optString("baseUrl") }
    val links = remember(result.toString(), language, baseUrl) { communityLinks(result, language, baseUrl) } ?: return
    fun open(url: String) {
        runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
            .onFailure { Toast.makeText(context, R.string.contact_open_failed, Toast.LENGTH_LONG).show() }
    }
    OutlinedCard { Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(stringResource(R.string.community_replies), style = MaterialTheme.typography.titleMedium)
        Text(stringResource(R.string.community_notice), style = MaterialTheme.typography.bodySmall)
        if (offline) Text(stringResource(R.string.community_offline), style = MaterialTheme.typography.bodySmall)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            TextButton(onClick = { open(links.submit) }, enabled = !offline) { Text(stringResource(R.string.community_share)) }
            TextButton(onClick = { open(links.replies) }, enabled = !offline) { Text(stringResource(R.string.community_view)) }
        }
    } }
}
