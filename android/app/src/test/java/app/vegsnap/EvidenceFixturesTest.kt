package app.vegsnap

import java.io.File
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test

/** The TypeScript core iterates the same contract, keeping both verdict ports aligned. */
class EvidenceFixturesTest {
    private val root = File(requireNotNull(System.getProperty("vegsnap.repo")))
    private val fixtures = JSONObject(File(root, "contracts/evidence-fixtures.json").readText())
    private val repository = CheckRepository(Evaluator(JSONObject(File(root, "data/rules.json").readText())), "unused")
    private fun urls(items: JSONArray?) = items?.let { values -> (0 until values.length()).map { values.getJSONObject(it).getString("url") } }.orEmpty()

    @Test fun assessmentsMatchSharedFixtures() {
        val cases = fixtures.getJSONArray("assessments")
        for (index in 0 until cases.length()) {
            val case = cases.getJSONObject(index)
            val input = case.getJSONObject("input")
            val result = repository.researchAssessment(CheckInput(category = input.optString("category", "other")),
                JSONObject(case.getJSONObject("extraction").toString()), input.getBoolean("photo"))
            val expected = case.getJSONObject("expected")
            assertEquals(case.getString("name"), "${expected.getString("outcome")}/${expected.getString("basis")}",
                "${result.getString("outcome")}/${result.getString("basis")}")
        }
    }

    @Test fun researchMergesMatchSharedFixtures() {
        val cases = fixtures.getJSONArray("researchMerges")
        for (index in 0 until cases.length()) {
            val case = cases.getJSONObject(index)
            val merged = JSONObject(case.getJSONObject("original").toString())
            mergeResearch(merged, JSONObject(case.getJSONObject("researched").toString()))
            val expected = case.getJSONObject("expected")
            assertEquals(case.getString("name"), expected.getJSONArray("webClaims").stringValues(), urls(merged.optJSONArray("webClaims")))
            assertEquals(case.getString("name"), expected.getJSONArray("webCompositions").stringValues(), urls(merged.optJSONArray("webCompositions")))
        }
    }
}
