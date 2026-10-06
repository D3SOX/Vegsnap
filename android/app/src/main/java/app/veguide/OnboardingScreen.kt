package app.veguide

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.*
import androidx.compose.ui.unit.dp

private data class TourPage(val title: Int, val description: Int, val icon: ImageVector, val cards: List<Pair<Int, Int>>)
private val tourPages = listOf(
    TourPage(R.string.tour_capture, R.string.tour_capture_body, Icons.Outlined.CameraAlt, listOf(
        R.string.tour_barcode to R.string.tour_barcode_body, R.string.tour_photo to R.string.tour_photo_body)),
    TourPage(R.string.tour_evidence, R.string.tour_evidence_body, Icons.Outlined.FactCheck, listOf(
        R.string.tour_certified to R.string.tour_certified_body,
        R.string.tour_certification_source to R.string.tour_certification_source_body,
        R.string.tour_packaging to R.string.tour_packaging_body, R.string.tour_maker to R.string.tour_maker_body,
        R.string.tour_composition to R.string.tour_composition_body)),
    TourPage(R.string.tour_uncertainty, R.string.tour_uncertainty_body, Icons.Outlined.ManageSearch, listOf(
        R.string.tour_nonvegan to R.string.tour_nonvegan_body,
        R.string.tour_conflicting to R.string.tour_conflicting_body, R.string.tour_unknown to R.string.tour_unknown_body,
        R.string.tour_company to R.string.tour_company_body)),
    TourPage(R.string.tour_control, R.string.tour_control_body, Icons.Outlined.Tune, listOf(
        R.string.tour_local to R.string.tour_local_body, R.string.tour_queue to R.string.tour_queue_body))
)

@Composable
internal fun OnboardingScreen(onFinish: () -> Unit) {
    var page by rememberSaveable { mutableIntStateOf(0) }
    BackHandler { if (page > 0) page-- else onFinish() }
    Surface(Modifier.fillMaxSize()) {
        Column(Modifier.safeDrawingPadding().fillMaxSize().padding(horizontal = 24.dp)) {
            Row(Modifier.fillMaxWidth().padding(vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                Image(painterResource(R.drawable.ic_veguide), null, Modifier.size(32.dp).clip(RoundedCornerShape(8.dp)))
                Spacer(Modifier.width(10.dp)); Text(stringResource(R.string.app_name), style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
                TextButton(onClick = onFinish) { Text(stringResource(R.string.tour_skip)) }
            }
            val progress = stringResource(R.string.tour_progress, page + 1, tourPages.size)
            Row(Modifier.fillMaxWidth().semantics { contentDescription = progress }, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                tourPages.forEachIndexed { index, _ ->
                    val color by animateColorAsState(if (index <= page) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surfaceContainerHighest, label = "tour step")
                    Box(Modifier.weight(1f).height(5.dp).clip(CircleShape).background(color))
                }
            }
            AnimatedContent(page, Modifier.weight(1f).fillMaxWidth(), label = "classification guide") { index ->
                val content = tourPages[index]
                Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(vertical = 24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                    Surface(shape = RoundedCornerShape(28.dp), color = MaterialTheme.colorScheme.primaryContainer) {
                        Icon(content.icon, null, Modifier.padding(24.dp).size(48.dp), tint = MaterialTheme.colorScheme.onPrimaryContainer)
                    }
                    Text(stringResource(content.title), style = MaterialTheme.typography.headlineLarge, modifier = Modifier.semantics { heading() })
                    Text(stringResource(content.description), style = MaterialTheme.typography.bodyLarge)
                    content.cards.forEach { (title, body) ->
                        Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainer)) {
                            Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                val classification = when (title) {
                                    R.string.tour_certified -> ResultClassification.CERTIFIED
                                    R.string.tour_certification_source -> ResultClassification.RESEARCH
                                    R.string.tour_packaging -> ResultClassification.PACKAGING
                                    R.string.tour_maker -> ResultClassification.MANUFACTURER
                                    R.string.tour_composition -> ResultClassification.COMPOSITION
                                    R.string.tour_nonvegan -> ResultClassification.NOT_VEGAN
                                    R.string.tour_conflicting -> ResultClassification.CONFLICTING
                                    R.string.tour_unknown -> ResultClassification.UNCERTAIN
                                    else -> null
                                }
                                if (classification != null) ResultStatusLabel(classification)
                                else Text(stringResource(title), style = MaterialTheme.typography.titleMedium)
                                Text(stringResource(body), style = MaterialTheme.typography.bodyMedium)
                            }
                        }
                    }
                }
            }
            Row(Modifier.fillMaxWidth().padding(vertical = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                if (page > 0) TextButton(onClick = { page-- }) { Text(stringResource(R.string.tour_back)) }
                Spacer(Modifier.weight(1f))
                Button(onClick = { if (page == tourPages.lastIndex) onFinish() else page++ }, modifier = Modifier.heightIn(min = 48.dp)) {
                    Text(stringResource(if (page == tourPages.lastIndex) R.string.tour_done else R.string.tour_next))
                    Spacer(Modifier.width(8.dp)); Icon(Icons.Outlined.ArrowForward, null)
                }
            }
        }
    }
}
