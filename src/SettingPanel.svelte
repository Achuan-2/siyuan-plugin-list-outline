<script lang="ts">
    import SettingPanel from './libs/components/setting-panel.svelte';
    import { getDefaultSettings, MAX_DEPTH } from './defaultSettings';
    import { showMessage } from 'siyuan';
    import type ListOutlinePlugin from './index';
    export let plugin: ListOutlinePlugin;

    let settings = { ...plugin.settings };
    let saving = false;
    $: items = [
        { key: 'enableHeadingOutline', type: 'checkbox', value: settings.enableHeadingOutline,
          title: '悬浮标题大纲', description: '在当前文档右侧显示悬浮标题目录，悬停线条展开内容，点击定位标题。' },
        { key: 'enableHeadingDock', type: 'checkbox', value: settings.enableHeadingDock,
          title: '右侧标题大纲 Dock', description: '在右侧栏注册一个独立的标题大纲 Dock 面板，持久常驻显示当前文档大纲。' },
        { key: 'headingOutlineDisplayMode', type: 'select', value: settings.headingOutlineDisplayMode,
          options: { compact: '省略列表型', icon: '图标型' },
          title: '电脑端悬浮标题大纲样式', description: '选择省略列表型，或使用和移动端相同的单按钮样式；按钮可悬浮或点击展开标题大纲。' },
        { key: 'enableListOutline', type: 'checkbox', value: settings.enableListOutline,
          title: '悬浮列表大纲', description: '列表处于可视区域内时在右侧显示该列表的大纲；不提取引述块中的列表项。' },
        { key: 'listOutlineRequireChildren', type: 'checkbox', value: settings.listOutlineRequireChildren,
          title: '无子级时不显示列表大纲', description: '列表仅有单层无子块（如子列表、引述块、代码块、附加段落等）时不显示悬浮列表大纲，包含子块时显示。' },
        { key: 'headingListDepth', type: 'select', value: String(settings.headingListDepth),
          options: Object.fromEntries(Array.from({ length: MAX_DEPTH + 1 }, (_, depth) =>
            [String(depth), depth === 0 ? '不显示列表' : `显示 ${depth} 层列表`])),
          title: '标题大纲列表层级', description: '选择不显示列表，或在所属标题下显示指定层级的列表项；列表块的独立层级设置仍优先生效。' },
        { key: 'defaultDepth', type: 'number', value: settings.defaultDepth,
          title: '列表默认大纲层级', description: `显示前多少层列表项，范围 1–${MAX_DEPTH}；单独设置过的列表不受影响。` },
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
            <span class="b3-label__text">修改后自动保存，各项功能独立生效。</span>
            <button class="b3-button b3-button--outline" on:click={() => save(getDefaultSettings())}>恢复默认</button>
        </div>
    </fieldset>
</div>

<style>
    .settings { padding: 8px 16px 20px; }
    fieldset { border: 0; margin: 0; padding: 0; min-width: 0; }
    .footer { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 16px 8px 0; }
</style>
