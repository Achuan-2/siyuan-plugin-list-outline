import { Plugin, Dialog, fetchSyncPost, openTab, openMobileFileById, getFrontend, showMessage } from "siyuan";
import "./index.scss";
import SettingPanel from "./SettingPanel.svelte";
import { normalizeSettings, type OutlineSettings } from "./defaultSettings";
import { ListOutlineController } from "./listOutline";

export const SETTINGS_FILE = "settings.json";

export default class ListOutlinePlugin extends Plugin {
    settings: OutlineSettings = normalizeSettings();
    private outline?: ListOutlineController;
    private disposed = false;
    private settingsQueue: Promise<unknown> = Promise.resolve();
    private dialogs = new Set<Dialog>();

    async onload() {
        this.disposed = false;
        try {
            this.settings = normalizeSettings(await this.loadData(SETTINGS_FILE) || {});
        } catch (error) {
            console.error("列表大纲：加载设置失败", error);
        }
        if (this.disposed) return;
        this.outline = new ListOutlineController({
            getSettings: () => this.settings,
            request: async (url, data) => {
                const response = await fetchSyncPost(url, data);
                if (!response || response.code !== 0) throw new Error(response?.msg || "请求失败");
                return response.data;
            },
            navigate: id => {
                if (getFrontend().includes("mobile")) {
                    openMobileFileById(this.app, id, ["cb-get-hl"]);
                } else {
                    void openTab({ app: this.app, doc: { id, action: ["cb-get-hl"] } });
                }
            },
            reportError: message => showMessage(message, 5000, "error"),
        });
    }

    onunload() {
        this.disposed = true;
        this.outline?.destroy();
        this.outline = undefined;
        this.dialogs.forEach(dialog => dialog.destroy());
        this.dialogs.clear();
    }

    async saveSettings(settings: OutlineSettings) {
        const next = normalizeSettings(settings);
        const save = this.settingsQueue.then(async () => {
            await this.saveData(SETTINGS_FILE, next);
            this.settings = next;
            this.outline?.refreshSettings();
        });
        this.settingsQueue = save.catch(() => {});
        await save;
        return next;
    }

    openSetting() {
        let panel: SettingPanel;
        const dialog = new Dialog({
            title: "列表大纲设置",
            content: '<div class="list-outline-settings"></div>',
            width: "560px",
            destroyCallback: () => {
                panel?.$destroy();
                this.dialogs.delete(dialog);
            },
        });
        panel = new SettingPanel({
            target: dialog.element.querySelector(".list-outline-settings"),
            props: { plugin: this },
        });
        this.dialogs.add(dialog);
    }
}
