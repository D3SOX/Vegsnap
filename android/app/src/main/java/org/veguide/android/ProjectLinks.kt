package org.veguide.android

import android.widget.Toast
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Code
import androidx.compose.material.icons.outlined.Language
import androidx.compose.material.icons.outlined.OpenInNew
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp

@Composable
private fun openProjectLink(): (String) -> Unit {
    val handler = LocalUriHandler.current
    val context = LocalContext.current
    return { url ->
        runCatching { handler.openUri(url) }.onFailure {
            Toast.makeText(context, R.string.external_link_failed, Toast.LENGTH_SHORT).show()
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun ProjectLinks() {
    val open = openProjectLink()
    val website = if (LocalConfiguration.current.locales[0].language == "de") "https://veguide.app/de/" else "https://veguide.app"
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedButton(onClick = { open("https://github.com/D3SOX/veguide") }) {
            Icon(Icons.Outlined.Code, null); Spacer(Modifier.width(8.dp)); Text("GitHub")
        }
        OutlinedButton(onClick = { open(website) }) {
            Icon(Icons.Outlined.Language, null); Spacer(Modifier.width(8.dp)); Text(stringResource(R.string.project_website))
        }
    }
}

@Composable
internal fun SourceLicenseLinks() {
    val open = openProjectLink()
    val entries = listOf(
        Triple("Veguide", "AGPL-3.0-only", "https://github.com/D3SOX/veguide/blob/main/LICENSE"),
        Triple("Open Food Facts · Open Beauty Facts · Open Products Facts", "ODbL-1.0", "https://opendatacommons.org/licenses/odbl/1-0/"),
        Triple(stringResource(R.string.database_contents), "DbCL-1.0", "https://opendatacommons.org/licenses/dbcl/1-0/"),
        Triple("Wikidata", "CC0", "https://www.wikidata.org/wiki/Wikidata:Licensing"),
        Triple("Barnivore", stringResource(R.string.source_terms), "https://www.barnivore.com/terms"),
        Triple("Tesseract4Android", "Apache-2.0", "https://github.com/adaptech-cz/Tesseract4Android/blob/master/LICENSE"),
        Triple(stringResource(R.string.tesseract_models), "Apache-2.0", "https://github.com/tesseract-ocr/tessdata_fast/blob/main/LICENSE"),
    )
    Column {
        entries.forEach { (name, license, url) ->
            TextButton(onClick = { open(url) }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
                contentPadding = PaddingValues(horizontal = 8.dp, vertical = 8.dp)) {
                Column(Modifier.weight(1f)) {
                    Text(name, style = MaterialTheme.typography.bodyMedium)
                    Text(license, style = MaterialTheme.typography.labelMedium)
                }
                Spacer(Modifier.width(12.dp))
                Icon(Icons.Outlined.OpenInNew, null, Modifier.size(18.dp))
            }
        }
    }
}
