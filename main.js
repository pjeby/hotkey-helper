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

function pluginSettingsAreOpen(app) {
    return (
        app.setting.containerEl.parentElement !== null &&
        app.setting.activeTab &&
        (app.setting.activeTab.id === "third-party-plugins" || app.setting.activeTab.id === "plugins")
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
                btn.onClick(() => this.showHotkeysFor(manifest.id.replace(/^file-explorer$/,"explorer")+":"));
                btn.extraSettingsEl.toggle(enabled);
                this.hotkeyButtons[manifest.id] = btn;
            });
        };

        this.registerEvent( workspace.on("plugin-settings:plugin-control", (setting, manifest, enabled, tabId) => {
            if (tabId === "plugins" && ! this.havePseudos) {
                this.havePseudos = true;
                const editorName    = this.getSettingsTab("editor")?.name || "Editor";
                const workspaceName = this.getSettingsTab("file")?.name   || "Files & Links";
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
        const corePlugins = this.getSettingsTab("plugins"), community = this.getSettingsTab("third-party-plugins");

        // Hook into the display() method of the plugin settings tabs
        if (corePlugins) this.register(around(corePlugins, {display: this.addPluginSettingEvents.bind(this, "plugins")}));
        if (community)   this.register(around(community,   {display: this.addPluginSettingEvents.bind(this, "third-party-plugins")}));

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
                        if (tabId === "third-party-plugins" && this.descEl.childElementCount && !in_event) {
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
        if (commands["explorer"]) commands["file-explorer"] = commands["explorer"];

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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWFpbi5qcyIsInNvdXJjZXMiOlsiLnlhcm4vY2FjaGUvbW9ua2V5LWFyb3VuZC1ucG0tMi4xLjAtNzBkZjMyZDJhYy0xYmQ3MmQyNWY5LnppcC9ub2RlX21vZHVsZXMvbW9ua2V5LWFyb3VuZC9tanMvaW5kZXguanMiLCJzcmMvcGx1Z2luLmpzIl0sInNvdXJjZXNDb250ZW50IjpbImV4cG9ydCBmdW5jdGlvbiBhcm91bmQob2JqLCBmYWN0b3JpZXMpIHtcbiAgICBjb25zdCByZW1vdmVycyA9IE9iamVjdC5rZXlzKGZhY3RvcmllcykubWFwKGtleSA9PiBhcm91bmQxKG9iaiwga2V5LCBmYWN0b3JpZXNba2V5XSkpO1xuICAgIHJldHVybiByZW1vdmVycy5sZW5ndGggPT09IDEgPyByZW1vdmVyc1swXSA6IGZ1bmN0aW9uICgpIHsgcmVtb3ZlcnMuZm9yRWFjaChyID0+IHIoKSk7IH07XG59XG5mdW5jdGlvbiBhcm91bmQxKG9iaiwgbWV0aG9kLCBjcmVhdGVXcmFwcGVyKSB7XG4gICAgY29uc3Qgb3JpZ2luYWwgPSBvYmpbbWV0aG9kXSwgaGFkT3duID0gb2JqLmhhc093blByb3BlcnR5KG1ldGhvZCk7XG4gICAgbGV0IGN1cnJlbnQgPSBjcmVhdGVXcmFwcGVyKG9yaWdpbmFsKTtcbiAgICAvLyBMZXQgb3VyIHdyYXBwZXIgaW5oZXJpdCBzdGF0aWMgcHJvcHMgZnJvbSB0aGUgd3JhcHBpbmcgbWV0aG9kLFxuICAgIC8vIGFuZCB0aGUgd3JhcHBpbmcgbWV0aG9kLCBwcm9wcyBmcm9tIHRoZSBvcmlnaW5hbCBtZXRob2RcbiAgICBpZiAob3JpZ2luYWwpXG4gICAgICAgIE9iamVjdC5zZXRQcm90b3R5cGVPZihjdXJyZW50LCBvcmlnaW5hbCk7XG4gICAgT2JqZWN0LnNldFByb3RvdHlwZU9mKHdyYXBwZXIsIGN1cnJlbnQpO1xuICAgIG9ialttZXRob2RdID0gd3JhcHBlcjtcbiAgICAvLyBSZXR1cm4gYSBjYWxsYmFjayB0byBhbGxvdyBzYWZlIHJlbW92YWxcbiAgICByZXR1cm4gcmVtb3ZlO1xuICAgIGZ1bmN0aW9uIHdyYXBwZXIoLi4uYXJncykge1xuICAgICAgICAvLyBJZiB3ZSBoYXZlIGJlZW4gZGVhY3RpdmF0ZWQgYW5kIGFyZSBubyBsb25nZXIgd3JhcHBlZCwgcmVtb3ZlIG91cnNlbHZlc1xuICAgICAgICBpZiAoY3VycmVudCA9PT0gb3JpZ2luYWwgJiYgb2JqW21ldGhvZF0gPT09IHdyYXBwZXIpXG4gICAgICAgICAgICByZW1vdmUoKTtcbiAgICAgICAgcmV0dXJuIGN1cnJlbnQuYXBwbHkodGhpcywgYXJncyk7XG4gICAgfVxuICAgIGZ1bmN0aW9uIHJlbW92ZSgpIHtcbiAgICAgICAgLy8gSWYgbm8gb3RoZXIgcGF0Y2hlcywganVzdCBkbyBhIGRpcmVjdCByZW1vdmFsXG4gICAgICAgIGlmIChvYmpbbWV0aG9kXSA9PT0gd3JhcHBlcikge1xuICAgICAgICAgICAgaWYgKGhhZE93bilcbiAgICAgICAgICAgICAgICBvYmpbbWV0aG9kXSA9IG9yaWdpbmFsO1xuICAgICAgICAgICAgZWxzZVxuICAgICAgICAgICAgICAgIGRlbGV0ZSBvYmpbbWV0aG9kXTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoY3VycmVudCA9PT0gb3JpZ2luYWwpXG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgIC8vIEVsc2UgcGFzcyBmdXR1cmUgY2FsbHMgdGhyb3VnaCwgYW5kIHJlbW92ZSB3cmFwcGVyIGZyb20gdGhlIHByb3RvdHlwZSBjaGFpblxuICAgICAgICBjdXJyZW50ID0gb3JpZ2luYWw7XG4gICAgICAgIE9iamVjdC5zZXRQcm90b3R5cGVPZih3cmFwcGVyLCBvcmlnaW5hbCB8fCBGdW5jdGlvbik7XG4gICAgfVxufVxuZXhwb3J0IGZ1bmN0aW9uIGFmdGVyKHByb21pc2UsIGNiKSB7XG4gICAgcmV0dXJuIHByb21pc2UudGhlbihjYiwgY2IpO1xufVxuZXhwb3J0IGZ1bmN0aW9uIHNlcmlhbGl6ZShhc3luY0Z1bmN0aW9uKSB7XG4gICAgbGV0IGxhc3RSdW4gPSBQcm9taXNlLnJlc29sdmUoKTtcbiAgICBmdW5jdGlvbiB3cmFwcGVyKC4uLmFyZ3MpIHtcbiAgICAgICAgcmV0dXJuIGxhc3RSdW4gPSBuZXcgUHJvbWlzZSgocmVzLCByZWopID0+IHtcbiAgICAgICAgICAgIGFmdGVyKGxhc3RSdW4sICgpID0+IHtcbiAgICAgICAgICAgICAgICBhc3luY0Z1bmN0aW9uLmFwcGx5KHRoaXMsIGFyZ3MpLnRoZW4ocmVzLCByZWopO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH0pO1xuICAgIH1cbiAgICB3cmFwcGVyLmFmdGVyID0gZnVuY3Rpb24gKCkge1xuICAgICAgICByZXR1cm4gbGFzdFJ1biA9IG5ldyBQcm9taXNlKChyZXMsIHJlaikgPT4geyBhZnRlcihsYXN0UnVuLCByZXMpOyB9KTtcbiAgICB9O1xuICAgIHJldHVybiB3cmFwcGVyO1xufVxuIiwiaW1wb3J0IHtQbHVnaW4sIEtleW1hcCwgU2V0dGluZywgZGVib3VuY2V9IGZyb20gXCJvYnNpZGlhblwiO1xuaW1wb3J0IHthcm91bmR9IGZyb20gXCJtb25rZXktYXJvdW5kXCI7XG5cbmZ1bmN0aW9uIGhvdGtleVRvU3RyaW5nKGhvdGtleSkge1xuICAgIHJldHVybiBLZXltYXAuY29tcGlsZU1vZGlmaWVycyhob3RrZXkubW9kaWZpZXJzKStcIixcIiArIGhvdGtleS5rZXkudG9Mb3dlckNhc2UoKVxufVxuXG5mdW5jdGlvbiBwbHVnaW5TZXR0aW5nc0FyZU9wZW4oYXBwKSB7XG4gICAgcmV0dXJuIChcbiAgICAgICAgYXBwLnNldHRpbmcuY29udGFpbmVyRWwucGFyZW50RWxlbWVudCAhPT0gbnVsbCAmJlxuICAgICAgICBhcHAuc2V0dGluZy5hY3RpdmVUYWIgJiZcbiAgICAgICAgKGFwcC5zZXR0aW5nLmFjdGl2ZVRhYi5pZCA9PT0gXCJ0aGlyZC1wYXJ0eS1wbHVnaW5zXCIgfHwgYXBwLnNldHRpbmcuYWN0aXZlVGFiLmlkID09PSBcInBsdWdpbnNcIilcbiAgICApO1xufVxuXG5leHBvcnQgZGVmYXVsdCBjbGFzcyBIb3RrZXlIZWxwZXIgZXh0ZW5kcyBQbHVnaW4ge1xuXG4gICAgb25sb2FkKCkge1xuICAgICAgICBjb25zdCB3b3Jrc3BhY2UgPSB0aGlzLmFwcC53b3Jrc3BhY2U7XG5cbiAgICAgICAgdGhpcy5yZWdpc3RlckV2ZW50KCB3b3Jrc3BhY2Uub24oXCJwbHVnaW4tc2V0dGluZ3M6YmVmb3JlLWRpc3BsYXlcIiwgKHNldHRpbmdzVGFiLCB0YWJJZCkgPT4ge1xuICAgICAgICAgICAgdGhpcy5ob3RrZXlCdXR0b25zID0ge307XG4gICAgICAgICAgICB0aGlzLmNvbmZpZ0J1dHRvbnMgPSB7fTtcbiAgICAgICAgICAgIHRoaXMuaGF2ZVBzZXVkb3MgPSBmYWxzZTtcbiAgICAgICAgfSkgKTtcbiAgICAgICAgdGhpcy5yZWdpc3RlckV2ZW50KCB3b3Jrc3BhY2Uub24oXCJwbHVnaW4tc2V0dGluZ3M6YWZ0ZXItZGlzcGxheVwiLCAgKCkgPT4gdGhpcy5yZWZyZXNoQnV0dG9ucyh0cnVlKSkgKTtcblxuICAgICAgICBjb25zdCBjcmVhdGVFeHRyYUJ1dHRvbnMgPSAoc2V0dGluZywgbWFuaWZlc3QsIGVuYWJsZWQpID0+IHtcbiAgICAgICAgICAgIHNldHRpbmcuYWRkRXh0cmFCdXR0b24oYnRuID0+IHtcbiAgICAgICAgICAgICAgICBidG4uc2V0SWNvbihcImdlYXJcIik7XG4gICAgICAgICAgICAgICAgYnRuLm9uQ2xpY2soKCkgPT4gdGhpcy5zaG93Q29uZmlnRm9yKG1hbmlmZXN0LmlkLnJlcGxhY2UoL153b3Jrc3BhY2UkLyxcImZpbGVcIikpKTtcbiAgICAgICAgICAgICAgICBidG4uc2V0VG9vbHRpcChcIk9wdGlvbnNcIik7XG4gICAgICAgICAgICAgICAgYnRuLmV4dHJhU2V0dGluZ3NFbC50b2dnbGUoZW5hYmxlZClcbiAgICAgICAgICAgICAgICB0aGlzLmNvbmZpZ0J1dHRvbnNbbWFuaWZlc3QuaWRdID0gYnRuO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICBzZXR0aW5nLmFkZEV4dHJhQnV0dG9uKGJ0biA9PiB7XG4gICAgICAgICAgICAgICAgYnRuLnNldEljb24oXCJhbnkta2V5XCIpO1xuICAgICAgICAgICAgICAgIGJ0bi5vbkNsaWNrKCgpID0+IHRoaXMuc2hvd0hvdGtleXNGb3IobWFuaWZlc3QuaWQucmVwbGFjZSgvXmZpbGUtZXhwbG9yZXIkLyxcImV4cGxvcmVyXCIpK1wiOlwiKSlcbiAgICAgICAgICAgICAgICBidG4uZXh0cmFTZXR0aW5nc0VsLnRvZ2dsZShlbmFibGVkKVxuICAgICAgICAgICAgICAgIHRoaXMuaG90a2V5QnV0dG9uc1ttYW5pZmVzdC5pZF0gPSBidG47XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfTtcblxuICAgICAgICB0aGlzLnJlZ2lzdGVyRXZlbnQoIHdvcmtzcGFjZS5vbihcInBsdWdpbi1zZXR0aW5nczpwbHVnaW4tY29udHJvbFwiLCAoc2V0dGluZywgbWFuaWZlc3QsIGVuYWJsZWQsIHRhYklkKSA9PiB7XG4gICAgICAgICAgICBpZiAodGFiSWQgPT09IFwicGx1Z2luc1wiICYmICEgdGhpcy5oYXZlUHNldWRvcykge1xuICAgICAgICAgICAgICAgIHRoaXMuaGF2ZVBzZXVkb3MgPSB0cnVlO1xuICAgICAgICAgICAgICAgIGNvbnN0IGVkaXRvck5hbWUgICAgPSB0aGlzLmdldFNldHRpbmdzVGFiKFwiZWRpdG9yXCIpPy5uYW1lIHx8IFwiRWRpdG9yXCI7XG4gICAgICAgICAgICAgICAgY29uc3Qgd29ya3NwYWNlTmFtZSA9IHRoaXMuZ2V0U2V0dGluZ3NUYWIoXCJmaWxlXCIpPy5uYW1lICAgfHwgXCJGaWxlcyAmIExpbmtzXCI7XG4gICAgICAgICAgICAgICAgY3JlYXRlRXh0cmFCdXR0b25zKFxuICAgICAgICAgICAgICAgICAgICBuZXcgU2V0dGluZyhzZXR0aW5nLnNldHRpbmdFbC5wYXJlbnRFbGVtZW50KVxuICAgICAgICAgICAgICAgICAgICAgICAgLnNldE5hbWUoZWRpdG9yTmFtZSkuc2V0RGVzYyhcIkNvcmUgZWRpdGluZyBjb21tYW5kcyAoYWx3YXlzIGVuYWJsZWQpXCIpLFxuICAgICAgICAgICAgICAgICAgICB7aWQ6IFwiZWRpdG9yXCIsIG5hbWU6IGVkaXRvck5hbWV9LCB0cnVlXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICBjcmVhdGVFeHRyYUJ1dHRvbnMoXG4gICAgICAgICAgICAgICAgICAgIG5ldyBTZXR0aW5nKHNldHRpbmcuc2V0dGluZ0VsLnBhcmVudEVsZW1lbnQpXG4gICAgICAgICAgICAgICAgICAgICAgICAuc2V0TmFtZSh3b3Jrc3BhY2VOYW1lKS5zZXREZXNjKFwiQ29yZSBmaWxlIGFuZCBwYW5lIG1hbmFnZW1lbnQgY29tbWFuZHMgKGFsd2F5cyBlbmFibGVkKVwiKSxcbiAgICAgICAgICAgICAgICAgICAge2lkOiBcIndvcmtzcGFjZVwiLCBuYW1lOiB3b3Jrc3BhY2VOYW1lfSwgdHJ1ZVxuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgc2V0dGluZy5zZXR0aW5nRWwucGFyZW50RWxlbWVudC5hcHBlbmQoc2V0dGluZy5zZXR0aW5nRWwpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBjcmVhdGVFeHRyYUJ1dHRvbnMoc2V0dGluZywgbWFuaWZlc3QsIGVuYWJsZWQpO1xuICAgICAgICB9KSApO1xuXG4gICAgICAgIC8vIFJlZnJlc2ggdGhlIGJ1dHRvbnMgd2hlbiBjb21tYW5kcyBvciBzZXR0aW5nIHRhYnMgYXJlIGFkZGVkIG9yIHJlbW92ZWRcbiAgICAgICAgY29uc3QgcmVxdWVzdFJlZnJlc2ggPSBkZWJvdW5jZSh0aGlzLnJlZnJlc2hCdXR0b25zLmJpbmQodGhpcyksIDUwLCB0cnVlKTtcbiAgICAgICAgZnVuY3Rpb24gcmVmcmVzaGVyKG9sZCkgeyByZXR1cm4gZnVuY3Rpb24oLi4uYXJncyl7IHJlcXVlc3RSZWZyZXNoKCk7IHJldHVybiBvbGQuYXBwbHkodGhpcywgYXJncyk7IH07IH1cbiAgICAgICAgdGhpcy5yZWdpc3Rlcihhcm91bmQoYXBwLmNvbW1hbmRzLCB7YWRkQ29tbWFuZDogICAgcmVmcmVzaGVyLCByZW1vdmVDb21tYW5kOiAgICByZWZyZXNoZXJ9KSk7XG4gICAgICAgIHRoaXMucmVnaXN0ZXIoYXJvdW5kKGFwcC5zZXR0aW5nLCAge2FkZFBsdWdpblRhYjogIHJlZnJlc2hlciwgcmVtb3ZlUGx1Z2luVGFiOiAgcmVmcmVzaGVyfSkpO1xuICAgICAgICB0aGlzLnJlZ2lzdGVyKGFyb3VuZChhcHAuc2V0dGluZywgIHthZGRTZXR0aW5nVGFiOiByZWZyZXNoZXIsIHJlbW92ZVNldHRpbmdUYWI6IHJlZnJlc2hlcn0pKTtcblxuICAgICAgICB3b3Jrc3BhY2Uub25MYXlvdXRSZWFkeSh0aGlzLndoZW5SZWFkeS5iaW5kKHRoaXMpKTtcbiAgICB9XG5cbiAgICB3aGVuUmVhZHkoKSB7XG4gICAgICAgIGNvbnN0IGFwcCA9IHRoaXMuYXBwO1xuICAgICAgICBjb25zdCBjb3JlUGx1Z2lucyA9IHRoaXMuZ2V0U2V0dGluZ3NUYWIoXCJwbHVnaW5zXCIpLCBjb21tdW5pdHkgPSB0aGlzLmdldFNldHRpbmdzVGFiKFwidGhpcmQtcGFydHktcGx1Z2luc1wiKTtcblxuICAgICAgICAvLyBIb29rIGludG8gdGhlIGRpc3BsYXkoKSBtZXRob2Qgb2YgdGhlIHBsdWdpbiBzZXR0aW5ncyB0YWJzXG4gICAgICAgIGlmIChjb3JlUGx1Z2lucykgdGhpcy5yZWdpc3Rlcihhcm91bmQoY29yZVBsdWdpbnMsIHtkaXNwbGF5OiB0aGlzLmFkZFBsdWdpblNldHRpbmdFdmVudHMuYmluZCh0aGlzLCBcInBsdWdpbnNcIil9KSk7XG4gICAgICAgIGlmIChjb21tdW5pdHkpICAgdGhpcy5yZWdpc3Rlcihhcm91bmQoY29tbXVuaXR5LCAgIHtkaXNwbGF5OiB0aGlzLmFkZFBsdWdpblNldHRpbmdFdmVudHMuYmluZCh0aGlzLCBcInRoaXJkLXBhcnR5LXBsdWdpbnNcIil9KSk7XG5cbiAgICAgICAgLy8gTm93IGZvcmNlIGEgcmVmcmVzaCBpZiBlaXRoZXIgcGx1Z2lucyB0YWIgaXMgY3VycmVudGx5IHZpc2libGUgKHRvIHNob3cgb3VyIG5ldyBidXR0b25zKVxuICAgICAgICBmdW5jdGlvbiByZWZyZXNoVGFiSWZPcGVuKCkge1xuICAgICAgICAgICAgaWYgKHBsdWdpblNldHRpbmdzQXJlT3BlbihhcHApKSBhcHAuc2V0dGluZy5vcGVuVGFiQnlJZChhcHAuc2V0dGluZy5hY3RpdmVUYWIuaWQpO1xuICAgICAgICB9XG4gICAgICAgIHJlZnJlc2hUYWJJZk9wZW4oKTtcblxuICAgICAgICAvLyBBbmQgZG8gaXQgYWdhaW4gYWZ0ZXIgd2UgdW5sb2FkICh0byByZW1vdmUgdGhlIG9sZCBidXR0b25zKVxuICAgICAgICB0aGlzLnJlZ2lzdGVyKCgpID0+IHNldEltbWVkaWF0ZShyZWZyZXNoVGFiSWZPcGVuKSk7XG5cbiAgICAgICAgLy8gVHdlYWsgdGhlIGhvdGtleSBzZXR0aW5ncyB0YWIgdG8gbWFrZSBmaWx0ZXJpbmcgd29yayBvbiBpZCBwcmVmaXhlcyBhcyB3ZWxsIGFzIGNvbW1hbmQgbmFtZXNcbiAgICAgICAgY29uc3QgaG90a2V5c1RhYiA9IHRoaXMuZ2V0U2V0dGluZ3NUYWIoXCJob3RrZXlzXCIpO1xuICAgICAgICBpZiAoaG90a2V5c1RhYikge1xuICAgICAgICAgICAgdGhpcy5yZWdpc3Rlcihhcm91bmQoaG90a2V5c1RhYiwge1xuICAgICAgICAgICAgICAgIHVwZGF0ZUhvdGtleVZpc2liaWxpdHkob2xkKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBmdW5jdGlvbigpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IG9sZFNlYXJjaCA9IHRoaXMuc2VhcmNoSW5wdXRFbC52YWx1ZSwgb2xkQ29tbWFuZHMgPSBhcHAuY29tbWFuZHMuY29tbWFuZHM7XG4gICAgICAgICAgICAgICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChvbGRTZWFyY2guZW5kc1dpdGgoXCI6XCIpICYmICFvbGRTZWFyY2guY29udGFpbnMoXCIgXCIpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC8vIFRoaXMgaXMgYW4gaW5jcmVkaWJseSB1Z2x5IGhhY2sgdGhhdCByZWxpZXMgb24gdXBkYXRlSG90a2V5VmlzaWJpbGl0eSgpIGl0ZXJhdGluZyBhcHAuY29tbWFuZHMuY29tbWFuZHNcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLy8gbG9va2luZyBmb3IgaG90a2V5IGNvbmZsaWN0cyAqYmVmb3JlKiBhbnl0aGluZyBlbHNlLlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBsZXQgY3VycmVudCA9IG9sZENvbW1hbmRzO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBsZXQgZmlsdGVyZWQgPSBPYmplY3QuZnJvbUVudHJpZXMoT2JqZWN0LmVudHJpZXMoYXBwLmNvbW1hbmRzLmNvbW1hbmRzKS5maWx0ZXIoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAoW2lkLCBjbWRdKSA9PiAoaWQrXCI6XCIpLnN0YXJ0c1dpdGgob2xkU2VhcmNoKVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICApKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5zZWFyY2hJbnB1dEVsLnZhbHVlID0gXCJcIjtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXBwLmNvbW1hbmRzLmNvbW1hbmRzID0gbmV3IFByb3h5KG9sZENvbW1hbmRzLCB7b3duS2V5cygpe1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLy8gVGhlIGZpcnN0IHRpbWUgY29tbWFuZHMgYXJlIGl0ZXJhdGVkLCByZXR1cm4gdGhlIHdob2xlIHRoaW5nO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLy8gYWZ0ZXIgdGhhdCwgcmV0dXJuIHRoZSBmaWx0ZXJlZCBsaXN0XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0cnkgeyByZXR1cm4gT2JqZWN0LmtleXMoY3VycmVudCk7IH0gZmluYWxseSB7IGN1cnJlbnQgPSBmaWx0ZXJlZDsgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9fSk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiBvbGQuY2FsbCh0aGlzKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH0gZmluYWxseSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5zZWFyY2hJbnB1dEVsLnZhbHVlID0gb2xkU2VhcmNoO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFwcC5jb21tYW5kcy5jb21tYW5kcyA9IG9sZENvbW1hbmRzO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSkpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgZ2V0U2V0dGluZ3NUYWIoaWQpIHsgcmV0dXJuIHRoaXMuYXBwLnNldHRpbmcuc2V0dGluZ1RhYnMuZmlsdGVyKHQgPT4gdC5pZCA9PT0gaWQpLnNoaWZ0KCk7IH1cblxuICAgIGFkZFBsdWdpblNldHRpbmdFdmVudHModGFiSWQsIG9sZCkge1xuICAgICAgICBjb25zdCBhcHAgPSB0aGlzLmFwcDtcbiAgICAgICAgbGV0IGluX2V2ZW50ID0gZmFsc2U7XG5cbiAgICAgICAgZnVuY3Rpb24gdHJpZ2dlciguLi5hcmdzKSB7XG4gICAgICAgICAgICBpbl9ldmVudCA9IHRydWU7XG4gICAgICAgICAgICB0cnkgeyBhcHAud29ya3NwYWNlLnRyaWdnZXIoLi4uYXJncyk7IH0gY2F0Y2goZSkgeyBjb25zb2xlLmVycm9yKGUpOyB9XG4gICAgICAgICAgICBpbl9ldmVudCA9IGZhbHNlO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gV3JhcHBlciB0byBhZGQgcGx1Z2luLXNldHRpbmdzIGV2ZW50c1xuICAgICAgICByZXR1cm4gZnVuY3Rpb24gZGlzcGxheSguLi5hcmdzKSB7XG4gICAgICAgICAgICBpZiAoaW5fZXZlbnQpIHJldHVybjtcbiAgICAgICAgICAgIHRyaWdnZXIoXCJwbHVnaW4tc2V0dGluZ3M6YmVmb3JlLWRpc3BsYXlcIiwgdGhpcywgdGFiSWQpO1xuXG4gICAgICAgICAgICAvLyBUcmFjayB3aGljaCBwbHVnaW4gZWFjaCBzZXR0aW5nIGlzIGZvclxuICAgICAgICAgICAgbGV0IG1hbmlmZXN0cztcbiAgICAgICAgICAgIGlmICh0YWJJZCA9PT0gXCJwbHVnaW5zXCIpIHtcbiAgICAgICAgICAgICAgICBtYW5pZmVzdHMgPSBPYmplY3QuZW50cmllcyhhcHAuaW50ZXJuYWxQbHVnaW5zLnBsdWdpbnMpLm1hcChcbiAgICAgICAgICAgICAgICAgICAgKFtpZCwge2luc3RhbmNlOiB7bmFtZX0sIF9sb2FkZWQ6ZW5hYmxlZH1dKSA9PiB7cmV0dXJuIHtpZCwgbmFtZSwgZW5hYmxlZH07fVxuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIG1hbmlmZXN0cyA9IE9iamVjdC52YWx1ZXMoYXBwLnBsdWdpbnMubWFuaWZlc3RzKTtcbiAgICAgICAgICAgICAgICBtYW5pZmVzdHMuc29ydCgoZSwgdCkgPT4gZS5uYW1lLmxvY2FsZUNvbXBhcmUodC5uYW1lKSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBsZXQgd2hpY2ggPSAwO1xuXG4gICAgICAgICAgICAvLyBUcmFwIHRoZSBhZGRpdGlvbiBvZiB0aGUgXCJ1bmluc3RhbGxcIiBidXR0b25zIG5leHQgdG8gZWFjaCBwbHVnaW5cbiAgICAgICAgICAgIGNvbnN0IHJlbW92ZSA9IGFyb3VuZChTZXR0aW5nLnByb3RvdHlwZSwge1xuICAgICAgICAgICAgICAgIGFkZFRvZ2dsZShvbGQpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGZ1bmN0aW9uKC4uLmFyZ3MpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICh0YWJJZCA9PT0gXCJwbHVnaW5zXCIgJiYgIWluX2V2ZW50ICYmIChtYW5pZmVzdHNbd2hpY2hdfHx7fSkubmFtZSA9PT0gdGhpcy5uYW1lRWwudGV4dENvbnRlbnQgKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgbWFuaWZlc3QgPSBtYW5pZmVzdHNbd2hpY2grK107XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdHJpZ2dlcihcInBsdWdpbi1zZXR0aW5nczpwbHVnaW4tY29udHJvbFwiLCB0aGlzLCBtYW5pZmVzdCwgbWFuaWZlc3QuZW5hYmxlZCwgdGFiSWQpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIG9sZC5hcHBseSh0aGlzLCBhcmdzKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgYWRkRXh0cmFCdXR0b24ob2xkKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBmdW5jdGlvbiguLi5hcmdzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAvLyBUaGUgb25seSBcImV4dHJhc1wiIGFkZGVkIHRvIHNldHRpbmdzIHcvYSBkZXNjcmlwdGlvbiBhcmUgb24gdGhlIHBsdWdpbnMsIGN1cnJlbnRseSxcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vIHNvIG9ubHkgdHJ5IHRvIG1hdGNoIHRob3NlIHRvIHBsdWdpbiBuYW1lc1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHRhYklkID09PSBcInRoaXJkLXBhcnR5LXBsdWdpbnNcIiAmJiB0aGlzLmRlc2NFbC5jaGlsZEVsZW1lbnRDb3VudCAmJiAhaW5fZXZlbnQpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoIChtYW5pZmVzdHNbd2hpY2hdfHx7fSkubmFtZSA9PT0gdGhpcy5uYW1lRWwudGV4dENvbnRlbnQgKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IG1hbmlmZXN0ID0gbWFuaWZlc3RzW3doaWNoKytdLCBlbmFibGVkID0gISFhcHAucGx1Z2lucy5wbHVnaW5zW21hbmlmZXN0LmlkXTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHJpZ2dlcihcInBsdWdpbi1zZXR0aW5nczpwbHVnaW4tY29udHJvbFwiLCB0aGlzLCBtYW5pZmVzdCwgZW5hYmxlZCwgdGFiSWQpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgIH07XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gb2xkLmFwcGx5KHRoaXMsIGFyZ3MpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIG9sZC5hcHBseSh0aGlzLCBhcmdzKTtcbiAgICAgICAgICAgIH0gZmluYWxseSB7XG4gICAgICAgICAgICAgICAgcmVtb3ZlKCk7XG4gICAgICAgICAgICAgICAgdHJpZ2dlcihcInBsdWdpbi1zZXR0aW5nczphZnRlci1kaXNwbGF5XCIsIHRoaXMpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfVxuXG4gICAgc2hvd0hvdGtleXNGb3Ioc2VhcmNoKSB7XG4gICAgICAgIHRoaXMuYXBwLnNldHRpbmcub3BlblRhYkJ5SWQoXCJob3RrZXlzXCIpO1xuICAgICAgICBjb25zdCB0YWIgPSB0aGlzLmFwcC5zZXR0aW5nLmFjdGl2ZVRhYjtcbiAgICAgICAgaWYgKHRhYiAmJiB0YWIuc2VhcmNoSW5wdXRFbCAmJiB0YWIudXBkYXRlSG90a2V5VmlzaWJpbGl0eSkge1xuICAgICAgICAgICAgdGFiLnNlYXJjaElucHV0RWwudmFsdWUgPSBzZWFyY2g7XG4gICAgICAgICAgICB0YWIudXBkYXRlSG90a2V5VmlzaWJpbGl0eSgpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgc2hvd0NvbmZpZ0ZvcihpZCkge1xuICAgICAgICB0aGlzLmFwcC5zZXR0aW5nLm9wZW5UYWJCeUlkKGlkKTtcbiAgICB9XG5cbiAgICBwbHVnaW5FbmFibGVkKGlkKSB7XG4gICAgICAgIHJldHVybiB0aGlzLmFwcC5pbnRlcm5hbFBsdWdpbnMucGx1Z2luc1tpZF0/Ll9sb2FkZWQgfHwgdGhpcy5hcHAucGx1Z2lucy5wbHVnaW5zW2lkXTtcbiAgICB9XG5cbiAgICByZWZyZXNoQnV0dG9ucyhmb3JjZT1mYWxzZSkge1xuICAgICAgICAvLyBEb24ndCByZWZyZXNoIHdoZW4gbm90IGRpc3BsYXlpbmcsIHVubGVzcyByZW5kZXJpbmcgaXMgaW4gcHJvZ3Jlc3NcbiAgICAgICAgaWYgKCFwbHVnaW5TZXR0aW5nc0FyZU9wZW4odGhpcy5hcHApICYmICFmb3JjZSkgcmV0dXJuO1xuXG4gICAgICAgIGNvbnN0IGhrbSA9IHRoaXMuYXBwLmhvdGtleU1hbmFnZXI7XG4gICAgICAgIGNvbnN0IGFzc2lnbmVkS2V5Q291bnQgPSB7fTtcblxuICAgICAgICAvLyBHZXQgYSBsaXN0IG9mIGNvbW1hbmRzIGJ5IHBsdWdpblxuICAgICAgICBjb25zdCBjb21tYW5kcyA9IE9iamVjdC52YWx1ZXModGhpcy5hcHAuY29tbWFuZHMuY29tbWFuZHMpLnJlZHVjZSgoY21kcywgY21kKT0+e1xuICAgICAgICAgICAgY29uc3QgcGlkID0gY21kLmlkLnNwbGl0KFwiOlwiLDIpLnNoaWZ0KCk7XG4gICAgICAgICAgICBjb25zdCBob3RrZXlzID0gKGhrbS5nZXRIb3RrZXlzKGNtZC5pZCkgfHwgaGttLmdldERlZmF1bHRIb3RrZXlzKGNtZC5pZCkgfHwgW10pLm1hcChob3RrZXlUb1N0cmluZyk7XG4gICAgICAgICAgICBob3RrZXlzLmZvckVhY2goayA9PiBhc3NpZ25lZEtleUNvdW50W2tdID0gMSArIChhc3NpZ25lZEtleUNvdW50W2tdfHwwKSk7XG4gICAgICAgICAgICAoY21kc1twaWRdIHx8IChjbWRzW3BpZF09W10pKS5wdXNoKHtob3RrZXlzLCBjbWR9KTtcbiAgICAgICAgICAgIHJldHVybiBjbWRzO1xuICAgICAgICB9LCB7fSk7XG4gICAgICAgIGlmIChjb21tYW5kc1tcImV4cGxvcmVyXCJdKSBjb21tYW5kc1tcImZpbGUtZXhwbG9yZXJcIl0gPSBjb21tYW5kc1tcImV4cGxvcmVyXCJdO1xuXG4gICAgICAgIC8vIFBsdWdpbiBzZXR0aW5nIHRhYnMgYnkgcGx1Z2luXG4gICAgICAgIGNvbnN0IHRhYnMgPSBPYmplY3QudmFsdWVzKHRoaXMuYXBwLnNldHRpbmcucGx1Z2luVGFicykucmVkdWNlKCh0YWJzLCB0YWIpPT4ge1xuICAgICAgICAgICAgdGFic1t0YWIuaWRdID0gdGFiOyByZXR1cm4gdGFic1xuICAgICAgICB9LCB7fSk7XG4gICAgICAgIHRhYnNbXCJ3b3Jrc3BhY2VcIl0gPSB0YWJzW1wiZWRpdG9yXCJdID0gdHJ1ZTtcblxuICAgICAgICBmb3IoY29uc3QgaWQgb2YgT2JqZWN0LmtleXModGhpcy5jb25maWdCdXR0b25zIHx8IHt9KSkge1xuICAgICAgICAgICAgY29uc3QgYnRuID0gdGhpcy5jb25maWdCdXR0b25zW2lkXTtcbiAgICAgICAgICAgIGlmICghdGFic1tpZF0pIHtcbiAgICAgICAgICAgICAgICBidG4uZXh0cmFTZXR0aW5nc0VsLmhpZGUoKTtcbiAgICAgICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGJ0bi5leHRyYVNldHRpbmdzRWwuc2hvdygpO1xuICAgICAgICB9XG5cbiAgICAgICAgZm9yKGNvbnN0IGlkIG9mIE9iamVjdC5rZXlzKHRoaXMuaG90a2V5QnV0dG9ucyB8fCB7fSkpIHtcbiAgICAgICAgICAgIGNvbnN0IGJ0biA9IHRoaXMuaG90a2V5QnV0dG9uc1tpZF07XG4gICAgICAgICAgICBpZiAoIWNvbW1hbmRzW2lkXSkge1xuICAgICAgICAgICAgICAgIC8vIFBsdWdpbiBpcyBkaXNhYmxlZCBvciBoYXMgbm8gY29tbWFuZHNcbiAgICAgICAgICAgICAgICBidG4uZXh0cmFTZXR0aW5nc0VsLmhpZGUoKTtcbiAgICAgICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNvbnN0IGFzc2lnbmVkID0gY29tbWFuZHNbaWRdLmZpbHRlcihpbmZvID0+IGluZm8uaG90a2V5cy5sZW5ndGgpO1xuICAgICAgICAgICAgY29uc3QgY29uZmxpY3RzID0gYXNzaWduZWQuZmlsdGVyKGluZm8gPT4gaW5mby5ob3RrZXlzLmZpbHRlcihrID0+IGFzc2lnbmVkS2V5Q291bnRba10+MSkubGVuZ3RoKS5sZW5ndGg7XG5cbiAgICAgICAgICAgIGJ0bi5zZXRUb29sdGlwKFxuICAgICAgICAgICAgICAgIGBDb25maWd1cmUgaG90a2V5cyR7XCJcXG5cIn0oJHthc3NpZ25lZC5sZW5ndGh9LyR7Y29tbWFuZHNbaWRdLmxlbmd0aH0gYXNzaWduZWQke1xuICAgICAgICAgICAgICAgICAgICBjb25mbGljdHMgPyBcIjsgXCIrY29uZmxpY3RzK1wiIGNvbmZsaWN0aW5nXCIgOiBcIlwiXG4gICAgICAgICAgICAgICAgfSlgXG4gICAgICAgICAgICApO1xuICAgICAgICAgICAgYnRuLmV4dHJhU2V0dGluZ3NFbC50b2dnbGVDbGFzcyhcIm1vZC1lcnJvclwiLCAhIWNvbmZsaWN0cyk7XG4gICAgICAgICAgICBidG4uZXh0cmFTZXR0aW5nc0VsLnNob3coKTtcbiAgICAgICAgfVxuICAgIH1cbn1cbiJdLCJuYW1lcyI6WyJLZXltYXAiLCJQbHVnaW4iLCJTZXR0aW5nIiwiZGVib3VuY2UiXSwibWFwcGluZ3MiOiI7Ozs7QUFBTyxTQUFTLE1BQU0sQ0FBQyxHQUFHLEVB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
