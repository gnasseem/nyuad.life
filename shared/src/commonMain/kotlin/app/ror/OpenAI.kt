package app.ror

import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.contentType
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray

private const val SystemPrompt = "You are ROR Answers, an assistant for NYU Abu Dhabi students. You answer ONLY from the Room of Requirement posts and comments provided. Each source is numbered [n] and carries its author and date. Give a direct answer first (one or two sentences), then a short analysis: count how many distinct people expressed positive, neutral and negative views (e.g. '10 of 15 students said it was great, 3 neutral, 2 disliked it') and name the most common praise and complaints; when the question compares options (professors, courses, programs), rank them with the counts behind each. Prefer recent posts when opinions changed over time and say so. Quote short phrases from sources with [n] citations after every claim. If the sources do not cover the question, say so plainly instead of guessing. Never invent people, numbers or posts. Keep it under 250 words unless the question needs a ranked list."

suspend fun answer(key: String, model: String, question: String, chunks: List<Chunk>): String {
    val sources = chunks.mapIndexed { index, chunk ->
        "[${index + 1}] ${chunk.author}, ${chunk.date}, ${chunk.url}\n${chunk.text}"
    }.joinToString("\n\n")
    val payload = buildJsonObject {
        put("model", model)
        put("temperature", 0.2)
        putJsonArray("messages") {
            addJsonObject {
                put("role", "system")
                put("content", SystemPrompt)
            }
            addJsonObject {
                put("role", "user")
                put("content", "$question\n\nSources:\n$sources")
            }
        }
    }
    val response = apiHttp.post("https://api.openai.com/v1/chat/completions") {
        header(HttpHeaders.Authorization, "Bearer $key")
        contentType(ContentType.Application.Json)
        setBody(payload.toString())
    }
    val body = response.bodyAsText()
    requireSuccess("OpenAI", response.status.value, body)
    return runCatching {
        apiJson.parseToJsonElement(body).jsonObject.getValue("choices").jsonArray.first().jsonObject
            .getValue("message").jsonObject.getValue("content").jsonPrimitive.content.trim()
    }.getOrElse { throw IllegalStateException("OpenAI returned an unreadable response: ${body.snippet()}") }
}
