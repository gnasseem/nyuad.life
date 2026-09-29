package app.ror

sealed interface MdBlock {
    data class Paragraph(val text: String) : MdBlock
    data class Heading(val text: String) : MdBlock
    data class Quote(val text: String) : MdBlock
    data class Bullets(val items: List<String>) : MdBlock
    data class Numbered(val items: List<String>, val start: Int) : MdBlock
}

/** Splits model output into blocks: headings, bullet and numbered lists, quotes and paragraphs. */
fun parseMarkdown(text: String): List<MdBlock> {
    val blocks = mutableListOf<MdBlock>()
    val paragraph = mutableListOf<String>()
    fun flush() {
        if (paragraph.isNotEmpty()) blocks += MdBlock.Paragraph(paragraph.joinToString(" "))
        paragraph.clear()
    }
    for (raw in text.replace("\r", "").lines()) {
        val line = raw.trim()
        if (line.isEmpty()) {
            flush()
            continue
        }
        Regex("^#{1,4}\\s+(.*)$").find(line)?.let {
            flush()
            blocks += MdBlock.Heading(it.groupValues[1])
            continue
        }
        if (line.startsWith(">")) {
            flush()
            blocks += MdBlock.Quote(line.removePrefix(">").trim())
            continue
        }
        Regex("^[-*•]\\s+(.*)$").find(line)?.let {
            flush()
            val last = blocks.lastOrNull()
            if (last is MdBlock.Bullets) blocks[blocks.lastIndex] = MdBlock.Bullets(last.items + it.groupValues[1])
            else blocks += MdBlock.Bullets(listOf(it.groupValues[1]))
            continue
        }
        Regex("^(\\d+)[.)]\\s+(.*)$").find(line)?.let {
            flush()
            val last = blocks.lastOrNull()
            if (last is MdBlock.Numbered) blocks[blocks.lastIndex] = MdBlock.Numbered(last.items + it.groupValues[2], last.start)
            else blocks += MdBlock.Numbered(listOf(it.groupValues[2]), it.groupValues[1].toInt())
            continue
        }
        val last = blocks.lastOrNull()
        if (raw.startsWith("  ") && paragraph.isEmpty() && last != null) {
            when (last) {
                is MdBlock.Bullets -> {
                    blocks[blocks.lastIndex] = MdBlock.Bullets(last.items.dropLast(1) + (last.items.last() + " " + line))
                    continue
                }
                is MdBlock.Numbered -> {
                    blocks[blocks.lastIndex] = MdBlock.Numbered(last.items.dropLast(1) + (last.items.last() + " " + line), last.start)
                    continue
                }
                else -> Unit
            }
        }
        paragraph += line
    }
    flush()
    return blocks
}

/** Citation numbers mentioned in a piece of text, in order of appearance. */
fun citationsIn(text: String): List<Int> =
    Regex("\\[(\\d+(?:\\]\\[\\d+)*|\\d+(?:,\\s*\\d+)+)\\]").findAll(text)
        .flatMap { match -> Regex("\\d+").findAll(match.value).map { it.value.toInt() } }
        .toList()
