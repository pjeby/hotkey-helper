import {
    Events, Plugin, Platform, Keymap, Setting, Modal, Notice, debounce, SettingTab, PluginManifest,
    ExtraButtonComponent, Hotkey, Command, SearchComponent
} from "obsidian";
import {around, serialize} from "monkey-around";
import {defer, modalSelect, onElement} from "@ophidian/core";
import "./obsidian-internals";

function hotkeyToString(hotkey: Hotkey) {
    return Keymap.compileModifiers(hotkey.modifiers)+"," + hotkey.key.toLowerCase()
}

function isPluginTab(id: string) {
    return id === "plugins" || id === "community-plugins";
}

function pluginSettingsAreOpen() {
    return settingsAreOpen() && isPluginTab(app.setting.activeTab?.id)
}

function settingsAreOpen() {
    return app.setting.containerEl.parentElement !== null
}

function isPluginViewer(ob: any) {
    return (
        ob instanceof Modal &&
        ob.hasOwnProperty("autoload") &&
        typeof (ob as any).showPlugin === "function" &&
        typeof (ob as any).updateSearch === "function" &&
        typeof (ob as any).searchEl == "object"
    );
}

export default class HotkeyHelper extends Plugin {
    lastSearch = {} as Record<string, string>
    hotkeyButtons = {} as Record<string, Partial<ExtraButtonComponent>>;
    globalsAdded = false;
    searchInput: SearchComponent = null;
    lastTabId: string;
    currentViewer: Modal;

    onload() {
        const workspace = this.app.workspace, plugin = this, events = workspace as Events;
        this.registerEvent(events.on("plugin-settings:before-display", (settingsTab, tabId) => {
            this.hotkeyButtons = {};
            this.globalsAdded = false;
            this.searchInput = null;
            const remove = around(Setting.prototype, {
                addSearch(old) { return function(f) {
                    remove();
                    return old.call(this, (i: SearchComponent) => {
                        plugin.searchInput = i; f?.(i);
                    })
                }}
            });
            defer(remove);
        }) );
        this.registerEvent( events.on("plugin-settings:after-display",  () => this.refreshButtons(true)) );

        this.registerEvent( events.on("plugin-settings:plugin-control", (setting, manifest, enabled, tabId) => {
            this.globalsAdded || this.addGlobals(tabId, setting.settingEl);
        }) );

        // Refresh the buttons when commands or setting tabs are added or removed
        const requestRefresh = debounce(this.refreshButtons.bind(this), 50, true);
        function refresher(old: (...args: any[]) => any ) {
            return function(...args: any[]){ requestRefresh(); return old.apply(this, args); };
        }
        this.register(around(app.commands, {addCommand:    refresher, removeCommand:    refresher}));
        this.register(around(app.setting,  {addSettingTab: refresher, removeSettingTab: refresher}));

        workspace.onLayoutReady(this.whenReady.bind(this));
        this.registerObsidianProtocolHandler("goto-plugin", ({id, show}) => {
            workspace.onLayoutReady(() => { this.gotoPlugin(id, show); });
        });
    }

    whenReady() {
        const app = this.app, plugin = this;
        const cmdPalette = app.internalPlugins.plugins["command-palette"]?.instance?.modal;

        if (cmdPalette) {
            this.register(around(cmdPalette, {
                onChooseItem(old) {
                    return function oci(cmd, e) {
                        if (Keymap.isModEvent(e)) {
                            defer(() => plugin.showHotkeysFor(cmd.name));
                            return false;
                        }
                        return old.call(this, cmd, e)
                    };
                }
            }));
            const first = cmdPalette.modalEl.find(".prompt-instructions .prompt-instruction");
            if (first) {
                createDiv("prompt-instruction", d => {
                    d.createSpan({
                        cls: "prompt-instruction-command", text: Keymap.compileModifiers(["Mod"])+"+↵"
                    });
                    d.appendText(" ");
                    d.createSpan({text: "to configure hotkey(s)"})
                    this.register(() => d.detach());
                }).insertAfter(first);
            }
        }

        const corePlugins = this.getSettingsTab("plugins");
        const community   = this.getSettingsTab("community-plugins");

        // Hook into the display() method of the plugin settings tabs
        if (corePlugins) this.register(around(corePlugins, {display: this.addPluginSettingEvents.bind(this, corePlugins.id)}));
        if (community)   this.register(around(community,   {display: this.addPluginSettingEvents.bind(this, community.id)}));

        const enhanceViewer = () => this.enhanceViewer();

        if (community)   this.register(
            // Trap opens of the community plugins viewer from the settings panel
            onElement(
                community.containerEl, "click",
                ".mod-cta, .installed-plugins-container .setting-item-info",
                enhanceViewer,
                true
            )
        );

        // Trap opens of the community plugins viewer via URL
        this.register(
            around(app.workspace.protocolHandlers, {
                get(old) {
                    return function get(key: string) {
                        if (key === "show-plugin") enhanceViewer();
                        return old.call(this, key);
                    }
                }
            })
        )

        // Now force a refresh if either plugins tab is currently visible (to show our new buttons)
        function refreshTabIfOpen() {
            if (pluginSettingsAreOpen()) app.setting.openTabById(app.setting.activeTab.id);
        }
        refreshTabIfOpen();

        // And do it again after we unload (to remove the old buttons)
        this.register(() => defer(refreshTabIfOpen));

        // Tweak the hotkey settings tab to make filtering work on id prefixes as well as command names
        const hotkeysTab = this.getSettingsTab("hotkeys") as SettingTab & {updateHotkeyVisibility(): void };
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

        // Add commands
        this.addCommand({
            id: "open-plugins",
            name: "Open the Community Plugins settings",
            callback: () => this.showSettings("community-plugins") || true
        });
        this.addCommand({
            id: "browse-plugins",
            name: "Browse or search the Community Plugins catalog",
            callback: () => this.gotoPlugin()
        })
        const alphaSort = new Intl.Collator(undefined, {usage: "sort", sensitivity: "base", numeric: true}).compare;
        this.addCommand({
            id: "open-settings",
            name: "Open settings for plugin...",
            callback: async () => {
                const {item} = await modalSelect(
                    app.setting.pluginTabs.concat(app.setting.settingTabs).sort((a, b) => alphaSort(a.name, b.name)),
                    t => t.name,
                    "Select a plugin to open its settings...",
                );
                if (item) {
                    app.setting.open()
                    app.setting.openTabById(item.id);
                }
            }
        });
        this.addCommand({
            id: "open-hotkeys",
            name: "Open hotkeys for plugin...",
            callback: async () => {
                const commandsByPlugin = this.refreshCommands();
                const plugins = Object.values(app.plugins.plugins)
                    .map(p => p.manifest as Partial<PluginManifest>)
                    .concat(
                        Object.entries(app.internalPlugins.plugins)
                            .map(
                                ([id, {instance: {name}, _loaded:enabled}]) => {return {id, name, enabled};}
                            )
                            .filter(p => p.enabled)
                    )
                    .concat([
                        {id: "app",       name: "App"},
                        {id: "editor",    name: this.getSettingsTab("editor")?.name || "Editor"},
                        {id: "workspace", name: this.getSettingsTab("file")?.name   || "Files & Links"}
                    ])
                    .filter(m => commandsByPlugin[m.id]?.length);
                ;
                const {item} = await modalSelect(
                    plugins.sort((a, b) => alphaSort(a.name, b.name)),
                    t => t.name,
                    "Select a plugin to open its hotkeys...");
                if (item) {
                    this.showHotkeysFor(item.id+":");
                }
            }
        });
    }

    createExtraButtons(setting: Setting, manifest: {id: string, name: string}, enabled: boolean) {
        if (manifest.id !== "app") setting.addExtraButton(btn => {
            btn.setIcon("gear");
            btn.onClick(() => this.showConfigFor(manifest.id.replace(/^workspace$/,"file")));
            btn.setTooltip("Options");
            btn.extraSettingsEl.toggle(enabled)
        });
        setting.addExtraButton(btn => {
            btn.setIcon("any-key");
            btn.onClick(() => this.showHotkeysFor(manifest.id+":"))
            btn.extraSettingsEl.toggle(enabled)
            this.hotkeyButtons[manifest.id] = btn;
        });
    }

    // Add top-level items (search and pseudo-plugins)
    addGlobals(tabId: string, settingEl: HTMLDivElement) {
        this.globalsAdded = true;

        // Add a search filter to shrink plugin list
        const containerEl = settingEl.parentElement;
        let searchEl: SearchComponent;
        if (tabId !== "plugins" || this.searchInput) {
            // Replace the built-in search handler
            (searchEl = this.searchInput)?.onChange(changeHandler);
        } else {
            const tmp = new Setting(containerEl).addSearch(s => {
                searchEl = s;
                s.setPlaceholder("Filter plugins...").onChange(changeHandler);
            });
            searchEl.containerEl.style.margin = "0";
            containerEl.createDiv("hotkey-search-container").append(searchEl.containerEl);
            tmp.settingEl.detach();
        }
        if (tabId === "community-plugins") {
            searchEl.inputEl.addEventListener("keyup", e => {
                if (e.keyCode === 13 && !Keymap.getModifiers(e)) {
                    this.gotoPlugin();
                    return false;
                }
            })
        }
        const plugin = this;
        function changeHandler(seek: string){
            const find = (plugin.lastSearch[tabId] = seek).toLowerCase();
            function matchAndHighlight(el: HTMLElement) {
                if (!el) return false;
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
                const authorMatches = matchAndHighlight(
                    e.find(".setting-item-description > div:nth-child(2)")
                );
                e.toggle(nameMatches || descMatches || authorMatches);
            });
        }
        defer(() => {
            if (!searchEl) return
            if (searchEl && typeof plugin.lastSearch[tabId] === "string") {
                searchEl.setValue(plugin.lastSearch[tabId]);
                searchEl.onChanged();
            }
            if (!Platform.isMobile) searchEl.inputEl.select();
        });
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

    enhanceViewer() {
        const plugin = this;
        setTimeout(around(Modal.prototype, {
            open(old) {
                return function(...args) {
                    if (isPluginViewer(this)) {
                        defer(() => {
                            if (plugin.lastSearch["community-plugins"]) {
                                // Detach the old search area, in case the empty search is still running
                                const newResults = this.searchResultEl.cloneNode();
                                this.searchContainerEl.replaceChild(newResults, this.searchResultEl);
                                this.searchResultEl = newResults;
                                // Force an update; use an event so that the "x" appears on search
                                this.searchEl.value = plugin.lastSearch["community-plugins"];
                                this.searchEl.dispatchEvent(new Event('input'));
                            }
                            this.searchEl.select();
                        });
                        plugin.currentViewer = this;
                        around(this, {
                            updateSearch: serialize,  // prevent race conditions

                            close(old) { return function(...args: any[]) {
                                plugin.currentViewer = null;
                                return old.apply(this, args);
                            }},

                            showPlugin(old) { return async function(manifest: PluginManifest){
                                const res = await old.call(this, manifest);
                                if (plugin.app.plugins.plugins[manifest.id]) {
                                    const hotkeysName = i18next.t("setting.hotkeys.name");
                                    const buttons = this.pluginContentEl.find("button").parentElement;
                                    for (const b of buttons.findAll("button")) {
                                        if (b.textContent === hotkeysName) {
                                            plugin.hotkeyButtons[manifest.id] = {
                                                setTooltip(tip) {b.title = tip; return this; }, extraSettingsEl: b
                                            }
                                        };
                                    }
                                    plugin.refreshButtons(true);
                                }
                                return res;
                            }}
                        })
                    }
                    return old.apply(this, args);
                }
            }
        }), 0);
    }

    getSettingsTab(id: string) {
        return app.setting.settingTabs.filter(t => t.id === id).shift() as SettingTab & {name: string};
    }

    addPluginSettingEvents(tabId: string, old: SettingTab["display"]) {
        const app = this.app, plugin = this;
        let in_event = false;

        function trigger(name: string, ...args: any[]) {
            in_event = true;
            try { app.workspace.trigger(name, ...args); } catch(e) { console.error(e); }
            in_event = false;
        }

        // Wrapper to add plugin-settings events
        return function display(...args: any[]) {
            if (in_event) return;
            trigger("plugin-settings:before-display", this, tabId);

            // Track which plugin each setting is for
            let manifests: {id: string, name: string, enabled?: boolean}[];
            if (tabId === "plugins") {
                manifests = Object.entries(app.internalPlugins.plugins).map(
                    ([id, {instance: {name, hiddenFromList}, _loaded:enabled}]) => {return !hiddenFromList && {id, name, enabled};}
                ).filter(m => m);
            } else {
                manifests = Object.values(app.plugins.manifests);
            }
            manifests.sort((e, t) => e.name.localeCompare(t.name));
            let which = 0, currentId = "";

            // Trap the addition of the "uninstall" buttons next to each plugin
            const remove = around(Setting.prototype, {
                addToggle(old) {
                    return function(...args) {
                        if (tabId === "plugins" && !in_event && (manifests[which]||{}).name === this.nameEl.textContent ) {
                            const manifest = manifests[which++];
                            currentId = manifest.id;
                            trigger("plugin-settings:plugin-control", this, manifest, manifest.enabled, tabId);
                        }
                        return old.apply(this, args);
                    }
                },
                addExtraButton(old) {
                    return function(cb) {
                        // The only "extras" added to settings w/a description are on the plugins, currently,
                        // so only try to match those to plugin names
                        if (tabId !== "plugins" && this.descEl.childElementCount && !in_event) {
                            if ( (manifests[which]||{}).name === this.nameEl.textContent ) {
                                const manifest = manifests[which++], enabled = !!app.plugins.plugins[manifest.id];
                                currentId = manifest.id
                                trigger("plugin-settings:plugin-control", this, manifest, enabled, tabId);
                            }
                        };
                        return old.call(this, function(b: ExtraButtonComponent) {
                            cb(b);
                            // Add key count/conflict indicators to built-in key buttons
                            if (!in_event && b.extraSettingsEl.find("svg.any-key") && currentId) {
                                plugin.hotkeyButtons[currentId] = b;
                            }
                        });
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

    gotoPlugin(id?: string, show="info") {
        if (id && show === "hotkeys") return this.showHotkeysFor(id+":");
        if (id && show === "config")  {
            if (!this.showConfigFor(id)) this.app.setting.close();
            return;
        }

        this.showSettings("community-plugins");
        const remove = around(Modal.prototype, {
            open(old) {
                return function(...args) {
                    remove();
                    if (id) this.autoload = id;
                    return old.apply(this, args);
                }
            }
        })
        this.app.setting.activeTab.containerEl.find(".mod-cta").click();
        // XXX handle nav to not-cataloged plugin
    }

    showSettings(id: string) {
        this.currentViewer?.close();  // close the plugin browser if open
        settingsAreOpen() || app.setting.open();
        if (id) {
            app.setting.openTabById(id);
            return app.setting.activeTab?.id === id ? app.setting.activeTab : false
        }
    }

    showHotkeysFor(search: string) {
        const tab = this.showSettings("hotkeys");
        if (tab && tab.searchInputEl && tab.updateHotkeyVisibility) {
            tab.searchInputEl.value = search;
            tab.updateHotkeyVisibility();
        }
    }

    showConfigFor(id: string) {
        if (this.showSettings(id)) return true;
        new Notice(
            `No settings tab for "${id}": it may not be installed or might not have settings.`
        );
        return false;
    }

    pluginEnabled(id: string) {
        return app.internalPlugins.plugins[id]?._loaded || app.plugins.plugins[id];
    }

    commandsByPlugin = {} as Record<string, {hotkeys: string[], cmd: Command}[]>;
    assignedKeyCount = {} as Record<string, number>;

    refreshCommands() {
        const hkm = app.hotkeyManager;
        this.assignedKeyCount = {};
        return this.commandsByPlugin = Object.values(app.commands.commands).reduce((cmds, cmd)=>{
            const pid = cmd.id.split(":",2).shift();
            const hotkeys = (hkm.getHotkeys(cmd.id) || hkm.getDefaultHotkeys(cmd.id) || []).map(hotkeyToString);
            hotkeys.forEach(k => this.assignedKeyCount[k] = 1 + (this.assignedKeyCount[k]||0));
            (cmds[pid] || (cmds[pid]=[])).push({hotkeys, cmd});
            return cmds;
        }, {} as Record<string, {hotkeys: string[], cmd: Command}[]>);
    }

    refreshButtons(force=false) {
        // Don't refresh when not displaying, unless rendering is in progress
        if (!pluginSettingsAreOpen() && !force) return;

        // Get a list of commands by plugin
        this.refreshCommands();

        // Plugin setting tabs by plugin
        const tabs = Object.values(app.setting.pluginTabs).reduce((tabs, tab)=> {
            tabs[tab.id] = tab; return tabs
        }, {} as Record<string, SettingTab|boolean>);
        tabs["workspace"] = tabs["editor"] = true;

        for(const id of Object.keys(this.hotkeyButtons || {})) {
            const btn = this.hotkeyButtons[id];
            if (!this.commandsByPlugin[id]) {
                // Plugin is disabled or has no commands
                btn.extraSettingsEl.hide();
                continue;
            }
            const assigned = this.commandsByPlugin[id].filter(info => info.hotkeys.length);
            const conflicts = assigned.filter(info => info.hotkeys.filter(k => this.assignedKeyCount[k]>1).length).length;

            btn.setTooltip(
                `Configure hotkeys${"\n"}(${assigned.length}/${this.commandsByPlugin[id].length} assigned${
                    conflicts ? "; "+conflicts+" conflicting" : ""
                })`
            );
            btn.extraSettingsEl.toggleClass("mod-error", !!conflicts);
            btn.extraSettingsEl.show();
        }
    }
}
