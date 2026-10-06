package app.veguide

import androidx.compose.ui.graphics.luminance
import org.junit.Assert.*
import org.junit.Test

class ResultPresentationTest {
    @Test fun visibleAndResearchedClaimsNeverBecomeVerifiedCertification() {
        assertEquals(ResultClassification.CERTIFIED, resultClassification("vegan", "certified"))
        assertEquals(ResultClassification.PACKAGING, resultClassification("vegan", "packaging"))
        assertEquals(ResultClassification.RESEARCH, resultClassification("vegan", "research"))
        assertEquals(ResultClassification.MANUFACTURER, resultClassification("vegan", "manufacturer"))
        assertEquals(ResultClassification.COMPOSITION, resultClassification("vegan", "composition"))
        assertEquals(ResultClassification.UNCERTAIN, resultClassification("vegan", "insufficient"))
        assertEquals(ResultClassification.UNCERTAIN, resultClassification("vegan", "unknown"))
    }

    @Test fun negativeOrConflictingOutcomeTakesPrecedenceOverEvidenceBasis() {
        for (basis in listOf("certified", "manufacturer", "composition", "packaging", "research")) {
            assertEquals(ResultClassification.NOT_VEGAN, resultClassification("not_vegan", basis))
            assertEquals(ResultClassification.CONFLICTING, resultClassification("conflicting", basis))
            assertEquals(ResultClassification.UNCERTAIN, resultClassification("uncertain", basis))
        }
    }

    @Test fun allStatusTextMeetsNormalTextContrastInBothThemes() {
        for (dark in listOf(false, true)) {
            val palettes = ResultClassification.entries.map { it.colors(dark) }
            assertEquals(ResultClassification.entries.size, palettes.distinct().size)
            for (status in ResultClassification.entries) {
                val (ink, surface) = status.colors(dark)
                val contrast = (maxOf(ink.luminance(), surface.luminance()) + 0.05f) /
                    (minOf(ink.luminance(), surface.luminance()) + 0.05f)
                assertTrue("$status dark=$dark contrast=$contrast", contrast >= 4.5f)
            }
        }
    }
}
