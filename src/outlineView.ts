import type { OutlineEntry } from "./outline";

export function createOutlineLabel(entry: OutlineEntry, highlightKeyword?: string,
    className = "list-outline-floating__text"): HTMLSpanElement {
    const label = document.createElement("span");
    label.className = className;
    if (entry.images?.length) {
        label.classList.add("outline-entry__label--images");
        for (const image of entry.images) {
            const element = document.createElement("img");
            element.className = "outline-entry__image";
            element.src = image.src;
            element.alt = image.alt;
            element.loading = "lazy";
            element.draggable = false;
            label.append(element);
        }
        const title = entry.images.map(image => image.title).filter(Boolean).join(" ");
        if (title) {
            const titleElement = document.createElement("span");
            titleElement.className = "outline-entry__image-title";
            titleElement.textContent = title;
            label.append(titleElement);
        }
        return label;
    }

    const kw = highlightKeyword?.trim();
    if (kw) {
        const lowerText = entry.text.toLowerCase();
        const lowerKw = kw.toLowerCase();
        let start = 0;
        let index = lowerText.indexOf(lowerKw, start);
        if (index !== -1) {
            while (index !== -1) {
                if (index > start) {
                    label.append(document.createTextNode(entry.text.slice(start, index)));
                }
                const matchSpan = document.createElement("span");
                matchSpan.className = "list-outline-floating__match";
                matchSpan.textContent = entry.text.slice(index, index + kw.length);
                label.append(matchSpan);
                start = index + kw.length;
                index = lowerText.indexOf(lowerKw, start);
            }
            if (start < entry.text.length) {
                label.append(document.createTextNode(entry.text.slice(start)));
            }
        } else {
            label.textContent = entry.text;
        }
    } else {
        label.textContent = entry.text;
    }
    return label;
}

/** 两种大纲共用线条、标题和截断样式。 */
export function createOutlineRow(entry: OutlineEntry, highlightKeyword?: string): HTMLButtonElement {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "list-outline-floating__item";
    row.dataset.id = entry.id;
    row.style.setProperty("--outline-indent", `${10 + (entry.depth - 1) * 14}px`);
    row.style.setProperty("--outline-line-width", `${Math.max(8, 28 - (entry.depth - 1) * 4)}px`);
    const line = document.createElement("span");
    line.className = "list-outline-floating__line";
    line.setAttribute("aria-hidden", "true");
    const text = createOutlineLabel(entry, highlightKeyword);
    row.append(line, text);
    if (!entry.images?.length || entry.images.some(image => image.title)) row.title = entry.text;
    row.setAttribute("aria-label", `第 ${entry.depth} 层：${entry.text}`);
    return row;
}

export function createOutlineFoldButton(entry: OutlineEntry, expanded: boolean, className: string): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.dataset.outlineToggle = entry.id;
    button.setAttribute("aria-expanded", String(expanded));
    button.setAttribute("aria-label", `${expanded ? "折叠" : "展开"}：${entry.text}`);
    button.title = expanded ? "折叠下级标题" : "展开下级标题";
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("aria-hidden", "true");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", expanded ? "#iconDown" : "#iconRight");
    icon.append(use);
    button.append(icon);
    return button;
}

export function setOutlineCurrent(body: HTMLElement, id: string) {
    body.querySelectorAll<HTMLElement>("button[data-id]").forEach(row => {
        const active = !!id && row.dataset.id === id;
        row.classList.toggle("list-outline-floating__current", active);
        if (active) row.setAttribute("aria-current", "location");
        else row.removeAttribute("aria-current");
    });
}
