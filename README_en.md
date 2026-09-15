# List Outline

A SiYuan plugin that displays compact outline lines at the upper-right corner of a hovered list. Hover over the lines to expand the labels and depth settings; move away to collapse them.

- Supports ordered, unordered, task, and nested lists.
- Lists inside blockquotes are excluded from the outline and do not trigger a separate panel.
- Defaults to 3 levels and 20 characters per entry. Longer labels end in an ellipsis; hover for the full text.
- Configure global depth (1–20) and label length (1–200) in plugin settings.
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
