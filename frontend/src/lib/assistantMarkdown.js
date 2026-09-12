/* AI 回覆是外部、不可信輸入：先解析 Markdown，再以嚴格白名單消毒 HTML。
   這個函式只能用在 assistant 訊息；使用者訊息仍由 Vue {{ }} 自動轉義。 */
import DOMPurify from "dompurify";
import { marked } from "marked";

const ALLOWED_TAGS = [
  "p", "br", "strong", "em", "blockquote",
  "ul", "ol", "li",
  "code", "pre",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "table", "thead", "tbody", "tr", "th", "td",
  "a",
];

export function renderAssistantMarkdown(rawMarkdown) {
  if (typeof rawMarkdown !== "string" || !rawMarkdown.trim()) return "";

  /* 模型常用 20~29、2000~2024 表示數字範圍。Marked 的 GFM 規則會把兩個
     單一 ~ 配成刪除線，因此先轉成中文範圍符號，避免數字被黏成 2029。 */
  const normalizedMarkdown = rawMarkdown.replace(/(\d)~(?=\d)/g, "$1～");

  const parsedHtml = marked.parse(normalizedMarkdown, {
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
      /* 青年年齡與年度常使用 20~29、2000~2024；GFM 可能把兩個單一 ~
         之間的內容誤判為刪除線。聊天回覆也不需要水平分隔線，因此兩者都禁用。 */
      "del", "hr",
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
