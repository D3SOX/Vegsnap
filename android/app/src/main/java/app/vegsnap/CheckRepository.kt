package app.vegsnap

import android.content.Context
import java.util.Base64
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import okhttp3.*
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

fun validEndpoint(endpoint: String): Boolean {
    val url = endpoint.toHttpUrlOrNull() ?: return false
    return (url.isHttps || url.host in setOf("localhost", "127.0.0.1", "::1")) &&
        url.username.isEmpty() && url.password.isEmpty() && url.query == null && url.fragment == null
}
class CheckRepository(private val evaluator: Evaluator, private val extractionPrompt: String,
    private val http: OkHttpClient = defaultHttpClient(), private val chatGPT: ChatGPTConnection? = null,
    private val researchPrompt: String = extractionPrompt,
    private val productRequests: OpenFactsProductRequests = OpenFactsProductRequests(),
    private val offlineDatabase: OfflineDatabase? = null,
    private val companyConcerns: CompanyConcernResolver = CompanyConcernResolver(),
    private val hostedBaseUrl: String = "") {
    constructor(context: Context, chatGPT: ChatGPTConnection? = null) : this(
        Evaluator(JSONObject(context.assets.open("rules.json").bufferedReader().use { it.readText() })),
        JSONObject(context.assets.open("ai-extraction-prompt.json").bufferedReader().use { it.readText() }).getString("prompt"),
        chatGPT = chatGPT, productRequests = openFactsProducts, offlineDatabase = ApplicationOfflineDatabase.get(context),
        researchPrompt = JSONObject(context.assets.open("ai-extraction-prompt.json").bufferedReader().use { it.readText() }).getString("researchPrompt"),
        companyConcerns = CompanyConcernResolver(JSONObject(context.assets.open("company-concerns.json").bufferedReader().use { it.readText() })),
        hostedBaseUrl = JSONObject(context.assets.open("hosted-ai.json").bufferedReader().use { it.readText() }).getString("baseUrl"),
    )
    companion object {
        fun defaultHttpClient() = OkHttpClient.Builder().dispatcher(Dispatcher().apply { maxRequestsPerHost = 10 }).followRedirects(false).followSslRedirects(false)
            .callTimeout(60, TimeUnit.SECONDS).connectTimeout(15, TimeUnit.SECONDS).build()
    }

    suspend fun check(original: CheckInput, photos: List<PreparedPhoto>, settings: AppSettings, token: String,
        onProgress: (CheckStage) -> Unit = {},
        recognizePhotos: (suspend (List<PreparedPhoto>) -> List<PreparedPhoto>)? = null): JSONObject = withContext(Dispatchers.IO) {
        val combinedText = (original.text + "\n" + photos.joinToString("\n") { it.text }).trim()
        val truncated = original.truncated || photos.any { it.truncated } || combinedText.length > 30_000
        val barcode = original.barcode.takeIf(::validGtin)
            ?: Regex("(?<![0-9])[0-9]{8,14}(?![0-9])").findAll(combinedText.take(30_000)).map { it.value }.firstOrNull(::validGtin).orEmpty()
        val input = original.copy(text = combinedText.take(30_000), complete = if (truncated) false else original.complete, barcode = barcode)
        // OCR is noisy page text, not a user-supplied ingredients list. Only a recognizable
        // composition heading makes photo text eligible for the local ingredient evaluator.
        val photoComposition = photos.mapNotNull { photo -> compositionHeading.find(photo.text)?.let { photo.text.substring(it.range.first) } }
        val localText = (listOf(original.text) + photoComposition).filter { it.isNotBlank() }.joinToString("\n").take(30_000)
        val localComplete = if (photos.isNotEmpty() && original.text.isBlank()) false else input.complete
        var result = evaluator.evaluate(input.copy(text = localText, complete = localComplete))
        if (photos.isNotEmpty() && original.text.isBlank()) {
            result.put("evidence", JSONArray())
            if (localText.isNotBlank()) {
                val evidence = JSONObject().put("id", "photo-ocr").put("kind", "ocr").put("title", if (input.locale == "de") "Texterkennung auf dem Gerät — am Etikett prüfen" else "On-device text recognition — verify against the label")
                    .put("excerpt", localText).put("retrievedAt", result.getString("checkedAt"))
                result.getJSONArray("evidence").put(evidence)
                val findings = result.getJSONArray("findings")
                for (index in 0 until findings.length()) findings.getJSONObject(index).put("evidenceId", "photo-ocr")
            }
        }
        var aiStatus = "not_needed"
        var extractionInput = input
        var aiError: JSONObject? = null
        var contactExtraction: JSONObject? = null
        val warnings = JSONArray()
        if (truncated) warnings.put(if (input.locale == "de") "Langer Text wurde gekürzt und wird als unvollständig behandelt." else "Long text was shortened and is treated as incomplete.")
        if (validGtin(barcode)) {
            try {
                onProgress(CheckStage.DATABASE)
                val database = lookup(barcode, input, settings.offline)
                if (database != null) {
                    result = mergeResults(result, databaseResult(database, barcode))
                    // Give AI the community record without promoting it to user-supplied evidence.
                    val useDatabaseText = photos.isEmpty() && input.text.isBlank()
                    extractionInput = input.copy(name = input.name.ifBlank { database.first.name }.take(300),
                        category = if (input.category == "other") database.first.category else input.category,
                        text = if (useDatabaseText) database.first.text.take(30_000) else input.text,
                        complete = if (useDatabaseText) false else input.complete)
                } else if (settings.offline) warnings.put(if (input.locale == "de") "Nicht im begrenzten Offline-Datenstand gefunden. Das sagt nichts über Existenz oder vegane Eigenschaften des Produkts aus." else "Not found in the limited offline snapshot. This does not establish whether the product exists or is vegan.")
            } catch (error: kotlinx.coroutines.CancellationException) { throw error }
            catch (error: Exception) { warnings.put(if (input.locale == "de") "Datenbank nicht erreichbar; lokale Analyse verwendet." else "Database unavailable; using local analysis.") }
        }
        if (result.getString("outcome") == "uncertain") {
            aiStatus = when {
                settings.offline -> "offline"
                !settings.aiEnabled -> "disabled"
                photos.isNotEmpty() && !settings.vision && combinedText.isBlank() -> "vision_disabled"
                settings.connection == "chatgpt" && (settings.chatgptModel.isBlank() || chatGPT == null) -> "unconfigured"
                settings.connection == "hosted" && (hostedBaseUrl.isBlank() || settings.baseUrl != hostedBaseUrl || !token.matches(Regex("[a-f0-9]{64}"))) -> "unconfigured"
                settings.connection != "chatgpt" && (!validEndpoint(settings.baseUrl) || settings.model.isBlank()) -> "unconfigured"
                else -> "pending"
            }
        }
        if (aiStatus == "pending") {
            try {
                onProgress(if (photos.isNotEmpty() && settings.vision) CheckStage.ANALYZING_PHOTO else CheckStage.ANALYZING_TEXT)
                val extracted = extract(extractionInput, photos, settings, token, onProgress)
                contactExtraction = extracted
                onProgress(CheckStage.EVALUATING)
                val localComplete = extractionInput.complete ?: Regex("(?:^|\\n)\\s*(?:ingredients|ingredienser|zutaten|materials|material|zusammensetzung|composition)\\s*:", RegexOption.IGNORE_CASE).containsMatchIn(extractionInput.text)
                val complete = extractionInput.complete != false && (photos.isNotEmpty() && settings.vision || localComplete) && extracted.getBoolean("complete")
                val recognizedBarcode = extracted.optString("barcode").takeIf(::validGtin).orEmpty()
                require(barcode.isBlank() || recognizedBarcode.isBlank() || barcode.padStart(14, '0') == recognizedBarcode.padStart(14, '0')) { "AI identified a different product" }
                val authoritativeText = when {
                    original.complete == true && original.text.isNotBlank() -> original.text.take(30_000)
                    photos.isNotEmpty() && !settings.vision && original.text.isBlank() && photoComposition.isEmpty() -> ""
                    else -> extracted.getString("text")
                }
                val aiInput = input.copy(text = authoritativeText, complete = complete, name = extracted.optString("name", input.name),
                    category = if (input.category != "other") input.category else extracted.getString("category"),
                    barcode = barcode.ifBlank { recognizedBarcode })
                val ingredients = extracted.optJSONArray("ingredients")?.let { items -> (0 until items.length()).map { items.getString(it) } }
                val parsed = parseSourceIngredients(aiInput.text, extracted.optJSONArray("ingredients"))
                val ai = evaluator.evaluate(aiInput, ingredients).put("usedAI", true)
                extracted.optString("brand").takeIf { it.isNotBlank() }?.let { ai.getJSONObject("identity").put("brand", it) }
                val evidence = ai.getJSONArray("evidence").getJSONObject(0)
                evidence.put("id", "ai-extraction").put("kind", "ai_extraction").put("title", if (input.locale == "de") "KI-extrahierter Text — am Etikett prüfen" else "AI-extracted text — verify against the label")
                val aiFindings = ai.getJSONArray("findings")
                for (index in 0 until aiFindings.length()) aiFindings.getJSONObject(index).put("evidenceId", "ai-extraction")
                if (evidence.getString("excerpt").isBlank()) ai.put("evidence", JSONArray())
                val identifiedInput = aiInput.copy(name = original.name.ifBlank { aiInput.name })
                result = applyWebEvidence(applyWebCompositions(applyAIEvidence(mergeResults(if (parsed != null) withoutCompositionFindings(result, aiInput.text) else result, ai), aiInput, extracted, complete, photos.isNotEmpty() && settings.vision), identifiedInput, extracted, evaluator), identifiedInput, extracted)
                if (result.getJSONObject("identity").optString("brand").isBlank()) extracted.optString("brand").takeIf { it.isNotBlank() }
                    ?.let { result.getJSONObject("identity").put("brand", it) }
                if (extracted.optJSONObject("research")?.optBoolean("searched") != true && needsResearch(input, extracted, photos.isNotEmpty() && settings.vision, settings)) warnings.put(if (input.locale == "de") "Die Webrecherche wurde nicht abgeschlossen; die verfügbaren Foto- oder Textbelege bleiben erhalten." else "Web research did not complete; the available photo or text evidence was kept.")
                aiStatus = if (photos.isNotEmpty()) { if (settings.vision) "images" else "vision_disabled" } else "text"
                // A vision-discovered GTIN can identify a public record before assessment.
                if (recognizedBarcode.isNotBlank() && barcode.isBlank()) {
                    try {
                        val database = lookup(recognizedBarcode, aiInput)
                        if (database != null) result = mergeResults(result, databaseResult(database, recognizedBarcode))
                    } catch (error: kotlinx.coroutines.CancellationException) { throw error }
                    catch (error: Exception) { warnings.put(if (input.locale == "de") "Datenbank nicht erreichbar; KI-Belege bleiben erhalten." else "Database unavailable; AI evidence has been kept.") }
                }
                if (extracted.getString("text").isNotBlank()) warnings.put(if (input.locale == "de") "KI kann Etiketten falsch lesen. Extraktion ist kein Zertifizierungsnachweis." else "AI may misread labels. Extraction is not certification evidence.")
            } catch (error: kotlinx.coroutines.CancellationException) { throw error }
            catch (error: Exception) { aiStatus = "failed"; aiError = aiFailure(error, input.locale) }
        }
        // Vision gets the untouched sanitized photos first. Local OCR is a last-resort,
        // one-shot fallback and must never reinterpret a successful AI analysis.
        if (photos.isNotEmpty() && result.getString("outcome") == "uncertain" && !result.getBoolean("usedAI") && recognizePhotos != null) {
            try {
                onProgress(CheckStage.OCR_FALLBACK)
                val recognized = recognizePhotos(photos)
                val rawText = recognized.joinToString("\n") { it.text }
                val ocrText = recognized.mapNotNull { photo -> compositionHeading.find(photo.text)?.let { photo.text.substring(it.range.first) } }
                    .joinToString("\n").take(30_000)
                warnings.put(if (input.locale == "de") "Texterkennung auf dem Gerät als Ersatz für die KI-Bildanalyse verwendet." else "On-device text recognition was used as a fallback for AI image analysis.")
                if (recognized.any { it.truncated } || rawText.length > 30_000) warnings.put(if (input.locale == "de") "Langer OCR-Text wurde gekürzt und wird als unvollständig behandelt." else "Long OCR text was shortened and is treated as incomplete.")
                if (ocrText.isNotBlank()) {
                    val fallback = evaluator.evaluate(input.copy(text = ocrText, complete = false,
                        category = result.getString("category"), name = result.getJSONObject("identity").optString("name")))
                    fallback.getJSONArray("evidence").getJSONObject(0).put("id", "photo-ocr").put("kind", "ocr")
                        .put("title", if (input.locale == "de") "Texterkennung auf dem Gerät — am Etikett prüfen" else "On-device text recognition — verify against the label")
                    val findings = fallback.getJSONArray("findings")
                    for (index in 0 until findings.length()) findings.getJSONObject(index).put("evidenceId", "photo-ocr")
                    result = mergeResults(result, fallback)
                }
            } catch (error: kotlinx.coroutines.CancellationException) { throw error }
            catch (error: Exception) { warnings.put(if (input.locale == "de") "Auch die lokale Texterkennung ist fehlgeschlagen; bisherige Belege bleiben erhalten." else "Local text recognition also failed; earlier evidence has been kept.") }
        }
        val allWarnings = result.getJSONArray("warnings")
        for (index in 0 until warnings.length()) allWarnings.put(warnings.getString(index))
        aiError?.let { result.put("aiError", it) }
        contactExtraction?.let {
            applyManufacturerContact(result, original, it)
            applyCompanyAssessment(result, it)
        }
        companyConcerns.attach(result.put("aiStatus", aiStatus), original.locale)
    }
    /** Passive camera lookups send only the GTIN; this entry point cannot invoke AI. */
    suspend fun lookupBarcode(input: CheckInput, offline: Boolean = false): JSONObject? = withContext(Dispatchers.IO) {
        require(validGtin(input.barcode))
        lookup(input.barcode, input, offline)?.let { databaseResult(it, input.barcode) }
    }

    private fun databaseResult(database: Pair<CheckInput, JSONObject>, barcode: String): JSONObject {
        val result = evaluator.evaluate(database.first)
        result.put("evidence", JSONArray().put(database.second))
        val findings = result.getJSONArray("findings")
        for (index in 0 until findings.length()) findings.getJSONObject(index).put("evidenceId", database.second.getString("id"))
        result.getJSONObject("identity").put("barcode", barcode).put("match", "exact_barcode")
        database.second.optString("databaseBrand").takeIf { it.isNotBlank() }?.let { result.getJSONObject("identity").put("brand", it) }
        database.second.remove("databaseBrand")
        if (database.second.optBoolean("differentMarket")) result.getJSONArray("warnings").put(if (database.first.locale == "de") "Dieser Datensatz nennt andere Märkte. Vergleiche die Rezeptur mit deiner Packung." else "This record lists other markets. Compare its composition with your package.")
        database.second.remove("differentMarket")
        if (database.second.has("offlineSnapshotDate")) {
            val date = database.second.getString("offlineSnapshotDate").take(10)
            database.second.remove("offlineSnapshotDate")
            result.getJSONArray("warnings").put(if (database.first.locale == "de") "Begrenzter Offline-Datenstand vom $date. Gemeinschaftliche Angaben können veraltet oder unvollständig sein." else "Limited offline snapshot from $date. Community records may be outdated or incomplete.")
        }
        result.getJSONArray("warnings").put(if (database.first.locale == "de") "Gemeinschaftlich gepflegter Datensatz; Markt, Rezeptur und Aktualität prüfen." else "Community-maintained record; check market, recipe and freshness.")
        return companyConcerns.attach(result, database.first.locale)
    }
    private suspend fun lookup(barcode: String, input: CheckInput, offline: Boolean = false): Pair<CheckInput, JSONObject>? {
        offlineDatabase?.lookup(input.copy(barcode = barcode))?.let { return it }
        if (offline) return null
        val domains = when (input.category) {
            "food", "drink" -> listOf("openfoodfacts.org")
            "cosmetics" -> listOf("openbeautyfacts.org")
            "clothing", "shoes", "household" -> listOf("openproductsfacts.org")
            else -> listOf("openfoodfacts.org", "openbeautyfacts.org", "openproductsfacts.org")
        }
        for (domain in domains) {
            val request = Request.Builder().url("https://world.$domain/api/v3/product/$barcode.json?fields=code,product_name,product_name_de,ingredients_text,ingredients_text_de,brands,last_modified_t,countries_tags")
                .header("User-Agent", "Vegsnap/0.1 (Android; local personal product checks)").build()
            val response = productRequests.product(request.url.toString()) { request(request, allowNotFound = true) } ?: continue
            val product = response.optJSONObject("product") ?: continue
            val returned = product.optString("code")
            if (!validGtin(returned) || returned.padStart(14, '0') != barcode.padStart(14, '0')) throw IOException("Product identity mismatch")
            val markets = product.optJSONArray("countries_tags") ?: JSONArray()
            val differentMarket = markets.length() > 0 && (0 until markets.length()).none { markets.optString(it) == "en:germany" }
            val text = product.optString(if (input.locale == "de") "ingredients_text_de" else "ingredients_text").ifBlank { product.optString("ingredients_text") }
            val name = product.optString(if (input.locale == "de") "product_name_de" else "product_name").ifBlank { product.optString("product_name") }
            val category = if (input.category == "other") when (domain) { "openfoodfacts.org" -> "food"; "openbeautyfacts.org" -> "cosmetics"; else -> "other" } else input.category
            val evidence = JSONObject().put("id", "$domain:$barcode").put("kind", "database").put("title", domain)
                .put("databaseBrand", product.optString("brands"))
                .put("differentMarket", differentMarket).put("url", "https://world.$domain/product/$barcode").put("excerpt", text).put("retrievedAt", java.time.Instant.now().toString()).put("license", "ODbL-1.0")
            if (product.optLong("last_modified_t") > 0) evidence.put("sourceDate", java.time.Instant.ofEpochSecond(product.getLong("last_modified_t")).toString())
            // Community ingredient fields may be partial. Explicit completeness is deliberately not inferred.
            return input.copy(text = text, name = name, barcode = barcode, complete = false, category = category) to evidence
        }
        return null
    }
    private fun researchAssessment(input: CheckInput, extracted: JSONObject, imagesSent: Boolean): JSONObject {
        val visibleInput = input.copy(text = extracted.getString("text"), complete = extracted.getBoolean("complete"),
            name = input.name.ifBlank { extracted.optString("name") }, category = if (input.category == "other") extracted.getString("category") else input.category)
        val ingredients = extracted.optJSONArray("ingredients")?.let { items -> (0 until items.length()).map { items.getString(it) } }
        val visible = applyAIEvidence(evaluator.evaluate(visibleInput, ingredients), visibleInput, extracted, extracted.getBoolean("complete"), imagesSent)
        return applyWebEvidence(applyWebCompositions(visible, visibleInput, extracted, evaluator), visibleInput, extracted)
    }
    private fun publicResearchQuestions(input: CheckInput, extracted: JSONObject): JSONArray {
        val findings = researchAssessment(input, extracted, false).getJSONArray("findings")
        return JSONArray((0 until findings.length()).map { findings.getJSONObject(it) }.filter {
            it.optString("evidenceId").startsWith("web-composition-") && it.getString("status") in setOf("unknown", "ambiguous")
        }.map { it.getString("term").take(300) }.distinct().take(20))
    }
    private fun needsResearch(input: CheckInput, extracted: JSONObject, imagesSent: Boolean, settings: AppSettings): Boolean {
        val endpoint = settings.baseUrl.toHttpUrlOrNull()
        val supported = settings.connection == "chatgpt" || endpoint?.let { it.host == "api.openai.com" && it.encodedPath.trimEnd('/') == "/v1" } == true
        if (!supported || extracted.optString("name").isBlank() || extracted.optString("brand").isBlank()) return false
        return researchAssessment(input, extracted, imagesSent).getString("outcome") == "uncertain"
    }

    private suspend fun extract(input: CheckInput, photos: List<PreparedPhoto>, settings: AppSettings, token: String, onProgress: (CheckStage) -> Unit): JSONObject {
        val started = System.nanoTime()
        val first = extractOnce(input, photos, settings, token, onProgress = onProgress)
        if (!needsResearch(input, first, photos.isNotEmpty() && settings.vision, settings)) return first
        val remaining = 130_000L - TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started)
        if (remaining <= 0) return first
        onProgress(CheckStage.SEARCHING_WEB)
        val followup = try {
            kotlinx.coroutines.withTimeoutOrNull(remaining) {
                extractOnce(CheckInput(category = first.getString("category"), locale = input.locale), emptyList(), settings, token, first, onProgress)
            }
        } catch (error: kotlinx.coroutines.CancellationException) { throw error }
        catch (_: Exception) { null }
        if (followup == null) return first
        if (followup.optJSONObject("research")?.optBoolean("searched") != true) return first
        if (normalizeProductIdentity(followup.optString("name")) != normalizeProductIdentity(first.getString("name")) ||
            normalizeProductIdentity(followup.optString("brand")) != normalizeProductIdentity(first.getString("brand"))) return first
        val merged = mutableMapOf<String, JSONArray>()
        for ((field, limit) in listOf("ingredientAssessments" to 100, "webClaims" to 5, "webCompositions" to 3)) {
            val combined = listOf(first, followup).flatMap { source ->
                val items = source.optJSONArray(field) ?: JSONArray()
                (0 until items.length()).map { items.getJSONObject(it) }
            }
            val values = if (field == "webCompositions") mergeSourceCompositions(combined) else combined.distinctBy { it.toString() }
            if (values.size > limit) return first
            merged[field] = JSONArray(values)
        }
        val sources = listOf(first, followup).flatMap { source ->
            val items = source.optJSONObject("research")?.optJSONArray("sources") ?: JSONArray()
            (0 until items.length()).map { items.getJSONObject(it) }
        }.distinctBy { it.getString("url") }
        if (sources.size > 50) return first
        for ((field, items) in merged) first.put(field, items)
        first.put("research", JSONObject().put("searched", true).put("sources", JSONArray(sources)))
        safeManufacturerContact(followup.optJSONObject("contact"))?.let { first.put("contact", it) }
        sourcedCompanyAssessment(JSONObject(followup.toString()).put("research", first.getJSONObject("research")))?.let { first.put("companyAssessment", it) }
        return first
    }

    private suspend fun extractOnce(input: CheckInput, photos: List<PreparedPhoto>, settings: AppSettings, token: String,
        researchIdentity: JSONObject? = null, onProgress: (CheckStage) -> Unit = {}): JSONObject {
        val requireResearch = researchIdentity != null
        val prompt = if (requireResearch) extractionPrompt + "\n" + researchPrompt else extractionPrompt
        val context = if (researchIdentity != null) JSONObject().put("name", researchIdentity.getString("name")).put("brand", researchIdentity.getString("brand"))
            .put("category", researchIdentity.getString("category")).put("locale", input.locale).put("unresolvedIngredients", publicResearchQuestions(input, researchIdentity)).toString()
        else extractionInputContext(input).toString()
        var research: JSONObject? = null
        val text = if (settings.connection == "hosted") {
            require(settings.baseUrl == hostedBaseUrl && !requireResearch)
            val payload = JSONObject(context)
            if (payload.isNull("complete")) payload.remove("complete")
            if (settings.vision) payload.put("images", JSONArray(photos.take(3).map { "data:image/jpeg;base64," + Base64.getEncoder().encodeToString(it.jpeg) }))
            val response = requireNotNull(request(Request.Builder().url("$hostedBaseUrl/api/check")
                .header("Authorization", "Bearer $token").post(payload.toString().toRequestBody("application/json".toMediaType())).build()))
            research = response.optJSONObject("research")
            response.remove("research")
            response.toString()
        } else if (settings.connection == "chatgpt") {
            val response = requireNotNull(chatGPT) { "ChatGPT connection unavailable" }.extract(settings.chatgptModel, prompt, context,
                if (settings.vision) photos.take(3).map { "data:image/jpeg;base64," + Base64.getEncoder().encodeToString(it.jpeg) } else emptyList(), requireResearch, onResearchStarted = { onProgress(CheckStage.SEARCHING_WEB) })
            research = response.research
            response.text
        } else {
            require(validEndpoint(settings.baseUrl) && settings.model.isNotBlank())
            val endpoint = requireNotNull(settings.baseUrl.toHttpUrlOrNull())
            val supportsSearch = endpoint.host == "api.openai.com" && endpoint.encodedPath.trimEnd('/') == "/v1"
            val content = JSONArray().put(JSONObject().put("type", if (supportsSearch) "input_text" else "text").put("text", context))
            if (settings.vision) photos.take(3).forEach {
                val url = "data:image/jpeg;base64," + Base64.getEncoder().encodeToString(it.jpeg)
                content.put(if (supportsSearch) JSONObject().put("type", "input_image").put("image_url", url)
                    else JSONObject().put("type", "image_url").put("image_url", JSONObject().put("url", url)))
            }
            val body = JSONObject().put("model", settings.model).put("stream", false)
            if (supportsSearch) body.put("instructions", prompt).put("store", false)
                .put("tools", JSONArray().put(JSONObject().put("type", "web_search"))).put("max_tool_calls", 3)
                .put("include", JSONArray().put("web_search_call.action.sources"))
                .put("input", JSONArray().put(JSONObject().put("role", "user").put("content", content)))
            else body.put("messages", JSONArray().put(JSONObject().put("role", "system").put("content", prompt))
                .put(JSONObject().put("role", "user").put("content", content)))
            if (supportsSearch && requireResearch) body.put("tool_choice", "required")
            val builder = Request.Builder().url(settings.baseUrl.trimEnd('/') + if (supportsSearch) "/responses" else "/chat/completions")
                .post(body.toString().toRequestBody("application/json".toMediaType()))
            if (token.isNotBlank()) builder.header("Authorization", "Bearer $token")
            val response = request(builder.build()) ?: error("Empty response")
            if (supportsSearch) {
                if (response.optString("status") != "completed") throw providerStreamFailure(response)
                research = responseResearch(response)
                val output = response.getJSONArray("output")
                buildString {
                    for (index in 0 until output.length()) {
                        val item = output.getJSONObject(index)
                        if (item.optString("type") != "message") continue
                        val parts = item.optJSONArray("content") ?: continue
                        for (i in 0 until parts.length()) if (parts.getJSONObject(i).optString("type") == "output_text") append(parts.getJSONObject(i).getString("text"))
                    }
                }
            } else {
                val choice = response.getJSONArray("choices").getJSONObject(0)
                if (choice.optString("finish_reason") != "stop") throw AIProviderFailure(AIErrorCode.INCOMPLETE)
                choice.getJSONObject("message").getString("content")
            }
        }
        val cleanText = text.trim().removePrefix("```json").removePrefix("```").removeSuffix("```").trim()
        val extracted = JSONObject(cleanText)
        require(!extracted.has("research")) { "Model cannot supply tool provenance" }
        require(extracted.get("text") is String && extracted.get("complete") is Boolean)
        require(extracted.optString("category") in setOf("food", "drink", "cosmetics", "household", "clothing", "shoes", "other"))
        for (field in listOf("name", "brand", "barcode")) require(!extracted.has(field) || extracted.get(field) is String)
        require(extracted.getString("text").length <= 20_000)
        validateAIEvidence(extracted)
        validateWebClaims(extracted)
        validateWebCompositions(extracted)
        if (extracted.has("companyAssessment")) {
            val assessment = safeCompanyAssessment(extracted.optJSONObject("companyAssessment"))
            extracted.remove("companyAssessment")
            if (assessment != null) extracted.put("companyAssessment", assessment)
        }
        if (extracted.has("contact")) {
            val contact = safeManufacturerContact(extracted.optJSONObject("contact"))
            extracted.remove("contact")
            if (contact != null) extracted.put("contact", contact)
        }
        if (!requireResearch && (photos.isEmpty() || !settings.vision)) require(validTextExtraction(input.text, extracted.getString("text"))) { "AI changed supplied composition" }
        if (research != null) extracted.put("research", research)
        return extracted
    }
    private suspend fun request(request: Request, allowNotFound: Boolean = false): JSONObject? = suspendCancellableCoroutine { continuation ->
        val hostedRequest = request.url.encodedPath == "/api/check"
        val providerRequest = request.url.encodedPath.endsWith("/responses") || request.url.encodedPath.endsWith("/chat/completions")
        val client = if (hostedRequest) http.newBuilder().callTimeout(135, TimeUnit.SECONDS).readTimeout(135, TimeUnit.SECONDS).build()
            else if (providerRequest) http.newBuilder().callTimeout(120, TimeUnit.SECONDS).readTimeout(90, TimeUnit.SECONDS).build() else http
        val call = client.newCall(request)
        continuation.invokeOnCancellation { call.cancel() }
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) { if (continuation.isActive) continuation.resumeWithException(e) }
            override fun onResponse(call: Call, response: Response) {
                response.use {
                    try {
                        if (allowNotFound && response.code == 404) { if (continuation.isActive) continuation.resume(null); return }
                        if (!response.isSuccessful) throw providerHttpFailure(response.code, response.body.byteStream())
                        val body = response.body
                        val output = java.io.ByteArrayOutputStream()
                        val buffer = ByteArray(8192)
                        val stream = body.byteStream()
                        while (output.size() <= 1_000_000) {
                            val count = stream.read(buffer, 0, minOf(buffer.size, 1_000_001 - output.size()))
                            if (count < 0) break
                            output.write(buffer, 0, count)
                        }
                        val bytes = output.toByteArray()
                        if (bytes.size > 1_000_000) throw AIProviderFailure(AIErrorCode.INVALID_RESPONSE)
                        val json = JSONObject(String(bytes))
                        if (continuation.isActive) continuation.resume(json)
                    } catch (e: Exception) { if (continuation.isActive) continuation.resumeWithException(e) }
                }
            }
        })
    }
}

fun validTextExtraction(original: String, extracted: String): Boolean {
    fun normalized(value: String) = java.text.Normalizer.normalize(value, java.text.Normalizer.Form.NFKC).lowercase(java.util.Locale.ROOT).replace(Regex("\\s+"), " ").trim()
    val heading = Regex("(?:^|\\n)\\s*(?:ingredients|ingredienser|zutaten|materials|material|zusammensetzung|composition)\\s*:\\s*", RegexOption.IGNORE_CASE).find(original)
    val body = heading?.let { original.substring(it.range.last + 1) } ?: original
    return normalized(extracted) in setOf(normalized(original), normalized(body))
}

/** Preserve every source's findings; uncertainty cannot erase a concrete animal finding. */
fun mergeResults(current: JSONObject, next: JSONObject): JSONObject {
    val currentOutcome = current.getString("outcome")
    val nextOutcome = next.getString("outcome")
    val contradictory = currentOutcome == "vegan" && nextOutcome == "not_vegan" || currentOutcome == "not_vegan" && nextOutcome == "vegan"
    val preferred = if (currentOutcome == "conflicting" || currentOutcome != "uncertain" && nextOutcome == "uncertain") current else next
    val result = JSONObject(preferred.toString()).put("id", current.getString("id"))
    val currentIdentity = current.getJSONObject("identity")
    val nextIdentity = next.getJSONObject("identity")
    result.put("identity", when {
        currentIdentity.optString("match") == "exact_barcode" -> currentIdentity
        nextIdentity.optString("match") == "exact_barcode" -> nextIdentity
        else -> preferred.getJSONObject("identity")
    })
    if (contradictory) result.put("outcome", "conflicting").put("basis", "insufficient")
        .put("summary", "The supplied composition and another source disagree. Check the product variant and source dates.")
    val databaseSources = listOf(current, next).flatMap { source -> source.getJSONArray("evidence").let { items ->
        (0 until items.length()).map { items.getJSONObject(it) }.filter { it.optString("kind") == "database" }.map { it.getString("id") }
    } }.toSet()
    for (field in listOf("evidence", "findings", "warnings", "crossContact")) {
        val merged = linkedMapOf<String, Any>()
        for (source in listOf(current, next)) {
            val values = source.getJSONArray(field)
            for (index in 0 until values.length()) {
                val item = values.get(index)
                val key = when (field) {
                    "evidence" -> (item as JSONObject).getString("id")
                    "findings" -> (item as JSONObject).let {
                        val key = "${normalizeCompositionTerm(it.getString("term"))}:${it.getString("status")}"
                        // Separate database misses from assessments, retaining existing transcription deduplication.
                        if (it.getString("status") == "unknown" && it.optString("evidenceId") in databaseSources) "$key:${it.optString("evidenceId")}" else key
                    }
                    else -> item.toString()
                }
                val previous = merged[key] as? JSONObject
                merged[key] = if (field == "findings" && item is JSONObject && !item.has("displayTerm") && previous?.has("displayTerm") == true) {
                    // Preserve display-only wording when a database finding replaces the same source term/status.
                    JSONObject(item.toString()).put("displayTerm", previous.get("displayTerm")).put("displayLocale", previous.opt("displayLocale"))
                } else item
            }
        }
        result.put(field, JSONArray(merged.values.toList()))
    }
    result.put("companyConcerns", current.getJSONArray("companyConcerns"))
    result.put("usedAI", current.getBoolean("usedAI") || next.getBoolean("usedAI"))
    val findings = result.getJSONArray("findings")
    val filtered = withoutDatabaseRuleMisses(findings, result.getJSONArray("evidence"))
    if (filtered.length() < findings.length()) result.put("questions", reconcileOriginQuestions(result.getJSONArray("questions"), filtered))
    return result.put("findings", filtered)
}

/** Keep the established ingredient and source instead of a duplicate database rule miss. */
internal fun withoutDatabaseRuleMisses(findings: JSONArray, evidence: JSONArray): JSONArray {
    val values = (0 until findings.length()).map { findings.getJSONObject(it) }
    val established = values.filter { it.getString("status") != "unknown" }.flatMap { finding ->
        val term = normalizeCompositionTerm(finding.getString("term"))
        // The curry label's country of origin does not change the ingredient's identity.
        if (finding.getString("status") == "plant") listOf(term, term.replace(Regex("\\s+\\((?:thaimaa|thailand)\\)$"), "")) else listOf(term)
    }.toSet()
    val databaseSources = (0 until evidence.length()).map { evidence.getJSONObject(it) }
        .filter { it.optString("kind") == "database" }.map { it.getString("id") }.toSet()
    return JSONArray(values.filter { finding -> finding.getString("status") != "unknown" || finding.optString("evidenceId") !in databaseSources || normalizeCompositionTerm(finding.getString("term")) !in established })
}

/** Keep existing origin questions aligned with the ingredients still requiring clarification. */
internal fun reconcileOriginQuestions(questions: JSONArray, findings: JSONArray, locale: String? = null): JSONArray {
    val unresolved = (0 until findings.length()).map { findings.getJSONObject(it) }
        .filter { it.getString("status") in setOf("unknown", "ambiguous") }
        .map { if (locale != null) it.optString("displayTerm", it.getString("term")) else it.getString("term") }.distinct()
    val originQuestion = Regex("^(?:Confirm the origin of:|Die Herkunft dieser Zutaten klären:|Confirm the source of the ambiguous|Die Herkunft unklarer)")
    return JSONArray((0 until questions.length()).mapNotNull { index ->
        val question = questions.getString(index)
        if (!originQuestion.containsMatchIn(question)) question else {
            val de = if (locale != null) locale == "de" else question.startsWith("Die Herkunft")
            if (unresolved.isEmpty()) null else (if (de) "Die Herkunft dieser Zutaten klären: " else "Confirm the origin of: ") + unresolved.joinToString(", ") + "."
        }
    })
}

/** Shared by ChatGPT plan and OpenAI-compatible requests, so photo checks retain known identity. */
internal fun extractionInputContext(input: CheckInput): JSONObject = JSONObject().put("text", input.text).put("category", input.category)
    .put("locale", input.locale).put("complete", input.complete ?: JSONObject.NULL)
    .apply { if (input.name.isNotBlank()) put("name", input.name); if (validGtin(input.barcode)) put("barcode", input.barcode) }
