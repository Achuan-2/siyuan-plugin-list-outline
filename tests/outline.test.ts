import { strict as assert } from "node:assert";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { compile } from "sass";
import { fileURLToPath } from "node:url";
import { blockDepth, DEPTH_ATTRIBUTE, extractOutline, findList, hasChildBlocks } from "../src/outline";
import { createOutlineRow } from "../src/outlineView";
import { getDefaultSettings, normalizeSettings } from "../src/defaultSettings";
import { ListOutlineController } from "../src/listOutline";

const paragraph = (text: string) => `<div data-type="NodeParagraph"><div contenteditable="true">${text}</div></div>`;
const item = (id: string, text: string, children = "") => `<div data-type="NodeListItem" data-node-id="${id}"><div class="protyle-action">1.</div>${paragraph(text)}${children}<div class="protyle-attr">备注</div></div>`;
const list = (id: string, children: string) => `<div data-type="NodeList" data-node-id="${id}">${children}</div>`;
const quote = (children: string) => `<div data-type="NodeBlockquote">${children}</div>`;
const outlineCss = compile(fileURLToPath(new URL("../src/index.scss", import.meta.url))).css;
const nested = list("root", item("one", "父项 <strong>加粗</strong>", paragraph("附加段落不应进入标题") +
    list("child-list", item("two", "子项", '<div data-type="NodeSuperBlock">' + list("grand-list", item("three", "孙项")) + '</div>'))) + item("four", "兄弟项"));

test("仅列表项生成层级，父标题不包含子列表、附加段落和块属性", () => {
    const document = new JSDOM(nested).window.document;
    assert.deepEqual(extractOutline(document.body.firstElementChild as HTMLElement, 3), [
        { id: "one", text: "父项 加粗", depth: 1 },
        { id: "two", text: "子项", depth: 2 },
        { id: "three", text: "孙项", depth: 3 },
        { id: "four", text: "兄弟项", depth: 1 },
    ]);
    assert.deepEqual(extractOutline(document.body.firstElementChild as HTMLElement, 1).map(entry => entry.id), ["one", "four"]);
});

test("空项、图片、公式、任务标记与 HTML 文本", () => {
    const document = new JSDOM(list("root", item("empty", "\u200b") + item("image", '<img alt="图片说明">') +
        item("math", '<span data-type="inline-math" data-content="x+y"><span>渲染副本</span></span>') + item("html", '&lt;img onerror=alert(1)&gt;'))).window.document;
    assert.deepEqual(extractOutline(document.body.firstElementChild as HTMLElement, 2).map(entry => entry.text), [
        "（空列表项）", "图片说明", "x+y", "<img onerror=alert(1)>",
    ]);
});

test("跳过引述块中的列表及其后代，保留正常子列表", () => {
    const document = new JSDOM(list("root", item("parent", "父项", quote(
        list("quoted", item("excluded", "引述列表", list("deep-quote", item("excluded-deep", "引述后代"))))) +
        list("normal", item("included", "正常子项"))))).window.document;
    assert.deepEqual(extractOutline(document.body.firstElementChild as HTMLElement, 3), [
        { id: "parent", text: "父项", depth: 1 }, { id: "included", text: "正常子项", depth: 2 },
    ]);
    assert.deepEqual(extractOutline(document.querySelector('[data-node-id="quoted"]')!, 3), []);
});

test("引述中的文字不会作为列表项标题，独立引述列表不触发大纲", () => {
    const document = new JSDOM(`<div class="protyle-wysiwyg">${quote(list("quoted", item("excluded", "引述列表")))}${list("root",
        `<div data-type="NodeListItem" data-node-id="parent">${quote(paragraph("引述文字"))}${paragraph("自己的标题")}</div>`)}${list("outer", item("outer-item", "外部列表", quote(list("inner-quote", item("quoted-item", "引述中的子列表")))))}</div>`).window.document;
    assert.equal(findList(document.querySelector('[data-node-id="excluded"]')!), null);
    assert.equal(findList(document.querySelector('[data-node-id="quoted-item"]')!)?.dataset.nodeId, "outer");
    assert.equal(extractOutline(document.querySelector('[data-node-id="root"]')!, 3)[0].text, "自己的标题");
});

test("大纲保留完整标题，按可用宽度单行省略", () => {
    const env = setup();
    try {
        const title = "很长的列表和标题内容👨‍👩‍👧‍👦".repeat(20);
        const row = createOutlineRow({ id: "long", text: title, depth: 2 });
        env.panel.append(row);
        const text = row.querySelector<HTMLElement>('.list-outline-floating__text')!;
        assert.equal(text.textContent, title);
        assert.equal(row.title, title);
        const style = env.win.getComputedStyle(text);
        assert.equal(style.whiteSpace, "nowrap");
        assert.equal(style.textOverflow, "ellipsis");
        assert.equal(style.minWidth, "0px");
    } finally { env.cleanup(); }
});

test("异常设置恢复默认，独立块层级只接受有效整数", () => {
    assert.deepEqual(normalizeSettings({ defaultDepth: 0 }), getDefaultSettings());
    assert.deepEqual(normalizeSettings({ defaultDepth: 99 }), { ...getDefaultSettings(), defaultDepth: 20 });
    const legacySettings = { ...getDefaultSettings(), maxTextLength: 2 };
    assert.deepEqual(normalizeSettings(legacySettings), getDefaultSettings());
    for (const value of [null, "", "0", "-1", "1.5", "21", "abc"]) assert.equal(blockDepth(value), null);
    assert.equal(blockDepth("4"), 4);
});

test("同一列表内移动保持根列表，非编辑器区域不触发", () => {
    const document = new JSDOM(`<div class="protyle-wysiwyg">${nested}</div>${list("outside", item("outside-item", "外部"))}`).window.document;
    assert.equal(findList(document.querySelector('[data-node-id="three"]')!)?.dataset.nodeId, "root");
    assert.equal(findList(document.querySelector('[data-node-id="outside-item"]')!), null);
});

function setup(request?: (url: string, data: any) => Promise<any>, getSettings?: () => any) {
    const dom = new JSDOM(`<div class="protyle-content"><div class="protyle-wysiwyg">${nested}${list("other", item("other-item", "另一列表"))}</div></div>`, { pretendToBeVisual: true });
    const win = dom.window;
    const style = win.document.createElement("style");
    style.textContent = outlineCss;
    win.document.head.append(style);
    for (const key of ["window", "document", "Element", "Node", "HTMLElement", "DOMParser", "MutationObserver", "Option"]) {
        Object.defineProperty(globalThis, key, { value: key === "window" ? win : (win as any)[key], configurable: true, writable: true });
    }
    Object.assign(globalThis, {
        requestAnimationFrame: win.requestAnimationFrame.bind(win),
        cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
        ResizeObserver: class { observe() {} disconnect() {} },
    });
    win.HTMLElement.prototype.getClientRects = function () { return [this.getBoundingClientRect()] as any; };
    win.HTMLElement.prototype.getBoundingClientRect = () => ({ x: 40, y: 40, left: 40, right: 800, top: 40, bottom: 600, width: 760, height: 560, toJSON() {} });
    const writes: any[] = [];
    const errors: string[] = [];
    const menus: any[] = [];
    const controller = new ListOutlineController({
        getSettings: getSettings || (() => ({ ...getDefaultSettings(), enableHeadingOutline: false, defaultDepth: 3 })),
        request: request || (async (url, data) => {
            if (url.endsWith("setBlockAttrs")) { writes.push(data); return null; }
            if (url.endsWith("getBlockAttrs")) return {};
            return { dom: win.document.querySelector(`[data-node-id="${data.id}"]`)?.outerHTML };
        }),
        navigate: () => {}, reportError: message => errors.push(message),
        openInsertMenu: (event, target) => { event.preventDefault(); menus.push(target); },
    });
    const hover = (id: string) => win.document.querySelector(`[data-node-id="${id}"]`)!.dispatchEvent(new win.MouseEvent("pointerover", { bubbles: true }));
    const panel = win.document.querySelector<HTMLElement>(".list-outline-floating")!;
    const cleanup = () => { controller.destroy(); win.close(); };
    return { win, controller, hover, panel, writes, errors, menus, cleanup };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 30));

test("悬浮显示、独立层级保存及清除，卸载移除面板与监听", async () => {
    const env = setup();
    try {
        env.hover("one");
        await settle();
        assert.equal(env.panel.hidden, false);
        assert.equal(env.panel.querySelectorAll("button").length, 4);
        const select = env.panel.querySelector("select")!;
        select.value = "1";
        select.dispatchEvent(new env.win.Event("change"));
        await settle();
        assert.deepEqual(env.writes[0], { id: "root", attrs: { [DEPTH_ATTRIBUTE]: "1" } });
        assert.equal(env.panel.querySelectorAll("button").length, 2);
        select.value = "";
        select.dispatchEvent(new env.win.Event("change"));
        await settle();
        assert.equal(env.writes[1].attrs[DEPTH_ATTRIBUTE], "");
        assert.equal(env.panel.querySelectorAll("button").length, 4);
        env.controller.destroy();
        env.hover("one");
        assert.equal(env.win.document.querySelector(".list-outline-floating"), null);
    } finally { env.cleanup(); }
});

test("可视区域内多个列表各自显示大纲，异步请求互不干扰", async () => {
    let resolveOld: (value: any) => void = () => {};
    const env = setup(async (url, data) => {
        if (url.endsWith("getBlockAttrs")) return {};
        if (data.id === "root") return await new Promise(resolve => { resolveOld = resolve; });
        return { dom: list("other", item("other-item", "另一列表")) };
    });
    try {
        await settle();
        const panels = Array.from(env.win.document.querySelectorAll<HTMLElement>(".list-outline-floating"));
        assert.equal(panels.length, 2);
        const rootPanel = panels.find(p => p.dataset.listId === "root")!;
        const otherPanel = panels.find(p => p.dataset.listId === "other")!;
        assert.equal(otherPanel.querySelectorAll("button").length, 1);
        assert.equal(otherPanel.querySelector("button")?.dataset.id, "other-item");
        resolveOld({ dom: nested });
        await settle();
        assert.equal(otherPanel.querySelectorAll("button").length, 1);
        assert.equal(otherPanel.querySelector("button")?.dataset.id, "other-item");
        assert.equal(rootPanel.querySelectorAll("button").length, 4);
    } finally { env.cleanup(); }
});

test("保存失败恢复选择，不修改列表块属性", async () => {
    const env = setup(async url => {
        if (url.endsWith("setBlockAttrs")) throw new Error("模拟保存失败");
        if (url.endsWith("getBlockAttrs")) return {};
        return { dom: nested };
    });
    try {
        env.hover("one");
        await settle();
        const select = env.panel.querySelector("select")!;
        select.value = "2";
        select.dispatchEvent(new env.win.Event("change"));
        await settle();
        assert.equal(select.value, "");
        assert.equal(select.disabled, false);
        assert.equal(env.win.document.querySelector('[data-node-id="root"]')?.hasAttribute(DEPTH_ATTRIBUTE), false);
        assert.equal(env.errors.length, 1);
    } finally { env.cleanup(); }
});

test("编辑后刷新，离开列表块后大纲保持显示，滚动出可视区后隐藏", async () => {
    const env = setup();
    try {
        env.hover("one");
        await settle();
        const text = env.win.document.querySelector('[data-node-id="one"] [contenteditable]')!;
        text.textContent = "修改后的标题";
        await settle();
        assert.equal(env.panel.querySelector("button")?.title, "修改后的标题");

        // 鼠标移出列表块到外部：大纲不隐藏，依然显示
        env.win.document.body.dispatchEvent(new env.win.MouseEvent("pointerover", { bubbles: true }));
        await new Promise(resolve => setTimeout(resolve, 280));
        assert.equal(env.panel.hidden, false);

        // 列表滚动离开可视区域后隐藏
        const root = env.win.document.querySelector<HTMLElement>('[data-node-id="root"]')!;
        root.getBoundingClientRect = () => ({ x: 40, y: -900, left: 40, right: 800, top: -900, bottom: -100, width: 760, height: 800, toJSON() {} });
        env.win.document.querySelector('.protyle-content')!.dispatchEvent(new env.win.Event("scroll"));
        await settle();
        assert.equal(env.panel.hidden, true);

        // 列表滚回可视区域后恢复显示
        root.getBoundingClientRect = () => ({ x: 40, y: 40, left: 40, right: 800, top: 40, bottom: 600, width: 760, height: 560, toJSON() {} });
        env.win.document.querySelector('.protyle-content')!.dispatchEvent(new env.win.Event("scroll"));
        await settle();
        assert.equal(env.panel.hidden, false);
    } finally { env.cleanup(); }
});

test("剪切列表后不再使用已删除的块 ID 请求快照", async () => {
    const calls: Array<{ url: string; id: string }> = [];
    const env = setup(async (url, data) => {
        calls.push({ url, id: data.id });
        if (url.endsWith("getBlockAttrs")) return {};
        return { dom: nested };
    });
    try {
        await settle();
        calls.length = 0;
        const root = env.win.document.querySelector<HTMLElement>('[data-node-id="root"]')!;
        const view = Array.from((env.controller as any).views.values())
            .find((candidate: any) => candidate.active === root);
        root.remove();

        // 模拟剪切事务与视图清理之间已经排队的延迟刷新。
        await (view as any).loadSnapshot();
        await settle();
        assert.deepEqual(calls, []);
        assert.equal(env.win.document.querySelector('[data-list-id="root"]'), null);
    } finally { env.cleanup(); }
});

test("服务端快照补齐编辑器中尚未渲染的折叠子列表", async () => {
    const env = setup(async url => url.endsWith("getBlockAttrs") ? {} : { dom: nested });
    try {
        env.win.document.querySelector('[data-node-id="child-list"]')!.remove();
        env.hover("one");
        assert.equal(env.panel.querySelectorAll("button").length, 2);
        await settle();
        assert.equal(env.panel.querySelectorAll("button").length, 4);
    } finally { env.cleanup(); }
});

test("鼠标移入悬浮面板不会关闭大纲", async () => {
    const env = setup();
    try {
        env.hover("one");
        env.win.document.querySelector('[data-node-id="one"]')!.dispatchEvent(
            new env.win.MouseEvent("pointerout", { bubbles: true, relatedTarget: env.panel }));
        env.panel.dispatchEvent(new env.win.MouseEvent("pointerover", { bubbles: true }));
        await new Promise(resolve => setTimeout(resolve, 280));
        assert.equal(env.panel.hidden, false);
    } finally { env.cleanup(); }
});

test("列表线条随鼠标与光标高亮，隐藏层级回退父项，渲染后保留高亮", async () => {
    const env = setup();
    try {
        env.hover("two");
        await settle();
        const current = () => env.panel.querySelector<HTMLButtonElement>('[aria-current="location"]')?.dataset.id;
        assert.equal(current(), "two");
        assert.equal(env.panel.querySelectorAll('.list-outline-floating__current').length, 1);
        const line = env.panel.querySelector<HTMLElement>('[data-id="two"] .list-outline-floating__line')!;
        assert.equal(env.win.getComputedStyle(line).opacity, "1");
        const text = env.win.document.querySelector('[data-node-id="four"] [contenteditable]')!.firstChild!;
        const selection = env.win.document.getSelection()!;
        selection.collapse(text, 1);
        env.win.document.dispatchEvent(new env.win.Event("selectionchange"));
        await settle();
        assert.equal(current(), "four");
        env.hover("three");
        await settle();
        assert.equal(current(), "three");
        const select = env.panel.querySelector("select")!;
        select.value = "1";
        select.dispatchEvent(new env.win.Event("change"));
        await settle();
        assert.equal(current(), "one");
        env.controller.refreshSettings();
        await settle();
        assert.equal(current(), "one");
    } finally { env.cleanup(); }
});

test("列表随编辑区滚动更新高亮，大纲自身滚动不改变当前位置", async () => {
    const env = setup();
    try {
        env.hover("two");
        await settle();
        const current = () => env.panel.querySelector<HTMLButtonElement>('[aria-current="location"]')?.dataset.id;
        assert.equal(current(), "two");
        const tops = { one: -200, two: -150, three: -100, four: 50 };
        for (const [id, top] of Object.entries(tops)) {
            env.win.document.querySelector<HTMLElement>(`[data-node-id="${id}"]`)!.getBoundingClientRect = () =>
                ({ x: 40, y: top, left: 40, top, right: 700, bottom: top + 50, width: 660, height: 50, toJSON() {} });
        }
        env.win.document.querySelector('.protyle-content')!.dispatchEvent(new env.win.Event("scroll"));
        await settle();
        assert.equal(current(), "four");
        env.panel.querySelector('.list-outline-floating__body')!.dispatchEvent(new env.win.Event("scroll"));
        await settle();
        assert.equal(current(), "four");
    } finally { env.cleanup(); }
});

test("列表右键锁定对应项，列表大纲放到正文右侧留白", async () => {
    const env = setup();
    try {
        const root = env.win.document.querySelector<HTMLElement>('[data-node-id="root"]')!;
        root.getBoundingClientRect = () => ({ x: 40, y: 40, left: 40, top: 40, right: 440, bottom: 600, width: 400, height: 560, toJSON() {} });
        env.hover("one");
        await settle();
        assert.equal(env.panel.style.left, "448px");
        env.panel.dispatchEvent(new env.win.MouseEvent("pointerover", { bubbles: true }));
        assert.equal(env.panel.style.left, "448px");
        const event = new env.win.MouseEvent("contextmenu", { bubbles: true, cancelable: true });
        env.panel.querySelector('[data-id="two"] span')!.dispatchEvent(event);
        assert.equal(event.defaultPrevented, true);
        assert.equal(env.menus[0].id, "two");
        assert.equal(env.menus[0].kind, "list");
    } finally { env.cleanup(); }
});

test("默认只显示层级线条，悬停展开文字和设置，离开后恢复线条且右边缘固定", async () => {
    const env = setup();
    try {
        const headingPanel = env.win.document.createElement("aside");
        headingPanel.className = "list-outline-floating heading-outline-floating";
        env.win.document.body.append(headingPanel);
        const zIndex = (element: HTMLElement) => Number(env.win.getComputedStyle(element).zIndex);
        env.hover("one");
        await settle();
        const header = env.panel.querySelector<HTMLElement>(".list-outline-floating__header")!;
        const text = env.panel.querySelector<HTMLElement>(".list-outline-floating__text")!;
        const line = env.panel.querySelector<HTMLElement>(".list-outline-floating__line")!;
        const right = () => parseFloat(env.panel.style.left) + parseFloat(env.panel.style.width);
        const compactRight = right();
        assert.ok(zIndex(env.panel) < zIndex(headingPanel));
        assert.equal(env.panel.style.width, "48px");
        assert.equal(env.win.getComputedStyle(header).display, "none");
        assert.equal(env.win.getComputedStyle(text).display, "none");
        assert.notEqual(env.win.getComputedStyle(line).display, "none");
        env.panel.dispatchEvent(new env.win.MouseEvent("pointerover", { bubbles: true }));
        assert.ok(zIndex(env.panel) > zIndex(headingPanel));
        headingPanel.classList.add("list-outline-floating--expanded");
        assert.ok(zIndex(env.panel) > zIndex(headingPanel));
        assert.equal(env.panel.style.width, "300px");
        assert.equal(right(), compactRight);
        assert.equal(env.win.getComputedStyle(header).display, "flex");
        assert.equal(env.win.getComputedStyle(text).display, "block");
        assert.equal(env.win.getComputedStyle(line).display, "none");
        env.panel.dispatchEvent(new env.win.MouseEvent("pointerout", { bubbles: true,
            relatedTarget: env.win.document.querySelector('[data-node-id="one"]') }));
        assert.equal(env.panel.hidden, false);
        assert.ok(zIndex(env.panel) < zIndex(headingPanel));
        assert.equal(env.panel.style.width, "48px");
        assert.equal(right(), compactRight);
        assert.equal(env.win.getComputedStyle(text).display, "none");
    } finally { env.cleanup(); }
});

test("列表右键打开菜单时离开大纲不关闭或收起，菜单关闭后恢复紧凑线条", async () => {
    const env = setup();
    try {
        let closeMenu: () => void = () => {};
        const openInsertMenu = (event: any, target: any, onInserted: any, onClose?: () => void) => {
            event.preventDefault();
            closeMenu = onClose || (() => {});
        };
        (env.controller as any).options.openInsertMenu = openInsertMenu;
        env.hover("one");
        await settle();
        assert.equal(env.panel.hidden, false);
        const event = new env.win.MouseEvent("contextmenu", { bubbles: true, cancelable: true });
        env.panel.querySelector('[data-id="two"] span')!.dispatchEvent(event);
        assert.equal(env.panel.style.width, "300px");
        assert.equal(env.panel.hidden, false);

        const outside = env.win.document.createElement("div");
        env.win.document.body.append(outside);
        env.panel.dispatchEvent(new env.win.MouseEvent("pointerout", { bubbles: true, relatedTarget: outside }));
        env.win.document.dispatchEvent(new env.win.MouseEvent("pointerover", { bubbles: true, target: outside } as any));
        env.win.document.dispatchEvent(new env.win.MouseEvent("pointerdown", { bubbles: true, target: outside } as any));
        await settle();
        assert.equal(env.panel.hidden, false);
        assert.equal(env.panel.style.width, "300px");

        closeMenu();
        await new Promise(resolve => setTimeout(resolve, 260));
        assert.equal(env.panel.hidden, false);
        assert.equal(env.panel.style.width, "48px");
    } finally { env.cleanup(); }
});

test("无子级判定：包含引述块、代码块、附加段落或子列表均视为包含子块", () => {
    const flatDOM = new JSDOM(list("f1", item("f1-1", "普通项1") + item("f1-2", "普通项2"))).window.document;
    assert.equal(hasChildBlocks(flatDOM.querySelector<HTMLElement>('[data-node-id="f1"]')!), false);

    const quoteDOM = new JSDOM(list("q1", item("q1-1", "项1", quote(paragraph("引述内容"))))).window.document;
    assert.equal(hasChildBlocks(quoteDOM.querySelector<HTMLElement>('[data-node-id="q1"]')!), true);

    const codeDOM = new JSDOM(list("c1", item("c1-1", "项1", '<div data-type="NodeCodeBlock"><pre>code</pre></div>'))).window.document;
    assert.equal(hasChildBlocks(codeDOM.querySelector<HTMLElement>('[data-node-id="c1"]')!), true);

    const multiParaDOM = new JSDOM(list("p1", item("p1-1", "标题段落", paragraph("第二段落")))).window.document;
    assert.equal(hasChildBlocks(multiParaDOM.querySelector<HTMLElement>('[data-node-id="p1"]')!), true);

    const nestedDOM = new JSDOM(nested).window.document;
    assert.equal(hasChildBlocks(nestedDOM.querySelector<HTMLElement>('[data-node-id="root"]')!), true);
});

test("设置仅有子块时显示列表大纲：单层纯文本列表隐藏，含引述块或子列表正常显示", async () => {
    let settings = { ...getDefaultSettings(), listOutlineRequireChildren: true };
    const env = setup(undefined, () => settings);
    try {
        await settle();
        const panels = Array.from(env.win.document.querySelectorAll<HTMLElement>(".list-outline-floating"));
        const rootPanel = panels.find(p => p.dataset.listId === "root")!;
        const otherPanel = panels.find(p => p.dataset.listId === "other")!;
        // root 包含子列表（one -> two -> three），正常显示
        assert.equal(rootPanel.hidden, false);
        // other 只有单层纯文本项（other-item），被隐藏
        assert.equal(otherPanel.hidden, true);

        // 给 other 列表项增加一个引述子块后，应当显示
        const otherItem = env.win.document.querySelector<HTMLElement>('[data-node-id="other-item"]')!;
        const quoteBlock = env.win.document.createElement("div");
        quoteBlock.setAttribute("data-type", "NodeBlockquote");
        quoteBlock.innerHTML = "<p>长引述内容</p>";
        otherItem.append(quoteBlock);
        env.controller.sync();
        await settle();
        assert.equal(otherPanel.hidden, false);

        // 关闭该设置后，即便无子块也恢复显示
        quoteBlock.remove();
        settings = { ...settings, listOutlineRequireChildren: false };
        env.controller.refreshSettings();
        await settle();
        assert.equal(otherPanel.hidden, false);
    } finally { env.cleanup(); }
});

test("列表大纲支持关键词搜索过滤、高亮匹配项及 Esc 清空", async () => {
    const env = setup();
    try {
        await settle();
        env.panel.dispatchEvent(new env.win.MouseEvent("pointerover", { bubbles: true }));
        assert.equal(env.panel.classList.contains("list-outline-floating--expanded"), true);

        const searchInput = env.panel.querySelector<HTMLInputElement>(".list-outline-floating__search-input")!;
        assert.ok(searchInput);

        // 初始状态包含全部 4 项
        let rows = env.panel.querySelectorAll<HTMLButtonElement>("button.list-outline-floating__item");
        assert.equal(rows.length, 4);

        // 输入 "孙项" 搜索
        searchInput.value = "孙项";
        searchInput.dispatchEvent(new env.win.Event("input"));
        await settle();

        rows = env.panel.querySelectorAll<HTMLButtonElement>("button.list-outline-floating__item");
        assert.equal(rows.length, 1);
        assert.equal(rows[0].dataset.id, "three");
        const match = rows[0].querySelector<HTMLElement>(".list-outline-floating__match")!;
        assert.ok(match);
        assert.equal(match.textContent, "孙项");

        // 搜索不存在的关键词
        searchInput.value = "不存在的内容";
        searchInput.dispatchEvent(new env.win.Event("input"));
        await settle();

        rows = env.panel.querySelectorAll<HTMLButtonElement>("button.list-outline-floating__item");
        assert.equal(rows.length, 0);
        const empty = env.panel.querySelector<HTMLElement>(".list-outline-floating__empty")!;
        assert.ok(empty);
        assert.equal(empty.textContent, "无匹配结果");

        // 按 Escape 清空输入框并恢复完整列表
        searchInput.dispatchEvent(new env.win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await settle();
        assert.equal(searchInput.value, "");
        rows = env.panel.querySelectorAll<HTMLButtonElement>("button.list-outline-floating__item");
        assert.equal(rows.length, 4);

        // 输入关键词后收起面板，再次展开时自动重置搜索
        searchInput.value = "子项";
        searchInput.dispatchEvent(new env.win.Event("input"));
        await settle();
        assert.equal(env.panel.querySelectorAll("button.list-outline-floating__item").length, 1);

        env.panel.dispatchEvent(new env.win.MouseEvent("pointerout", { bubbles: true, relatedTarget: env.win.document.body }));
        assert.equal(env.panel.classList.contains("list-outline-floating--expanded"), false);

        env.panel.dispatchEvent(new env.win.MouseEvent("pointerover", { bubbles: true }));
        assert.equal(searchInput.value, "");
        assert.equal(env.panel.querySelectorAll("button.list-outline-floating__item").length, 4);
    } finally { env.cleanup(); }
});

test("多个列表大纲垂直空间受各自列表块限制，滚动与相邻列表互不重叠", async () => {
    const env = setup();
    try {
        const rootEl = env.win.document.querySelector<HTMLElement>('[data-node-id="root"]')!;
        const otherEl = env.win.document.querySelector<HTMLElement>('[data-node-id="other"]')!;

        // 场景 1：两个列表都在可视区，各自大纲高度受自身列表 bottom 约束
        rootEl.getBoundingClientRect = () => ({ x: 40, y: 100, left: 40, right: 800, top: 100, bottom: 250, width: 760, height: 150, toJSON() {} });
        otherEl.getBoundingClientRect = () => ({ x: 40, y: 300, left: 40, right: 800, top: 300, bottom: 600, width: 760, height: 300, toJSON() {} });

        env.win.document.querySelector('.protyle-content')!.dispatchEvent(new env.win.Event("scroll"));
        await settle();

        const panels = Array.from(env.win.document.querySelectorAll<HTMLElement>(".list-outline-floating"));
        const rootPanel = panels.find(p => p.dataset.listId === "root")!;
        const otherPanel = panels.find(p => p.dataset.listId === "other")!;

        assert.equal(rootPanel.hidden, false);
        assert.equal(otherPanel.hidden, false);

        const rootTop = parseFloat(rootPanel.style.top);
        const rootMaxHeight = parseFloat(rootPanel.style.maxHeight);
        const otherTop = parseFloat(otherPanel.style.top);

        // root 大纲的底部（top + maxHeight）不超过 rootEl 的 bottom（250px），且位于 other 大纲上方
        assert.ok(rootTop + rootMaxHeight <= 250);
        assert.ok(rootTop + rootMaxHeight <= otherTop);

        // 场景 2：列表 1 向上滚动即将离开可视区，高度缩减；当剩余可用高度 < 12px 时自动隐藏
        rootEl.getBoundingClientRect = () => ({ x: 40, y: -400, left: 40, right: 800, top: -400, bottom: 15, width: 760, height: 415, toJSON() {} });
        otherEl.getBoundingClientRect = () => ({ x: 40, y: 40, left: 40, right: 800, top: 40, bottom: 400, width: 760, height: 360, toJSON() {} });

        env.win.document.querySelector('.protyle-content')!.dispatchEvent(new env.win.Event("scroll"));
        await settle();

        // 可用高度 = 15 - 8 = 7px < 12px，rootPanel 隐藏，避免残留在编辑区顶部
        assert.equal(rootPanel.hidden, true);
        assert.equal(otherPanel.hidden, false);
    } finally { env.cleanup(); }
});


