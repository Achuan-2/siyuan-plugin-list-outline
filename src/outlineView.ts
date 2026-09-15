import type { OutlineEntry } from "./outline";

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
    const text = document.createElement("span");
    text.className = "list-outline-floating__text";
    const kw = highlightKeyword?.trim();
    if (kw) {
        const lowerText = entry.text.toLowerCase();
        const lowerKw = kw.toLowerCase();
        let start = 0;
        let index = lowerText.indexOf(lowerKw, start);
        if (index !== -1) {
            while (index !== -1) {
                if (index > start) {
                    text.append(document.createTextNode(entry.text.slice(start, index)));
                }
                const matchSpan = document.createElement("span");
                matchSpan.className = "list-outline-floating__match";
                matchSpan.textContent = entry.text.slice(index, index + kw.length);
                text.append(matchSpan);
                start = index + kw.length;
                index = lowerText.indexOf(lowerKw, start);
            }
            if (start < entry.text.length) {
                text.append(document.createTextNode(entry.text.slice(start)));
            }
        } else {
            text.textContent = entry.text;
        }
    } else {
        text.textContent = entry.text;
    }
    row.append(line, text);
    row.title = entry.text;
    row.setAttribute("aria-label", `第 ${entry.depth} 层：${entry.text}`);
    return row;
}

export function setOutlineCurrent(body: HTMLElement, id: string) {
    body.querySelectorAll<HTMLElement>("button[data-id]").forEach(row => {
        const active = !!id && row.dataset.id === id;
        row.classList.toggle("list-outline-floating__current", active);
        if (active) row.setAttribute("aria-current", "location");
        else row.removeAttribute("aria-current");
    });
}
