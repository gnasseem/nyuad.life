package app.ror.indexer

import app.ror.Chunk
import app.ror.Chunker
import app.ror.SourcePost
import io.ktor.client.HttpClient
import io.ktor.client.engine.okhttp.OkHttp
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.contentType
import java.io.BufferedOutputStream
import java.nio.file.Files
import java.nio.file.Path
import kotlin.io.path.fileSize
import kotlin.math.sqrt
import kotlin.system.exitProcess
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.io.File
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray

private const val Dimension = 512
private val json = Json { ignoreUnknownKeys = true; prettyPrint = true }

fun main(args: Array<String>) = runBlocking {
    val key = System.getenv("VOYAGE_API_KEY").orEmpty().ifBlank { savedVoyageKey() }
    if (key.isBlank()) {
        System.err.println("Set VOYAGE_API_KEY (or save the key in the app's Keys screen) before running the indexer.")
        exitProcess(1)
    }

    val root = projectRoot()
    val input = root.resolve("data/posts.jsonl")
    val resourceDir = root.resolve("shared/src/commonMain/composeResources/files")
    val chunkFile = resourceDir.resolve("chunks.json")
    val vectorFile = resourceDir.resolve("vectors.bin")
    val fresh = "--fresh" in args
    if (!fresh && completedIndex(chunkFile, vectorFile)) {
        println("Index already exists. Pass --fresh to rebuild it.")
        return@runBlocking
    }
    check(Files.exists(input)) { "Missing ${input.toAbsolutePath()}. Add data/posts.jsonl first." }

    val posts = Files.readAllLines(input).mapIndexedNotNull { index, line ->
        if (line.isBlank()) null else runCatching { json.decodeFromString<SourcePost>(line) }
            .getOrElse { throw IllegalArgumentException("Invalid JSON on data/posts.jsonl line ${index + 1}: ${it.message}") }
    }
    val chunks = Chunker.chunk(posts)
    println("Read ${posts.size} posts and created ${chunks.size} chunks.")

    val vectors = mutableListOf<FloatArray>()
    HttpClient(OkHttp).use { client ->
        chunks.chunked(64).forEach { batch ->
            vectors += embed(client, key, batch.map { it.text })
            println("Embedded ${vectors.size}/${chunks.size} chunks.")
        }
    }

    Files.createDirectories(resourceDir)
    Files.write(chunkFile, json.encodeToString(chunks).toByteArray(Charsets.UTF_8))
    writeVectors(vectorFile, vectors)
    val comments = posts.sumOf { it.comments.size }
    Files.writeString(
        root.resolve("data/index-stats.txt"),
        "posts=${posts.size}\ncomments=$comments\nchunks=${chunks.size}\ndimensions=$Dimension\n",
    )
    println("Wrote ${root.relativize(chunkFile)} and ${root.relativize(vectorFile)}.")
}

private suspend fun embed(client: HttpClient, key: String, texts: List<String>): List<FloatArray> {
    val payload = buildJsonObject {
        putJsonArray("input") { texts.forEach { add(it) } }
        put("model", "voyage-3.5")
        put("input_type", "document")
        put("output_dimension", Dimension)
    }.toString()

    repeat(6) { attempt ->
        val response = client.post("https://api.voyageai.com/v1/embeddings") {
            header(HttpHeaders.Authorization, "Bearer $key")
            contentType(ContentType.Application.Json)
            setBody(payload)
        }
        val body = response.bodyAsText()
        val status = response.status.value
        if (status in 200..299) {
            val rows = runCatching {
                json.parseToJsonElement(body).jsonObject.getValue("data").jsonArray.map { item ->
                    item.jsonObject.getValue("embedding").jsonArray
                        .map { it.jsonPrimitive.content.toFloat() }.toFloatArray()
                }
            }.getOrElse { throw IllegalStateException("Voyage returned an unreadable response: ${snippet(body)}") }
            check(rows.size == texts.size) { "Voyage returned ${rows.size} embeddings for ${texts.size} chunks." }
            rows.forEach { check(it.size == Dimension) { "Voyage returned ${it.size} dimensions; expected $Dimension." } }
            return rows.map(::normalize)
        }
        val retryable = status == 429 || status >= 500
        if (!retryable || attempt == 5) {
            throw IllegalStateException("Voyage embeddings failed with HTTP $status: ${snippet(body)}")
        }
        val wait = 1_000L shl attempt
        println("Voyage returned HTTP $status; retrying in ${wait / 1000}s.")
        delay(wait)
    }
    error("Embedding retry loop ended unexpectedly.")
}

private fun normalize(vector: FloatArray): FloatArray {
    var sum = 0.0
    vector.forEach { sum += it * it }
    val magnitude = sqrt(sum).toFloat()
    check(magnitude > 0f) { "Voyage returned a zero-length embedding." }
    for (index in vector.indices) vector[index] /= magnitude
    return vector
}

private fun writeVectors(path: Path, vectors: List<FloatArray>) {
    BufferedOutputStream(Files.newOutputStream(path)).use { output ->
        vectors.forEach { vector ->
            vector.forEach { value ->
                val bits = value.toRawBits()
                output.write(bits and 0xff)
                output.write((bits ushr 8) and 0xff)
                output.write((bits ushr 16) and 0xff)
                output.write((bits ushr 24) and 0xff)
            }
        }
    }
}

private fun completedIndex(chunks: Path, vectors: Path): Boolean =
    Files.exists(chunks) && Files.readString(chunks).trim() != "[]" &&
        Files.exists(vectors) && vectors.fileSize() > 0

private fun projectRoot(): Path {
    var current = Path.of("").toAbsolutePath().normalize()
    repeat(5) {
        if (Files.exists(current.resolve("settings.gradle.kts"))) return current
        current = current.parent ?: return@repeat
    }
    error("Could not find the ROR project root from ${Path.of("").toAbsolutePath()}.")
}

private fun snippet(body: String): String = body.replace('\n', ' ').trim().take(500)

/** The key the app saved from its Keys screen, so the indexer can run after the user typed it there. */
private fun savedVoyageKey(): String {
    val file = File(System.getProperty("user.home"), ".ror-answers/keys.properties")
    if (!file.exists()) return ""
    return java.util.Properties().apply { file.inputStream().use(::load) }.getProperty("voyage_key").orEmpty()
}
