/**
 * Lightweight markdown renderer for NIP-23 long-form content.
 * No external dependencies — handles the subset of markdown commonly used in Nostr articles.
 */

import { decodeEntity, normalizeBareEntities } from "./mentions";

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Render inline markdown: bold, italic, code, links, images */
function renderInline(text: string): string {
  let result = escapeHtml(normalizeBareEntities(text));

  // Inline code (must come before bold/italic to avoid conflicts)
  result = result.replace(/`([^`]+)`/g, '<code class="md-inline-code">$1</code>');

  // Images: ![alt](url)
  result = result.replace(
    /!\[([^\]]*)\]\(([^)]+)\)/g,
    '<img class="md-img" src="$2" alt="$1" loading="lazy" />'
  );

  // Links: [text](url)
  result = result.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    '<a class="md-link" href="$2" target="_blank" rel="noopener">$1</a>'
  );

  // Bold + italic: ***text*** or ___text___
  result = result.replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>");
  result = result.replace(/___(.+?)___/g, "<strong><em>$1</em></strong>");

  // Bold: **text** or __text__
  result = result.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  result = result.replace(/__(.+?)__/g, "<strong>$1</strong>");

  // Italic: *text* or _text_
  result = result.replace(/\*(.+?)\*/g, "<em>$1</em>");
  result = result.replace(/(?<!\w)_(.+?)_(?!\w)/g, "<em>$1</em>");

  // Strikethrough: ~~text~~
  result = result.replace(/~~(.+?)~~/g, "<del>$1</del>");

  // Auto-link bare URLs that aren't already inside an href
  result = result.replace(
    /(?<!href="|src=")(https?:\/\/[^\s<>"]+)/g,
    '<a class="md-link" href="$1" target="_blank" rel="noopener">$1</a>'
  );

  // Highlight hashtags (require letter after #, preceded by whitespace or tag-end)
  result = result.replace(
    /(^|[\s>])#([a-zA-Z]\w{0,49})\b/gm,
    '$1<span class="hashtag" data-hashtag="$2" style="cursor:pointer">#$2</span>'
  );

  // Nostr entity links (npub, note, nevent, naddr, nprofile)
  result = result.replace(/nostr:((npub|nprofile|note|nevent|naddr)1[a-z0-9]+)/g, (_match, bech32str) => {
    const entity = decodeEntity(bech32str);
    if (!entity) return bech32str;
    const linkIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="12" height="12" style="vertical-align:middle;margin-right:2px"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`;
    switch (entity.type) {
      case "npub":
      case "nprofile":
        return `<span class="mention" data-pubkey="${entity.pubkey}" style="cursor:pointer;color:var(--accent)">@${bech32str.slice(0, 12)}...</span>`;
      case "note":
      case "nevent":
        return `<span class="mention note-link" data-note-id="${entity.eventId}" style="cursor:pointer;color:var(--accent)">${linkIcon}${bech32str.slice(0, 16)}...</span>`;
      case "naddr": {
        const data = JSON.stringify({ kind: entity.kind, pubkey: entity.pubkey, dTag: entity.dTag, relays: entity.relays });
        const label = entity.dTag || bech32str.slice(0, 16) + "...";
        return `<span class="mention note-link" data-naddr='${data.replace(/&/g, "&amp;").replace(/'/g, "&#39;")}' style="cursor:pointer;color:var(--accent)">${linkIcon}${label.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</span>`;
      }
      default:
        return bech32str;
    }
  });

  return result;
}

/** Render a full markdown string to HTML */
export function renderMarkdown(markdown: string): string {
  const lines = markdown.split("\n");
  const html: string[] = [];
  let inCodeBlock = false;
  let codeBlockLang = "";
  let codeLines: string[] = [];
  let inList = false;
  let listType: "ul" | "ol" = "ul";
  let inBlockquote = false;
  let blockquoteLines: string[] = [];

  function flushList() {
    if (inList) {
      html.push(`</${listType}>`);
      inList = false;
    }
  }

  function flushBlockquote() {
    if (inBlockquote) {
      html.push(`<blockquote class="md-blockquote">${blockquoteLines.map(renderInline).join("<br>")}</blockquote>`);
      blockquoteLines = [];
      inBlockquote = false;
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Fenced code blocks
    if (line.startsWith("```")) {
      if (!inCodeBlock) {
        flushList();
        flushBlockquote();
        inCodeBlock = true;
        codeBlockLang = line.slice(3).trim();
        codeLines = [];
      } else {
        const langClass = codeBlockLang ? ` data-lang="${escapeHtml(codeBlockLang)}"` : "";
        html.push(`<pre class="md-code-block"${langClass}><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
        inCodeBlock = false;
        codeBlockLang = "";
      }
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }

    // Empty line
    if (line.trim() === "") {
      flushList();
      flushBlockquote();
      continue;
    }

    // Blockquotes
    if (line.startsWith("> ")) {
      flushList();
      inBlockquote = true;
      blockquoteLines.push(line.slice(2));
      continue;
    } else {
      flushBlockquote();
    }

    // Headings
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      flushList();
      const level = headingMatch[1].length;
      html.push(`<h${level} class="md-h${level}">${renderInline(headingMatch[2])}</h${level}>`);
      continue;
    }

    // Horizontal rule
    if (/^(\*{3,}|-{3,}|_{3,})\s*$/.test(line.trim())) {
      flushList();
      html.push('<hr class="md-hr">');
      continue;
    }

    // Unordered list
    const ulMatch = line.match(/^(\s*)[*+-]\s+(.+)$/);
    if (ulMatch) {
      if (!inList || listType !== "ul") {
        flushList();
        html.push('<ul class="md-list">');
        inList = true;
        listType = "ul";
      }
      html.push(`<li>${renderInline(ulMatch[2])}</li>`);
      continue;
    }

    // Ordered list
    const olMatch = line.match(/^(\s*)\d+\.\s+(.+)$/);
    if (olMatch) {
      if (!inList || listType !== "ol") {
        flushList();
        html.push('<ol class="md-list">');
        inList = true;
        listType = "ol";
      }
      html.push(`<li>${renderInline(olMatch[2])}</li>`);
      continue;
    }

    // Regular paragraph
    flushList();
    html.push(`<p class="md-p">${renderInline(line)}</p>`);
  }

  // Flush remaining state
  if (inCodeBlock) {
    html.push(`<pre class="md-code-block"><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
  }
  flushList();
  flushBlockquote();

  return html.join("\n");
}
