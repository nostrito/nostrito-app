/**
 * Pure utility for markdown toolbar actions.
 * Takes content + cursor selection, returns new content + cursor position.
 */

export interface InsertResult {
  newContent: string;
  cursorStart: number;
  cursorEnd: number;
}

export type ToolbarAction =
  | "bold" | "italic" | "heading" | "link" | "quote"
  | "code" | "codeblock" | "ul" | "ol" | "hr" | "image";

export function applyToolbarAction(
  content: string,
  selStart: number,
  selEnd: number,
  action: ToolbarAction,
  imageUrl?: string,
): InsertResult {
  const sel = content.slice(selStart, selEnd);
  const hasSel = selStart !== selEnd;

  switch (action) {
    case "bold": {
      const text = hasSel ? sel : "bold text";
      const insert = `**${text}**`;
      return splice(content, selStart, selEnd, insert,
        hasSel ? selStart + insert.length : selStart + 2, hasSel ? selStart + insert.length : selStart + 2 + text.length);
    }
    case "italic": {
      const text = hasSel ? sel : "italic text";
      const insert = `*${text}*`;
      return splice(content, selStart, selEnd, insert,
        hasSel ? selStart + insert.length : selStart + 1, hasSel ? selStart + insert.length : selStart + 1 + text.length);
    }
    case "heading": {
      const lineStart = content.lastIndexOf("\n", selStart - 1) + 1;
      const prefix = "## ";
      const insert = prefix + (hasSel ? sel : "Heading");
      const lineEnd = hasSel ? selEnd : selStart;
      // Replace from line start to selection end
      const before = content.slice(0, lineStart);
      const after = content.slice(lineEnd);
      const nc = before + insert + after;
      return { newContent: nc, cursorStart: lineStart + insert.length, cursorEnd: lineStart + insert.length };
    }
    case "link": {
      const text = hasSel ? sel : "link text";
      const insert = `[${text}](url)`;
      const urlStart = selStart + text.length + 3; // after "[text]("
      return splice(content, selStart, selEnd, insert, urlStart, urlStart + 3);
    }
    case "quote": {
      if (hasSel) {
        const lines = sel.split("\n").map(l => `> ${l}`).join("\n");
        return splice(content, selStart, selEnd, lines, selStart + lines.length, selStart + lines.length);
      }
      const insert = "\n> ";
      return splice(content, selStart, selEnd, insert, selStart + insert.length, selStart + insert.length);
    }
    case "code": {
      const text = hasSel ? sel : "code";
      const insert = `\`${text}\``;
      return splice(content, selStart, selEnd, insert,
        hasSel ? selStart + insert.length : selStart + 1, hasSel ? selStart + insert.length : selStart + 1 + text.length);
    }
    case "codeblock": {
      const text = hasSel ? sel : "";
      const insert = `\n\`\`\`\n${text}\n\`\`\`\n`;
      const cursorPos = selStart + 5; // after opening ``` + newline
      return splice(content, selStart, selEnd, insert,
        hasSel ? selStart + insert.length : cursorPos, hasSel ? selStart + insert.length : cursorPos);
    }
    case "ul": {
      if (hasSel) {
        const lines = sel.split("\n").map(l => `- ${l}`).join("\n");
        return splice(content, selStart, selEnd, lines, selStart + lines.length, selStart + lines.length);
      }
      const insert = "\n- ";
      return splice(content, selStart, selEnd, insert, selStart + insert.length, selStart + insert.length);
    }
    case "ol": {
      if (hasSel) {
        const lines = sel.split("\n").map((l, i) => `${i + 1}. ${l}`).join("\n");
        return splice(content, selStart, selEnd, lines, selStart + lines.length, selStart + lines.length);
      }
      const insert = "\n1. ";
      return splice(content, selStart, selEnd, insert, selStart + insert.length, selStart + insert.length);
    }
    case "hr": {
      const insert = "\n---\n";
      return splice(content, selStart, selStart, insert, selStart + insert.length, selStart + insert.length);
    }
    case "image": {
      const url = imageUrl || "url";
      const alt = hasSel ? sel : "image";
      const insert = `![${alt}](${url})`;
      return splice(content, selStart, selEnd, insert, selStart + insert.length, selStart + insert.length);
    }
    default:
      return { newContent: content, cursorStart: selStart, cursorEnd: selEnd };
  }
}

function splice(
  content: string, start: number, end: number, insert: string,
  cursorStart: number, cursorEnd: number,
): InsertResult {
  return {
    newContent: content.slice(0, start) + insert + content.slice(end),
    cursorStart,
    cursorEnd,
  };
}
