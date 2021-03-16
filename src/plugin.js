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

    onload() {
        const workspace = this.app.workspace;

        this.registerEvent( workspace.on("plugin-settings:before-display", () => {
            this.hotkeyButtons = {};
            this.configButtons = {};
        }) );
        this.registerEvent( workspace.on("plugin-settings:after-display",  () => this.refreshButtons(true)) );
        this.registerEvent( workspace.on("plugin-settings:plugin-control", (setting, manifest, enabled) => {
            setting.addExtraButton(btn => {
                btn.setIcon("gear");
                btn.onClick(() => this.showConfigFor(manifest.id))
                btn.setTooltip("Options");
                btn.extraSettingsEl.toggle(enabled)
                this.configButtons[manifest.id] = btn;
            });
            setting.addExtraButton(btn => {
                btn.setIcon("any-key");
                btn.onClick(() => this.showHotkeysFor(manifest.name+":"))
                btn.extraSettingsEl.toggle(enabled)
                this.hotkeyButtons[manifest.id] = btn;
            });
        }) );

        // Refresh the buttons when commands or setting tabs are added or removed
        const requestRefresh = debounce(this.refreshButtons.bind(this), 50, true);
        function refresher(old) { return function(...args){ requestRefresh(); return old.apply(this, args); }; }
        this.register(around(app.commands, {addCommand:   refresher, removeCommand:   refresher}));
        this.register(around(app.setting,  {addPluginTab: refresher, removePluginTab: refresher}));

        workspace.onLayoutReady(this.whenReady.bind(this));
    }

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
                around(pluginsTab, {display: this.addPluginSettingEvents.bind(this)})
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

    addPluginSettingEvents(old) {
        const app = this.app;
        let in_event = false;

        function trigger(...args) {
            in_event = true;
            try { app.workspace.trigger(...args); } catch(e) { console.error(e); }
            in_event = false;
        }

        // Wrapper to add plugin-settings events
        return function display(...args) {
            if (in_event) return;
            trigger("plugin-settings:before-display", this);

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
                        if (this.descEl.childElementCount && !in_event) {
                            if ( (manifests[which]||{}).name === this.nameEl.textContent ) {
                                const manifest = manifests[which++], enabled = !!app.plugins.plugins[manifest.id];
                                trigger("plugin-settings:plugin-control", this, manifest, enabled);
                            }
                        };
                        return old.apply(this, args);
                    }
                }
            });

            try {
                return old.apply(this, args);
            } finally {
                remove();
                trigger("plugin-settings:after-display", this);
            }
        }
    }

    showHotkeysFor(search) {
        this.app.setting.openTabById("hotkeys");
        const tab = this.app.setting.activeTab;
        if (tab && tab.searchInputEl && tab.updateHotkeyVisibility) {
            tab.searchInputEl.value = search;
            tab.updateHotkeyVisibility();
        }
    }

    showConfigFor(id) {
        this.app.setting.openTabById(id);
    }

    refreshButtons(force=false) {
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

        // Plugin setting tabs by plugin
        const tabs = Object.values(this.app.setting.pluginTabs).reduce((tabs, tab)=> {
            tabs[tab.id] = tab; return tabs
        }, {});

        for(const id of Object.keys(this.configButtons || {})) {
            const btn = this.configButtons[id];
            if (!this.app.plugins.plugins[id] || !tabs[id]) {
                btn.extraSettingsEl.hide();
                continue;
            }
            btn.extraSettingsEl.show();
        }

        for(const id of Object.keys(this.hotkeyButtons || {})) {
            const btn = this.hotkeyButtons[id];
            if (!this.app.plugins.plugins[id] || !commands[id]) {
                // Plugin is disabled or has no commands
                btn.extraSettingsEl.hide();
                continue;
            }
            const assigned = commands[id].filter(info => info.hotkeys.length);
            const conflicts = assigned.filter(info => info.hotkeys.filter(k => assignedKeyCount[k]>1).length).length;

            btn.setTooltip(
                `Configure hotkeys${"\n"}(${assigned.length}/${commands[id].length} assigned${
                    conflicts ? "; "+conflicts+" conflicting" : ""
                })`
            );
            btn.extraSettingsEl.toggleClass("mod-error", !!conflicts);
            btn.extraSettingsEl.show();
        }
    }
}
