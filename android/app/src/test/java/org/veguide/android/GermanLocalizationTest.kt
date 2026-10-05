package org.veguide.android

import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.w3c.dom.Element

class GermanLocalizationTest {
    private val root = File(requireNotNull(System.getProperty("veguide.repo")))
    private fun resources(folder: String): Map<String, String> = buildMap {
        val builder = DocumentBuilderFactory.newInstance().newDocumentBuilder()
        File(root, "android/app/src/main/res/$folder").listFiles().orEmpty().filter { it.extension == "xml" }.forEach { file ->
            val children = builder.parse(file).documentElement.childNodes
            for (index in 0 until children.length) {
                val element = children.item(index) as? Element ?: continue
                if (element.tagName in setOf("string", "plurals", "string-array")) put(element.getAttribute("name"), element.textContent)
            }
        }
    }
    @Test fun `German covers every UI resource and preserves formatting arguments`() {
        val english = resources("values")
        val german = resources("values-de")
        assertEquals(english.keys, german.keys)
        val arguments = Regex("%(?:[0-9]+\\$)?[0-9]*[dsf]")
        english.forEach { (name, text) ->
            assertTrue("Empty German resource: $name", german.getValue(name).isNotBlank())
            assertEquals("Formatting arguments: $name", arguments.findAll(text).map { it.value }.sorted().toList(),
                arguments.findAll(german.getValue(name)).map { it.value }.sorted().toList())
        }
        assertEquals("Mit ChatGPT fortfahren", german.getValue("chatgpt_continue"))
    }
    @Test fun `saved English result uses German app copy without changing original evidence or classification`() {
        val rules = JSONObject(File(root, "data/rules.json").readText())
        val evaluator = Evaluator(rules)
        val saved = evaluator.evaluate(CheckInput("milk", "food", true, locale = "en"))
        saved.put("warnings", JSONArray().put("Database unavailable; using local analysis."))
        saved.put("aiError", AIErrorCode.QUOTA.json("en"))
        val snapshot = saved.toString()
        val display = ResultTextTranslations(JSONObject(File(root, "data/result-translations.json").readText()), rules).localize(saved, "de")
        val expected = evaluator.evaluate(CheckInput("milk", "food", true, locale = "de"))
        assertEquals(expected.getString("summary"), display.getString("summary"))
        assertEquals(expected.getJSONArray("findings").getJSONObject(0).getString("explanation"), display.getJSONArray("findings").getJSONObject(0).getString("explanation"))
        assertEquals("Datenbank nicht erreichbar; lokale Analyse verwendet.", display.getJSONArray("warnings").getString(0))
        assertEquals(AIErrorCode.QUOTA.german, display.getJSONObject("aiError").getString("message"))
        assertEquals(saved.getString("outcome"), display.getString("outcome"))
        assertEquals(saved.getJSONArray("evidence").toString(), display.getJSONArray("evidence").toString())
        assertEquals(snapshot, saved.toString())
    }
    @Test fun `free form AI explanations and source quotations are never invented in another language`() {
        val rules = JSONObject(File(root, "data/rules.json").readText())
        val saved = Evaluator(rules).evaluate(CheckInput("unknown", "food", true))
        val original = "Unusual manufacturer wording that requires its own source review."
        saved.getJSONArray("findings").getJSONObject(0).put("explanation", original)
        val display = ResultTextTranslations(JSONObject(File(root, "data/result-translations.json").readText()), rules).localize(saved, "de")
        assertEquals(original, display.getJSONArray("findings").getJSONObject(0).getString("explanation"))
        assertEquals(saved.getJSONArray("evidence").toString(), display.getJSONArray("evidence").toString())
    }
}
