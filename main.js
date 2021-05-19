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
function after(promise, cb) {
    return promise.then(cb, cb);
}
function serialize(asyncFunction) {
    let lastRun = Promise.resolve();
    function wrapper(...args) {
        return lastRun = new Promise((res, rej) => {
            after(lastRun, () => {
                asyncFunction.apply(this, args).then(res, rej);
            });
        });
    }
    wrapper.after = function () {
        return lastRun = new Promise((res, rej) => { after(lastRun, res); });
    };
    return wrapper;
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
        this.lastSearch = {};   // last search used, indexed by tab

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
        });
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
        let searchEl;
        if (tabId !== "plugins") {
            // Replace the built-in search handler
            (searchEl = this.searchInput)?.onChange(changeHandler);
        } else {
            const tmp = new obsidian.Setting(containerEl).addSearch(s => {
                searchEl = s;
                s.setPlaceholder("Filter plugins...").onChange(changeHandler);
            });
            searchEl.containerEl.style.margin = 0;
            containerEl.createDiv("hotkey-search-container").append(searchEl.containerEl);
            tmp.settingEl.detach();
        }
        const plugin = this;
        function changeHandler(seek){
            const find = (plugin.lastSearch[tabId] = seek).toLowerCase();
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
        setImmediate(() => {
            if (!searchEl) return
            if (searchEl && typeof plugin.lastSearch[tabId] === "string") {
                searchEl.setValue(plugin.lastSearch[tabId]);
                searchEl.onChanged();
            }
            if (!obsidian.Platform.isMobile) searchEl.inputEl.select();
        });
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
                        setImmediate(() => {
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
                    if (id) this.autoload = id;
                    return old.apply(this, args);
                }
            }
        });
        this.app.setting.activeTab.containerEl.find(".mod-cta").click();
        // XXX handle nav to not-cataloged plugin
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWFpbi5qcyIsInNvdXJjZXMiOlsiLnlhcm4vY2FjaGUvbW9ua2V5LWFyb3VuZC1ucG0tMi4xLjAtNzBkZjMyZDJhYy0xYmQ3MmQyNWY5LnppcC9ub2RlX21vZHVsZXMvbW9ua2V5LWFyb3VuZC9tanMvaW5kZXguanMiLCJzcmMvcGx1Z2luLmpzIl0sInNvdXJjZXNDb250ZW50IjpbImV4cG9ydCBmdW5jdGlvbiBhcm91bmQob2JqLCBmYWN0b3JpZXMpIHtcbiAgICBjb25zdCByZW1vdmVycyA9IE9iamVjdC5rZXlzKGZhY3RvcmllcykubWFwKGtleSA9PiBhcm91bmQxKG9iaiwga2V5LCBmYWN0b3JpZXNba2V5XSkpO1xuICAgIHJldHVybiByZW1vdmVycy5sZW5ndGggPT09IDEgPyByZW1vdmVyc1swXSA6IGZ1bmN0aW9uICgpIHsgcmVtb3ZlcnMuZm9yRWFjaChyID0+IHIoKSk7IH07XG59XG5mdW5jdGlvbiBhcm91bmQxKG9iaiwgbWV0aG9kLCBjcmVhdGVXcmFwcGVyKSB7XG4gICAgY29uc3Qgb3JpZ2luYWwgPSBvYmpbbWV0aG9kXSwgaGFkT3duID0gb2JqLmhhc093blByb3BlcnR5KG1ldGhvZCk7XG4gICAgbGV0IGN1cnJlbnQgPSBjcmVhdGVXcmFwcGVyKG9yaWdpbmFsKTtcbiAgICAvLyBMZXQgb3VyIHdyYXBwZXIgaW5oZXJpdCBzdGF0aWMgcHJvcHMgZnJvbSB0aGUgd3JhcHBpbmcgbWV0aG9kLFxuICAgIC8vIGFuZCB0aGUgd3JhcHBpbmcgbWV0aG9kLCBwcm9wcyBmcm9tIHRoZSBvcmlnaW5hbCBtZXRob2RcbiAgICBpZiAob3JpZ2luYWwpXG4gICAgICAgIE9iamVjdC5zZXRQcm90b3R5cGVPZihjdXJyZW50LCBvcmlnaW5hbCk7XG4gICAgT2JqZWN0LnNldFByb3RvdHlwZU9mKHdyYXBwZXIsIGN1cnJlbnQpO1xuICAgIG9ialttZXRob2RdID0gd3JhcHBlcjtcbiAgICAvLyBSZXR1cm4gYSBjYWxsYmFjayB0byBhbGxvdyBzYWZlIHJlbW92YWxcbiAgICByZXR1cm4gcmVtb3ZlO1xuICAgIGZ1bmN0aW9uIHdyYXBwZXIoLi4uYXJncykge1xuICAgICAgICAvLyBJZiB3ZSBoYXZlIGJlZW4gZGVhY3RpdmF0ZWQgYW5kIGFyZSBubyBsb25nZXIgd3JhcHBlZCwgcmVtb3ZlIG91cnNlbHZlc1xuICAgICAgICBpZiAoY3VycmVudCA9PT0gb3JpZ2luYWwgJiYgb2JqW21ldGhvZF0gPT09IHdyYXBwZXIpXG4gICAgICAgICAgICByZW1vdmUoKTtcbiAgICAgICAgcmV0dXJuIGN1cnJlbnQuYXBwbHkodGhpcywgYXJncyk7XG4gICAgfVxuICAgIGZ1bmN0aW9uIHJlbW92ZSgpIHtcbiAgICAgICAgLy8gSWYgbm8gb3RoZXIgcGF0Y2hlcywganVzdCBkbyBhIGRpcmVjdCByZW1vdmFsXG4gICAgICAgIGlmIChvYmpbbWV0aG9kXSA9PT0gd3JhcHBlcikge1xuICAgICAgICAgICAgaWYgKGhhZE93bilcbiAgICAgICAgICAgICAgICBvYmpbbWV0aG9kXSA9IG9yaWdpbmFsO1xuICAgICAgICAgICAgZWxzZVxuICAgICAgICAgICAgICAgIGRlbGV0ZSBvYmpbbWV0aG9kXTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoY3VycmVudCA9PT0gb3JpZ2luYWwpXG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgIC8vIEVsc2UgcGFzcyBmdXR1cmUgY2FsbHMgdGhyb3VnaCwgYW5kIHJlbW92ZSB3cmFwcGVyIGZyb20gdGhlIHByb3RvdHlwZSBjaGFpblxuICAgICAgICBjdXJyZW50ID0gb3JpZ2luYWw7XG4gICAgICAgIE9iamVjdC5zZXRQcm90b3R5cGVPZih3cmFwcGVyLCBvcmlnaW5hbCB8fCBGdW5jdGlvbik7XG4gICAgfVxufVxuZXhwb3J0IGZ1bmN0aW9uIGFmdGVyKHByb21pc2UsIGNiKSB7XG4gICAgcmV0dXJuIHByb21pc2UudGhlbihjYiwgY2IpO1xufVxuZXhwb3J0IGZ1bmN0aW9uIHNlcmlhbGl6ZShhc3luY0Z1bmN0aW9uKSB7XG4gICAgbGV0IGxhc3RSdW4gPSBQcm9taXNlLnJlc29sdmUoKTtcbiAgICBmdW5jdGlvbiB3cmFwcGVyKC4uLmFyZ3MpIHtcbiAgICAgICAgcmV0dXJuIGxhc3RSdW4gPSBuZXcgUHJvbWlzZSgocmVzLCByZWopID0+IHtcbiAgICAgICAgICAgIGFmdGVyKGxhc3RSdW4sICgpID0+IHtcbiAgICAgICAgICAgICAgICBhc3luY0Z1bmN0aW9uLmFwcGx5KHRoaXMsIGFyZ3MpLnRoZW4ocmVzLCByZWopO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH0pO1xuICAgIH1cbiAgICB3cmFwcGVyLmFmdGVyID0gZnVuY3Rpb24gKCkge1xuICAgICAgICByZXR1cm4gbGFzdFJ1biA9IG5ldyBQcm9taXNlKChyZXMsIHJlaikgPT4geyBhZnRlcihsYXN0UnVuLCByZXMpOyB9KTtcbiAgICB9O1xuICAgIHJldHVybiB3cmFwcGVyO1xufVxuIiwiaW1wb3J0IHtQbHVnaW4sIFBsYXRmb3JtLCBLZXltYXAsIFNldHRpbmcsIE1vZGFsLCBkZWJvdW5jZX0gZnJvbSBcIm9ic2lkaWFuXCI7XG5pbXBvcnQge2Fyb3VuZCwgc2VyaWFsaXplfSBmcm9tIFwibW9ua2V5LWFyb3VuZFwiO1xuXG5mdW5jdGlvbiBob3RrZXlUb1N0cmluZyhob3RrZXkpIHtcbiAgICByZXR1cm4gS2V5bWFwLmNvbXBpbGVNb2RpZmllcnMoaG90a2V5Lm1vZGlmaWVycykrXCIsXCIgKyBob3RrZXkua2V5LnRvTG93ZXJDYXNlKClcbn1cblxuZnVuY3Rpb24gaXNQbHVnaW5UYWIoaWQpIHtcbiAgICByZXR1cm4gaWQgPT09IFwicGx1Z2luc1wiIHx8IGlkID09PSBcImNvbW11bml0eS1wbHVnaW5zXCI7XG59XG5cbmZ1bmN0aW9uIHBsdWdpblNldHRpbmdzQXJlT3BlbihhcHApIHtcbiAgICByZXR1cm4gc2V0dGluZ3NBcmVPcGVuKGFwcCkgJiYgaXNQbHVnaW5UYWIoYXBwLnNldHRpbmcuYWN0aXZlVGFiPy5pZClcbn1cblxuZnVuY3Rpb24gc2V0dGluZ3NBcmVPcGVuKGFwcCkge1xuICAgIHJldHVybiBhcHAuc2V0dGluZy5jb250YWluZXJFbC5wYXJlbnRFbGVtZW50ICE9PSBudWxsXG59XG5cbmZ1bmN0aW9uIGlzUGx1Z2luVmlld2VyKG9iKSB7XG4gICAgcmV0dXJuIChcbiAgICAgICAgb2IgaW5zdGFuY2VvZiBNb2RhbCAmJlxuICAgICAgICBvYi5oYXNPd25Qcm9wZXJ0eShcImF1dG9sb2FkXCIpICYmXG4gICAgICAgIHR5cGVvZiBvYi5zaG93UGx1Z2luID09PSBcImZ1bmN0aW9uXCIgJiZcbiAgICAgICAgdHlwZW9mIG9iLnVwZGF0ZVNlYXJjaCA9PT0gXCJmdW5jdGlvblwiICYmXG4gICAgICAgIHR5cGVvZiBvYi5zZWFyY2hFbCA9PSBcIm9iamVjdFwiXG4gICAgKTtcbn1cblxuZnVuY3Rpb24gb25FbGVtZW50KGVsLCBldmVudCwgc2VsZWN0b3IsIGNhbGxiYWNrLCBvcHRpb25zPWZhbHNlKSB7XG4gICAgZWwub24oZXZlbnQsIHNlbGVjdG9yLCBjYWxsYmFjaywgb3B0aW9ucylcbiAgICByZXR1cm4gKCkgPT4gZWwub2ZmKGV2ZW50LCBzZWxlY3RvciwgY2FsbGJhY2ssIG9wdGlvbnMpO1xufVxuXG5leHBvcnQgZGVmYXVsdCBjbGFzcyBIb3RrZXlIZWxwZXIgZXh0ZW5kcyBQbHVnaW4ge1xuXG4gICAgb25sb2FkKCkge1xuICAgICAgICBjb25zdCB3b3Jrc3BhY2UgPSB0aGlzLmFwcC53b3Jrc3BhY2UsIHBsdWdpbiA9IHRoaXM7XG4gICAgICAgIHRoaXMubGFzdFNlYXJjaCA9IHt9OyAgIC8vIGxhc3Qgc2VhcmNoIHVzZWQsIGluZGV4ZWQgYnkgdGFiXG5cbiAgICAgICAgdGhpcy5yZWdpc3RlckV2ZW50KCB3b3Jrc3BhY2Uub24oXCJwbHVnaW4tc2V0dGluZ3M6YmVmb3JlLWRpc3BsYXlcIiwgKHNldHRpbmdzVGFiLCB0YWJJZCkgPT4ge1xuICAgICAgICAgICAgdGhpcy5ob3RrZXlCdXR0b25zID0ge307XG4gICAgICAgICAgICB0aGlzLmNvbmZpZ0J1dHRvbnMgPSB7fTtcbiAgICAgICAgICAgIHRoaXMuZ2xvYmFsc0FkZGVkID0gZmFsc2U7XG4gICAgICAgICAgICB0aGlzLnNlYXJjaElucHV0ID0gbnVsbDtcbiAgICAgICAgICAgIGNvbnN0IHJlbW92ZSA9IGFyb3VuZChTZXR0aW5nLnByb3RvdHlwZSwge1xuICAgICAgICAgICAgICAgIGFkZFNlYXJjaChvbGQpIHsgcmV0dXJuIGZ1bmN0aW9uKGYpIHtcbiAgICAgICAgICAgICAgICAgICAgcmVtb3ZlKCk7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBvbGQuY2FsbCh0aGlzLCBpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHBsdWdpbi5zZWFyY2hJbnB1dCA9IGk7IGY/LihpKTtcbiAgICAgICAgICAgICAgICAgICAgfSlcbiAgICAgICAgICAgICAgICB9fVxuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICBzZXRJbW1lZGlhdGUocmVtb3ZlKTtcbiAgICAgICAgfSkgKTtcbiAgICAgICAgdGhpcy5yZWdpc3RlckV2ZW50KCB3b3Jrc3BhY2Uub24oXCJwbHVnaW4tc2V0dGluZ3M6YWZ0ZXItZGlzcGxheVwiLCAgKCkgPT4gdGhpcy5yZWZyZXNoQnV0dG9ucyh0cnVlKSkgKTtcblxuICAgICAgICB0aGlzLnJlZ2lzdGVyRXZlbnQoIHdvcmtzcGFjZS5vbihcInBsdWdpbi1zZXR0aW5nczpwbHVnaW4tY29udHJvbFwiLCAoc2V0dGluZywgbWFuaWZlc3QsIGVuYWJsZWQsIHRhYklkKSA9PiB7XG4gICAgICAgICAgICB0aGlzLmdsb2JhbHNBZGRlZCB8fCB0aGlzLmFkZEdsb2JhbHModGFiSWQsIHNldHRpbmcuc2V0dGluZ0VsKTtcbiAgICAgICAgICAgIHRoaXMuY3JlYXRlRXh0cmFCdXR0b25zKHNldHRpbmcsIG1hbmlmZXN0LCBlbmFibGVkKTtcbiAgICAgICAgfSkgKTtcblxuICAgICAgICAvLyBSZWZyZXNoIHRoZSBidXR0b25zIHdoZW4gY29tbWFuZHMgb3Igc2V0dGluZyB0YWJzIGFyZSBhZGRlZCBvciByZW1vdmVkXG4gICAgICAgIGNvbnN0IHJlcXVlc3RSZWZyZXNoID0gZGVib3VuY2UodGhpcy5yZWZyZXNoQnV0dG9ucy5iaW5kKHRoaXMpLCA1MCwgdHJ1ZSk7XG4gICAgICAgIGZ1bmN0aW9uIHJlZnJlc2hlcihvbGQpIHsgcmV0dXJuIGZ1bmN0aW9uKC4uLmFyZ3MpeyByZXF1ZXN0UmVmcmVzaCgpOyByZXR1cm4gb2xkLmFwcGx5KHRoaXMsIGFyZ3MpOyB9OyB9XG4gICAgICAgIHRoaXMucmVnaXN0ZXIoYXJvdW5kKGFwcC5jb21tYW5kcywge2FkZENvbW1hbmQ6ICAgIHJlZnJlc2hlciwgcmVtb3ZlQ29tbWFuZDogICAgcmVmcmVzaGVyfSkpO1xuICAgICAgICB0aGlzLnJlZ2lzdGVyKGFyb3VuZChhcHAuc2V0dGluZywgIHthZGRQbHVnaW5UYWI6ICByZWZyZXNoZXIsIHJlbW92ZVBsdWdpblRhYjogIHJlZnJlc2hlcn0pKTtcbiAgICAgICAgdGhpcy5yZWdpc3Rlcihhcm91bmQoYXBwLnNldHRpbmcsICB7YWRkU2V0dGluZ1RhYjogcmVmcmVzaGVyLCByZW1vdmVTZXR0aW5nVGFiOiByZWZyZXNoZXJ9KSk7XG5cbiAgICAgICAgd29ya3NwYWNlLm9uTGF5b3V0UmVhZHkodGhpcy53aGVuUmVhZHkuYmluZCh0aGlzKSk7XG4gICAgICAgIHRoaXMucmVnaXN0ZXJPYnNpZGlhblByb3RvY29sSGFuZGxlcihcImdvdG8tcGx1Z2luXCIsICh7aWQsIHNob3d9KSA9PiB7XG4gICAgICAgICAgICB3b3Jrc3BhY2Uub25MYXlvdXRSZWFkeSgoKSA9PiB7IHRoaXMuZ290b1BsdWdpbihpZCwgc2hvdyk7IH0pO1xuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICB3aGVuUmVhZHkoKSB7XG4gICAgICAgIGNvbnN0IGFwcCA9IHRoaXMuYXBwLCBwbHVnaW4gPSB0aGlzO1xuXG4gICAgICAgIC8vIFNhdmUgYW5kIHJlc3RvcmUgY3VycmVudCB0YWIgKHdvcmthcm91bmQgaHR0cHM6Ly9mb3J1bS5vYnNpZGlhbi5tZC90L3NldHRpbmdzLWRpYWxvZy1yZXNldHMtdG8tZmlyc3QtdGFiLWV2ZXJ5LXRpbWUvMTgyNDApXG4gICAgICAgIHRoaXMucmVnaXN0ZXIoYXJvdW5kKGFwcC5zZXR0aW5nLCB7XG4gICAgICAgICAgICBvbk9wZW4ob2xkKSB7IHJldHVybiBmdW5jdGlvbiguLi5hcmdzKSB7XG4gICAgICAgICAgICAgICAgb2xkLmFwcGx5KHRoaXMsIGFyZ3MpO1xuICAgICAgICAgICAgICAgIGlmICghUGxhdGZvcm0uaXNNb2JpbGUgJiYgcGx1Z2luLmxhc3RUYWJJZCkgdGhpcy5vcGVuVGFiQnlJZChwbHVnaW4ubGFzdFRhYklkKTtcbiAgICAgICAgICAgIH19LFxuICAgICAgICAgICAgb25DbG9zZShvbGQpIHsgcmV0dXJuIGZ1bmN0aW9uKC4uLmFyZ3MpIHtcbiAgICAgICAgICAgICAgICBwbHVnaW4ubGFzdFRhYklkID0gdGhpcy5hY3RpdmVUYWI/LmlkO1xuICAgICAgICAgICAgICAgIHJldHVybiBvbGQuYXBwbHkodGhpcywgYXJncyk7XG4gICAgICAgICAgICB9fVxuICAgICAgICB9KSlcblxuICAgICAgICBjb25zdCBjb3JlUGx1Z2lucyA9IHRoaXMuZ2V0U2V0dGluZ3NUYWIoXCJwbHVnaW5zXCIpO1xuICAgICAgICBjb25zdCBjb21tdW5pdHkgICA9IHRoaXMuZ2V0U2V0dGluZ3NUYWIoXCJjb21tdW5pdHktcGx1Z2luc1wiKTtcblxuICAgICAgICAvLyBIb29rIGludG8gdGhlIGRpc3BsYXkoKSBtZXRob2Qgb2YgdGhlIHBsdWdpbiBzZXR0aW5ncyB0YWJzXG4gICAgICAgIGlmIChjb3JlUGx1Z2lucykgdGhpcy5yZWdpc3Rlcihhcm91bmQoY29yZVBsdWdpbnMsIHtkaXNwbGF5OiB0aGlzLmFkZFBsdWdpblNldHRpbmdFdmVudHMuYmluZCh0aGlzLCBjb3JlUGx1Z2lucy5pZCl9KSk7XG4gICAgICAgIGlmIChjb21tdW5pdHkpICAgdGhpcy5yZWdpc3Rlcihhcm91bmQoY29tbXVuaXR5LCAgIHtkaXNwbGF5OiB0aGlzLmFkZFBsdWdpblNldHRpbmdFdmVudHMuYmluZCh0aGlzLCBjb21tdW5pdHkuaWQpfSkpO1xuXG4gICAgICAgIGlmIChjb21tdW5pdHkpICAgdGhpcy5yZWdpc3RlcihcbiAgICAgICAgICAgIC8vIFRyYXAgb3BlbnMgb2YgdGhlIGNvbW11bml0eSBwbHVnaW5zIHZpZXdlclxuICAgICAgICAgICAgb25FbGVtZW50KFxuICAgICAgICAgICAgICAgIGNvbW11bml0eS5jb250YWluZXJFbCwgXCJjbGlja1wiLFxuICAgICAgICAgICAgICAgIFwiLm1vZC1jdGEsIC5pbnN0YWxsZWQtcGx1Z2lucy1jb250YWluZXIgLnNldHRpbmctaXRlbS1pbmZvXCIsXG4gICAgICAgICAgICAgICAgKCkgPT4gdGhpcy5lbmhhbmNlVmlld2VyKCksXG4gICAgICAgICAgICAgICAgdHJ1ZVxuICAgICAgICAgICAgKVxuICAgICAgICApO1xuXG4gICAgICAgIC8vIE5vdyBmb3JjZSBhIHJlZnJlc2ggaWYgZWl0aGVyIHBsdWdpbnMgdGFiIGlzIGN1cnJlbnRseSB2aXNpYmxlICh0byBzaG93IG91ciBuZXcgYnV0dG9ucylcbiAgICAgICAgZnVuY3Rpb24gcmVmcmVzaFRhYklmT3BlbigpIHtcbiAgICAgICAgICAgIGlmIChwbHVnaW5TZXR0aW5nc0FyZU9wZW4oYXBwKSkgYXBwLnNldHRpbmcub3BlblRhYkJ5SWQoYXBwLnNldHRpbmcuYWN0aXZlVGFiLmlkKTtcbiAgICAgICAgfVxuICAgICAgICByZWZyZXNoVGFiSWZPcGVuKCk7XG5cbiAgICAgICAgLy8gQW5kIGRvIGl0IGFnYWluIGFmdGVyIHdlIHVubG9hZCAodG8gcmVtb3ZlIHRoZSBvbGQgYnV0dG9ucylcbiAgICAgICAgdGhpcy5yZWdpc3RlcigoKSA9PiBzZXRJbW1lZGlhdGUocmVmcmVzaFRhYklmT3BlbikpO1xuXG4gICAgICAgIC8vIFR3ZWFrIHRoZSBob3RrZXkgc2V0dGluZ3MgdGFiIHRvIG1ha2UgZmlsdGVyaW5nIHdvcmsgb24gaWQgcHJlZml4ZXMgYXMgd2VsbCBhcyBjb21tYW5kIG5hbWVzXG4gICAgICAgIGNvbnN0IGhvdGtleXNUYWIgPSB0aGlzLmdldFNldHRpbmdzVGFiKFwiaG90a2V5c1wiKTtcbiAgICAgICAgaWYgKGhvdGtleXNUYWIpIHtcbiAgICAgICAgICAgIHRoaXMucmVnaXN0ZXIoYXJvdW5kKGhvdGtleXNUYWIsIHtcbiAgICAgICAgICAgICAgICBkaXNwbGF5KG9sZCkgeyByZXR1cm4gZnVuY3Rpb24oKSB7IG9sZC5jYWxsKHRoaXMpOyB0aGlzLnNlYXJjaElucHV0RWwuZm9jdXMoKTsgfTsgfSxcbiAgICAgICAgICAgICAgICB1cGRhdGVIb3RrZXlWaXNpYmlsaXR5KG9sZCkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gZnVuY3Rpb24oKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBvbGRTZWFyY2ggPSB0aGlzLnNlYXJjaElucHV0RWwudmFsdWUsIG9sZENvbW1hbmRzID0gYXBwLmNvbW1hbmRzLmNvbW1hbmRzO1xuICAgICAgICAgICAgICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAob2xkU2VhcmNoLmVuZHNXaXRoKFwiOlwiKSAmJiAhb2xkU2VhcmNoLmNvbnRhaW5zKFwiIFwiKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAvLyBUaGlzIGlzIGFuIGluY3JlZGlibHkgdWdseSBoYWNrIHRoYXQgcmVsaWVzIG9uIHVwZGF0ZUhvdGtleVZpc2liaWxpdHkoKSBpdGVyYXRpbmcgYXBwLmNvbW1hbmRzLmNvbW1hbmRzXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC8vIGxvb2tpbmcgZm9yIGhvdGtleSBjb25mbGljdHMgKmJlZm9yZSogYW55dGhpbmcgZWxzZS5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGN1cnJlbnQgPSBvbGRDb21tYW5kcztcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGZpbHRlcmVkID0gT2JqZWN0LmZyb21FbnRyaWVzKE9iamVjdC5lbnRyaWVzKGFwcC5jb21tYW5kcy5jb21tYW5kcykuZmlsdGVyKFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgKFtpZCwgY21kXSkgPT4gKGlkK1wiOlwiKS5zdGFydHNXaXRoKG9sZFNlYXJjaClcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgKSk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuc2VhcmNoSW5wdXRFbC52YWx1ZSA9IFwiXCI7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFwcC5jb21tYW5kcy5jb21tYW5kcyA9IG5ldyBQcm94eShvbGRDb21tYW5kcywge293bktleXMoKXtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC8vIFRoZSBmaXJzdCB0aW1lIGNvbW1hbmRzIGFyZSBpdGVyYXRlZCwgcmV0dXJuIHRoZSB3aG9sZSB0aGluZztcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC8vIGFmdGVyIHRoYXQsIHJldHVybiB0aGUgZmlsdGVyZWQgbGlzdFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHJ5IHsgcmV0dXJuIE9iamVjdC5rZXlzKGN1cnJlbnQpOyB9IGZpbmFsbHkgeyBjdXJyZW50ID0gZmlsdGVyZWQ7IH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfX0pO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gb2xkLmNhbGwodGhpcyk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9IGZpbmFsbHkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuc2VhcmNoSW5wdXRFbC52YWx1ZSA9IG9sZFNlYXJjaDtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBhcHAuY29tbWFuZHMuY29tbWFuZHMgPSBvbGRDb21tYW5kcztcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0pKTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIEFkZCBjb21tYW5kc1xuICAgICAgICB0aGlzLmFkZENvbW1hbmQoe1xuICAgICAgICAgICAgaWQ6IFwib3Blbi1wbHVnaW5zXCIsXG4gICAgICAgICAgICBuYW1lOiBcIk9wZW4gdGhlIENvbW11bml0eSBQbHVnaW5zIHNldHRpbmdzXCIsXG4gICAgICAgICAgICBjYWxsYmFjazogKCkgPT4gdGhpcy5zaG93U2V0dGluZ3MoXCJjb21tdW5pdHktcGx1Z2luc1wiKSB8fCB0cnVlXG4gICAgICAgIH0pO1xuICAgICAgICB0aGlzLmFkZENvbW1hbmQoe1xuICAgICAgICAgICAgaWQ6IFwiYnJvd3NlLXBsdWdpbnNcIixcbiAgICAgICAgICAgIG5hbWU6IFwiQnJvd3NlIG9yIHNlYXJjaCB0aGUgQ29tbXVuaXR5IFBsdWdpbnMgY2F0YWxvZ1wiLFxuICAgICAgICAgICAgY2FsbGJhY2s6ICgpID0+IHRoaXMuZ290b1BsdWdpbigpXG4gICAgICAgIH0pXG4gICAgfVxuXG4gICAgY3JlYXRlRXh0cmFCdXR0b25zKHNldHRpbmcsIG1hbmlmZXN0LCBlbmFibGVkKSB7XG4gICAgICAgIHNldHRpbmcuYWRkRXh0cmFCdXR0b24oYnRuID0+IHtcbiAgICAgICAgICAgIGJ0bi5zZXRJY29uKFwiZ2VhclwiKTtcbiAgICAgICAgICAgIGJ0bi5vbkNsaWNrKCgpID0+IHRoaXMuc2hvd0NvbmZpZ0ZvcihtYW5pZmVzdC5pZC5yZXBsYWNlKC9ed29ya3NwYWNlJC8sXCJmaWxlXCIpKSk7XG4gICAgICAgICAgICBidG4uc2V0VG9vbHRpcChcIk9wdGlvbnNcIik7XG4gICAgICAgICAgICBidG4uZXh0cmFTZXR0aW5nc0VsLnRvZ2dsZShlbmFibGVkKVxuICAgICAgICAgICAgdGhpcy5jb25maWdCdXR0b25zW21hbmlmZXN0LmlkXSA9IGJ0bjtcbiAgICAgICAgfSk7XG4gICAgICAgIHNldHRpbmcuYWRkRXh0cmFCdXR0b24oYnRuID0+IHtcbiAgICAgICAgICAgIGJ0bi5zZXRJY29uKFwiYW55LWtleVwiKTtcbiAgICAgICAgICAgIGJ0bi5vbkNsaWNrKCgpID0+IHRoaXMuc2hvd0hvdGtleXNGb3IobWFuaWZlc3QuaWQrXCI6XCIpKVxuICAgICAgICAgICAgYnRuLmV4dHJhU2V0dGluZ3NFbC50b2dnbGUoZW5hYmxlZClcbiAgICAgICAgICAgIHRoaXMuaG90a2V5QnV0dG9uc1ttYW5pZmVzdC5pZF0gPSBidG47XG4gICAgICAgIH0pO1xuICAgIH1cblxuICAgIC8vIEFkZCB0b3AtbGV2ZWwgaXRlbXMgKHNlYXJjaCBhbmQgcHNldWRvLXBsdWdpbnMpXG4gICAgYWRkR2xvYmFscyh0YWJJZCwgc2V0dGluZ0VsKSB7XG4gICAgICAgIHRoaXMuZ2xvYmFsc0FkZGVkID0gdHJ1ZTtcblxuICAgICAgICAvLyBBZGQgYSBzZWFyY2ggZmlsdGVyIHRvIHNocmluayBwbHVnaW4gbGlzdFxuICAgICAgICBjb25zdCBjb250YWluZXJFbCA9IHNldHRpbmdFbC5wYXJlbnRFbGVtZW50O1xuICAgICAgICBsZXQgc2VhcmNoRWw7XG4gICAgICAgIGlmICh0YWJJZCAhPT0gXCJwbHVnaW5zXCIpIHtcbiAgICAgICAgICAgIC8vIFJlcGxhY2UgdGhlIGJ1aWx0LWluIHNlYXJjaCBoYW5kbGVyXG4gICAgICAgICAgICAoc2VhcmNoRWwgPSB0aGlzLnNlYXJjaElucHV0KT8ub25DaGFuZ2UoY2hhbmdlSGFuZGxlcik7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBjb25zdCB0bXAgPSBuZXcgU2V0dGluZyhjb250YWluZXJFbCkuYWRkU2VhcmNoKHMgPT4ge1xuICAgICAgICAgICAgICAgIHNlYXJjaEVsID0gcztcbiAgICAgICAgICAgICAgICBzLnNldFBsYWNlaG9sZGVyKFwiRmlsdGVyIHBsdWdpbnMuLi5cIikub25DaGFuZ2UoY2hhbmdlSGFuZGxlcik7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIHNlYXJjaEVsLmNvbnRhaW5lckVsLnN0eWxlLm1hcmdpbiA9IDA7XG4gICAgICAgICAgICBjb250YWluZXJFbC5jcmVhdGVEaXYoXCJob3RrZXktc2VhcmNoLWNvbnRhaW5lclwiKS5hcHBlbmQoc2VhcmNoRWwuY29udGFpbmVyRWwpO1xuICAgICAgICAgICAgdG1wLnNldHRpbmdFbC5kZXRhY2goKTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBwbHVnaW4gPSB0aGlzO1xuICAgICAgICBmdW5jdGlvbiBjaGFuZ2VIYW5kbGVyKHNlZWspe1xuICAgICAgICAgICAgY29uc3QgZmluZCA9IChwbHVnaW4ubGFzdFNlYXJjaFt0YWJJZF0gPSBzZWVrKS50b0xvd2VyQ2FzZSgpO1xuICAgICAgICAgICAgZnVuY3Rpb24gbWF0Y2hBbmRIaWdobGlnaHQoZWwpIHtcbiAgICAgICAgICAgICAgICBjb25zdCB0ZXh0ID0gZWwudGV4dENvbnRlbnQgPSBlbC50ZXh0Q29udGVudDsgLy8gY2xlYXIgcHJldmlvdXMgaGlnaGxpZ2h0aW5nLCBpZiBhbnlcbiAgICAgICAgICAgICAgICBjb25zdCBpbmRleCA9IHRleHQudG9Mb3dlckNhc2UoKS5pbmRleE9mKGZpbmQpO1xuICAgICAgICAgICAgICAgIGlmICghfmluZGV4KSByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICAgICAgZWwudGV4dENvbnRlbnQgPSB0ZXh0LnN1YnN0cigwLCBpbmRleCk7XG4gICAgICAgICAgICAgICAgZWwuY3JlYXRlU3BhbihcInN1Z2dlc3Rpb24taGlnaGxpZ2h0XCIpLnRleHRDb250ZW50ID0gdGV4dC5zdWJzdHIoaW5kZXgsIGZpbmQubGVuZ3RoKTtcbiAgICAgICAgICAgICAgICBlbC5pbnNlcnRBZGphY2VudFRleHQoXCJiZWZvcmVlbmRcIiwgdGV4dC5zdWJzdHIoaW5kZXgrZmluZC5sZW5ndGgpKVxuICAgICAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY29udGFpbmVyRWwuZmluZEFsbChcIi5zZXR0aW5nLWl0ZW1cIikuZm9yRWFjaChlID0+IHtcbiAgICAgICAgICAgICAgICBjb25zdCBuYW1lTWF0Y2hlcyA9IG1hdGNoQW5kSGlnaGxpZ2h0KGUuZmluZChcIi5zZXR0aW5nLWl0ZW0tbmFtZVwiKSk7XG4gICAgICAgICAgICAgICAgY29uc3QgZGVzY01hdGNoZXMgPSBtYXRjaEFuZEhpZ2hsaWdodChcbiAgICAgICAgICAgICAgICAgICAgZS5maW5kKFwiLnNldHRpbmctaXRlbS1kZXNjcmlwdGlvbiA+IGRpdjpsYXN0LWNoaWxkXCIpID8/XG4gICAgICAgICAgICAgICAgICAgIGUuZmluZChcIi5zZXR0aW5nLWl0ZW0tZGVzY3JpcHRpb25cIilcbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIGUudG9nZ2xlKG5hbWVNYXRjaGVzIHx8IGRlc2NNYXRjaGVzKTtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICAgIHNldEltbWVkaWF0ZSgoKSA9PiB7XG4gICAgICAgICAgICBpZiAoIXNlYXJjaEVsKSByZXR1cm5cbiAgICAgICAgICAgIGlmIChzZWFyY2hFbCAmJiB0eXBlb2YgcGx1Z2luLmxhc3RTZWFyY2hbdGFiSWRdID09PSBcInN0cmluZ1wiKSB7XG4gICAgICAgICAgICAgICAgc2VhcmNoRWwuc2V0VmFsdWUocGx1Z2luLmxhc3RTZWFyY2hbdGFiSWRdKTtcbiAgICAgICAgICAgICAgICBzZWFyY2hFbC5vbkNoYW5nZWQoKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmICghUGxhdGZvcm0uaXNNb2JpbGUpIHNlYXJjaEVsLmlucHV0RWwuc2VsZWN0KCk7XG4gICAgICAgIH0pO1xuICAgICAgICBjb250YWluZXJFbC5hcHBlbmQoc2V0dGluZ0VsKTtcblxuICAgICAgICBpZiAodGFiSWQgPT09IFwicGx1Z2luc1wiKSB7XG4gICAgICAgICAgICBjb25zdCBlZGl0b3JOYW1lICAgID0gdGhpcy5nZXRTZXR0aW5nc1RhYihcImVkaXRvclwiKT8ubmFtZSB8fCBcIkVkaXRvclwiO1xuICAgICAgICAgICAgY29uc3Qgd29ya3NwYWNlTmFtZSA9IHRoaXMuZ2V0U2V0dGluZ3NUYWIoXCJmaWxlXCIpPy5uYW1lICAgfHwgXCJGaWxlcyAmIExpbmtzXCI7XG4gICAgICAgICAgICB0aGlzLmNyZWF0ZUV4dHJhQnV0dG9ucyhcbiAgICAgICAgICAgICAgICBuZXcgU2V0dGluZyhzZXR0aW5nRWwucGFyZW50RWxlbWVudClcbiAgICAgICAgICAgICAgICAgICAgLnNldE5hbWUoXCJBcHBcIikuc2V0RGVzYyhcIk1pc2NlbGxhbmVvdXMgYXBwbGljYXRpb24gY29tbWFuZHMgKGFsd2F5cyBlbmFibGVkKVwiKSxcbiAgICAgICAgICAgICAgICB7aWQ6IFwiYXBwXCIsIG5hbWU6IFwiQXBwXCJ9LCB0cnVlXG4gICAgICAgICAgICApO1xuICAgICAgICAgICAgdGhpcy5jcmVhdGVFeHRyYUJ1dHRvbnMoXG4gICAgICAgICAgICAgICAgbmV3IFNldHRpbmcoc2V0dGluZ0VsLnBhcmVudEVsZW1lbnQpXG4gICAgICAgICAgICAgICAgICAgIC5zZXROYW1lKGVkaXRvck5hbWUpLnNldERlc2MoXCJDb3JlIGVkaXRpbmcgY29tbWFuZHMgKGFsd2F5cyBlbmFibGVkKVwiKSxcbiAgICAgICAgICAgICAgICB7aWQ6IFwiZWRpdG9yXCIsIG5hbWU6IGVkaXRvck5hbWV9LCB0cnVlXG4gICAgICAgICAgICApO1xuICAgICAgICAgICAgdGhpcy5jcmVhdGVFeHRyYUJ1dHRvbnMoXG4gICAgICAgICAgICAgICAgbmV3IFNldHRpbmcoc2V0dGluZ0VsLnBhcmVudEVsZW1lbnQpXG4gICAgICAgICAgICAgICAgICAgIC5zZXROYW1lKHdvcmtzcGFjZU5hbWUpLnNldERlc2MoXCJDb3JlIGZpbGUgYW5kIHBhbmUgbWFuYWdlbWVudCBjb21tYW5kcyAoYWx3YXlzIGVuYWJsZWQpXCIpLFxuICAgICAgICAgICAgICAgIHtpZDogXCJ3b3Jrc3BhY2VcIiwgbmFtZTogd29ya3NwYWNlTmFtZX0sIHRydWVcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgICBzZXR0aW5nRWwucGFyZW50RWxlbWVudC5hcHBlbmQoc2V0dGluZ0VsKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIGVuaGFuY2VWaWV3ZXIoKSB7XG4gICAgICAgIGNvbnN0IHBsdWdpbiA9IHRoaXM7XG4gICAgICAgIHNldEltbWVkaWF0ZShhcm91bmQoTW9kYWwucHJvdG90eXBlLCB7XG4gICAgICAgICAgICBvcGVuKG9sZCkge1xuICAgICAgICAgICAgICAgIHJldHVybiBmdW5jdGlvbiguLi5hcmdzKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChpc1BsdWdpblZpZXdlcih0aGlzKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgc2V0SW1tZWRpYXRlKCgpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAocGx1Z2luLmxhc3RTZWFyY2hbXCJjb21tdW5pdHktcGx1Z2luc1wiXSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAvLyBEZXRhY2ggdGhlIG9sZCBzZWFyY2ggYXJlYSwgaW4gY2FzZSB0aGUgZW1wdHkgc2VhcmNoIGlzIHN0aWxsIHJ1bm5pbmdcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgbmV3UmVzdWx0cyA9IHRoaXMuc2VhcmNoUmVzdWx0RWwuY2xvbmVOb2RlKCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuc2VhcmNoQ29udGFpbmVyRWwucmVwbGFjZUNoaWxkKG5ld1Jlc3VsdHMsIHRoaXMuc2VhcmNoUmVzdWx0RWwpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aGlzLnNlYXJjaFJlc3VsdEVsID0gbmV3UmVzdWx0cztcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLy8gRm9yY2UgYW4gdXBkYXRlOyB1c2UgYW4gZXZlbnQgc28gdGhhdCB0aGUgXCJ4XCIgYXBwZWFycyBvbiBzZWFyY2hcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5zZWFyY2hFbC52YWx1ZSA9IHBsdWdpbi5sYXN0U2VhcmNoW1wiY29tbXVuaXR5LXBsdWdpbnNcIl07XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuc2VhcmNoRWwuZGlzcGF0Y2hFdmVudChuZXcgRXZlbnQoJ2lucHV0JykpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aGlzLnNlYXJjaEVsLnNlbGVjdCgpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgICAgICBwbHVnaW4uY3VycmVudFZpZXdlciA9IHRoaXM7XG4gICAgICAgICAgICAgICAgICAgICAgICBhcm91bmQodGhpcywge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHVwZGF0ZVNlYXJjaDogc2VyaWFsaXplLCAgLy8gcHJldmVudCByYWNlIGNvbmRpdGlvbnNcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNsb3NlKG9sZCkgeyByZXR1cm4gZnVuY3Rpb24oLi4uYXJncykge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwbHVnaW4uY3VycmVudFZpZXdlciA9IG51bGw7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiBvbGQuYXBwbHkodGhpcywgYXJncyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfX0sXG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBzaG93UGx1Z2luKG9sZCkgeyByZXR1cm4gYXN5bmMgZnVuY3Rpb24obWFuaWZlc3Qpe1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25zdCByZXMgPSBhd2FpdCBvbGQuY2FsbCh0aGlzLCBtYW5pZmVzdCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChwbHVnaW4uYXBwLnBsdWdpbnMucGx1Z2luc1ttYW5pZmVzdC5pZF0pIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IGJ1dHRvbnMgPSB0aGlzLnBsdWdpbkNvbnRlbnRFbC5maW5kKFwiYnV0dG9uXCIpLnBhcmVudEVsZW1lbnQ7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBrZXlCdG4gPSBidXR0b25zLmNyZWF0ZUVsKFwiYnV0dG9uXCIsIHtwcmVwZW5kOiB0cnVlLCB0ZXh0OiBcIkhvdGtleXNcIn0pO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgY2ZnQnRuID0gYnV0dG9ucy5jcmVhdGVFbChcImJ1dHRvblwiLCB7cHJlcGVuZDogdHJ1ZSwgdGV4dDogXCJPcHRpb25zXCJ9KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBsdWdpbi5ob3RrZXlCdXR0b25zW21hbmlmZXN0LmlkXSA9IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBzZXRUb29sdGlwKHRpcCkge2tleUJ0bi50aXRsZSA9IHRpcH0sIGV4dHJhU2V0dGluZ3NFbDoga2V5QnRuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwbHVnaW4uY29uZmlnQnV0dG9uc1ttYW5pZmVzdC5pZF0gPSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgc2V0VG9vbHRpcCgpIHt9LCBleHRyYVNldHRpbmdzRWw6IGNmZ0J0blxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcGx1Z2luLnJlZnJlc2hCdXR0b25zKHRydWUpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAga2V5QnRuLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAgKCkgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuY2xvc2UoKTsgcGx1Z2luLnNob3dIb3RrZXlzRm9yKG1hbmlmZXN0LmlkK1wiOlwiKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY2ZnQnRuLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAgKCkgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuY2xvc2UoKTsgcGx1Z2luLnNob3dDb25maWdGb3IobWFuaWZlc3QuaWQpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHJlcztcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9fVxuICAgICAgICAgICAgICAgICAgICAgICAgfSlcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gb2xkLmFwcGx5KHRoaXMsIGFyZ3MpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfSkpO1xuICAgIH1cblxuICAgIGdldFNldHRpbmdzVGFiKGlkKSB7IHJldHVybiB0aGlzLmFwcC5zZXR0aW5nLnNldHRpbmdUYWJzLmZpbHRlcih0ID0+IHQuaWQgPT09IGlkKS5zaGlmdCgpOyB9XG5cbiAgICBhZGRQbHVnaW5TZXR0aW5nRXZlbnRzKHRhYklkLCBvbGQpIHtcbiAgICAgICAgY29uc3QgYXBwID0gdGhpcy5hcHA7XG4gICAgICAgIGxldCBpbl9ldmVudCA9IGZhbHNlO1xuXG4gICAgICAgIGZ1bmN0aW9uIHRyaWdnZXIoLi4uYXJncykge1xuICAgICAgICAgICAgaW5fZXZlbnQgPSB0cnVlO1xuICAgICAgICAgICAgdHJ5IHsgYXBwLndvcmtzcGFjZS50cmlnZ2VyKC4uLmFyZ3MpOyB9IGNhdGNoKGUpIHsgY29uc29sZS5lcnJvcihlKTsgfVxuICAgICAgICAgICAgaW5fZXZlbnQgPSBmYWxzZTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIFdyYXBwZXIgdG8gYWRkIHBsdWdpbi1zZXR0aW5ncyBldmVudHNcbiAgICAgICAgcmV0dXJuIGZ1bmN0aW9uIGRpc3BsYXkoLi4uYXJncykge1xuICAgICAgICAgICAgaWYgKGluX2V2ZW50KSByZXR1cm47XG4gICAgICAgICAgICB0cmlnZ2VyKFwicGx1Z2luLXNldHRpbmdzOmJlZm9yZS1kaXNwbGF5XCIsIHRoaXMsIHRhYklkKTtcblxuICAgICAgICAgICAgLy8gVHJhY2sgd2hpY2ggcGx1Z2luIGVhY2ggc2V0dGluZyBpcyBmb3JcbiAgICAgICAgICAgIGxldCBtYW5pZmVzdHM7XG4gICAgICAgICAgICBpZiAodGFiSWQgPT09IFwicGx1Z2luc1wiKSB7XG4gICAgICAgICAgICAgICAgbWFuaWZlc3RzID0gT2JqZWN0LmVudHJpZXMoYXBwLmludGVybmFsUGx1Z2lucy5wbHVnaW5zKS5tYXAoXG4gICAgICAgICAgICAgICAgICAgIChbaWQsIHtpbnN0YW5jZToge25hbWV9LCBfbG9hZGVkOmVuYWJsZWR9XSkgPT4ge3JldHVybiB7aWQsIG5hbWUsIGVuYWJsZWR9O31cbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBtYW5pZmVzdHMgPSBPYmplY3QudmFsdWVzKGFwcC5wbHVnaW5zLm1hbmlmZXN0cyk7XG4gICAgICAgICAgICAgICAgbWFuaWZlc3RzLnNvcnQoKGUsIHQpID0+IGUubmFtZS5sb2NhbGVDb21wYXJlKHQubmFtZSkpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgbGV0IHdoaWNoID0gMDtcblxuICAgICAgICAgICAgLy8gVHJhcCB0aGUgYWRkaXRpb24gb2YgdGhlIFwidW5pbnN0YWxsXCIgYnV0dG9ucyBuZXh0IHRvIGVhY2ggcGx1Z2luXG4gICAgICAgICAgICBjb25zdCByZW1vdmUgPSBhcm91bmQoU2V0dGluZy5wcm90b3R5cGUsIHtcbiAgICAgICAgICAgICAgICBhZGRUb2dnbGUob2xkKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBmdW5jdGlvbiguLi5hcmdzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAodGFiSWQgPT09IFwicGx1Z2luc1wiICYmICFpbl9ldmVudCAmJiAobWFuaWZlc3RzW3doaWNoXXx8e30pLm5hbWUgPT09IHRoaXMubmFtZUVsLnRleHRDb250ZW50ICkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IG1hbmlmZXN0ID0gbWFuaWZlc3RzW3doaWNoKytdO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRyaWdnZXIoXCJwbHVnaW4tc2V0dGluZ3M6cGx1Z2luLWNvbnRyb2xcIiwgdGhpcywgbWFuaWZlc3QsIG1hbmlmZXN0LmVuYWJsZWQsIHRhYklkKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiBvbGQuYXBwbHkodGhpcywgYXJncyk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgIGFkZEV4dHJhQnV0dG9uKG9sZCkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gZnVuY3Rpb24oLi4uYXJncykge1xuICAgICAgICAgICAgICAgICAgICAgICAgLy8gVGhlIG9ubHkgXCJleHRyYXNcIiBhZGRlZCB0byBzZXR0aW5ncyB3L2EgZGVzY3JpcHRpb24gYXJlIG9uIHRoZSBwbHVnaW5zLCBjdXJyZW50bHksXG4gICAgICAgICAgICAgICAgICAgICAgICAvLyBzbyBvbmx5IHRyeSB0byBtYXRjaCB0aG9zZSB0byBwbHVnaW4gbmFtZXNcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICh0YWJJZCAhPT0gXCJwbHVnaW5zXCIgJiYgdGhpcy5kZXNjRWwuY2hpbGRFbGVtZW50Q291bnQgJiYgIWluX2V2ZW50KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCAobWFuaWZlc3RzW3doaWNoXXx8e30pLm5hbWUgPT09IHRoaXMubmFtZUVsLnRleHRDb250ZW50ICkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBtYW5pZmVzdCA9IG1hbmlmZXN0c1t3aGljaCsrXSwgZW5hYmxlZCA9ICEhYXBwLnBsdWdpbnMucGx1Z2luc1ttYW5pZmVzdC5pZF07XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRyaWdnZXIoXCJwbHVnaW4tc2V0dGluZ3M6cGx1Z2luLWNvbnRyb2xcIiwgdGhpcywgbWFuaWZlc3QsIGVuYWJsZWQsIHRhYklkKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIG9sZC5hcHBseSh0aGlzLCBhcmdzKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgIHJldHVybiBvbGQuYXBwbHkodGhpcywgYXJncyk7XG4gICAgICAgICAgICB9IGZpbmFsbHkge1xuICAgICAgICAgICAgICAgIHJlbW92ZSgpO1xuICAgICAgICAgICAgICAgIHRyaWdnZXIoXCJwbHVnaW4tc2V0dGluZ3M6YWZ0ZXItZGlzcGxheVwiLCB0aGlzKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH1cblxuICAgIGdvdG9QbHVnaW4oaWQsIHNob3c9XCJpbmZvXCIpIHtcbiAgICAgICAgaWYgKGlkICYmIHNob3cgPT09IFwiaG90a2V5c1wiKSByZXR1cm4gdGhpcy5zaG93SG90a2V5c0ZvcihpZCtcIjpcIik7XG4gICAgICAgIGlmIChpZCAmJiBzaG93ID09PSBcImNvbmZpZ1wiKSAge1xuICAgICAgICAgICAgaWYgKCF0aGlzLnNob3dDb25maWdGb3IoaWQpKSB0aGlzLmFwcC5zZXR0aW5nLmNsb3NlKCk7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cblxuICAgICAgICB0aGlzLnNob3dTZXR0aW5ncyhcImNvbW11bml0eS1wbHVnaW5zXCIpO1xuICAgICAgICBjb25zdCByZW1vdmUgPSBhcm91bmQoTW9kYWwucHJvdG90eXBlLCB7XG4gICAgICAgICAgICBvcGVuKG9sZCkge1xuICAgICAgICAgICAgICAgIHJldHVybiBmdW5jdGlvbiguLi5hcmdzKSB7XG4gICAgICAgICAgICAgICAgICAgIHJlbW92ZSgpO1xuICAgICAgICAgICAgICAgICAgICBpZiAoaWQpIHRoaXMuYXV0b2xvYWQgPSBpZDtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIG9sZC5hcHBseSh0aGlzLCBhcmdzKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pXG4gICAgICAgIHRoaXMuYXBwLnNldHRpbmcuYWN0aXZlVGFiLmNvbnRhaW5lckVsLmZpbmQoXCIubW9kLWN0YVwiKS5jbGljaygpO1xuICAgICAgICAvLyBYWFggaGFuZGxlIG5hdiB0byBub3QtY2F0YWxvZ2VkIHBsdWdpblxuICAgIH1cblxuICAgIHNob3dTZXR0aW5ncyhpZCkge1xuICAgICAgICB0aGlzLmN1cnJlbnRWaWV3ZXI/LmNsb3NlKCk7ICAvLyBjbG9zZSB0aGUgcGx1Z2luIGJyb3dzZXIgaWYgb3BlblxuICAgICAgICBzZXR0aW5nc0FyZU9wZW4odGhpcy5hcHApIHx8IHRoaXMuYXBwLnNldHRpbmcub3BlbigpO1xuICAgICAgICBpZiAoaWQpIHtcbiAgICAgICAgICAgIHRoaXMuYXBwLnNldHRpbmcub3BlblRhYkJ5SWQoaWQpO1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMuYXBwLnNldHRpbmcuYWN0aXZlVGFiPy5pZCA9PT0gaWQgPyB0aGlzLmFwcC5zZXR0aW5nLmFjdGl2ZVRhYiA6IGZhbHNlXG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBzaG93SG90a2V5c0ZvcihzZWFyY2gpIHtcbiAgICAgICAgY29uc3QgdGFiID0gdGhpcy5zaG93U2V0dGluZ3MoXCJob3RrZXlzXCIpO1xuICAgICAgICBpZiAodGFiICYmIHRhYi5zZWFyY2hJbnB1dEVsICYmIHRhYi51cGRhdGVIb3RrZXlWaXNpYmlsaXR5KSB7XG4gICAgICAgICAgICB0YWIuc2VhcmNoSW5wdXRFbC52YWx1ZSA9IHNlYXJjaDtcbiAgICAgICAgICAgIHRhYi51cGRhdGVIb3RrZXlWaXNpYmlsaXR5KCk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBzaG93Q29uZmlnRm9yKGlkKSB7XG4gICAgICAgIGlmICh0aGlzLnNob3dTZXR0aW5ncyhpZCkpIHJldHVybiB0cnVlO1xuICAgICAgICBuZXcgTm90aWNlKFxuICAgICAgICAgICAgYE5vIHNldHRpbmdzIHRhYiBmb3IgXCIke2lkfVwiOiBpdCBtYXkgbm90IGJlIGluc3RhbGxlZCBvciBtaWdodCBub3QgaGF2ZSBzZXR0aW5ncy5gXG4gICAgICAgICk7XG4gICAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG5cbiAgICBwbHVnaW5FbmFibGVkKGlkKSB7XG4gICAgICAgIHJldHVybiB0aGlzLmFwcC5pbnRlcm5hbFBsdWdpbnMucGx1Z2luc1tpZF0/Ll9sb2FkZWQgfHwgdGhpcy5hcHAucGx1Z2lucy5wbHVnaW5zW2lkXTtcbiAgICB9XG5cbiAgICByZWZyZXNoQnV0dG9ucyhmb3JjZT1mYWxzZSkge1xuICAgICAgICAvLyBEb24ndCByZWZyZXNoIHdoZW4gbm90IGRpc3BsYXlpbmcsIHVubGVzcyByZW5kZXJpbmcgaXMgaW4gcHJvZ3Jlc3NcbiAgICAgICAgaWYgKCFwbHVnaW5TZXR0aW5nc0FyZU9wZW4odGhpcy5hcHApICYmICFmb3JjZSkgcmV0dXJuO1xuXG4gICAgICAgIGNvbnN0IGhrbSA9IHRoaXMuYXBwLmhvdGtleU1hbmFnZXI7XG4gICAgICAgIGNvbnN0IGFzc2lnbmVkS2V5Q291bnQgPSB7fTtcblxuICAgICAgICAvLyBHZXQgYSBsaXN0IG9mIGNvbW1hbmRzIGJ5IHBsdWdpblxuICAgICAgICBjb25zdCBjb21tYW5kcyA9IE9iamVjdC52YWx1ZXModGhpcy5hcHAuY29tbWFuZHMuY29tbWFuZHMpLnJlZHVjZSgoY21kcywgY21kKT0+e1xuICAgICAgICAgICAgY29uc3QgcGlkID0gY21kLmlkLnNwbGl0KFwiOlwiLDIpLnNoaWZ0KCk7XG4gICAgICAgICAgICBjb25zdCBob3RrZXlzID0gKGhrbS5nZXRIb3RrZXlzKGNtZC5pZCkgfHwgaGttLmdldERlZmF1bHRIb3RrZXlzKGNtZC5pZCkgfHwgW10pLm1hcChob3RrZXlUb1N0cmluZyk7XG4gICAgICAgICAgICBob3RrZXlzLmZvckVhY2goayA9PiBhc3NpZ25lZEtleUNvdW50W2tdID0gMSArIChhc3NpZ25lZEtleUNvdW50W2tdfHwwKSk7XG4gICAgICAgICAgICAoY21kc1twaWRdIHx8IChjbWRzW3BpZF09W10pKS5wdXNoKHtob3RrZXlzLCBjbWR9KTtcbiAgICAgICAgICAgIHJldHVybiBjbWRzO1xuICAgICAgICB9LCB7fSk7XG5cbiAgICAgICAgLy8gUGx1Z2luIHNldHRpbmcgdGFicyBieSBwbHVnaW5cbiAgICAgICAgY29uc3QgdGFicyA9IE9iamVjdC52YWx1ZXModGhpcy5hcHAuc2V0dGluZy5wbHVnaW5UYWJzKS5yZWR1Y2UoKHRhYnMsIHRhYik9PiB7XG4gICAgICAgICAgICB0YWJzW3RhYi5pZF0gPSB0YWI7IHJldHVybiB0YWJzXG4gICAgICAgIH0sIHt9KTtcbiAgICAgICAgdGFic1tcIndvcmtzcGFjZVwiXSA9IHRhYnNbXCJlZGl0b3JcIl0gPSB0cnVlO1xuXG4gICAgICAgIGZvcihjb25zdCBpZCBvZiBPYmplY3Qua2V5cyh0aGlzLmNvbmZpZ0J1dHRvbnMgfHwge30pKSB7XG4gICAgICAgICAgICBjb25zdCBidG4gPSB0aGlzLmNvbmZpZ0J1dHRvbnNbaWRdO1xuICAgICAgICAgICAgaWYgKCF0YWJzW2lkXSkge1xuICAgICAgICAgICAgICAgIGJ0bi5leHRyYVNldHRpbmdzRWwuaGlkZSgpO1xuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgYnRuLmV4dHJhU2V0dGluZ3NFbC5zaG93KCk7XG4gICAgICAgIH1cblxuICAgICAgICBmb3IoY29uc3QgaWQgb2YgT2JqZWN0LmtleXModGhpcy5ob3RrZXlCdXR0b25zIHx8IHt9KSkge1xuICAgICAgICAgICAgY29uc3QgYnRuID0gdGhpcy5ob3RrZXlCdXR0b25zW2lkXTtcbiAgICAgICAgICAgIGlmICghY29tbWFuZHNbaWRdKSB7XG4gICAgICAgICAgICAgICAgLy8gUGx1Z2luIGlzIGRpc2FibGVkIG9yIGhhcyBubyBjb21tYW5kc1xuICAgICAgICAgICAgICAgIGJ0bi5leHRyYVNldHRpbmdzRWwuaGlkZSgpO1xuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY29uc3QgYXNzaWduZWQgPSBjb21tYW5kc1tpZF0uZmlsdGVyKGluZm8gPT4gaW5mby5ob3RrZXlzLmxlbmd0aCk7XG4gICAgICAgICAgICBjb25zdCBjb25mbGljdHMgPSBhc3NpZ25lZC5maWx0ZXIoaW5mbyA9PiBpbmZvLmhvdGtleXMuZmlsdGVyKGsgPT4gYXNzaWduZWRLZXlDb3VudFtrXT4xKS5sZW5ndGgpLmxlbmd0aDtcblxuICAgICAgICAgICAgYnRuLnNldFRvb2x0aXAoXG4gICAgICAgICAgICAgICAgYENvbmZpZ3VyZSBob3RrZXlzJHtcIlxcblwifSgke2Fzc2lnbmVkLmxlbmd0aH0vJHtjb21tYW5kc1tpZF0ubGVuZ3RofSBhc3NpZ25lZCR7XG4gICAgICAgICAgICAgICAgICAgIGNvbmZsaWN0cyA/IFwiOyBcIitjb25mbGljdHMrXCIgY29uZmxpY3RpbmdcIiA6IFwiXCJcbiAgICAgICAgICAgICAgICB9KWBcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgICBidG4uZXh0cmFTZXR0aW5nc0VsLnRvZ2dsZUNsYXNzKFwibW9kLWVycm9yXCIsICEhY29uZmxpY3RzKTtcbiAgICAgICAgICAgIGJ0bi5leHRyYVNldHRpbmdzRWwuc2hvdygpO1xuICAgICAgICB9XG4gICAgfVxufVxuIl0sIm5hbWVzIjpbIktleW1hcCIsIk1vZGFsIiwiUGx1Z2luIiwiU2V0dGluZyIsImRlYm91bmNlIiwiUGxhdGZvcm0iXSwibWFwcGluZ3MiOiI7Ozs7QUFBTyxTQUFTLE1BQU0sQ0FBQyxHQUFHLEVBQUUsU0FBUyxFQUFFO0FBQ3ZDLElBQUksTUFBTSxRQUFRLEdBQUcsTUFBTSxDQUFDLElBQUksQ0FBQyxTQUFTLENBQUMsQ0FBQyxHQUFHLENBQUMsR0FBRyxJQUFJLE9BQU8sQ0FBQyxHQUFHLEVBQUUsR0FBRyxFQUFFLFNBQVMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDMUYsSUFBSSxPQUFPLFFBQVEsQ0FBQyxNQUFNLEtBQUssQ0FBQyxHQUFHLFFBQVEsQ0FBQyxDQUFDLENBQUMsR0FBRyxZQUFZLEVBQUUsUUFBUSxDQUFDLE9BQU8sQ0FBQyxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUMsQ0FBQyxFQUFFLENBQUM7QUFDN0YsQ0FBQztBQUNELFNBQVMsT0FBTyxDQUFDLEdBQUcsRUFBRSxNQUFNLEVBQUUsYUFBYSxFQUFFO0FBQzdDLElBQUksTUFBTSxRQUFRLEdBQUcsR0FBRyxDQUFDLE1BQU0sQ0FBQyxFQUFFLE1B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
