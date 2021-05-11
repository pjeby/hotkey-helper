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
    return id === "plugins" || id === "third-party-plugins" || id === "community-plugins";
}

function pluginSettingsAreOpen(app) {
    return (
        app.setting.containerEl.parentElement !== null &&
        app.setting.activeTab &&
        isPluginTab(app.setting.activeTab.id)
    );
}

class HotkeyHelper extends obsidian.Plugin {

    onload() {
        const workspace = this.app.workspace;

        this.registerEvent( workspace.on("plugin-settings:before-display", (settingsTab, tabId) => {
            this.hotkeyButtons = {};
            this.configButtons = {};
            this.havePseudos = false;
        }) );
        this.registerEvent( workspace.on("plugin-settings:after-display",  () => this.refreshButtons(true)) );

        const createExtraButtons = (setting, manifest, enabled) => {
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
        };

        this.registerEvent( workspace.on("plugin-settings:plugin-control", (setting, manifest, enabled, tabId) => {
            if (!this.havePseudos) {
                // Add a search filter to shrink plugin list
                const containerEl = setting.settingEl.parentElement;
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
                containerEl.append(setting.settingEl);
            }

            if (tabId === "plugins" && ! this.havePseudos) {
                const editorName    = this.getSettingsTab("editor")?.name || "Editor";
                const workspaceName = this.getSettingsTab("file")?.name   || "Files & Links";
                createExtraButtons(
                    new obsidian.Setting(setting.settingEl.parentElement)
                        .setName("App").setDesc("Miscellaneous application commands (always enabled)"),
                    {id: "app", name: "App"}, true
                );
                createExtraButtons(
                    new obsidian.Setting(setting.settingEl.parentElement)
                        .setName(editorName).setDesc("Core editing commands (always enabled)"),
                    {id: "editor", name: editorName}, true
                );
                createExtraButtons(
                    new obsidian.Setting(setting.settingEl.parentElement)
                        .setName(workspaceName).setDesc("Core file and pane management commands (always enabled)"),
                    {id: "workspace", name: workspaceName}, true
                );
                setting.settingEl.parentElement.append(setting.settingEl);
            }

            this.havePseudos = true;
            createExtraButtons(setting, manifest, enabled);
        }) );

        // Refresh the buttons when commands or setting tabs are added or removed
        const requestRefresh = obsidian.debounce(this.refreshButtons.bind(this), 50, true);
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWFpbi5qcyIsInNvdXJjZXMiOlsiLnlhcm4vY2FjaGUvbW9ua2V5LWFyb3VuZC1ucG0tMi4xLjAtNzBkZjMyZDJhYy0xYmQ3MmQyNWY5LnppcC9ub2RlX21vZHVsZXMvbW9ua2V5LWFyb3VuZC9tanMvaW5kZXguanMiLCJzcmMvcGx1Z2luLmpzIl0sInNvdXJjZXNDb250ZW50IjpbImV4cG9ydCBmdW5jdGlvbiBhcm91bmQob2JqLCBmYWN0b3JpZXMpIHtcbiAgICBjb25zdCByZW1vdmVycyA9IE9iamVjdC5rZXlzKGZhY3RvcmllcykubWFwKGtleSA9PiBhcm91bmQxKG9iaiwga2V5LCBmYWN0b3JpZXNba2V5XSkpO1xuICAgIHJldHVybiByZW1vdmVycy5sZW5ndGggPT09IDEgPyByZW1vdmVyc1swXSA6IGZ1bmN0aW9uICgpIHsgcmVtb3ZlcnMuZm9yRWFjaChyID0+IHIoKSk7IH07XG59XG5mdW5jdGlvbiBhcm91bmQxKG9iaiwgbWV0aG9kLCBjcmVhdGVXcmFwcGVyKSB7XG4gICAgY29uc3Qgb3JpZ2luYWwgPSBvYmpbbWV0aG9kXSwgaGFkT3duID0gb2JqLmhhc093blByb3BlcnR5KG1ldGhvZCk7XG4gICAgbGV0IGN1cnJlbnQgPSBjcmVhdGVXcmFwcGVyKG9yaWdpbmFsKTtcbiAgICAvLyBMZXQgb3VyIHdyYXBwZXIgaW5oZXJpdCBzdGF0aWMgcHJvcHMgZnJvbSB0aGUgd3JhcHBpbmcgbWV0aG9kLFxuICAgIC8vIGFuZCB0aGUgd3JhcHBpbmcgbWV0aG9kLCBwcm9wcyBmcm9tIHRoZSBvcmlnaW5hbCBtZXRob2RcbiAgICBpZiAob3JpZ2luYWwpXG4gICAgICAgIE9iamVjdC5zZXRQcm90b3R5cGVPZihjdXJyZW50LCBvcmlnaW5hbCk7XG4gICAgT2JqZWN0LnNldFByb3RvdHlwZU9mKHdyYXBwZXIsIGN1cnJlbnQpO1xuICAgIG9ialttZXRob2RdID0gd3JhcHBlcjtcbiAgICAvLyBSZXR1cm4gYSBjYWxsYmFjayB0byBhbGxvdyBzYWZlIHJlbW92YWxcbiAgICByZXR1cm4gcmVtb3ZlO1xuICAgIGZ1bmN0aW9uIHdyYXBwZXIoLi4uYXJncykge1xuICAgICAgICAvLyBJZiB3ZSBoYXZlIGJlZW4gZGVhY3RpdmF0ZWQgYW5kIGFyZSBubyBsb25nZXIgd3JhcHBlZCwgcmVtb3ZlIG91cnNlbHZlc1xuICAgICAgICBpZiAoY3VycmVudCA9PT0gb3JpZ2luYWwgJiYgb2JqW21ldGhvZF0gPT09IHdyYXBwZXIpXG4gICAgICAgICAgICByZW1vdmUoKTtcbiAgICAgICAgcmV0dXJuIGN1cnJlbnQuYXBwbHkodGhpcywgYXJncyk7XG4gICAgfVxuICAgIGZ1bmN0aW9uIHJlbW92ZSgpIHtcbiAgICAgICAgLy8gSWYgbm8gb3RoZXIgcGF0Y2hlcywganVzdCBkbyBhIGRpcmVjdCByZW1vdmFsXG4gICAgICAgIGlmIChvYmpbbWV0aG9kXSA9PT0gd3JhcHBlcikge1xuICAgICAgICAgICAgaWYgKGhhZE93bilcbiAgICAgICAgICAgICAgICBvYmpbbWV0aG9kXSA9IG9yaWdpbmFsO1xuICAgICAgICAgICAgZWxzZVxuICAgICAgICAgICAgICAgIGRlbGV0ZSBvYmpbbWV0aG9kXTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoY3VycmVudCA9PT0gb3JpZ2luYWwpXG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgIC8vIEVsc2UgcGFzcyBmdXR1cmUgY2FsbHMgdGhyb3VnaCwgYW5kIHJlbW92ZSB3cmFwcGVyIGZyb20gdGhlIHByb3RvdHlwZSBjaGFpblxuICAgICAgICBjdXJyZW50ID0gb3JpZ2luYWw7XG4gICAgICAgIE9iamVjdC5zZXRQcm90b3R5cGVPZih3cmFwcGVyLCBvcmlnaW5hbCB8fCBGdW5jdGlvbik7XG4gICAgfVxufVxuZXhwb3J0IGZ1bmN0aW9uIGFmdGVyKHByb21pc2UsIGNiKSB7XG4gICAgcmV0dXJuIHByb21pc2UudGhlbihjYiwgY2IpO1xufVxuZXhwb3J0IGZ1bmN0aW9uIHNlcmlhbGl6ZShhc3luY0Z1bmN0aW9uKSB7XG4gICAgbGV0IGxhc3RSdW4gPSBQcm9taXNlLnJlc29sdmUoKTtcbiAgICBmdW5jdGlvbiB3cmFwcGVyKC4uLmFyZ3MpIHtcbiAgICAgICAgcmV0dXJuIGxhc3RSdW4gPSBuZXcgUHJvbWlzZSgocmVzLCByZWopID0+IHtcbiAgICAgICAgICAgIGFmdGVyKGxhc3RSdW4sICgpID0+IHtcbiAgICAgICAgICAgICAgICBhc3luY0Z1bmN0aW9uLmFwcGx5KHRoaXMsIGFyZ3MpLnRoZW4ocmVzLCByZWopO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH0pO1xuICAgIH1cbiAgICB3cmFwcGVyLmFmdGVyID0gZnVuY3Rpb24gKCkge1xuICAgICAgICByZXR1cm4gbGFzdFJ1biA9IG5ldyBQcm9taXNlKChyZXMsIHJlaikgPT4geyBhZnRlcihsYXN0UnVuLCByZXMpOyB9KTtcbiAgICB9O1xuICAgIHJldHVybiB3cmFwcGVyO1xufVxuIiwiaW1wb3J0IHtQbHVnaW4sIEtleW1hcCwgU2V0dGluZywgZGVib3VuY2V9IGZyb20gXCJvYnNpZGlhblwiO1xuaW1wb3J0IHthcm91bmR9IGZyb20gXCJtb25rZXktYXJvdW5kXCI7XG5cbmZ1bmN0aW9uIGhvdGtleVRvU3RyaW5nKGhvdGtleSkge1xuICAgIHJldHVybiBLZXltYXAuY29tcGlsZU1vZGlmaWVycyhob3RrZXkubW9kaWZpZXJzKStcIixcIiArIGhvdGtleS5rZXkudG9Mb3dlckNhc2UoKVxufVxuXG5mdW5jdGlvbiBpc1BsdWdpblRhYihpZCkge1xuICAgIHJldHVybiBpZCA9PT0gXCJwbHVnaW5zXCIgfHwgaWQgPT09IFwidGhpcmQtcGFydHktcGx1Z2luc1wiIHx8IGlkID09PSBcImNvbW11bml0eS1wbHVnaW5zXCI7XG59XG5cbmZ1bmN0aW9uIHBsdWdpblNldHRpbmdzQXJlT3BlbihhcHApIHtcbiAgICByZXR1cm4gKFxuICAgICAgICBhcHAuc2V0dGluZy5jb250YWluZXJFbC5wYXJlbnRFbGVtZW50ICE9PSBudWxsICYmXG4gICAgICAgIGFwcC5zZXR0aW5nLmFjdGl2ZVRhYiAmJlxuICAgICAgICBpc1BsdWdpblRhYihhcHAuc2V0dGluZy5hY3RpdmVUYWIuaWQpXG4gICAgKTtcbn1cblxuZXhwb3J0IGRlZmF1bHQgY2xhc3MgSG90a2V5SGVscGVyIGV4dGVuZHMgUGx1Z2luIHtcblxuICAgIG9ubG9hZCgpIHtcbiAgICAgICAgY29uc3Qgd29ya3NwYWNlID0gdGhpcy5hcHAud29ya3NwYWNlO1xuXG4gICAgICAgIHRoaXMucmVnaXN0ZXJFdmVudCggd29ya3NwYWNlLm9uKFwicGx1Z2luLXNldHRpbmdzOmJlZm9yZS1kaXNwbGF5XCIsIChzZXR0aW5nc1RhYiwgdGFiSWQpID0+IHtcbiAgICAgICAgICAgIHRoaXMuaG90a2V5QnV0dG9ucyA9IHt9O1xuICAgICAgICAgICAgdGhpcy5jb25maWdCdXR0b25zID0ge307XG4gICAgICAgICAgICB0aGlzLmhhdmVQc2V1ZG9zID0gZmFsc2U7XG4gICAgICAgIH0pICk7XG4gICAgICAgIHRoaXMucmVnaXN0ZXJFdmVudCggd29ya3NwYWNlLm9uKFwicGx1Z2luLXNldHRpbmdzOmFmdGVyLWRpc3BsYXlcIiwgICgpID0+IHRoaXMucmVmcmVzaEJ1dHRvbnModHJ1ZSkpICk7XG5cbiAgICAgICAgY29uc3QgY3JlYXRlRXh0cmFCdXR0b25zID0gKHNldHRpbmcsIG1hbmlmZXN0LCBlbmFibGVkKSA9PiB7XG4gICAgICAgICAgICBzZXR0aW5nLmFkZEV4dHJhQnV0dG9uKGJ0biA9PiB7XG4gICAgICAgICAgICAgICAgYnRuLnNldEljb24oXCJnZWFyXCIpO1xuICAgICAgICAgICAgICAgIGJ0bi5vbkNsaWNrKCgpID0+IHRoaXMuc2hvd0NvbmZpZ0ZvcihtYW5pZmVzdC5pZC5yZXBsYWNlKC9ed29ya3NwYWNlJC8sXCJmaWxlXCIpKSk7XG4gICAgICAgICAgICAgICAgYnRuLnNldFRvb2x0aXAoXCJPcHRpb25zXCIpO1xuICAgICAgICAgICAgICAgIGJ0bi5leHRyYVNldHRpbmdzRWwudG9nZ2xlKGVuYWJsZWQpXG4gICAgICAgICAgICAgICAgdGhpcy5jb25maWdCdXR0b25zW21hbmlmZXN0LmlkXSA9IGJ0bjtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgc2V0dGluZy5hZGRFeHRyYUJ1dHRvbihidG4gPT4ge1xuICAgICAgICAgICAgICAgIGJ0bi5zZXRJY29uKFwiYW55LWtleVwiKTtcbiAgICAgICAgICAgICAgICBidG4ub25DbGljaygoKSA9PiB0aGlzLnNob3dIb3RrZXlzRm9yKG1hbmlmZXN0LmlkK1wiOlwiKSlcbiAgICAgICAgICAgICAgICBidG4uZXh0cmFTZXR0aW5nc0VsLnRvZ2dsZShlbmFibGVkKVxuICAgICAgICAgICAgICAgIHRoaXMuaG90a2V5QnV0dG9uc1ttYW5pZmVzdC5pZF0gPSBidG47XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfTtcblxuICAgICAgICB0aGlzLnJlZ2lzdGVyRXZlbnQoIHdvcmtzcGFjZS5vbihcInBsdWdpbi1zZXR0aW5nczpwbHVnaW4tY29udHJvbFwiLCAoc2V0dGluZywgbWFuaWZlc3QsIGVuYWJsZWQsIHRhYklkKSA9PiB7XG4gICAgICAgICAgICBpZiAoIXRoaXMuaGF2ZVBzZXVkb3MpIHtcbiAgICAgICAgICAgICAgICAvLyBBZGQgYSBzZWFyY2ggZmlsdGVyIHRvIHNocmluayBwbHVnaW4gbGlzdFxuICAgICAgICAgICAgICAgIGNvbnN0IGNvbnRhaW5lckVsID0gc2V0dGluZy5zZXR0aW5nRWwucGFyZW50RWxlbWVudDtcbiAgICAgICAgICAgICAgICBsZXQgaW5wdXRFbDtcbiAgICAgICAgICAgICAgICBpZiAodGFiSWQgIT09IFwicGx1Z2luc1wiKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vIFJlcGxhY2UgdGhlIGJ1aWx0LWluIHNlYXJjaCBoYW5kbGVyXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IG9yaWdpbmFsID0gaW5wdXRFbCA9IGNvbnRhaW5lckVsLnBhcmVudEVsZW1lbnQ/LmZpbmQoXCIuc2VhcmNoLWlucHV0LWNvbnRhaW5lciBpbnB1dFwiKVxuICAgICAgICAgICAgICAgICAgICBpZiAob3JpZ2luYWwpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlucHV0RWwgPSBvcmlnaW5hbC5jbG9uZU5vZGUoKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIG9yaWdpbmFsLnBhcmVudEVsZW1lbnQucmVwbGFjZUNoaWxkKGlucHV0RWwsIG9yaWdpbmFsKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBpbnB1dEVsID0gaW5wdXRFbCA/PyBjb250YWluZXJFbC5jcmVhdGVEaXYoXCJob3RrZXktc2VhcmNoLWNvbnRhaW5lclwiKS5jcmVhdGVFbChcbiAgICAgICAgICAgICAgICAgICAgXCJpbnB1dFwiLCB7dHlwZTogXCJ0ZXh0XCIsIGF0dHI6IHtwbGFjZWhvbGRlcjpcIkZpbHRlciBwbHVnaW5zLi4uXCIsIHNwZWxsY2hlY2s6IFwiZmFsc2VcIn19XG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICBpbnB1dEVsLmFkZEV2ZW50TGlzdGVuZXIoXCJpbnB1dFwiLCBmdW5jdGlvbigpe1xuICAgICAgICAgICAgICAgICAgICBjb25zdCBmaW5kID0gaW5wdXRFbC52YWx1ZS50b0xvd2VyQ2FzZSgpO1xuICAgICAgICAgICAgICAgICAgICBmdW5jdGlvbiBtYXRjaEFuZEhpZ2hsaWdodChlbCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgdGV4dCA9IGVsLnRleHRDb250ZW50ID0gZWwudGV4dENvbnRlbnQ7IC8vIGNsZWFyIHByZXZpb3VzIGhpZ2hsaWdodGluZywgaWYgYW55XG4gICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBpbmRleCA9IHRleHQudG9Mb3dlckNhc2UoKS5pbmRleE9mKGZpbmQpO1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCF+aW5kZXgpIHJldHVybiBmYWxzZTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGVsLnRleHRDb250ZW50ID0gdGV4dC5zdWJzdHIoMCwgaW5kZXgpO1xuICAgICAgICAgICAgICAgICAgICAgICAgZWwuY3JlYXRlU3BhbihcInN1Z2dlc3Rpb24taGlnaGxpZ2h0XCIpLnRleHRDb250ZW50ID0gdGV4dC5zdWJzdHIoaW5kZXgsIGZpbmQubGVuZ3RoKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGVsLmluc2VydEFkamFjZW50VGV4dChcImJlZm9yZWVuZFwiLCB0ZXh0LnN1YnN0cihpbmRleCtmaW5kLmxlbmd0aCkpXG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICBjb250YWluZXJFbC5maW5kQWxsKFwiLnNldHRpbmctaXRlbVwiKS5mb3JFYWNoKGUgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgbmFtZU1hdGNoZXMgPSBtYXRjaEFuZEhpZ2hsaWdodChlLmZpbmQoXCIuc2V0dGluZy1pdGVtLW5hbWVcIikpO1xuICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgZGVzY01hdGNoZXMgPSBtYXRjaEFuZEhpZ2hsaWdodChcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlLmZpbmQoXCIuc2V0dGluZy1pdGVtLWRlc2NyaXB0aW9uID4gZGl2Omxhc3QtY2hpbGRcIikgPz9cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlLmZpbmQoXCIuc2V0dGluZy1pdGVtLWRlc2NyaXB0aW9uXCIpXG4gICAgICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgICAgICAgICAgZS50b2dnbGUobmFtZU1hdGNoZXMgfHwgZGVzY01hdGNoZXMpO1xuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICBzZXRJbW1lZGlhdGUoKCkgPT4ge2lucHV0RWwuZm9jdXMoKX0pO1xuICAgICAgICAgICAgICAgIGNvbnRhaW5lckVsLmFwcGVuZChzZXR0aW5nLnNldHRpbmdFbCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmICh0YWJJZCA9PT0gXCJwbHVnaW5zXCIgJiYgISB0aGlzLmhhdmVQc2V1ZG9zKSB7XG4gICAgICAgICAgICAgICAgY29uc3QgZWRpdG9yTmFtZSAgICA9IHRoaXMuZ2V0U2V0dGluZ3NUYWIoXCJlZGl0b3JcIik/Lm5hbWUgfHwgXCJFZGl0b3JcIjtcbiAgICAgICAgICAgICAgICBjb25zdCB3b3Jrc3BhY2VOYW1lID0gdGhpcy5nZXRTZXR0aW5nc1RhYihcImZpbGVcIik/Lm5hbWUgICB8fCBcIkZpbGVzICYgTGlua3NcIjtcbiAgICAgICAgICAgICAgICBjcmVhdGVFeHRyYUJ1dHRvbnMoXG4gICAgICAgICAgICAgICAgICAgIG5ldyBTZXR0aW5nKHNldHRpbmcuc2V0dGluZ0VsLnBhcmVudEVsZW1lbnQpXG4gICAgICAgICAgICAgICAgICAgICAgICAuc2V0TmFtZShcIkFwcFwiKS5zZXREZXNjKFwiTWlzY2VsbGFuZW91cyBhcHBsaWNhdGlvbiBjb21tYW5kcyAoYWx3YXlzIGVuYWJsZWQpXCIpLFxuICAgICAgICAgICAgICAgICAgICB7aWQ6IFwiYXBwXCIsIG5hbWU6IFwiQXBwXCJ9LCB0cnVlXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICBjcmVhdGVFeHRyYUJ1dHRvbnMoXG4gICAgICAgICAgICAgICAgICAgIG5ldyBTZXR0aW5nKHNldHRpbmcuc2V0dGluZ0VsLnBhcmVudEVsZW1lbnQpXG4gICAgICAgICAgICAgICAgICAgICAgICAuc2V0TmFtZShlZGl0b3JOYW1lKS5zZXREZXNjKFwiQ29yZSBlZGl0aW5nIGNvbW1hbmRzIChhbHdheXMgZW5hYmxlZClcIiksXG4gICAgICAgICAgICAgICAgICAgIHtpZDogXCJlZGl0b3JcIiwgbmFtZTogZWRpdG9yTmFtZX0sIHRydWVcbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIGNyZWF0ZUV4dHJhQnV0dG9ucyhcbiAgICAgICAgICAgICAgICAgICAgbmV3IFNldHRpbmcoc2V0dGluZy5zZXR0aW5nRWwucGFyZW50RWxlbWVudClcbiAgICAgICAgICAgICAgICAgICAgICAgIC5zZXROYW1lKHdvcmtzcGFjZU5hbWUpLnNldERlc2MoXCJDb3JlIGZpbGUgYW5kIHBhbmUgbWFuYWdlbWVudCBjb21tYW5kcyAoYWx3YXlzIGVuYWJsZWQpXCIpLFxuICAgICAgICAgICAgICAgICAgICB7aWQ6IFwid29ya3NwYWNlXCIsIG5hbWU6IHdvcmtzcGFjZU5hbWV9LCB0cnVlXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICBzZXR0aW5nLnNldHRpbmdFbC5wYXJlbnRFbGVtZW50LmFwcGVuZChzZXR0aW5nLnNldHRpbmdFbCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHRoaXMuaGF2ZVBzZXVkb3MgPSB0cnVlO1xuICAgICAgICAgICAgY3JlYXRlRXh0cmFCdXR0b25zKHNldHRpbmcsIG1hbmlmZXN0LCBlbmFibGVkKTtcbiAgICAgICAgfSkgKTtcblxuICAgICAgICAvLyBSZWZyZXNoIHRoZSBidXR0b25zIHdoZW4gY29tbWFuZHMgb3Igc2V0dGluZyB0YWJzIGFyZSBhZGRlZCBvciByZW1vdmVkXG4gICAgICAgIGNvbnN0IHJlcXVlc3RSZWZyZXNoID0gZGVib3VuY2UodGhpcy5yZWZyZXNoQnV0dG9ucy5iaW5kKHRoaXMpLCA1MCwgdHJ1ZSk7XG4gICAgICAgIGZ1bmN0aW9uIHJlZnJlc2hlcihvbGQpIHsgcmV0dXJuIGZ1bmN0aW9uKC4uLmFyZ3MpeyByZXF1ZXN0UmVmcmVzaCgpOyByZXR1cm4gb2xkLmFwcGx5KHRoaXMsIGFyZ3MpOyB9OyB9XG4gICAgICAgIHRoaXMucmVnaXN0ZXIoYXJvdW5kKGFwcC5jb21tYW5kcywge2FkZENvbW1hbmQ6ICAgIHJlZnJlc2hlciwgcmVtb3ZlQ29tbWFuZDogICAgcmVmcmVzaGVyfSkpO1xuICAgICAgICB0aGlzLnJlZ2lzdGVyKGFyb3VuZChhcHAuc2V0dGluZywgIHthZGRQbHVnaW5UYWI6ICByZWZyZXNoZXIsIHJlbW92ZVBsdWdpblRhYjogIHJlZnJlc2hlcn0pKTtcbiAgICAgICAgdGhpcy5yZWdpc3Rlcihhcm91bmQoYXBwLnNldHRpbmcsICB7YWRkU2V0dGluZ1RhYjogcmVmcmVzaGVyLCByZW1vdmVTZXR0aW5nVGFiOiByZWZyZXNoZXJ9KSk7XG5cbiAgICAgICAgd29ya3NwYWNlLm9uTGF5b3V0UmVhZHkodGhpcy53aGVuUmVhZHkuYmluZCh0aGlzKSk7XG4gICAgfVxuXG4gICAgd2hlblJlYWR5KCkge1xuICAgICAgICBjb25zdCBhcHAgPSB0aGlzLmFwcDtcbiAgICAgICAgY29uc3QgY29yZVBsdWdpbnMgPSB0aGlzLmdldFNldHRpbmdzVGFiKFwicGx1Z2luc1wiKTtcbiAgICAgICAgY29uc3QgY29tbXVuaXR5ID0gdGhpcy5nZXRTZXR0aW5nc1RhYihcInRoaXJkLXBhcnR5LXBsdWdpbnNcIikgPz8gdGhpcy5nZXRTZXR0aW5nc1RhYihcImNvbW11bml0eS1wbHVnaW5zXCIpO1xuXG4gICAgICAgIC8vIEhvb2sgaW50byB0aGUgZGlzcGxheSgpIG1ldGhvZCBvZiB0aGUgcGx1Z2luIHNldHRpbmdzIHRhYnNcbiAgICAgICAgaWYgKGNvcmVQbHVnaW5zKSB0aGlzLnJlZ2lzdGVyKGFyb3VuZChjb3JlUGx1Z2lucywge2Rpc3BsYXk6IHRoaXMuYWRkUGx1Z2luU2V0dGluZ0V2ZW50cy5iaW5kKHRoaXMsIGNvcmVQbHVnaW5zLmlkKX0pKTtcbiAgICAgICAgaWYgKGNvbW11bml0eSkgICB0aGlzLnJlZ2lzdGVyKGFyb3VuZChjb21tdW5pdHksICAge2Rpc3BsYXk6IHRoaXMuYWRkUGx1Z2luU2V0dGluZ0V2ZW50cy5iaW5kKHRoaXMsIGNvbW11bml0eS5pZCl9KSk7XG5cbiAgICAgICAgLy8gTm93IGZvcmNlIGEgcmVmcmVzaCBpZiBlaXRoZXIgcGx1Z2lucyB0YWIgaXMgY3VycmVudGx5IHZpc2libGUgKHRvIHNob3cgb3VyIG5ldyBidXR0b25zKVxuICAgICAgICBmdW5jdGlvbiByZWZyZXNoVGFiSWZPcGVuKCkge1xuICAgICAgICAgICAgaWYgKHBsdWdpblNldHRpbmdzQXJlT3BlbihhcHApKSBhcHAuc2V0dGluZy5vcGVuVGFiQnlJZChhcHAuc2V0dGluZy5hY3RpdmVUYWIuaWQpO1xuICAgICAgICB9XG4gICAgICAgIHJlZnJlc2hUYWJJZk9wZW4oKTtcblxuICAgICAgICAvLyBBbmQgZG8gaXQgYWdhaW4gYWZ0ZXIgd2UgdW5sb2FkICh0byByZW1vdmUgdGhlIG9sZCBidXR0b25zKVxuICAgICAgICB0aGlzLnJlZ2lzdGVyKCgpID0+IHNldEltbWVkaWF0ZShyZWZyZXNoVGFiSWZPcGVuKSk7XG5cbiAgICAgICAgLy8gVHdlYWsgdGhlIGhvdGtleSBzZXR0aW5ncyB0YWIgdG8gbWFrZSBmaWx0ZXJpbmcgd29yayBvbiBpZCBwcmVmaXhlcyBhcyB3ZWxsIGFzIGNvbW1hbmQgbmFtZXNcbiAgICAgICAgY29uc3QgaG90a2V5c1RhYiA9IHRoaXMuZ2V0U2V0dGluZ3NUYWIoXCJob3RrZXlzXCIpO1xuICAgICAgICBpZiAoaG90a2V5c1RhYikge1xuICAgICAgICAgICAgdGhpcy5yZWdpc3Rlcihhcm91bmQoaG90a2V5c1RhYiwge1xuICAgICAgICAgICAgICAgIGRpc3BsYXkob2xkKSB7IHJldHVybiBmdW5jdGlvbigpIHsgb2xkLmNhbGwodGhpcyk7IHRoaXMuc2VhcmNoSW5wdXRFbC5mb2N1cygpOyB9OyB9LFxuICAgICAgICAgICAgICAgIHVwZGF0ZUhvdGtleVZpc2liaWxpdHkob2xkKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBmdW5jdGlvbigpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IG9sZFNlYXJjaCA9IHRoaXMuc2VhcmNoSW5wdXRFbC52YWx1ZSwgb2xkQ29tbWFuZHMgPSBhcHAuY29tbWFuZHMuY29tbWFuZHM7XG4gICAgICAgICAgICAgICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChvbGRTZWFyY2guZW5kc1dpdGgoXCI6XCIpICYmICFvbGRTZWFyY2guY29udGFpbnMoXCIgXCIpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC8vIFRoaXMgaXMgYW4gaW5jcmVkaWJseSB1Z2x5IGhhY2sgdGhhdCByZWxpZXMgb24gdXBkYXRlSG90a2V5VmlzaWJpbGl0eSgpIGl0ZXJhdGluZyBhcHAuY29tbWFuZHMuY29tbWFuZHNcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLy8gbG9va2luZyBmb3IgaG90a2V5IGNvbmZsaWN0cyAqYmVmb3JlKiBhbnl0aGluZyBlbHNlLlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBsZXQgY3VycmVudCA9IG9sZENvbW1hbmRzO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBsZXQgZmlsdGVyZWQgPSBPYmplY3QuZnJvbUVudHJpZXMoT2JqZWN0LmVudHJpZXMoYXBwLmNvbW1hbmRzLmNvbW1hbmRzKS5maWx0ZXIoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAoW2lkLCBjbWRdKSA9PiAoaWQrXCI6XCIpLnN0YXJ0c1dpdGgob2xkU2VhcmNoKVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICApKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5zZWFyY2hJbnB1dEVsLnZhbHVlID0gXCJcIjtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXBwLmNvbW1hbmRzLmNvbW1hbmRzID0gbmV3IFByb3h5KG9sZENvbW1hbmRzLCB7b3duS2V5cygpe1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLy8gVGhlIGZpcnN0IHRpbWUgY29tbWFuZHMgYXJlIGl0ZXJhdGVkLCByZXR1cm4gdGhlIHdob2xlIHRoaW5nO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLy8gYWZ0ZXIgdGhhdCwgcmV0dXJuIHRoZSBmaWx0ZXJlZCBsaXN0XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0cnkgeyByZXR1cm4gT2JqZWN0LmtleXMoY3VycmVudCk7IH0gZmluYWxseSB7IGN1cnJlbnQgPSBmaWx0ZXJlZDsgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9fSk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiBvbGQuY2FsbCh0aGlzKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH0gZmluYWxseSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5zZWFyY2hJbnB1dEVsLnZhbHVlID0gb2xkU2VhcmNoO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFwcC5jb21tYW5kcy5jb21tYW5kcyA9IG9sZENvbW1hbmRzO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSkpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgZ2V0U2V0dGluZ3NUYWIoaWQpIHsgcmV0dXJuIHRoaXMuYXBwLnNldHRpbmcuc2V0dGluZ1RhYnMuZmlsdGVyKHQgPT4gdC5pZCA9PT0gaWQpLnNoaWZ0KCk7IH1cblxuICAgIGFkZFBsdWdpblNldHRpbmdFdmVudHModGFiSWQsIG9sZCkge1xuICAgICAgICBjb25zdCBhcHAgPSB0aGlzLmFwcDtcbiAgICAgICAgbGV0IGluX2V2ZW50ID0gZmFsc2U7XG5cbiAgICAgICAgZnVuY3Rpb24gdHJpZ2dlciguLi5hcmdzKSB7XG4gICAgICAgICAgICBpbl9ldmVudCA9IHRydWU7XG4gICAgICAgICAgICB0cnkgeyBhcHAud29ya3NwYWNlLnRyaWdnZXIoLi4uYXJncyk7IH0gY2F0Y2goZSkgeyBjb25zb2xlLmVycm9yKGUpOyB9XG4gICAgICAgICAgICBpbl9ldmVudCA9IGZhbHNlO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gV3JhcHBlciB0byBhZGQgcGx1Z2luLXNldHRpbmdzIGV2ZW50c1xuICAgICAgICByZXR1cm4gZnVuY3Rpb24gZGlzcGxheSguLi5hcmdzKSB7XG4gICAgICAgICAgICBpZiAoaW5fZXZlbnQpIHJldHVybjtcbiAgICAgICAgICAgIHRyaWdnZXIoXCJwbHVnaW4tc2V0dGluZ3M6YmVmb3JlLWRpc3BsYXlcIiwgdGhpcywgdGFiSWQpO1xuXG4gICAgICAgICAgICAvLyBUcmFjayB3aGljaCBwbHVnaW4gZWFjaCBzZXR0aW5nIGlzIGZvclxuICAgICAgICAgICAgbGV0IG1hbmlmZXN0cztcbiAgICAgICAgICAgIGlmICh0YWJJZCA9PT0gXCJwbHVnaW5zXCIpIHtcbiAgICAgICAgICAgICAgICBtYW5pZmVzdHMgPSBPYmplY3QuZW50cmllcyhhcHAuaW50ZXJuYWxQbHVnaW5zLnBsdWdpbnMpLm1hcChcbiAgICAgICAgICAgICAgICAgICAgKFtpZCwge2luc3RhbmNlOiB7bmFtZX0sIF9sb2FkZWQ6ZW5hYmxlZH1dKSA9PiB7cmV0dXJuIHtpZCwgbmFtZSwgZW5hYmxlZH07fVxuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIG1hbmlmZXN0cyA9IE9iamVjdC52YWx1ZXMoYXBwLnBsdWdpbnMubWFuaWZlc3RzKTtcbiAgICAgICAgICAgICAgICBtYW5pZmVzdHMuc29ydCgoZSwgdCkgPT4gZS5uYW1lLmxvY2FsZUNvbXBhcmUodC5uYW1lKSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBsZXQgd2hpY2ggPSAwO1xuXG4gICAgICAgICAgICAvLyBUcmFwIHRoZSBhZGRpdGlvbiBvZiB0aGUgXCJ1bmluc3RhbGxcIiBidXR0b25zIG5leHQgdG8gZWFjaCBwbHVnaW5cbiAgICAgICAgICAgIGNvbnN0IHJlbW92ZSA9IGFyb3VuZChTZXR0aW5nLnByb3RvdHlwZSwge1xuICAgICAgICAgICAgICAgIGFkZFRvZ2dsZShvbGQpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGZ1bmN0aW9uKC4uLmFyZ3MpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICh0YWJJZCA9PT0gXCJwbHVnaW5zXCIgJiYgIWluX2V2ZW50ICYmIChtYW5pZmVzdHNbd2hpY2hdfHx7fSkubmFtZSA9PT0gdGhpcy5uYW1lRWwudGV4dENvbnRlbnQgKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgbWFuaWZlc3QgPSBtYW5pZmVzdHNbd2hpY2grK107XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdHJpZ2dlcihcInBsdWdpbi1zZXR0aW5nczpwbHVnaW4tY29udHJvbFwiLCB0aGlzLCBtYW5pZmVzdCwgbWFuaWZlc3QuZW5hYmxlZCwgdGFiSWQpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIG9sZC5hcHBseSh0aGlzLCBhcmdzKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgYWRkRXh0cmFCdXR0b24ob2xkKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBmdW5jdGlvbiguLi5hcmdzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAvLyBUaGUgb25seSBcImV4dHJhc1wiIGFkZGVkIHRvIHNldHRpbmdzIHcvYSBkZXNjcmlwdGlvbiBhcmUgb24gdGhlIHBsdWdpbnMsIGN1cnJlbnRseSxcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vIHNvIG9ubHkgdHJ5IHRvIG1hdGNoIHRob3NlIHRvIHBsdWdpbiBuYW1lc1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHRhYklkICE9PSBcInBsdWdpbnNcIiAmJiB0aGlzLmRlc2NFbC5jaGlsZEVsZW1lbnRDb3VudCAmJiAhaW5fZXZlbnQpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoIChtYW5pZmVzdHNbd2hpY2hdfHx7fSkubmFtZSA9PT0gdGhpcy5uYW1lRWwudGV4dENvbnRlbnQgKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IG1hbmlmZXN0ID0gbWFuaWZlc3RzW3doaWNoKytdLCBlbmFibGVkID0gISFhcHAucGx1Z2lucy5wbHVnaW5zW21hbmlmZXN0LmlkXTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHJpZ2dlcihcInBsdWdpbi1zZXR0aW5nczpwbHVnaW4tY29udHJvbFwiLCB0aGlzLCBtYW5pZmVzdCwgZW5hYmxlZCwgdGFiSWQpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgIH07XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gb2xkLmFwcGx5KHRoaXMsIGFyZ3MpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIG9sZC5hcHBseSh0aGlzLCBhcmdzKTtcbiAgICAgICAgICAgIH0gZmluYWxseSB7XG4gICAgICAgICAgICAgICAgcmVtb3ZlKCk7XG4gICAgICAgICAgICAgICAgdHJpZ2dlcihcInBsdWdpbi1zZXR0aW5nczphZnRlci1kaXNwbGF5XCIsIHRoaXMpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfVxuXG4gICAgc2hvd0hvdGtleXNGb3Ioc2VhcmNoKSB7XG4gICAgICAgIHRoaXMuYXBwLnNldHRpbmcub3BlblRhYkJ5SWQoXCJob3RrZXlzXCIpO1xuICAgICAgICBjb25zdCB0YWIgPSB0aGlzLmFwcC5zZXR0aW5nLmFjdGl2ZVRhYjtcbiAgICAgICAgaWYgKHRhYiAmJiB0YWIuc2VhcmNoSW5wdXRFbCAmJiB0YWIudXBkYXRlSG90a2V5VmlzaWJpbGl0eSkge1xuICAgICAgICAgICAgdGFiLnNlYXJjaElucHV0RWwudmFsdWUgPSBzZWFyY2g7XG4gICAgICAgICAgICB0YWIudXBkYXRlSG90a2V5VmlzaWJpbGl0eSgpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgc2hvd0NvbmZpZ0ZvcihpZCkge1xuICAgICAgICB0aGlzLmFwcC5zZXR0aW5nLm9wZW5UYWJCeUlkKGlkKTtcbiAgICB9XG5cbiAgICBwbHVnaW5FbmFibGVkKGlkKSB7XG4gICAgICAgIHJldHVybiB0aGlzLmFwcC5pbnRlcm5hbFBsdWdpbnMucGx1Z2luc1tpZF0/Ll9sb2FkZWQgfHwgdGhpcy5hcHAucGx1Z2lucy5wbHVnaW5zW2lkXTtcbiAgICB9XG5cbiAgICByZWZyZXNoQnV0dG9ucyhmb3JjZT1mYWxzZSkge1xuICAgICAgICAvLyBEb24ndCByZWZyZXNoIHdoZW4gbm90IGRpc3BsYXlpbmcsIHVubGVzcyByZW5kZXJpbmcgaXMgaW4gcHJvZ3Jlc3NcbiAgICAgICAgaWYgKCFwbHVnaW5TZXR0aW5nc0FyZU9wZW4odGhpcy5hcHApICYmICFmb3JjZSkgcmV0dXJuO1xuXG4gICAgICAgIGNvbnN0IGhrbSA9IHRoaXMuYXBwLmhvdGtleU1hbmFnZXI7XG4gICAgICAgIGNvbnN0IGFzc2lnbmVkS2V5Q291bnQgPSB7fTtcblxuICAgICAgICAvLyBHZXQgYSBsaXN0IG9mIGNvbW1hbmRzIGJ5IHBsdWdpblxuICAgICAgICBjb25zdCBjb21tYW5kcyA9IE9iamVjdC52YWx1ZXModGhpcy5hcHAuY29tbWFuZHMuY29tbWFuZHMpLnJlZHVjZSgoY21kcywgY21kKT0+e1xuICAgICAgICAgICAgY29uc3QgcGlkID0gY21kLmlkLnNwbGl0KFwiOlwiLDIpLnNoaWZ0KCk7XG4gICAgICAgICAgICBjb25zdCBob3RrZXlzID0gKGhrbS5nZXRIb3RrZXlzKGNtZC5pZCkgfHwgaGttLmdldERlZmF1bHRIb3RrZXlzKGNtZC5pZCkgfHwgW10pLm1hcChob3RrZXlUb1N0cmluZyk7XG4gICAgICAgICAgICBob3RrZXlzLmZvckVhY2goayA9PiBhc3NpZ25lZEtleUNvdW50W2tdID0gMSArIChhc3NpZ25lZEtleUNvdW50W2tdfHwwKSk7XG4gICAgICAgICAgICAoY21kc1twaWRdIHx8IChjbWRzW3BpZF09W10pKS5wdXNoKHtob3RrZXlzLCBjbWR9KTtcbiAgICAgICAgICAgIHJldHVybiBjbWRzO1xuICAgICAgICB9LCB7fSk7XG5cbiAgICAgICAgLy8gUGx1Z2luIHNldHRpbmcgdGFicyBieSBwbHVnaW5cbiAgICAgICAgY29uc3QgdGFicyA9IE9iamVjdC52YWx1ZXModGhpcy5hcHAuc2V0dGluZy5wbHVnaW5UYWJzKS5yZWR1Y2UoKHRhYnMsIHRhYik9PiB7XG4gICAgICAgICAgICB0YWJzW3RhYi5pZF0gPSB0YWI7IHJldHVybiB0YWJzXG4gICAgICAgIH0sIHt9KTtcbiAgICAgICAgdGFic1tcIndvcmtzcGFjZVwiXSA9IHRhYnNbXCJlZGl0b3JcIl0gPSB0cnVlO1xuXG4gICAgICAgIGZvcihjb25zdCBpZCBvZiBPYmplY3Qua2V5cyh0aGlzLmNvbmZpZ0J1dHRvbnMgfHwge30pKSB7XG4gICAgICAgICAgICBjb25zdCBidG4gPSB0aGlzLmNvbmZpZ0J1dHRvbnNbaWRdO1xuICAgICAgICAgICAgaWYgKCF0YWJzW2lkXSkge1xuICAgICAgICAgICAgICAgIGJ0bi5leHRyYVNldHRpbmdzRWwuaGlkZSgpO1xuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgYnRuLmV4dHJhU2V0dGluZ3NFbC5zaG93KCk7XG4gICAgICAgIH1cblxuICAgICAgICBmb3IoY29uc3QgaWQgb2YgT2JqZWN0LmtleXModGhpcy5ob3RrZXlCdXR0b25zIHx8IHt9KSkge1xuICAgICAgICAgICAgY29uc3QgYnRuID0gdGhpcy5ob3RrZXlCdXR0b25zW2lkXTtcbiAgICAgICAgICAgIGlmICghY29tbWFuZHNbaWRdKSB7XG4gICAgICAgICAgICAgICAgLy8gUGx1Z2luIGlzIGRpc2FibGVkIG9yIGhhcyBubyBjb21tYW5kc1xuICAgICAgICAgICAgICAgIGJ0bi5leHRyYVNldHRpbmdzRWwuaGlkZSgpO1xuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY29uc3QgYXNzaWduZWQgPSBjb21tYW5kc1tpZF0uZmlsdGVyKGluZm8gPT4gaW5mby5ob3RrZXlzLmxlbmd0aCk7XG4gICAgICAgICAgICBjb25zdCBjb25mbGljdHMgPSBhc3NpZ25lZC5maWx0ZXIoaW5mbyA9PiBpbmZvLmhvdGtleXMuZmlsdGVyKGsgPT4gYXNzaWduZWRLZXlDb3VudFtrXT4xKS5sZW5ndGgpLmxlbmd0aDtcblxuICAgICAgICAgICAgYnRuLnNldFRvb2x0aXAoXG4gICAgICAgICAgICAgICAgYENvbmZpZ3VyZSBob3RrZXlzJHtcIlxcblwifSgke2Fzc2lnbmVkLmxlbmd0aH0vJHtjb21tYW5kc1tpZF0ubGVuZ3RofSBhc3NpZ25lZCR7XG4gICAgICAgICAgICAgICAgICAgIGNvbmZsaWN0cyA/IFwiOyBcIitjb25mbGljdHMrXCIgY29uZmxpY3RpbmdcIiA6IFwiXCJcbiAgICAgICAgICAgICAgICB9KWBcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgICBidG4uZXh0cmFTZXR0aW5nc0VsLnRvZ2dsZUNsYXNzKFwibW9kLWVycm9yXCIsICEhY29uZmxpY3RzKTtcbiAgICAgICAgICAgIGJ0bi5leHRyYVNldHRpbmdzRWwuc2hvdygpO1xuICAgICAgICB9XG4gICAgfVxufVxuIl0sIm5hbWVzIjpbIktleW1hcCIsIlBsdWdpbiIsIlNldHRpbmciLCJkZWJvdW5jZSJdLCJtYXBwaW5ncyI6Ijs7OztBQUFPLFNBQVMsTUFBTSxDQUFDLEdBQUcsRUFBRSxTQUFTLEVBQUU7QUFDdkMsSUFBSSxNQUFNLFFBQVEsR0FBRyxNQUFNLENBQUMsSUFBSSxDQUFD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
