package app.ror.server

import app.ror.Chunk
import app.ror.Index
import app.ror.ask
import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import java.net.InetSocketAddress
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

// Same pipeline as the app, served on localhost with a one-page web UI.
// Keys come from ~/.ror-answers/keys.properties, the file the desktop app writes.

@Serializable
private data class Reply(val text: String = "", val sources: List<Chunk> = emptyList(), val error: String = "")

private val json = Json { encodeDefaults = true }

fun main(args: Array<String>) {
    val port = args.firstOrNull()?.toIntOrNull() ?: 8080
    runBlocking { Index.load() }
    val page = object {}.javaClass.getResource("/index.html")!!.readText()
    val server = HttpServer.create(InetSocketAddress("127.0.0.1", port), 0)
    server.createContext("/") { ex -> ex.send(200, "text/html; charset=utf-8", page) }
    server.createContext("/ask") { ex ->
        val question = ex.requestBody.readBytes().decodeToString().trim()
        val reply = runCatching { runBlocking { ask(question) { println("  $it") } } }
            .fold({ Reply(it.text, it.sources) }, { Reply(error = it.message ?: it.toString()) })
        ex.send(200, "application/json; charset=utf-8", json.encodeToString(reply))
    }
    server.start()
    println("ROR Answers on http://localhost:$port with ${Index.size} chunks")
}

private fun HttpExchange.send(status: Int, type: String, body: String) {
    val bytes = body.toByteArray()
    responseHeaders.add("Content-Type", type)
    sendResponseHeaders(status, bytes.size.toLong())
    responseBody.use { it.write(bytes) }
}
