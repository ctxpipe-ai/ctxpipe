import { ConfluencePage } from "./client.js"

interface ConversionResult {
  markdown: string
  frontmatter: Record<string, string>
}

export class ConfluenceToMarkdownConverter {
  convert(page: ConfluencePage): ConversionResult {
    const html = page.body.storage.value
    const markdown = this.htmlToMarkdown(html)

    return {
      markdown,
      frontmatter: {
        title: page.title,
        confluence_id: page.id,
        confluence_space: page.spaceId,
        version: page.version.number.toString(),
        last_modified: page.version.createdAt,
      },
    }
  }

  private htmlToMarkdown(html: string): string {
    let md = html

    md = md.replace(/\n\s*/g, " ")

    md = md.replace(
      /\u003ch1[^\u003e]*\u003e(.*?)\u003c\/h1\u003e/gi,
      "# $1\n\n",
    )
    md = md.replace(
      /\u003ch2[^\u003e]*\u003e(.*?)\u003c\/h2\u003e/gi,
      "## $1\n\n",
    )
    md = md.replace(
      /\u003ch3[^\u003e]*\u003e(.*?)\u003c\/h3\u003e/gi,
      "### $1\n\n",
    )
    md = md.replace(
      /\u003ch4[^\u003e]*\u003e(.*?)\u003c\/h4\u003e/gi,
      "#### $1\n\n",
    )
    md = md.replace(
      /\u003ch5[^\u003e]*\u003e(.*?)\u003c\/h5\u003e/gi,
      "##### $1\n\n",
    )
    md = md.replace(
      /\u003ch6[^\u003e]*\u003e(.*?)\u003c\/h6\u003e/gi,
      "###### $1\n\n",
    )

    md = md.replace(/\u003cp\u003e(.*?)\u003c\/p\u003e/gi, "$1\n\n")

    md = md.replace(/\u003cstrong\u003e(.*?)\u003c\/strong\u003e/gi, "**$1**")
    md = md.replace(/\u003cb\u003e(.*?)\u003c\/b\u003e/gi, "**$1**")

    md = md.replace(/\u003cem\u003e(.*?)\u003c\/em\u003e/gi, "_$1_")
    md = md.replace(/\u003ci\u003e(.*?)\u003c\/i\u003e/gi, "_$1_")

    md = md.replace(/\u003ccode\u003e(.*?)\u003c\/code\u003e/gi, "`$1`")

    md = md.replace(
      /\u003cpre\u003e\u003ccode\u003e([\s\S]*?)\u003c\/code\u003e\u003c\/pre\u003e/gi,
      "```\n$1\n```\n\n",
    )

    md = md.replace(
      /\u003ca\s+href="([^"]+)"[^\u003e]*\u003e(.*?)\u003c\/a\u003e/gi,
      "[$2]($1)",
    )

    md = md.replace(
      /\u003cul\u003e([\s\S]*?)\u003c\/ul\u003e/gi,
      (match, content) => {
        const items = content.replace(
          /\u003cli\u003e(.*?)\u003c\/li\u003e/gi,
          "- $1\n",
        )
        return items + "\n"
      },
    )

    md = md.replace(
      /\u003col\u003e([\s\S]*?)\u003c\/ol\u003e/gi,
      (match, content) => {
        let index = 1
        const items = content.replace(
          /\u003cli\u003e(.*?)\u003c\/li\u003e/gi,
          () => {
            const result = `${index}. $1\n`
            index++
            return result
          },
        )
        return items + "\n"
      },
    )

    md = md.replace(/\u003cbr\s*\/?\u003e/gi, "\n")
    md = md.replace(/\u003chr\s*\/?\u003e/gi, "---\n\n")

    md = md.replace(
      /\u003ctable[^\u003e]*\u003e([\s\S]*?)\u003c\/table\u003e/gi,
      (match) => {
        return this.convertTable(match)
      },
    )

    md = md.replace(/\u003c[^\u003e]+\u003e/g, "")

    md = md.replace(/&lt;/g, "<")
    md = md.replace(/&gt;/g, ">")
    md = md.replace(/&amp;/g, "&")
    md = md.replace(/&quot;/g, '"')
    md = md.replace(/&#39;/g, "'")
    md = md.replace(/&nbsp;/g, " ")

    md = md.replace(/\n{3,}/g, "\n\n")
    md = md.trim()

    return md
  }

  private convertTable(tableHtml: string): string {
    const rows: string[][] = []

    const trMatches =
      tableHtml.match(/\u003ctr[^\u003e]*\u003e([\s\S]*?)\u003c\/tr\u003e/gi) ||
      []

    for (const tr of trMatches) {
      const cells: string[] = []
      const cellMatches =
        tr.match(
          /\u003c(?:td|th)[^\u003e]*\u003e([\s\S]*?)\u003c\/(?:td|th)\u003e/gi,
        ) || []

      for (const cell of cellMatches) {
        const content = cell.replace(/\u003c[^\u003e]+\u003e/g, "").trim()
        cells.push(content)
      }

      if (cells.length > 0) {
        rows.push(cells)
      }
    }

    if (rows.length === 0) {
      return ""
    }

    let markdown = ""

    const headers = rows[0]
    markdown += "| " + headers.join(" | ") + " |\n"
    markdown += "| " + headers.map(() => "---").join(" | ") + " |\n"

    for (let i = 1; i < rows.length; i++) {
      markdown += "| " + rows[i].join(" | ") + " |\n"
    }

    return markdown + "\n"
  }

  generateFilePath(page: ConfluencePage, spaceKey: string): string {
    const slug = page.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .substring(0, 100)

    return `confluence/${spaceKey}/${slug}.md`
  }

  formatWithFrontmatter(result: ConversionResult): string {
    const frontmatter = Object.entries(result.frontmatter)
      .map(([key, value]) => `${key}: "${value.replace(/"/g, '\\"')}"`)
      .join("\n")

    return `---\n${frontmatter}\n---\n\n${result.markdown}`
  }
}
