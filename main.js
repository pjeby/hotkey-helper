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
            const original = inputEl = containerEl.parentElement?.find(".search-input-container input");
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
        });
        setImmediate(() => {inputEl.focus();});
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWFpbi5qcyIsInNvdXJjZXMiOlsiLnlhcm4vY2FjaGUvbW9ua2V5LWFyb3VuZC1ucG0tMi4xLjAtNzBkZjMyZDJhYy0xYmQ3MmQyNWY5LnppcC9ub2RlX21vZHVsZXMvbW9ua2V5LWFyb3VuZC9tanMvaW5kZXguanMiLCJzcmMvcGx1Z2luLmpzIl0sInNvdXJjZXNDb250ZW50IjpbImV4cG9ydCBmdW5jdGlvbiBhcm91bmQob2JqLCBmYWN0b3JpZXMpIHtcbiAgICBjb25zdCByZW1vdmVycyA9IE9iamVjdC5rZXlzKGZhY3RvcmllcykubWFwKGtleSA9PiBhcm91bmQxKG9iaiwga2V5LCBmYWN0b3JpZXNba2V5XSkpO1xuICAgIHJldHVybiByZW1vdmVycy5sZW5ndGggPT09IDEgPyByZW1vdmVyc1swXSA6IGZ1bmN0aW9uICgpIHsgcmVtb3ZlcnMuZm9yRWFjaChyID0+IHIoKSk7IH07XG59XG5mdW5jdGlvbiBhcm91bmQxKG9iaiwgbWV0aG9kLCBjcmVhdGVXcmFwcGVyKSB7XG4gICAgY29uc3Qgb3JpZ2luYWwgPSBvYmpbbWV0aG9kXSwgaGFkT3duID0gb2JqLmhhc093blByb3BlcnR5KG1ldGhvZCk7XG4gICAgbGV0IGN1cnJlbnQgPSBjcmVhdGVXcmFwcGVyKG9yaWdpbmFsKTtcbiAgICAvLyBMZXQgb3VyIHdyYXBwZXIgaW5oZXJpdCBzdGF0aWMgcHJvcHMgZnJvbSB0aGUgd3JhcHBpbmcgbWV0aG9kLFxuICAgIC8vIGFuZCB0aGUgd3JhcHBpbmcgbWV0aG9kLCBwcm9wcyBmcm9tIHRoZSBvcmlnaW5hbCBtZXRob2RcbiAgICBpZiAob3JpZ2luYWwpXG4gICAgICAgIE9iamVjdC5zZXRQcm90b3R5cGVPZihjdXJyZW50LCBvcmlnaW5hbCk7XG4gICAgT2JqZWN0LnNldFByb3RvdHlwZU9mKHdyYXBwZXIsIGN1cnJlbnQpO1xuICAgIG9ialttZXRob2RdID0gd3JhcHBlcjtcbiAgICAvLyBSZXR1cm4gYSBjYWxsYmFjayB0byBhbGxvdyBzYWZlIHJlbW92YWxcbiAgICByZXR1cm4gcmVtb3ZlO1xuICAgIGZ1bmN0aW9uIHdyYXBwZXIoLi4uYXJncykge1xuICAgICAgICAvLyBJZiB3ZSBoYXZlIGJlZW4gZGVhY3RpdmF0ZWQgYW5kIGFyZSBubyBsb25nZXIgd3JhcHBlZCwgcmVtb3ZlIG91cnNlbHZlc1xuICAgICAgICBpZiAoY3VycmVudCA9PT0gb3JpZ2luYWwgJiYgb2JqW21ldGhvZF0gPT09IHdyYXBwZXIpXG4gICAgICAgICAgICByZW1vdmUoKTtcbiAgICAgICAgcmV0dXJuIGN1cnJlbnQuYXBwbHkodGhpcywgYXJncyk7XG4gICAgfVxuICAgIGZ1bmN0aW9uIHJlbW92ZSgpIHtcbiAgICAgICAgLy8gSWYgbm8gb3RoZXIgcGF0Y2hlcywganVzdCBkbyBhIGRpcmVjdCByZW1vdmFsXG4gICAgICAgIGlmIChvYmpbbWV0aG9kXSA9PT0gd3JhcHBlcikge1xuICAgICAgICAgICAgaWYgKGhhZE93bilcbiAgICAgICAgICAgICAgICBvYmpbbWV0aG9kXSA9IG9yaWdpbmFsO1xuICAgICAgICAgICAgZWxzZVxuICAgICAgICAgICAgICAgIGRlbGV0ZSBvYmpbbWV0aG9kXTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoY3VycmVudCA9PT0gb3JpZ2luYWwpXG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgIC8vIEVsc2UgcGFzcyBmdXR1cmUgY2FsbHMgdGhyb3VnaCwgYW5kIHJlbW92ZSB3cmFwcGVyIGZyb20gdGhlIHByb3RvdHlwZSBjaGFpblxuICAgICAgICBjdXJyZW50ID0gb3JpZ2luYWw7XG4gICAgICAgIE9iamVjdC5zZXRQcm90b3R5cGVPZih3cmFwcGVyLCBvcmlnaW5hbCB8fCBGdW5jdGlvbik7XG4gICAgfVxufVxuZXhwb3J0IGZ1bmN0aW9uIGFmdGVyKHByb21pc2UsIGNiKSB7XG4gICAgcmV0dXJuIHByb21pc2UudGhlbihjYiwgY2IpO1xufVxuZXhwb3J0IGZ1bmN0aW9uIHNlcmlhbGl6ZShhc3luY0Z1bmN0aW9uKSB7XG4gICAgbGV0IGxhc3RSdW4gPSBQcm9taXNlLnJlc29sdmUoKTtcbiAgICBmdW5jdGlvbiB3cmFwcGVyKC4uLmFyZ3MpIHtcbiAgICAgICAgcmV0dXJuIGxhc3RSdW4gPSBuZXcgUHJvbWlzZSgocmVzLCByZWopID0+IHtcbiAgICAgICAgICAgIGFmdGVyKGxhc3RSdW4sICgpID0+IHtcbiAgICAgICAgICAgICAgICBhc3luY0Z1bmN0aW9uLmFwcGx5KHRoaXMsIGFyZ3MpLnRoZW4ocmVzLCByZWopO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH0pO1xuICAgIH1cbiAgICB3cmFwcGVyLmFmdGVyID0gZnVuY3Rpb24gKCkge1xuICAgICAgICByZXR1cm4gbGFzdFJ1biA9IG5ldyBQcm9taXNlKChyZXMsIHJlaikgPT4geyBhZnRlcihsYXN0UnVuLCByZXMpOyB9KTtcbiAgICB9O1xuICAgIHJldHVybiB3cmFwcGVyO1xufVxuIiwiaW1wb3J0IHtQbHVnaW4sIFBsYXRmb3JtLCBLZXltYXAsIFNldHRpbmcsIE1vZGFsLCBkZWJvdW5jZX0gZnJvbSBcIm9ic2lkaWFuXCI7XG5pbXBvcnQge2Fyb3VuZH0gZnJvbSBcIm1vbmtleS1hcm91bmRcIjtcblxuZnVuY3Rpb24gaG90a2V5VG9TdHJpbmcoaG90a2V5KSB7XG4gICAgcmV0dXJuIEtleW1hcC5jb21waWxlTW9kaWZpZXJzKGhvdGtleS5tb2RpZmllcnMpK1wiLFwiICsgaG90a2V5LmtleS50b0xvd2VyQ2FzZSgpXG59XG5cbmZ1bmN0aW9uIGlzUGx1Z2luVGFiKGlkKSB7XG4gICAgcmV0dXJuIGlkID09PSBcInBsdWdpbnNcIiB8fCBpZCA9PT0gXCJjb21tdW5pdHktcGx1Z2luc1wiO1xufVxuXG5mdW5jdGlvbiBwbHVnaW5TZXR0aW5nc0FyZU9wZW4oYXBwKSB7XG4gICAgcmV0dXJuIHNldHRpbmdzQXJlT3BlbihhcHApICYmIGlzUGx1Z2luVGFiKGFwcC5zZXR0aW5nLmFjdGl2ZVRhYj8uaWQpXG59XG5cbmZ1bmN0aW9uIHNldHRpbmdzQXJlT3BlbihhcHApIHtcbiAgICByZXR1cm4gYXBwLnNldHRpbmcuY29udGFpbmVyRWwucGFyZW50RWxlbWVudCAhPT0gbnVsbFxufVxuXG5mdW5jdGlvbiBpc1BsdWdpblZpZXdlcihvYikge1xuICAgIHJldHVybiAoXG4gICAgICAgIG9iIGluc3RhbmNlb2YgTW9kYWwgJiZcbiAgICAgICAgb2IuaGFzT3duUHJvcGVydHkoXCJhdXRvbG9hZFwiKSAmJlxuICAgICAgICB0eXBlb2Ygb2Iuc2hvd1BsdWdpbiA9PT0gXCJmdW5jdGlvblwiICYmXG4gICAgICAgIHR5cGVvZiBvYi51cGRhdGVTZWFyY2ggPT09IFwiZnVuY3Rpb25cIiAmJlxuICAgICAgICB0eXBlb2Ygb2Iuc2VhcmNoRWwgPT0gXCJvYmplY3RcIlxuICAgICk7XG59XG5cbmZ1bmN0aW9uIG9uRWxlbWVudChlbCwgZXZlbnQsIHNlbGVjdG9yLCBjYWxsYmFjaywgb3B0aW9ucz1mYWxzZSkge1xuICAgIGVsLm9uKGV2ZW50LCBzZWxlY3RvciwgY2FsbGJhY2ssIG9wdGlvbnMpXG4gICAgcmV0dXJuICgpID0+IGVsLm9mZihldmVudCwgc2VsZWN0b3IsIGNhbGxiYWNrLCBvcHRpb25zKTtcbn1cblxuZXhwb3J0IGRlZmF1bHQgY2xhc3MgSG90a2V5SGVscGVyIGV4dGVuZHMgUGx1Z2luIHtcblxuICAgIG9ubG9hZCgpIHtcbiAgICAgICAgY29uc3Qgd29ya3NwYWNlID0gdGhpcy5hcHAud29ya3NwYWNlO1xuXG4gICAgICAgIHRoaXMucmVnaXN0ZXJFdmVudCggd29ya3NwYWNlLm9uKFwicGx1Z2luLXNldHRpbmdzOmJlZm9yZS1kaXNwbGF5XCIsIChzZXR0aW5nc1RhYiwgdGFiSWQpID0+IHtcbiAgICAgICAgICAgIHRoaXMuaG90a2V5QnV0dG9ucyA9IHt9O1xuICAgICAgICAgICAgdGhpcy5jb25maWdCdXR0b25zID0ge307XG4gICAgICAgICAgICB0aGlzLmdsb2JhbHNBZGRlZCA9IGZhbHNlO1xuICAgICAgICB9KSApO1xuICAgICAgICB0aGlzLnJlZ2lzdGVyRXZlbnQoIHdvcmtzcGFjZS5vbihcInBsdWdpbi1zZXR0aW5nczphZnRlci1kaXNwbGF5XCIsICAoKSA9PiB0aGlzLnJlZnJlc2hCdXR0b25zKHRydWUpKSApO1xuXG4gICAgICAgIHRoaXMucmVnaXN0ZXJFdmVudCggd29ya3NwYWNlLm9uKFwicGx1Z2luLXNldHRpbmdzOnBsdWdpbi1jb250cm9sXCIsIChzZXR0aW5nLCBtYW5pZmVzdCwgZW5hYmxlZCwgdGFiSWQpID0+IHtcbiAgICAgICAgICAgIHRoaXMuZ2xvYmFsc0FkZGVkIHx8IHRoaXMuYWRkR2xvYmFscyh0YWJJZCwgc2V0dGluZy5zZXR0aW5nRWwpO1xuICAgICAgICAgICAgdGhpcy5jcmVhdGVFeHRyYUJ1dHRvbnMoc2V0dGluZywgbWFuaWZlc3QsIGVuYWJsZWQpO1xuICAgICAgICB9KSApO1xuXG4gICAgICAgIC8vIFJlZnJlc2ggdGhlIGJ1dHRvbnMgd2hlbiBjb21tYW5kcyBvciBzZXR0aW5nIHRhYnMgYXJlIGFkZGVkIG9yIHJlbW92ZWRcbiAgICAgICAgY29uc3QgcmVxdWVzdFJlZnJlc2ggPSBkZWJvdW5jZSh0aGlzLnJlZnJlc2hCdXR0b25zLmJpbmQodGhpcyksIDUwLCB0cnVlKTtcbiAgICAgICAgZnVuY3Rpb24gcmVmcmVzaGVyKG9sZCkgeyByZXR1cm4gZnVuY3Rpb24oLi4uYXJncyl7IHJlcXVlc3RSZWZyZXNoKCk7IHJldHVybiBvbGQuYXBwbHkodGhpcywgYXJncyk7IH07IH1cbiAgICAgICAgdGhpcy5yZWdpc3Rlcihhcm91bmQoYXBwLmNvbW1hbmRzLCB7YWRkQ29tbWFuZDogICAgcmVmcmVzaGVyLCByZW1vdmVDb21tYW5kOiAgICByZWZyZXNoZXJ9KSk7XG4gICAgICAgIHRoaXMucmVnaXN0ZXIoYXJvdW5kKGFwcC5zZXR0aW5nLCAge2FkZFBsdWdpblRhYjogIHJlZnJlc2hlciwgcmVtb3ZlUGx1Z2luVGFiOiAgcmVmcmVzaGVyfSkpO1xuICAgICAgICB0aGlzLnJlZ2lzdGVyKGFyb3VuZChhcHAuc2V0dGluZywgIHthZGRTZXR0aW5nVGFiOiByZWZyZXNoZXIsIHJlbW92ZVNldHRpbmdUYWI6IHJlZnJlc2hlcn0pKTtcblxuICAgICAgICB3b3Jrc3BhY2Uub25MYXlvdXRSZWFkeSh0aGlzLndoZW5SZWFkeS5iaW5kKHRoaXMpKTtcbiAgICAgICAgdGhpcy5yZWdpc3Rlck9ic2lkaWFuUHJvdG9jb2xIYW5kbGVyKFwiZ290by1wbHVnaW5cIiwgKHtpZCwgc2hvd30pID0+IHtcbiAgICAgICAgICAgIHdvcmtzcGFjZS5vbkxheW91dFJlYWR5KCgpID0+IHsgdGhpcy5nb3RvUGx1Z2luKGlkLCBzaG93KTsgfSk7XG4gICAgICAgIH0pO1xuICAgIH1cblxuICAgIHdoZW5SZWFkeSgpIHtcbiAgICAgICAgY29uc3QgYXBwID0gdGhpcy5hcHAsIHBsdWdpbiA9IHRoaXM7XG5cbiAgICAgICAgLy8gU2F2ZSBhbmQgcmVzdG9yZSBjdXJyZW50IHRhYiAod29ya2Fyb3VuZCBodHRwczovL2ZvcnVtLm9ic2lkaWFuLm1kL3Qvc2V0dGluZ3MtZGlhbG9nLXJlc2V0cy10by1maXJzdC10YWItZXZlcnktdGltZS8xODI0MClcbiAgICAgICAgdGhpcy5yZWdpc3Rlcihhcm91bmQoYXBwLnNldHRpbmcsIHtcbiAgICAgICAgICAgIG9uT3BlbihvbGQpIHsgcmV0dXJuIGZ1bmN0aW9uKC4uLmFyZ3MpIHtcbiAgICAgICAgICAgICAgICBvbGQuYXBwbHkodGhpcywgYXJncyk7XG4gICAgICAgICAgICAgICAgaWYgKCFQbGF0Zm9ybS5pc01vYmlsZSAmJiBwbHVnaW4ubGFzdFRhYklkKSB0aGlzLm9wZW5UYWJCeUlkKHBsdWdpbi5sYXN0VGFiSWQpO1xuICAgICAgICAgICAgfX0sXG4gICAgICAgICAgICBvbkNsb3NlKG9sZCkgeyByZXR1cm4gZnVuY3Rpb24oLi4uYXJncykge1xuICAgICAgICAgICAgICAgIHBsdWdpbi5sYXN0VGFiSWQgPSB0aGlzLmFjdGl2ZVRhYj8uaWQ7XG4gICAgICAgICAgICAgICAgcmV0dXJuIG9sZC5hcHBseSh0aGlzLCBhcmdzKTtcbiAgICAgICAgICAgIH19XG4gICAgICAgIH0pKVxuXG4gICAgICAgIGNvbnN0IGNvcmVQbHVnaW5zID0gdGhpcy5nZXRTZXR0aW5nc1RhYihcInBsdWdpbnNcIik7XG4gICAgICAgIGNvbnN0IGNvbW11bml0eSAgID0gdGhpcy5nZXRTZXR0aW5nc1RhYihcImNvbW11bml0eS1wbHVnaW5zXCIpO1xuXG4gICAgICAgIC8vIEhvb2sgaW50byB0aGUgZGlzcGxheSgpIG1ldGhvZCBvZiB0aGUgcGx1Z2luIHNldHRpbmdzIHRhYnNcbiAgICAgICAgaWYgKGNvcmVQbHVnaW5zKSB0aGlzLnJlZ2lzdGVyKGFyb3VuZChjb3JlUGx1Z2lucywge2Rpc3BsYXk6IHRoaXMuYWRkUGx1Z2luU2V0dGluZ0V2ZW50cy5iaW5kKHRoaXMsIGNvcmVQbHVnaW5zLmlkKX0pKTtcbiAgICAgICAgaWYgKGNvbW11bml0eSkgICB0aGlzLnJlZ2lzdGVyKGFyb3VuZChjb21tdW5pdHksICAge2Rpc3BsYXk6IHRoaXMuYWRkUGx1Z2luU2V0dGluZ0V2ZW50cy5iaW5kKHRoaXMsIGNvbW11bml0eS5pZCl9KSk7XG5cbiAgICAgICAgaWYgKGNvbW11bml0eSkgICB0aGlzLnJlZ2lzdGVyKFxuICAgICAgICAgICAgLy8gVHJhcCBvcGVucyBvZiB0aGUgY29tbXVuaXR5IHBsdWdpbnMgdmlld2VyXG4gICAgICAgICAgICBvbkVsZW1lbnQoXG4gICAgICAgICAgICAgICAgY29tbXVuaXR5LmNvbnRhaW5lckVsLCBcImNsaWNrXCIsXG4gICAgICAgICAgICAgICAgXCIubW9kLWN0YSwgLmluc3RhbGxlZC1wbHVnaW5zLWNvbnRhaW5lciAuc2V0dGluZy1pdGVtLWluZm9cIixcbiAgICAgICAgICAgICAgICAoKSA9PiB0aGlzLmVuaGFuY2VWaWV3ZXIoKSxcbiAgICAgICAgICAgICAgICB0cnVlXG4gICAgICAgICAgICApXG4gICAgICAgICk7XG5cbiAgICAgICAgLy8gTm93IGZvcmNlIGEgcmVmcmVzaCBpZiBlaXRoZXIgcGx1Z2lucyB0YWIgaXMgY3VycmVudGx5IHZpc2libGUgKHRvIHNob3cgb3VyIG5ldyBidXR0b25zKVxuICAgICAgICBmdW5jdGlvbiByZWZyZXNoVGFiSWZPcGVuKCkge1xuICAgICAgICAgICAgaWYgKHBsdWdpblNldHRpbmdzQXJlT3BlbihhcHApKSBhcHAuc2V0dGluZy5vcGVuVGFiQnlJZChhcHAuc2V0dGluZy5hY3RpdmVUYWIuaWQpO1xuICAgICAgICB9XG4gICAgICAgIHJlZnJlc2hUYWJJZk9wZW4oKTtcblxuICAgICAgICAvLyBBbmQgZG8gaXQgYWdhaW4gYWZ0ZXIgd2UgdW5sb2FkICh0byByZW1vdmUgdGhlIG9sZCBidXR0b25zKVxuICAgICAgICB0aGlzLnJlZ2lzdGVyKCgpID0+IHNldEltbWVkaWF0ZShyZWZyZXNoVGFiSWZPcGVuKSk7XG5cbiAgICAgICAgLy8gVHdlYWsgdGhlIGhvdGtleSBzZXR0aW5ncyB0YWIgdG8gbWFrZSBmaWx0ZXJpbmcgd29yayBvbiBpZCBwcmVmaXhlcyBhcyB3ZWxsIGFzIGNvbW1hbmQgbmFtZXNcbiAgICAgICAgY29uc3QgaG90a2V5c1RhYiA9IHRoaXMuZ2V0U2V0dGluZ3NUYWIoXCJob3RrZXlzXCIpO1xuICAgICAgICBpZiAoaG90a2V5c1RhYikge1xuICAgICAgICAgICAgdGhpcy5yZWdpc3Rlcihhcm91bmQoaG90a2V5c1RhYiwge1xuICAgICAgICAgICAgICAgIGRpc3BsYXkob2xkKSB7IHJldHVybiBmdW5jdGlvbigpIHsgb2xkLmNhbGwodGhpcyk7IHRoaXMuc2VhcmNoSW5wdXRFbC5mb2N1cygpOyB9OyB9LFxuICAgICAgICAgICAgICAgIHVwZGF0ZUhvdGtleVZpc2liaWxpdHkob2xkKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBmdW5jdGlvbigpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IG9sZFNlYXJjaCA9IHRoaXMuc2VhcmNoSW5wdXRFbC52YWx1ZSwgb2xkQ29tbWFuZHMgPSBhcHAuY29tbWFuZHMuY29tbWFuZHM7XG4gICAgICAgICAgICAgICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChvbGRTZWFyY2guZW5kc1dpdGgoXCI6XCIpICYmICFvbGRTZWFyY2guY29udGFpbnMoXCIgXCIpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC8vIFRoaXMgaXMgYW4gaW5jcmVkaWJseSB1Z2x5IGhhY2sgdGhhdCByZWxpZXMgb24gdXBkYXRlSG90a2V5VmlzaWJpbGl0eSgpIGl0ZXJhdGluZyBhcHAuY29tbWFuZHMuY29tbWFuZHNcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLy8gbG9va2luZyBmb3IgaG90a2V5IGNvbmZsaWN0cyAqYmVmb3JlKiBhbnl0aGluZyBlbHNlLlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBsZXQgY3VycmVudCA9IG9sZENvbW1hbmRzO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBsZXQgZmlsdGVyZWQgPSBPYmplY3QuZnJvbUVudHJpZXMoT2JqZWN0LmVudHJpZXMoYXBwLmNvbW1hbmRzLmNvbW1hbmRzKS5maWx0ZXIoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAoW2lkLCBjbWRdKSA9PiAoaWQrXCI6XCIpLnN0YXJ0c1dpdGgob2xkU2VhcmNoKVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICApKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5zZWFyY2hJbnB1dEVsLnZhbHVlID0gXCJcIjtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXBwLmNvbW1hbmRzLmNvbW1hbmRzID0gbmV3IFByb3h5KG9sZENvbW1hbmRzLCB7b3duS2V5cygpe1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLy8gVGhlIGZpcnN0IHRpbWUgY29tbWFuZHMgYXJlIGl0ZXJhdGVkLCByZXR1cm4gdGhlIHdob2xlIHRoaW5nO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLy8gYWZ0ZXIgdGhhdCwgcmV0dXJuIHRoZSBmaWx0ZXJlZCBsaXN0XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0cnkgeyByZXR1cm4gT2JqZWN0LmtleXMoY3VycmVudCk7IH0gZmluYWxseSB7IGN1cnJlbnQgPSBmaWx0ZXJlZDsgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9fSk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiBvbGQuY2FsbCh0aGlzKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH0gZmluYWxseSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5zZWFyY2hJbnB1dEVsLnZhbHVlID0gb2xkU2VhcmNoO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFwcC5jb21tYW5kcy5jb21tYW5kcyA9IG9sZENvbW1hbmRzO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSkpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgY3JlYXRlRXh0cmFCdXR0b25zKHNldHRpbmcsIG1hbmlmZXN0LCBlbmFibGVkKSB7XG4gICAgICAgIHNldHRpbmcuYWRkRXh0cmFCdXR0b24oYnRuID0+IHtcbiAgICAgICAgICAgIGJ0bi5zZXRJY29uKFwiZ2VhclwiKTtcbiAgICAgICAgICAgIGJ0bi5vbkNsaWNrKCgpID0+IHRoaXMuc2hvd0NvbmZpZ0ZvcihtYW5pZmVzdC5pZC5yZXBsYWNlKC9ed29ya3NwYWNlJC8sXCJmaWxlXCIpKSk7XG4gICAgICAgICAgICBidG4uc2V0VG9vbHRpcChcIk9wdGlvbnNcIik7XG4gICAgICAgICAgICBidG4uZXh0cmFTZXR0aW5nc0VsLnRvZ2dsZShlbmFibGVkKVxuICAgICAgICAgICAgdGhpcy5jb25maWdCdXR0b25zW21hbmlmZXN0LmlkXSA9IGJ0bjtcbiAgICAgICAgfSk7XG4gICAgICAgIHNldHRpbmcuYWRkRXh0cmFCdXR0b24oYnRuID0+IHtcbiAgICAgICAgICAgIGJ0bi5zZXRJY29uKFwiYW55LWtleVwiKTtcbiAgICAgICAgICAgIGJ0bi5vbkNsaWNrKCgpID0+IHRoaXMuc2hvd0hvdGtleXNGb3IobWFuaWZlc3QuaWQrXCI6XCIpKVxuICAgICAgICAgICAgYnRuLmV4dHJhU2V0dGluZ3NFbC50b2dnbGUoZW5hYmxlZClcbiAgICAgICAgICAgIHRoaXMuaG90a2V5QnV0dG9uc1ttYW5pZmVzdC5pZF0gPSBidG47XG4gICAgICAgIH0pO1xuICAgIH1cblxuICAgIC8vIEFkZCB0b3AtbGV2ZWwgaXRlbXMgKHNlYXJjaCBhbmQgcHNldWRvLXBsdWdpbnMpXG4gICAgYWRkR2xvYmFscyh0YWJJZCwgc2V0dGluZ0VsKSB7XG4gICAgICAgIHRoaXMuZ2xvYmFsc0FkZGVkID0gdHJ1ZTtcblxuICAgICAgICAvLyBBZGQgYSBzZWFyY2ggZmlsdGVyIHRvIHNocmluayBwbHVnaW4gbGlzdFxuICAgICAgICBjb25zdCBjb250YWluZXJFbCA9IHNldHRpbmdFbC5wYXJlbnRFbGVtZW50O1xuICAgICAgICBsZXQgaW5wdXRFbDtcbiAgICAgICAgaWYgKHRhYklkICE9PSBcInBsdWdpbnNcIikge1xuICAgICAgICAgICAgLy8gUmVwbGFjZSB0aGUgYnVpbHQtaW4gc2VhcmNoIGhhbmRsZXJcbiAgICAgICAgICAgIGNvbnN0IG9yaWdpbmFsID0gaW5wdXRFbCA9IGNvbnRhaW5lckVsLnBhcmVudEVsZW1lbnQ/LmZpbmQoXCIuc2VhcmNoLWlucHV0LWNvbnRhaW5lciBpbnB1dFwiKVxuICAgICAgICAgICAgaWYgKG9yaWdpbmFsKSB7XG4gICAgICAgICAgICAgICAgaW5wdXRFbCA9IG9yaWdpbmFsLmNsb25lTm9kZSgpO1xuICAgICAgICAgICAgICAgIG9yaWdpbmFsLnBhcmVudEVsZW1lbnQucmVwbGFjZUNoaWxkKGlucHV0RWwsIG9yaWdpbmFsKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICBpbnB1dEVsID0gaW5wdXRFbCA/PyBjb250YWluZXJFbC5jcmVhdGVEaXYoXCJob3RrZXktc2VhcmNoLWNvbnRhaW5lclwiKS5jcmVhdGVFbChcbiAgICAgICAgICAgIFwiaW5wdXRcIiwge3R5cGU6IFwidGV4dFwiLCBhdHRyOiB7cGxhY2Vob2xkZXI6XCJGaWx0ZXIgcGx1Z2lucy4uLlwiLCBzcGVsbGNoZWNrOiBcImZhbHNlXCJ9fVxuICAgICAgICApO1xuICAgICAgICBpbnB1dEVsLmFkZEV2ZW50TGlzdGVuZXIoXCJpbnB1dFwiLCBmdW5jdGlvbigpe1xuICAgICAgICAgICAgY29uc3QgZmluZCA9IGlucHV0RWwudmFsdWUudG9Mb3dlckNhc2UoKTtcbiAgICAgICAgICAgIGZ1bmN0aW9uIG1hdGNoQW5kSGlnaGxpZ2h0KGVsKSB7XG4gICAgICAgICAgICAgICAgY29uc3QgdGV4dCA9IGVsLnRleHRDb250ZW50ID0gZWwudGV4dENvbnRlbnQ7IC8vIGNsZWFyIHByZXZpb3VzIGhpZ2hsaWdodGluZywgaWYgYW55XG4gICAgICAgICAgICAgICAgY29uc3QgaW5kZXggPSB0ZXh0LnRvTG93ZXJDYXNlKCkuaW5kZXhPZihmaW5kKTtcbiAgICAgICAgICAgICAgICBpZiAoIX5pbmRleCkgcmV0dXJuIGZhbHNlO1xuICAgICAgICAgICAgICAgIGVsLnRleHRDb250ZW50ID0gdGV4dC5zdWJzdHIoMCwgaW5kZXgpO1xuICAgICAgICAgICAgICAgIGVsLmNyZWF0ZVNwYW4oXCJzdWdnZXN0aW9uLWhpZ2hsaWdodFwiKS50ZXh0Q29udGVudCA9IHRleHQuc3Vic3RyKGluZGV4LCBmaW5kLmxlbmd0aCk7XG4gICAgICAgICAgICAgICAgZWwuaW5zZXJ0QWRqYWNlbnRUZXh0KFwiYmVmb3JlZW5kXCIsIHRleHQuc3Vic3RyKGluZGV4K2ZpbmQubGVuZ3RoKSlcbiAgICAgICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNvbnRhaW5lckVsLmZpbmRBbGwoXCIuc2V0dGluZy1pdGVtXCIpLmZvckVhY2goZSA9PiB7XG4gICAgICAgICAgICAgICAgY29uc3QgbmFtZU1hdGNoZXMgPSBtYXRjaEFuZEhpZ2hsaWdodChlLmZpbmQoXCIuc2V0dGluZy1pdGVtLW5hbWVcIikpO1xuICAgICAgICAgICAgICAgIGNvbnN0IGRlc2NNYXRjaGVzID0gbWF0Y2hBbmRIaWdobGlnaHQoXG4gICAgICAgICAgICAgICAgICAgIGUuZmluZChcIi5zZXR0aW5nLWl0ZW0tZGVzY3JpcHRpb24gPiBkaXY6bGFzdC1jaGlsZFwiKSA/P1xuICAgICAgICAgICAgICAgICAgICBlLmZpbmQoXCIuc2V0dGluZy1pdGVtLWRlc2NyaXB0aW9uXCIpXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICBlLnRvZ2dsZShuYW1lTWF0Y2hlcyB8fCBkZXNjTWF0Y2hlcyk7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfSk7XG4gICAgICAgIHNldEltbWVkaWF0ZSgoKSA9PiB7aW5wdXRFbC5mb2N1cygpfSk7XG4gICAgICAgIGNvbnRhaW5lckVsLmFwcGVuZChzZXR0aW5nRWwpO1xuXG4gICAgICAgIGlmICh0YWJJZCA9PT0gXCJwbHVnaW5zXCIpIHtcbiAgICAgICAgICAgIGNvbnN0IGVkaXRvck5hbWUgICAgPSB0aGlzLmdldFNldHRpbmdzVGFiKFwiZWRpdG9yXCIpPy5uYW1lIHx8IFwiRWRpdG9yXCI7XG4gICAgICAgICAgICBjb25zdCB3b3Jrc3BhY2VOYW1lID0gdGhpcy5nZXRTZXR0aW5nc1RhYihcImZpbGVcIik/Lm5hbWUgICB8fCBcIkZpbGVzICYgTGlua3NcIjtcbiAgICAgICAgICAgIHRoaXMuY3JlYXRlRXh0cmFCdXR0b25zKFxuICAgICAgICAgICAgICAgIG5ldyBTZXR0aW5nKHNldHRpbmdFbC5wYXJlbnRFbGVtZW50KVxuICAgICAgICAgICAgICAgICAgICAuc2V0TmFtZShcIkFwcFwiKS5zZXREZXNjKFwiTWlzY2VsbGFuZW91cyBhcHBsaWNhdGlvbiBjb21tYW5kcyAoYWx3YXlzIGVuYWJsZWQpXCIpLFxuICAgICAgICAgICAgICAgIHtpZDogXCJhcHBcIiwgbmFtZTogXCJBcHBcIn0sIHRydWVcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgICB0aGlzLmNyZWF0ZUV4dHJhQnV0dG9ucyhcbiAgICAgICAgICAgICAgICBuZXcgU2V0dGluZyhzZXR0aW5nRWwucGFyZW50RWxlbWVudClcbiAgICAgICAgICAgICAgICAgICAgLnNldE5hbWUoZWRpdG9yTmFtZSkuc2V0RGVzYyhcIkNvcmUgZWRpdGluZyBjb21tYW5kcyAoYWx3YXlzIGVuYWJsZWQpXCIpLFxuICAgICAgICAgICAgICAgIHtpZDogXCJlZGl0b3JcIiwgbmFtZTogZWRpdG9yTmFtZX0sIHRydWVcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgICB0aGlzLmNyZWF0ZUV4dHJhQnV0dG9ucyhcbiAgICAgICAgICAgICAgICBuZXcgU2V0dGluZyhzZXR0aW5nRWwucGFyZW50RWxlbWVudClcbiAgICAgICAgICAgICAgICAgICAgLnNldE5hbWUod29ya3NwYWNlTmFtZSkuc2V0RGVzYyhcIkNvcmUgZmlsZSBhbmQgcGFuZSBtYW5hZ2VtZW50IGNvbW1hbmRzIChhbHdheXMgZW5hYmxlZClcIiksXG4gICAgICAgICAgICAgICAge2lkOiBcIndvcmtzcGFjZVwiLCBuYW1lOiB3b3Jrc3BhY2VOYW1lfSwgdHJ1ZVxuICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIHNldHRpbmdFbC5wYXJlbnRFbGVtZW50LmFwcGVuZChzZXR0aW5nRWwpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgZW5oYW5jZVZpZXdlcigpIHtcbiAgICAgICAgY29uc3QgcGx1Z2luID0gdGhpcztcbiAgICAgICAgc2V0SW1tZWRpYXRlKGFyb3VuZChNb2RhbC5wcm90b3R5cGUsIHtcbiAgICAgICAgICAgIG9wZW4ob2xkKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGZ1bmN0aW9uKC4uLmFyZ3MpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKGlzUGx1Z2luVmlld2VyKHRoaXMpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBzZXRJbW1lZGlhdGUoKCkgPT4ge3RoaXMuc2VhcmNoRWwuZm9jdXMoKX0pO1xuICAgICAgICAgICAgICAgICAgICAgICAgcGx1Z2luLmN1cnJlbnRWaWV3ZXIgPSB0aGlzO1xuICAgICAgICAgICAgICAgICAgICAgICAgYXJvdW5kKHRoaXMsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjbG9zZShvbGQpIHsgcmV0dXJuIGZ1bmN0aW9uKC4uLmFyZ3MpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcGx1Z2luLmN1cnJlbnRWaWV3ZXIgPSBudWxsO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gb2xkLmFwcGx5KHRoaXMsIGFyZ3MpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH19LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNob3dQbHVnaW4ob2xkKSB7IHJldHVybiBhc3luYyBmdW5jdGlvbihtYW5pZmVzdCl7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IHJlcyA9IGF3YWl0IG9sZC5jYWxsKHRoaXMsIG1hbmlmZXN0KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHBsdWdpbi5hcHAucGx1Z2lucy5wbHVnaW5zW21hbmlmZXN0LmlkXSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgYnV0dG9ucyA9IHRoaXMucGx1Z2luQ29udGVudEVsLmZpbmQoXCJidXR0b25cIikucGFyZW50RWxlbWVudDtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IGtleUJ0biA9IGJ1dHRvbnMuY3JlYXRlRWwoXCJidXR0b25cIiwge3ByZXBlbmQ6IHRydWUsIHRleHQ6IFwiSG90a2V5c1wifSk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBjZmdCdG4gPSBidXR0b25zLmNyZWF0ZUVsKFwiYnV0dG9uXCIsIHtwcmVwZW5kOiB0cnVlLCB0ZXh0OiBcIk9wdGlvbnNcIn0pO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcGx1Z2luLmhvdGtleUJ1dHRvbnNbbWFuaWZlc3QuaWRdID0ge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNldFRvb2x0aXAodGlwKSB7a2V5QnRuLnRpdGxlID0gdGlwfSwgZXh0cmFTZXR0aW5nc0VsOiBrZXlCdG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBsdWdpbi5jb25maWdCdXR0b25zW21hbmlmZXN0LmlkXSA9IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBzZXRUb29sdGlwKCkge30sIGV4dHJhU2V0dGluZ3NFbDogY2ZnQnRuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwbHVnaW4ucmVmcmVzaEJ1dHRvbnModHJ1ZSk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBrZXlCdG4uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsICAoKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5jbG9zZSgpOyBwbHVnaW4uc2hvd0hvdGtleXNGb3IobWFuaWZlc3QuaWQrXCI6XCIpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjZmdCdG4uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsICAoKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5jbG9zZSgpOyBwbHVnaW4uc2hvd0NvbmZpZ0ZvcihtYW5pZmVzdC5pZCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gcmVzO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH19XG4gICAgICAgICAgICAgICAgICAgICAgICB9KVxuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBvbGQuYXBwbHkodGhpcywgYXJncyk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9KSk7XG4gICAgfVxuXG4gICAgZ2V0U2V0dGluZ3NUYWIoaWQpIHsgcmV0dXJuIHRoaXMuYXBwLnNldHRpbmcuc2V0dGluZ1RhYnMuZmlsdGVyKHQgPT4gdC5pZCA9PT0gaWQpLnNoaWZ0KCk7IH1cblxuICAgIGFkZFBsdWdpblNldHRpbmdFdmVudHModGFiSWQsIG9sZCkge1xuICAgICAgICBjb25zdCBhcHAgPSB0aGlzLmFwcDtcbiAgICAgICAgbGV0IGluX2V2ZW50ID0gZmFsc2U7XG5cbiAgICAgICAgZnVuY3Rpb24gdHJpZ2dlciguLi5hcmdzKSB7XG4gICAgICAgICAgICBpbl9ldmVudCA9IHRydWU7XG4gICAgICAgICAgICB0cnkgeyBhcHAud29ya3NwYWNlLnRyaWdnZXIoLi4uYXJncyk7IH0gY2F0Y2goZSkgeyBjb25zb2xlLmVycm9yKGUpOyB9XG4gICAgICAgICAgICBpbl9ldmVudCA9IGZhbHNlO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gV3JhcHBlciB0byBhZGQgcGx1Z2luLXNldHRpbmdzIGV2ZW50c1xuICAgICAgICByZXR1cm4gZnVuY3Rpb24gZGlzcGxheSguLi5hcmdzKSB7XG4gICAgICAgICAgICBpZiAoaW5fZXZlbnQpIHJldHVybjtcbiAgICAgICAgICAgIHRyaWdnZXIoXCJwbHVnaW4tc2V0dGluZ3M6YmVmb3JlLWRpc3BsYXlcIiwgdGhpcywgdGFiSWQpO1xuXG4gICAgICAgICAgICAvLyBUcmFjayB3aGljaCBwbHVnaW4gZWFjaCBzZXR0aW5nIGlzIGZvclxuICAgICAgICAgICAgbGV0IG1hbmlmZXN0cztcbiAgICAgICAgICAgIGlmICh0YWJJZCA9PT0gXCJwbHVnaW5zXCIpIHtcbiAgICAgICAgICAgICAgICBtYW5pZmVzdHMgPSBPYmplY3QuZW50cmllcyhhcHAuaW50ZXJuYWxQbHVnaW5zLnBsdWdpbnMpLm1hcChcbiAgICAgICAgICAgICAgICAgICAgKFtpZCwge2luc3RhbmNlOiB7bmFtZX0sIF9sb2FkZWQ6ZW5hYmxlZH1dKSA9PiB7cmV0dXJuIHtpZCwgbmFtZSwgZW5hYmxlZH07fVxuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIG1hbmlmZXN0cyA9IE9iamVjdC52YWx1ZXMoYXBwLnBsdWdpbnMubWFuaWZlc3RzKTtcbiAgICAgICAgICAgICAgICBtYW5pZmVzdHMuc29ydCgoZSwgdCkgPT4gZS5uYW1lLmxvY2FsZUNvbXBhcmUodC5uYW1lKSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBsZXQgd2hpY2ggPSAwO1xuXG4gICAgICAgICAgICAvLyBUcmFwIHRoZSBhZGRpdGlvbiBvZiB0aGUgXCJ1bmluc3RhbGxcIiBidXR0b25zIG5leHQgdG8gZWFjaCBwbHVnaW5cbiAgICAgICAgICAgIGNvbnN0IHJlbW92ZSA9IGFyb3VuZChTZXR0aW5nLnByb3RvdHlwZSwge1xuICAgICAgICAgICAgICAgIGFkZFRvZ2dsZShvbGQpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGZ1bmN0aW9uKC4uLmFyZ3MpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICh0YWJJZCA9PT0gXCJwbHVnaW5zXCIgJiYgIWluX2V2ZW50ICYmIChtYW5pZmVzdHNbd2hpY2hdfHx7fSkubmFtZSA9PT0gdGhpcy5uYW1lRWwudGV4dENvbnRlbnQgKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgbWFuaWZlc3QgPSBtYW5pZmVzdHNbd2hpY2grK107XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdHJpZ2dlcihcInBsdWdpbi1zZXR0aW5nczpwbHVnaW4tY29udHJvbFwiLCB0aGlzLCBtYW5pZmVzdCwgbWFuaWZlc3QuZW5hYmxlZCwgdGFiSWQpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIG9sZC5hcHBseSh0aGlzLCBhcmdzKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgYWRkRXh0cmFCdXR0b24ob2xkKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBmdW5jdGlvbiguLi5hcmdzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAvLyBUaGUgb25seSBcImV4dHJhc1wiIGFkZGVkIHRvIHNldHRpbmdzIHcvYSBkZXNjcmlwdGlvbiBhcmUgb24gdGhlIHBsdWdpbnMsIGN1cnJlbnRseSxcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vIHNvIG9ubHkgdHJ5IHRvIG1hdGNoIHRob3NlIHRvIHBsdWdpbiBuYW1lc1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHRhYklkICE9PSBcInBsdWdpbnNcIiAmJiB0aGlzLmRlc2NFbC5jaGlsZEVsZW1lbnRDb3VudCAmJiAhaW5fZXZlbnQpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoIChtYW5pZmVzdHNbd2hpY2hdfHx7fSkubmFtZSA9PT0gdGhpcy5uYW1lRWwudGV4dENvbnRlbnQgKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IG1hbmlmZXN0ID0gbWFuaWZlc3RzW3doaWNoKytdLCBlbmFibGVkID0gISFhcHAucGx1Z2lucy5wbHVnaW5zW21hbmlmZXN0LmlkXTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHJpZ2dlcihcInBsdWdpbi1zZXR0aW5nczpwbHVnaW4tY29udHJvbFwiLCB0aGlzLCBtYW5pZmVzdCwgZW5hYmxlZCwgdGFiSWQpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgIH07XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gb2xkLmFwcGx5KHRoaXMsIGFyZ3MpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIG9sZC5hcHBseSh0aGlzLCBhcmdzKTtcbiAgICAgICAgICAgIH0gZmluYWxseSB7XG4gICAgICAgICAgICAgICAgcmVtb3ZlKCk7XG4gICAgICAgICAgICAgICAgdHJpZ2dlcihcInBsdWdpbi1zZXR0aW5nczphZnRlci1kaXNwbGF5XCIsIHRoaXMpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfVxuXG4gICAgZ290b1BsdWdpbihpZCwgc2hvdz1cImluZm9cIikge1xuICAgICAgICBpZiAoaWQgJiYgc2hvdyA9PT0gXCJob3RrZXlzXCIpIHJldHVybiB0aGlzLnNob3dIb3RrZXlzRm9yKGlkK1wiOlwiKTtcbiAgICAgICAgaWYgKGlkICYmIHNob3cgPT09IFwiY29uZmlnXCIpICB7XG4gICAgICAgICAgICBpZiAoIXRoaXMuc2hvd0NvbmZpZ0ZvcihpZCkpIHRoaXMuYXBwLnNldHRpbmcuY2xvc2UoKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuXG4gICAgICAgIHRoaXMuc2hvd1NldHRpbmdzKFwiY29tbXVuaXR5LXBsdWdpbnNcIik7XG4gICAgICAgIGNvbnN0IHJlbW92ZSA9IGFyb3VuZChNb2RhbC5wcm90b3R5cGUsIHtcbiAgICAgICAgICAgIG9wZW4ob2xkKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGZ1bmN0aW9uKC4uLmFyZ3MpIHtcbiAgICAgICAgICAgICAgICAgICAgcmVtb3ZlKCk7XG4gICAgICAgICAgICAgICAgICAgIHRoaXMuYXV0b2xvYWQgPSBpZDtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIG9sZC5hcHBseSh0aGlzLCBhcmdzKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pXG4gICAgICAgIHRoaXMuYXBwLnNldHRpbmcuYWN0aXZlVGFiLmNvbnRhaW5lckVsLmZpbmQoXCIubW9kLWN0YVwiKS5jbGljaygpO1xuICAgICAgICAvLyBYWFggaGFuZGxlIG5hdiB0byBub3QtaW5zdGFsbGVkIHBsdWdpblxuICAgIH1cblxuICAgIHNob3dTZXR0aW5ncyhpZCkge1xuICAgICAgICB0aGlzLmN1cnJlbnRWaWV3ZXI/LmNsb3NlKCk7ICAvLyBjbG9zZSB0aGUgcGx1Z2luIGJyb3dzZXIgaWYgb3BlblxuICAgICAgICBzZXR0aW5nc0FyZU9wZW4odGhpcy5hcHApIHx8IHRoaXMuYXBwLnNldHRpbmcub3BlbigpO1xuICAgICAgICBpZiAoaWQpIHtcbiAgICAgICAgICAgIHRoaXMuYXBwLnNldHRpbmcub3BlblRhYkJ5SWQoaWQpO1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMuYXBwLnNldHRpbmcuYWN0aXZlVGFiPy5pZCA9PT0gaWQgPyB0aGlzLmFwcC5zZXR0aW5nLmFjdGl2ZVRhYiA6IGZhbHNlXG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBzaG93SG90a2V5c0ZvcihzZWFyY2gpIHtcbiAgICAgICAgY29uc3QgdGFiID0gdGhpcy5zaG93U2V0dGluZ3MoXCJob3RrZXlzXCIpO1xuICAgICAgICBpZiAodGFiICYmIHRhYi5zZWFyY2hJbnB1dEVsICYmIHRhYi51cGRhdGVIb3RrZXlWaXNpYmlsaXR5KSB7XG4gICAgICAgICAgICB0YWIuc2VhcmNoSW5wdXRFbC52YWx1ZSA9IHNlYXJjaDtcbiAgICAgICAgICAgIHRhYi51cGRhdGVIb3RrZXlWaXNpYmlsaXR5KCk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBzaG93Q29uZmlnRm9yKGlkKSB7XG4gICAgICAgIGlmICh0aGlzLnNob3dTZXR0aW5ncyhpZCkpIHJldHVybiB0cnVlO1xuICAgICAgICBuZXcgTm90aWNlKFxuICAgICAgICAgICAgYE5vIHNldHRpbmdzIHRhYiBmb3IgXCIke2lkfVwiOiBpdCBtYXkgbm90IGJlIGluc3RhbGxlZCBvciBtaWdodCBub3QgaGF2ZSBzZXR0aW5ncy5gXG4gICAgICAgICk7XG4gICAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG5cbiAgICBwbHVnaW5FbmFibGVkKGlkKSB7XG4gICAgICAgIHJldHVybiB0aGlzLmFwcC5pbnRlcm5hbFBsdWdpbnMucGx1Z2luc1tpZF0/Ll9sb2FkZWQgfHwgdGhpcy5hcHAucGx1Z2lucy5wbHVnaW5zW2lkXTtcbiAgICB9XG5cbiAgICByZWZyZXNoQnV0dG9ucyhmb3JjZT1mYWxzZSkge1xuICAgICAgICAvLyBEb24ndCByZWZyZXNoIHdoZW4gbm90IGRpc3BsYXlpbmcsIHVubGVzcyByZW5kZXJpbmcgaXMgaW4gcHJvZ3Jlc3NcbiAgICAgICAgaWYgKCFwbHVnaW5TZXR0aW5nc0FyZU9wZW4odGhpcy5hcHApICYmICFmb3JjZSkgcmV0dXJuO1xuXG4gICAgICAgIGNvbnN0IGhrbSA9IHRoaXMuYXBwLmhvdGtleU1hbmFnZXI7XG4gICAgICAgIGNvbnN0IGFzc2lnbmVkS2V5Q291bnQgPSB7fTtcblxuICAgICAgICAvLyBHZXQgYSBsaXN0IG9mIGNvbW1hbmRzIGJ5IHBsdWdpblxuICAgICAgICBjb25zdCBjb21tYW5kcyA9IE9iamVjdC52YWx1ZXModGhpcy5hcHAuY29tbWFuZHMuY29tbWFuZHMpLnJlZHVjZSgoY21kcywgY21kKT0+e1xuICAgICAgICAgICAgY29uc3QgcGlkID0gY21kLmlkLnNwbGl0KFwiOlwiLDIpLnNoaWZ0KCk7XG4gICAgICAgICAgICBjb25zdCBob3RrZXlzID0gKGhrbS5nZXRIb3RrZXlzKGNtZC5pZCkgfHwgaGttLmdldERlZmF1bHRIb3RrZXlzKGNtZC5pZCkgfHwgW10pLm1hcChob3RrZXlUb1N0cmluZyk7XG4gICAgICAgICAgICBob3RrZXlzLmZvckVhY2goayA9PiBhc3NpZ25lZEtleUNvdW50W2tdID0gMSArIChhc3NpZ25lZEtleUNvdW50W2tdfHwwKSk7XG4gICAgICAgICAgICAoY21kc1twaWRdIHx8IChjbWRzW3BpZF09W10pKS5wdXNoKHtob3RrZXlzLCBjbWR9KTtcbiAgICAgICAgICAgIHJldHVybiBjbWRzO1xuICAgICAgICB9LCB7fSk7XG5cbiAgICAgICAgLy8gUGx1Z2luIHNldHRpbmcgdGFicyBieSBwbHVnaW5cbiAgICAgICAgY29uc3QgdGFicyA9IE9iamVjdC52YWx1ZXModGhpcy5hcHAuc2V0dGluZy5wbHVnaW5UYWJzKS5yZWR1Y2UoKHRhYnMsIHRhYik9PiB7XG4gICAgICAgICAgICB0YWJzW3RhYi5pZF0gPSB0YWI7IHJldHVybiB0YWJzXG4gICAgICAgIH0sIHt9KTtcbiAgICAgICAgdGFic1tcIndvcmtzcGFjZVwiXSA9IHRhYnNbXCJlZGl0b3JcIl0gPSB0cnVlO1xuXG4gICAgICAgIGZvcihjb25zdCBpZCBvZiBPYmplY3Qua2V5cyh0aGlzLmNvbmZpZ0J1dHRvbnMgfHwge30pKSB7XG4gICAgICAgICAgICBjb25zdCBidG4gPSB0aGlzLmNvbmZpZ0J1dHRvbnNbaWRdO1xuICAgICAgICAgICAgaWYgKCF0YWJzW2lkXSkge1xuICAgICAgICAgICAgICAgIGJ0bi5leHRyYVNldHRpbmdzRWwuaGlkZSgpO1xuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgYnRuLmV4dHJhU2V0dGluZ3NFbC5zaG93KCk7XG4gICAgICAgIH1cblxuICAgICAgICBmb3IoY29uc3QgaWQgb2YgT2JqZWN0LmtleXModGhpcy5ob3RrZXlCdXR0b25zIHx8IHt9KSkge1xuICAgICAgICAgICAgY29uc3QgYnRuID0gdGhpcy5ob3RrZXlCdXR0b25zW2lkXTtcbiAgICAgICAgICAgIGlmICghY29tbWFuZHNbaWRdKSB7XG4gICAgICAgICAgICAgICAgLy8gUGx1Z2luIGlzIGRpc2FibGVkIG9yIGhhcyBubyBjb21tYW5kc1xuICAgICAgICAgICAgICAgIGJ0bi5leHRyYVNldHRpbmdzRWwuaGlkZSgpO1xuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY29uc3QgYXNzaWduZWQgPSBjb21tYW5kc1tpZF0uZmlsdGVyKGluZm8gPT4gaW5mby5ob3RrZXlzLmxlbmd0aCk7XG4gICAgICAgICAgICBjb25zdCBjb25mbGljdHMgPSBhc3NpZ25lZC5maWx0ZXIoaW5mbyA9PiBpbmZvLmhvdGtleXMuZmlsdGVyKGsgPT4gYXNzaWduZWRLZXlDb3VudFtrXT4xKS5sZW5ndGgpLmxlbmd0aDtcblxuICAgICAgICAgICAgYnRuLnNldFRvb2x0aXAoXG4gICAgICAgICAgICAgICAgYENvbmZpZ3VyZSBob3RrZXlzJHtcIlxcblwifSgke2Fzc2lnbmVkLmxlbmd0aH0vJHtjb21tYW5kc1tpZF0ubGVuZ3RofSBhc3NpZ25lZCR7XG4gICAgICAgICAgICAgICAgICAgIGNvbmZsaWN0cyA/IFwiOyBcIitjb25mbGljdHMrXCIgY29uZmxpY3RpbmdcIiA6IFwiXCJcbiAgICAgICAgICAgICAgICB9KWBcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgICBidG4uZXh0cmFTZXR0aW5nc0VsLnRvZ2dsZUNsYXNzKFwibW9kLWVycm9yXCIsICEhY29uZmxpY3RzKTtcbiAgICAgICAgICAgIGJ0bi5leHRyYVNldHRpbmdzRWwuc2hvdygpO1xuICAgICAgICB9XG4gICAgfVxufVxuIl0sIm5hbWVzIjpbIktleW1hcCIsIk1vZGFsIiwiUGx1Z2luIiwiZGVib3VuY2UiLCJQbGF0Zm9ybSIsIlNldHRpbmciXSwibWFwcGluZ3MiOiI7Ozs7QUFBTyxTQUFTLE1BQU0sQ0FBQyxHQUFHLEVBQUUsU0FBUyxFQUFFO0FBQ3ZDLElBQUksTUFBTSxRQUFRLEdBQUcsTUFBTSxDQUFDLElBQUksQ0FBQyxTQUFTLENBQUMsQ0FBQyxHQUFHLENBQUMsR0FBRyxJQUFJLE9BQU8sQ0FBQyxHQUFHLEVBQUUsR0FBRyxFQUFFLFNBQVMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDMUYsSUFBSSxPQUFPLFFBQVEsQ0FBQyxNQUFNLEtBQUssQ0FBQyxHQUFHLFFBQVEsQ0FBQyxDQUFDLENBQUMsR0FBRyxZQUFZLEVBQUUsUUFBUSxDQUFDLE9BQU8sQ0FBQyxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUMsQ0FBQyxFQUFFLENBQUM7QUFDN0YsQ0FBQztBQUNELFNBQVMsT0FBTyxDQUFDLEdBQUcsRUFBRSxNQUFNLEVBQUUsYUFBYSxFQUFFO0FBQzdDLElBQUksTUFBTSxRQUFRLEdBQUcsR0FBRyxDQUFDLE1BQU0sQ0FBQyxFQUFFLE1BQU0sR0FBRyxHQUFHLENBQUMsY0FBYyxDQUFDLE1BQU0sQ0FBQyxDQUFDO0FBQ3RFLElBQUksSUFBSSxPQUFPLEdBQUcsYUFBYSxDQUFDLFFBQVEsQ0FBQyxDQUFDO0FBQzFDO0FBQ0E7QUFDQSxJQUFJLElBQUksUUFBUTtBQUNoQixRQUFRLE1BQU0sQ0FBQyxjQUFjLENBQUMsT0FBTyxFQUFFLFFBQVEsQ0FBQyxDQUFDO0FBQ2pELElBQUksTUFBTSxDQUFDLGNBQWMsQ0FBQyxPQUFPLEVBQUUsT0FBTyxDQUFDLENBQUM7QUFDNUMsSUFBSSxHQUFHLENBQUMsTUFBTSxDQUFDLEdBQUcsT0FBTyxDQUFDO0FBQzFCO0FBQ0EsSUFBSSxPQUFPLE1BQU0sQ0FBQztBQUNs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
