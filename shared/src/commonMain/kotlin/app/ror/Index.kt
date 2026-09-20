package app.ror

import app.ror.generated.resources.Res
import kotlin.math.ln
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json

object Index {
    private const val Dimension = 512
    private val lock = Mutex()
    private var loaded = false
    private var chunks: List<Chunk> = emptyList()
    private var vectors = FloatArray(0)

    val size: Int get() = chunks.size

    suspend fun load() {
        if (loaded) return
        lock.withLock {
            if (loaded) return
            val loadedData = withContext(Dispatchers.Default) {
                val chunkBytes = Res.readBytes("files/chunks.json")
                val vectorBytes = Res.readBytes("files/vectors.bin")
                val parsed = Json { ignoreUnknownKeys = true }.decodeFromString<List<Chunk>>(chunkBytes.decodeToString())
                val expected = parsed.size * Dimension * 4
                check(vectorBytes.size == expected) {
                    "Index files do not match: ${parsed.size} chunks need $expected vector bytes, found ${vectorBytes.size}. Run the indexer again."
                }
                parsed to decodeFloats(vectorBytes)
            }
            chunks = loadedData.first
            vectors = loadedData.second
            loaded = true
        }
    }

    fun search(queryVec: FloatArray, k: Int): List<Pair<Chunk, Float>> {
        if (chunks.isEmpty() || k <= 0) return emptyList()
        require(queryVec.size == Dimension) { "Query embedding must have $Dimension values." }
        return chunks.indices.map { row ->
            var score = 0f
            val offset = row * Dimension
            for (column in 0 until Dimension) score += queryVec[column] * vectors[offset + column]
            chunks[row] to score
        }.sortedByDescending { it.second }.take(k)
    }

    fun keyword(query: String, k: Int): List<Pair<Chunk, Float>> {
        if (chunks.isEmpty() || k <= 0) return emptyList()
        val terms = tokenize(query).distinct()
        if (terms.isEmpty()) return emptyList()
        val documentTokens = chunks.map { tokenize(it.text) }
        val frequencies = documentTokens.map { tokens -> tokens.groupingBy { it }.eachCount() }
        val documentFrequency = terms.associateWith { term -> frequencies.count { term in it } }
        return chunks.indices.mapNotNull { index ->
            var score = 0.0
            for (term in terms) {
                val tf = frequencies[index][term] ?: continue
                val df = documentFrequency.getValue(term)
                if (df > 0) score += tf * ln(chunks.size.toDouble() / df)
            }
            if (score > 0.0) chunks[index] to score.toFloat() else null
        }.sortedByDescending { it.second }.take(k)
    }

    fun hybrid(queryVec: FloatArray, query: String, k: Int): List<Pair<Chunk, Float>> {
        val scores = mutableMapOf<String, Pair<Chunk, Float>>()
        fun add(results: List<Pair<Chunk, Float>>) {
            results.forEachIndexed { index, (chunk, _) ->
                val rankScore = 1f / (60 + index + 1)
                val old = scores[chunk.id]?.second ?: 0f
                scores[chunk.id] = chunk to old + rankScore
            }
        }
        add(search(queryVec, k))
        add(keyword(query, k))
        return scores.values.sortedByDescending { it.second }.take(k)
    }

    private fun tokenize(text: String): List<String> = text.lowercase()
        .split(Regex("[^\\p{L}]+"))
        .filter { it.isNotEmpty() }

    private fun decodeFloats(bytes: ByteArray): FloatArray {
        val result = FloatArray(bytes.size / 4)
        for (index in result.indices) {
            val offset = index * 4
            val bits = (bytes[offset].toInt() and 0xff) or
                ((bytes[offset + 1].toInt() and 0xff) shl 8) or
                ((bytes[offset + 2].toInt() and 0xff) shl 16) or
                ((bytes[offset + 3].toInt() and 0xff) shl 24)
            result[index] = Float.fromBits(bits)
        }
        return result
    }
}
