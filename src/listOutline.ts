import { MAX_DEPTH, type OutlineSettings } from "./defaultSettings";
import { blockDepth, DEPTH_ATTRIBUTE, extractOutline, findList, LIST_SELECTOR, truncateText } from "./outline";

interface Options {
    getSettings(): OutlineSettings;
    request(url: string, data: Record<string, unknown>): Promise<any>;
    navigate(id: string): void;
    reportError(message: string): void;
}

export class ListOutlineController {
    private panel = document.createElement("aside");
    private select = document.createElement("select");
    private body = document.createElement("div");
    private status = document.createElement("div");
    private active: HTMLElement | null = null;
    private source: HTMLElement | null = null;
    private editor: HTMLElement | null = null;
    private override: number | null = null;
    private generation = 0;
    private requestVersion = 0;
    private frame = 0;
    private hideTimer?: ReturnType<typeof setTimeout>;
    private refreshTimer?: ReturnType<typeof setTimeout>;
    private heartbeat?: ReturnType<typeof setInterval>;
    private observer: MutationObserver;
    private resizeObserver: ResizeObserver;
    private saving = new Set<string>();
    private disposed = false;

    constructor(private options: Options) {
        this.panel.className = "list-outline-floating";
        this.panel.setAttribute("aria-label", "列表大纲");
        this.panel.hidden = true;
        const header = document.createElement("div");
        header.className = "list-outline-floating__header";
        const title = document.createElement("span");
        title.textContent = "列表大纲";
        const label = document.createElement("label");
        label.textContent = "层级";
        this.select.className = "b3-select";
        this.select.setAttribute("aria-label", "当前列表的大纲层级");
        this.select.title = "单独设置当前列表，自动保存到列表块属性";
        this.select.add(new Option("跟随默认", ""));
        for (let depth = 1; depth <= MAX_DEPTH; depth++) this.select.add(new Option(`${depth} 层`, String(depth)));
        label.append(this.select);
        header.append(title, label);
        this.body.className = "list-outline-floating__body";
        this.status.className = "list-outline-floating__status";
        this.status.setAttribute("role", "status");
        this.panel.append(header, this.body, this.status);
        document.body.append(this.panel);
        this.select.addEventListener("change", this.saveDepth);
        this.body.addEventListener("click", this.onEntryClick);
        document.addEventListener("pointerover", this.onPointerOver);
        document.addEventListener("pointerout", this.onPointerOut);
        document.addEventListener("pointerdown", this.onPointerDown);
        document.addEventListener("keydown", this.onKeyDown);
        window.addEventListener("blur", this.hide);
        window.addEventListener("scroll", this.schedulePosition, true);
        window.addEventListener("resize", this.schedulePosition);
        this.observer = new MutationObserver(this.onMutation);
        this.resizeObserver = new ResizeObserver(this.schedulePosition);
    }

    private onPointerOver = (event: PointerEvent) => {
        if (!(event.target instanceof Element)) return;
        if (this.panel.contains(event.target)) {
            clearTimeout(this.hideTimer);
            return;
        }
        const list = findList(event.target);
        if (list) {
            clearTimeout(this.hideTimer);
            if (list !== this.active) this.show(list);
        } else if (this.active) this.scheduleHide();
    };

    private onPointerOut = (event: PointerEvent) => {
        const next = event.relatedTarget;
        if (next instanceof Node && (this.panel.contains(next) || this.active?.contains(next))) return;
        // 原生下拉框展开时 relatedTarget 可能为空，不能销毁正在操作的控件。
        if (!next && document.activeElement === this.select) return;
        this.scheduleHide();
    };

    private onPointerDown = (event: PointerEvent) => {
        if (event.target instanceof Node && !this.panel.contains(event.target) && !this.active?.contains(event.target)) this.hide();
    };

    private onKeyDown = (event: KeyboardEvent) => {
        if (event.key === "Escape") this.hide();
    };

    private scheduleHide() {
        clearTimeout(this.hideTimer);
        this.hideTimer = setTimeout(this.hide, 240);
    }

    private show(list: HTMLElement) {
        this.hide();
        this.active = list;
        this.source = list;
        this.editor = list.closest<HTMLElement>(".protyle-wysiwyg");
        this.override = blockDepth(list.getAttribute(DEPTH_ATTRIBUTE));
        this.panel.hidden = false;
        this.status.textContent = "";
        this.body.scrollTop = 0;
        this.render();
        this.position();
        if (!this.active) return;
        this.observer.observe(this.editor!, {
            childList: true, subtree: true, characterData: true, attributes: true,
            attributeFilter: [DEPTH_ATTRIBUTE, "fold", "data-type", "data-content"],
        });
        this.resizeObserver.observe(list);
        this.resizeObserver.observe(this.editor!);
        this.heartbeat = setInterval(this.schedulePosition, 500);
        void this.loadSnapshot();
    }

    private onMutation = (mutations: MutationRecord[]) => {
        if (!this.active) return;
        if (!this.active.isConnected) {
            const id = this.active.dataset.nodeId;
            const replacement = Array.from(this.editor?.querySelectorAll<HTMLElement>(LIST_SELECTOR) || [])
                .find(node => node.dataset.nodeId === id);
            if (replacement) this.show(replacement);
            else this.hide();
            return;
        }
        if (!mutations.some(mutation => this.active!.contains(mutation.target))) return;
        this.requestVersion++;
        this.override = blockDepth(this.active.getAttribute(DEPTH_ATTRIBUTE));
        this.source = this.active;
        this.render();
        clearTimeout(this.refreshTimer);
        // 等待编辑事务落盘，再补齐折叠、未渲染的子列表。
        this.refreshTimer = setTimeout(() => void this.loadSnapshot(), 600);
    };

    private async loadSnapshot() {
        const active = this.active;
        if (!active) return;
        const generation = this.generation;
        const version = ++this.requestVersion;
        const id = active.dataset.nodeId!;
        const [dom, attrs] = await Promise.allSettled([
            this.options.request("/api/block/getBlockDOM", { id }),
            this.options.request("/api/attr/getBlockAttrs", { id }),
        ]);
        if (this.disposed || generation !== this.generation || version !== this.requestVersion) return;
        if (dom.status === "fulfilled" && dom.value?.dom) {
            const parsed = new DOMParser().parseFromString(dom.value.dom, "text/html");
            const root = Array.from(parsed.querySelectorAll<HTMLElement>(LIST_SELECTOR)).find(node => node.dataset.nodeId === id);
            if (root) this.source = root;
        }
        if (attrs.status === "fulfilled" && !this.saving.has(id)) {
            this.override = blockDepth(attrs.value?.[DEPTH_ATTRIBUTE] || null);
        }
        this.status.textContent = dom.status === "rejected" ? "读取完整列表失败，暂显示已加载内容" : "";
        if (attrs.status === "rejected") this.status.textContent = "读取块设置失败，暂使用当前显示值";
        this.render();
    }

    refreshSettings() {
        if (this.active) this.render();
    }

    private render() {
        if (!this.active || !this.source) return;
        const settings = this.options.getSettings();
        this.select.options[0].textContent = `跟随默认（${settings.defaultDepth} 层）`;
        this.select.value = this.override === null ? "" : String(this.override);
        this.select.disabled = this.saving.has(this.active.dataset.nodeId!);
        const entries = extractOutline(this.source, this.override ?? settings.defaultDepth);
        const fragment = document.createDocumentFragment();
        for (const entry of entries) {
            const row = document.createElement("button");
            row.type = "button";
            row.className = "list-outline-floating__item";
            row.dataset.id = entry.id;
            row.style.paddingInlineStart = `${10 + (entry.depth - 1) * 14}px`;
            row.textContent = truncateText(entry.text, settings.maxTextLength);
            row.title = entry.text;
            row.setAttribute("aria-label", `第 ${entry.depth} 层：${entry.text}`);
            fragment.append(row);
        }
        if (!entries.length) {
            const empty = document.createElement("div");
            empty.className = "list-outline-floating__empty";
            empty.textContent = "暂无列表项";
            fragment.append(empty);
        }
        const scrollTop = this.body.scrollTop;
        this.body.replaceChildren(fragment);
        this.body.scrollTop = scrollTop;
        this.schedulePosition();
    }

    private saveDepth = async () => {
        if (!this.active) return;
        const active = this.active;
        const id = active.dataset.nodeId!;
        if (this.saving.has(id)) return;
        const value = this.select.value;
        const generation = this.generation;
        this.requestVersion++;
        this.saving.add(id);
        this.select.disabled = true;
        this.status.textContent = "正在保存…";
        try {
            await this.options.request("/api/attr/setBlockAttrs", { id, attrs: { [DEPTH_ATTRIBUTE]: value } });
            if (this.disposed) return;
            // 同一列表可能同时在多个编辑器中打开，只同步这一个自定义属性。
            document.querySelectorAll<HTMLElement>(LIST_SELECTOR).forEach(node => {
                if (node.dataset.nodeId !== id) return;
                if (value) node.setAttribute(DEPTH_ATTRIBUTE, value);
                else node.removeAttribute(DEPTH_ATTRIBUTE);
            });
            if (generation === this.generation) {
                this.override = blockDepth(value);
                this.status.textContent = value ? `已保存：${value} 层` : "已恢复跟随默认";
            }
        } catch (error) {
            console.error("列表大纲：保存块属性失败", error);
            if (!this.disposed) this.options.reportError("列表大纲层级保存失败，请重试。");
            if (generation === this.generation) this.status.textContent = "保存失败，设置未更改";
        } finally {
            this.saving.delete(id);
            if (!this.disposed && this.active?.dataset.nodeId === id) this.render();
        }
    };

    private onEntryClick = (event: MouseEvent) => {
        const button = (event.target as Element).closest<HTMLButtonElement>("button[data-id]");
        if (!button || !this.active) return;
        const id = button.dataset.id!;
        const target = Array.from(this.active.querySelectorAll<HTMLElement>('[data-type="NodeListItem"]'))
            .find(node => node.dataset.nodeId === id);
        const foldedParent = target?.parentElement?.closest('[fold="1"]');
        if (target && target.getClientRects().length && !foldedParent) {
            target.scrollIntoView({ block: "center", behavior: "smooth" });
            target.animate([{ backgroundColor: "var(--b3-theme-primary-light)" }, { backgroundColor: "transparent" }], { duration: 1000 });
        } else this.options.navigate(id);
    };

    private schedulePosition = () => {
        if (!this.frame && this.active) this.frame = requestAnimationFrame(() => {
            this.frame = 0;
            this.position();
        });
    };

    private position() {
        if (!this.active?.isConnected || !this.active.getClientRects().length) {
            this.hide();
            return;
        }
        const rect = this.active.getBoundingClientRect();
        const viewport = this.active.closest(".protyle-content")?.getBoundingClientRect();
        const top = Math.max(8, viewport?.top ?? 0);
        const bottom = Math.min(window.innerHeight - 8, viewport?.bottom ?? window.innerHeight);
        const left = Math.max(8, viewport?.left ?? 0);
        const right = Math.min(window.innerWidth - 8, viewport?.right ?? window.innerWidth);
        if (rect.bottom <= top || rect.top >= bottom || rect.right <= left || rect.left >= right) {
            this.hide();
            return;
        }
        const width = Math.max(0, Math.min(300, right - left));
        const y = Math.max(top, Math.min(rect.top + 6, bottom - 100));
        this.panel.style.width = `${width}px`;
        this.panel.style.left = `${Math.max(left, Math.min(rect.right - width - 6, right - width))}px`;
        this.panel.style.top = `${y}px`;
        this.panel.style.maxHeight = `${Math.max(0, Math.min(420, bottom - y))}px`;
    }

    private hide = () => {
        clearTimeout(this.hideTimer);
        clearTimeout(this.refreshTimer);
        clearInterval(this.heartbeat);
        cancelAnimationFrame(this.frame);
        this.frame = 0;
        this.generation++;
        this.observer?.disconnect();
        this.resizeObserver?.disconnect();
        this.active = null;
        this.source = null;
        this.editor = null;
        this.panel.hidden = true;
    };

    destroy() {
        this.disposed = true;
        this.hide();
        document.removeEventListener("pointerover", this.onPointerOver);
        document.removeEventListener("pointerout", this.onPointerOut);
        document.removeEventListener("pointerdown", this.onPointerDown);
        document.removeEventListener("keydown", this.onKeyDown);
        window.removeEventListener("blur", this.hide);
        window.removeEventListener("scroll", this.schedulePosition, true);
        window.removeEventListener("resize", this.schedulePosition);
        this.panel.remove();
    }
}
