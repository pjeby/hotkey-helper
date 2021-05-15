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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWFpbi5qcyIsInNvdXJjZXMiOlsiLnlhcm4vY2FjaGUvbW9ua2V5LWFyb3VuZC1ucG0tMi4xLjAtNzBkZjMyZDJhYy0xYmQ3MmQyNWY5LnppcC9ub2RlX21vZHVsZXMvbW9ua2V5LWFyb3VuZC9tanMvaW5kZXguanMiLCJzcmMvcGx1Z2luLmpzIl0sInNvdXJjZXNDb250ZW50IjpbImV4cG9ydCBmdW5jdGlvbiBhcm91bmQob2JqLCBmYWN0b3JpZXMpIHtcbiAgICBjb25zdCByZW1vdmVycyA9IE9iamVjdC5rZXlzKGZhY3RvcmllcykubWFwKGtleSA9PiBhcm91bmQxKG9iaiwga2V5LCBmYWN0b3JpZXNba2V5XSkpO1xuICAgIHJldHVybiByZW1vdmVycy5sZW5ndGggPT09IDEgPyByZW1vdmVyc1swXSA6IGZ1bmN0aW9uICgpIHsgcmVtb3ZlcnMuZm9yRWFjaChyID0+IHIoKSk7IH07XG59XG5mdW5jdGlvbiBhcm91bmQxKG9iaiwgbWV0aG9kLCBjcmVhdGVXcmFwcGVyKSB7XG4gICAgY29uc3Qgb3JpZ2luYWwgPSBvYmpbbWV0aG9kXSwgaGFkT3duID0gb2JqLmhhc093blByb3BlcnR5KG1ldGhvZCk7XG4gICAgbGV0IGN1cnJlbnQgPSBjcmVhdGVXcmFwcGVyKG9yaWdpbmFsKTtcbiAgICAvLyBMZXQgb3VyIHdyYXBwZXIgaW5oZXJpdCBzdGF0aWMgcHJvcHMgZnJvbSB0aGUgd3JhcHBpbmcgbWV0aG9kLFxuICAgIC8vIGFuZCB0aGUgd3JhcHBpbmcgbWV0aG9kLCBwcm9wcyBmcm9tIHRoZSBvcmlnaW5hbCBtZXRob2RcbiAgICBpZiAob3JpZ2luYWwpXG4gICAgICAgIE9iamVjdC5zZXRQcm90b3R5cGVPZihjdXJyZW50LCBvcmlnaW5hbCk7XG4gICAgT2JqZWN0LnNldFByb3RvdHlwZU9mKHdyYXBwZXIsIGN1cnJlbnQpO1xuICAgIG9ialttZXRob2RdID0gd3JhcHBlcjtcbiAgICAvLyBSZXR1cm4gYSBjYWxsYmFjayB0byBhbGxvdyBzYWZlIHJlbW92YWxcbiAgICByZXR1cm4gcmVtb3ZlO1xuICAgIGZ1bmN0aW9uIHdyYXBwZXIoLi4uYXJncykge1xuICAgICAgICAvLyBJZiB3ZSBoYXZlIGJlZW4gZGVhY3RpdmF0ZWQgYW5kIGFyZSBubyBsb25nZXIgd3JhcHBlZCwgcmVtb3ZlIG91cnNlbHZlc1xuICAgICAgICBpZiAoY3VycmVudCA9PT0gb3JpZ2luYWwgJiYgb2JqW21ldGhvZF0gPT09IHdyYXBwZXIpXG4gICAgICAgICAgICByZW1vdmUoKTtcbiAgICAgICAgcmV0dXJuIGN1cnJlbnQuYXBwbHkodGhpcywgYXJncyk7XG4gICAgfVxuICAgIGZ1bmN0aW9uIHJlbW92ZSgpIHtcbiAgICAgICAgLy8gSWYgbm8gb3RoZXIgcGF0Y2hlcywganVzdCBkbyBhIGRpcmVjdCByZW1vdmFsXG4gICAgICAgIGlmIChvYmpbbWV0aG9kXSA9PT0gd3JhcHBlcikge1xuICAgICAgICAgICAgaWYgKGhhZE93bilcbiAgICAgICAgICAgICAgICBvYmpbbWV0aG9kXSA9IG9yaWdpbmFsO1xuICAgICAgICAgICAgZWxzZVxuICAgICAgICAgICAgICAgIGRlbGV0ZSBvYmpbbWV0aG9kXTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoY3VycmVudCA9PT0gb3JpZ2luYWwpXG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgIC8vIEVsc2UgcGFzcyBmdXR1cmUgY2FsbHMgdGhyb3VnaCwgYW5kIHJlbW92ZSB3cmFwcGVyIGZyb20gdGhlIHByb3RvdHlwZSBjaGFpblxuICAgICAgICBjdXJyZW50ID0gb3JpZ2luYWw7XG4gICAgICAgIE9iamVjdC5zZXRQcm90b3R5cGVPZih3cmFwcGVyLCBvcmlnaW5hbCB8fCBGdW5jdGlvbik7XG4gICAgfVxufVxuZXhwb3J0IGZ1bmN0aW9uIGFmdGVyKHByb21pc2UsIGNiKSB7XG4gICAgcmV0dXJuIHByb21pc2UudGhlbihjYiwgY2IpO1xufVxuZXhwb3J0IGZ1bmN0aW9uIHNlcmlhbGl6ZShhc3luY0Z1bmN0aW9uKSB7XG4gICAgbGV0IGxhc3RSdW4gPSBQcm9taXNlLnJlc29sdmUoKTtcbiAgICBmdW5jdGlvbiB3cmFwcGVyKC4uLmFyZ3MpIHtcbiAgICAgICAgcmV0dXJuIGxhc3RSdW4gPSBuZXcgUHJvbWlzZSgocmVzLCByZWopID0+IHtcbiAgICAgICAgICAgIGFmdGVyKGxhc3RSdW4sICgpID0+IHtcbiAgICAgICAgICAgICAgICBhc3luY0Z1bmN0aW9uLmFwcGx5KHRoaXMsIGFyZ3MpLnRoZW4ocmVzLCByZWopO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH0pO1xuICAgIH1cbiAgICB3cmFwcGVyLmFmdGVyID0gZnVuY3Rpb24gKCkge1xuICAgICAgICByZXR1cm4gbGFzdFJ1biA9IG5ldyBQcm9taXNlKChyZXMsIHJlaikgPT4geyBhZnRlcihsYXN0UnVuLCByZXMpOyB9KTtcbiAgICB9O1xuICAgIHJldHVybiB3cmFwcGVyO1xufVxuIiwiaW1wb3J0IHtQbHVnaW4sIFBsYXRmb3JtLCBLZXltYXAsIFNldHRpbmcsIE1vZGFsLCBkZWJvdW5jZX0gZnJvbSBcIm9ic2lkaWFuXCI7XG5pbXBvcnQge2Fyb3VuZCwgc2VyaWFsaXplfSBmcm9tIFwibW9ua2V5LWFyb3VuZFwiO1xuXG5mdW5jdGlvbiBob3RrZXlUb1N0cmluZyhob3RrZXkpIHtcbiAgICByZXR1cm4gS2V5bWFwLmNvbXBpbGVNb2RpZmllcnMoaG90a2V5Lm1vZGlmaWVycykrXCIsXCIgKyBob3RrZXkua2V5LnRvTG93ZXJDYXNlKClcbn1cblxuZnVuY3Rpb24gaXNQbHVnaW5UYWIoaWQpIHtcbiAgICByZXR1cm4gaWQgPT09IFwicGx1Z2luc1wiIHx8IGlkID09PSBcImNvbW11bml0eS1wbHVnaW5zXCI7XG59XG5cbmZ1bmN0aW9uIHBsdWdpblNldHRpbmdzQXJlT3BlbihhcHApIHtcbiAgICByZXR1cm4gc2V0dGluZ3NBcmVPcGVuKGFwcCkgJiYgaXNQbHVnaW5UYWIoYXBwLnNldHRpbmcuYWN0aXZlVGFiPy5pZClcbn1cblxuZnVuY3Rpb24gc2V0dGluZ3NBcmVPcGVuKGFwcCkge1xuICAgIHJldHVybiBhcHAuc2V0dGluZy5jb250YWluZXJFbC5wYXJlbnRFbGVtZW50ICE9PSBudWxsXG59XG5cbmZ1bmN0aW9uIGlzUGx1Z2luVmlld2VyKG9iKSB7XG4gICAgcmV0dXJuIChcbiAgICAgICAgb2IgaW5zdGFuY2VvZiBNb2RhbCAmJlxuICAgICAgICBvYi5oYXNPd25Qcm9wZXJ0eShcImF1dG9sb2FkXCIpICYmXG4gICAgICAgIHR5cGVvZiBvYi5zaG93UGx1Z2luID09PSBcImZ1bmN0aW9uXCIgJiZcbiAgICAgICAgdHlwZW9mIG9iLnVwZGF0ZVNlYXJjaCA9PT0gXCJmdW5jdGlvblwiICYmXG4gICAgICAgIHR5cGVvZiBvYi5zZWFyY2hFbCA9PSBcIm9iamVjdFwiXG4gICAgKTtcbn1cblxuZnVuY3Rpb24gb25FbGVtZW50KGVsLCBldmVudCwgc2VsZWN0b3IsIGNhbGxiYWNrLCBvcHRpb25zPWZhbHNlKSB7XG4gICAgZWwub24oZXZlbnQsIHNlbGVjdG9yLCBjYWxsYmFjaywgb3B0aW9ucylcbiAgICByZXR1cm4gKCkgPT4gZWwub2ZmKGV2ZW50LCBzZWxlY3RvciwgY2FsbGJhY2ssIG9wdGlvbnMpO1xufVxuXG5leHBvcnQgZGVmYXVsdCBjbGFzcyBIb3RrZXlIZWxwZXIgZXh0ZW5kcyBQbHVnaW4ge1xuXG4gICAgb25sb2FkKCkge1xuICAgICAgICBjb25zdCB3b3Jrc3BhY2UgPSB0aGlzLmFwcC53b3Jrc3BhY2UsIHBsdWdpbiA9IHRoaXM7XG4gICAgICAgIHRoaXMubGFzdFNlYXJjaCA9IHt9OyAgIC8vIGxhc3Qgc2VhcmNoIHVzZWQsIGluZGV4ZWQgYnkgdGFiXG5cbiAgICAgICAgdGhpcy5yZWdpc3RlckV2ZW50KCB3b3Jrc3BhY2Uub24oXCJwbHVnaW4tc2V0dGluZ3M6YmVmb3JlLWRpc3BsYXlcIiwgKHNldHRpbmdzVGFiLCB0YWJJZCkgPT4ge1xuICAgICAgICAgICAgdGhpcy5ob3RrZXlCdXR0b25zID0ge307XG4gICAgICAgICAgICB0aGlzLmNvbmZpZ0J1dHRvbnMgPSB7fTtcbiAgICAgICAgICAgIHRoaXMuZ2xvYmFsc0FkZGVkID0gZmFsc2U7XG4gICAgICAgICAgICB0aGlzLnNlYXJjaElucHV0ID0gbnVsbDtcbiAgICAgICAgICAgIGNvbnN0IHJlbW92ZSA9IGFyb3VuZChTZXR0aW5nLnByb3RvdHlwZSwge1xuICAgICAgICAgICAgICAgIGFkZFNlYXJjaChvbGQpIHsgcmV0dXJuIGZ1bmN0aW9uKGYpIHtcbiAgICAgICAgICAgICAgICAgICAgcmVtb3ZlKCk7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBvbGQuY2FsbCh0aGlzLCBpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHBsdWdpbi5zZWFyY2hJbnB1dCA9IGk7IGY/LihpKTtcbiAgICAgICAgICAgICAgICAgICAgfSlcbiAgICAgICAgICAgICAgICB9fVxuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICBzZXRJbW1lZGlhdGUocmVtb3ZlKTtcbiAgICAgICAgfSkgKTtcbiAgICAgICAgdGhpcy5yZWdpc3RlckV2ZW50KCB3b3Jrc3BhY2Uub24oXCJwbHVnaW4tc2V0dGluZ3M6YWZ0ZXItZGlzcGxheVwiLCAgKCkgPT4gdGhpcy5yZWZyZXNoQnV0dG9ucyh0cnVlKSkgKTtcblxuICAgICAgICB0aGlzLnJlZ2lzdGVyRXZlbnQoIHdvcmtzcGFjZS5vbihcInBsdWdpbi1zZXR0aW5nczpwbHVnaW4tY29udHJvbFwiLCAoc2V0dGluZywgbWFuaWZlc3QsIGVuYWJsZWQsIHRhYklkKSA9PiB7XG4gICAgICAgICAgICB0aGlzLmdsb2JhbHNBZGRlZCB8fCB0aGlzLmFkZEdsb2JhbHModGFiSWQsIHNldHRpbmcuc2V0dGluZ0VsKTtcbiAgICAgICAgICAgIHRoaXMuY3JlYXRlRXh0cmFCdXR0b25zKHNldHRpbmcsIG1hbmlmZXN0LCBlbmFibGVkKTtcbiAgICAgICAgfSkgKTtcblxuICAgICAgICAvLyBSZWZyZXNoIHRoZSBidXR0b25zIHdoZW4gY29tbWFuZHMgb3Igc2V0dGluZyB0YWJzIGFyZSBhZGRlZCBvciByZW1vdmVkXG4gICAgICAgIGNvbnN0IHJlcXVlc3RSZWZyZXNoID0gZGVib3VuY2UodGhpcy5yZWZyZXNoQnV0dG9ucy5iaW5kKHRoaXMpLCA1MCwgdHJ1ZSk7XG4gICAgICAgIGZ1bmN0aW9uIHJlZnJlc2hlcihvbGQpIHsgcmV0dXJuIGZ1bmN0aW9uKC4uLmFyZ3MpeyByZXF1ZXN0UmVmcmVzaCgpOyByZXR1cm4gb2xkLmFwcGx5KHRoaXMsIGFyZ3MpOyB9OyB9XG4gICAgICAgIHRoaXMucmVnaXN0ZXIoYXJvdW5kKGFwcC5jb21tYW5kcywge2FkZENvbW1hbmQ6ICAgIHJlZnJlc2hlciwgcmVtb3ZlQ29tbWFuZDogICAgcmVmcmVzaGVyfSkpO1xuICAgICAgICB0aGlzLnJlZ2lzdGVyKGFyb3VuZChhcHAuc2V0dGluZywgIHthZGRQbHVnaW5UYWI6ICByZWZyZXNoZXIsIHJlbW92ZVBsdWdpblRhYjogIHJlZnJlc2hlcn0pKTtcbiAgICAgICAgdGhpcy5yZWdpc3Rlcihhcm91bmQoYXBwLnNldHRpbmcsICB7YWRkU2V0dGluZ1RhYjogcmVmcmVzaGVyLCByZW1vdmVTZXR0aW5nVGFiOiByZWZyZXNoZXJ9KSk7XG5cbiAgICAgICAgd29ya3NwYWNlLm9uTGF5b3V0UmVhZHkodGhpcy53aGVuUmVhZHkuYmluZCh0aGlzKSk7XG4gICAgICAgIHRoaXMucmVnaXN0ZXJPYnNpZGlhblByb3RvY29sSGFuZGxlcihcImdvdG8tcGx1Z2luXCIsICh7aWQsIHNob3d9KSA9PiB7XG4gICAgICAgICAgICB3b3Jrc3BhY2Uub25MYXlvdXRSZWFkeSgoKSA9PiB7IHRoaXMuZ290b1BsdWdpbihpZCwgc2hvdyk7IH0pO1xuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICB3aGVuUmVhZHkoKSB7XG4gICAgICAgIGNvbnN0IGFwcCA9IHRoaXMuYXBwLCBwbHVnaW4gPSB0aGlzO1xuXG4gICAgICAgIC8vIFNhdmUgYW5kIHJlc3RvcmUgY3VycmVudCB0YWIgKHdvcmthcm91bmQgaHR0cHM6Ly9mb3J1bS5vYnNpZGlhbi5tZC90L3NldHRpbmdzLWRpYWxvZy1yZXNldHMtdG8tZmlyc3QtdGFiLWV2ZXJ5LXRpbWUvMTgyNDApXG4gICAgICAgIHRoaXMucmVnaXN0ZXIoYXJvdW5kKGFwcC5zZXR0aW5nLCB7XG4gICAgICAgICAgICBvbk9wZW4ob2xkKSB7IHJldHVybiBmdW5jdGlvbiguLi5hcmdzKSB7XG4gICAgICAgICAgICAgICAgb2xkLmFwcGx5KHRoaXMsIGFyZ3MpO1xuICAgICAgICAgICAgICAgIGlmICghUGxhdGZvcm0uaXNNb2JpbGUgJiYgcGx1Z2luLmxhc3RUYWJJZCkgdGhpcy5vcGVuVGFiQnlJZChwbHVnaW4ubGFzdFRhYklkKTtcbiAgICAgICAgICAgIH19LFxuICAgICAgICAgICAgb25DbG9zZShvbGQpIHsgcmV0dXJuIGZ1bmN0aW9uKC4uLmFyZ3MpIHtcbiAgICAgICAgICAgICAgICBwbHVnaW4ubGFzdFRhYklkID0gdGhpcy5hY3RpdmVUYWI/LmlkO1xuICAgICAgICAgICAgICAgIHJldHVybiBvbGQuYXBwbHkodGhpcywgYXJncyk7XG4gICAgICAgICAgICB9fVxuICAgICAgICB9KSlcblxuICAgICAgICBjb25zdCBjb3JlUGx1Z2lucyA9IHRoaXMuZ2V0U2V0dGluZ3NUYWIoXCJwbHVnaW5zXCIpO1xuICAgICAgICBjb25zdCBjb21tdW5pdHkgICA9IHRoaXMuZ2V0U2V0dGluZ3NUYWIoXCJjb21tdW5pdHktcGx1Z2luc1wiKTtcblxuICAgICAgICAvLyBIb29rIGludG8gdGhlIGRpc3BsYXkoKSBtZXRob2Qgb2YgdGhlIHBsdWdpbiBzZXR0aW5ncyB0YWJzXG4gICAgICAgIGlmIChjb3JlUGx1Z2lucykgdGhpcy5yZWdpc3Rlcihhcm91bmQoY29yZVBsdWdpbnMsIHtkaXNwbGF5OiB0aGlzLmFkZFBsdWdpblNldHRpbmdFdmVudHMuYmluZCh0aGlzLCBjb3JlUGx1Z2lucy5pZCl9KSk7XG4gICAgICAgIGlmIChjb21tdW5pdHkpICAgdGhpcy5yZWdpc3Rlcihhcm91bmQoY29tbXVuaXR5LCAgIHtkaXNwbGF5OiB0aGlzLmFkZFBsdWdpblNldHRpbmdFdmVudHMuYmluZCh0aGlzLCBjb21tdW5pdHkuaWQpfSkpO1xuXG4gICAgICAgIGlmIChjb21tdW5pdHkpICAgdGhpcy5yZWdpc3RlcihcbiAgICAgICAgICAgIC8vIFRyYXAgb3BlbnMgb2YgdGhlIGNvbW11bml0eSBwbHVnaW5zIHZpZXdlclxuICAgICAgICAgICAgb25FbGVtZW50KFxuICAgICAgICAgICAgICAgIGNvbW11bml0eS5jb250YWluZXJFbCwgXCJjbGlja1wiLFxuICAgICAgICAgICAgICAgIFwiLm1vZC1jdGEsIC5pbnN0YWxsZWQtcGx1Z2lucy1jb250YWluZXIgLnNldHRpbmctaXRlbS1pbmZvXCIsXG4gICAgICAgICAgICAgICAgKCkgPT4gdGhpcy5lbmhhbmNlVmlld2VyKCksXG4gICAgICAgICAgICAgICAgdHJ1ZVxuICAgICAgICAgICAgKVxuICAgICAgICApO1xuXG4gICAgICAgIC8vIE5vdyBmb3JjZSBhIHJlZnJlc2ggaWYgZWl0aGVyIHBsdWdpbnMgdGFiIGlzIGN1cnJlbnRseSB2aXNpYmxlICh0byBzaG93IG91ciBuZXcgYnV0dG9ucylcbiAgICAgICAgZnVuY3Rpb24gcmVmcmVzaFRhYklmT3BlbigpIHtcbiAgICAgICAgICAgIGlmIChwbHVnaW5TZXR0aW5nc0FyZU9wZW4oYXBwKSkgYXBwLnNldHRpbmcub3BlblRhYkJ5SWQoYXBwLnNldHRpbmcuYWN0aXZlVGFiLmlkKTtcbiAgICAgICAgfVxuICAgICAgICByZWZyZXNoVGFiSWZPcGVuKCk7XG5cbiAgICAgICAgLy8gQW5kIGRvIGl0IGFnYWluIGFmdGVyIHdlIHVubG9hZCAodG8gcmVtb3ZlIHRoZSBvbGQgYnV0dG9ucylcbiAgICAgICAgdGhpcy5yZWdpc3RlcigoKSA9PiBzZXRJbW1lZGlhdGUocmVmcmVzaFRhYklmT3BlbikpO1xuXG4gICAgICAgIC8vIFR3ZWFrIHRoZSBob3RrZXkgc2V0dGluZ3MgdGFiIHRvIG1ha2UgZmlsdGVyaW5nIHdvcmsgb24gaWQgcHJlZml4ZXMgYXMgd2VsbCBhcyBjb21tYW5kIG5hbWVzXG4gICAgICAgIGNvbnN0IGhvdGtleXNUYWIgPSB0aGlzLmdldFNldHRpbmdzVGFiKFwiaG90a2V5c1wiKTtcbiAgICAgICAgaWYgKGhvdGtleXNUYWIpIHtcbiAgICAgICAgICAgIHRoaXMucmVnaXN0ZXIoYXJvdW5kKGhvdGtleXNUYWIsIHtcbiAgICAgICAgICAgICAgICBkaXNwbGF5KG9sZCkgeyByZXR1cm4gZnVuY3Rpb24oKSB7IG9sZC5jYWxsKHRoaXMpOyB0aGlzLnNlYXJjaElucHV0RWwuZm9jdXMoKTsgfTsgfSxcbiAgICAgICAgICAgICAgICB1cGRhdGVIb3RrZXlWaXNpYmlsaXR5KG9sZCkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gZnVuY3Rpb24oKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBvbGRTZWFyY2ggPSB0aGlzLnNlYXJjaElucHV0RWwudmFsdWUsIG9sZENvbW1hbmRzID0gYXBwLmNvbW1hbmRzLmNvbW1hbmRzO1xuICAgICAgICAgICAgICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAob2xkU2VhcmNoLmVuZHNXaXRoKFwiOlwiKSAmJiAhb2xkU2VhcmNoLmNvbnRhaW5zKFwiIFwiKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAvLyBUaGlzIGlzIGFuIGluY3JlZGlibHkgdWdseSBoYWNrIHRoYXQgcmVsaWVzIG9uIHVwZGF0ZUhvdGtleVZpc2liaWxpdHkoKSBpdGVyYXRpbmcgYXBwLmNvbW1hbmRzLmNvbW1hbmRzXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC8vIGxvb2tpbmcgZm9yIGhvdGtleSBjb25mbGljdHMgKmJlZm9yZSogYW55dGhpbmcgZWxzZS5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGN1cnJlbnQgPSBvbGRDb21tYW5kcztcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGZpbHRlcmVkID0gT2JqZWN0LmZyb21FbnRyaWVzKE9iamVjdC5lbnRyaWVzKGFwcC5jb21tYW5kcy5jb21tYW5kcykuZmlsdGVyKFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgKFtpZCwgY21kXSkgPT4gKGlkK1wiOlwiKS5zdGFydHNXaXRoKG9sZFNlYXJjaClcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgKSk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuc2VhcmNoSW5wdXRFbC52YWx1ZSA9IFwiXCI7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFwcC5jb21tYW5kcy5jb21tYW5kcyA9IG5ldyBQcm94eShvbGRDb21tYW5kcywge293bktleXMoKXtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC8vIFRoZSBmaXJzdCB0aW1lIGNvbW1hbmRzIGFyZSBpdGVyYXRlZCwgcmV0dXJuIHRoZSB3aG9sZSB0aGluZztcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC8vIGFmdGVyIHRoYXQsIHJldHVybiB0aGUgZmlsdGVyZWQgbGlzdFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHJ5IHsgcmV0dXJuIE9iamVjdC5rZXlzKGN1cnJlbnQpOyB9IGZpbmFsbHkgeyBjdXJyZW50ID0gZmlsdGVyZWQ7IH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfX0pO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gb2xkLmNhbGwodGhpcyk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9IGZpbmFsbHkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuc2VhcmNoSW5wdXRFbC52YWx1ZSA9IG9sZFNlYXJjaDtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBhcHAuY29tbWFuZHMuY29tbWFuZHMgPSBvbGRDb21tYW5kcztcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0pKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIGNyZWF0ZUV4dHJhQnV0dG9ucyhzZXR0aW5nLCBtYW5pZmVzdCwgZW5hYmxlZCkge1xuICAgICAgICBzZXR0aW5nLmFkZEV4dHJhQnV0dG9uKGJ0biA9PiB7XG4gICAgICAgICAgICBidG4uc2V0SWNvbihcImdlYXJcIik7XG4gICAgICAgICAgICBidG4ub25DbGljaygoKSA9PiB0aGlzLnNob3dDb25maWdGb3IobWFuaWZlc3QuaWQucmVwbGFjZSgvXndvcmtzcGFjZSQvLFwiZmlsZVwiKSkpO1xuICAgICAgICAgICAgYnRuLnNldFRvb2x0aXAoXCJPcHRpb25zXCIpO1xuICAgICAgICAgICAgYnRuLmV4dHJhU2V0dGluZ3NFbC50b2dnbGUoZW5hYmxlZClcbiAgICAgICAgICAgIHRoaXMuY29uZmlnQnV0dG9uc1ttYW5pZmVzdC5pZF0gPSBidG47XG4gICAgICAgIH0pO1xuICAgICAgICBzZXR0aW5nLmFkZEV4dHJhQnV0dG9uKGJ0biA9PiB7XG4gICAgICAgICAgICBidG4uc2V0SWNvbihcImFueS1rZXlcIik7XG4gICAgICAgICAgICBidG4ub25DbGljaygoKSA9PiB0aGlzLnNob3dIb3RrZXlzRm9yKG1hbmlmZXN0LmlkK1wiOlwiKSlcbiAgICAgICAgICAgIGJ0bi5leHRyYVNldHRpbmdzRWwudG9nZ2xlKGVuYWJsZWQpXG4gICAgICAgICAgICB0aGlzLmhvdGtleUJ1dHRvbnNbbWFuaWZlc3QuaWRdID0gYnRuO1xuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICAvLyBBZGQgdG9wLWxldmVsIGl0ZW1zIChzZWFyY2ggYW5kIHBzZXVkby1wbHVnaW5zKVxuICAgIGFkZEdsb2JhbHModGFiSWQsIHNldHRpbmdFbCkge1xuICAgICAgICB0aGlzLmdsb2JhbHNBZGRlZCA9IHRydWU7XG5cbiAgICAgICAgLy8gQWRkIGEgc2VhcmNoIGZpbHRlciB0byBzaHJpbmsgcGx1Z2luIGxpc3RcbiAgICAgICAgY29uc3QgY29udGFpbmVyRWwgPSBzZXR0aW5nRWwucGFyZW50RWxlbWVudDtcbiAgICAgICAgbGV0IHNlYXJjaEVsO1xuICAgICAgICBpZiAodGFiSWQgIT09IFwicGx1Z2luc1wiKSB7XG4gICAgICAgICAgICAvLyBSZXBsYWNlIHRoZSBidWlsdC1pbiBzZWFyY2ggaGFuZGxlclxuICAgICAgICAgICAgKHNlYXJjaEVsID0gdGhpcy5zZWFyY2hJbnB1dCk/Lm9uQ2hhbmdlKGNoYW5nZUhhbmRsZXIpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgY29uc3QgdG1wID0gbmV3IFNldHRpbmcoY29udGFpbmVyRWwpLmFkZFNlYXJjaChzID0+IHtcbiAgICAgICAgICAgICAgICBzZWFyY2hFbCA9IHM7XG4gICAgICAgICAgICAgICAgcy5zZXRQbGFjZWhvbGRlcihcIkZpbHRlciBwbHVnaW5zLi4uXCIpLm9uQ2hhbmdlKGNoYW5nZUhhbmRsZXIpO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICBzZWFyY2hFbC5jb250YWluZXJFbC5zdHlsZS5tYXJnaW4gPSAwO1xuICAgICAgICAgICAgY29udGFpbmVyRWwuY3JlYXRlRGl2KFwiaG90a2V5LXNlYXJjaC1jb250YWluZXJcIikuYXBwZW5kKHNlYXJjaEVsLmNvbnRhaW5lckVsKTtcbiAgICAgICAgICAgIHRtcC5zZXR0aW5nRWwuZGV0YWNoKCk7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgcGx1Z2luID0gdGhpcztcbiAgICAgICAgZnVuY3Rpb24gY2hhbmdlSGFuZGxlcihzZWVrKXtcbiAgICAgICAgICAgIGNvbnN0IGZpbmQgPSAocGx1Z2luLmxhc3RTZWFyY2hbdGFiSWRdID0gc2VlaykudG9Mb3dlckNhc2UoKTtcbiAgICAgICAgICAgIGZ1bmN0aW9uIG1hdGNoQW5kSGlnaGxpZ2h0KGVsKSB7XG4gICAgICAgICAgICAgICAgY29uc3QgdGV4dCA9IGVsLnRleHRDb250ZW50ID0gZWwudGV4dENvbnRlbnQ7IC8vIGNsZWFyIHByZXZpb3VzIGhpZ2hsaWdodGluZywgaWYgYW55XG4gICAgICAgICAgICAgICAgY29uc3QgaW5kZXggPSB0ZXh0LnRvTG93ZXJDYXNlKCkuaW5kZXhPZihmaW5kKTtcbiAgICAgICAgICAgICAgICBpZiAoIX5pbmRleCkgcmV0dXJuIGZhbHNlO1xuICAgICAgICAgICAgICAgIGVsLnRleHRDb250ZW50ID0gdGV4dC5zdWJzdHIoMCwgaW5kZXgpO1xuICAgICAgICAgICAgICAgIGVsLmNyZWF0ZVNwYW4oXCJzdWdnZXN0aW9uLWhpZ2hsaWdodFwiKS50ZXh0Q29udGVudCA9IHRleHQuc3Vic3RyKGluZGV4LCBmaW5kLmxlbmd0aCk7XG4gICAgICAgICAgICAgICAgZWwuaW5zZXJ0QWRqYWNlbnRUZXh0KFwiYmVmb3JlZW5kXCIsIHRleHQuc3Vic3RyKGluZGV4K2ZpbmQubGVuZ3RoKSlcbiAgICAgICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNvbnRhaW5lckVsLmZpbmRBbGwoXCIuc2V0dGluZy1pdGVtXCIpLmZvckVhY2goZSA9PiB7XG4gICAgICAgICAgICAgICAgY29uc3QgbmFtZU1hdGNoZXMgPSBtYXRjaEFuZEhpZ2hsaWdodChlLmZpbmQoXCIuc2V0dGluZy1pdGVtLW5hbWVcIikpO1xuICAgICAgICAgICAgICAgIGNvbnN0IGRlc2NNYXRjaGVzID0gbWF0Y2hBbmRIaWdobGlnaHQoXG4gICAgICAgICAgICAgICAgICAgIGUuZmluZChcIi5zZXR0aW5nLWl0ZW0tZGVzY3JpcHRpb24gPiBkaXY6bGFzdC1jaGlsZFwiKSA/P1xuICAgICAgICAgICAgICAgICAgICBlLmZpbmQoXCIuc2V0dGluZy1pdGVtLWRlc2NyaXB0aW9uXCIpXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICBlLnRvZ2dsZShuYW1lTWF0Y2hlcyB8fCBkZXNjTWF0Y2hlcyk7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgICAgICBzZXRJbW1lZGlhdGUoKCkgPT4ge1xuICAgICAgICAgICAgaWYgKCFzZWFyY2hFbCkgcmV0dXJuXG4gICAgICAgICAgICBpZiAoc2VhcmNoRWwgJiYgdHlwZW9mIHBsdWdpbi5sYXN0U2VhcmNoW3RhYklkXSA9PT0gXCJzdHJpbmdcIikge1xuICAgICAgICAgICAgICAgIHNlYXJjaEVsLnNldFZhbHVlKHBsdWdpbi5sYXN0U2VhcmNoW3RhYklkXSk7XG4gICAgICAgICAgICAgICAgc2VhcmNoRWwub25DaGFuZ2VkKCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAoIVBsYXRmb3JtLmlzTW9iaWxlKSBzZWFyY2hFbC5pbnB1dEVsLnNlbGVjdCgpO1xuICAgICAgICB9KTtcbiAgICAgICAgY29udGFpbmVyRWwuYXBwZW5kKHNldHRpbmdFbCk7XG5cbiAgICAgICAgaWYgKHRhYklkID09PSBcInBsdWdpbnNcIikge1xuICAgICAgICAgICAgY29uc3QgZWRpdG9yTmFtZSAgICA9IHRoaXMuZ2V0U2V0dGluZ3NUYWIoXCJlZGl0b3JcIik/Lm5hbWUgfHwgXCJFZGl0b3JcIjtcbiAgICAgICAgICAgIGNvbnN0IHdvcmtzcGFjZU5hbWUgPSB0aGlzLmdldFNldHRpbmdzVGFiKFwiZmlsZVwiKT8ubmFtZSAgIHx8IFwiRmlsZXMgJiBMaW5rc1wiO1xuICAgICAgICAgICAgdGhpcy5jcmVhdGVFeHRyYUJ1dHRvbnMoXG4gICAgICAgICAgICAgICAgbmV3IFNldHRpbmcoc2V0dGluZ0VsLnBhcmVudEVsZW1lbnQpXG4gICAgICAgICAgICAgICAgICAgIC5zZXROYW1lKFwiQXBwXCIpLnNldERlc2MoXCJNaXNjZWxsYW5lb3VzIGFwcGxpY2F0aW9uIGNvbW1hbmRzIChhbHdheXMgZW5hYmxlZClcIiksXG4gICAgICAgICAgICAgICAge2lkOiBcImFwcFwiLCBuYW1lOiBcIkFwcFwifSwgdHJ1ZVxuICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIHRoaXMuY3JlYXRlRXh0cmFCdXR0b25zKFxuICAgICAgICAgICAgICAgIG5ldyBTZXR0aW5nKHNldHRpbmdFbC5wYXJlbnRFbGVtZW50KVxuICAgICAgICAgICAgICAgICAgICAuc2V0TmFtZShlZGl0b3JOYW1lKS5zZXREZXNjKFwiQ29yZSBlZGl0aW5nIGNvbW1hbmRzIChhbHdheXMgZW5hYmxlZClcIiksXG4gICAgICAgICAgICAgICAge2lkOiBcImVkaXRvclwiLCBuYW1lOiBlZGl0b3JOYW1lfSwgdHJ1ZVxuICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIHRoaXMuY3JlYXRlRXh0cmFCdXR0b25zKFxuICAgICAgICAgICAgICAgIG5ldyBTZXR0aW5nKHNldHRpbmdFbC5wYXJlbnRFbGVtZW50KVxuICAgICAgICAgICAgICAgICAgICAuc2V0TmFtZSh3b3Jrc3BhY2VOYW1lKS5zZXREZXNjKFwiQ29yZSBmaWxlIGFuZCBwYW5lIG1hbmFnZW1lbnQgY29tbWFuZHMgKGFsd2F5cyBlbmFibGVkKVwiKSxcbiAgICAgICAgICAgICAgICB7aWQ6IFwid29ya3NwYWNlXCIsIG5hbWU6IHdvcmtzcGFjZU5hbWV9LCB0cnVlXG4gICAgICAgICAgICApO1xuICAgICAgICAgICAgc2V0dGluZ0VsLnBhcmVudEVsZW1lbnQuYXBwZW5kKHNldHRpbmdFbCk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBlbmhhbmNlVmlld2VyKCkge1xuICAgICAgICBjb25zdCBwbHVnaW4gPSB0aGlzO1xuICAgICAgICBzZXRJbW1lZGlhdGUoYXJvdW5kKE1vZGFsLnByb3RvdHlwZSwge1xuICAgICAgICAgICAgb3BlbihvbGQpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gZnVuY3Rpb24oLi4uYXJncykge1xuICAgICAgICAgICAgICAgICAgICBpZiAoaXNQbHVnaW5WaWV3ZXIodGhpcykpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHNldEltbWVkaWF0ZSgoKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHBsdWdpbi5sYXN0U2VhcmNoW1wiY29tbXVuaXR5LXBsdWdpbnNcIl0pIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLy8gRGV0YWNoIHRoZSBvbGQgc2VhcmNoIGFyZWEsIGluIGNhc2UgdGhlIGVtcHR5IHNlYXJjaCBpcyBzdGlsbCBydW5uaW5nXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IG5ld1Jlc3VsdHMgPSB0aGlzLnNlYXJjaFJlc3VsdEVsLmNsb25lTm9kZSgpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aGlzLnNlYXJjaENvbnRhaW5lckVsLnJlcGxhY2VDaGlsZChuZXdSZXN1bHRzLCB0aGlzLnNlYXJjaFJlc3VsdEVsKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5zZWFyY2hSZXN1bHRFbCA9IG5ld1Jlc3VsdHM7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC8vIEZvcmNlIGFuIHVwZGF0ZTsgdXNlIGFuIGV2ZW50IHNvIHRoYXQgdGhlIFwieFwiIGFwcGVhcnMgb24gc2VhcmNoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuc2VhcmNoRWwudmFsdWUgPSBwbHVnaW4ubGFzdFNlYXJjaFtcImNvbW11bml0eS1wbHVnaW5zXCJdO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aGlzLnNlYXJjaEVsLmRpc3BhdGNoRXZlbnQobmV3IEV2ZW50KCdpbnB1dCcpKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5zZWFyY2hFbC5zZWxlY3QoKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICAgICAgcGx1Z2luLmN1cnJlbnRWaWV3ZXIgPSB0aGlzO1xuICAgICAgICAgICAgICAgICAgICAgICAgYXJvdW5kKHRoaXMsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB1cGRhdGVTZWFyY2g6IHNlcmlhbGl6ZSwgIC8vIHByZXZlbnQgcmFjZSBjb25kaXRpb25zXG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjbG9zZShvbGQpIHsgcmV0dXJuIGZ1bmN0aW9uKC4uLmFyZ3MpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcGx1Z2luLmN1cnJlbnRWaWV3ZXIgPSBudWxsO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gb2xkLmFwcGx5KHRoaXMsIGFyZ3MpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH19LFxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgc2hvd1BsdWdpbihvbGQpIHsgcmV0dXJuIGFzeW5jIGZ1bmN0aW9uKG1hbmlmZXN0KXtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgcmVzID0gYXdhaXQgb2xkLmNhbGwodGhpcywgbWFuaWZlc3QpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAocGx1Z2luLmFwcC5wbHVnaW5zLnBsdWdpbnNbbWFuaWZlc3QuaWRdKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBidXR0b25zID0gdGhpcy5wbHVnaW5Db250ZW50RWwuZmluZChcImJ1dHRvblwiKS5wYXJlbnRFbGVtZW50O1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29uc3Qga2V5QnRuID0gYnV0dG9ucy5jcmVhdGVFbChcImJ1dHRvblwiLCB7cHJlcGVuZDogdHJ1ZSwgdGV4dDogXCJIb3RrZXlzXCJ9KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IGNmZ0J0biA9IGJ1dHRvbnMuY3JlYXRlRWwoXCJidXR0b25cIiwge3ByZXBlbmQ6IHRydWUsIHRleHQ6IFwiT3B0aW9uc1wifSk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwbHVnaW4uaG90a2V5QnV0dG9uc1ttYW5pZmVzdC5pZF0gPSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgc2V0VG9vbHRpcCh0aXApIHtrZXlCdG4udGl0bGUgPSB0aXB9LCBleHRyYVNldHRpbmdzRWw6IGtleUJ0blxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcGx1Z2luLmNvbmZpZ0J1dHRvbnNbbWFuaWZlc3QuaWRdID0ge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNldFRvb2x0aXAoKSB7fSwgZXh0cmFTZXR0aW5nc0VsOiBjZmdCdG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBsdWdpbi5yZWZyZXNoQnV0dG9ucyh0cnVlKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGtleUJ0bi5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgICgpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aGlzLmNsb3NlKCk7IHBsdWdpbi5zaG93SG90a2V5c0ZvcihtYW5pZmVzdC5pZCtcIjpcIik7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNmZ0J0bi5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgICgpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aGlzLmNsb3NlKCk7IHBsdWdpbi5zaG93Q29uZmlnRm9yKG1hbmlmZXN0LmlkKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiByZXM7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfX1cbiAgICAgICAgICAgICAgICAgICAgICAgIH0pXG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIG9sZC5hcHBseSh0aGlzLCBhcmdzKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pKTtcbiAgICB9XG5cbiAgICBnZXRTZXR0aW5nc1RhYihpZCkgeyByZXR1cm4gdGhpcy5hcHAuc2V0dGluZy5zZXR0aW5nVGFicy5maWx0ZXIodCA9PiB0LmlkID09PSBpZCkuc2hpZnQoKTsgfVxuXG4gICAgYWRkUGx1Z2luU2V0dGluZ0V2ZW50cyh0YWJJZCwgb2xkKSB7XG4gICAgICAgIGNvbnN0IGFwcCA9IHRoaXMuYXBwO1xuICAgICAgICBsZXQgaW5fZXZlbnQgPSBmYWxzZTtcblxuICAgICAgICBmdW5jdGlvbiB0cmlnZ2VyKC4uLmFyZ3MpIHtcbiAgICAgICAgICAgIGluX2V2ZW50ID0gdHJ1ZTtcbiAgICAgICAgICAgIHRyeSB7IGFwcC53b3Jrc3BhY2UudHJpZ2dlciguLi5hcmdzKTsgfSBjYXRjaChlKSB7IGNvbnNvbGUuZXJyb3IoZSk7IH1cbiAgICAgICAgICAgIGluX2V2ZW50ID0gZmFsc2U7XG4gICAgICAgIH1cblxuICAgICAgICAvLyBXcmFwcGVyIHRvIGFkZCBwbHVnaW4tc2V0dGluZ3MgZXZlbnRzXG4gICAgICAgIHJldHVybiBmdW5jdGlvbiBkaXNwbGF5KC4uLmFyZ3MpIHtcbiAgICAgICAgICAgIGlmIChpbl9ldmVudCkgcmV0dXJuO1xuICAgICAgICAgICAgdHJpZ2dlcihcInBsdWdpbi1zZXR0aW5nczpiZWZvcmUtZGlzcGxheVwiLCB0aGlzLCB0YWJJZCk7XG5cbiAgICAgICAgICAgIC8vIFRyYWNrIHdoaWNoIHBsdWdpbiBlYWNoIHNldHRpbmcgaXMgZm9yXG4gICAgICAgICAgICBsZXQgbWFuaWZlc3RzO1xuICAgICAgICAgICAgaWYgKHRhYklkID09PSBcInBsdWdpbnNcIikge1xuICAgICAgICAgICAgICAgIG1hbmlmZXN0cyA9IE9iamVjdC5lbnRyaWVzKGFwcC5pbnRlcm5hbFBsdWdpbnMucGx1Z2lucykubWFwKFxuICAgICAgICAgICAgICAgICAgICAoW2lkLCB7aW5zdGFuY2U6IHtuYW1lfSwgX2xvYWRlZDplbmFibGVkfV0pID0+IHtyZXR1cm4ge2lkLCBuYW1lLCBlbmFibGVkfTt9XG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgbWFuaWZlc3RzID0gT2JqZWN0LnZhbHVlcyhhcHAucGx1Z2lucy5tYW5pZmVzdHMpO1xuICAgICAgICAgICAgICAgIG1hbmlmZXN0cy5zb3J0KChlLCB0KSA9PiBlLm5hbWUubG9jYWxlQ29tcGFyZSh0Lm5hbWUpKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGxldCB3aGljaCA9IDA7XG5cbiAgICAgICAgICAgIC8vIFRyYXAgdGhlIGFkZGl0aW9uIG9mIHRoZSBcInVuaW5zdGFsbFwiIGJ1dHRvbnMgbmV4dCB0byBlYWNoIHBsdWdpblxuICAgICAgICAgICAgY29uc3QgcmVtb3ZlID0gYXJvdW5kKFNldHRpbmcucHJvdG90eXBlLCB7XG4gICAgICAgICAgICAgICAgYWRkVG9nZ2xlKG9sZCkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gZnVuY3Rpb24oLi4uYXJncykge1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHRhYklkID09PSBcInBsdWdpbnNcIiAmJiAhaW5fZXZlbnQgJiYgKG1hbmlmZXN0c1t3aGljaF18fHt9KS5uYW1lID09PSB0aGlzLm5hbWVFbC50ZXh0Q29udGVudCApIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBtYW5pZmVzdCA9IG1hbmlmZXN0c1t3aGljaCsrXTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0cmlnZ2VyKFwicGx1Z2luLXNldHRpbmdzOnBsdWdpbi1jb250cm9sXCIsIHRoaXMsIG1hbmlmZXN0LCBtYW5pZmVzdC5lbmFibGVkLCB0YWJJZCk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gb2xkLmFwcGx5KHRoaXMsIGFyZ3MpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICBhZGRFeHRyYUJ1dHRvbihvbGQpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGZ1bmN0aW9uKC4uLmFyZ3MpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vIFRoZSBvbmx5IFwiZXh0cmFzXCIgYWRkZWQgdG8gc2V0dGluZ3Mgdy9hIGRlc2NyaXB0aW9uIGFyZSBvbiB0aGUgcGx1Z2lucywgY3VycmVudGx5LFxuICAgICAgICAgICAgICAgICAgICAgICAgLy8gc28gb25seSB0cnkgdG8gbWF0Y2ggdGhvc2UgdG8gcGx1Z2luIG5hbWVzXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAodGFiSWQgIT09IFwicGx1Z2luc1wiICYmIHRoaXMuZGVzY0VsLmNoaWxkRWxlbWVudENvdW50ICYmICFpbl9ldmVudCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICggKG1hbmlmZXN0c1t3aGljaF18fHt9KS5uYW1lID09PSB0aGlzLm5hbWVFbC50ZXh0Q29udGVudCApIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgbWFuaWZlc3QgPSBtYW5pZmVzdHNbd2hpY2grK10sIGVuYWJsZWQgPSAhIWFwcC5wbHVnaW5zLnBsdWdpbnNbbWFuaWZlc3QuaWRdO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0cmlnZ2VyKFwicGx1Z2luLXNldHRpbmdzOnBsdWdpbi1jb250cm9sXCIsIHRoaXMsIG1hbmlmZXN0LCBlbmFibGVkLCB0YWJJZCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgfTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiBvbGQuYXBwbHkodGhpcywgYXJncyk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICByZXR1cm4gb2xkLmFwcGx5KHRoaXMsIGFyZ3MpO1xuICAgICAgICAgICAgfSBmaW5hbGx5IHtcbiAgICAgICAgICAgICAgICByZW1vdmUoKTtcbiAgICAgICAgICAgICAgICB0cmlnZ2VyKFwicGx1Z2luLXNldHRpbmdzOmFmdGVyLWRpc3BsYXlcIiwgdGhpcyk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBnb3RvUGx1Z2luKGlkLCBzaG93PVwiaW5mb1wiKSB7XG4gICAgICAgIGlmIChpZCAmJiBzaG93ID09PSBcImhvdGtleXNcIikgcmV0dXJuIHRoaXMuc2hvd0hvdGtleXNGb3IoaWQrXCI6XCIpO1xuICAgICAgICBpZiAoaWQgJiYgc2hvdyA9PT0gXCJjb25maWdcIikgIHtcbiAgICAgICAgICAgIGlmICghdGhpcy5zaG93Q29uZmlnRm9yKGlkKSkgdGhpcy5hcHAuc2V0dGluZy5jbG9zZSgpO1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG5cbiAgICAgICAgdGhpcy5zaG93U2V0dGluZ3MoXCJjb21tdW5pdHktcGx1Z2luc1wiKTtcbiAgICAgICAgY29uc3QgcmVtb3ZlID0gYXJvdW5kKE1vZGFsLnByb3RvdHlwZSwge1xuICAgICAgICAgICAgb3BlbihvbGQpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gZnVuY3Rpb24oLi4uYXJncykge1xuICAgICAgICAgICAgICAgICAgICByZW1vdmUoKTtcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5hdXRvbG9hZCA9IGlkO1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gb2xkLmFwcGx5KHRoaXMsIGFyZ3MpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfSlcbiAgICAgICAgdGhpcy5hcHAuc2V0dGluZy5hY3RpdmVUYWIuY29udGFpbmVyRWwuZmluZChcIi5tb2QtY3RhXCIpLmNsaWNrKCk7XG4gICAgICAgIC8vIFhYWCBoYW5kbGUgbmF2IHRvIG5vdC1pbnN0YWxsZWQgcGx1Z2luXG4gICAgfVxuXG4gICAgc2hvd1NldHRpbmdzKGlkKSB7XG4gICAgICAgIHRoaXMuY3VycmVudFZpZXdlcj8uY2xvc2UoKTsgIC8vIGNsb3NlIHRoZSBwbHVnaW4gYnJvd3NlciBpZiBvcGVuXG4gICAgICAgIHNldHRpbmdzQXJlT3Blbih0aGlzLmFwcCkgfHwgdGhpcy5hcHAuc2V0dGluZy5vcGVuKCk7XG4gICAgICAgIGlmIChpZCkge1xuICAgICAgICAgICAgdGhpcy5hcHAuc2V0dGluZy5vcGVuVGFiQnlJZChpZCk7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5hcHAuc2V0dGluZy5hY3RpdmVUYWI/LmlkID09PSBpZCA/IHRoaXMuYXBwLnNldHRpbmcuYWN0aXZlVGFiIDogZmFsc2VcbiAgICAgICAgfVxuICAgIH1cblxuICAgIHNob3dIb3RrZXlzRm9yKHNlYXJjaCkge1xuICAgICAgICBjb25zdCB0YWIgPSB0aGlzLnNob3dTZXR0aW5ncyhcImhvdGtleXNcIik7XG4gICAgICAgIGlmICh0YWIgJiYgdGFiLnNlYXJjaElucHV0RWwgJiYgdGFiLnVwZGF0ZUhvdGtleVZpc2liaWxpdHkpIHtcbiAgICAgICAgICAgIHRhYi5zZWFyY2hJbnB1dEVsLnZhbHVlID0gc2VhcmNoO1xuICAgICAgICAgICAgdGFiLnVwZGF0ZUhvdGtleVZpc2liaWxpdHkoKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIHNob3dDb25maWdGb3IoaWQpIHtcbiAgICAgICAgaWYgKHRoaXMuc2hvd1NldHRpbmdzKGlkKSkgcmV0dXJuIHRydWU7XG4gICAgICAgIG5ldyBOb3RpY2UoXG4gICAgICAgICAgICBgTm8gc2V0dGluZ3MgdGFiIGZvciBcIiR7aWR9XCI6IGl0IG1heSBub3QgYmUgaW5zdGFsbGVkIG9yIG1pZ2h0IG5vdCBoYXZlIHNldHRpbmdzLmBcbiAgICAgICAgKTtcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cblxuICAgIHBsdWdpbkVuYWJsZWQoaWQpIHtcbiAgICAgICAgcmV0dXJuIHRoaXMuYXBwLmludGVybmFsUGx1Z2lucy5wbHVnaW5zW2lkXT8uX2xvYWRlZCB8fCB0aGlzLmFwcC5wbHVnaW5zLnBsdWdpbnNbaWRdO1xuICAgIH1cblxuICAgIHJlZnJlc2hCdXR0b25zKGZvcmNlPWZhbHNlKSB7XG4gICAgICAgIC8vIERvbid0IHJlZnJlc2ggd2hlbiBub3QgZGlzcGxheWluZywgdW5sZXNzIHJlbmRlcmluZyBpcyBpbiBwcm9ncmVzc1xuICAgICAgICBpZiAoIXBsdWdpblNldHRpbmdzQXJlT3Blbih0aGlzLmFwcCkgJiYgIWZvcmNlKSByZXR1cm47XG5cbiAgICAgICAgY29uc3QgaGttID0gdGhpcy5hcHAuaG90a2V5TWFuYWdlcjtcbiAgICAgICAgY29uc3QgYXNzaWduZWRLZXlDb3VudCA9IHt9O1xuXG4gICAgICAgIC8vIEdldCBhIGxpc3Qgb2YgY29tbWFuZHMgYnkgcGx1Z2luXG4gICAgICAgIGNvbnN0IGNvbW1hbmRzID0gT2JqZWN0LnZhbHVlcyh0aGlzLmFwcC5jb21tYW5kcy5jb21tYW5kcykucmVkdWNlKChjbWRzLCBjbWQpPT57XG4gICAgICAgICAgICBjb25zdCBwaWQgPSBjbWQuaWQuc3BsaXQoXCI6XCIsMikuc2hpZnQoKTtcbiAgICAgICAgICAgIGNvbnN0IGhvdGtleXMgPSAoaGttLmdldEhvdGtleXMoY21kLmlkKSB8fCBoa20uZ2V0RGVmYXVsdEhvdGtleXMoY21kLmlkKSB8fCBbXSkubWFwKGhvdGtleVRvU3RyaW5nKTtcbiAgICAgICAgICAgIGhvdGtleXMuZm9yRWFjaChrID0+IGFzc2lnbmVkS2V5Q291bnRba10gPSAxICsgKGFzc2lnbmVkS2V5Q291bnRba118fDApKTtcbiAgICAgICAgICAgIChjbWRzW3BpZF0gfHwgKGNtZHNbcGlkXT1bXSkpLnB1c2goe2hvdGtleXMsIGNtZH0pO1xuICAgICAgICAgICAgcmV0dXJuIGNtZHM7XG4gICAgICAgIH0sIHt9KTtcblxuICAgICAgICAvLyBQbHVnaW4gc2V0dGluZyB0YWJzIGJ5IHBsdWdpblxuICAgICAgICBjb25zdCB0YWJzID0gT2JqZWN0LnZhbHVlcyh0aGlzLmFwcC5zZXR0aW5nLnBsdWdpblRhYnMpLnJlZHVjZSgodGFicywgdGFiKT0+IHtcbiAgICAgICAgICAgIHRhYnNbdGFiLmlkXSA9IHRhYjsgcmV0dXJuIHRhYnNcbiAgICAgICAgfSwge30pO1xuICAgICAgICB0YWJzW1wid29ya3NwYWNlXCJdID0gdGFic1tcImVkaXRvclwiXSA9IHRydWU7XG5cbiAgICAgICAgZm9yKGNvbnN0IGlkIG9mIE9iamVjdC5rZXlzKHRoaXMuY29uZmlnQnV0dG9ucyB8fCB7fSkpIHtcbiAgICAgICAgICAgIGNvbnN0IGJ0biA9IHRoaXMuY29uZmlnQnV0dG9uc1tpZF07XG4gICAgICAgICAgICBpZiAoIXRhYnNbaWRdKSB7XG4gICAgICAgICAgICAgICAgYnRuLmV4dHJhU2V0dGluZ3NFbC5oaWRlKCk7XG4gICAgICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBidG4uZXh0cmFTZXR0aW5nc0VsLnNob3coKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGZvcihjb25zdCBpZCBvZiBPYmplY3Qua2V5cyh0aGlzLmhvdGtleUJ1dHRvbnMgfHwge30pKSB7XG4gICAgICAgICAgICBjb25zdCBidG4gPSB0aGlzLmhvdGtleUJ1dHRvbnNbaWRdO1xuICAgICAgICAgICAgaWYgKCFjb21tYW5kc1tpZF0pIHtcbiAgICAgICAgICAgICAgICAvLyBQbHVnaW4gaXMgZGlzYWJsZWQgb3IgaGFzIG5vIGNvbW1hbmRzXG4gICAgICAgICAgICAgICAgYnRuLmV4dHJhU2V0dGluZ3NFbC5oaWRlKCk7XG4gICAgICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjb25zdCBhc3NpZ25lZCA9IGNvbW1hbmRzW2lkXS5maWx0ZXIoaW5mbyA9PiBpbmZvLmhvdGtleXMubGVuZ3RoKTtcbiAgICAgICAgICAgIGNvbnN0IGNvbmZsaWN0cyA9IGFzc2lnbmVkLmZpbHRlcihpbmZvID0+IGluZm8uaG90a2V5cy5maWx0ZXIoayA9PiBhc3NpZ25lZEtleUNvdW50W2tdPjEpLmxlbmd0aCkubGVuZ3RoO1xuXG4gICAgICAgICAgICBidG4uc2V0VG9vbHRpcChcbiAgICAgICAgICAgICAgICBgQ29uZmlndXJlIGhvdGtleXMke1wiXFxuXCJ9KCR7YXNzaWduZWQubGVuZ3RofS8ke2NvbW1hbmRzW2lkXS5sZW5ndGh9IGFzc2lnbmVkJHtcbiAgICAgICAgICAgICAgICAgICAgY29uZmxpY3RzID8gXCI7IFwiK2NvbmZsaWN0cytcIiBjb25mbGljdGluZ1wiIDogXCJcIlxuICAgICAgICAgICAgICAgIH0pYFxuICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIGJ0bi5leHRyYVNldHRpbmdzRWwudG9nZ2xlQ2xhc3MoXCJtb2QtZXJyb3JcIiwgISFjb25mbGljdHMpO1xuICAgICAgICAgICAgYnRuLmV4dHJhU2V0dGluZ3NFbC5zaG93KCk7XG4gICAgICAgIH1cbiAgICB9XG59XG4iXSwibmFtZXMiOlsiS2V5bWFwIiwiTW9kYWwiLCJQbHVnaW4iLCJTZXR0aW5nIiwiZGVib3VuY2UiLCJQbGF0Zm9ybSJd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
