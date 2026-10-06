package app.veguide

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material.icons.automirrored.outlined.CompareArrows
import androidx.compose.material.icons.automirrored.outlined.FormatListBulleted
import androidx.compose.material.icons.automirrored.outlined.HelpOutline
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import org.json.JSONObject

/** Evidence levels remain distinct even when their overall verdict is vegan. */
internal enum class ResultClassification(val label: Int, val icon: ImageVector,
    private val lightInk: Long, private val lightSurface: Long,
    private val darkInk: Long, private val darkSurface: Long) {
    CERTIFIED(R.string.vegan_certified, Icons.Outlined.Verified, 0xFF205B29, 0xFFD7F5D6, 0xFFACE5AB, 0xFF173E20),
    MANUFACTURER(R.string.vegan_manufacturer, Icons.Outlined.Business, 0xFF00594D, 0xFFB5F1E0, 0xFF8ED7C6, 0xFF003D34),
    COMPOSITION(R.string.vegan, Icons.AutoMirrored.Outlined.FormatListBulleted, 0xFF244F91, 0xFFD8E6FF, 0xFFAFCBFF, 0xFF18365F),
    PACKAGING(R.string.vegan_label_visible, Icons.Outlined.Visibility, 0xFF70418F, 0xFFF1DCFF, 0xFFDDB9F5, 0xFF4B2962),
    RESEARCH(R.string.vegan_certification_source, Icons.Outlined.FindInPage, 0xFF005466, 0xFFBFEEFF, 0xFF8ED3E8, 0xFF003C4A),
    UNCERTAIN(R.string.uncertain, Icons.AutoMirrored.Outlined.HelpOutline, 0xFF635000, 0xFFFFECA5, 0xFFE5CE78, 0xFF443700),
    CONFLICTING(R.string.conflicting, Icons.AutoMirrored.Outlined.CompareArrows, 0xFF813800, 0xFFFFDCC5, 0xFFFFB785, 0xFF5C2800),
    NOT_VEGAN(R.string.not_vegan, Icons.Outlined.Cancel, 0xFF922C34, 0xFFFFDADB, 0xFFFFB3B7, 0xFF641B23);

    fun colors(dark: Boolean): Pair<Color, Color> = if (dark) Color(darkInk) to Color(darkSurface)
        else Color(lightInk) to Color(lightSurface)
}

internal fun resultClassification(outcome: String, basis: String = ""): ResultClassification = when (outcome) {
    "not_vegan" -> ResultClassification.NOT_VEGAN
    "conflicting" -> ResultClassification.CONFLICTING
    "vegan" -> when (basis) {
        "certified" -> ResultClassification.CERTIFIED
        "manufacturer" -> ResultClassification.MANUFACTURER
        "composition" -> ResultClassification.COMPOSITION
        "packaging" -> ResultClassification.PACKAGING
        "research" -> ResultClassification.RESEARCH
        else -> ResultClassification.UNCERTAIN
    }
    else -> ResultClassification.UNCERTAIN
}

@Composable
internal fun ResultStatusLabel(classification: ResultClassification, prominent: Boolean = false) {
    // Local semantic colors supplement the dynamic Material theme. Both modes use
    // opaque, contrast-tested pairs; text and icons also identify every status.
    val (ink, background) = classification.colors(MaterialTheme.colorScheme.surface.luminance() < 0.5f)
    Surface(color = background, contentColor = ink, shape = MaterialTheme.shapes.small) {
        Row(Modifier.padding(horizontal = 12.dp, vertical = 8.dp)
            .then(if (prominent) Modifier.semantics { heading() } else Modifier),
            horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(classification.icon, null, Modifier.size(if (prominent) 28.dp else 20.dp))
            Text(stringResource(classification.label), style = if (prominent) MaterialTheme.typography.headlineSmall else MaterialTheme.typography.labelLarge)
        }
    }
}

internal fun categoryIcon(category: String): ImageVector = when (category) {
    "food" -> Icons.Outlined.Restaurant
    "drink" -> Icons.Outlined.LocalCafe
    "cosmetics" -> Icons.Outlined.Face
    "household" -> Icons.Outlined.Home
    "clothing" -> Icons.Outlined.Checkroom
    "shoes" -> Icons.Outlined.IceSkating
    else -> Icons.Outlined.AutoAwesome
}

/** Count active concern topics, without counting the same AI and reviewed topic twice. */
internal fun resultConcernCount(result: JSONObject): Int {
    val topics = mutableSetOf<Pair<String, String>>()
    fun add(company: String, category: String) {
        if (company.isNotBlank() && category in setOf("animal_testing", "animal_welfare_lobbying", "animal_exploitation")) {
            topics += company.trim().lowercase(java.util.Locale.ROOT) to category
        }
    }
    result.optJSONArray("companyConcerns")?.let { concerns ->
        for (index in 0 until concerns.length()) {
            val concern = concerns.optJSONObject(index) ?: continue
            if (concern.optString("status") != "resolved") add(concern.optString("company"), concern.optString("category"))
        }
    }
    safeCompanyAssessment(result.optJSONObject("companyAssessment"), saved = true)
        ?.takeIf { it.optString("verdict") == "concerns_found" }?.let { assessment ->
            val categories = assessment.getJSONArray("categories")
            for (index in 0 until categories.length()) add(assessment.getString("company"), categories.getString(index))
        }
    return topics.size
}
