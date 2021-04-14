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

        this.registerEvent( workspace.on("plugin-settings:before-display", () => {
            this.hotkeyButtons = {};
            this.configButtons = {};
        }) );
        this.registerEvent( workspace.on("plugin-settings:after-display",  () => this.refreshButtons(true)) );
        this.registerEvent( workspace.on("plugin-settings:plugin-control", (setting, manifest, enabled) => {
            setting.addExtraButton(btn => {
                btn.setIcon("gear");
                btn.onClick(() => this.showConfigFor(manifest.id));
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
            trigger("plugin-settings:before-display", this);

            // Track which plugin each setting is for
            let manifests;
            if (tabId === "plugins") {
                manifests = Object.entries(app.internalPlugins.plugins).map(
                    ([id, {instance: {name, description}, _loaded:enabled}]) => {return {id, name, description, enabled};}
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
                            trigger("plugin-settings:plugin-control", this, manifest, manifest.enabled);
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
                                trigger("plugin-settings:plugin-control", this, manifest, enabled);
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

        for(const id of Object.keys(this.configButtons || {})) {
            const btn = this.configButtons[id];
            if (!tabs[id] || !this.pluginEnabled(id)) {
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWFpbi5qcyIsInNvdXJjZXMiOlsiLnlhcm4vY2FjaGUvbW9ua2V5LWFyb3VuZC1ucG0tMi4xLjAtNzBkZjMyZDJhYy0xYmQ3MmQyNWY5LnppcC9ub2RlX21vZHVsZXMvbW9ua2V5LWFyb3VuZC9tanMvaW5kZXguanMiLCJzcmMvcGx1Z2luLmpzIl0sInNvdXJjZXNDb250ZW50IjpbImV4cG9ydCBmdW5jdGlvbiBhcm91bmQob2JqLCBmYWN0b3JpZXMpIHtcbiAgICBjb25zdCByZW1vdmVycyA9IE9iamVjdC5rZXlzKGZhY3RvcmllcykubWFwKGtleSA9PiBhcm91bmQxKG9iaiwga2V5LCBmYWN0b3JpZXNba2V5XSkpO1xuICAgIHJldHVybiByZW1vdmVycy5sZW5ndGggPT09IDEgPyByZW1vdmVyc1swXSA6IGZ1bmN0aW9uICgpIHsgcmVtb3ZlcnMuZm9yRWFjaChyID0+IHIoKSk7IH07XG59XG5mdW5jdGlvbiBhcm91bmQxKG9iaiwgbWV0aG9kLCBjcmVhdGVXcmFwcGVyKSB7XG4gICAgY29uc3Qgb3JpZ2luYWwgPSBvYmpbbWV0aG9kXSwgaGFkT3duID0gb2JqLmhhc093blByb3BlcnR5KG1ldGhvZCk7XG4gICAgbGV0IGN1cnJlbnQgPSBjcmVhdGVXcmFwcGVyKG9yaWdpbmFsKTtcbiAgICAvLyBMZXQgb3VyIHdyYXBwZXIgaW5oZXJpdCBzdGF0aWMgcHJvcHMgZnJvbSB0aGUgd3JhcHBpbmcgbWV0aG9kLFxuICAgIC8vIGFuZCB0aGUgd3JhcHBpbmcgbWV0aG9kLCBwcm9wcyBmcm9tIHRoZSBvcmlnaW5hbCBtZXRob2RcbiAgICBpZiAob3JpZ2luYWwpXG4gICAgICAgIE9iamVjdC5zZXRQcm90b3R5cGVPZihjdXJyZW50LCBvcmlnaW5hbCk7XG4gICAgT2JqZWN0LnNldFByb3RvdHlwZU9mKHdyYXBwZXIsIGN1cnJlbnQpO1xuICAgIG9ialttZXRob2RdID0gd3JhcHBlcjtcbiAgICAvLyBSZXR1cm4gYSBjYWxsYmFjayB0byBhbGxvdyBzYWZlIHJlbW92YWxcbiAgICByZXR1cm4gcmVtb3ZlO1xuICAgIGZ1bmN0aW9uIHdyYXBwZXIoLi4uYXJncykge1xuICAgICAgICAvLyBJZiB3ZSBoYXZlIGJlZW4gZGVhY3RpdmF0ZWQgYW5kIGFyZSBubyBsb25nZXIgd3JhcHBlZCwgcmVtb3ZlIG91cnNlbHZlc1xuICAgICAgICBpZiAoY3VycmVudCA9PT0gb3JpZ2luYWwgJiYgb2JqW21ldGhvZF0gPT09IHdyYXBwZXIpXG4gICAgICAgICAgICByZW1vdmUoKTtcbiAgICAgICAgcmV0dXJuIGN1cnJlbnQuYXBwbHkodGhpcywgYXJncyk7XG4gICAgfVxuICAgIGZ1bmN0aW9uIHJlbW92ZSgpIHtcbiAgICAgICAgLy8gSWYgbm8gb3RoZXIgcGF0Y2hlcywganVzdCBkbyBhIGRpcmVjdCByZW1vdmFsXG4gICAgICAgIGlmIChvYmpbbWV0aG9kXSA9PT0gd3JhcHBlcikge1xuICAgICAgICAgICAgaWYgKGhhZE93bilcbiAgICAgICAgICAgICAgICBvYmpbbWV0aG9kXSA9IG9yaWdpbmFsO1xuICAgICAgICAgICAgZWxzZVxuICAgICAgICAgICAgICAgIGRlbGV0ZSBvYmpbbWV0aG9kXTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoY3VycmVudCA9PT0gb3JpZ2luYWwpXG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgIC8vIEVsc2UgcGFzcyBmdXR1cmUgY2FsbHMgdGhyb3VnaCwgYW5kIHJlbW92ZSB3cmFwcGVyIGZyb20gdGhlIHByb3RvdHlwZSBjaGFpblxuICAgICAgICBjdXJyZW50ID0gb3JpZ2luYWw7XG4gICAgICAgIE9iamVjdC5zZXRQcm90b3R5cGVPZih3cmFwcGVyLCBvcmlnaW5hbCB8fCBGdW5jdGlvbik7XG4gICAgfVxufVxuZXhwb3J0IGZ1bmN0aW9uIGFmdGVyKHByb21pc2UsIGNiKSB7XG4gICAgcmV0dXJuIHByb21pc2UudGhlbihjYiwgY2IpO1xufVxuZXhwb3J0IGZ1bmN0aW9uIHNlcmlhbGl6ZShhc3luY0Z1bmN0aW9uKSB7XG4gICAgbGV0IGxhc3RSdW4gPSBQcm9taXNlLnJlc29sdmUoKTtcbiAgICBmdW5jdGlvbiB3cmFwcGVyKC4uLmFyZ3MpIHtcbiAgICAgICAgcmV0dXJuIGxhc3RSdW4gPSBuZXcgUHJvbWlzZSgocmVzLCByZWopID0+IHtcbiAgICAgICAgICAgIGFmdGVyKGxhc3RSdW4sICgpID0+IHtcbiAgICAgICAgICAgICAgICBhc3luY0Z1bmN0aW9uLmFwcGx5KHRoaXMsIGFyZ3MpLnRoZW4ocmVzLCByZWopO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH0pO1xuICAgIH1cbiAgICB3cmFwcGVyLmFmdGVyID0gZnVuY3Rpb24gKCkge1xuICAgICAgICByZXR1cm4gbGFzdFJ1biA9IG5ldyBQcm9taXNlKChyZXMsIHJlaikgPT4geyBhZnRlcihsYXN0UnVuLCByZXMpOyB9KTtcbiAgICB9O1xuICAgIHJldHVybiB3cmFwcGVyO1xufVxuIiwiaW1wb3J0IHtQbHVnaW4sIEtleW1hcCwgU2V0dGluZywgZGVib3VuY2V9IGZyb20gXCJvYnNpZGlhblwiO1xuaW1wb3J0IHthcm91bmR9IGZyb20gXCJtb25rZXktYXJvdW5kXCI7XG5cbmZ1bmN0aW9uIGhvdGtleVRvU3RyaW5nKGhvdGtleSkge1xuICAgIHJldHVybiBLZXltYXAuY29tcGlsZU1vZGlmaWVycyhob3RrZXkubW9kaWZpZXJzKStcIixcIiArIGhvdGtleS5rZXkudG9Mb3dlckNhc2UoKVxufVxuXG5mdW5jdGlvbiBwbHVnaW5TZXR0aW5nc0FyZU9wZW4oYXBwKSB7XG4gICAgcmV0dXJuIChcbiAgICAgICAgYXBwLnNldHRpbmcuY29udGFpbmVyRWwucGFyZW50RWxlbWVudCAhPT0gbnVsbCAmJlxuICAgICAgICBhcHAuc2V0dGluZy5hY3RpdmVUYWIgJiZcbiAgICAgICAgKGFwcC5zZXR0aW5nLmFjdGl2ZVRhYi5pZCA9PT0gXCJ0aGlyZC1wYXJ0eS1wbHVnaW5zXCIgfHwgYXBwLnNldHRpbmcuYWN0aXZlVGFiLmlkID09PSBcInBsdWdpbnNcIilcbiAgICApO1xufVxuXG5leHBvcnQgZGVmYXVsdCBjbGFzcyBIb3RrZXlIZWxwZXIgZXh0ZW5kcyBQbHVnaW4ge1xuXG4gICAgb25sb2FkKCkge1xuICAgICAgICBjb25zdCB3b3Jrc3BhY2UgPSB0aGlzLmFwcC53b3Jrc3BhY2U7XG5cbiAgICAgICAgdGhpcy5yZWdpc3RlckV2ZW50KCB3b3Jrc3BhY2Uub24oXCJwbHVnaW4tc2V0dGluZ3M6YmVmb3JlLWRpc3BsYXlcIiwgKCkgPT4ge1xuICAgICAgICAgICAgdGhpcy5ob3RrZXlCdXR0b25zID0ge307XG4gICAgICAgICAgICB0aGlzLmNvbmZpZ0J1dHRvbnMgPSB7fTtcbiAgICAgICAgfSkgKTtcbiAgICAgICAgdGhpcy5yZWdpc3RlckV2ZW50KCB3b3Jrc3BhY2Uub24oXCJwbHVnaW4tc2V0dGluZ3M6YWZ0ZXItZGlzcGxheVwiLCAgKCkgPT4gdGhpcy5yZWZyZXNoQnV0dG9ucyh0cnVlKSkgKTtcbiAgICAgICAgdGhpcy5yZWdpc3RlckV2ZW50KCB3b3Jrc3BhY2Uub24oXCJwbHVnaW4tc2V0dGluZ3M6cGx1Z2luLWNvbnRyb2xcIiwgKHNldHRpbmcsIG1hbmlmZXN0LCBlbmFibGVkKSA9PiB7XG4gICAgICAgICAgICBzZXR0aW5nLmFkZEV4dHJhQnV0dG9uKGJ0biA9PiB7XG4gICAgICAgICAgICAgICAgYnRuLnNldEljb24oXCJnZWFyXCIpO1xuICAgICAgICAgICAgICAgIGJ0bi5vbkNsaWNrKCgpID0+IHRoaXMuc2hvd0NvbmZpZ0ZvcihtYW5pZmVzdC5pZCkpXG4gICAgICAgICAgICAgICAgYnRuLnNldFRvb2x0aXAoXCJPcHRpb25zXCIpO1xuICAgICAgICAgICAgICAgIGJ0bi5leHRyYVNldHRpbmdzRWwudG9nZ2xlKGVuYWJsZWQpXG4gICAgICAgICAgICAgICAgdGhpcy5jb25maWdCdXR0b25zW21hbmlmZXN0LmlkXSA9IGJ0bjtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgc2V0dGluZy5hZGRFeHRyYUJ1dHRvbihidG4gPT4ge1xuICAgICAgICAgICAgICAgIGJ0bi5zZXRJY29uKFwiYW55LWtleVwiKTtcbiAgICAgICAgICAgICAgICBidG4ub25DbGljaygoKSA9PiB0aGlzLnNob3dIb3RrZXlzRm9yKG1hbmlmZXN0LmlkLnJlcGxhY2UoL15maWxlLWV4cGxvcmVyJC8sXCJleHBsb3JlclwiKStcIjpcIikpXG4gICAgICAgICAgICAgICAgYnRuLmV4dHJhU2V0dGluZ3NFbC50b2dnbGUoZW5hYmxlZClcbiAgICAgICAgICAgICAgICB0aGlzLmhvdGtleUJ1dHRvbnNbbWFuaWZlc3QuaWRdID0gYnRuO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH0pICk7XG5cbiAgICAgICAgLy8gUmVmcmVzaCB0aGUgYnV0dG9ucyB3aGVuIGNvbW1hbmRzIG9yIHNldHRpbmcgdGFicyBhcmUgYWRkZWQgb3IgcmVtb3ZlZFxuICAgICAgICBjb25zdCByZXF1ZXN0UmVmcmVzaCA9IGRlYm91bmNlKHRoaXMucmVmcmVzaEJ1dHRvbnMuYmluZCh0aGlzKSwgNTAsIHRydWUpO1xuICAgICAgICBmdW5jdGlvbiByZWZyZXNoZXIob2xkKSB7IHJldHVybiBmdW5jdGlvbiguLi5hcmdzKXsgcmVxdWVzdFJlZnJlc2goKTsgcmV0dXJuIG9sZC5hcHBseSh0aGlzLCBhcmdzKTsgfTsgfVxuICAgICAgICB0aGlzLnJlZ2lzdGVyKGFyb3VuZChhcHAuY29tbWFuZHMsIHthZGRDb21tYW5kOiAgICByZWZyZXNoZXIsIHJlbW92ZUNvbW1hbmQ6ICAgIHJlZnJlc2hlcn0pKTtcbiAgICAgICAgdGhpcy5yZWdpc3Rlcihhcm91bmQoYXBwLnNldHRpbmcsICB7YWRkUGx1Z2luVGFiOiAgcmVmcmVzaGVyLCByZW1vdmVQbHVnaW5UYWI6ICByZWZyZXNoZXJ9KSk7XG4gICAgICAgIHRoaXMucmVnaXN0ZXIoYXJvdW5kKGFwcC5zZXR0aW5nLCAge2FkZFNldHRpbmdUYWI6IHJlZnJlc2hlciwgcmVtb3ZlU2V0dGluZ1RhYjogcmVmcmVzaGVyfSkpO1xuXG4gICAgICAgIHdvcmtzcGFjZS5vbkxheW91dFJlYWR5KHRoaXMud2hlblJlYWR5LmJpbmQodGhpcykpO1xuICAgIH1cblxuICAgIHdoZW5SZWFkeSgpIHtcbiAgICAgICAgY29uc3QgYXBwID0gdGhpcy5hcHA7XG4gICAgICAgIGNvbnN0IGNvcmVQbHVnaW5zID0gdGhpcy5nZXRTZXR0aW5nc1RhYihcInBsdWdpbnNcIiksIGNvbW11bml0eSA9IHRoaXMuZ2V0U2V0dGluZ3NUYWIoXCJ0aGlyZC1wYXJ0eS1wbHVnaW5zXCIpO1xuXG4gICAgICAgIC8vIEhvb2sgaW50byB0aGUgZGlzcGxheSgpIG1ldGhvZCBvZiB0aGUgcGx1Z2luIHNldHRpbmdzIHRhYnNcbiAgICAgICAgaWYgKGNvcmVQbHVnaW5zKSB0aGlzLnJlZ2lzdGVyKGFyb3VuZChjb3JlUGx1Z2lucywge2Rpc3BsYXk6IHRoaXMuYWRkUGx1Z2luU2V0dGluZ0V2ZW50cy5iaW5kKHRoaXMsIFwicGx1Z2luc1wiKX0pKTtcbiAgICAgICAgaWYgKGNvbW11bml0eSkgICB0aGlzLnJlZ2lzdGVyKGFyb3VuZChjb21tdW5pdHksICAge2Rpc3BsYXk6IHRoaXMuYWRkUGx1Z2luU2V0dGluZ0V2ZW50cy5iaW5kKHRoaXMsIFwidGhpcmQtcGFydHktcGx1Z2luc1wiKX0pKTtcblxuICAgICAgICAvLyBOb3cgZm9yY2UgYSByZWZyZXNoIGlmIGVpdGhlciBwbHVnaW5zIHRhYiBpcyBjdXJyZW50bHkgdmlzaWJsZSAodG8gc2hvdyBvdXIgbmV3IGJ1dHRvbnMpXG4gICAgICAgIGZ1bmN0aW9uIHJlZnJlc2hUYWJJZk9wZW4oKSB7XG4gICAgICAgICAgICBpZiAocGx1Z2luU2V0dGluZ3NBcmVPcGVuKGFwcCkpIGFwcC5zZXR0aW5nLm9wZW5UYWJCeUlkKGFwcC5zZXR0aW5nLmFjdGl2ZVRhYi5pZCk7XG4gICAgICAgIH1cbiAgICAgICAgcmVmcmVzaFRhYklmT3BlbigpO1xuXG4gICAgICAgIC8vIEFuZCBkbyBpdCBhZ2FpbiBhZnRlciB3ZSB1bmxvYWQgKHRvIHJlbW92ZSB0aGUgb2xkIGJ1dHRvbnMpXG4gICAgICAgIHRoaXMucmVnaXN0ZXIoKCkgPT4gc2V0SW1tZWRpYXRlKHJlZnJlc2hUYWJJZk9wZW4pKTtcblxuICAgICAgICAvLyBUd2VhayB0aGUgaG90a2V5IHNldHRpbmdzIHRhYiB0byBtYWtlIGZpbHRlcmluZyB3b3JrIG9uIGlkIHByZWZpeGVzIGFzIHdlbGwgYXMgY29tbWFuZCBuYW1lc1xuICAgICAgICBjb25zdCBob3RrZXlzVGFiID0gdGhpcy5nZXRTZXR0aW5nc1RhYihcImhvdGtleXNcIik7XG4gICAgICAgIGlmIChob3RrZXlzVGFiKSB7XG4gICAgICAgICAgICB0aGlzLnJlZ2lzdGVyKGFyb3VuZChob3RrZXlzVGFiLCB7XG4gICAgICAgICAgICAgICAgdXBkYXRlSG90a2V5VmlzaWJpbGl0eShvbGQpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGZ1bmN0aW9uKCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgY29uc3Qgb2xkU2VhcmNoID0gdGhpcy5zZWFyY2hJbnB1dEVsLnZhbHVlLCBvbGRDb21tYW5kcyA9IGFwcC5jb21tYW5kcy5jb21tYW5kcztcbiAgICAgICAgICAgICAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKG9sZFNlYXJjaC5lbmRzV2l0aChcIjpcIikgJiYgIW9sZFNlYXJjaC5jb250YWlucyhcIiBcIikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLy8gVGhpcyBpcyBhbiBpbmNyZWRpYmx5IHVnbHkgaGFjayB0aGF0IHJlbGllcyBvbiB1cGRhdGVIb3RrZXlWaXNpYmlsaXR5KCkgaXRlcmF0aW5nIGFwcC5jb21tYW5kcy5jb21tYW5kc1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAvLyBsb29raW5nIGZvciBob3RrZXkgY29uZmxpY3RzICpiZWZvcmUqIGFueXRoaW5nIGVsc2UuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxldCBjdXJyZW50ID0gb2xkQ29tbWFuZHM7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxldCBmaWx0ZXJlZCA9IE9iamVjdC5mcm9tRW50cmllcyhPYmplY3QuZW50cmllcyhhcHAuY29tbWFuZHMuY29tbWFuZHMpLmZpbHRlcihcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIChbaWQsIGNtZF0pID0+IChpZCtcIjpcIikuc3RhcnRzV2l0aChvbGRTZWFyY2gpXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICkpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aGlzLnNlYXJjaElucHV0RWwudmFsdWUgPSBcIlwiO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhcHAuY29tbWFuZHMuY29tbWFuZHMgPSBuZXcgUHJveHkob2xkQ29tbWFuZHMsIHtvd25LZXlzKCl7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAvLyBUaGUgZmlyc3QgdGltZSBjb21tYW5kcyBhcmUgaXRlcmF0ZWQsIHJldHVybiB0aGUgd2hvbGUgdGhpbmc7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAvLyBhZnRlciB0aGF0LCByZXR1cm4gdGhlIGZpbHRlcmVkIGxpc3RcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRyeSB7IHJldHVybiBPYmplY3Qua2V5cyhjdXJyZW50KTsgfSBmaW5hbGx5IHsgY3VycmVudCA9IGZpbHRlcmVkOyB9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH19KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIG9sZC5jYWxsKHRoaXMpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfSBmaW5hbGx5IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aGlzLnNlYXJjaElucHV0RWwudmFsdWUgPSBvbGRTZWFyY2g7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYXBwLmNvbW1hbmRzLmNvbW1hbmRzID0gb2xkQ29tbWFuZHM7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9KSk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBnZXRTZXR0aW5nc1RhYihpZCkgeyByZXR1cm4gdGhpcy5hcHAuc2V0dGluZy5zZXR0aW5nVGFicy5maWx0ZXIodCA9PiB0LmlkID09PSBpZCkuc2hpZnQoKTsgfVxuXG4gICAgYWRkUGx1Z2luU2V0dGluZ0V2ZW50cyh0YWJJZCwgb2xkKSB7XG4gICAgICAgIGNvbnN0IGFwcCA9IHRoaXMuYXBwO1xuICAgICAgICBsZXQgaW5fZXZlbnQgPSBmYWxzZTtcblxuICAgICAgICBmdW5jdGlvbiB0cmlnZ2VyKC4uLmFyZ3MpIHtcbiAgICAgICAgICAgIGluX2V2ZW50ID0gdHJ1ZTtcbiAgICAgICAgICAgIHRyeSB7IGFwcC53b3Jrc3BhY2UudHJpZ2dlciguLi5hcmdzKTsgfSBjYXRjaChlKSB7IGNvbnNvbGUuZXJyb3IoZSk7IH1cbiAgICAgICAgICAgIGluX2V2ZW50ID0gZmFsc2U7XG4gICAgICAgIH1cblxuICAgICAgICAvLyBXcmFwcGVyIHRvIGFkZCBwbHVnaW4tc2V0dGluZ3MgZXZlbnRzXG4gICAgICAgIHJldHVybiBmdW5jdGlvbiBkaXNwbGF5KC4uLmFyZ3MpIHtcbiAgICAgICAgICAgIGlmIChpbl9ldmVudCkgcmV0dXJuO1xuICAgICAgICAgICAgdHJpZ2dlcihcInBsdWdpbi1zZXR0aW5nczpiZWZvcmUtZGlzcGxheVwiLCB0aGlzKTtcblxuICAgICAgICAgICAgLy8gVHJhY2sgd2hpY2ggcGx1Z2luIGVhY2ggc2V0dGluZyBpcyBmb3JcbiAgICAgICAgICAgIGxldCBtYW5pZmVzdHM7XG4gICAgICAgICAgICBpZiAodGFiSWQgPT09IFwicGx1Z2luc1wiKSB7XG4gICAgICAgICAgICAgICAgbWFuaWZlc3RzID0gT2JqZWN0LmVudHJpZXMoYXBwLmludGVybmFsUGx1Z2lucy5wbHVnaW5zKS5tYXAoXG4gICAgICAgICAgICAgICAgICAgIChbaWQsIHtpbnN0YW5jZToge25hbWUsIGRlc2NyaXB0aW9ufSwgX2xvYWRlZDplbmFibGVkfV0pID0+IHtyZXR1cm4ge2lkLCBuYW1lLCBkZXNjcmlwdGlvbiwgZW5hYmxlZH07fVxuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIG1hbmlmZXN0cyA9IE9iamVjdC52YWx1ZXMoYXBwLnBsdWdpbnMubWFuaWZlc3RzKTtcbiAgICAgICAgICAgICAgICBtYW5pZmVzdHMuc29ydCgoZSwgdCkgPT4gZS5uYW1lLmxvY2FsZUNvbXBhcmUodC5uYW1lKSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBsZXQgd2hpY2ggPSAwO1xuXG4gICAgICAgICAgICAvLyBUcmFwIHRoZSBhZGRpdGlvbiBvZiB0aGUgXCJ1bmluc3RhbGxcIiBidXR0b25zIG5leHQgdG8gZWFjaCBwbHVnaW5cbiAgICAgICAgICAgIGNvbnN0IHJlbW92ZSA9IGFyb3VuZChTZXR0aW5nLnByb3RvdHlwZSwge1xuICAgICAgICAgICAgICAgIGFkZFRvZ2dsZShvbGQpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGZ1bmN0aW9uKC4uLmFyZ3MpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICh0YWJJZCA9PT0gXCJwbHVnaW5zXCIgJiYgIWluX2V2ZW50ICYmIChtYW5pZmVzdHNbd2hpY2hdfHx7fSkubmFtZSA9PT0gdGhpcy5uYW1lRWwudGV4dENvbnRlbnQgKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgbWFuaWZlc3QgPSBtYW5pZmVzdHNbd2hpY2grK107XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdHJpZ2dlcihcInBsdWdpbi1zZXR0aW5nczpwbHVnaW4tY29udHJvbFwiLCB0aGlzLCBtYW5pZmVzdCwgbWFuaWZlc3QuZW5hYmxlZCk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gb2xkLmFwcGx5KHRoaXMsIGFyZ3MpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICBhZGRFeHRyYUJ1dHRvbihvbGQpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGZ1bmN0aW9uKC4uLmFyZ3MpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vIFRoZSBvbmx5IFwiZXh0cmFzXCIgYWRkZWQgdG8gc2V0dGluZ3Mgdy9hIGRlc2NyaXB0aW9uIGFyZSBvbiB0aGUgcGx1Z2lucywgY3VycmVudGx5LFxuICAgICAgICAgICAgICAgICAgICAgICAgLy8gc28gb25seSB0cnkgdG8gbWF0Y2ggdGhvc2UgdG8gcGx1Z2luIG5hbWVzXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAodGFiSWQgPT09IFwidGhpcmQtcGFydHktcGx1Z2luc1wiICYmIHRoaXMuZGVzY0VsLmNoaWxkRWxlbWVudENvdW50ICYmICFpbl9ldmVudCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICggKG1hbmlmZXN0c1t3aGljaF18fHt9KS5uYW1lID09PSB0aGlzLm5hbWVFbC50ZXh0Q29udGVudCApIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgbWFuaWZlc3QgPSBtYW5pZmVzdHNbd2hpY2grK10sIGVuYWJsZWQgPSAhIWFwcC5wbHVnaW5zLnBsdWdpbnNbbWFuaWZlc3QuaWRdO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0cmlnZ2VyKFwicGx1Z2luLXNldHRpbmdzOnBsdWdpbi1jb250cm9sXCIsIHRoaXMsIG1hbmlmZXN0LCBlbmFibGVkKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIG9sZC5hcHBseSh0aGlzLCBhcmdzKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgIHJldHVybiBvbGQuYXBwbHkodGhpcywgYXJncyk7XG4gICAgICAgICAgICB9IGZpbmFsbHkge1xuICAgICAgICAgICAgICAgIHJlbW92ZSgpO1xuICAgICAgICAgICAgICAgIHRyaWdnZXIoXCJwbHVnaW4tc2V0dGluZ3M6YWZ0ZXItZGlzcGxheVwiLCB0aGlzKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH1cblxuICAgIHNob3dIb3RrZXlzRm9yKHNlYXJjaCkge1xuICAgICAgICB0aGlzLmFwcC5zZXR0aW5nLm9wZW5UYWJCeUlkKFwiaG90a2V5c1wiKTtcbiAgICAgICAgY29uc3QgdGFiID0gdGhpcy5hcHAuc2V0dGluZy5hY3RpdmVUYWI7XG4gICAgICAgIGlmICh0YWIgJiYgdGFiLnNlYXJjaElucHV0RWwgJiYgdGFiLnVwZGF0ZUhvdGtleVZpc2liaWxpdHkpIHtcbiAgICAgICAgICAgIHRhYi5zZWFyY2hJbnB1dEVsLnZhbHVlID0gc2VhcmNoO1xuICAgICAgICAgICAgdGFiLnVwZGF0ZUhvdGtleVZpc2liaWxpdHkoKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIHNob3dDb25maWdGb3IoaWQpIHtcbiAgICAgICAgdGhpcy5hcHAuc2V0dGluZy5vcGVuVGFiQnlJZChpZCk7XG4gICAgfVxuXG4gICAgcGx1Z2luRW5hYmxlZChpZCkge1xuICAgICAgICByZXR1cm4gdGhpcy5hcHAuaW50ZXJuYWxQbHVnaW5zLnBsdWdpbnNbaWRdPy5fbG9hZGVkIHx8IHRoaXMuYXBwLnBsdWdpbnMucGx1Z2luc1tpZF07XG4gICAgfVxuXG4gICAgcmVmcmVzaEJ1dHRvbnMoZm9yY2U9ZmFsc2UpIHtcbiAgICAgICAgLy8gRG9uJ3QgcmVmcmVzaCB3aGVuIG5vdCBkaXNwbGF5aW5nLCB1bmxlc3MgcmVuZGVyaW5nIGlzIGluIHByb2dyZXNzXG4gICAgICAgIGlmICghcGx1Z2luU2V0dGluZ3NBcmVPcGVuKHRoaXMuYXBwKSAmJiAhZm9yY2UpIHJldHVybjtcblxuICAgICAgICBjb25zdCBoa20gPSB0aGlzLmFwcC5ob3RrZXlNYW5hZ2VyO1xuICAgICAgICBjb25zdCBhc3NpZ25lZEtleUNvdW50ID0ge307XG5cbiAgICAgICAgLy8gR2V0IGEgbGlzdCBvZiBjb21tYW5kcyBieSBwbHVnaW5cbiAgICAgICAgY29uc3QgY29tbWFuZHMgPSBPYmplY3QudmFsdWVzKHRoaXMuYXBwLmNvbW1hbmRzLmNvbW1hbmRzKS5yZWR1Y2UoKGNtZHMsIGNtZCk9PntcbiAgICAgICAgICAgIGNvbnN0IHBpZCA9IGNtZC5pZC5zcGxpdChcIjpcIiwyKS5zaGlmdCgpO1xuICAgICAgICAgICAgY29uc3QgaG90a2V5cyA9IChoa20uZ2V0SG90a2V5cyhjbWQuaWQpIHx8IGhrbS5nZXREZWZhdWx0SG90a2V5cyhjbWQuaWQpIHx8IFtdKS5tYXAoaG90a2V5VG9TdHJpbmcpO1xuICAgICAgICAgICAgaG90a2V5cy5mb3JFYWNoKGsgPT4gYXNzaWduZWRLZXlDb3VudFtrXSA9IDEgKyAoYXNzaWduZWRLZXlDb3VudFtrXXx8MCkpO1xuICAgICAgICAgICAgKGNtZHNbcGlkXSB8fCAoY21kc1twaWRdPVtdKSkucHVzaCh7aG90a2V5cywgY21kfSk7XG4gICAgICAgICAgICByZXR1cm4gY21kcztcbiAgICAgICAgfSwge30pO1xuICAgICAgICBpZiAoY29tbWFuZHNbXCJleHBsb3JlclwiXSkgY29tbWFuZHNbXCJmaWxlLWV4cGxvcmVyXCJdID0gY29tbWFuZHNbXCJleHBsb3JlclwiXTtcblxuICAgICAgICAvLyBQbHVnaW4gc2V0dGluZyB0YWJzIGJ5IHBsdWdpblxuICAgICAgICBjb25zdCB0YWJzID0gT2JqZWN0LnZhbHVlcyh0aGlzLmFwcC5zZXR0aW5nLnBsdWdpblRhYnMpLnJlZHVjZSgodGFicywgdGFiKT0+IHtcbiAgICAgICAgICAgIHRhYnNbdGFiLmlkXSA9IHRhYjsgcmV0dXJuIHRhYnNcbiAgICAgICAgfSwge30pO1xuXG4gICAgICAgIGZvcihjb25zdCBpZCBvZiBPYmplY3Qua2V5cyh0aGlzLmNvbmZpZ0J1dHRvbnMgfHwge30pKSB7XG4gICAgICAgICAgICBjb25zdCBidG4gPSB0aGlzLmNvbmZpZ0J1dHRvbnNbaWRdO1xuICAgICAgICAgICAgaWYgKCF0YWJzW2lkXSB8fCAhdGhpcy5wbHVnaW5FbmFibGVkKGlkKSkge1xuICAgICAgICAgICAgICAgIGJ0bi5leHRyYVNldHRpbmdzRWwuaGlkZSgpO1xuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgYnRuLmV4dHJhU2V0dGluZ3NFbC5zaG93KCk7XG4gICAgICAgIH1cblxuICAgICAgICBmb3IoY29uc3QgaWQgb2YgT2JqZWN0LmtleXModGhpcy5ob3RrZXlCdXR0b25zIHx8IHt9KSkge1xuICAgICAgICAgICAgY29uc3QgYnRuID0gdGhpcy5ob3RrZXlCdXR0b25zW2lkXTtcbiAgICAgICAgICAgIGlmICghY29tbWFuZHNbaWRdKSB7XG4gICAgICAgICAgICAgICAgLy8gUGx1Z2luIGlzIGRpc2FibGVkIG9yIGhhcyBubyBjb21tYW5kc1xuICAgICAgICAgICAgICAgIGJ0bi5leHRyYVNldHRpbmdzRWwuaGlkZSgpO1xuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY29uc3QgYXNzaWduZWQgPSBjb21tYW5kc1tpZF0uZmlsdGVyKGluZm8gPT4gaW5mby5ob3RrZXlzLmxlbmd0aCk7XG4gICAgICAgICAgICBjb25zdCBjb25mbGljdHMgPSBhc3NpZ25lZC5maWx0ZXIoaW5mbyA9PiBpbmZvLmhvdGtleXMuZmlsdGVyKGsgPT4gYXNzaWduZWRLZXlDb3VudFtrXT4xKS5sZW5ndGgpLmxlbmd0aDtcblxuICAgICAgICAgICAgYnRuLnNldFRvb2x0aXAoXG4gICAgICAgICAgICAgICAgYENvbmZpZ3VyZSBob3RrZXlzJHtcIlxcblwifSgke2Fzc2lnbmVkLmxlbmd0aH0vJHtjb21tYW5kc1tpZF0ubGVuZ3RofSBhc3NpZ25lZCR7XG4gICAgICAgICAgICAgICAgICAgIGNvbmZsaWN0cyA/IFwiOyBcIitjb25mbGljdHMrXCIgY29uZmxpY3RpbmdcIiA6IFwiXCJcbiAgICAgICAgICAgICAgICB9KWBcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgICBidG4uZXh0cmFTZXR0aW5nc0VsLnRvZ2dsZUNsYXNzKFwibW9kLWVycm9yXCIsICEhY29uZmxpY3RzKTtcbiAgICAgICAgICAgIGJ0bi5leHRyYVNldHRpbmdzRWwuc2hvdygpO1xuICAgICAgICB9XG4gICAgfVxufVxuIl0sIm5hbWVzIjpbIktleW1hcCIsIlBsdWdpbiIsImRlYm91bmNlIiwiU2V0dGluZyJdLCJtYXBwaW5ncyI6Ijs7OztBQUFPLFNBQVMsTUFBTSxDQUFDLEdBQUcsRUFBRSxTQUFTLEVBQUU7QUFDdkMsSUFBSSxNQUFNLFFBQVEsR0FBRyxNQUFNLENBQUMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxHQUFHLElBQUksT0FBTyxDQUFDLEdBQUcsRUFBRSxHQUFHLEVBQUUsU0FBUyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUMxRixJQUFJLE9BQU8sUUFBUSxDQUFDLE1BQU0sS0FBSyxDQUFDLEdBQUcsUUFBUSxDQUFDLENBQUMsQ0FBQyxHQUFHLFlBQVksRUFBRSxRQUFRLENBQUMsT0FBTyxDQUFDLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQyxDQUFDLEVBQUUsQ0FBQztBQUM3RixDQUFDO0FBQ0QsU0FBUyxPQUFPLENBQUMsR0FBRyxFQUFFLE1BQU0sRUFBRSxh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
