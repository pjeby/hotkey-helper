import {Plugin, Keymap, Setting, Modal, debounce} from "obsidian";
import {around} from "monkey-around";

function hotkeyToString(hotkey) {
    return Keymap.compileModifiers(hotkey.modifiers)+"," + hotkey.key.toLowerCase()
}

function isPluginTab(id) {
    return id === "plugins" || id === "third-party-plugins" || id === "community-plugins";
}

function pluginSettingsAreOpen(app) {
    return settingsAreOpen(app) && isPluginTab(app.setting.activeTab?.id)
}

function settingsAreOpen(app) {
    return app.setting.containerEl.parentElement !== null
}

function isPluginViewer(ob) {
    return (
        ob instanceof Modal &&
        ob.hasOwnProperty("autoload") &&
        typeof ob.showPlugin === "function" &&
        typeof ob.updateSearch === "function" &&
        typeof ob.searchEl == "object"
    );
}

function onElement(el, event, selector, callback, options=false) {
    el.on(event, selector, callback, options)
    return () => el.off(event, selector, callback, options);
}

export default class HotkeyHelper extends Plugin {

    onload() {
        const workspace = this.app.workspace;

        this.registerEvent( workspace.on("plugin-settings:before-display", (settingsTab, tabId) => {
            this.hotkeyButtons = {};
            this.configButtons = {};
            this.globalsAdded = false;
        }) );
        this.registerEvent( workspace.on("plugin-settings:after-display",  () => this.refreshButtons(true)) );

        this.registerEvent( workspace.on("plugin-settings:plugin-control", (setting, manifest, enabled, tabId) => {
            this.globalsAdded || this.addGlobals(tabId, setting.settingEl);
            this.createExtraButtons(setting, manifest, enabled);
        }) );

        // Refresh the buttons when commands or setting tabs are added or removed
        const requestRefresh = debounce(this.refreshButtons.bind(this), 50, true);
        function refresher(old) { return function(...args){ requestRefresh(); return old.apply(this, args); }; }
        this.register(around(app.commands, {addCommand:    refresher, removeCommand:    refresher}));
        this.register(around(app.setting,  {addPluginTab:  refresher, removePluginTab:  refresher}));
        this.register(around(app.setting,  {addSettingTab: refresher, removeSettingTab: refresher}));

        workspace.onLayoutReady(this.whenReady.bind(this));
    }

    whenReady() {
        const app = this.app;
        const corePlugins = this.getSettingsTab("plugins");
        const community = this.getSettingsTab("third-party-plugins") ?? this.getSettingsTab("community-plugins");

        // Hook into the display() method of the plugin settings tabs
        if (corePlugins) this.register(around(corePlugins, {display: this.addPluginSettingEvents.bind(this, corePlugins.id)}));
        if (community)   this.register(around(community,   {display: this.addPluginSettingEvents.bind(this, community.id)}));

        // Now force a refresh if either plugins tab is currently visible (to show our new buttons)
        function refreshTabIfOpen() {
            if (pluginSettingsAreOpen(app)) app.setting.openTabById(app.setting.activeTab.id);
        }
        refreshTabIfOpen();

        // And do it again after we unload (to remove the old buttons)
        this.register(() => setImmediate(refreshTabIfOpen));

        // Tweak the hotkey settings tab to make filtering work on id prefixes as well as command names
        const hotkeysTab = this.getSettingsTab("hotkeys");
        if (hotkeysTab) {
            this.register(around(hotkeysTab, {
                display(old) { return function() { old.call(this); this.searchInputEl.focus(); }; },
                updateHotkeyVisibility(old) {
                    return function() {
                        const oldSearch = this.searchInputEl.value, oldCommands = app.commands.commands;
                        try {
                            if (oldSearch.endsWith(":") && !oldSearch.contains(" ")) {
                                // This is an incredibly ugly hack that relies on updateHotkeyVisibility() iterating app.commands.commands
                                // looking for hotkey conflicts *before* anything else.
                                let current = oldCommands;
                                let filtered = Object.fromEntries(Object.entries(app.commands.commands).filter(
                                    ([id, cmd]) => (id+":").startsWith(oldSearch)
                                ));
                                this.searchInputEl.value = "";
                                app.commands.commands = new Proxy(oldCommands, {ownKeys(){
                                    // The first time commands are iterated, return the whole thing;
                                    // after that, return the filtered list
                                    try { return Object.keys(current); } finally { current = filtered; }
                                }});
                            }
                            return old.call(this);
                        } finally {
                            this.searchInputEl.value = oldSearch;
                            app.commands.commands = oldCommands;
                        }
                    }
                }
            }));
        }
    }

    createExtraButtons(setting, manifest, enabled) {
        setting.addExtraButton(btn => {
            btn.setIcon("gear");
            btn.onClick(() => this.showConfigFor(manifest.id.replace(/^workspace$/,"file")));
            btn.setTooltip("Options");
            btn.extraSettingsEl.toggle(enabled)
            this.configButtons[manifest.id] = btn;
        });
        setting.addExtraButton(btn => {
            btn.setIcon("any-key");
            btn.onClick(() => this.showHotkeysFor(manifest.id+":"))
            btn.extraSettingsEl.toggle(enabled)
            this.hotkeyButtons[manifest.id] = btn;
        });
    }

    // Add top-level items (search and pseudo-plugins)
    addGlobals(tabId, settingEl) {
        this.globalsAdded = true;

        // Add a search filter to shrink plugin list
        const containerEl = settingEl.parentElement;
        let inputEl;
        if (tabId !== "plugins") {
            // Replace the built-in search handler
            const original = inputEl = containerEl.parentElement?.find(".search-input-container input")
            if (original) {
                inputEl = original.cloneNode();
                original.parentElement.replaceChild(inputEl, original);
            }
        }
        inputEl = inputEl ?? containerEl.createDiv("hotkey-search-container").createEl(
            "input", {type: "text", attr: {placeholder:"Filter plugins...", spellcheck: "false"}}
        );
        inputEl.addEventListener("input", function(){
            const find = inputEl.value.toLowerCase();
            function matchAndHighlight(el) {
                const text = el.textContent = el.textContent; // clear previous highlighting, if any
                const index = text.toLowerCase().indexOf(find);
                if (!~index) return false;
                el.textContent = text.substr(0, index);
                el.createSpan("suggestion-highlight").textContent = text.substr(index, find.length);
                el.insertAdjacentText("beforeend", text.substr(index+find.length))
                return true;
            }
            containerEl.findAll(".setting-item").forEach(e => {
                const nameMatches = matchAndHighlight(e.find(".setting-item-name"));
                const descMatches = matchAndHighlight(
                    e.find(".setting-item-description > div:last-child") ??
                    e.find(".setting-item-description")
                );
                e.toggle(nameMatches || descMatches);
            });
        });
        setImmediate(() => {inputEl.focus()});
        containerEl.append(settingEl);

        if (tabId === "plugins") {
            const editorName    = this.getSettingsTab("editor")?.name || "Editor";
            const workspaceName = this.getSettingsTab("file")?.name   || "Files & Links";
            this.createExtraButtons(
                new Setting(settingEl.parentElement)
                    .setName("App").setDesc("Miscellaneous application commands (always enabled)"),
                {id: "app", name: "App"}, true
            );
            this.createExtraButtons(
                new Setting(settingEl.parentElement)
                    .setName(editorName).setDesc("Core editing commands (always enabled)"),
                {id: "editor", name: editorName}, true
            );
            this.createExtraButtons(
                new Setting(settingEl.parentElement)
                    .setName(workspaceName).setDesc("Core file and pane management commands (always enabled)"),
                {id: "workspace", name: workspaceName}, true
            );
            settingEl.parentElement.append(settingEl);
        }

    }

    getSettingsTab(id) { return this.app.setting.settingTabs.filter(t => t.id === id).shift(); }

    addPluginSettingEvents(tabId, old) {
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
            trigger("plugin-settings:before-display", this, tabId);

            // Track which plugin each setting is for
            let manifests;
            if (tabId === "plugins") {
                manifests = Object.entries(app.internalPlugins.plugins).map(
                    ([id, {instance: {name}, _loaded:enabled}]) => {return {id, name, enabled};}
                );
            } else {
                manifests = Object.values(app.plugins.manifests);
                manifests.sort((e, t) => e.name.localeCompare(t.name));
            }
            let which = 0;

            // Trap the addition of the "uninstall" buttons next to each plugin
            const remove = around(Setting.prototype, {
                addToggle(old) {
                    return function(...args) {
                        if (tabId === "plugins" && !in_event && (manifests[which]||{}).name === this.nameEl.textContent ) {
                            const manifest = manifests[which++];
                            trigger("plugin-settings:plugin-control", this, manifest, manifest.enabled, tabId);
                        }
                        return old.apply(this, args);
                    }
                },
                addExtraButton(old) {
                    return function(...args) {
                        // The only "extras" added to settings w/a description are on the plugins, currently,
                        // so only try to match those to plugin names
                        if (tabId !== "plugins" && this.descEl.childElementCount && !in_event) {
                            if ( (manifests[which]||{}).name === this.nameEl.textContent ) {
                                const manifest = manifests[which++], enabled = !!app.plugins.plugins[manifest.id];
                                trigger("plugin-settings:plugin-control", this, manifest, enabled, tabId);
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
        if (this.app.setting.activeTab?.id === id) return true;
        new Notice(
            `No settings tab for "${id}": it may not be installed or might not have settings.`
        );
        return false;
    }

    pluginEnabled(id) {
        return this.app.internalPlugins.plugins[id]?._loaded || this.app.plugins.plugins[id];
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
        tabs["workspace"] = tabs["editor"] = true;

        for(const id of Object.keys(this.configButtons || {})) {
            const btn = this.configButtons[id];
            if (!tabs[id]) {
                btn.extraSettingsEl.hide();
                continue;
            }
            btn.extraSettingsEl.show();
        }

        for(const id of Object.keys(this.hotkeyButtons || {})) {
            const btn = this.hotkeyButtons[id];
            if (!commands[id]) {
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
