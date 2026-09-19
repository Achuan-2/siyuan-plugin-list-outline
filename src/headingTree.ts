import { blockDepth, DEPTH_ATTRIBUTE, EMBED_RESULT_SELECTOR, extractOutline, findRootLists, OUTLINE_CONTAINER_SELECTOR, OUTLINE_ITEM_SELECTOR,
    type OutlineEntry } from "./outline";

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

export interface HeadingEntry extends OutlineEntry {
    level: number;
    /** 所在查询嵌入块，用于点击时定位当前文档里的渲染副本。 */
    embedId?: string;
}

const EMBED_SELECTOR = '[data-type="NodeBlockQueryEmbed"][data-node-id]';

/**
 * Kernel 的 BlockDOM 只有嵌入查询语句，不包含前端异步渲染出的查询结果。
 * 将当前编辑器中顶层嵌入块的结果复制到快照，既保留折叠内容，又能按文档顺序提取嵌入列表。
 */
function mergeRenderedEmbeds(document: Document, liveRoot?: Element | null) {
    if (!liveRoot) return;
    const liveEmbeds = Array.from(liveRoot.querySelectorAll<HTMLElement>(EMBED_SELECTOR))
        .filter(embed => !embed.closest(EMBED_RESULT_SELECTOR));
    for (const liveEmbed of liveEmbeds) {
        const id = liveEmbed.dataset.nodeId;
        if (!id) continue;
        const snapshotEmbed = Array.from(document.querySelectorAll<HTMLElement>(EMBED_SELECTOR))
            .find(embed => embed.dataset.nodeId === id);
        if (!snapshotEmbed) continue;
        for (const result of Array.from(liveEmbed.children).filter(child => child.matches(EMBED_RESULT_SELECTOR))) {
            snapshotEmbed.append(result.cloneNode(true));
        }
    }
}

export function findEmbeddedOutlineTarget(root: Element, id: string, embedId: string): HTMLElement | null {
    const embed = Array.from(root.querySelectorAll<HTMLElement>(EMBED_SELECTOR))
        .find(node => node.dataset.nodeId === embedId);
    return Array.from(embed?.querySelectorAll<HTMLElement>(OUTLINE_ITEM_SELECTOR) || [])
        .find(node => node.dataset.nodeId === id) || null;
}

/** 用完整文档 DOM 确定列表和页签位置，标题文字及层级仍沿用思源原生大纲。 */
export function includeListsInHeadingTree(headings: HeadingEntry[], dom: string, defaultDepth: number,
    liveRoot?: Element | null): HeadingEntry[] {
    const document = new DOMParser().parseFromString(dom, "text/html");
    mergeRenderedEmbeds(document, liveRoot);
    const headingMap = new Map(headings.map(entry => [entry.id, entry]));
    const listItems = new Map<string, HeadingEntry>();
    const entries: HeadingEntry[] = [];
    const seen = new Set<string>();
    const rootContainers = new Set(findRootLists(document.body));
    let headingDepth = 0;
    const selector = `[data-type="NodeHeading"], ${OUTLINE_CONTAINER_SELECTOR}, ${OUTLINE_ITEM_SELECTOR}`;
    for (const node of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
        const id = node.dataset.nodeId || "";
        const heading = headingMap.get(id);
        if (heading) {
            entries.push(heading);
            seen.add(id);
            headingDepth = heading.depth;
        } else if (node.matches(OUTLINE_CONTAINER_SELECTOR) && rootContainers.has(node) &&
            (!node.closest('[data-type="NodeBlockQueryEmbed"]') || node.closest(EMBED_RESULT_SELECTOR))) {
            const depth = blockDepth(node.getAttribute(DEPTH_ATTRIBUTE)) ?? defaultDepth;
            const embedId = node.closest<HTMLElement>(EMBED_SELECTOR)?.dataset.nodeId;
            for (const entry of extractOutline(node, depth)) {
                listItems.set(entry.id, { ...entry, depth: headingDepth + entry.depth, level: 0,
                    kind: entry.kind === "tab" ? "tab" : "list", ...(embedId ? { embedId } : {}) });
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
