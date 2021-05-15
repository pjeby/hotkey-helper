'use strict';

var obsidian = require('obsidian');

function around(obj, factories) {
    const removers = Object.keys(factories).map(key => around1(obj, key, factories[key]));
    return removers.length === 1 ? removers[0] : function () { removers.forEach(r => r()); };
}
function around1(obj, method, createWrapper) {
    const original = obj[method], hadOwn = obj.hasOwnProperty(method);
    let current = createWrapper(original);
    // Let our wrapper inherit static props from the wrapping method,
    // and the wrapping method, props from the original method
    if (original)
        Object.setPrototypeOf(current, original);
    Object.setPrototypeOf(wrapper, current);
    obj[method] = wrapper;
    // Return a callback to allow safe removal
    return remove;
    function wrapper(...args) {
        // If we have been deactivated and are no longer wrapped, remove ourselves
        if (current === original && obj[method] === wrapper)
            remove();
        return current.apply(this, args);
    }
    function remove() {
        // If no other patches, just do a direct removal
        if (obj[method] === wrapper) {
            if (hadOwn)
                obj[method] = original;
            else
                delete obj[method];
        }
        if (current === original)
            return;
        // Else pass future calls through, and remove wrapper from the prototype chain
        current = original;
        Object.setPrototypeOf(wrapper, original || Function);
    }
}

function hotkeyToString(hotkey) {
    return obsidian.Keymap.compileModifiers(hotkey.modifiers)+"," + hotkey.key.toLowerCase()
}

function isPluginTab(id) {
    return id === "plugins" || id === "community-plugins";
}

function pluginSettingsAreOpen(app) {
    return settingsAreOpen(app) && isPluginTab(app.setting.activeTab?.id)
}

function settingsAreOpen(app) {
    return app.setting.containerEl.parentElement !== null
}

function isPluginViewer(ob) {
    return (
        ob instanceof obsidian.Modal &&
        ob.hasOwnProperty("autoload") &&
        typeof ob.showPlugin === "function" &&
        typeof ob.updateSearch === "function" &&
        typeof ob.searchEl == "object"
    );
}

function onElement(el, event, selector, callback, options=false) {
    el.on(event, selector, callback, options);
    return () => el.off(event, selector, callback, options);
}

class HotkeyHelper extends obsidian.Plugin {

    onload() {
        const workspace = this.app.workspace, plugin = this;

        this.registerEvent( workspace.on("plugin-settings:before-display", (settingsTab, tabId) => {
            this.hotkeyButtons = {};
            this.configButtons = {};
            this.globalsAdded = false;
            this.searchInput = null;
            const remove = around(obsidian.Setting.prototype, {
                addSearch(old) { return function(f) {
                    remove();
                    return old.call(this, i => {
                        plugin.searchInput = i; f?.(i);
                    })
                }}
            });
            setImmediate(remove);
        }) );
        this.registerEvent( workspace.on("plugin-settings:after-display",  () => this.refreshButtons(true)) );

        this.registerEvent( workspace.on("plugin-settings:plugin-control", (setting, manifest, enabled, tabId) => {
            this.globalsAdded || this.addGlobals(tabId, setting.settingEl);
            this.createExtraButtons(setting, manifest, enabled);
        }) );

        // Refresh the buttons when commands or setting tabs are added or removed
        const requestRefresh = obsidian.debounce(this.refreshButtons.bind(this), 50, true);
        function refresher(old) { return function(...args){ requestRefresh(); return old.apply(this, args); }; }
        this.register(around(app.commands, {addCommand:    refresher, removeCommand:    refresher}));
        this.register(around(app.setting,  {addPluginTab:  refresher, removePluginTab:  refresher}));
        this.register(around(app.setting,  {addSettingTab: refresher, removeSettingTab: refresher}));

        workspace.onLayoutReady(this.whenReady.bind(this));
        this.registerObsidianProtocolHandler("goto-plugin", ({id, show}) => {
            workspace.onLayoutReady(() => { this.gotoPlugin(id, show); });
        });
    }

    whenReady() {
        const app = this.app, plugin = this;

        // Save and restore current tab (workaround https://forum.obsidian.md/t/settings-dialog-resets-to-first-tab-every-time/18240)
        this.register(around(app.setting, {
            onOpen(old) { return function(...args) {
                old.apply(this, args);
                if (!obsidian.Platform.isMobile && plugin.lastTabId) this.openTabById(plugin.lastTabId);
            }},
            onClose(old) { return function(...args) {
                plugin.lastTabId = this.activeTab?.id;
                return old.apply(this, args);
            }}
        }));

        const corePlugins = this.getSettingsTab("plugins");
        const community   = this.getSettingsTab("community-plugins");

        // Hook into the display() method of the plugin settings tabs
        if (corePlugins) this.register(around(corePlugins, {display: this.addPluginSettingEvents.bind(this, corePlugins.id)}));
        if (community)   this.register(around(community,   {display: this.addPluginSettingEvents.bind(this, community.id)}));

        if (community)   this.register(
            // Trap opens of the community plugins viewer
            onElement(
                community.containerEl, "click",
                ".mod-cta, .installed-plugins-container .setting-item-info",
                () => this.enhanceViewer(),
                true
            )
        );

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
            btn.extraSettingsEl.toggle(enabled);
            this.configButtons[manifest.id] = btn;
        });
        setting.addExtraButton(btn => {
            btn.setIcon("any-key");
            btn.onClick(() => this.showHotkeysFor(manifest.id+":"));
            btn.extraSettingsEl.toggle(enabled);
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
            this.searchInput?.onChange(changeHandler);
            inputEl = this.searchInput?.inputEl;
        } else {
            let search;
            const tmp = new obsidian.Setting(containerEl).addSearch(s => {
                search = s;
                s.setPlaceholder("Filter plugins...").onChange(changeHandler);
            });
            inputEl = search.inputEl;
            search.containerEl.style.margin = 0;
            containerEl.createDiv("hotkey-search-container").append(search.containerEl);
            tmp.settingEl.detach();
        }
        function changeHandler(){
            const find = inputEl.value.toLowerCase();
            function matchAndHighlight(el) {
                const text = el.textContent = el.textContent; // clear previous highlighting, if any
                const index = text.toLowerCase().indexOf(find);
                if (!~index) return false;
                el.textContent = text.substr(0, index);
                el.createSpan("suggestion-highlight").textContent = text.substr(index, find.length);
                el.insertAdjacentText("beforeend", text.substr(index+find.length));
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
        }
        setImmediate(() => {inputEl?.focus();});
        containerEl.append(settingEl);

        if (tabId === "plugins") {
            const editorName    = this.getSettingsTab("editor")?.name || "Editor";
            const workspaceName = this.getSettingsTab("file")?.name   || "Files & Links";
            this.createExtraButtons(
                new obsidian.Setting(settingEl.parentElement)
                    .setName("App").setDesc("Miscellaneous application commands (always enabled)"),
                {id: "app", name: "App"}, true
            );
            this.createExtraButtons(
                new obsidian.Setting(settingEl.parentElement)
                    .setName(editorName).setDesc("Core editing commands (always enabled)"),
                {id: "editor", name: editorName}, true
            );
            this.createExtraButtons(
                new obsidian.Setting(settingEl.parentElement)
                    .setName(workspaceName).setDesc("Core file and pane management commands (always enabled)"),
                {id: "workspace", name: workspaceName}, true
            );
            settingEl.parentElement.append(settingEl);
        }
    }

    enhanceViewer() {
        const plugin = this;
        setImmediate(around(obsidian.Modal.prototype, {
            open(old) {
                return function(...args) {
                    if (isPluginViewer(this)) {
                        setImmediate(() => {this.searchEl.focus();});
                        plugin.currentViewer = this;
                        around(this, {
                            close(old) { return function(...args) {
                                plugin.currentViewer = null;
                                return old.apply(this, args);
                            }},
                            showPlugin(old) { return async function(manifest){
                                const res = await old.call(this, manifest);
                                if (plugin.app.plugins.plugins[manifest.id]) {
                                    const buttons = this.pluginContentEl.find("button").parentElement;
                                    const keyBtn = buttons.createEl("button", {prepend: true, text: "Hotkeys"});
                                    const cfgBtn = buttons.createEl("button", {prepend: true, text: "Options"});
                                    plugin.hotkeyButtons[manifest.id] = {
                                        setTooltip(tip) {keyBtn.title = tip;}, extraSettingsEl: keyBtn
                                    };
                                    plugin.configButtons[manifest.id] = {
                                        setTooltip() {}, extraSettingsEl: cfgBtn
                                    };
                                    plugin.refreshButtons(true);
                                    keyBtn.addEventListener("click",  () => {
                                        this.close(); plugin.showHotkeysFor(manifest.id+":");
                                    });
                                    cfgBtn.addEventListener("click",  () => {
                                        this.close(); plugin.showConfigFor(manifest.id);
                                    });
                                }
                                return res;
                            }}
                        });
                    }
                    return old.apply(this, args);
                }
            }
        }));
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
            const remove = around(obsidian.Setting.prototype, {
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
                        }                        return old.apply(this, args);
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

    gotoPlugin(id, show="info") {
        if (id && show === "hotkeys") return this.showHotkeysFor(id+":");
        if (id && show === "config")  {
            if (!this.showConfigFor(id)) this.app.setting.close();
            return;
        }

        this.showSettings("community-plugins");
        const remove = around(obsidian.Modal.prototype, {
            open(old) {
                return function(...args) {
                    remove();
                    this.autoload = id;
                    return old.apply(this, args);
                }
            }
        });
        this.app.setting.activeTab.containerEl.find(".mod-cta").click();
        // XXX handle nav to not-installed plugin
    }

    showSettings(id) {
        this.currentViewer?.close();  // close the plugin browser if open
        settingsAreOpen(this.app) || this.app.setting.open();
        if (id) {
            this.app.setting.openTabById(id);
            return this.app.setting.activeTab?.id === id ? this.app.setting.activeTab : false
        }
    }

    showHotkeysFor(search) {
        const tab = this.showSettings("hotkeys");
        if (tab && tab.searchInputEl && tab.updateHotkeyVisibility) {
            tab.searchInputEl.value = search;
            tab.updateHotkeyVisibility();
        }
    }

    showConfigFor(id) {
        if (this.showSettings(id)) return true;
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

module.exports = HotkeyHelper;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWFpbi5qcyIsInNvdXJjZXMiOlsiLnlhcm4vY2FjaGUvbW9ua2V5LWFyb3VuZC1ucG0tMi4xLjAtNzBkZjMyZDJhYy0xYmQ3MmQyNWY5LnppcC9ub2RlX21vZHVsZXMvbW9ua2V5LWFyb3VuZC9tanMvaW5kZXguanMiLCJzcmMvcGx1Z2luLmpzIl0sInNvdXJjZXNDb250ZW50IjpbImV4cG9ydCBmdW5jdGlvbiBhcm91bmQob2JqLCBmYWN0b3JpZXMpIHtcbiAgICBjb25zdCByZW1vdmVycyA9IE9iamVjdC5rZXlzKGZhY3RvcmllcykubWFwKGtleSA9PiBhcm91bmQxKG9iaiwga2V5LCBmYWN0b3JpZXNba2V5XSkpO1xuICAgIHJldHVybiByZW1vdmVycy5sZW5ndGggPT09IDEgPyByZW1vdmVyc1swXSA6IGZ1bmN0aW9uICgpIHsgcmVtb3ZlcnMuZm9yRWFjaChyID0+IHIoKSk7IH07XG59XG5mdW5jdGlvbiBhcm91bmQxKG9iaiwgbWV0aG9kLCBjcmVhdGVXcmFwcGVyKSB7XG4gICAgY29uc3Qgb3JpZ2luYWwgPSBvYmpbbWV0aG9kXSwgaGFkT3duID0gb2JqLmhhc093blByb3BlcnR5KG1ldGhvZCk7XG4gICAgbGV0IGN1cnJlbnQgPSBjcmVhdGVXcmFwcGVyKG9yaWdpbmFsKTtcbiAgICAvLyBMZXQgb3VyIHdyYXBwZXIgaW5oZXJpdCBzdGF0aWMgcHJvcHMgZnJvbSB0aGUgd3JhcHBpbmcgbWV0aG9kLFxuICAgIC8vIGFuZCB0aGUgd3JhcHBpbmcgbWV0aG9kLCBwcm9wcyBmcm9tIHRoZSBvcmlnaW5hbCBtZXRob2RcbiAgICBpZiAob3JpZ2luYWwpXG4gICAgICAgIE9iamVjdC5zZXRQcm90b3R5cGVPZihjdXJyZW50LCBvcmlnaW5hbCk7XG4gICAgT2JqZWN0LnNldFByb3RvdHlwZU9mKHdyYXBwZXIsIGN1cnJlbnQpO1xuICAgIG9ialttZXRob2RdID0gd3JhcHBlcjtcbiAgICAvLyBSZXR1cm4gYSBjYWxsYmFjayB0byBhbGxvdyBzYWZlIHJlbW92YWxcbiAgICByZXR1cm4gcmVtb3ZlO1xuICAgIGZ1bmN0aW9uIHdyYXBwZXIoLi4uYXJncykge1xuICAgICAgICAvLyBJZiB3ZSBoYXZlIGJlZW4gZGVhY3RpdmF0ZWQgYW5kIGFyZSBubyBsb25nZXIgd3JhcHBlZCwgcmVtb3ZlIG91cnNlbHZlc1xuICAgICAgICBpZiAoY3VycmVudCA9PT0gb3JpZ2luYWwgJiYgb2JqW21ldGhvZF0gPT09IHdyYXBwZXIpXG4gICAgICAgICAgICByZW1vdmUoKTtcbiAgICAgICAgcmV0dXJuIGN1cnJlbnQuYXBwbHkodGhpcywgYXJncyk7XG4gICAgfVxuICAgIGZ1bmN0aW9uIHJlbW92ZSgpIHtcbiAgICAgICAgLy8gSWYgbm8gb3RoZXIgcGF0Y2hlcywganVzdCBkbyBhIGRpcmVjdCByZW1vdmFsXG4gICAgICAgIGlmIChvYmpbbWV0aG9kXSA9PT0gd3JhcHBlcikge1xuICAgICAgICAgICAgaWYgKGhhZE93bilcbiAgICAgICAgICAgICAgICBvYmpbbWV0aG9kXSA9IG9yaWdpbmFsO1xuICAgICAgICAgICAgZWxzZVxuICAgICAgICAgICAgICAgIGRlbGV0ZSBvYmpbbWV0aG9kXTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoY3VycmVudCA9PT0gb3JpZ2luYWwpXG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgIC8vIEVsc2UgcGFzcyBmdXR1cmUgY2FsbHMgdGhyb3VnaCwgYW5kIHJlbW92ZSB3cmFwcGVyIGZyb20gdGhlIHByb3RvdHlwZSBjaGFpblxuICAgICAgICBjdXJyZW50ID0gb3JpZ2luYWw7XG4gICAgICAgIE9iamVjdC5zZXRQcm90b3R5cGVPZih3cmFwcGVyLCBvcmlnaW5hbCB8fCBGdW5jdGlvbik7XG4gICAgfVxufVxuZXhwb3J0IGZ1bmN0aW9uIGFmdGVyKHByb21pc2UsIGNiKSB7XG4gICAgcmV0dXJuIHByb21pc2UudGhlbihjYiwgY2IpO1xufVxuZXhwb3J0IGZ1bmN0aW9uIHNlcmlhbGl6ZShhc3luY0Z1bmN0aW9uKSB7XG4gICAgbGV0IGxhc3RSdW4gPSBQcm9taXNlLnJlc29sdmUoKTtcbiAgICBmdW5jdGlvbiB3cmFwcGVyKC4uLmFyZ3MpIHtcbiAgICAgICAgcmV0dXJuIGxhc3RSdW4gPSBuZXcgUHJvbWlzZSgocmVzLCByZWopID0+IHtcbiAgICAgICAgICAgIGFmdGVyKGxhc3RSdW4sICgpID0+IHtcbiAgICAgICAgICAgICAgICBhc3luY0Z1bmN0aW9uLmFwcGx5KHRoaXMsIGFyZ3MpLnRoZW4ocmVzLCByZWopO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH0pO1xuICAgIH1cbiAgICB3cmFwcGVyLmFmdGVyID0gZnVuY3Rpb24gKCkge1xuICAgICAgICByZXR1cm4gbGFzdFJ1biA9IG5ldyBQcm9taXNlKChyZXMsIHJlaikgPT4geyBhZnRlcihsYXN0UnVuLCByZXMpOyB9KTtcbiAgICB9O1xuICAgIHJldHVybiB3cmFwcGVyO1xufVxuIiwiaW1wb3J0IHtQbHVnaW4sIFBsYXRmb3JtLCBLZXltYXAsIFNldHRpbmcsIE1vZGFsLCBkZWJvdW5jZX0gZnJvbSBcIm9ic2lkaWFuXCI7XG5pbXBvcnQge2Fyb3VuZH0gZnJvbSBcIm1vbmtleS1hcm91bmRcIjtcblxuZnVuY3Rpb24gaG90a2V5VG9TdHJpbmcoaG90a2V5KSB7XG4gICAgcmV0dXJuIEtleW1hcC5jb21waWxlTW9kaWZpZXJzKGhvdGtleS5tb2RpZmllcnMpK1wiLFwiICsgaG90a2V5LmtleS50b0xvd2VyQ2FzZSgpXG59XG5cbmZ1bmN0aW9uIGlzUGx1Z2luVGFiKGlkKSB7XG4gICAgcmV0dXJuIGlkID09PSBcInBsdWdpbnNcIiB8fCBpZCA9PT0gXCJjb21tdW5pdHktcGx1Z2luc1wiO1xufVxuXG5mdW5jdGlvbiBwbHVnaW5TZXR0aW5nc0FyZU9wZW4oYXBwKSB7XG4gICAgcmV0dXJuIHNldHRpbmdzQXJlT3BlbihhcHApICYmIGlzUGx1Z2luVGFiKGFwcC5zZXR0aW5nLmFjdGl2ZVRhYj8uaWQpXG59XG5cbmZ1bmN0aW9uIHNldHRpbmdzQXJlT3BlbihhcHApIHtcbiAgICByZXR1cm4gYXBwLnNldHRpbmcuY29udGFpbmVyRWwucGFyZW50RWxlbWVudCAhPT0gbnVsbFxufVxuXG5mdW5jdGlvbiBpc1BsdWdpblZpZXdlcihvYikge1xuICAgIHJldHVybiAoXG4gICAgICAgIG9iIGluc3RhbmNlb2YgTW9kYWwgJiZcbiAgICAgICAgb2IuaGFzT3duUHJvcGVydHkoXCJhdXRvbG9hZFwiKSAmJlxuICAgICAgICB0eXBlb2Ygb2Iuc2hvd1BsdWdpbiA9PT0gXCJmdW5jdGlvblwiICYmXG4gICAgICAgIHR5cGVvZiBvYi51cGRhdGVTZWFyY2ggPT09IFwiZnVuY3Rpb25cIiAmJlxuICAgICAgICB0eXBlb2Ygb2Iuc2VhcmNoRWwgPT0gXCJvYmplY3RcIlxuICAgICk7XG59XG5cbmZ1bmN0aW9uIG9uRWxlbWVudChlbCwgZXZlbnQsIHNlbGVjdG9yLCBjYWxsYmFjaywgb3B0aW9ucz1mYWxzZSkge1xuICAgIGVsLm9uKGV2ZW50LCBzZWxlY3RvciwgY2FsbGJhY2ssIG9wdGlvbnMpXG4gICAgcmV0dXJuICgpID0+IGVsLm9mZihldmVudCwgc2VsZWN0b3IsIGNhbGxiYWNrLCBvcHRpb25zKTtcbn1cblxuZXhwb3J0IGRlZmF1bHQgY2xhc3MgSG90a2V5SGVscGVyIGV4dGVuZHMgUGx1Z2luIHtcblxuICAgIG9ubG9hZCgpIHtcbiAgICAgICAgY29uc3Qgd29ya3NwYWNlID0gdGhpcy5hcHAud29ya3NwYWNlLCBwbHVnaW4gPSB0aGlzO1xuXG4gICAgICAgIHRoaXMucmVnaXN0ZXJFdmVudCggd29ya3NwYWNlLm9uKFwicGx1Z2luLXNldHRpbmdzOmJlZm9yZS1kaXNwbGF5XCIsIChzZXR0aW5nc1RhYiwgdGFiSWQpID0+IHtcbiAgICAgICAgICAgIHRoaXMuaG90a2V5QnV0dG9ucyA9IHt9O1xuICAgICAgICAgICAgdGhpcy5jb25maWdCdXR0b25zID0ge307XG4gICAgICAgICAgICB0aGlzLmdsb2JhbHNBZGRlZCA9IGZhbHNlO1xuICAgICAgICAgICAgdGhpcy5zZWFyY2hJbnB1dCA9IG51bGw7XG4gICAgICAgICAgICBjb25zdCByZW1vdmUgPSBhcm91bmQoU2V0dGluZy5wcm90b3R5cGUsIHtcbiAgICAgICAgICAgICAgICBhZGRTZWFyY2gob2xkKSB7IHJldHVybiBmdW5jdGlvbihmKSB7XG4gICAgICAgICAgICAgICAgICAgIHJlbW92ZSgpO1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gb2xkLmNhbGwodGhpcywgaSA9PiB7XG4gICAgICAgICAgICAgICAgICAgICAgICBwbHVnaW4uc2VhcmNoSW5wdXQgPSBpOyBmPy4oaSk7XG4gICAgICAgICAgICAgICAgICAgIH0pXG4gICAgICAgICAgICAgICAgfX1cbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgc2V0SW1tZWRpYXRlKHJlbW92ZSk7XG4gICAgICAgIH0pICk7XG4gICAgICAgIHRoaXMucmVnaXN0ZXJFdmVudCggd29ya3NwYWNlLm9uKFwicGx1Z2luLXNldHRpbmdzOmFmdGVyLWRpc3BsYXlcIiwgICgpID0+IHRoaXMucmVmcmVzaEJ1dHRvbnModHJ1ZSkpICk7XG5cbiAgICAgICAgdGhpcy5yZWdpc3RlckV2ZW50KCB3b3Jrc3BhY2Uub24oXCJwbHVnaW4tc2V0dGluZ3M6cGx1Z2luLWNvbnRyb2xcIiwgKHNldHRpbmcsIG1hbmlmZXN0LCBlbmFibGVkLCB0YWJJZCkgPT4ge1xuICAgICAgICAgICAgdGhpcy5nbG9iYWxzQWRkZWQgfHwgdGhpcy5hZGRHbG9iYWxzKHRhYklkLCBzZXR0aW5nLnNldHRpbmdFbCk7XG4gICAgICAgICAgICB0aGlzLmNyZWF0ZUV4dHJhQnV0dG9ucyhzZXR0aW5nLCBtYW5pZmVzdCwgZW5hYmxlZCk7XG4gICAgICAgIH0pICk7XG5cbiAgICAgICAgLy8gUmVmcmVzaCB0aGUgYnV0dG9ucyB3aGVuIGNvbW1hbmRzIG9yIHNldHRpbmcgdGFicyBhcmUgYWRkZWQgb3IgcmVtb3ZlZFxuICAgICAgICBjb25zdCByZXF1ZXN0UmVmcmVzaCA9IGRlYm91bmNlKHRoaXMucmVmcmVzaEJ1dHRvbnMuYmluZCh0aGlzKSwgNTAsIHRydWUpO1xuICAgICAgICBmdW5jdGlvbiByZWZyZXNoZXIob2xkKSB7IHJldHVybiBmdW5jdGlvbiguLi5hcmdzKXsgcmVxdWVzdFJlZnJlc2goKTsgcmV0dXJuIG9sZC5hcHBseSh0aGlzLCBhcmdzKTsgfTsgfVxuICAgICAgICB0aGlzLnJlZ2lzdGVyKGFyb3VuZChhcHAuY29tbWFuZHMsIHthZGRDb21tYW5kOiAgICByZWZyZXNoZXIsIHJlbW92ZUNvbW1hbmQ6ICAgIHJlZnJlc2hlcn0pKTtcbiAgICAgICAgdGhpcy5yZWdpc3Rlcihhcm91bmQoYXBwLnNldHRpbmcsICB7YWRkUGx1Z2luVGFiOiAgcmVmcmVzaGVyLCByZW1vdmVQbHVnaW5UYWI6ICByZWZyZXNoZXJ9KSk7XG4gICAgICAgIHRoaXMucmVnaXN0ZXIoYXJvdW5kKGFwcC5zZXR0aW5nLCAge2FkZFNldHRpbmdUYWI6IHJlZnJlc2hlciwgcmVtb3ZlU2V0dGluZ1RhYjogcmVmcmVzaGVyfSkpO1xuXG4gICAgICAgIHdvcmtzcGFjZS5vbkxheW91dFJlYWR5KHRoaXMud2hlblJlYWR5LmJpbmQodGhpcykpO1xuICAgICAgICB0aGlzLnJlZ2lzdGVyT2JzaWRpYW5Qcm90b2NvbEhhbmRsZXIoXCJnb3RvLXBsdWdpblwiLCAoe2lkLCBzaG93fSkgPT4ge1xuICAgICAgICAgICAgd29ya3NwYWNlLm9uTGF5b3V0UmVhZHkoKCkgPT4geyB0aGlzLmdvdG9QbHVnaW4oaWQsIHNob3cpOyB9KTtcbiAgICAgICAgfSk7XG4gICAgfVxuXG4gICAgd2hlblJlYWR5KCkge1xuICAgICAgICBjb25zdCBhcHAgPSB0aGlzLmFwcCwgcGx1Z2luID0gdGhpcztcblxuICAgICAgICAvLyBTYXZlIGFuZCByZXN0b3JlIGN1cnJlbnQgdGFiICh3b3JrYXJvdW5kIGh0dHBzOi8vZm9ydW0ub2JzaWRpYW4ubWQvdC9zZXR0aW5ncy1kaWFsb2ctcmVzZXRzLXRvLWZpcnN0LXRhYi1ldmVyeS10aW1lLzE4MjQwKVxuICAgICAgICB0aGlzLnJlZ2lzdGVyKGFyb3VuZChhcHAuc2V0dGluZywge1xuICAgICAgICAgICAgb25PcGVuKG9sZCkgeyByZXR1cm4gZnVuY3Rpb24oLi4uYXJncykge1xuICAgICAgICAgICAgICAgIG9sZC5hcHBseSh0aGlzLCBhcmdzKTtcbiAgICAgICAgICAgICAgICBpZiAoIVBsYXRmb3JtLmlzTW9iaWxlICYmIHBsdWdpbi5sYXN0VGFiSWQpIHRoaXMub3BlblRhYkJ5SWQocGx1Z2luLmxhc3RUYWJJZCk7XG4gICAgICAgICAgICB9fSxcbiAgICAgICAgICAgIG9uQ2xvc2Uob2xkKSB7IHJldHVybiBmdW5jdGlvbiguLi5hcmdzKSB7XG4gICAgICAgICAgICAgICAgcGx1Z2luLmxhc3RUYWJJZCA9IHRoaXMuYWN0aXZlVGFiPy5pZDtcbiAgICAgICAgICAgICAgICByZXR1cm4gb2xkLmFwcGx5KHRoaXMsIGFyZ3MpO1xuICAgICAgICAgICAgfX1cbiAgICAgICAgfSkpXG5cbiAgICAgICAgY29uc3QgY29yZVBsdWdpbnMgPSB0aGlzLmdldFNldHRpbmdzVGFiKFwicGx1Z2luc1wiKTtcbiAgICAgICAgY29uc3QgY29tbXVuaXR5ICAgPSB0aGlzLmdldFNldHRpbmdzVGFiKFwiY29tbXVuaXR5LXBsdWdpbnNcIik7XG5cbiAgICAgICAgLy8gSG9vayBpbnRvIHRoZSBkaXNwbGF5KCkgbWV0aG9kIG9mIHRoZSBwbHVnaW4gc2V0dGluZ3MgdGFic1xuICAgICAgICBpZiAoY29yZVBsdWdpbnMpIHRoaXMucmVnaXN0ZXIoYXJvdW5kKGNvcmVQbHVnaW5zLCB7ZGlzcGxheTogdGhpcy5hZGRQbHVnaW5TZXR0aW5nRXZlbnRzLmJpbmQodGhpcywgY29yZVBsdWdpbnMuaWQpfSkpO1xuICAgICAgICBpZiAoY29tbXVuaXR5KSAgIHRoaXMucmVnaXN0ZXIoYXJvdW5kKGNvbW11bml0eSwgICB7ZGlzcGxheTogdGhpcy5hZGRQbHVnaW5TZXR0aW5nRXZlbnRzLmJpbmQodGhpcywgY29tbXVuaXR5LmlkKX0pKTtcblxuICAgICAgICBpZiAoY29tbXVuaXR5KSAgIHRoaXMucmVnaXN0ZXIoXG4gICAgICAgICAgICAvLyBUcmFwIG9wZW5zIG9mIHRoZSBjb21tdW5pdHkgcGx1Z2lucyB2aWV3ZXJcbiAgICAgICAgICAgIG9uRWxlbWVudChcbiAgICAgICAgICAgICAgICBjb21tdW5pdHkuY29udGFpbmVyRWwsIFwiY2xpY2tcIixcbiAgICAgICAgICAgICAgICBcIi5tb2QtY3RhLCAuaW5zdGFsbGVkLXBsdWdpbnMtY29udGFpbmVyIC5zZXR0aW5nLWl0ZW0taW5mb1wiLFxuICAgICAgICAgICAgICAgICgpID0+IHRoaXMuZW5oYW5jZVZpZXdlcigpLFxuICAgICAgICAgICAgICAgIHRydWVcbiAgICAgICAgICAgIClcbiAgICAgICAgKTtcblxuICAgICAgICAvLyBOb3cgZm9yY2UgYSByZWZyZXNoIGlmIGVpdGhlciBwbHVnaW5zIHRhYiBpcyBjdXJyZW50bHkgdmlzaWJsZSAodG8gc2hvdyBvdXIgbmV3IGJ1dHRvbnMpXG4gICAgICAgIGZ1bmN0aW9uIHJlZnJlc2hUYWJJZk9wZW4oKSB7XG4gICAgICAgICAgICBpZiAocGx1Z2luU2V0dGluZ3NBcmVPcGVuKGFwcCkpIGFwcC5zZXR0aW5nLm9wZW5UYWJCeUlkKGFwcC5zZXR0aW5nLmFjdGl2ZVRhYi5pZCk7XG4gICAgICAgIH1cbiAgICAgICAgcmVmcmVzaFRhYklmT3BlbigpO1xuXG4gICAgICAgIC8vIEFuZCBkbyBpdCBhZ2FpbiBhZnRlciB3ZSB1bmxvYWQgKHRvIHJlbW92ZSB0aGUgb2xkIGJ1dHRvbnMpXG4gICAgICAgIHRoaXMucmVnaXN0ZXIoKCkgPT4gc2V0SW1tZWRpYXRlKHJlZnJlc2hUYWJJZk9wZW4pKTtcblxuICAgICAgICAvLyBUd2VhayB0aGUgaG90a2V5IHNldHRpbmdzIHRhYiB0byBtYWtlIGZpbHRlcmluZyB3b3JrIG9uIGlkIHByZWZpeGVzIGFzIHdlbGwgYXMgY29tbWFuZCBuYW1lc1xuICAgICAgICBjb25zdCBob3RrZXlzVGFiID0gdGhpcy5nZXRTZXR0aW5nc1RhYihcImhvdGtleXNcIik7XG4gICAgICAgIGlmIChob3RrZXlzVGFiKSB7XG4gICAgICAgICAgICB0aGlzLnJlZ2lzdGVyKGFyb3VuZChob3RrZXlzVGFiLCB7XG4gICAgICAgICAgICAgICAgZGlzcGxheShvbGQpIHsgcmV0dXJuIGZ1bmN0aW9uKCkgeyBvbGQuY2FsbCh0aGlzKTsgdGhpcy5zZWFyY2hJbnB1dEVsLmZvY3VzKCk7IH07IH0sXG4gICAgICAgICAgICAgICAgdXBkYXRlSG90a2V5VmlzaWJpbGl0eShvbGQpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGZ1bmN0aW9uKCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgY29uc3Qgb2xkU2VhcmNoID0gdGhpcy5zZWFyY2hJbnB1dEVsLnZhbHVlLCBvbGRDb21tYW5kcyA9IGFwcC5jb21tYW5kcy5jb21tYW5kcztcbiAgICAgICAgICAgICAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKG9sZFNlYXJjaC5lbmRzV2l0aChcIjpcIikgJiYgIW9sZFNlYXJjaC5jb250YWlucyhcIiBcIikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLy8gVGhpcyBpcyBhbiBpbmNyZWRpYmx5IHVnbHkgaGFjayB0aGF0IHJlbGllcyBvbiB1cGRhdGVIb3RrZXlWaXNpYmlsaXR5KCkgaXRlcmF0aW5nIGFwcC5jb21tYW5kcy5jb21tYW5kc1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAvLyBsb29raW5nIGZvciBob3RrZXkgY29uZmxpY3RzICpiZWZvcmUqIGFueXRoaW5nIGVsc2UuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxldCBjdXJyZW50ID0gb2xkQ29tbWFuZHM7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxldCBmaWx0ZXJlZCA9IE9iamVjdC5mcm9tRW50cmllcyhPYmplY3QuZW50cmllcyhhcHAuY29tbWFuZHMuY29tbWFuZHMpLmZpbHRlcihcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIChbaWQsIGNtZF0pID0+IChpZCtcIjpcIikuc3RhcnRzV2l0aChvbGRTZWFyY2gpXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICkpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aGlzLnNlYXJjaElucHV0RWwudmFsdWUgPSBcIlwiO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhcHAuY29tbWFuZHMuY29tbWFuZHMgPSBuZXcgUHJveHkob2xkQ29tbWFuZHMsIHtvd25LZXlzKCl7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAvLyBUaGUgZmlyc3QgdGltZSBjb21tYW5kcyBhcmUgaXRlcmF0ZWQsIHJldHVybiB0aGUgd2hvbGUgdGhpbmc7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAvLyBhZnRlciB0aGF0LCByZXR1cm4gdGhlIGZpbHRlcmVkIGxpc3RcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRyeSB7IHJldHVybiBPYmplY3Qua2V5cyhjdXJyZW50KTsgfSBmaW5hbGx5IHsgY3VycmVudCA9IGZpbHRlcmVkOyB9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH19KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIG9sZC5jYWxsKHRoaXMpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfSBmaW5hbGx5IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aGlzLnNlYXJjaElucHV0RWwudmFsdWUgPSBvbGRTZWFyY2g7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYXBwLmNvbW1hbmRzLmNvbW1hbmRzID0gb2xkQ29tbWFuZHM7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9KSk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBjcmVhdGVFeHRyYUJ1dHRvbnMoc2V0dGluZywgbWFuaWZlc3QsIGVuYWJsZWQpIHtcbiAgICAgICAgc2V0dGluZy5hZGRFeHRyYUJ1dHRvbihidG4gPT4ge1xuICAgICAgICAgICAgYnRuLnNldEljb24oXCJnZWFyXCIpO1xuICAgICAgICAgICAgYnRuLm9uQ2xpY2soKCkgPT4gdGhpcy5zaG93Q29uZmlnRm9yKG1hbmlmZXN0LmlkLnJlcGxhY2UoL153b3Jrc3BhY2UkLyxcImZpbGVcIikpKTtcbiAgICAgICAgICAgIGJ0bi5zZXRUb29sdGlwKFwiT3B0aW9uc1wiKTtcbiAgICAgICAgICAgIGJ0bi5leHRyYVNldHRpbmdzRWwudG9nZ2xlKGVuYWJsZWQpXG4gICAgICAgICAgICB0aGlzLmNvbmZpZ0J1dHRvbnNbbWFuaWZlc3QuaWRdID0gYnRuO1xuICAgICAgICB9KTtcbiAgICAgICAgc2V0dGluZy5hZGRFeHRyYUJ1dHRvbihidG4gPT4ge1xuICAgICAgICAgICAgYnRuLnNldEljb24oXCJhbnkta2V5XCIpO1xuICAgICAgICAgICAgYnRuLm9uQ2xpY2soKCkgPT4gdGhpcy5zaG93SG90a2V5c0ZvcihtYW5pZmVzdC5pZCtcIjpcIikpXG4gICAgICAgICAgICBidG4uZXh0cmFTZXR0aW5nc0VsLnRvZ2dsZShlbmFibGVkKVxuICAgICAgICAgICAgdGhpcy5ob3RrZXlCdXR0b25zW21hbmlmZXN0LmlkXSA9IGJ0bjtcbiAgICAgICAgfSk7XG4gICAgfVxuXG4gICAgLy8gQWRkIHRvcC1sZXZlbCBpdGVtcyAoc2VhcmNoIGFuZCBwc2V1ZG8tcGx1Z2lucylcbiAgICBhZGRHbG9iYWxzKHRhYklkLCBzZXR0aW5nRWwpIHtcbiAgICAgICAgdGhpcy5nbG9iYWxzQWRkZWQgPSB0cnVlO1xuXG4gICAgICAgIC8vIEFkZCBhIHNlYXJjaCBmaWx0ZXIgdG8gc2hyaW5rIHBsdWdpbiBsaXN0XG4gICAgICAgIGNvbnN0IGNvbnRhaW5lckVsID0gc2V0dGluZ0VsLnBhcmVudEVsZW1lbnQ7XG4gICAgICAgIGxldCBpbnB1dEVsO1xuICAgICAgICBpZiAodGFiSWQgIT09IFwicGx1Z2luc1wiKSB7XG4gICAgICAgICAgICAvLyBSZXBsYWNlIHRoZSBidWlsdC1pbiBzZWFyY2ggaGFuZGxlclxuICAgICAgICAgICAgdGhpcy5zZWFyY2hJbnB1dD8ub25DaGFuZ2UoY2hhbmdlSGFuZGxlcik7XG4gICAgICAgICAgICBpbnB1dEVsID0gdGhpcy5zZWFyY2hJbnB1dD8uaW5wdXRFbDtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGxldCBzZWFyY2g7XG4gICAgICAgICAgICBjb25zdCB0bXAgPSBuZXcgU2V0dGluZyhjb250YWluZXJFbCkuYWRkU2VhcmNoKHMgPT4ge1xuICAgICAgICAgICAgICAgIHNlYXJjaCA9IHM7XG4gICAgICAgICAgICAgICAgcy5zZXRQbGFjZWhvbGRlcihcIkZpbHRlciBwbHVnaW5zLi4uXCIpLm9uQ2hhbmdlKGNoYW5nZUhhbmRsZXIpO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICBpbnB1dEVsID0gc2VhcmNoLmlucHV0RWw7XG4gICAgICAgICAgICBzZWFyY2guY29udGFpbmVyRWwuc3R5bGUubWFyZ2luID0gMDtcbiAgICAgICAgICAgIGNvbnRhaW5lckVsLmNyZWF0ZURpdihcImhvdGtleS1zZWFyY2gtY29udGFpbmVyXCIpLmFwcGVuZChzZWFyY2guY29udGFpbmVyRWwpO1xuICAgICAgICAgICAgdG1wLnNldHRpbmdFbC5kZXRhY2goKTtcbiAgICAgICAgfVxuICAgICAgICBmdW5jdGlvbiBjaGFuZ2VIYW5kbGVyKCl7XG4gICAgICAgICAgICBjb25zdCBmaW5kID0gaW5wdXRFbC52YWx1ZS50b0xvd2VyQ2FzZSgpO1xuICAgICAgICAgICAgZnVuY3Rpb24gbWF0Y2hBbmRIaWdobGlnaHQoZWwpIHtcbiAgICAgICAgICAgICAgICBjb25zdCB0ZXh0ID0gZWwudGV4dENvbnRlbnQgPSBlbC50ZXh0Q29udGVudDsgLy8gY2xlYXIgcHJldmlvdXMgaGlnaGxpZ2h0aW5nLCBpZiBhbnlcbiAgICAgICAgICAgICAgICBjb25zdCBpbmRleCA9IHRleHQudG9Mb3dlckNhc2UoKS5pbmRleE9mKGZpbmQpO1xuICAgICAgICAgICAgICAgIGlmICghfmluZGV4KSByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICAgICAgZWwudGV4dENvbnRlbnQgPSB0ZXh0LnN1YnN0cigwLCBpbmRleCk7XG4gICAgICAgICAgICAgICAgZWwuY3JlYXRlU3BhbihcInN1Z2dlc3Rpb24taGlnaGxpZ2h0XCIpLnRleHRDb250ZW50ID0gdGV4dC5zdWJzdHIoaW5kZXgsIGZpbmQubGVuZ3RoKTtcbiAgICAgICAgICAgICAgICBlbC5pbnNlcnRBZGphY2VudFRleHQoXCJiZWZvcmVlbmRcIiwgdGV4dC5zdWJzdHIoaW5kZXgrZmluZC5sZW5ndGgpKVxuICAgICAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY29udGFpbmVyRWwuZmluZEFsbChcIi5zZXR0aW5nLWl0ZW1cIikuZm9yRWFjaChlID0+IHtcbiAgICAgICAgICAgICAgICBjb25zdCBuYW1lTWF0Y2hlcyA9IG1hdGNoQW5kSGlnaGxpZ2h0KGUuZmluZChcIi5zZXR0aW5nLWl0ZW0tbmFtZVwiKSk7XG4gICAgICAgICAgICAgICAgY29uc3QgZGVzY01hdGNoZXMgPSBtYXRjaEFuZEhpZ2hsaWdodChcbiAgICAgICAgICAgICAgICAgICAgZS5maW5kKFwiLnNldHRpbmctaXRlbS1kZXNjcmlwdGlvbiA+IGRpdjpsYXN0LWNoaWxkXCIpID8/XG4gICAgICAgICAgICAgICAgICAgIGUuZmluZChcIi5zZXR0aW5nLWl0ZW0tZGVzY3JpcHRpb25cIilcbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIGUudG9nZ2xlKG5hbWVNYXRjaGVzIHx8IGRlc2NNYXRjaGVzKTtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICAgIHNldEltbWVkaWF0ZSgoKSA9PiB7aW5wdXRFbD8uZm9jdXMoKX0pO1xuICAgICAgICBjb250YWluZXJFbC5hcHBlbmQoc2V0dGluZ0VsKTtcblxuICAgICAgICBpZiAodGFiSWQgPT09IFwicGx1Z2luc1wiKSB7XG4gICAgICAgICAgICBjb25zdCBlZGl0b3JOYW1lICAgID0gdGhpcy5nZXRTZXR0aW5nc1RhYihcImVkaXRvclwiKT8ubmFtZSB8fCBcIkVkaXRvclwiO1xuICAgICAgICAgICAgY29uc3Qgd29ya3NwYWNlTmFtZSA9IHRoaXMuZ2V0U2V0dGluZ3NUYWIoXCJmaWxlXCIpPy5uYW1lICAgfHwgXCJGaWxlcyAmIExpbmtzXCI7XG4gICAgICAgICAgICB0aGlzLmNyZWF0ZUV4dHJhQnV0dG9ucyhcbiAgICAgICAgICAgICAgICBuZXcgU2V0dGluZyhzZXR0aW5nRWwucGFyZW50RWxlbWVudClcbiAgICAgICAgICAgICAgICAgICAgLnNldE5hbWUoXCJBcHBcIikuc2V0RGVzYyhcIk1pc2NlbGxhbmVvdXMgYXBwbGljYXRpb24gY29tbWFuZHMgKGFsd2F5cyBlbmFibGVkKVwiKSxcbiAgICAgICAgICAgICAgICB7aWQ6IFwiYXBwXCIsIG5hbWU6IFwiQXBwXCJ9LCB0cnVlXG4gICAgICAgICAgICApO1xuICAgICAgICAgICAgdGhpcy5jcmVhdGVFeHRyYUJ1dHRvbnMoXG4gICAgICAgICAgICAgICAgbmV3IFNldHRpbmcoc2V0dGluZ0VsLnBhcmVudEVsZW1lbnQpXG4gICAgICAgICAgICAgICAgICAgIC5zZXROYW1lKGVkaXRvck5hbWUpLnNldERlc2MoXCJDb3JlIGVkaXRpbmcgY29tbWFuZHMgKGFsd2F5cyBlbmFibGVkKVwiKSxcbiAgICAgICAgICAgICAgICB7aWQ6IFwiZWRpdG9yXCIsIG5hbWU6IGVkaXRvck5hbWV9LCB0cnVlXG4gICAgICAgICAgICApO1xuICAgICAgICAgICAgdGhpcy5jcmVhdGVFeHRyYUJ1dHRvbnMoXG4gICAgICAgICAgICAgICAgbmV3IFNldHRpbmcoc2V0dGluZ0VsLnBhcmVudEVsZW1lbnQpXG4gICAgICAgICAgICAgICAgICAgIC5zZXROYW1lKHdvcmtzcGFjZU5hbWUpLnNldERlc2MoXCJDb3JlIGZpbGUgYW5kIHBhbmUgbWFuYWdlbWVudCBjb21tYW5kcyAoYWx3YXlzIGVuYWJsZWQpXCIpLFxuICAgICAgICAgICAgICAgIHtpZDogXCJ3b3Jrc3BhY2VcIiwgbmFtZTogd29ya3NwYWNlTmFtZX0sIHRydWVcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgICBzZXR0aW5nRWwucGFyZW50RWxlbWVudC5hcHBlbmQoc2V0dGluZ0VsKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIGVuaGFuY2VWaWV3ZXIoKSB7XG4gICAgICAgIGNvbnN0IHBsdWdpbiA9IHRoaXM7XG4gICAgICAgIHNldEltbWVkaWF0ZShhcm91bmQoTW9kYWwucHJvdG90eXBlLCB7XG4gICAgICAgICAgICBvcGVuKG9sZCkge1xuICAgICAgICAgICAgICAgIHJldHVybiBmdW5jdGlvbiguLi5hcmdzKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChpc1BsdWdpblZpZXdlcih0aGlzKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgc2V0SW1tZWRpYXRlKCgpID0+IHt0aGlzLnNlYXJjaEVsLmZvY3VzKCl9KTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHBsdWdpbi5jdXJyZW50Vmlld2VyID0gdGhpcztcbiAgICAgICAgICAgICAgICAgICAgICAgIGFyb3VuZCh0aGlzLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2xvc2Uob2xkKSB7IHJldHVybiBmdW5jdGlvbiguLi5hcmdzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBsdWdpbi5jdXJyZW50Vmlld2VyID0gbnVsbDtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIG9sZC5hcHBseSh0aGlzLCBhcmdzKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9fSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBzaG93UGx1Z2luKG9sZCkgeyByZXR1cm4gYXN5bmMgZnVuY3Rpb24obWFuaWZlc3Qpe1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25zdCByZXMgPSBhd2FpdCBvbGQuY2FsbCh0aGlzLCBtYW5pZmVzdCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChwbHVnaW4uYXBwLnBsdWdpbnMucGx1Z2luc1ttYW5pZmVzdC5pZF0pIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IGJ1dHRvbnMgPSB0aGlzLnBsdWdpbkNvbnRlbnRFbC5maW5kKFwiYnV0dG9uXCIpLnBhcmVudEVsZW1lbnQ7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBrZXlCdG4gPSBidXR0b25zLmNyZWF0ZUVsKFwiYnV0dG9uXCIsIHtwcmVwZW5kOiB0cnVlLCB0ZXh0OiBcIkhvdGtleXNcIn0pO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgY2ZnQnRuID0gYnV0dG9ucy5jcmVhdGVFbChcImJ1dHRvblwiLCB7cHJlcGVuZDogdHJ1ZSwgdGV4dDogXCJPcHRpb25zXCJ9KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBsdWdpbi5ob3RrZXlCdXR0b25zW21hbmlmZXN0LmlkXSA9IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBzZXRUb29sdGlwKHRpcCkge2tleUJ0bi50aXRsZSA9IHRpcH0sIGV4dHJhU2V0dGluZ3NFbDoga2V5QnRuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwbHVnaW4uY29uZmlnQnV0dG9uc1ttYW5pZmVzdC5pZF0gPSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgc2V0VG9vbHRpcCgpIHt9LCBleHRyYVNldHRpbmdzRWw6IGNmZ0J0blxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcGx1Z2luLnJlZnJlc2hCdXR0b25zKHRydWUpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAga2V5QnRuLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAgKCkgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuY2xvc2UoKTsgcGx1Z2luLnNob3dIb3RrZXlzRm9yKG1hbmlmZXN0LmlkK1wiOlwiKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY2ZnQnRuLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAgKCkgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuY2xvc2UoKTsgcGx1Z2luLnNob3dDb25maWdGb3IobWFuaWZlc3QuaWQpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHJlcztcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9fVxuICAgICAgICAgICAgICAgICAgICAgICAgfSlcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gb2xkLmFwcGx5KHRoaXMsIGFyZ3MpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfSkpO1xuICAgIH1cblxuICAgIGdldFNldHRpbmdzVGFiKGlkKSB7IHJldHVybiB0aGlzLmFwcC5zZXR0aW5nLnNldHRpbmdUYWJzLmZpbHRlcih0ID0+IHQuaWQgPT09IGlkKS5zaGlmdCgpOyB9XG5cbiAgICBhZGRQbHVnaW5TZXR0aW5nRXZlbnRzKHRhYklkLCBvbGQpIHtcbiAgICAgICAgY29uc3QgYXBwID0gdGhpcy5hcHA7XG4gICAgICAgIGxldCBpbl9ldmVudCA9IGZhbHNlO1xuXG4gICAgICAgIGZ1bmN0aW9uIHRyaWdnZXIoLi4uYXJncykge1xuICAgICAgICAgICAgaW5fZXZlbnQgPSB0cnVlO1xuICAgICAgICAgICAgdHJ5IHsgYXBwLndvcmtzcGFjZS50cmlnZ2VyKC4uLmFyZ3MpOyB9IGNhdGNoKGUpIHsgY29uc29sZS5lcnJvcihlKTsgfVxuICAgICAgICAgICAgaW5fZXZlbnQgPSBmYWxzZTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIFdyYXBwZXIgdG8gYWRkIHBsdWdpbi1zZXR0aW5ncyBldmVudHNcbiAgICAgICAgcmV0dXJuIGZ1bmN0aW9uIGRpc3BsYXkoLi4uYXJncykge1xuICAgICAgICAgICAgaWYgKGluX2V2ZW50KSByZXR1cm47XG4gICAgICAgICAgICB0cmlnZ2VyKFwicGx1Z2luLXNldHRpbmdzOmJlZm9yZS1kaXNwbGF5XCIsIHRoaXMsIHRhYklkKTtcblxuICAgICAgICAgICAgLy8gVHJhY2sgd2hpY2ggcGx1Z2luIGVhY2ggc2V0dGluZyBpcyBmb3JcbiAgICAgICAgICAgIGxldCBtYW5pZmVzdHM7XG4gICAgICAgICAgICBpZiAodGFiSWQgPT09IFwicGx1Z2luc1wiKSB7XG4gICAgICAgICAgICAgICAgbWFuaWZlc3RzID0gT2JqZWN0LmVudHJpZXMoYXBwLmludGVybmFsUGx1Z2lucy5wbHVnaW5zKS5tYXAoXG4gICAgICAgICAgICAgICAgICAgIChbaWQsIHtpbnN0YW5jZToge25hbWV9LCBfbG9hZGVkOmVuYWJsZWR9XSkgPT4ge3JldHVybiB7aWQsIG5hbWUsIGVuYWJsZWR9O31cbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBtYW5pZmVzdHMgPSBPYmplY3QudmFsdWVzKGFwcC5wbHVnaW5zLm1hbmlmZXN0cyk7XG4gICAgICAgICAgICAgICAgbWFuaWZlc3RzLnNvcnQoKGUsIHQpID0+IGUubmFtZS5sb2NhbGVDb21wYXJlKHQubmFtZSkpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgbGV0IHdoaWNoID0gMDtcblxuICAgICAgICAgICAgLy8gVHJhcCB0aGUgYWRkaXRpb24gb2YgdGhlIFwidW5pbnN0YWxsXCIgYnV0dG9ucyBuZXh0IHRvIGVhY2ggcGx1Z2luXG4gICAgICAgICAgICBjb25zdCByZW1vdmUgPSBhcm91bmQoU2V0dGluZy5wcm90b3R5cGUsIHtcbiAgICAgICAgICAgICAgICBhZGRUb2dnbGUob2xkKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBmdW5jdGlvbiguLi5hcmdzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAodGFiSWQgPT09IFwicGx1Z2luc1wiICYmICFpbl9ldmVudCAmJiAobWFuaWZlc3RzW3doaWNoXXx8e30pLm5hbWUgPT09IHRoaXMubmFtZUVsLnRleHRDb250ZW50ICkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IG1hbmlmZXN0ID0gbWFuaWZlc3RzW3doaWNoKytdO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRyaWdnZXIoXCJwbHVnaW4tc2V0dGluZ3M6cGx1Z2luLWNvbnRyb2xcIiwgdGhpcywgbWFuaWZlc3QsIG1hbmlmZXN0LmVuYWJsZWQsIHRhYklkKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiBvbGQuYXBwbHkodGhpcywgYXJncyk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgIGFkZEV4dHJhQnV0dG9uKG9sZCkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gZnVuY3Rpb24oLi4uYXJncykge1xuICAgICAgICAgICAgICAgICAgICAgICAgLy8gVGhlIG9ubHkgXCJleHRyYXNcIiBhZGRlZCB0byBzZXR0aW5ncyB3L2EgZGVzY3JpcHRpb24gYXJlIG9uIHRoZSBwbHVnaW5zLCBjdXJyZW50bHksXG4gICAgICAgICAgICAgICAgICAgICAgICAvLyBzbyBvbmx5IHRyeSB0byBtYXRjaCB0aG9zZSB0byBwbHVnaW4gbmFtZXNcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICh0YWJJZCAhPT0gXCJwbHVnaW5zXCIgJiYgdGhpcy5kZXNjRWwuY2hpbGRFbGVtZW50Q291bnQgJiYgIWluX2V2ZW50KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCAobWFuaWZlc3RzW3doaWNoXXx8e30pLm5hbWUgPT09IHRoaXMubmFtZUVsLnRleHRDb250ZW50ICkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBtYW5pZmVzdCA9IG1hbmlmZXN0c1t3aGljaCsrXSwgZW5hYmxlZCA9ICEhYXBwLnBsdWdpbnMucGx1Z2luc1ttYW5pZmVzdC5pZF07XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRyaWdnZXIoXCJwbHVnaW4tc2V0dGluZ3M6cGx1Z2luLWNvbnRyb2xcIiwgdGhpcywgbWFuaWZlc3QsIGVuYWJsZWQsIHRhYklkKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIG9sZC5hcHBseSh0aGlzLCBhcmdzKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgIHJldHVybiBvbGQuYXBwbHkodGhpcywgYXJncyk7XG4gICAgICAgICAgICB9IGZpbmFsbHkge1xuICAgICAgICAgICAgICAgIHJlbW92ZSgpO1xuICAgICAgICAgICAgICAgIHRyaWdnZXIoXCJwbHVnaW4tc2V0dGluZ3M6YWZ0ZXItZGlzcGxheVwiLCB0aGlzKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH1cblxuICAgIGdvdG9QbHVnaW4oaWQsIHNob3c9XCJpbmZvXCIpIHtcbiAgICAgICAgaWYgKGlkICYmIHNob3cgPT09IFwiaG90a2V5c1wiKSByZXR1cm4gdGhpcy5zaG93SG90a2V5c0ZvcihpZCtcIjpcIik7XG4gICAgICAgIGlmIChpZCAmJiBzaG93ID09PSBcImNvbmZpZ1wiKSAge1xuICAgICAgICAgICAgaWYgKCF0aGlzLnNob3dDb25maWdGb3IoaWQpKSB0aGlzLmFwcC5zZXR0aW5nLmNsb3NlKCk7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cblxuICAgICAgICB0aGlzLnNob3dTZXR0aW5ncyhcImNvbW11bml0eS1wbHVnaW5zXCIpO1xuICAgICAgICBjb25zdCByZW1vdmUgPSBhcm91bmQoTW9kYWwucHJvdG90eXBlLCB7XG4gICAgICAgICAgICBvcGVuKG9sZCkge1xuICAgICAgICAgICAgICAgIHJldHVybiBmdW5jdGlvbiguLi5hcmdzKSB7XG4gICAgICAgICAgICAgICAgICAgIHJlbW92ZSgpO1xuICAgICAgICAgICAgICAgICAgICB0aGlzLmF1dG9sb2FkID0gaWQ7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBvbGQuYXBwbHkodGhpcywgYXJncyk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9KVxuICAgICAgICB0aGlzLmFwcC5zZXR0aW5nLmFjdGl2ZVRhYi5jb250YWluZXJFbC5maW5kKFwiLm1vZC1jdGFcIikuY2xpY2soKTtcbiAgICAgICAgLy8gWFhYIGhhbmRsZSBuYXYgdG8gbm90LWluc3RhbGxlZCBwbHVnaW5cbiAgICB9XG5cbiAgICBzaG93U2V0dGluZ3MoaWQpIHtcbiAgICAgICAgdGhpcy5jdXJyZW50Vmlld2VyPy5jbG9zZSgpOyAgLy8gY2xvc2UgdGhlIHBsdWdpbiBicm93c2VyIGlmIG9wZW5cbiAgICAgICAgc2V0dGluZ3NBcmVPcGVuKHRoaXMuYXBwKSB8fCB0aGlzLmFwcC5zZXR0aW5nLm9wZW4oKTtcbiAgICAgICAgaWYgKGlkKSB7XG4gICAgICAgICAgICB0aGlzLmFwcC5zZXR0aW5nLm9wZW5UYWJCeUlkKGlkKTtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLmFwcC5zZXR0aW5nLmFjdGl2ZVRhYj8uaWQgPT09IGlkID8gdGhpcy5hcHAuc2V0dGluZy5hY3RpdmVUYWIgOiBmYWxzZVxuICAgICAgICB9XG4gICAgfVxuXG4gICAgc2hvd0hvdGtleXNGb3Ioc2VhcmNoKSB7XG4gICAgICAgIGNvbnN0IHRhYiA9IHRoaXMuc2hvd1NldHRpbmdzKFwiaG90a2V5c1wiKTtcbiAgICAgICAgaWYgKHRhYiAmJiB0YWIuc2VhcmNoSW5wdXRFbCAmJiB0YWIudXBkYXRlSG90a2V5VmlzaWJpbGl0eSkge1xuICAgICAgICAgICAgdGFiLnNlYXJjaElucHV0RWwudmFsdWUgPSBzZWFyY2g7XG4gICAgICAgICAgICB0YWIudXBkYXRlSG90a2V5VmlzaWJpbGl0eSgpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgc2hvd0NvbmZpZ0ZvcihpZCkge1xuICAgICAgICBpZiAodGhpcy5zaG93U2V0dGluZ3MoaWQpKSByZXR1cm4gdHJ1ZTtcbiAgICAgICAgbmV3IE5vdGljZShcbiAgICAgICAgICAgIGBObyBzZXR0aW5ncyB0YWIgZm9yIFwiJHtpZH1cIjogaXQgbWF5IG5vdCBiZSBpbnN0YWxsZWQgb3IgbWlnaHQgbm90IGhhdmUgc2V0dGluZ3MuYFxuICAgICAgICApO1xuICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuXG4gICAgcGx1Z2luRW5hYmxlZChpZCkge1xuICAgICAgICByZXR1cm4gdGhpcy5hcHAuaW50ZXJuYWxQbHVnaW5zLnBsdWdpbnNbaWRdPy5fbG9hZGVkIHx8IHRoaXMuYXBwLnBsdWdpbnMucGx1Z2luc1tpZF07XG4gICAgfVxuXG4gICAgcmVmcmVzaEJ1dHRvbnMoZm9yY2U9ZmFsc2UpIHtcbiAgICAgICAgLy8gRG9uJ3QgcmVmcmVzaCB3aGVuIG5vdCBkaXNwbGF5aW5nLCB1bmxlc3MgcmVuZGVyaW5nIGlzIGluIHByb2dyZXNzXG4gICAgICAgIGlmICghcGx1Z2luU2V0dGluZ3NBcmVPcGVuKHRoaXMuYXBwKSAmJiAhZm9yY2UpIHJldHVybjtcblxuICAgICAgICBjb25zdCBoa20gPSB0aGlzLmFwcC5ob3RrZXlNYW5hZ2VyO1xuICAgICAgICBjb25zdCBhc3NpZ25lZEtleUNvdW50ID0ge307XG5cbiAgICAgICAgLy8gR2V0IGEgbGlzdCBvZiBjb21tYW5kcyBieSBwbHVnaW5cbiAgICAgICAgY29uc3QgY29tbWFuZHMgPSBPYmplY3QudmFsdWVzKHRoaXMuYXBwLmNvbW1hbmRzLmNvbW1hbmRzKS5yZWR1Y2UoKGNtZHMsIGNtZCk9PntcbiAgICAgICAgICAgIGNvbnN0IHBpZCA9IGNtZC5pZC5zcGxpdChcIjpcIiwyKS5zaGlmdCgpO1xuICAgICAgICAgICAgY29uc3QgaG90a2V5cyA9IChoa20uZ2V0SG90a2V5cyhjbWQuaWQpIHx8IGhrbS5nZXREZWZhdWx0SG90a2V5cyhjbWQuaWQpIHx8IFtdKS5tYXAoaG90a2V5VG9TdHJpbmcpO1xuICAgICAgICAgICAgaG90a2V5cy5mb3JFYWNoKGsgPT4gYXNzaWduZWRLZXlDb3VudFtrXSA9IDEgKyAoYXNzaWduZWRLZXlDb3VudFtrXXx8MCkpO1xuICAgICAgICAgICAgKGNtZHNbcGlkXSB8fCAoY21kc1twaWRdPVtdKSkucHVzaCh7aG90a2V5cywgY21kfSk7XG4gICAgICAgICAgICByZXR1cm4gY21kcztcbiAgICAgICAgfSwge30pO1xuXG4gICAgICAgIC8vIFBsdWdpbiBzZXR0aW5nIHRhYnMgYnkgcGx1Z2luXG4gICAgICAgIGNvbnN0IHRhYnMgPSBPYmplY3QudmFsdWVzKHRoaXMuYXBwLnNldHRpbmcucGx1Z2luVGFicykucmVkdWNlKCh0YWJzLCB0YWIpPT4ge1xuICAgICAgICAgICAgdGFic1t0YWIuaWRdID0gdGFiOyByZXR1cm4gdGFic1xuICAgICAgICB9LCB7fSk7XG4gICAgICAgIHRhYnNbXCJ3b3Jrc3BhY2VcIl0gPSB0YWJzW1wiZWRpdG9yXCJdID0gdHJ1ZTtcblxuICAgICAgICBmb3IoY29uc3QgaWQgb2YgT2JqZWN0LmtleXModGhpcy5jb25maWdCdXR0b25zIHx8IHt9KSkge1xuICAgICAgICAgICAgY29uc3QgYnRuID0gdGhpcy5jb25maWdCdXR0b25zW2lkXTtcbiAgICAgICAgICAgIGlmICghdGFic1tpZF0pIHtcbiAgICAgICAgICAgICAgICBidG4uZXh0cmFTZXR0aW5nc0VsLmhpZGUoKTtcbiAgICAgICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGJ0bi5leHRyYVNldHRpbmdzRWwuc2hvdygpO1xuICAgICAgICB9XG5cbiAgICAgICAgZm9yKGNvbnN0IGlkIG9mIE9iamVjdC5rZXlzKHRoaXMuaG90a2V5QnV0dG9ucyB8fCB7fSkpIHtcbiAgICAgICAgICAgIGNvbnN0IGJ0biA9IHRoaXMuaG90a2V5QnV0dG9uc1tpZF07XG4gICAgICAgICAgICBpZiAoIWNvbW1hbmRzW2lkXSkge1xuICAgICAgICAgICAgICAgIC8vIFBsdWdpbiBpcyBkaXNhYmxlZCBvciBoYXMgbm8gY29tbWFuZHNcbiAgICAgICAgICAgICAgICBidG4uZXh0cmFTZXR0aW5nc0VsLmhpZGUoKTtcbiAgICAgICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNvbnN0IGFzc2lnbmVkID0gY29tbWFuZHNbaWRdLmZpbHRlcihpbmZvID0+IGluZm8uaG90a2V5cy5sZW5ndGgpO1xuICAgICAgICAgICAgY29uc3QgY29uZmxpY3RzID0gYXNzaWduZWQuZmlsdGVyKGluZm8gPT4gaW5mby5ob3RrZXlzLmZpbHRlcihrID0+IGFzc2lnbmVkS2V5Q291bnRba10+MSkubGVuZ3RoKS5sZW5ndGg7XG5cbiAgICAgICAgICAgIGJ0bi5zZXRUb29sdGlwKFxuICAgICAgICAgICAgICAgIGBDb25maWd1cmUgaG90a2V5cyR7XCJcXG5cIn0oJHthc3NpZ25lZC5sZW5ndGh9LyR7Y29tbWFuZHNbaWRdLmxlbmd0aH0gYXNzaWduZWQke1xuICAgICAgICAgICAgICAgICAgICBjb25mbGljdHMgPyBcIjsgXCIrY29uZmxpY3RzK1wiIGNvbmZsaWN0aW5nXCIgOiBcIlwiXG4gICAgICAgICAgICAgICAgfSlgXG4gICAgICAgICAgICApO1xuICAgICAgICAgICAgYnRuLmV4dHJhU2V0dGluZ3NFbC50b2dnbGVDbGFzcyhcIm1vZC1lcnJvclwiLCAhIWNvbmZsaWN0cyk7XG4gICAgICAgICAgICBidG4uZXh0cmFTZXR0aW5nc0VsLnNob3coKTtcbiAgICAgICAgfVxuICAgIH1cbn1cbiJdLCJuYW1lcyI6WyJLZXltYXAiLCJNb2RhbCIsIlBsdWdpbiIsIlNldHRpbmciLCJkZWJvdW5jZSIsIlBsYXRmb3JtIl0sIm1hcHBpbmdzIjoiOzs7O0FBQU8sU0FBUyxNQUFNLENBQUMsR0FBRyxFQUFFLFNBQVMsRUFBRTtBQUN2QyxJQUFJLE1BQU0sUUFBUSxHQUFHLE1BQU0sQ0FBQyxJQUFJLENBQUMsU0FBUyxDQUFDLENBQUMsR0FBRyxDQUFDLEdBQUcsSUFBSSxPQUFPLENBQUMsR0FBRyxFQUFFLEdBQUcsRUFBRSxTQUFTLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQzFGLElBQUksT0FBTyxRQUFRLENBQUMsTUFBTSxLQUFLLENBQUMsR0FBRyxRQUFRLENBQUMsQ0FBQyxDQUFDLEdBQUcsWUFBWSxFQUFFLFFBQVEsQ0FBQyxPQUFPLENBQUMsQ0FBQyxJQUFJLENBQUMsRUFB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
