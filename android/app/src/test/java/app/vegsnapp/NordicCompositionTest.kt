package app.vegsnapp

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File

class NordicCompositionTest {
    private val evaluator = Evaluator(JSONObject(File(requireNotNull(System.getProperty("vegsnap.repo")), "data/rules.json").readText()))
    private val oddlygood = "vesi, kuorittu soijapapu* 13 %, sokeri, tärkkelys, kalsium, suola, vitamiinit (riboflaviini (B2), B12, D2), jodi, hapate.\n\n* Allergioita tai intoleransseja aiheuttavat aineet korostettu"
    @Test fun finnishSoyCompositionDoesNotInventIngredientsFromTypography() {
        val result = evaluator.evaluate(CheckInput(oddlygood, "food", true))
        val findings = result.getJSONArray("findings")
        val statuses = (0 until findings.length()).associate { findings.getJSONObject(it).getString("term") to findings.getJSONObject(it).getString("status") }
        for (term in listOf("vesi", "kuorittu soijapapu", "sokeri", "tärkkelys", "suola")) assertEquals("plant", statuses[term])
        assertFalse(statuses.keys.any { it.contains("allergioita") })
        assertEquals("plant", statuses["vitamin d2"])
        assertEquals("ambiguous", statuses["hapate"])
        assertEquals("uncertain", result.getString("outcome"))
    }
    @Test fun vitaminGroupsKeepAmbiguousDAndActualAnimalSubingredients() {
        assertEquals(listOf("vitamin d", "vitamin e", "riboflavin", "vitamin b12"), compositionTerms("vitaminer (D, E, riboflavin, B12)"))
        assertTrue(compositionTerms("vitaminer (D, mjölk)").contains("mjölk"))
        val result = evaluator.evaluate(CheckInput("Vatten, SOJABÖNOR 8%, surhetsreglerande medel (E170), vitaminer (D, E, riboflavin, B12).", "drink", true))
        assertEquals("uncertain", result.getString("outcome"))
        val findings = result.getJSONArray("findings")
        assertTrue((0 until findings.length()).map { findings.getJSONObject(it) }.any { it.getString("term") == "vitamin d" && it.getString("status") == "ambiguous" })
        assertTrue((0 until findings.length()).map { findings.getJSONObject(it) }.any { it.getString("term") == "vitamin e" && it.getString("status") == "plant" })
    }
    @Test fun vitaminEStillChecksAnimalDerivedCarriers() {
        assertEquals("not_vegan", evaluator.evaluate(CheckInput("water, vitamin E (gelatin)", "food", true)).getString("outcome"))
        assertEquals("vegan", evaluator.evaluate(CheckInput("water, tocopherol", "food", true)).getString("outcome"))
    }
    @Test fun completeSoyDrinkDoesNotInheritWineFiningVeto() {
        assertEquals("vegan", evaluator.evaluate(CheckInput("water, soybeans, salt", "drink", true, name = "Soy drink")).getString("outcome"))
        for (name in listOf("White wine", "Öl", "Alkoholfri öl")) assertEquals("uncertain", evaluator.evaluate(CheckInput("water, sugar", "drink", true, name = name)).getString("outcome"))
        assertEquals("not_vegan", evaluator.evaluate(CheckInput("water, milk", "drink", true, name = "Soy drink")).getString("outcome"))
    }
    @Test fun germanOilIngredientsDoNotTriggerSwedishBeerFining() {
        assertFalse(needsProcessingEvidence(CheckInput("Wasser, pflanzliches Öl", "drink", true, name = "Pflanzliches Getränk", locale = "de")))
        assertTrue(needsProcessingEvidence(CheckInput("water, sugar", "drink", true, name = "Alkoholfri öl", locale = "de")))
    }
    @Test fun onlyKnownAllergyTypographyNotesAreRemoved() {
        assertEquals(listOf("water", "milk"), compositionTerms("water, milk\n* Ämnen som kan orsaka allergier eller intoleranser är markerade"))
        assertTrue(compositionTerms("water\n* milk").contains("milk"))
        assertTrue(compositionTerms("water\n* Allergioita tai intoleransseja aiheuttavat aineet korostettu. milk").any { it.endsWith("milk") })
    }
}
