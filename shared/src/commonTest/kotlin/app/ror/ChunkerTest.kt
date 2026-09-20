package app.ror

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ChunkerTest {
    @Test
    fun rendersShortPostAndComments() {
        val chunks = Chunker.chunk(
            SourcePost(
                id = "42",
                url = "https://example.com/42",
                author = "Maya",
                date = "2024-11-02",
                text = "Is this course worth taking?",
                comments = listOf(SourceComment(author = "Omar", text = "Yes, the lectures are clear.")),
            ),
        )

        assertEquals(1, chunks.size)
        assertEquals("42#1", chunks.single().id)
        assertTrue(chunks.single().text.startsWith("Post by Maya on 2024-11-02. 1 comments."))
        assertTrue(chunks.single().text.contains("Comment by Omar: Yes, the lectures are clear."))
    }

    @Test
    fun longPostsCarryContextInEveryChunk() {
        val body = List(45) { "Sentence $it explains a different part of the course experience." }.joinToString(" ")
        val chunks = Chunker.chunk(
            SourcePost(
                id = "long",
                author = "Student",
                date = "2025-01-10",
                text = body,
                comments = List(8) { SourceComment(author = "Person $it", text = body.take(260)) },
            ),
        )

        assertTrue(chunks.size > 2)
        chunks.forEachIndexed { index, chunk ->
            assertEquals("long#${index + 1}", chunk.id)
            assertTrue(chunk.text.startsWith("Post by Student on 2025-01-10. 8 comments.\n${body.take(200)}"))
            assertTrue(chunk.text.length <= 1250)
        }
    }

    @Test
    fun skipsPostsWithoutBodyOrComments() {
        assertTrue(Chunker.chunk(SourcePost(id = "empty", text = "   ")).isEmpty())
    }
}
