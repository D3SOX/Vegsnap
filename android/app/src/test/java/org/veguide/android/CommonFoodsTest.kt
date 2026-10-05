package org.veguide.android

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File

class CommonFoodsTest {
    private val repo = File(requireNotNull(System.getProperty("veguide.repo")))
    private val evaluator = Evaluator(JSONObject(File(repo, "data/rules.json").readText()))
    private fun check(text: String) = evaluator.evaluate(CheckInput(text, "food", true))

    @Test fun commonGermanEnglishSwedishCompositionsUseTheSharedRules() {
        val examples = JSONArray(File(repo, "fixtures/common-foods.json").readText())
        for (i in 0 until examples.length()) {
            val text = examples.getString(i)
            val result = check(text)
            assertEquals(text, "vegan", result.getString("outcome"))
            val findings = result.getJSONArray("findings")
            for (j in 0 until findings.length()) assertEquals(text, "plant", findings.getJSONObject(j).getString("status"))
        }
    }

    @Test fun bareAdditiveClassesAreNotEvidenceOfPlantOrigin() {
        for (role in listOf("Säuerungsmittel", "Säuerungsmittel:", "Emulgator()", "thickener", "stabiliser:", "förtjockningsmedel")) {
            assertEquals(role, "uncertain", check("water, $role").getString("outcome"))
        }
        assertEquals(listOf("verdickungsmittel"), compositionTerms("Verdickungsmittel ()"))
        assertEquals(listOf("zitronensäure"), compositionTerms("Säuerungsmittel: Zitronensäure"))
        assertEquals(listOf("paprika"), compositionTerms("Gemüse - Paprika"))
    }

    @Test fun headingCleanupPreservesAnimalIngredientsAndUnknownCompoundRecipes() {
        for (text in listOf("Gemüse - Milch", "Gurken (Milch)", "Säuerungsmittel: Milch", "Verdickungsmittel (Gelatine)", "Kartoffeln, hönsägg", "grönsaker, nötkött", "Tomaten, Fischsauce", "water, shellfish")) {
            assertEquals(text, "not_vegan", check(text).getString("outcome"))
        }
        for (text in listOf("Vegetables - paprika with milk", "Paprikazubereitung", "margarine", "chocolate", "cheese flavour", "soy milk", "sojadryck")) {
            assertEquals(text, "uncertain", check(text).getString("outcome"))
        }
        for (ingredient in listOf("E471", "lecithin", "natural flavouring", "vitamin D", "glycerin")) {
            val findings = check("Gurken, $ingredient").getJSONArray("findings")
            assertTrue(ingredient, (0 until findings.length()).any { findings.getJSONObject(it).getString("status") == "ambiguous" })
        }
    }
}
