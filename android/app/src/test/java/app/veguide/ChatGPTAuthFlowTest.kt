package app.veguide

import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import org.junit.Assert.*
import org.junit.Test

class ChatGPTAuthFlowTest {
    @Test fun browserGetsReturnPageWhileBackgroundExchangeIsStillSuspended() = runBlocking {
        val exchangeStarted = CompletableDeferred<Unit>()
        val allowExchange = CompletableDeferred<Unit>()
        val browserReceivedPage = CompletableDeferred<Unit>()
        val attempt = async {
            completeChatGPTCallback({
                exchangeStarted.complete(Unit)
                allowExchange.await()
                "connected"
            }) { browserReceivedPage.complete(Unit) }
        }
        try {
            exchangeStarted.await()
            assertTrue("Browser must receive the app-return page before waiting on background token requests", browserReceivedPage.isCompleted)
        } finally {
            allowExchange.complete(Unit)
            attempt.await()
        }
    }
    @Test fun appSuccessWaitsForTokenVerificationAndSessionSave() = runBlocking {
        val events = mutableListOf<String>()
        val result = completeChatGPTCallback({ events += "verified and saved"; "connected" }) {
            events += "browser pending"
        }
        events += "app $result"
        assertEquals(listOf("browser pending", "verified and saved", "app connected"), events)
    }
    @Test fun tokenFailureReachesAppWithoutAFalseBrowserSuccess() = runBlocking {
        val events = mutableListOf<String>()
        try {
            completeChatGPTCallback<Unit>({ throw IllegalStateException("token failure") }, { events += "browser pending" })
            fail("Failure must reach the app")
        } catch (_: IllegalStateException) { events += "app failed" }
        assertEquals(listOf("browser pending", "app failed"), events)
    }
    @Test fun fullBrowserResponseClosesSocketBeforeWaitingOnExchange() = runBlocking {
        val exchangeStarted = CompletableDeferred<Unit>()
        val allowExchange = CompletableDeferred<Unit>()
        val server = java.net.ServerSocket(0, 1, java.net.InetAddress.getLoopbackAddress())
        server.use {
            val attempt = async(kotlinx.coroutines.Dispatchers.IO) {
                val socket = server.accept()
                completeChatGPTCallback({
                    assertTrue("Handoff must close the callback socket", socket.isClosed)
                    exchangeStarted.complete(Unit)
                    allowExchange.await()
                    "connected"
                }) { sendChatGPTBrowserResponse(socket, chatGPTCompletionResponse("Finish connecting in Veguide", true)) }
            }
            java.net.Socket(java.net.InetAddress.getLoopbackAddress(), server.localPort).use { browser ->
                browser.soTimeout = 1000
                try {
                    val response = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { browser.getInputStream().readBytes().toString(Charsets.UTF_8) }
                    exchangeStarted.await()
                    assertTrue(response.contains("Finish connecting in Veguide"))
                    assertFalse(attempt.isCompleted)
                } finally { allowExchange.complete(Unit) }
                assertEquals("connected", attempt.await())
            }
        }
    }

    @Test fun closedBrowserDoesNotUndoSavedConnection() = runBlocking {
        assertEquals("connected", completeChatGPTCallback({ "connected" }) { throw java.io.IOException("tab closed") })
    }
    @Test fun onlyBrowserDeadlineMapsToTimeoutAndStageFailuresDoNotLeakDetails() = runBlocking {
        ChatGPTSignInStage.entries.forEach { stage ->
            val error = try {
                chatGPTSignInStage(stage) { throw java.io.IOException("private token detail") }
                error("Must fail")
            } catch (error: ChatGPTSignInException) { error }
            assertEquals(stage.messageId, chatGPTSignInMessage(error))
            assertFalse(error.toString().contains("private token"))
            if (stage != ChatGPTSignInStage.TIMEOUT) assertNotEquals(R.string.chatgpt_signin_timeout, chatGPTSignInMessage(error))
        }
        assertEquals(R.string.chatgpt_signin_error, chatGPTSignInMessage(java.io.IOException("network")))
    }
    @Test fun cancellationIsNotReportedAsAnExpiredSignIn() = runBlocking {
        try {
            chatGPTSignInStage(ChatGPTSignInStage.EXCHANGE) { throw kotlinx.coroutines.CancellationException() }
            fail("Must cancel")
        } catch (_: kotlinx.coroutines.CancellationException) { }
    }
    @Test fun appReturnAcceptsOnlyNavigationWithoutCredentialParameters() {
        assertTrue(isChatGPTAppReturn("veguide://auth/complete"))
        listOf(null, "veguide://auth/complete?code=secret", "veguide://auth/complete#token", "veguide://auth/other",
            "https://auth/complete", "veguide://other/complete").forEach { assertFalse(isChatGPTAppReturn(it)) }
    }
    @Test fun completionPageUsesBrandedAssetAndPrivatePackageTargetedReturn() {
        val template = java.io.File(System.getProperty("veguide.repo"), "contracts/auth-completion.html").readText()
        val page = chatGPTCompletionPage(template, true, "Finish connecting in Veguide", "Return <now>", "Open Veguide")
        assertTrue(page.contains("<svg"))
        assertTrue(chatGPTCompletionPage(template, true, "Verbunden", "Bereit", "Öffnen", "de").contains("<html lang=\"de\">"))
        assertTrue(page.contains("Return &lt;now&gt;"))
        assertTrue(page.contains("package=app.veguide"))
        assertTrue(page.contains("history.replaceState(null,'','/auth/done')"))
        assertTrue(page.contains("window.location.replace"))
        assertFalse(page.contains("{{"))
        val failed = chatGPTCompletionPage(template, false, "Failed", "Retry", "Open Veguide")
        assertFalse(failed.contains("window.location.replace"))
        assertTrue(failed.contains("<a href="))
        val response = chatGPTCompletionResponse(page, true).toString(Charsets.UTF_8)
        assertTrue(response.startsWith("HTTP/1.1 200 OK"))
        assertTrue(response.contains("Cache-Control: no-store"))
        assertTrue(response.contains("script-src 'nonce-veguide-auth-return'"))
        assertTrue(response.contains("Content-Length: ${page.toByteArray(Charsets.UTF_8).size}\r\n"))
        assertTrue(chatGPTCompletionResponse(failed, false).toString(Charsets.UTF_8).startsWith("HTTP/1.1 400 Bad Request"))
    }
}
