package app.vegsnap

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class CommunityVerdictTest {
    private val reply = CommunityReply("12345678-1234-4234-8234-123456789abc", "Drink", "Maker", "SE", "", "Is it vegan?", "All our drinks are vegan.",
        "2026-01-10", "vegan", "whole_product", "2026-01-11T00:00:00Z", null, false, "barcode")
    private fun result(outcome: String = "uncertain") = JSONObject().put("outcome",outcome).put("basis","insufficient")
        .put("title","Uncertain").put("summary","Unclear").put("findings",JSONArray()).put("evidence",JSONArray())
        .put("warnings",JSONArray()).put("questions",JSONArray().put("Ask maker")).put("identity",JSONObject().put("market","SE"))
    @Test fun wholeProductReplyUpdatesADisplayCopy() {
        val original = result(); val before = original.toString()
        val updated = applyCommunityReplies(original,listOf(reply),"en","https://community.example")
        assertEquals("vegan",updated.getString("outcome")); assertEquals("manufacturer",updated.getString("basis"))
        assertEquals("Manufacturer says vegan",updated.getString("title")); assertEquals(before,original.toString())
        assertEquals("2026-01-10T00:00:00Z",updated.getJSONArray("evidence").getJSONObject(0).getString("sourceDate"))
        assertSame(original,applyCommunityReplies(original,emptyList(),"en","https://community.example"))
    }
    @Test fun onlyConfirmedWholeProductRepliesAffectTheVerdict() {
        val original = result()
        for (item in listOf(reply.copy(scope="ingredients"),reply.copy(scope="processing"),reply.copy(claim="inconclusive"),reply.copy(match="candidate")))
            assertSame(original,applyCommunityReplies(original,listOf(item),"en","https://community.example"))
    }
    @Test fun negativeAndOpposingClaimsAreVisible() {
        val negative = reply.copy(claim="not_vegan")
        assertEquals("Manufacturer says not vegan",applyCommunityReplies(result(),listOf(negative),"en","https://community.example").getString("title"))
        for ((source,replies) in listOf(result() to listOf(reply,negative),result("vegan") to listOf(negative),result("not_vegan") to listOf(reply)))
            assertEquals("conflicting",applyCommunityReplies(source,replies,"en","https://community.example").getString("outcome"))
        val animal = result().put("findings",JSONArray().put(JSONObject().put("status","animal")))
        assertEquals("conflicting",applyCommunityReplies(animal,listOf(reply),"en","https://community.example").getString("outcome"))
    }
    @Test fun unrelatedEditedLookupAndBlockedRepliesCannotChangeTheOpenProduct() {
        val state = CommunityRepliesState(CommunityLookup("Drink","Maker","3017620422003","SE"))
        state.page = CommunityReplyPage(listOf(reply),false)
        assertEquals(listOf(reply),state.appliedReplies())
        state.page = CommunityReplyPage(listOf(reply),true); assertTrue(state.appliedReplies().isEmpty())
        state.page = CommunityReplyPage(listOf(reply),false)
        state.hidden = setOf(reply.id); assertTrue(state.appliedReplies().isEmpty())
        state.hidden = emptySet(); state.submitted = state.original.copy(barcode="4006381333931")
        assertTrue(state.appliedReplies().isEmpty())
    }
}
