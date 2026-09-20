package app.ror

import io.ktor.client.HttpClient
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.contentType
import io.ktor.serialization.kotlinx.json.json
import kotlin.math.sqrt
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray

internal val apiJson = Json { ignoreUnknownKeys = true }
internal val apiHttp = HttpClient {
    install(ContentNegotiation) { json(apiJson) }
}

suspend fun embedQuery(key: String, text: String): FloatArray {
    val payload = buildJsonObject {
        putJsonArray("input") { add(text) }
        put("model", "voyage-3.5")
        put("input_type", "query")
        put("output_dimension", 512)
    }
    val response = apiHttp.post("https://api.voyageai.com/v1/embeddings") {
        header(HttpHeaders.Authorization, "Bearer $key")
        contentType(ContentType.Application.Json)
        setBody(payload.toString())
    }
    val body = response.bodyAsText()
    requireSuccess("Voyage embeddings", response.status.value, body)
    val values = runCatching {
        apiJson.parseToJsonElement(body).jsonObject.getValue("data").jsonArray.first().jsonObject
            .getValue("embedding").jsonArray.map { it.jsonPrimitive.content.toFloat() }
    }.getOrElse { throw IllegalStateException("Voyage embeddings returned an unreadable response: ${body.snippet()}") }
    check(values.size == 512) { "Voyage embeddings returned ${values.size} values; expected 512." }
    return normalize(values.toFloatArray())
}

suspend fun rerank(
    key: String,
    query: String,
    docs: List<String>,
    topK: Int,
): List<Pair<Int, Double>> {
    if (docs.isEmpty()) return emptyList()
    val payload = buildJsonObject {
        put("query", query)
        putJsonArray("documents") { docs.forEach { add(it) } }
        put("model", "rerank-2.5")
        put("top_k", topK.coerceAtMost(docs.size))
    }
    val response = apiHttp.post("https://api.voyageai.com/v1/rerank") {
        header(HttpHeaders.Authorization, "Bearer $key")
        contentType(ContentType.Application.Json)
        setBody(payload.toString())
    }
    val body = response.bodyAsText()
    requireSuccess("Voyage rerank", response.status.value, body)
    return runCatching {
        apiJson.parseToJsonElement(body).jsonObject.getValue("data").jsonArray.map { item ->
            val value = item.jsonObject
            value.getValue("index").jsonPrimitive.content.toInt() to
                value.getValue("relevance_score").jsonPrimitive.content.toDouble()
        }
    }.getOrElse { throw IllegalStateException("Voyage rerank returned an unreadable response: ${body.snippet()}") }
}

internal fun normalize(vector: FloatArray): FloatArray {
    var sum = 0.0
    vector.forEach { sum += it * it }
    val magnitude = sqrt(sum).toFloat()
    if (magnitude == 0f) return vector
    for (index in vector.indices) vector[index] /= magnitude
    return vector
}

internal fun requireSuccess(service: String, status: Int, body: String) {
    if (status !in 200..299) {
        throw IllegalStateException("$service failed with HTTP $status: ${body.snippet()}")
    }
}

internal fun String.snippet(): String = replace('\n', ' ').trim().take(500)
