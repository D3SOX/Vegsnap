package app.vegsnapp

import org.junit.Assert.*
import org.junit.Test

class BarnivoreTest {
    private fun page(rows: String) = """<p id="result-count">2 products found</p><ul id="results">$rows</ul>"""
    private fun row(id: Int, name: String, badge: String) = """<li><a href="/products/$id-drink" class="result-row"><span class="result-name">$name</span><span class="result-meta">Maker · Beer</span><span class="result-status"><span class="badge badge-sm $badge">Status</span></span></a></li>"""
    @Test fun reportsSourceStatusWithoutTreatingBadgeAsCompositionOrCertification() {
        val result = parseBarnivoreSearch(page(row(1, "Drink &amp; Co", "badge-vegan") + row(2, "Drink (Australia)", "badge-not-vegan")), "de", "2026-10-05T00:00:00Z")
        assertEquals(2, result.records.size)
        assertEquals("Drink & Co", result.records[0].name)
        assertEquals("Laut Barnivore vegan", result.records[0].labels)
        assertEquals("Laut Barnivore nicht vegan", result.records[1].labels)
        assertTrue(result.records.all { it.composition.isEmpty() && it.url.startsWith("https://www.barnivore.com/products/") })
        assertEquals("2026-10-05T00:00:00Z", result.records[0].updated)
    }
    @Test fun unknownStatusIsNotVeganAndForeignLinksAreNotAccepted() {
        val result = parseBarnivoreSearch(page(row(1, "Drink", "badge-unknown") + row(2, "Injected", "badge-vegan").replace("/products/2-drink", "https://evil.example/products/2-drink")), "en", "2026-10-05T00:00:00Z")
        assertEquals(1, result.records.size)
        assertEquals("Status unclear — check the original record", result.records.single().labels)
    }
    @Test fun siteErrorsDoNotLookLikeNoMatches() {
        try { parseBarnivoreSearch("<html>Service unavailable</html>", "en", "2026-10-05"); fail() }
        catch (error: BrowseException) { assertEquals(BrowseFailure.UNAVAILABLE, error.reason) }
        assertTrue(parseBarnivoreSearch("<form id=\"search-form\"></form><p class=\"heading-3 mb-2\">Yikes, no matches found!</p>", "en", "2026-10-05").records.isEmpty())
        assertTrue(parseBarnivoreSearch("<p id=\"result-count\">0 products found</p>", "en", "2026-10-05").records.isEmpty())
    }
}
