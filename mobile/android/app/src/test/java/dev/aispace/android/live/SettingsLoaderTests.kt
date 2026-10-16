package dev.aispace.android.live

import dev.aispace.android.core.CookieSource
import dev.aispace.android.core.SpaceApi
import kotlinx.coroutines.*
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.Assert.*
import java.util.concurrent.TimeUnit

class SettingsLoaderTests {
    private lateinit var server: MockWebServer
    @Before fun start() { server = MockWebServer(); server.start() }
    @After fun stop() { server.shutdown() }
    private fun loader(scope: CoroutineScope) = SettingsLoader(SpaceApi(server.url("/").toUri(), CookieSource.none), scope)
    private fun settings(model: String, delay: Long = 0) {
        repeat(3) { server.enqueue(MockResponse().setHeadersDelay(delay, TimeUnit.MILLISECONDS)
            .setBody("""{"defaultModel":"$model","options":[],"services":[],"backups":[]}""")) }
    }
    private suspend fun requests(count: Int) = withTimeout(3000) {
        while (server.requestCount < count) delay(5)
    }

    @Test fun forgottenRefreshCannotRestoreSettings() = runBlocking {
        settings("old", 200)
        val loader = loader(this)
        val pending = launch { loader.refresh() }
        requests(3)
        loader.forget()
        pending.join()
        assertNull(loader.settings.value)
        assertFalse(loader.isLoading.value)
    }

    @Test fun oldRefreshCannotClearTheNewRefreshLoadingState() = runBlocking {
        settings("old", 200)
        settings("new", 500)
        val loader = loader(this)
        val old = launch { loader.refresh() }
        requests(3)
        loader.forget()
        val fresh = launch { loader.refresh() }
        requests(6)
        old.join()
        assertNull(loader.settings.value)
        assertTrue(loader.isLoading.value)
        fresh.join()
        assertEquals("new", loader.settings.value?.models?.defaultModel)
        assertFalse(loader.isLoading.value)
    }

    @Test fun oldSaveCannotOverwriteTheNewSessionsSettings() = runBlocking {
        settings("initial")
        val loader = loader(this)
        loader.refresh()
        server.enqueue(MockResponse().setHeadersDelay(300, TimeUnit.MILLISECONDS)
            .setBody("""{"defaultModel":"old","options":[]}"""))
        val save = launch { loader.setDefaultModel("old") }
        requests(4)
        loader.forget()
        settings("new")
        loader.refresh()
        save.join()
        assertEquals("new", loader.settings.value?.models?.defaultModel)
        assertNull(loader.saveError.value)
        assertFalse(loader.isSaving.value)
    }

    @Test fun oldSaveFailureCannotRestoreAnErrorAfterForget() = runBlocking {
        val loader = loader(this)
        server.enqueue(MockResponse().setHeadersDelay(200, TimeUnit.MILLISECONDS)
            .setResponseCode(500).setBody("""{"error":"old failure"}"""))
        val save = launch { loader.setDefaultModel("old") }
        requests(1)
        loader.forget()
        save.join()
        assertNull(loader.saveError.value)
        assertNull(loader.settings.value)
        assertFalse(loader.isSaving.value)
    }
}
