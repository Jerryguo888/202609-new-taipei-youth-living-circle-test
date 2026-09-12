/* AI 回覆是外部、不可信輸入：先解析 Markdown，再以嚴格白名單消毒 HTML。
   這個函式只能用在 assistant 訊息；使用者訊息仍由 Vue {{ }} 自動轉義。 */
import DOMPurify from "dompurify";
import { marked } from "marked";

const ALLOWED_TAGS = [
  "p", "br", "strong", "em", "del", "blockquote",
  "ul", "ol", "li",
  "code", "pre",
  "h1", "h2", "h3", "h4", "h5", "h6", "hr",
  "table", "thead", "tbody", "tr", "th", "td",
  "a",
];

export function renderAssistantMarkdown(rawMarkdown) {
  if (typeof rawMarkdown !== "string" || !rawMarkdown.trim()) return "";

  const parsedHtml = marked.parse(rawMarkdown, {
    async: false,
    breaks: true,
    gfm: true,
  });

  return DOMPurify.sanitize(String(parsedHtml), {
    ALLOWED_TAGS: ALLOWED_TAGS,
    ALLOWED_ATTR: ["href", "title"],
    FORBID_TAGS: [
      "script", "style", "iframe", "object", "embed", "link", "meta", "base",
      "img", "picture", "video", "audio", "source", "track",
      "svg", "math", "form", "input", "button", "textarea", "select", "option",
    ],
    FORBID_ATTR: [
      "style", "class", "id", "name", "target", "src", "srcset", "xlink:href",
      "formaction", "background",
    ],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    ALLOW_UNKNOWN_PROTOCOLS: false,
    SANITIZE_DOM: true,
    SANITIZE_NAMED_PROPS: true,
    KEEP_CONTENT: true,
    RETURN_TRUSTED_TYPE: false,
  });
}
