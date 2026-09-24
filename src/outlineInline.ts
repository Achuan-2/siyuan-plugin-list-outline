const INLINE_TAGS = new Set(["SPAN", "STRONG", "B", "EM", "I", "S", "DEL", "U", "CODE", "KBD", "MARK", "SUP", "SUB", "IMG", "BR"]);
const INLINE_ATTRIBUTES = new Set(["data-type", "data-subtype", "data-content", "alt", "title"]);
const INLINE_STYLES = ["color", "background-color", "font-weight", "font-style", "font-family",
    "text-decoration", "text-decoration-color", "border-bottom", "vertical-align"];

/** 保留原生大纲的行内展示，不携带编辑器操作、链接跳转和可执行属性。 */
export function parseOutlineInlineHTML(html: string): { text: string; html?: string } {
    const parsed = new DOMParser().parseFromString(html, "text/html");
    return extractOutlineInlineContent(parsed.body);
}

/** 从正文或页签标题提取展示副本，不改动编辑器中的原始节点。 */
export function extractOutlineInlineContent(content: HTMLElement): { text: string; html?: string } {
    const body = content.cloneNode(true) as HTMLElement;
    body.querySelectorAll("script, style, iframe, object, embed, svg, math, template, input, button, .protyle-action, .protyle-action__title, .protyle-attr, .img__net")
        .forEach(element => element.remove());
    for (const element of Array.from(body.querySelectorAll<HTMLElement>("*"))) {
        if (!INLINE_TAGS.has(element.tagName)) {
            element.replaceWith(...element.childNodes);
            continue;
        }
        if (element.tagName === "IMG" && element.dataset.src) element.setAttribute("src", element.dataset.src);
        const styles = INLINE_STYLES.map(property => [property, element.style.getPropertyValue(property)]);
        for (const attribute of Array.from(element.attributes)) {
            if (INLINE_ATTRIBUTES.has(attribute.name)) continue;
            if (element.tagName === "IMG" && attribute.name === "src" &&
                !/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(attribute.value.trim())) continue;
            if (element.tagName === "IMG" && attribute.name === "src" &&
                /^https?:\/\//i.test(attribute.value.trim())) continue;
            element.removeAttribute(attribute.name);
        }
        for (const [property, value] of styles) {
            if (value && !/url\s*\(|expression\s*\(/i.test(value)) element.style.setProperty(property, value);
        }
        if (element.matches('[data-type~="inline-math"], [data-subtype="math"]')) {
            element.dataset.subtype = "math";
            element.textContent = element.dataset.content || element.textContent;
        }
        if (element.tagName === "IMG") element.setAttribute("draggable", "false");
    }
    const textBody = body.cloneNode(true) as HTMLElement;
    textBody.querySelectorAll("img").forEach(image => image.replaceWith(image.alt || "图片"));
    const text = (textBody.textContent || "").replace(/[\u200b\ufeff]/g, "").replace(/\s+/g, " ").trim();
    // 只有换行或空格式标记的块仍使用“空列表项”等占位文字。
    return { text, ...(text && body.children.length ? { html: body.innerHTML } : {}) };
}

/** 在文本节点中标记匹配范围，保留跨行内元素匹配时的原始格式。 */
export function highlightOutlineLabel(label: HTMLElement, keyword: string) {
    if (!keyword.trim()) return;
    const walker = document.createTreeWalker(label, 4 /* NodeFilter.SHOW_TEXT */);
    const nodes: { node: Text; start: number }[] = [];
    let text = "";
    while (walker.nextNode()) {
        const node = walker.currentNode as Text;
        nodes.push({ node, start: text.length });
        text += node.data;
    }
    // 原生大纲用 NBSP 保留空格；搜索文本将空白合并，因此匹配时接受连续空白。
    const pattern = keyword.trim().split(/\s+/).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
    const matches = Array.from(text.matchAll(new RegExp(pattern, "gi")), match => ({ start: match.index!, length: match[0].length }));
    for (const { node, start } of nodes) {
        const fragment = document.createDocumentFragment();
        let offset = 0;
        for (const match of matches) {
            const from = Math.max(0, match.start - start);
            const to = Math.min(node.length, match.start + match.length - start);
            if (from >= to) continue;
            // 公式渲染会替换内部文本节点，保留整个公式的搜索高亮。
            node.parentElement?.closest('[data-subtype="math"]')?.classList.add("list-outline-floating__match");
            fragment.append(node.data.slice(offset, from));
            const mark = document.createElement("span");
            mark.className = "list-outline-floating__match";
            mark.textContent = node.data.slice(from, to);
            fragment.append(mark);
            offset = to;
        }
        if (offset) {
            fragment.append(node.data.slice(offset));
            node.replaceWith(fragment);
        }
    }
}
