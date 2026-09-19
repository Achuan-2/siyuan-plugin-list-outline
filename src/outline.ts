import { MAX_DEPTH } from "./defaultSettings";

export const DEPTH_ATTRIBUTE = "custom-list-outline-depth";
export const LIST_SELECTOR = '[data-type="NodeList"][data-node-id]';
const ITEM_SELECTOR = '[data-type="NodeListItem"]';
const QUOTE_SELECTOR = '[data-type="NodeBlockquote"], blockquote';

export interface OutlineEntry {
    id: string;
    text: string;
    depth: number;
    images?: OutlineImage[];
}

export interface OutlineImage {
    src: string;
    alt: string;
    title?: string;
}

function normalizedText(element?: Element | null): string {
    return (element?.textContent || "").replace(/[\u200b\ufeff]/g, "").replace(/\s+/g, " ").trim();
}

function imageTitle(image: HTMLImageElement): string {
    return image.getAttribute("title")?.trim() ||
        image.closest('[data-type="img"], .img')?.querySelector<HTMLElement>('.protyle-action__title span')?.textContent?.trim() || "";
}

export function blockDepth(value: string | null): number | null {
    if (!value || !/^\d+$/.test(value)) return null;
    const depth = Number(value);
    return depth >= 1 && depth <= MAX_DEPTH ? depth : null;
}

export function findList(target: Element): HTMLElement | null {
    const editor = target.closest(".protyle-wysiwyg");
    if (!editor) return null;
    let list = target.closest<HTMLElement>(LIST_SELECTOR);
    let result: HTMLElement | null = null;
    // 子列表属于同一份大纲；在子项间移动时不切换悬浮面板。
    while (list && editor.contains(list)) {
        if (!list.closest(QUOTE_SELECTOR)) result = list;
        list = list.parentElement?.closest<HTMLElement>(LIST_SELECTOR);
    }
    return result;
}

export function findRootLists(container: Element): HTMLElement[] {
    const lists = Array.from(container.querySelectorAll<HTMLElement>(LIST_SELECTOR));
    return lists.filter(list => {
        if (list.closest(QUOTE_SELECTOR)) return false;
        const parentList = list.parentElement?.closest(LIST_SELECTOR);
        return !parentList || !container.contains(parentList);
    });
}

export function extractOutline(root: HTMLElement, maxDepth: number): OutlineEntry[] {
    const entries: OutlineEntry[] = [];
    function visit(list: Element, depth: number) {
        if (depth > maxDepth || list.closest(QUOTE_SELECTOR)) return;
        for (const item of Array.from(list.children)) {
            if (!item.matches(ITEM_SELECTOR)) continue;
            // 仅取本列表项自己的首个文本块，不把子列表和附加段落拼入标题。
            const content = Array.from(item.querySelectorAll<HTMLElement>('[contenteditable="true"]'))
                .find(element => element.closest(ITEM_SELECTOR) === item &&
                    !element.closest(QUOTE_SELECTOR) &&
                    !element.closest('.protyle-attr, .protyle-action, [data-type="NodeCodeBlock"], [data-type="NodeTable"]'));
            const clone = content?.cloneNode(true) as HTMLElement | undefined;
            clone?.querySelectorAll('.protyle-attr, .protyle-action, script, style, .img__net').forEach(node => node.remove());
            clone?.querySelectorAll('[data-type="inline-math"]').forEach(math => math.replaceWith(math.getAttribute("data-content") || math.textContent || ""));
            const imageElements = Array.from(clone?.querySelectorAll<HTMLImageElement>('img') || []);
            const textOnlyClone = clone?.cloneNode(true) as HTMLElement | undefined;
            textOnlyClone?.querySelectorAll('img, .protyle-action__title').forEach(node => node.remove());
            const isImageOnly = imageElements.length > 0 && !normalizedText(textOnlyClone);
            const images = isImageOnly ? imageElements.flatMap(image => {
                const src = image.getAttribute("data-src") || image.getAttribute("src") || "";
                const title = imageTitle(image);
                return src ? [{ src, alt: image.getAttribute("alt") || "图片", ...(title ? { title } : {}) }] : [];
            }) : [];
            clone?.querySelectorAll('.protyle-action__title').forEach(node => node.remove());
            clone?.querySelectorAll('img').forEach(img => img.replaceWith(img.getAttribute('alt') || "图片"));
            const text = images.length ? images.map(image => image.title).filter(Boolean).join(" ") || "图片" : normalizedText(clone);
            const id = item.getAttribute("data-node-id");
            if (id) entries.push({ id, text: text || "（空列表项）", depth,
                ...(images.length ? { images } : {}) });
            // 只有嵌套列表增加层级；引述块中的列表整体跳过。
            for (const child of Array.from(item.querySelectorAll(LIST_SELECTOR))) {
                if (child.parentElement?.closest(ITEM_SELECTOR) === item &&
                    child.parentElement?.closest(LIST_SELECTOR) === list) visit(child, depth + 1);
            }
        }
    }
    visit(root, 1);
    return entries;
}

export function hasChildBlocks(root: HTMLElement): boolean {
    if (!root || !root.querySelectorAll) return false;
    const items = Array.from(root.querySelectorAll<HTMLElement>(ITEM_SELECTOR));
    if (!items.length) return false;

    for (const item of items) {
        // 1. 包含嵌套子列表或引述块
        if (item.querySelector(LIST_SELECTOR) || item.querySelector(QUOTE_SELECTOR)) {
            return true;
        }
        // 2. 包含代码块、超级块、表格、公式块、HTML块、嵌入块等复合子块
        if (item.querySelector('[data-type="NodeCodeBlock"], [data-type="NodeSuperBlock"], [data-type="NodeTable"], [data-type="NodeMathBlock"], [data-type="NodeHTMLBlock"], [data-type="NodeBlockQueryEmbed"], [data-type="NodeIFrame"], [data-type="NodeWidget"], [data-type="NodeVideo"], [data-type="NodeAudio"], [data-type="NodeHeading"]')) {
            return true;
        }
        // 3. 包含多个直接内容块（例如两个或更多段落）
        const childBlocks = Array.from(item.querySelectorAll<HTMLElement>('[data-type]')).filter(el => {
            if (el === item) return false;
            if (el.closest(ITEM_SELECTOR) !== item) return false;
            const type = el.getAttribute("data-type") || "";
            return type.startsWith("Node") && type !== "NodeListItem";
        });
        if (childBlocks.length > 1) {
            return true;
        }
    }
    return false;
}
