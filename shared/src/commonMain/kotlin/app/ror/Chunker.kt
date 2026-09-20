package app.ror

import kotlinx.serialization.Serializable

@Serializable
data class SourceComment(
    val author: String = "",
    val date: String = "",
    val text: String = "",
)

@Serializable
data class SourcePost(
    val id: String = "",
    val url: String = "",
    val author: String = "",
    val date: String = "",
    val text: String = "",
    val comments: List<SourceComment> = emptyList(),
)

@Serializable
data class Chunk(
    val id: String,
    val postId: String,
    val url: String,
    val author: String,
    val date: String,
    val text: String,
    val postPreview: String,
)

object Chunker {
    fun chunk(posts: List<SourcePost>): List<Chunk> = buildList {
        posts.forEachIndexed { index, post ->
            addAll(chunk(post, "post-${index + 1}"))
        }
    }

    fun chunk(post: SourcePost, fallbackId: String = "post"): List<Chunk> {
        val body = clean(post.text)
        val comments = post.comments.mapNotNull { comment ->
            clean(comment.text).takeIf { it.isNotEmpty() }?.let { text ->
                "Comment by ${display(comment.author)}: $text"
            }
        }
        if (body.isEmpty() && comments.isEmpty()) return emptyList()

        val postId = post.id.trim().ifEmpty { fallbackId }
        val author = display(post.author)
        val date = post.date.trim().ifEmpty { "unknown date" }
        val header = "Post by $author on $date. ${post.comments.size} comments."
        val rendered = listOf(header, body).plus(comments).filter { it.isNotEmpty() }.joinToString("\n")
        val preview = body.take(160)

        if (rendered.length <= 1500) {
            return listOf(record(post, postId, author, date, rendered, preview, 1))
        }

        val context = listOf(header, body.take(200)).filter { it.isNotEmpty() }.joinToString("\n")
        val payloadLimit = (1200 - context.length - 1).coerceAtLeast(300)
        val parts = buildList {
            addAll(splitAtSentences(body, payloadLimit))
            comments.forEach { addAll(splitAtSentences(it, payloadLimit)) }
        }
        val payloads = pack(parts, payloadLimit)
        return payloads.mapIndexed { index, payload ->
            record(post, postId, author, date, "$context\n$payload", preview, index + 1)
        }
    }

    private fun record(
        post: SourcePost,
        postId: String,
        author: String,
        date: String,
        text: String,
        preview: String,
        number: Int,
    ) = Chunk(
        id = "$postId#$number",
        postId = postId,
        url = post.url.trim(),
        author = author,
        date = date,
        text = text,
        postPreview = preview,
    )

    private fun splitAtSentences(text: String, limit: Int): List<String> {
        if (text.isEmpty()) return emptyList()
        val sentences = text.split(Regex("(?<=[.!?])\\s+")).filter { it.isNotBlank() }
        return sentences.flatMap { hardSplit(it.trim(), limit) }
    }

    private fun hardSplit(text: String, limit: Int): List<String> {
        if (text.length <= limit) return listOf(text)
        val result = mutableListOf<String>()
        var rest = text
        while (rest.length > limit) {
            val breakAt = rest.lastIndexOf(' ', limit).takeIf { it > limit / 2 } ?: limit
            result += rest.take(breakAt).trim()
            rest = rest.drop(breakAt).trimStart()
        }
        if (rest.isNotEmpty()) result += rest
        return result
    }

    private fun pack(parts: List<String>, limit: Int): List<String> {
        val result = mutableListOf<String>()
        val current = StringBuilder()
        for (part in parts) {
            val separator = if (current.isEmpty()) 0 else 1
            if (current.isNotEmpty() && current.length + separator + part.length > limit) {
                result += current.toString()
                current.clear()
            }
            if (current.isNotEmpty()) current.append('\n')
            current.append(part)
        }
        if (current.isNotEmpty()) result += current.toString()
        return result
    }

    private fun clean(text: String): String = text.trim().replace(Regex("\\s+"), " ")

    private fun display(value: String): String = value.trim().ifEmpty { "Unknown" }
}
