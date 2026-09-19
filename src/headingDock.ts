import { flattenHeadingTree, includeListsInHeadingTree, type HeadingEntry } from "./headingTree";
import { getDefaultSettings, MAX_DEPTH, type OutlineSettings } from "./defaultSettings";
import type { HeadingEditor } from "./headingOutline";
import type { OpenInsertMenu } from "./outlineInsert";
import { createOutlineLabel } from "./outlineView";

export interface HeadingDockOptions {
    getEditors(): HeadingEditor[];
    request(url: string, data: Record<string, unknown>): Promise<any>;
    navigate(id: string, folded: boolean): void;
    reportError(message: string): void;
    openInsertMenu?: OpenInsertMenu;
    getSettings?(): OutlineSettings;
    setListDepth?(depth: number): Promise<unknown>;
}

export class HeadingOutlineDockView {
    public readonly rootElement = document.createElement("div");
    private header = document.createElement("div");
    private body = document.createElement("div");
    private status = document.createElement("div");
    private listDepthSelect = document.createElement("select");
    private searchInput = document.createElement("input");
    private editor: HeadingEditor | null = null;
    private entries: HeadingEntry[] = [];
    private searchQuery = "";
    private version = 0;
    private timer?: ReturnType<typeof setTimeout>;
    private heartbeat: ReturnType<typeof setInterval>;
    private frame = 0;
    private disposed = false;
    private observer: MutationObserver;
    private pointerElement: HTMLElement | null = null;

    constructor(
        public readonly container: HTMLElement,
        private options: HeadingDockOptions,
    ) {
        this.rootElement.className = "heading-outline-dock fn__flex-1 fn__flex-column";
        this.rootElement.setAttribute("aria-label", "标题大纲 Dock");

        // 顶部工具栏
        this.header.className = "heading-outline-dock__header block__icons";
        const logo = document.createElement("span");
        logo.className = "block__logo";
        logo.textContent = "标题大纲";

        const space = document.createElement("span");
        space.className = "fn__flex-1";

        this.listDepthSelect.className = "b3-select heading-outline-dock__list-depth";
        this.listDepthSelect.setAttribute("aria-label", "标题大纲列表层级");
        this.listDepthSelect.title = "选择标题大纲中显示的列表层级";
        for (let depth = 0; depth <= MAX_DEPTH; depth++) {
            const option = document.createElement("option");
            option.value = String(depth);
            option.textContent = depth === 0 ? "不显示列表" : `列表 ${depth} 层`;
            this.listDepthSelect.add(option);
        }
        this.listDepthSelect.value = String(this.settings.headingListDepth);
        this.listDepthSelect.addEventListener("change", async () => {
            this.listDepthSelect.disabled = true;
            try {
                await this.options.setListDepth?.(Number(this.listDepthSelect.value));
                if (!this.disposed) await this.refresh();
            } catch (error) {
                if (!this.disposed) this.options.reportError("列表层级设置保存失败，请重试。");
            } finally {
                this.listDepthSelect.disabled = false;
                this.listDepthSelect.value = String(this.settings.headingListDepth);
            }
        });

        const refreshBtn = document.createElement("button");
        refreshBtn.className = "block__icon b3-tooltips b3-tooltips__s";
        refreshBtn.setAttribute("aria-label", "刷新大纲");
        const refreshIcon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        const refreshUse = document.createElementNS("http://www.w3.org/2000/svg", "use");
        refreshUse.setAttribute("href", "#iconRefresh");
        refreshIcon.append(refreshUse);
        refreshBtn.append(refreshIcon);
        refreshBtn.addEventListener("click", () => void this.refresh());

        this.header.append(logo, space);
        if (options.setListDepth) this.header.append(this.listDepthSelect);
        this.header.append(refreshBtn);

        // 搜索栏
        const searchContainer = document.createElement("div");
        searchContainer.className = "heading-outline-dock__search";
        const searchIcon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        searchIcon.classList.add("heading-outline-dock__search-icon");
        searchIcon.setAttribute("aria-hidden", "true");
        const searchUse = document.createElementNS("http://www.w3.org/2000/svg", "use");
        searchUse.setAttribute("href", "#iconSearch");
        searchIcon.append(searchUse);

        this.searchInput.className = "b3-text-field heading-outline-dock__search-input";
        this.searchInput.type = "search";
        this.searchInput.placeholder = "搜索标题…";
        this.searchInput.setAttribute("aria-label", "搜索标题");
        this.searchInput.addEventListener("input", () => {
            this.searchQuery = this.searchInput.value.trim();
            this.render();
        });
        this.searchInput.addEventListener("keydown", (event: KeyboardEvent) => {
            if (event.key === "Escape" && this.searchInput.value) {
                event.stopPropagation();
                this.searchInput.value = "";
                this.searchQuery = "";
                this.render();
            }
        });
        searchContainer.append(searchIcon, this.searchInput);

        // 列表主体与状态栏
        this.body.className = "heading-outline-dock__body b3-list b3-list--background fn__flex-1";
        this.status.className = "heading-outline-dock__status";
        this.status.setAttribute("role", "status");

        this.rootElement.append(this.header, searchContainer, this.body, this.status);
        this.container.append(this.rootElement);

        this.body.addEventListener("click", this.onClick);
        this.body.addEventListener("contextmenu", this.onContextMenu);
        document.addEventListener("click", this.onEditorInteraction);
        document.addEventListener("focusin", this.onEditorInteraction);
        window.addEventListener("scroll", this.onScroll, true);

        this.observer = new MutationObserver(records => {
            if (records.some(record => this.settings.headingListDepth > 0 || record.type !== "characterData" ||
                record.target.parentElement?.closest('[data-type="NodeHeading"],h1,h2,h3,h4,h5,h6'))) this.scheduleRefresh();
        });

        this.heartbeat = setInterval(() => this.syncEditors(), 500);
        this.syncEditors();
    }

    private get settings(): OutlineSettings {
        return this.options.getSettings?.() || getDefaultSettings();
    }

    private visible(editor: HeadingEditor) {
        return editor.element.isConnected && !editor.element.closest('.fn__none, [hidden]') &&
            editor.content.getClientRects().length > 0;
    }

    syncEditors(preferred?: HTMLElement) {
        if (this.disposed) return;
        const editors = this.options.getEditors().filter(editor => this.visible(editor));
        const editor = editors.find(item => preferred && (item.element === preferred || item.element.contains(preferred))) ||
            editors.find(item => item.element === this.editor?.element) ||
            editors.find(item => document.activeElement && item.element.contains(document.activeElement)) || editors[0] || null;

        if (editor?.element === this.editor?.element && editor?.rootID === this.editor?.rootID &&
            editor?.preview === this.editor?.preview && editor?.content === this.editor?.content) {
            this.highlight();
            return;
        }
        this.version++;
        clearTimeout(this.timer);
        this.observer.disconnect();
        this.editor = editor;
        this.entries = [];
        this.body.replaceChildren();
        this.status.textContent = "";
        if (!editor) {
            this.render();
            return;
        }
        this.observer.observe(editor.content, {
            childList: true, subtree: true, characterData: true,
            attributes: true, attributeFilter: ["data-type", "data-subtype", "data-content", "custom-list-outline-depth", "src", "data-src", "alt", "title"],
        });
        void this.refresh();
    }

    private onEditorInteraction = (event: Event) => {
        if (event.target instanceof HTMLElement && !this.rootElement.contains(event.target)) {
            this.pointerElement = event.target;
            this.syncEditors(event.target);
            if (event.type === "click") this.highlight(true);
        }
    };

    private onScroll = (event: Event) => {
        if (event.target instanceof Node && this.rootElement.contains(event.target)) return;
        this.pointerElement = null;
        this.scheduleHighlight();
    };

    scheduleRefresh() {
        if (this.disposed || !this.editor) return;
        this.version++;
        clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.refresh(), 600);
    }

    async refresh() {
        if (this.disposed || !this.editor) return;
        clearTimeout(this.timer);
        const editor = this.editor;
        const version = ++this.version;
        const settings = this.settings;
        try {
            const [nodes, snapshot] = await Promise.all([
                this.options.request("/api/outline/getDocOutline", {
                    id: editor.rootID, preview: editor.preview, ...(editor.notebook ? { notebook: editor.notebook } : {}),
                }),
                settings.headingListDepth > 0 ? this.options.request("/api/block/getBlockDOM", {
                    id: editor.rootID, ...(editor.notebook ? { notebook: editor.notebook } : {}),
                }) : Promise.resolve(null),
            ]);
            if (this.disposed || version !== this.version) return;
            this.entries = flattenHeadingTree(nodes);
            if (settings.headingListDepth > 0) {
                this.entries = includeListsInHeadingTree(this.entries, snapshot?.dom || "", settings.headingListDepth);
            }
            this.status.textContent = "";
            this.render();
        } catch (error) {
            if (this.disposed || version !== this.version) return;
            console.error("标题大纲 Dock：读取失败", error);
            this.status.textContent = "读取标题大纲失败，可点击刷新重试";
            this.render();
        }
    }

    refreshSettings() {
        this.listDepthSelect.value = String(this.settings.headingListDepth);
        if (this.settings.headingListDepth === 0) {
            this.entries = this.entries.filter(entry => entry.kind !== "list");
            this.render();
        }
        void this.refresh();
    }

    private render() {
        if (this.disposed) return;

        if (!this.editor) {
            this.status.textContent = "暂无活动文档";
            this.status.hidden = false;
            this.body.replaceChildren();
            return;
        }

        const query = this.searchQuery.toLowerCase();
        const filteredEntries = query
            ? this.entries.filter(e => e.text.toLowerCase().includes(query))
            : this.entries;

        if (!this.entries.length) {
            this.status.textContent = this.status.textContent || "当前文档暂无标题";
            this.status.hidden = false;
            this.body.replaceChildren();
            return;
        }

        if (!filteredEntries.length) {
            this.status.textContent = "无匹配结果";
            this.status.hidden = false;
            this.body.replaceChildren();
            return;
        }

        this.status.hidden = true;
        const fragment = document.createDocumentFragment();
        for (const entry of filteredEntries) {
            const item = document.createElement("button");
            item.type = "button";
            item.className = "b3-list-item heading-outline-dock__item";
            item.dataset.id = entry.id;
            item.style.paddingLeft = `${12 + (entry.depth - 1) * 16}px`;

            const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
            icon.classList.add("b3-list-item__graphic", "heading-outline-dock__icon");
            icon.setAttribute("aria-hidden", "true");
            const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
            use.setAttribute("href", entry.kind === "list" ? "#iconList" : `#iconH${entry.level}`);
            icon.append(use);

            const text = createOutlineLabel(entry, this.searchQuery,
                "b3-list-item__text heading-outline-dock__text");

            item.append(icon, text);
            if (!entry.images?.length || entry.images.some(image => image.title)) item.title = entry.text;
            item.setAttribute("aria-label", `第 ${entry.depth} 层：${entry.text}`);
            fragment.append(item);
        }
        const scrollTop = this.body.scrollTop;
        this.body.replaceChildren(fragment);
        this.body.scrollTop = scrollTop;
        this.highlight();
    }

    private onClick = async (event: MouseEvent) => {
        const row = (event.target as Element).closest<HTMLButtonElement>("button[data-id]");
        const editor = this.editor;
        if (!row || !editor) return;
        const id = row.dataset.id!;
        if (!id) { void this.refresh(); return; }
        if (editor.preview) {
            const heading = Array.from(editor.content.querySelectorAll<HTMLElement>("[id]")).find(node => node.id === id);
            if (heading) { heading.scrollIntoView({ block: "center", behavior: "smooth" }); return; }
        }
        try {
            const result = await this.options.request("/api/block/checkBlockFold", {
                id, ...(editor.notebook ? { notebook: editor.notebook } : {}),
            });
            if (!this.disposed && this.editor === editor) this.options.navigate(id, !!result?.isFolded);
        } catch (error) {
            console.error("标题大纲 Dock：定位失败", error);
            if (!this.disposed) this.options.reportError("大纲条目定位失败，请重试。");
        }
    };

    private onContextMenu = (event: MouseEvent) => {
        const row = (event.target as Element).closest<HTMLButtonElement>("button[data-id]");
        if (!row?.dataset.id || !this.editor) return;
        const rootID = this.editor.rootID;
        const kind = this.entries.find(entry => entry.id === row.dataset.id)?.kind || "heading";
        this.options.openInsertMenu?.(event, {
            id: row.dataset.id, kind, editor: this.editor.element, notebook: this.editor.notebook,
        }, () => {
            if (!this.disposed && this.editor?.rootID === rootID) void this.refresh();
        });
    };

    scheduleHighlight = () => {
        if (!this.frame && !this.disposed) this.frame = requestAnimationFrame(() => {
            this.frame = 0;
            this.highlight();
        });
    };

    private resolveCurrentID(ids: Set<string>): string {
        if (!this.editor || !ids.size) return "";
        const selector = this.editor.preview
            ? "h1[id],h2[id],h3[id],h4[id],h5[id],h6[id],li[id]"
            : '[data-type="NodeHeading"][data-node-id], [data-type="NodeListItem"][data-node-id]';
        const nodes = Array.from(this.editor.content.querySelectorAll<HTMLElement>(selector)).filter(node => {
            const id = this.editor!.preview ? node.id : node.dataset.nodeId!;
            return ids.has(id) && node.getClientRects().length > 0;
        });

        const pointer = this.pointerElement;
        if (pointer?.isConnected && this.editor.content.contains(pointer)) {
            const direct = pointer.closest<HTMLElement>(selector);
            const directID = direct && this.editor.content.contains(direct)
                ? (this.editor.preview ? direct.id : direct.dataset.nodeId || "") : "";
            if (ids.has(directID)) return directID;

            // 普通段落、代码块等没有大纲项时，定位到文档顺序中它上方最近的大纲项。
            let preceding = "";
            for (const node of nodes) {
                const id = this.editor.preview ? node.id : node.dataset.nodeId!;
                if (node.compareDocumentPosition(pointer) & Node.DOCUMENT_POSITION_FOLLOWING) preceding = id;
                else if (node.compareDocumentPosition(pointer) & Node.DOCUMENT_POSITION_PRECEDING) break;
            }
            if (preceding) return preceding;
        }

        const viewport = this.editor.content.closest(".protyle-content") || this.editor.content;
        const top = viewport.getBoundingClientRect().top;
        let current = "";
        for (const node of nodes) {
            const id = this.editor.preview ? node.id : node.dataset.nodeId!;
            if (!current) current = id;
            if (node.getBoundingClientRect().top <= top + 48) current = id;
        }
        return current;
    }

    highlight(autoScroll = false) {
        if (!this.editor || this.disposed) return;
        const ids = new Set(this.entries.map(entry => entry.id));
        const current = this.resolveCurrentID(ids);
        let currentRow: HTMLElement | null = null;
        this.body.querySelectorAll<HTMLElement>("button[data-id]").forEach(row => {
            const active = !!current && row.dataset.id === current;
            row.classList.toggle("b3-list-item--focus", active);
            row.classList.toggle("heading-outline-dock__current", active);
            if (active) {
                row.setAttribute("aria-current", "location");
                currentRow = row;
            }
            else row.removeAttribute("aria-current");
        });
        if (autoScroll && currentRow) currentRow.scrollIntoView?.({ block: "nearest" });
    }

    destroy() {
        this.disposed = true;
        this.version++;
        clearTimeout(this.timer);
        clearInterval(this.heartbeat);
        cancelAnimationFrame(this.frame);
        this.observer.disconnect();
        document.removeEventListener("click", this.onEditorInteraction);
        document.removeEventListener("focusin", this.onEditorInteraction);
        window.removeEventListener("scroll", this.onScroll, true);
        this.rootElement.remove();
        this.editor = null;
    }
}
