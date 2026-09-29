package app.ror

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class MarkdownTest {
    @Test
    fun splitsBlocks() {
        val blocks = parseMarkdown(
            """
            **Dania** is the favourite [1][2].

            - 3 of 4 recommend her [1]
            - grading is fair [2]
              and the curve is generous
            1. First
            2. Second
            > quoted
            ## Heading
            """.trimIndent(),
        )
        assertEquals(MdBlock.Paragraph("**Dania** is the favourite [1][2]."), blocks[0])
        assertEquals(MdBlock.Bullets(listOf("3 of 4 recommend her [1]", "grading is fair [2] and the curve is generous")), blocks[1])
        assertEquals(MdBlock.Numbered(listOf("First", "Second"), 1), blocks[2])
        assertEquals(MdBlock.Quote("quoted"), blocks[3])
        assertEquals(MdBlock.Heading("Heading"), blocks[4])
    }

    @Test
    fun findsCitations() {
        assertEquals(listOf(1, 2, 5, 7, 8), citationsIn("claim [1][2] and [5] then [7, 8]"))
        assertTrue(citationsIn("no citations here").isEmpty())
    }
}
