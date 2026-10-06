package app.veguide

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
import org.json.JSONObject

@Composable
internal fun CompanyAssessmentSection(result: JSONObject) {
    val assessment = safeCompanyAssessment(result.optJSONObject("companyAssessment"), saved = true)
    Text(stringResource(R.string.company_ai_heading), style = MaterialTheme.typography.titleMedium)
    if (assessment == null) {
        Text(stringResource(R.string.company_ai_not_assessed), style = MaterialTheme.typography.bodySmall)
        return
    }
    OutlinedCard { Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(stringResource(when (assessment.getString("verdict")) {
            "concerns_found" -> R.string.company_ai_concerns
            "no_concerns_found" -> R.string.company_ai_no_concerns
            else -> R.string.company_ai_inconclusive
        }), style = MaterialTheme.typography.titleSmall)
        Text(assessment.getString("company"), style = MaterialTheme.typography.titleSmall)
        Text(stringResource(if (assessment.getString("scope") == "parent") R.string.company_parent_of else R.string.company_direct_match,
            assessment.getString("brand")), style = MaterialTheme.typography.bodySmall)
        val categories = assessment.getJSONArray("categories")
        if (categories.length() > 0) Text((0 until categories.length()).map { index ->
            stringResource(when (categories.getString(index)) {
                "animal_testing" -> R.string.company_animal_testing
                "animal_welfare_lobbying" -> R.string.company_lobbying
                else -> R.string.company_exploitation
            })
        }.joinToString(" · "), style = MaterialTheme.typography.labelLarge)
        Text(assessment.getString("summary"), style = MaterialTheme.typography.bodySmall)
        Text(stringResource(R.string.company_ai_limit), style = MaterialTheme.typography.bodySmall)
        if (assessment.getString("verdict") == "no_concerns_found" && (result.optJSONArray("companyConcerns")?.length() ?: 0) > 0) Text(stringResource(R.string.company_ai_reviewed_remain), style = MaterialTheme.typography.bodySmall)
        Text(stringResource(R.string.company_ai_date, assessment.getString("assessedAt").take(10)), style = MaterialTheme.typography.labelSmall)
        val sources = assessment.getJSONArray("sources")
        val handler = LocalUriHandler.current
        for (index in 0 until sources.length()) {
            val source = sources.getJSONObject(index)
            TextButton(onClick = { runCatching { handler.openUri(source.getString("url")) } }) { Text(source.getString("title")) }
            Text(source.getString("quote"), style = MaterialTheme.typography.bodySmall)
        }
        if (assessment.has("ownershipSourceUrl")) TextButton(onClick = { runCatching { handler.openUri(assessment.getString("ownershipSourceUrl")) } }) {
            Text(stringResource(R.string.company_ownership_source))
        }
    } }
}
