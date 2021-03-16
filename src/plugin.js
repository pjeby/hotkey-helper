import {Plugin, Keymap, Setting, debounce} from "obsidian";
import {around} from "monkey-around";

function hotkeyToString(hotkey) {
    return Keymap.compileModifiers(hotkey.modifiers)+"," + hotkey.key.toLowerCase()
}

function pluginSettingsAreOpen(app) {
    return (
        app.setting.containerEl.parentElement !== null &&
        app.setting.activeTab &&
        app.setting.activeTab.id === "third-party-plugins"
    );
}

export default class HotkeyHelper extends Plugin {

    onload() { this.app.workspace.onLayoutReady(this.whenReady.bind(this)); }

    whenReady() {
        const
            app = this.app,
            pluginsTab = app.setting.settingTabs.reduce(
                (last, tab)=> ((tab.id === "third-party-plugins" && tab) || last)
            )
        ;
        if (pluginsTab) {
            this.register(
                // Hook into the display() method of the community plugins settings tab
                around(pluginsTab, {display: this.hookPluginsDisplay.bind(this)})
            );

            // Now force a refresh if the tab is currently visible (to show our new buttons)
            function refreshTabIfOpen() {
                if (pluginSettingsAreOpen(app)) app.setting.openTabById("third-party-plugins");
            }
            refreshTabIfOpen();

            // And do it again after we unload (to remove the old buttons)
            this.register(() => setImmediate(refreshTabIfOpen));
        }
    }

    hookPluginsDisplay(old) {
        const plugin = this, app = this.app;

        // Refresh the buttons when commands are added or removed
        this.requestRefresh = debounce(this.refreshHotkeys.bind(this), 100, true);
        this.register(around(app.commands, {
            addCommand(old)    { return function(...args){ plugin.requestRefresh(); return old.apply(this, args); }; },
            removeCommand(old) { return function(...args){ plugin.requestRefresh(); return old.apply(this, args); }; }
        }));

        // Wrapper to inject "extra" buttons
        return function display(...args) {
            plugin.hotkeyButtons = {};  // reload settings map

            // Track which plugin each setting is for
            const manifests = Object.values(app.plugins.manifests);
            manifests.sort((e, t) => e.name.localeCompare(t.name));
            let which = 0;

            // Trap the addition of the "uninstall" buttons next to each plugin
            const remove = around(Setting.prototype, {
                addExtraButton(old) {
                    return function(...args) {
                        // The only "extras" added to settings w/a description are on the plugins, currently,
                        // so only try to match those to plugin names
                        if (this.descEl.childElementCount) {
                            if ( (manifests[which]||{}).name === this.nameEl.textContent ) {
                                old.call(this, btn => {
                                    const manifest = manifests[which++], plugin_id = manifest.id;
                                    plugin.hotkeyButtons[plugin_id] = btn;
                                    btn.setIcon("any-key")
                                    btn.onClick(() => plugin.searchHotkeysBy(manifest.name+":"))
                                })
                            }
                        };
                        return old.apply(this, args);
                    }
                }
            });

            try {
                const result = old.apply(this, args);
                plugin.refreshHotkeys(true);
                return result;
            } finally {
                remove();
            }
        }
    }

    searchHotkeysBy(search) {
        this.app.setting.openTabById("hotkeys");
        const tab = this.app.setting.activeTab;
        if (tab && tab.searchInputEl && tab.updateHotkeyVisibility) {
            tab.searchInputEl.value = search;
            tab.updateHotkeyVisibility();
        }
    }

    refreshHotkeys(force=false) {
        // Don't refresh when not displaying, unless rendering is in progress
        if (!pluginSettingsAreOpen(this.app) && !force) return;

        const hkm = this.app.hotkeyManager;
        const assignedKeyCount = {};

        // Get a list of commands by plugin
        const commands = Object.values(this.app.commands.commands).reduce((cmds, cmd)=>{
            const pid = cmd.id.split(":",2).shift();
            const hotkeys = (hkm.getHotkeys(cmd.id) || hkm.getDefaultHotkeys(cmd.id) || []).map(hotkeyToString);
            hotkeys.forEach(k => assignedKeyCount[k] = 1 + (assignedKeyCount[k]||0));
            (cmds[pid] || (cmds[pid]=[])).push({hotkeys, cmd});
            return cmds;
        }, {});

        for(const id of Object.keys(this.hotkeyButtons || {})) {
            const btn = this.hotkeyButtons[id];
            if (!this.app.plugins.plugins[id] || !commands[id]) {
                // Plugin is disabled or has no commands
                btn.extraSettingsEl.hide();
                continue;
            }
            const assigned = commands[id].filter(info => info.hotkeys.length);
            const conflicts = assigned.filter(info => info.hotkeys.filter(k => assignedKeyCount[k]>1).length).length;

            btn.setTooltip(`Configure hotkeys${"\n"}(${assigned.length}/${commands[id].length} assigned${conflicts ? "; "+conflicts+" conflicts" : ""})`);
            btn.extraSettingsEl.toggleClass("mod-error", !!conflicts);
            btn.extraSettingsEl.show();
        }
    }
}
