import { strict as assert } from "node:assert";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { normalizeSettings } from "../src/defaultSettings";
import { HeadingOutlineDockView } from "../src/headingDock";
import type { HeadingEditor } from "../src/headingOutline";

const tree = [{ id: "h1", name: "<strong>一级标题</strong>", subType: "h1", number: "1.", blocks: [
    { id: "h3", name: "", content: "三级标题", subType: "h3", children: [{ id: "h6", name: "自定义块名", content: "六级标题", subType: "h6" }] },
] }, { id: "h2", name: "第二章", subType: "h2" }];

const settle = () => new Promise(resolve => setTimeout(resolve, 30));

function setup(request?: (url: string, data: Record<string, unknown>) => Promise<any>) {
    const dom = new JSDOM('<div class="protyle"><div class="protyle-content"><div class="protyle-wysiwyg"><div data-type="NodeHeading" data-node-id="h1"><div contenteditable="true">标题</div></div></div></div></div>', { pretendToBeVisual: true });
    const win = dom.window;
    for (const key of ["window", "document", "Element", "Node", "HTMLElement", "DOMParser", "MutationObserver"]) {
        Object.defineProperty(globalThis, key, { value: key === "window" ? win : (win as any)[key], configurable: true, writable: true });
    }
    Object.assign(globalThis, { requestAnimationFrame: win.requestAnimationFrame.bind(win), cancelAnimationFrame: win.cancelAnimationFrame.bind(win) });
    win.HTMLElement.prototype.getClientRects = function () { return [this.getBoundingClientRect()] as any; };
    win.HTMLElement.prototype.getBoundingClientRect = () => ({ x: 40, y: 40, left: 40, right: 800, top: 40, bottom: 600, width: 760, height: 560, toJSON() {} });

    const editors: HeadingEditor[] = [{ element: win.document.querySelector('.protyle')!, content: win.document.querySelector('.protyle-wysiwyg')!, rootID: "doc1", notebook: "notebook1", preview: false }];
    const calls: { url: string; data: Record<string, unknown> }[] = [];
    const navigations: { id: string; folded: boolean }[] = [];
    const menus: any[] = [];
    let settings = normalizeSettings({ enableHeadingDock: true });

    const container = win.document.createElement("div");
    win.document.body.append(container);

    const dock = new HeadingOutlineDockView(container, {
        getEditors: () => editors,
        getSettings: () => settings,
        setListDepth: async depth => { settings = { ...settings, headingListDepth: depth }; },
        request: async (url, data) => {
            calls.push({ url, data });
            return request ? request(url, data) : url.endsWith("checkBlockFold") ? { isFolded: true } : tree;
        },
        navigate: (id, folded) => navigations.push({ id, folded }),
        reportError: () => {},
        openInsertMenu: (event, target) => { event.preventDefault(); menus.push(target); },
    });

    return {
        win, editors, calls, navigations, menus, dock, container,
        setSettings: (value: Parameters<typeof normalizeSettings>[0]) => {
            settings = normalizeSettings(value);
            dock.refreshSettings();
        },
        cleanup: () => {
            dock.destroy();
            win.close();
        },
    };
}

test("标题大纲 Dock：关闭设置时不再显示禁用提示", async () => {
    const env = setup();
    try {
        await settle();
        let rows = env.container.querySelectorAll<HTMLButtonElement>("button.heading-outline-dock__item");
        assert.equal(rows.length, 4);
        assert.equal(env.container.querySelector(".heading-outline-dock__header .block__logo use"), null);

        // Dock 的注册/移除由插件生命周期处理，视图本身不再渲染“已禁用”提示。
        env.setSettings({ enableHeadingDock: false });
        await settle();
        rows = env.container.querySelectorAll<HTMLButtonElement>("button.heading-outline-dock__item");
        const status = env.container.querySelector<HTMLElement>(".heading-outline-dock__status")!;
        assert.equal(rows.length, 4);
        assert.equal(status.textContent?.includes("关闭"), false);
    } finally { env.cleanup(); }
});

test("标题大纲 Dock：搜索过滤、高亮匹配项及 Esc 清空", async () => {
    const env = setup();
    try {
        await settle();
        const searchInput = env.container.querySelector<HTMLInputElement>(".heading-outline-dock__search-input")!;
        assert.ok(searchInput);

        // 搜索 "三级"
        searchInput.value = "三级";
        searchInput.dispatchEvent(new env.win.Event("input"));
        await settle();

        let rows = env.container.querySelectorAll<HTMLButtonElement>("button.heading-outline-dock__item");
        assert.equal(rows.length, 1);
        assert.equal(rows[0].dataset.id, "h3");
        const match = rows[0].querySelector<HTMLElement>(".list-outline-floating__match")!;
        assert.ok(match);
        assert.equal(match.textContent, "三级");

        // 搜索无匹配
        searchInput.value = "无结果关键词";
        searchInput.dispatchEvent(new env.win.Event("input"));
        await settle();
        rows = env.container.querySelectorAll<HTMLButtonElement>("button.heading-outline-dock__item");
        assert.equal(rows.length, 0);
        const status = env.container.querySelector<HTMLElement>(".heading-outline-dock__status")!;
        assert.equal(status.textContent, "无匹配结果");

        // 按 Escape 清空
        searchInput.dispatchEvent(new env.win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await settle();
        assert.equal(searchInput.value, "");
        rows = env.container.querySelectorAll<HTMLButtonElement>("button.heading-outline-dock__item");
        assert.equal(rows.length, 4);
    } finally { env.cleanup(); }
});

test("标题大纲 Dock：点击定位与右键菜单插入同级", async () => {
    const env = setup();
    try {
        await settle();
        const row = env.container.querySelector<HTMLButtonElement>('button[data-id="h3"]')!;
        assert.ok(row);

        // 点击定位
        row.click();
        await settle();
        assert.deepEqual(env.navigations.at(-1), { id: "h3", folded: true });

        // 右键插入菜单
        row.dispatchEvent(new env.win.MouseEvent("contextmenu", { bubbles: true }));
        assert.equal(env.menus.at(-1)?.id, "h3");
        assert.equal(env.menus.at(-1)?.kind, "heading");
    } finally { env.cleanup(); }
});

test("标题大纲 Dock：鼠标移入不定位，点击标题或段落才定位高亮", async () => {
    const env = setup();
    try {
        await settle();
        assert.equal(env.container.querySelector('button[aria-label="定位当前位置"]'), null);
        const h1El = env.win.document.querySelector<HTMLElement>('[data-node-id="h1"]')!;
        h1El.dispatchEvent(new env.win.MouseEvent("pointerover", { bubbles: true }));
        assert.equal(env.container.querySelector<HTMLButtonElement>("button.b3-list-item--focus")?.dataset.id, "h1");

        const h3El = env.win.document.createElement("div");
        h3El.dataset.type = "NodeHeading";
        h3El.dataset.nodeId = "h3";
        h3El.innerHTML = '<div contenteditable="true">三级标题</div>';
        h3El.getBoundingClientRect = () => ({ ...h1El.getBoundingClientRect(), top: 200 });
        env.editors[0].content.append(h3El);
        let scrolled = false;
        env.container.querySelector<HTMLElement>('button[data-id="h3"]')!.scrollIntoView = () => { scrolled = true; };
        h3El.firstElementChild!.dispatchEvent(new env.win.MouseEvent("pointerover", { bubbles: true }));
        env.dock.syncEditors();
        assert.equal(env.container.querySelector<HTMLButtonElement>("button.b3-list-item--focus")?.dataset.id, "h1");
        assert.equal(scrolled, false);
        h3El.firstElementChild!.dispatchEvent(new env.win.MouseEvent("click", { bubbles: true }));
        assert.equal(env.container.querySelector<HTMLButtonElement>("button.b3-list-item--focus")?.dataset.id, "h3");
        assert.equal(scrolled, true);

        const paragraph = env.win.document.createElement("div");
        paragraph.dataset.type = "NodeParagraph";
        paragraph.innerHTML = '<div contenteditable="true">普通段落</div>';
        env.editors[0].content.append(paragraph);
        h1El.click();
        paragraph.firstElementChild!.dispatchEvent(new env.win.MouseEvent("pointerover", { bubbles: true }));
        assert.equal(env.container.querySelector<HTMLButtonElement>("button.b3-list-item--focus")?.dataset.id, "h1");
        paragraph.firstElementChild!.dispatchEvent(new env.win.MouseEvent("click", { bubbles: true }));
        assert.equal(env.container.querySelector<HTMLButtonElement>("button.b3-list-item--focus")?.dataset.id, "h3");
    } finally { env.cleanup(); }
});

test("标题大纲 Dock：同步高亮不强制滚动列表到当前标题", async () => {
    const env = setup();
    try {
        await settle();
        const body = env.container.querySelector<HTMLElement>(".heading-outline-dock__body")!;
        const currentRow = env.container.querySelector<HTMLElement>('button[data-id="h1"]')!;
        let scrolled = false;
        currentRow.scrollIntoView = () => { scrolled = true; };
        body.scrollTop = 80;

        env.dock.syncEditors();

        assert.equal(scrolled, false);
        assert.equal(body.scrollTop, 80);
        assert.equal(currentRow.classList.contains("b3-list-item--focus"), true);
    } finally { env.cleanup(); }
});

test("标题大纲 Dock：列表下拉框选择不显示或具体显示层级", async () => {
    const snapshot = '<div data-type="NodeHeading" data-node-id="h1"></div>' +
        '<div data-type="NodeList" data-node-id="list"><div data-type="NodeListItem" data-node-id="l1">' +
        '<div data-type="NodeParagraph"><div contenteditable="true">一级列表</div></div>' +
        '<div data-type="NodeList" data-node-id="child"><div data-type="NodeListItem" data-node-id="l2">' +
        '<div data-type="NodeParagraph"><div contenteditable="true">二级列表</div></div></div></div></div></div>';
    const env = setup(async url => url.endsWith("getBlockDOM") ? { dom: snapshot } : tree);
    try {
        await settle();
        const select = env.container.querySelector<HTMLSelectElement>('select[aria-label="标题大纲列表层级"]')!;
        assert.equal(select.value, "0");
        assert.equal(env.calls.some(call => call.url.endsWith("getBlockDOM")), false);

        select.value = "1";
        select.dispatchEvent(new env.win.Event("change"));
        await settle();
        assert.ok(env.container.querySelector('[data-id="l1"]'));
        assert.equal(env.container.querySelector('[data-id="l2"]'), null);

        env.editors[0].content.innerHTML = snapshot;
        const listContent = env.editors[0].content.querySelector('[data-node-id="l1"] [contenteditable]')!;
        listContent.dispatchEvent(new env.win.MouseEvent("pointerover", { bubbles: true }));
        assert.notEqual(env.container.querySelector<HTMLButtonElement>("button.b3-list-item--focus")?.dataset.id, "l1");
        listContent.dispatchEvent(new env.win.MouseEvent("click", { bubbles: true }));
        assert.equal(env.container.querySelector<HTMLButtonElement>("button.b3-list-item--focus")?.dataset.id, "l1");

        select.value = "0";
        select.dispatchEvent(new env.win.Event("change"));
        await settle();
        assert.equal(env.container.querySelector('[data-id="l1"]'), null);
    } finally { env.cleanup(); }
});

test("标题大纲 Dock：纯图片列表项显示图片，alt 不作为可见文本", async () => {
    const snapshot = '<div data-type="NodeList" data-node-id="list"><div data-type="NodeListItem" data-node-id="image-only">' +
        '<div data-type="NodeParagraph"><div contenteditable="true"><span data-type="img" class="img">' +
        '<img src="assets/result.png" alt="不显示的文件名"></span></div></div></div></div>';
    const env = setup(async url => url.endsWith("getBlockDOM") ? { dom: snapshot } : tree);
    try {
        await settle();
        env.setSettings({ enableHeadingDock: true, headingListDepth: 1 });
        await settle();
        const row = env.container.querySelector<HTMLButtonElement>('button[data-id="image-only"]')!;
        assert.ok(row);
        assert.equal(row.querySelector("img")?.getAttribute("src"), "assets/result.png");
        assert.equal(row.querySelector(".heading-outline-dock__text")?.textContent, "");
    } finally { env.cleanup(); }
});
