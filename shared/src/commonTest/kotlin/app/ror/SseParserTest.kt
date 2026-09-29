package app.ror

import kotlin.test.Test
import kotlin.test.assertEquals

class SseParserTest {
    @Test
    fun parsesEventsAndMultiLineData() {
        val events = mutableListOf<Pair<String, String>>()
        val parser = SseParser { event, data -> events += event to data }
        listOf(
            "event: status",
            "data: {\"message\":\"Searching\"}",
            "",
            "event: delta",
            "data: {\"text\":\"a\"}",
            "data: {\"text\":\"b\"}",
            "",
            ": comment line",
            "data: tail",
        ).forEach(parser::feed)
        parser.finish()
        assertEquals(
            listOf(
                "status" to "{\"message\":\"Searching\"}",
                "delta" to "{\"text\":\"a\"}\n{\"text\":\"b\"}",
                "message" to "tail",
            ),
            events,
        )
    }
}
