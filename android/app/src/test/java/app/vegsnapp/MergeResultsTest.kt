package app.vegsnapp

import java.io.File
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class MergeResultsTest {
    private val root = File(requireNotNull(System.getProperty("vegsnap.repo")))
    private val evaluator = Evaluator(JSONObject(File(root, "data/rules.json").readText()))
    private val curry = JSONObject(File(root, "fixtures/massaman-source-merge.json").readText())

    @Test fun `Pixel curry photo check retains translated AI ingredients after database evidence merges`() {
        for (databaseFirst in listOf(false, true)) {
            val ai = evaluator.evaluate(CheckInput(category = "food")).put("outcome", "vegan").put("basis", "composition").put("usedAI", true)
                .put("findings", JSONArray(curry.getJSONArray("findings").toString()))
                .put("evidence", JSONArray().put(JSONObject().put("id", "web-composition-0").put("kind", "ai_extraction")
                    .put("title", "Retailer composition (AI)").put("excerpt", curry.getString("composition")).put("retrievedAt", "2026-10-07T10:49:12Z"))
                    .put(JSONObject().put("id", "web-composition-0-assessment").put("kind", "ai_extraction")
                        .put("title", "AI ingredient assessment").put("excerpt", "Ingredient origins assessed by AI.").put("retrievedAt", "2026-10-07T10:49:12Z")))
            val database = evaluator.evaluate(CheckInput(curry.getString("databaseComposition"), "food", false))
            database.getJSONArray("evidence").getJSONObject(0).put("id", "database").put("kind", "database")
            val local = database.getJSONArray("findings")
            for (index in 0 until local.length()) local.getJSONObject(index).put("evidenceId", "database")
            assertTrue((0 until local.length()).any { local.getJSONObject(it).getString("status") == "unknown" })
            val result = if (databaseFirst) mergeResults(database, ai) else mergeResults(ai, database)
            val findings = result.getJSONArray("findings")
            assertEquals("vegan", result.getString("outcome"))
            assertEquals(curry.getJSONArray("findings").length(), findings.length())
            assertTrue((0 until findings.length()).all { findings.getJSONObject(it).getString("status") == "plant" })
            val names = (0 until findings.length()).map { findings.getJSONObject(it).getString("displayTerm") }.sorted()
            val expected = curry.getJSONArray("findings").let { items -> (0 until items.length()).map { items.getJSONObject(it).getString("displayTerm") }.sorted() }
            assertEquals(expected, names)
            val ids = result.getJSONArray("evidence").let { items -> (0 until items.length()).map { items.getJSONObject(it).getString("id") } }
            assertTrue(ids.containsAll(listOf("database", "web-composition-0")))
        }
    }

    @Test fun `merging preserves independent uncertainty ambiguous origins and animal evidence`() {
        val ai = evaluator.evaluate(CheckInput(category = "food")).put("outcome", "vegan").put("basis", "composition")
            .put("findings", JSONArray().put(JSONObject().put("term", "spice blend (rare extract)").put("status", "plant").put("explanation", "Assessed blend.").put("evidenceId", "input"))
                .put(JSONObject().put("term", "glycerin").put("status", "plant").put("explanation", "A conflicting source claim.").put("evidenceId", "input")))
        val database = evaluator.evaluate(CheckInput("rare extract, glycerin, milk", "food", false))
        database.getJSONArray("evidence").getJSONObject(0).put("id", "database").put("kind", "database")
        val findings = database.getJSONArray("findings")
        for (index in 0 until findings.length()) findings.getJSONObject(index).put("evidenceId", "database")
        val result = mergeResults(ai, database)
        val merged = result.getJSONArray("findings").let { items -> (0 until items.length()).map { items.getJSONObject(it) } }
        assertEquals("conflicting", result.getString("outcome"))
        assertEquals("unknown", merged.single { it.getString("term") == "rare extract" }.getString("status"))
        assertEquals(setOf("ambiguous", "plant"), merged.filter { it.getString("term") == "glycerin" }.map { it.getString("status") }.toSet())
        assertEquals("animal", merged.single { it.getString("term") == "milk" }.getString("status"))
    }

    @Test fun `explicit unresolved AI assessment is not hidden by an assessment from another source`() {
        val ai = evaluator.evaluate(CheckInput(category = "food")).put("findings", JSONArray().put(JSONObject()
            .put("term", "valkosipuli").put("status", "plant").put("explanation", "A plant bulb.").put("evidenceId", "input")))
        val other = evaluator.evaluate(CheckInput("valkosipuli", "food", false))
        other.getJSONArray("evidence").getJSONObject(0).put("id", "other-assessment").put("kind", "ai_extraction")
        other.getJSONArray("findings").getJSONObject(0).put("evidenceId", "other-assessment").put("explanation", "The source could not be interpreted.")
        val merged = mergeResults(ai, other).getJSONArray("findings")
        assertEquals(setOf("plant", "unknown"), (0 until merged.length()).map { merged.getJSONObject(it).getString("status") }.toSet())
    }

    @Test fun `opening the saved Pixel result removes database duplicates without rechecking or modifying storage`() {
        val saved = evaluator.evaluate(CheckInput(category = "food")).put("outcome", "vegan").put("basis", "composition")
            .put("findings", JSONArray(curry.getJSONArray("findings").toString()))
            .put("evidence", JSONArray().put(JSONObject().put("id", "web-composition-0").put("kind", "ai_extraction").put("excerpt", curry.getString("composition")))
                .put(JSONObject().put("id", "web-composition-0-assessment").put("kind", "ai_extraction").put("excerpt", "Ingredient origins assessed by AI."))
                .put(JSONObject().put("id", "database").put("kind", "database").put("excerpt", curry.getString("databaseComposition"))))
        val local = evaluator.evaluate(CheckInput(curry.getString("databaseComposition"), "food", false)).getJSONArray("findings")
        for (index in 0 until local.length()) {
            val finding = local.getJSONObject(index)
            if (finding.getString("status") == "unknown") saved.getJSONArray("findings").put(finding.put("evidenceId", "database"))
        }
        val original = saved.toString()
        assertEquals(23, saved.getJSONArray("findings").length())
        val shown = IngredientTranslations().localize(saved, "en")
        val findings = shown.getJSONArray("findings")
        assertEquals(13, findings.length())
        assertTrue((0 until findings.length()).all { findings.getJSONObject(it).getString("status") == "plant" && findings.getJSONObject(it).has("displayTerm") })
        assertEquals(saved.getJSONArray("evidence").toString(), shown.getJSONArray("evidence").toString())
        assertEquals(original, saved.toString())
    }
}
