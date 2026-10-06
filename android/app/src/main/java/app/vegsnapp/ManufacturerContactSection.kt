package app.vegsnapp

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.widget.Toast
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.OutlinedCard
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.selected
import org.json.JSONObject

@Composable
internal fun ManufacturerContactSection(result: JSONObject) {
    if (result.optString("outcome") !in setOf("uncertain", "conflicting")) return
    val contact = safeManufacturerContact(result.optJSONObject("manufacturerContact"))
    val context = LocalContext.current
    val locale = LocalConfiguration.current.locales[0].language
    val languages = listOf("en", "de", "sv")
    val messages = remember(context) { JSONObject(context.assets.open("manufacturer-messages.json").bufferedReader().use { it.readText() }) }
    var draftLanguage by rememberSaveable(result.optString("id"), locale) { mutableStateOf(locale.takeIf { it in languages } ?: "en") }
    var languageMenu by remember { mutableStateOf(false) }
    val draft = remember(result.toString(), draftLanguage) { manufacturerDraft(result, draftLanguage, messages) }
    var expanded by remember(result.optString("id")) { mutableStateOf(false) }
    fun open(uri: Uri, email: Boolean = false) {
        runCatching { context.startActivity(Intent(if (email) Intent.ACTION_SENDTO else Intent.ACTION_VIEW, uri)) }
            .onFailure { Toast.makeText(context, if (email) R.string.contact_no_email_app else R.string.contact_open_failed, Toast.LENGTH_LONG).show() }
    }
    OutlinedCard { Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(stringResource(R.string.contact_manufacturer), style = MaterialTheme.typography.titleMedium)
        Text(stringResource(if (contact == null) R.string.contact_missing else R.string.contact_ai_read), style = MaterialTheme.typography.bodySmall)
        if (contact != null) TextButton(onClick = { open(Uri.parse(contact.getString("sourceUrl"))) }) { Text(stringResource(R.string.contact_source)) }
        contact?.optString("email")?.takeIf { it.isNotBlank() }?.let { Text(it) }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        Box {
            TextButton(onClick = { languageMenu = true }) {
                Text(stringResource(R.string.contact_language, messages.getJSONObject("templates").getJSONObject(draftLanguage).getString("name")))
            }
            DropdownMenu(languageMenu, { languageMenu = false }) {
                languages.forEach { language ->
                    DropdownMenuItem(text = { Text(messages.getJSONObject("templates").getJSONObject(language).getString("name")) },
                        modifier = Modifier.semantics { selected = draftLanguage == language },
                        onClick = { draftLanguage = language; languageMenu = false; expanded = true })
                }
            }
        }
        contact?.optString("email")?.takeIf { it.isNotBlank() }?.let { email ->
            TextButton(onClick = { open(Uri.parse("mailto:" + Uri.encode(email) + "?subject=" + Uri.encode(draft.subject) + "&body=" + Uri.encode(draft.body)), true) }) { Text(stringResource(R.string.contact_email_app)) }
        }
        contact?.optString("url")?.takeIf { it.isNotBlank() }?.let { url ->
            TextButton(onClick = { open(Uri.parse(url)) }) { Text(stringResource(R.string.contact_form)) }
        }
        TextButton(onClick = { expanded = !expanded }) { Text(stringResource(if (expanded) R.string.contact_hide_draft else R.string.contact_show_draft)) }
        TextButton(onClick = {
            runCatching {
                requireNotNull(context.getSystemService(ClipboardManager::class.java))
                    .setPrimaryClip(ClipData.newPlainText(draft.subject, draft.subject + "\n\n" + draft.body))
            }.onSuccess { Toast.makeText(context, R.string.contact_copied, Toast.LENGTH_SHORT).show() }
                .onFailure { expanded = true; Toast.makeText(context, R.string.contact_copy_failed, Toast.LENGTH_LONG).show() }
        }) { Text(stringResource(R.string.contact_copy)) }
        }
        if (expanded) { SelectionContainer { Column { Text(draft.subject, style = MaterialTheme.typography.titleSmall); Text(draft.body, style = MaterialTheme.typography.bodySmall) } } }
    } }
}
