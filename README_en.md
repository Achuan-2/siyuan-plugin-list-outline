# List Outline

Right-click a heading or list entry to insert a sibling above or below it. A heading inserted below follows the entire current section, matching SiYuan's native outline behavior. List items preserve their list type; new tasks start unchecked. New blocks are empty and focused for typing. The list panel prefers the blank space to the right of the list, falling back to the editor's right edge when space is limited.

The plugin provides independently switchable floating heading and list outlines. Both are enabled by default. The heading outline follows the current document and uses SiYuan's native `/api/outline/getDocOutline` tree, heading levels, and numbering. Hover to expand labels, click to navigate, and scroll to highlight the current heading. Folded headings use the native block-fold check before navigation. Heading depth is independent of the list depth setting. Both outlines show each label on one line, with an ellipsis when it exceeds the available width.

Enable “Show lists” in the heading panel or its plugin setting to include list items beneath their headings in document order. This option defaults to off and is saved automatically. It respects global and per-list depth, excludes blockquotes, and works independently of the floating list panel. Mixed list entries support navigation and sibling insertion too.

A SiYuan plugin that displays compact outline lines at the upper-right corner of a hovered list. Hover over the lines to expand the labels and depth settings; move away to collapse them.

- Supports ordered, unordered, task, and nested lists.
- Outlines remain visible while lists stay in the viewport, and hide automatically when scrolled out of view.
- Search and filter list items in real time with keyword highlighting; press Escape to clear search, and search resets automatically when collapsed.
- Option to hide the list outline if the list has no child blocks (nested sub-lists, blockquotes, code blocks, extra paragraphs, etc.) (`listOutlineRequireChildren`).
- Lists inside blockquotes are excluded from the outline and do not trigger a separate panel.
- Defaults to 3 levels. Labels fit one line and overflow with an ellipsis; hover for the full text.
- Configure global depth (1–20) in plugin settings. The character limit setting has been removed; older character limits are ignored.
- Choose a depth in the floating panel to override the current list, or restore the global default.
- Click an entry to navigate to its list item.
- The outermost list and its nested lists share one outline. Only list items add levels; additional paragraphs and block metadata do not.
- Requires a mouse or another pointer with hover support; no dedicated touch-only entry point is provided.

Global settings are saved in `settings.json`. Per-list depth is saved as the list block attribute `custom-list-outline-depth`. Restoring the default clears this attribute without rewriting list content.

## Development

```sh
pnpm install
pnpm test
pnpm typecheck
pnpm build
```

`pnpm build` generates `dist/` and `package.zip`, then automatically copies `dist/` to the SiYuan workspace at `data/plugins/siyuan-plugin-list-outline/`. Enable the plugin after the first sync. The package can also be installed in another workspace.

`pnpm dev` watches changes and copies `dev/` after every build. Both modes wait for static assets to finish writing. Set `SIYUAN_PLUGIN_DIR` to override the plugins directory in `scripts/make_dev_copy.js`. Sync failures are reported separately; retry with `pnpm make_dev_copy dist` or `pnpm make_dev_copy dev`.

DOM tests do not replace interaction checks inside the SiYuan client.

Based on [plugin-sample-vite-svelte](https://github.com/siyuan-note/plugin-sample-vite-svelte/).
