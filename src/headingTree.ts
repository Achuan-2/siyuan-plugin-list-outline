import { blockDepth, DEPTH_ATTRIBUTE, extractOutline, LIST_SELECTOR, type OutlineEntry } from "./outline";

// 对应思源 kernel/model/outline.go：顶层 Path 使用 name/blocks，子级 Block 使用 content/children。
export interface NativeHeading {
    id: string;
    name?: string;
    content?: string;
    nameIsHTML?: boolean;
    subType?: string;
    number?: string;
    blocks?: NativeHeading[];
    children?: NativeHeading[];
}

export interface HeadingEntry extends OutlineEntry { level: number; kind?: "heading" | "list" }

/** 用完整文档 DOM 确定列表位置，标题文字及层级仍沿用思源原生大纲。 */
export function includeListsInHeadingTree(headings: HeadingEntry[], dom: string, defaultDepth: number): HeadingEntry[] {
    const document = new DOMParser().parseFromString(dom, "text/html");
    const headingMap = new Map(headings.map(entry => [entry.id, entry]));
    const listItems = new Map<string, HeadingEntry>();
    const entries: HeadingEntry[] = [];
    const seen = new Set<string>();
    let headingDepth = 0;
    for (const node of Array.from(document.querySelectorAll<HTMLElement>('[data-type="NodeHeading"], [data-type="NodeList"], [data-type="NodeListItem"]'))) {
        const id = node.dataset.nodeId || "";
        const heading = headingMap.get(id);
        if (heading) {
            entries.push(heading);
            seen.add(id);
            headingDepth = heading.depth;
        } else if (node.matches(LIST_SELECTOR) && !node.parentElement?.closest(LIST_SELECTOR) &&
            !node.closest('[data-type="NodeBlockquote"], blockquote, [data-type="NodeBlockQueryEmbed"]')) {
            const depth = blockDepth(node.getAttribute(DEPTH_ATTRIBUTE)) ?? defaultDepth;
            for (const entry of extractOutline(node, depth)) {
                listItems.set(entry.id, { ...entry, depth: headingDepth + entry.depth, level: 0, kind: "list" });
            }
        } else if (listItems.has(id)) {
            entries.push(listItems.get(id)!);
        }
    }
    // 快照与原生大纲短暂不同步时，不丢失已有标题。
    entries.push(...headings.filter(entry => !seen.has(entry.id)));
    return entries;
}

export function flattenHeadingTree(nodes: NativeHeading[] | null): HeadingEntry[] {
    const entries: HeadingEntry[] = [];
    const seen = new Set<string>();
    function visit(items: NativeHeading[], depth: number) {
        for (const node of items) {
            if (!node || !node.id || seen.has(node.id)) continue;
            seen.add(node.id);
            // Block.name 是块命名属性（常为空），不是子标题正文；原生 Tree.genBlockHTML 读取 content。
            const isBlock = typeof node.content === "string";
            let text = isBlock ? node.content! : node.name ?? "";
            if (isBlock || node.nameIsHTML !== false) {
                const parsed = new DOMParser().parseFromString(text, "text/html");
                parsed.querySelectorAll("script,style").forEach(element => element.remove());
                parsed.querySelectorAll("img").forEach(element => element.replaceWith(element.alt || "图片"));
                parsed.querySelectorAll('[data-type="inline-math"]').forEach(element =>
                    element.replaceWith(element.getAttribute("data-content") || element.textContent || ""));
                text = parsed.body.textContent || "";
            }
            text = text.replace(/[\u200b\ufeff]/g, "").replace(/\s+/g, " ").trim() || "（空标题）";
            entries.push({ id: node.id, text: node.number ? `${node.number} ${text}` : text, depth,
                level: /^h[1-6]$/.test(node.subType || "") ? Number(node.subType![1]) : Math.min(depth, 6) });
            visit([...(node.blocks || []), ...(node.children || [])], depth + 1);
        }
    }
    visit(Array.isArray(nodes) ? nodes : [], 1);
    return entries;
}
