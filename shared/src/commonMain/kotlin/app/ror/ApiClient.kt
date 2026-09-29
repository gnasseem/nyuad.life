package app.ror

import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.request.HttpRequestBuilder
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.parameter
import io.ktor.client.request.preparePost
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsChannel
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.contentType
import io.ktor.http.isSuccess
import io.ktor.serialization.kotlinx.json.json
import io.ktor.utils.io.readLine
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

class ApiException(val status: Int, val code: String, message: String) : Exception(message) {
    val needsAccessCode: Boolean get() = status == 401
    val needsServer: Boolean get() = code == "no_server"
}

class AskHandlers(
    val onStatus: (String) -> Unit = {},
    val onSources: (List<SourceCard>) -> Unit = {},
    val onDelta: (String) -> Unit = {},
    val onFollowups: (List<String>) -> Unit = {},
)

/** Parses server-sent-event lines into (event, data) pairs. Kept separate from the network code so it can be unit tested. */
internal class SseParser(private val onEvent: (event: String, data: String) -> Unit) {
    private var event = "message"
    private val data = StringBuilder()

    fun feed(line: String) {
        when {
            line.startsWith("event:") -> event = line.removePrefix("event:").trim()
            line.startsWith("data:") -> {
                if (data.isNotEmpty()) data.append('\n')
                data.append(line.removePrefix("data:").trim())
            }
            line.isBlank() -> flush()
        }
    }

    fun finish() = flush()

    private fun flush() {
        if (data.isNotEmpty()) onEvent(event, data.toString())
        event = "message"
        data.clear()
    }
}

/** Thin client for the ROR Answers backend. All model calls happen on the server; the app only needs its address. */
object Api {
    val json = Json { ignoreUnknownKeys = true; coerceInputValues = true; encodeDefaults = true }

    private val http = HttpClient {
        install(ContentNegotiation) { json(json) }
        install(HttpTimeout) {
            requestTimeoutMillis = 180_000
            socketTimeoutMillis = 180_000
            connectTimeoutMillis = 15_000
        }
        expectSuccess = false
    }

    private fun base(): String {
        val url = Settings.serverUrl()
        if (url.isBlank()) throw ApiException(0, "no_server", "Add the server address in Settings first.")
        return url
    }

    private fun HttpRequestBuilder.auth() {
        Settings.accessCode().takeIf { it.isNotBlank() }?.let { header("x-ror-code", it) }
    }

    private suspend inline fun <reified T> getJson(path: String, vararg params: Pair<String, String?>): T {
        val response = try {
            http.get("${base()}$path") {
                auth()
                for ((name, value) in params) if (!value.isNullOrBlank()) parameter(name, value)
            }
        } catch (e: ApiException) {
            throw e
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            throw ApiException(0, "network", "Could not reach the server: ${e.message ?: e::class.simpleName}")
        }
        if (!response.status.isSuccess()) throw response.toError()
        return response.body()
    }

    suspend fun health(): Health = getJson("/api/health")

    suspend fun home(): HomePayload = getJson("/api/home")

    suspend fun search(
        query: String = "",
        topic: String = "",
        sort: String = "",
        page: Int = 1,
        pageSize: Int = 20,
        from: String = "",
        to: String = "",
    ): SearchResult = getJson(
        "/api/search",
        "q" to query,
        "topic" to topic,
        "sort" to sort,
        "page" to page.toString(),
        "pageSize" to pageSize.toString(),
        "from" to from,
        "to" to to,
    )

    suspend fun post(id: String): PostResponse = getJson("/api/post", "id" to id)

    suspend fun courses(query: String = ""): CourseList = getJson("/api/courses", "q" to query, "limit" to "400")

    suspend fun course(code: String, page: Int = 1): CoursePosts =
        getJson("/api/courses", "code" to code, "page" to page.toString(), "pageSize" to "30")

    /** Streams an answer; handlers fire on the calling coroutine as events arrive. */
    suspend fun ask(question: String, history: List<ChatTurn>, handlers: AskHandlers) {
        val statement = try {
            http.preparePost("${base()}/api/ask") {
                auth()
                contentType(ContentType.Application.Json)
                setBody(AskBody(question, history, stream = true))
            }
        } catch (e: ApiException) {
            throw e
        }
        try {
            statement.execute { response ->
                if (!response.status.isSuccess()) throw response.toError()
                var failure: ApiException? = null
                val parser = SseParser { event, data -> dispatch(event, data, handlers)?.let { failure = it } }
                val channel = response.bodyAsChannel()
                while (!channel.isClosedForRead) {
                    val line = channel.readLine() ?: break
                    parser.feed(line)
                }
                parser.finish()
                failure?.let { throw it }
            }
        } catch (e: ApiException) {
            throw e
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            throw ApiException(0, "network", "Lost the connection while answering: ${e.message ?: e::class.simpleName}")
        }
    }

    private fun dispatch(event: String, data: String, handlers: AskHandlers): ApiException? {
        val payload = runCatching { json.parseToJsonElement(data).jsonObject }.getOrNull() ?: return null
        when (event) {
            "status" -> handlers.onStatus(payload["message"]?.jsonPrimitive?.content.orEmpty())
            "sources" -> handlers.onSources(payload["sources"]?.let { json.decodeFromJsonElement<List<SourceCard>>(it) } ?: emptyList())
            "delta" -> handlers.onDelta(payload["text"]?.jsonPrimitive?.content.orEmpty())
            "followups" -> handlers.onFollowups(payload["questions"]?.jsonArray?.map { it.jsonPrimitive.content } ?: emptyList())
            "error" -> return ApiException(500, "stream_error", payload["message"]?.jsonPrimitive?.content ?: "The answer failed.")
        }
        return null
    }

    private suspend fun HttpResponse.toError(): ApiException {
        val text = runCatching { bodyAsText() }.getOrDefault("")
        val parsed = runCatching { json.decodeFromString<ApiErrorBody>(text) }.getOrNull()
        val fallback = when (status.value) {
            401 -> "This archive needs an access code. Add it in Settings."
            404 -> "Not found."
            429 -> "Too many requests. Give it a minute."
            else -> "The server answered ${status.value}."
        }
        return ApiException(status.value, parsed?.error?.ifBlank { null } ?: "http_${status.value}", parsed?.message?.ifBlank { null } ?: fallback)
    }
}
