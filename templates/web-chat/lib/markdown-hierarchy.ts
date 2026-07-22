const HEADING_PATTERN = /^(\s{0,3})(#{1,6})(\s+.*)$/;
const FENCE_PATTERN = /^\s{0,3}(`{3,}|~{3,})/;
const LEADING_STRONG_PATTERN = /^\s*(?:\*\*(.+)\*\*|__(.+)__)\s*$/;

interface MarkdownLine {
  headingDepth?: number;
  inFence: boolean;
  value: string;
}

/**
 * Normalizes model-authored Markdown into three document levels:
 * response title, section, and subsection. Fenced code is kept untouched.
 */
export function normalizeMarkdownHierarchy(markdown: string): string {
  const sourceLines = markdown.split("\n");
  let activeFence: string | undefined;

  const lines: MarkdownLine[] = sourceLines.map((value) => {
    const fenceMatch = value.match(FENCE_PATTERN);
    const inFence = activeFence !== undefined;

    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      const markerCharacter = marker[0]!;

      if (activeFence === undefined) {
        activeFence = markerCharacter;
      } else if (activeFence === markerCharacter) {
        activeFence = undefined;
      }

      return { inFence: true, value };
    }

    if (inFence) return { inFence: true, value };

    const headingMatch = value.match(HEADING_PATTERN);
    return {
      headingDepth: headingMatch?.[2]?.length,
      inFence: false,
      value,
    };
  });

  const firstContentIndex = lines.findIndex((line) => line.value.trim().length > 0);
  const firstContent = lines[firstContentIndex];

  if (firstContent && !firstContent.inFence && firstContent.headingDepth === undefined) {
    const strongMatch = firstContent.value.match(LEADING_STRONG_PATTERN);
    const title = strongMatch?.[1] ?? strongMatch?.[2];

    if (title) {
      firstContent.value = `# ${title.trim()}`;
      firstContent.headingDepth = 1;
    }
  }

  const headingDepths = Array.from(
    new Set(
      lines
        .map((line) => line.headingDepth)
        .filter((depth): depth is number => depth !== undefined),
    ),
  ).sort((a, b) => a - b);
  const hasTitle = headingDepths.includes(1);
  const sectionDepths = headingDepths.filter((depth) => depth > 1);
  const sectionDepth = sectionDepths[0];

  return lines
    .map((line) => {
      if (line.inFence || line.headingDepth === undefined) return line.value;

      let normalizedDepth: 1 | 2 | 3;
      if (line.headingDepth === 1) {
        normalizedDepth = 1;
      } else if (line.headingDepth === sectionDepth) {
        normalizedDepth = 2;
      } else {
        normalizedDepth = hasTitle || sectionDepth !== undefined ? 3 : 2;
      }

      return line.value.replace(HEADING_PATTERN, `$1${"#".repeat(normalizedDepth)}$3`);
    })
    .join("\n");
}
