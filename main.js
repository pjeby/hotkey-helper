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
    return settingsAreOpen(app) && isPluginTab(app.setting.activeTab?.id)
}

function settingsAreOpen(app) {
    return app.setting.containerEl.parentElement !== null
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

module.exports = HotkeyHelper;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWFpbi5qcyIsInNvdXJjZXMiOlsiLnlhcm4vY2FjaGUvbW9ua2V5LWFyb3VuZC1ucG0tMi4xLjAtNzBkZjMyZDJhYy0xYmQ3MmQyNWY5LnppcC9ub2RlX21vZHVsZXMvbW9ua2V5LWFyb3VuZC9tanMvaW5kZXguanMiLCJzcmMvcGx1Z2luLmpzIl0sInNvdXJjZXNDb250ZW50IjpbImV4cG9ydCBmdW5jdGlvbiBhcm91bmQob2JqLCBmYWN0b3JpZXMpIHtcbiAgICBjb25zdCByZW1vdmVycyA9IE9iamVjdC5rZXlzKGZhY3RvcmllcykubWFwKGtleSA9PiBhcm91bmQxKG9iaiwga2V5LCBmYWN0b3JpZXNba2V5XSkpO1xuICAgIHJldHVybiByZW1vdmVycy5sZW5ndGggPT09IDEgPyByZW1vdmVyc1swXSA6IGZ1bmN0aW9uICgpIHsgcmVtb3ZlcnMuZm9yRWFjaChyID0+IHIoKSk7IH07XG59XG5mdW5jdGlvbiBhcm91bmQxKG9iaiwgbWV0aG9kLCBjcmVhdGVXcmFwcGVyKSB7XG4gICAgY29uc3Qgb3JpZ2luYWwgPSBvYmpbbWV0aG9kXSwgaGFkT3duID0gb2JqLmhhc093blByb3BlcnR5KG1ldGhvZCk7XG4gICAgbGV0IGN1cnJlbnQgPSBjcmVhdGVXcmFwcGVyKG9yaWdpbmFsKTtcbiAgICAvLyBMZXQgb3VyIHdyYXBwZXIgaW5oZXJpdCBzdGF0aWMgcHJvcHMgZnJvbSB0aGUgd3JhcHBpbmcgbWV0aG9kLFxuICAgIC8vIGFuZCB0aGUgd3JhcHBpbmcgbWV0aG9kLCBwcm9wcyBmcm9tIHRoZSBvcmlnaW5hbCBtZXRob2RcbiAgICBpZiAob3JpZ2luYWwpXG4gICAgICAgIE9iamVjdC5zZXRQcm90b3R5cGVPZihjdXJyZW50LCBvcmlnaW5hbCk7XG4gICAgT2JqZWN0LnNldFByb3RvdHlwZU9mKHdyYXBwZXIsIGN1cnJlbnQpO1xuICAgIG9ialttZXRob2RdID0gd3JhcHBlcjtcbiAgICAvLyBSZXR1cm4gYSBjYWxsYmFjayB0byBhbGxvdyBzYWZlIHJlbW92YWxcbiAgICByZXR1cm4gcmVtb3ZlO1xuICAgIGZ1bmN0aW9uIHdyYXBwZXIoLi4uYXJncykge1xuICAgICAgICAvLyBJZiB3ZSBoYXZlIGJlZW4gZGVhY3RpdmF0ZWQgYW5kIGFyZSBubyBsb25nZXIgd3JhcHBlZCwgcmVtb3ZlIG91cnNlbHZlc1xuICAgICAgICBpZiAoY3VycmVudCA9PT0gb3JpZ2luYWwgJiYgb2JqW21ldGhvZF0gPT09IHdyYXBwZXIpXG4gICAgICAgICAgICByZW1vdmUoKTtcbiAgICAgICAgcmV0dXJuIGN1cnJlbnQuYXBwbHkodGhpcywgYXJncyk7XG4gICAgfVxuICAgIGZ1bmN0aW9uIHJlbW92ZSgpIHtcbiAgICAgICAgLy8gSWYgbm8gb3RoZXIgcGF0Y2hlcywganVzdCBkbyBhIGRpcmVjdCByZW1vdmFsXG4gICAgICAgIGlmIChvYmpbbWV0aG9kXSA9PT0gd3JhcHBlcikge1xuICAgICAgICAgICAgaWYgKGhhZE93bilcbiAgICAgICAgICAgICAgICBvYmpbbWV0aG9kXSA9IG9yaWdpbmFsO1xuICAgICAgICAgICAgZWxzZVxuICAgICAgICAgICAgICAgIGRlbGV0ZSBvYmpbbWV0aG9kXTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoY3VycmVudCA9PT0gb3JpZ2luYWwpXG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgIC8vIEVsc2UgcGFzcyBmdXR1cmUgY2FsbHMgdGhyb3VnaCwgYW5kIHJlbW92ZSB3cmFwcGVyIGZyb20gdGhlIHByb3RvdHlwZSBjaGFpblxuICAgICAgICBjdXJyZW50ID0gb3JpZ2luYWw7XG4gICAgICAgIE9iamVjdC5zZXRQcm90b3R5cGVPZih3cmFwcGVyLCBvcmlnaW5hbCB8fCBGdW5jdGlvbik7XG4gICAgfVxufVxuZXhwb3J0IGZ1bmN0aW9uIGFmdGVyKHByb21pc2UsIGNiKSB7XG4gICAgcmV0dXJuIHByb21pc2UudGhlbihjYiwgY2IpO1xufVxuZXhwb3J0IGZ1bmN0aW9uIHNlcmlhbGl6ZShhc3luY0Z1bmN0aW9uKSB7XG4gICAgbGV0IGxhc3RSdW4gPSBQcm9taXNlLnJlc29sdmUoKTtcbiAgICBmdW5jdGlvbiB3cmFwcGVyKC4uLmFyZ3MpIHtcbiAgICAgICAgcmV0dXJuIGxhc3RSdW4gPSBuZXcgUHJvbWlzZSgocmVzLCByZWopID0+IHtcbiAgICAgICAgICAgIGFmdGVyKGxhc3RSdW4sICgpID0+IHtcbiAgICAgICAgICAgICAgICBhc3luY0Z1bmN0aW9uLmFwcGx5KHRoaXMsIGFyZ3MpLnRoZW4ocmVzLCByZWopO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH0pO1xuICAgIH1cbiAgICB3cmFwcGVyLmFmdGVyID0gZnVuY3Rpb24gKCkge1xuICAgICAgICByZXR1cm4gbGFzdFJ1biA9IG5ldyBQcm9taXNlKChyZXMsIHJlaikgPT4geyBhZnRlcihsYXN0UnVuLCByZXMpOyB9KTtcbiAgICB9O1xuICAgIHJldHVybiB3cmFwcGVyO1xufVxuIiwiaW1wb3J0IHtQbHVnaW4sIEtleW1hcCwgU2V0dGluZywgTW9kYWwsIGRlYm91bmNlfSBmcm9tIFwib2JzaWRpYW5cIjtcbmltcG9ydCB7YXJvdW5kfSBmcm9tIFwibW9ua2V5LWFyb3VuZFwiO1xuXG5mdW5jdGlvbiBob3RrZXlUb1N0cmluZyhob3RrZXkpIHtcbiAgICByZXR1cm4gS2V5bWFwLmNvbXBpbGVNb2RpZmllcnMoaG90a2V5Lm1vZGlmaWVycykrXCIsXCIgKyBob3RrZXkua2V5LnRvTG93ZXJDYXNlKClcbn1cblxuZnVuY3Rpb24gaXNQbHVnaW5UYWIoaWQpIHtcbiAgICByZXR1cm4gaWQgPT09IFwicGx1Z2luc1wiIHx8IGlkID09PSBcInRoaXJkLXBhcnR5LXBsdWdpbnNcIiB8fCBpZCA9PT0gXCJjb21tdW5pdHktcGx1Z2luc1wiO1xufVxuXG5mdW5jdGlvbiBwbHVnaW5TZXR0aW5nc0FyZU9wZW4oYXBwKSB7XG4gICAgcmV0dXJuIHNldHRpbmdzQXJlT3BlbihhcHApICYmIGlzUGx1Z2luVGFiKGFwcC5zZXR0aW5nLmFjdGl2ZVRhYj8uaWQpXG59XG5cbmZ1bmN0aW9uIHNldHRpbmdzQXJlT3BlbihhcHApIHtcbiAgICByZXR1cm4gYXBwLnNldHRpbmcuY29udGFpbmVyRWwucGFyZW50RWxlbWVudCAhPT0gbnVsbFxufVxuXG5mdW5jdGlvbiBpc1BsdWdpblZpZXdlcihvYikge1xuICAgIHJldHVybiAoXG4gICAgICAgIG9iIGluc3RhbmNlb2YgTW9kYWwgJiZcbiAgICAgICAgb2IuaGFzT3duUHJvcGVydHkoXCJhdXRvbG9hZFwiKSAmJlxuICAgICAgICB0eXBlb2Ygb2Iuc2hvd1BsdWdpbiA9PT0gXCJmdW5jdGlvblwiICYmXG4gICAgICAgIHR5cGVvZiBvYi51cGRhdGVTZWFyY2ggPT09IFwiZnVuY3Rpb25cIiAmJlxuICAgICAgICB0eXBlb2Ygb2Iuc2VhcmNoRWwgPT0gXCJvYmplY3RcIlxuICAgICk7XG59XG5cbmZ1bmN0aW9uIG9uRWxlbWVudChlbCwgZXZlbnQsIHNlbGVjdG9yLCBjYWxsYmFjaywgb3B0aW9ucz1mYWxzZSkge1xuICAgIGVsLm9uKGV2ZW50LCBzZWxlY3RvciwgY2FsbGJhY2ssIG9wdGlvbnMpXG4gICAgcmV0dXJuICgpID0+IGVsLm9mZihldmVudCwgc2VsZWN0b3IsIGNhbGxiYWNrLCBvcHRpb25zKTtcbn1cblxuZXhwb3J0IGRlZmF1bHQgY2xhc3MgSG90a2V5SGVscGVyIGV4dGVuZHMgUGx1Z2luIHtcblxuICAgIG9ubG9hZCgpIHtcbiAgICAgICAgY29uc3Qgd29ya3NwYWNlID0gdGhpcy5hcHAud29ya3NwYWNlO1xuXG4gICAgICAgIHRoaXMucmVnaXN0ZXJFdmVudCggd29ya3NwYWNlLm9uKFwicGx1Z2luLXNldHRpbmdzOmJlZm9yZS1kaXNwbGF5XCIsIChzZXR0aW5nc1RhYiwgdGFiSWQpID0+IHtcbiAgICAgICAgICAgIHRoaXMuaG90a2V5QnV0dG9ucyA9IHt9O1xuICAgICAgICAgICAgdGhpcy5jb25maWdCdXR0b25zID0ge307XG4gICAgICAgICAgICB0aGlzLmdsb2JhbHNBZGRlZCA9IGZhbHNlO1xuICAgICAgICB9KSApO1xuICAgICAgICB0aGlzLnJlZ2lzdGVyRXZlbnQoIHdvcmtzcGFjZS5vbihcInBsdWdpbi1zZXR0aW5nczphZnRlci1kaXNwbGF5XCIsICAoKSA9PiB0aGlzLnJlZnJlc2hCdXR0b25zKHRydWUpKSApO1xuXG4gICAgICAgIHRoaXMucmVnaXN0ZXJFdmVudCggd29ya3NwYWNlLm9uKFwicGx1Z2luLXNldHRpbmdzOnBsdWdpbi1jb250cm9sXCIsIChzZXR0aW5nLCBtYW5pZmVzdCwgZW5hYmxlZCwgdGFiSWQpID0+IHtcbiAgICAgICAgICAgIHRoaXMuZ2xvYmFsc0FkZGVkIHx8IHRoaXMuYWRkR2xvYmFscyh0YWJJZCwgc2V0dGluZy5zZXR0aW5nRWwpO1xuICAgICAgICAgICAgdGhpcy5jcmVhdGVFeHRyYUJ1dHRvbnMoc2V0dGluZywgbWFuaWZlc3QsIGVuYWJsZWQpO1xuICAgICAgICB9KSApO1xuXG4gICAgICAgIC8vIFJlZnJlc2ggdGhlIGJ1dHRvbnMgd2hlbiBjb21tYW5kcyBvciBzZXR0aW5nIHRhYnMgYXJlIGFkZGVkIG9yIHJlbW92ZWRcbiAgICAgICAgY29uc3QgcmVxdWVzdFJlZnJlc2ggPSBkZWJvdW5jZSh0aGlzLnJlZnJlc2hCdXR0b25zLmJpbmQodGhpcyksIDUwLCB0cnVlKTtcbiAgICAgICAgZnVuY3Rpb24gcmVmcmVzaGVyKG9sZCkgeyByZXR1cm4gZnVuY3Rpb24oLi4uYXJncyl7IHJlcXVlc3RSZWZyZXNoKCk7IHJldHVybiBvbGQuYXBwbHkodGhpcywgYXJncyk7IH07IH1cbiAgICAgICAgdGhpcy5yZWdpc3Rlcihhcm91bmQoYXBwLmNvbW1hbmRzLCB7YWRkQ29tbWFuZDogICAgcmVmcmVzaGVyLCByZW1vdmVDb21tYW5kOiAgICByZWZyZXNoZXJ9KSk7XG4gICAgICAgIHRoaXMucmVnaXN0ZXIoYXJvdW5kKGFwcC5zZXR0aW5nLCAge2FkZFBsdWdpblRhYjogIHJlZnJlc2hlciwgcmVtb3ZlUGx1Z2luVGFiOiAgcmVmcmVzaGVyfSkpO1xuICAgICAgICB0aGlzLnJlZ2lzdGVyKGFyb3VuZChhcHAuc2V0dGluZywgIHthZGRTZXR0aW5nVGFiOiByZWZyZXNoZXIsIHJlbW92ZVNldHRpbmdUYWI6IHJlZnJlc2hlcn0pKTtcblxuICAgICAgICB3b3Jrc3BhY2Uub25MYXlvdXRSZWFkeSh0aGlzLndoZW5SZWFkeS5iaW5kKHRoaXMpKTtcbiAgICB9XG5cbiAgICB3aGVuUmVhZHkoKSB7XG4gICAgICAgIGNvbnN0IGFwcCA9IHRoaXMuYXBwO1xuICAgICAgICBjb25zdCBjb3JlUGx1Z2lucyA9IHRoaXMuZ2V0U2V0dGluZ3NUYWIoXCJwbHVnaW5zXCIpO1xuICAgICAgICBjb25zdCBjb21tdW5pdHkgPSB0aGlzLmdldFNldHRpbmdzVGFiKFwidGhpcmQtcGFydHktcGx1Z2luc1wiKSA/PyB0aGlzLmdldFNldHRpbmdzVGFiKFwiY29tbXVuaXR5LXBsdWdpbnNcIik7XG5cbiAgICAgICAgLy8gSG9vayBpbnRvIHRoZSBkaXNwbGF5KCkgbWV0aG9kIG9mIHRoZSBwbHVnaW4gc2V0dGluZ3MgdGFic1xuICAgICAgICBpZiAoY29yZVBsdWdpbnMpIHRoaXMucmVnaXN0ZXIoYXJvdW5kKGNvcmVQbHVnaW5zLCB7ZGlzcGxheTogdGhpcy5hZGRQbHVnaW5TZXR0aW5nRXZlbnRzLmJpbmQodGhpcywgY29yZVBsdWdpbnMuaWQpfSkpO1xuICAgICAgICBpZiAoY29tbXVuaXR5KSAgIHRoaXMucmVnaXN0ZXIoYXJvdW5kKGNvbW11bml0eSwgICB7ZGlzcGxheTogdGhpcy5hZGRQbHVnaW5TZXR0aW5nRXZlbnRzLmJpbmQodGhpcywgY29tbXVuaXR5LmlkKX0pKTtcblxuICAgICAgICAvLyBOb3cgZm9yY2UgYSByZWZyZXNoIGlmIGVpdGhlciBwbHVnaW5zIHRhYiBpcyBjdXJyZW50bHkgdmlzaWJsZSAodG8gc2hvdyBvdXIgbmV3IGJ1dHRvbnMpXG4gICAgICAgIGZ1bmN0aW9uIHJlZnJlc2hUYWJJZk9wZW4oKSB7XG4gICAgICAgICAgICBpZiAocGx1Z2luU2V0dGluZ3NBcmVPcGVuKGFwcCkpIGFwcC5zZXR0aW5nLm9wZW5UYWJCeUlkKGFwcC5zZXR0aW5nLmFjdGl2ZVRhYi5pZCk7XG4gICAgICAgIH1cbiAgICAgICAgcmVmcmVzaFRhYklmT3BlbigpO1xuXG4gICAgICAgIC8vIEFuZCBkbyBpdCBhZ2FpbiBhZnRlciB3ZSB1bmxvYWQgKHRvIHJlbW92ZSB0aGUgb2xkIGJ1dHRvbnMpXG4gICAgICAgIHRoaXMucmVnaXN0ZXIoKCkgPT4gc2V0SW1tZWRpYXRlKHJlZnJlc2hUYWJJZk9wZW4pKTtcblxuICAgICAgICAvLyBUd2VhayB0aGUgaG90a2V5IHNldHRpbmdzIHRhYiB0byBtYWtlIGZpbHRlcmluZyB3b3JrIG9uIGlkIHByZWZpeGVzIGFzIHdlbGwgYXMgY29tbWFuZCBuYW1lc1xuICAgICAgICBjb25zdCBob3RrZXlzVGFiID0gdGhpcy5nZXRTZXR0aW5nc1RhYihcImhvdGtleXNcIik7XG4gICAgICAgIGlmIChob3RrZXlzVGFiKSB7XG4gICAgICAgICAgICB0aGlzLnJlZ2lzdGVyKGFyb3VuZChob3RrZXlzVGFiLCB7XG4gICAgICAgICAgICAgICAgZGlzcGxheShvbGQpIHsgcmV0dXJuIGZ1bmN0aW9uKCkgeyBvbGQuY2FsbCh0aGlzKTsgdGhpcy5zZWFyY2hJbnB1dEVsLmZvY3VzKCk7IH07IH0sXG4gICAgICAgICAgICAgICAgdXBkYXRlSG90a2V5VmlzaWJpbGl0eShvbGQpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGZ1bmN0aW9uKCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgY29uc3Qgb2xkU2VhcmNoID0gdGhpcy5zZWFyY2hJbnB1dEVsLnZhbHVlLCBvbGRDb21tYW5kcyA9IGFwcC5jb21tYW5kcy5jb21tYW5kcztcbiAgICAgICAgICAgICAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKG9sZFNlYXJjaC5lbmRzV2l0aChcIjpcIikgJiYgIW9sZFNlYXJjaC5jb250YWlucyhcIiBcIikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLy8gVGhpcyBpcyBhbiBpbmNyZWRpYmx5IHVnbHkgaGFjayB0aGF0IHJlbGllcyBvbiB1cGRhdGVIb3RrZXlWaXNpYmlsaXR5KCkgaXRlcmF0aW5nIGFwcC5jb21tYW5kcy5jb21tYW5kc1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAvLyBsb29raW5nIGZvciBob3RrZXkgY29uZmxpY3RzICpiZWZvcmUqIGFueXRoaW5nIGVsc2UuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxldCBjdXJyZW50ID0gb2xkQ29tbWFuZHM7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxldCBmaWx0ZXJlZCA9IE9iamVjdC5mcm9tRW50cmllcyhPYmplY3QuZW50cmllcyhhcHAuY29tbWFuZHMuY29tbWFuZHMpLmZpbHRlcihcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIChbaWQsIGNtZF0pID0+IChpZCtcIjpcIikuc3RhcnRzV2l0aChvbGRTZWFyY2gpXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICkpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aGlzLnNlYXJjaElucHV0RWwudmFsdWUgPSBcIlwiO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhcHAuY29tbWFuZHMuY29tbWFuZHMgPSBuZXcgUHJveHkob2xkQ29tbWFuZHMsIHtvd25LZXlzKCl7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAvLyBUaGUgZmlyc3QgdGltZSBjb21tYW5kcyBhcmUgaXRlcmF0ZWQsIHJldHVybiB0aGUgd2hvbGUgdGhpbmc7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAvLyBhZnRlciB0aGF0LCByZXR1cm4gdGhlIGZpbHRlcmVkIGxpc3RcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRyeSB7IHJldHVybiBPYmplY3Qua2V5cyhjdXJyZW50KTsgfSBmaW5hbGx5IHsgY3VycmVudCA9IGZpbHRlcmVkOyB9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH19KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIG9sZC5jYWxsKHRoaXMpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfSBmaW5hbGx5IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aGlzLnNlYXJjaElucHV0RWwudmFsdWUgPSBvbGRTZWFyY2g7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYXBwLmNvbW1hbmRzLmNvbW1hbmRzID0gb2xkQ29tbWFuZHM7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9KSk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBjcmVhdGVFeHRyYUJ1dHRvbnMoc2V0dGluZywgbWFuaWZlc3QsIGVuYWJsZWQpIHtcbiAgICAgICAgc2V0dGluZy5hZGRFeHRyYUJ1dHRvbihidG4gPT4ge1xuICAgICAgICAgICAgYnRuLnNldEljb24oXCJnZWFyXCIpO1xuICAgICAgICAgICAgYnRuLm9uQ2xpY2soKCkgPT4gdGhpcy5zaG93Q29uZmlnRm9yKG1hbmlmZXN0LmlkLnJlcGxhY2UoL153b3Jrc3BhY2UkLyxcImZpbGVcIikpKTtcbiAgICAgICAgICAgIGJ0bi5zZXRUb29sdGlwKFwiT3B0aW9uc1wiKTtcbiAgICAgICAgICAgIGJ0bi5leHRyYVNldHRpbmdzRWwudG9nZ2xlKGVuYWJsZWQpXG4gICAgICAgICAgICB0aGlzLmNvbmZpZ0J1dHRvbnNbbWFuaWZlc3QuaWRdID0gYnRuO1xuICAgICAgICB9KTtcbiAgICAgICAgc2V0dGluZy5hZGRFeHRyYUJ1dHRvbihidG4gPT4ge1xuICAgICAgICAgICAgYnRuLnNldEljb24oXCJhbnkta2V5XCIpO1xuICAgICAgICAgICAgYnRuLm9uQ2xpY2soKCkgPT4gdGhpcy5zaG93SG90a2V5c0ZvcihtYW5pZmVzdC5pZCtcIjpcIikpXG4gICAgICAgICAgICBidG4uZXh0cmFTZXR0aW5nc0VsLnRvZ2dsZShlbmFibGVkKVxuICAgICAgICAgICAgdGhpcy5ob3RrZXlCdXR0b25zW21hbmlmZXN0LmlkXSA9IGJ0bjtcbiAgICAgICAgfSk7XG4gICAgfVxuXG4gICAgLy8gQWRkIHRvcC1sZXZlbCBpdGVtcyAoc2VhcmNoIGFuZCBwc2V1ZG8tcGx1Z2lucylcbiAgICBhZGRHbG9iYWxzKHRhYklkLCBzZXR0aW5nRWwpIHtcbiAgICAgICAgdGhpcy5nbG9iYWxzQWRkZWQgPSB0cnVlO1xuXG4gICAgICAgIC8vIEFkZCBhIHNlYXJjaCBmaWx0ZXIgdG8gc2hyaW5rIHBsdWdpbiBsaXN0XG4gICAgICAgIGNvbnN0IGNvbnRhaW5lckVsID0gc2V0dGluZ0VsLnBhcmVudEVsZW1lbnQ7XG4gICAgICAgIGxldCBpbnB1dEVsO1xuICAgICAgICBpZiAodGFiSWQgIT09IFwicGx1Z2luc1wiKSB7XG4gICAgICAgICAgICAvLyBSZXBsYWNlIHRoZSBidWlsdC1pbiBzZWFyY2ggaGFuZGxlclxuICAgICAgICAgICAgY29uc3Qgb3JpZ2luYWwgPSBpbnB1dEVsID0gY29udGFpbmVyRWwucGFyZW50RWxlbWVudD8uZmluZChcIi5zZWFyY2gtaW5wdXQtY29udGFpbmVyIGlucHV0XCIpXG4gICAgICAgICAgICBpZiAob3JpZ2luYWwpIHtcbiAgICAgICAgICAgICAgICBpbnB1dEVsID0gb3JpZ2luYWwuY2xvbmVOb2RlKCk7XG4gICAgICAgICAgICAgICAgb3JpZ2luYWwucGFyZW50RWxlbWVudC5yZXBsYWNlQ2hpbGQoaW5wdXRFbCwgb3JpZ2luYWwpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIGlucHV0RWwgPSBpbnB1dEVsID8/IGNvbnRhaW5lckVsLmNyZWF0ZURpdihcImhvdGtleS1zZWFyY2gtY29udGFpbmVyXCIpLmNyZWF0ZUVsKFxuICAgICAgICAgICAgXCJpbnB1dFwiLCB7dHlwZTogXCJ0ZXh0XCIsIGF0dHI6IHtwbGFjZWhvbGRlcjpcIkZpbHRlciBwbHVnaW5zLi4uXCIsIHNwZWxsY2hlY2s6IFwiZmFsc2VcIn19XG4gICAgICAgICk7XG4gICAgICAgIGlucHV0RWwuYWRkRXZlbnRMaXN0ZW5lcihcImlucHV0XCIsIGZ1bmN0aW9uKCl7XG4gICAgICAgICAgICBjb25zdCBmaW5kID0gaW5wdXRFbC52YWx1ZS50b0xvd2VyQ2FzZSgpO1xuICAgICAgICAgICAgZnVuY3Rpb24gbWF0Y2hBbmRIaWdobGlnaHQoZWwpIHtcbiAgICAgICAgICAgICAgICBjb25zdCB0ZXh0ID0gZWwudGV4dENvbnRlbnQgPSBlbC50ZXh0Q29udGVudDsgLy8gY2xlYXIgcHJldmlvdXMgaGlnaGxpZ2h0aW5nLCBpZiBhbnlcbiAgICAgICAgICAgICAgICBjb25zdCBpbmRleCA9IHRleHQudG9Mb3dlckNhc2UoKS5pbmRleE9mKGZpbmQpO1xuICAgICAgICAgICAgICAgIGlmICghfmluZGV4KSByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICAgICAgZWwudGV4dENvbnRlbnQgPSB0ZXh0LnN1YnN0cigwLCBpbmRleCk7XG4gICAgICAgICAgICAgICAgZWwuY3JlYXRlU3BhbihcInN1Z2dlc3Rpb24taGlnaGxpZ2h0XCIpLnRleHRDb250ZW50ID0gdGV4dC5zdWJzdHIoaW5kZXgsIGZpbmQubGVuZ3RoKTtcbiAgICAgICAgICAgICAgICBlbC5pbnNlcnRBZGphY2VudFRleHQoXCJiZWZvcmVlbmRcIiwgdGV4dC5zdWJzdHIoaW5kZXgrZmluZC5sZW5ndGgpKVxuICAgICAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY29udGFpbmVyRWwuZmluZEFsbChcIi5zZXR0aW5nLWl0ZW1cIikuZm9yRWFjaChlID0+IHtcbiAgICAgICAgICAgICAgICBjb25zdCBuYW1lTWF0Y2hlcyA9IG1hdGNoQW5kSGlnaGxpZ2h0KGUuZmluZChcIi5zZXR0aW5nLWl0ZW0tbmFtZVwiKSk7XG4gICAgICAgICAgICAgICAgY29uc3QgZGVzY01hdGNoZXMgPSBtYXRjaEFuZEhpZ2hsaWdodChcbiAgICAgICAgICAgICAgICAgICAgZS5maW5kKFwiLnNldHRpbmctaXRlbS1kZXNjcmlwdGlvbiA+IGRpdjpsYXN0LWNoaWxkXCIpID8/XG4gICAgICAgICAgICAgICAgICAgIGUuZmluZChcIi5zZXR0aW5nLWl0ZW0tZGVzY3JpcHRpb25cIilcbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIGUudG9nZ2xlKG5hbWVNYXRjaGVzIHx8IGRlc2NNYXRjaGVzKTtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9KTtcbiAgICAgICAgc2V0SW1tZWRpYXRlKCgpID0+IHtpbnB1dEVsLmZvY3VzKCl9KTtcbiAgICAgICAgY29udGFpbmVyRWwuYXBwZW5kKHNldHRpbmdFbCk7XG5cbiAgICAgICAgaWYgKHRhYklkID09PSBcInBsdWdpbnNcIikge1xuICAgICAgICAgICAgY29uc3QgZWRpdG9yTmFtZSAgICA9IHRoaXMuZ2V0U2V0dGluZ3NUYWIoXCJlZGl0b3JcIik/Lm5hbWUgfHwgXCJFZGl0b3JcIjtcbiAgICAgICAgICAgIGNvbnN0IHdvcmtzcGFjZU5hbWUgPSB0aGlzLmdldFNldHRpbmdzVGFiKFwiZmlsZVwiKT8ubmFtZSAgIHx8IFwiRmlsZXMgJiBMaW5rc1wiO1xuICAgICAgICAgICAgdGhpcy5jcmVhdGVFeHRyYUJ1dHRvbnMoXG4gICAgICAgICAgICAgICAgbmV3IFNldHRpbmcoc2V0dGluZ0VsLnBhcmVudEVsZW1lbnQpXG4gICAgICAgICAgICAgICAgICAgIC5zZXROYW1lKFwiQXBwXCIpLnNldERlc2MoXCJNaXNjZWxsYW5lb3VzIGFwcGxpY2F0aW9uIGNvbW1hbmRzIChhbHdheXMgZW5hYmxlZClcIiksXG4gICAgICAgICAgICAgICAge2lkOiBcImFwcFwiLCBuYW1lOiBcIkFwcFwifSwgdHJ1ZVxuICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIHRoaXMuY3JlYXRlRXh0cmFCdXR0b25zKFxuICAgICAgICAgICAgICAgIG5ldyBTZXR0aW5nKHNldHRpbmdFbC5wYXJlbnRFbGVtZW50KVxuICAgICAgICAgICAgICAgICAgICAuc2V0TmFtZShlZGl0b3JOYW1lKS5zZXREZXNjKFwiQ29yZSBlZGl0aW5nIGNvbW1hbmRzIChhbHdheXMgZW5hYmxlZClcIiksXG4gICAgICAgICAgICAgICAge2lkOiBcImVkaXRvclwiLCBuYW1lOiBlZGl0b3JOYW1lfSwgdHJ1ZVxuICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIHRoaXMuY3JlYXRlRXh0cmFCdXR0b25zKFxuICAgICAgICAgICAgICAgIG5ldyBTZXR0aW5nKHNldHRpbmdFbC5wYXJlbnRFbGVtZW50KVxuICAgICAgICAgICAgICAgICAgICAuc2V0TmFtZSh3b3Jrc3BhY2VOYW1lKS5zZXREZXNjKFwiQ29yZSBmaWxlIGFuZCBwYW5lIG1hbmFnZW1lbnQgY29tbWFuZHMgKGFsd2F5cyBlbmFibGVkKVwiKSxcbiAgICAgICAgICAgICAgICB7aWQ6IFwid29ya3NwYWNlXCIsIG5hbWU6IHdvcmtzcGFjZU5hbWV9LCB0cnVlXG4gICAgICAgICAgICApO1xuICAgICAgICAgICAgc2V0dGluZ0VsLnBhcmVudEVsZW1lbnQuYXBwZW5kKHNldHRpbmdFbCk7XG4gICAgICAgIH1cblxuICAgIH1cblxuICAgIGdldFNldHRpbmdzVGFiKGlkKSB7IHJldHVybiB0aGlzLmFwcC5zZXR0aW5nLnNldHRpbmdUYWJzLmZpbHRlcih0ID0+IHQuaWQgPT09IGlkKS5zaGlmdCgpOyB9XG5cbiAgICBhZGRQbHVnaW5TZXR0aW5nRXZlbnRzKHRhYklkLCBvbGQpIHtcbiAgICAgICAgY29uc3QgYXBwID0gdGhpcy5hcHA7XG4gICAgICAgIGxldCBpbl9ldmVudCA9IGZhbHNlO1xuXG4gICAgICAgIGZ1bmN0aW9uIHRyaWdnZXIoLi4uYXJncykge1xuICAgICAgICAgICAgaW5fZXZlbnQgPSB0cnVlO1xuICAgICAgICAgICAgdHJ5IHsgYXBwLndvcmtzcGFjZS50cmlnZ2VyKC4uLmFyZ3MpOyB9IGNhdGNoKGUpIHsgY29uc29sZS5lcnJvcihlKTsgfVxuICAgICAgICAgICAgaW5fZXZlbnQgPSBmYWxzZTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIFdyYXBwZXIgdG8gYWRkIHBsdWdpbi1zZXR0aW5ncyBldmVudHNcbiAgICAgICAgcmV0dXJuIGZ1bmN0aW9uIGRpc3BsYXkoLi4uYXJncykge1xuICAgICAgICAgICAgaWYgKGluX2V2ZW50KSByZXR1cm47XG4gICAgICAgICAgICB0cmlnZ2VyKFwicGx1Z2luLXNldHRpbmdzOmJlZm9yZS1kaXNwbGF5XCIsIHRoaXMsIHRhYklkKTtcblxuICAgICAgICAgICAgLy8gVHJhY2sgd2hpY2ggcGx1Z2luIGVhY2ggc2V0dGluZyBpcyBmb3JcbiAgICAgICAgICAgIGxldCBtYW5pZmVzdHM7XG4gICAgICAgICAgICBpZiAodGFiSWQgPT09IFwicGx1Z2luc1wiKSB7XG4gICAgICAgICAgICAgICAgbWFuaWZlc3RzID0gT2JqZWN0LmVudHJpZXMoYXBwLmludGVybmFsUGx1Z2lucy5wbHVnaW5zKS5tYXAoXG4gICAgICAgICAgICAgICAgICAgIChbaWQsIHtpbnN0YW5jZToge25hbWV9LCBfbG9hZGVkOmVuYWJsZWR9XSkgPT4ge3JldHVybiB7aWQsIG5hbWUsIGVuYWJsZWR9O31cbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBtYW5pZmVzdHMgPSBPYmplY3QudmFsdWVzKGFwcC5wbHVnaW5zLm1hbmlmZXN0cyk7XG4gICAgICAgICAgICAgICAgbWFuaWZlc3RzLnNvcnQoKGUsIHQpID0+IGUubmFtZS5sb2NhbGVDb21wYXJlKHQubmFtZSkpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgbGV0IHdoaWNoID0gMDtcblxuICAgICAgICAgICAgLy8gVHJhcCB0aGUgYWRkaXRpb24gb2YgdGhlIFwidW5pbnN0YWxsXCIgYnV0dG9ucyBuZXh0IHRvIGVhY2ggcGx1Z2luXG4gICAgICAgICAgICBjb25zdCByZW1vdmUgPSBhcm91bmQoU2V0dGluZy5wcm90b3R5cGUsIHtcbiAgICAgICAgICAgICAgICBhZGRUb2dnbGUob2xkKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBmdW5jdGlvbiguLi5hcmdzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAodGFiSWQgPT09IFwicGx1Z2luc1wiICYmICFpbl9ldmVudCAmJiAobWFuaWZlc3RzW3doaWNoXXx8e30pLm5hbWUgPT09IHRoaXMubmFtZUVsLnRleHRDb250ZW50ICkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IG1hbmlmZXN0ID0gbWFuaWZlc3RzW3doaWNoKytdO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRyaWdnZXIoXCJwbHVnaW4tc2V0dGluZ3M6cGx1Z2luLWNvbnRyb2xcIiwgdGhpcywgbWFuaWZlc3QsIG1hbmlmZXN0LmVuYWJsZWQsIHRhYklkKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiBvbGQuYXBwbHkodGhpcywgYXJncyk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgIGFkZEV4dHJhQnV0dG9uKG9sZCkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gZnVuY3Rpb24oLi4uYXJncykge1xuICAgICAgICAgICAgICAgICAgICAgICAgLy8gVGhlIG9ubHkgXCJleHRyYXNcIiBhZGRlZCB0byBzZXR0aW5ncyB3L2EgZGVzY3JpcHRpb24gYXJlIG9uIHRoZSBwbHVnaW5zLCBjdXJyZW50bHksXG4gICAgICAgICAgICAgICAgICAgICAgICAvLyBzbyBvbmx5IHRyeSB0byBtYXRjaCB0aG9zZSB0byBwbHVnaW4gbmFtZXNcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICh0YWJJZCAhPT0gXCJwbHVnaW5zXCIgJiYgdGhpcy5kZXNjRWwuY2hpbGRFbGVtZW50Q291bnQgJiYgIWluX2V2ZW50KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCAobWFuaWZlc3RzW3doaWNoXXx8e30pLm5hbWUgPT09IHRoaXMubmFtZUVsLnRleHRDb250ZW50ICkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBtYW5pZmVzdCA9IG1hbmlmZXN0c1t3aGljaCsrXSwgZW5hYmxlZCA9ICEhYXBwLnBsdWdpbnMucGx1Z2luc1ttYW5pZmVzdC5pZF07XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRyaWdnZXIoXCJwbHVnaW4tc2V0dGluZ3M6cGx1Z2luLWNvbnRyb2xcIiwgdGhpcywgbWFuaWZlc3QsIGVuYWJsZWQsIHRhYklkKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIG9sZC5hcHBseSh0aGlzLCBhcmdzKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgIHJldHVybiBvbGQuYXBwbHkodGhpcywgYXJncyk7XG4gICAgICAgICAgICB9IGZpbmFsbHkge1xuICAgICAgICAgICAgICAgIHJlbW92ZSgpO1xuICAgICAgICAgICAgICAgIHRyaWdnZXIoXCJwbHVnaW4tc2V0dGluZ3M6YWZ0ZXItZGlzcGxheVwiLCB0aGlzKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH1cblxuICAgIHNob3dIb3RrZXlzRm9yKHNlYXJjaCkge1xuICAgICAgICB0aGlzLmFwcC5zZXR0aW5nLm9wZW5UYWJCeUlkKFwiaG90a2V5c1wiKTtcbiAgICAgICAgY29uc3QgdGFiID0gdGhpcy5hcHAuc2V0dGluZy5hY3RpdmVUYWI7XG4gICAgICAgIGlmICh0YWIgJiYgdGFiLnNlYXJjaElucHV0RWwgJiYgdGFiLnVwZGF0ZUhvdGtleVZpc2liaWxpdHkpIHtcbiAgICAgICAgICAgIHRhYi5zZWFyY2hJbnB1dEVsLnZhbHVlID0gc2VhcmNoO1xuICAgICAgICAgICAgdGFiLnVwZGF0ZUhvdGtleVZpc2liaWxpdHkoKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIHNob3dDb25maWdGb3IoaWQpIHtcbiAgICAgICAgdGhpcy5hcHAuc2V0dGluZy5vcGVuVGFiQnlJZChpZCk7XG4gICAgICAgIGlmICh0aGlzLmFwcC5zZXR0aW5nLmFjdGl2ZVRhYj8uaWQgPT09IGlkKSByZXR1cm4gdHJ1ZTtcbiAgICAgICAgbmV3IE5vdGljZShcbiAgICAgICAgICAgIGBObyBzZXR0aW5ncyB0YWIgZm9yIFwiJHtpZH1cIjogaXQgbWF5IG5vdCBiZSBpbnN0YWxsZWQgb3IgbWlnaHQgbm90IGhhdmUgc2V0dGluZ3MuYFxuICAgICAgICApO1xuICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuXG4gICAgcGx1Z2luRW5hYmxlZChpZCkge1xuICAgICAgICByZXR1cm4gdGhpcy5hcHAuaW50ZXJuYWxQbHVnaW5zLnBsdWdpbnNbaWRdPy5fbG9hZGVkIHx8IHRoaXMuYXBwLnBsdWdpbnMucGx1Z2luc1tpZF07XG4gICAgfVxuXG4gICAgcmVmcmVzaEJ1dHRvbnMoZm9yY2U9ZmFsc2UpIHtcbiAgICAgICAgLy8gRG9uJ3QgcmVmcmVzaCB3aGVuIG5vdCBkaXNwbGF5aW5nLCB1bmxlc3MgcmVuZGVyaW5nIGlzIGluIHByb2dyZXNzXG4gICAgICAgIGlmICghcGx1Z2luU2V0dGluZ3NBcmVPcGVuKHRoaXMuYXBwKSAmJiAhZm9yY2UpIHJldHVybjtcblxuICAgICAgICBjb25zdCBoa20gPSB0aGlzLmFwcC5ob3RrZXlNYW5hZ2VyO1xuICAgICAgICBjb25zdCBhc3NpZ25lZEtleUNvdW50ID0ge307XG5cbiAgICAgICAgLy8gR2V0IGEgbGlzdCBvZiBjb21tYW5kcyBieSBwbHVnaW5cbiAgICAgICAgY29uc3QgY29tbWFuZHMgPSBPYmplY3QudmFsdWVzKHRoaXMuYXBwLmNvbW1hbmRzLmNvbW1hbmRzKS5yZWR1Y2UoKGNtZHMsIGNtZCk9PntcbiAgICAgICAgICAgIGNvbnN0IHBpZCA9IGNtZC5pZC5zcGxpdChcIjpcIiwyKS5zaGlmdCgpO1xuICAgICAgICAgICAgY29uc3QgaG90a2V5cyA9IChoa20uZ2V0SG90a2V5cyhjbWQuaWQpIHx8IGhrbS5nZXREZWZhdWx0SG90a2V5cyhjbWQuaWQpIHx8IFtdKS5tYXAoaG90a2V5VG9TdHJpbmcpO1xuICAgICAgICAgICAgaG90a2V5cy5mb3JFYWNoKGsgPT4gYXNzaWduZWRLZXlDb3VudFtrXSA9IDEgKyAoYXNzaWduZWRLZXlDb3VudFtrXXx8MCkpO1xuICAgICAgICAgICAgKGNtZHNbcGlkXSB8fCAoY21kc1twaWRdPVtdKSkucHVzaCh7aG90a2V5cywgY21kfSk7XG4gICAgICAgICAgICByZXR1cm4gY21kcztcbiAgICAgICAgfSwge30pO1xuXG4gICAgICAgIC8vIFBsdWdpbiBzZXR0aW5nIHRhYnMgYnkgcGx1Z2luXG4gICAgICAgIGNvbnN0IHRhYnMgPSBPYmplY3QudmFsdWVzKHRoaXMuYXBwLnNldHRpbmcucGx1Z2luVGFicykucmVkdWNlKCh0YWJzLCB0YWIpPT4ge1xuICAgICAgICAgICAgdGFic1t0YWIuaWRdID0gdGFiOyByZXR1cm4gdGFic1xuICAgICAgICB9LCB7fSk7XG4gICAgICAgIHRhYnNbXCJ3b3Jrc3BhY2VcIl0gPSB0YWJzW1wiZWRpdG9yXCJdID0gdHJ1ZTtcblxuICAgICAgICBmb3IoY29uc3QgaWQgb2YgT2JqZWN0LmtleXModGhpcy5jb25maWdCdXR0b25zIHx8IHt9KSkge1xuICAgICAgICAgICAgY29uc3QgYnRuID0gdGhpcy5jb25maWdCdXR0b25zW2lkXTtcbiAgICAgICAgICAgIGlmICghdGFic1tpZF0pIHtcbiAgICAgICAgICAgICAgICBidG4uZXh0cmFTZXR0aW5nc0VsLmhpZGUoKTtcbiAgICAgICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGJ0bi5leHRyYVNldHRpbmdzRWwuc2hvdygpO1xuICAgICAgICB9XG5cbiAgICAgICAgZm9yKGNvbnN0IGlkIG9mIE9iamVjdC5rZXlzKHRoaXMuaG90a2V5QnV0dG9ucyB8fCB7fSkpIHtcbiAgICAgICAgICAgIGNvbnN0IGJ0biA9IHRoaXMuaG90a2V5QnV0dG9uc1tpZF07XG4gICAgICAgICAgICBpZiAoIWNvbW1hbmRzW2lkXSkge1xuICAgICAgICAgICAgICAgIC8vIFBsdWdpbiBpcyBkaXNhYmxlZCBvciBoYXMgbm8gY29tbWFuZHNcbiAgICAgICAgICAgICAgICBidG4uZXh0cmFTZXR0aW5nc0VsLmhpZGUoKTtcbiAgICAgICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNvbnN0IGFzc2lnbmVkID0gY29tbWFuZHNbaWRdLmZpbHRlcihpbmZvID0+IGluZm8uaG90a2V5cy5sZW5ndGgpO1xuICAgICAgICAgICAgY29uc3QgY29uZmxpY3RzID0gYXNzaWduZWQuZmlsdGVyKGluZm8gPT4gaW5mby5ob3RrZXlzLmZpbHRlcihrID0+IGFzc2lnbmVkS2V5Q291bnRba10+MSkubGVuZ3RoKS5sZW5ndGg7XG5cbiAgICAgICAgICAgIGJ0bi5zZXRUb29sdGlwKFxuICAgICAgICAgICAgICAgIGBDb25maWd1cmUgaG90a2V5cyR7XCJcXG5cIn0oJHthc3NpZ25lZC5sZW5ndGh9LyR7Y29tbWFuZHNbaWRdLmxlbmd0aH0gYXNzaWduZWQke1xuICAgICAgICAgICAgICAgICAgICBjb25mbGljdHMgPyBcIjsgXCIrY29uZmxpY3RzK1wiIGNvbmZsaWN0aW5nXCIgOiBcIlwiXG4gICAgICAgICAgICAgICAgfSlgXG4gICAgICAgICAgICApO1xuICAgICAgICAgICAgYnRuLmV4dHJhU2V0dGluZ3NFbC50b2dnbGVDbGFzcyhcIm1vZC1lcnJvclwiLCAhIWNvbmZsaWN0cyk7XG4gICAgICAgICAgICBidG4uZXh0cmFTZXR0aW5nc0VsLnNob3coKTtcbiAgICAgICAgfVxuICAgIH1cbn1cbiJdLCJuYW1lcyI6WyJLZXltYXAiLCJQbHVnaW4iLCJkZWJvdW5jZSIsIlNldHRpbmciXSwibWFwcGluZ3MiOiI7Ozs7QUFBTyxTQUFTLE1BQU0sQ0FBQyxHQUFHLEVBQUUsU0FBUyxFQUFFO0FBQ3ZDLElBQUksTUFBTSxRQUFRLEdBQUcsTUFBTSxDQUFDLElBQUksQ0FBQyxTQUFTLENBQUMsQ0FBQyxHQUFHLENBQUMsR0FBRyxJQUFJLE9BQU8sQ0FBQyxHQUFHLEVBQUUsR0FBRyxFQUFFLFNBQVMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDMUYsSUFBSSxPQUFPLFFBQVEsQ0FBQyxNQUFNLEtBQUssQ0FBQyxHQUFHLFFBQVEsQ0FBQyxDQUFDLENBQUMsR0FBRyxZQUFZLEVBQUUsUUFBUSxDQUFDLE9BQU8sQ0FBQyxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUMsQ0FBQyxFQUFFLENBQUM7QUFDN0YsQ0FBQztBQUNELFNBQVMsT0FBTyxDQUFDLEdBQUcsRUFBRSxNQUFNLEVBQUUsYUFBYSxFQUFFO0FBQzdDLElBQUksTUFBTSxRQUFRLEdBQUcsR0FBRyxDQUFDLE1BQU0sQ0FBQyxFQUFFLE1BQU0sR0FBRyxHQUFHLENBQUMsY0FBYyxDQUFDLE1BQU0sQ0FBQyxDQUFDO0FBQ3RFLElBQUksSUFBSSxPQUFPLEdBQUcsYUFBYSxDQUFDLFFBQVEsQ0FBQyxDQUFDO0FBQzFDO0FBQ0E7QUFDQSxJQUFJLElBQUksUUFBUTtBQUNoQixRQUFRLE1BQU0sQ0FBQyxjQUFjLENBQUMsT0FBTyxFQUFFLFFBQVEsQ0FBQyxDQUFDO0FBQ2pELElBQUksTUFBTSxDQUFDLGNBQWMsQ0FBQyxPQUFPLEVBQUUs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
