package app.vegsnap

import androidx.compose.ui.graphics.luminance
import org.junit.Assert.*
import org.junit.Test
import org.json.JSONArray
import org.json.JSONObject

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

    private fun companyAssessment(verdict: String = "concerns_found") = JSONObject()
        .put("brand", "Maker").put("company", "Maker Ltd").put("scope", "direct")
        .put("verdict", verdict).put("summary", "A documented company policy was reviewed.")
        .put("categories", JSONArray().apply { if (verdict != "no_concerns_found") put("animal_testing") })
        .put("sources", JSONArray().put(JSONObject().put("url", "https://maker.example/policy")
            .put("title", "Company policy").put("quote", "The published policy describes animal testing.")))
        .put("assessedAt", "2026-10-06T00:00:00Z")

    @Test fun concernsBadgeOnlyCountsActiveSupportedTopics() {
        assertEquals(0, resultConcernCount(JSONObject()))
        for (verdict in listOf("no_concerns_found", "inconclusive")) {
            assertEquals(0, resultConcernCount(JSONObject().put("companyAssessment", companyAssessment(verdict))))
        }
        assertEquals(1, resultConcernCount(JSONObject().put("companyAssessment", companyAssessment())))
        assertEquals(0, resultConcernCount(JSONObject().put("companyAssessment", companyAssessment().put("sources", JSONArray()))))
        val resolved = JSONObject().put("company", "Maker Ltd").put("category", "animal_testing").put("status", "resolved")
        assertEquals(0, resultConcernCount(JSONObject().put("companyConcerns", JSONArray().put(resolved))))
    }

    @Test fun concernsBadgeDeduplicatesAiAndReviewedTopicsWithoutHidingOtherCompanies() {
        val reviewed = JSONArray()
            .put(JSONObject().put("company", "MAKER LTD").put("category", "animal_testing").put("status", "current"))
            .put(JSONObject().put("company", "Maker Ltd").put("category", "animal_welfare_lobbying").put("status", "disputed"))
            .put(JSONObject().put("company", "Parent Ltd").put("category", "animal_testing").put("status", "current"))
        assertEquals(3, resultConcernCount(JSONObject().put("companyConcerns", reviewed).put("companyAssessment", companyAssessment())))
        assertEquals(3, resultConcernCount(JSONObject().put("companyConcerns", reviewed).put("companyAssessment", companyAssessment("no_concerns_found"))))
    }

}
