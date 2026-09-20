package app.ror

data class Answer(
    val text: String,
    val sources: List<Chunk>,
)

suspend fun ask(
    question: String,
    onProgress: (String) -> Unit = {},
): Answer {
    val voyageKey = KeyStore.get("voyage_key").orEmpty()
    val openAiKey = KeyStore.get("openai_key").orEmpty()
    val model = KeyStore.get("openai_model").orEmpty().ifBlank { "gpt-4.1" }
    check(voyageKey.isNotBlank()) { "Voyage AI API key is missing. Open Keys and add it." }
    check(openAiKey.isNotBlank()) { "OpenAI API key is missing. Open Keys and add it." }

    Index.load()
    check(Index.size > 0) { "Index is empty. Run the indexer." }

    onProgress("Embedding…")
    val queryVector = embedQuery(voyageKey, question)
    onProgress("Searching ${formatCount(Index.size)} chunks…")
    val candidates = Index.hybrid(queryVector, question, 60)
    val distinctPosts = buildList {
        val seen = mutableSetOf<String>()
        for ((chunk, score) in candidates) {
            if (seen.add(chunk.postId)) add(chunk to score)
        }
    }

    onProgress("Reranking ${distinctPosts.size} hits…")
    val ranked = rerank(
        key = voyageKey,
        query = question,
        docs = distinctPosts.map { it.first.text },
        topK = distinctPosts.size.coerceAtMost(60),
    ).mapNotNull { (index, score) -> distinctPosts.getOrNull(index)?.first?.let { Triple(it, index, score) } }
    val relevant = ranked.filter { it.third >= 0.2 }.take(20)
    val selected = (if (relevant.size >= 5) relevant else ranked.take(5)).map { it.first }
    check(selected.isNotEmpty()) { "No relevant posts were found for that question." }

    onProgress("Writing the answer…")
    return Answer(answer(openAiKey, model, question, selected), selected)
}

private fun formatCount(value: Int): String {
    val text = value.toString()
    return text.reversed().chunked(3).joinToString(",").reversed()
}
