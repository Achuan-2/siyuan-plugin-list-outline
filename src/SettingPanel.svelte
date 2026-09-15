<script lang="ts">
    import SettingPanel from './libs/components/setting-panel.svelte';
    import { getDefaultSettings, MAX_DEPTH } from './defaultSettings';
    import { showMessage } from 'siyuan';
    import type ListOutlinePlugin from './index';
    export let plugin: ListOutlinePlugin;

    let settings = { ...plugin.settings };
    let saving = false;
    $: items = [
        { key: 'defaultDepth', type: 'number', value: settings.defaultDepth,
          title: '默认大纲层级', description: `显示前多少层列表项，范围 1–${MAX_DEPTH}；单独设置过的列表不受影响。` },
        { key: 'maxTextLength', type: 'number', value: settings.maxTextLength,
          title: '每项显示字数', description: '每个条目最多显示的字符数，范围 1–200；超出后显示省略号，悬停可查看全文。' },
    ] as ISettingItem[];

    async function save(next = settings) {
        saving = true;
        try {
            settings = { ...await plugin.saveSettings(next) };
        } catch (error) {
            console.error(error);
            settings = { ...plugin.settings };
            showMessage('列表大纲设置保存失败，请重试。', 5000, 'error');
        } finally {
            saving = false;
        }
    }
</script>

<div class="settings">
    <fieldset disabled={saving}>
        <SettingPanel group="列表大纲" settingItems={items} display={true}
            on:changed={event => save({ ...settings, [event.detail.key]: event.detail.value })} />
        <div class="footer">
            <span class="b3-label__text">修改后自动保存。列表右上角可单独选择层级。</span>
            <button class="b3-button b3-button--outline" on:click={() => save(getDefaultSettings())}>恢复默认</button>
        </div>
    </fieldset>
</div>

<style>
    .settings { padding: 8px 16px 20px; }
    fieldset { border: 0; margin: 0; padding: 0; min-width: 0; }
    .footer { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 16px 8px 0; }
</style>
