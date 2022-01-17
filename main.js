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
                    return function get(key) {
                        if (key === "show-plugin") enhanceViewer();
                        return old.call(this, key);
                    }
                }
            })
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
        if (tabId !== "plugins" || this.searchInput) {
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
        if (tabId === "community-plugins") {
            searchEl.inputEl.addEventListener("keyup", e => {
                if (e.keyCode === 13 && !obsidian.Keymap.getModifiers(e)) {
                    this.gotoPlugin();
                    return false;
                }
            });
        }
        const plugin = this;
        function changeHandler(seek){
            const find = (plugin.lastSearch[tabId] = seek).toLowerCase();
            function matchAndHighlight(el) {
                if (!el) return false;
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
                const authorMatches = matchAndHighlight(
                    e.find(".setting-item-description > div:nth-child(2)")
                );
                e.toggle(nameMatches || descMatches || authorMatches);
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
                                    const removeBtns = [i18next.t("setting.options"), i18next.t("setting.hotkeys.name")];
                                    for (const b of buttons.findAll("button")) {
                                        if (removeBtns.indexOf(b.textContent) !== -1) b.detach();
                                    }
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
                    return function(cb) {
                        // The only "extras" added to settings w/a description are on the plugins, currently,
                        // so only try to match those to plugin names
                        if (tabId !== "plugins" && this.descEl.childElementCount && !in_event) {
                            if ( (manifests[which]||{}).name === this.nameEl.textContent ) {
                                const manifest = manifests[which++], enabled = !!app.plugins.plugins[manifest.id];
                                trigger("plugin-settings:plugin-control", this, manifest, enabled, tabId);
                            }
                            return old.call(this, function(b) {
                                cb(b);
                                if (!in_event && b.extraSettingsEl.find("svg.gear, svg.any-key")) b.extraSettingsEl.detach();
                            });
                        }                        return old.call(this, cb);
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWFpbi5qcyIsInNvdXJjZXMiOlsiLnlhcm4vY2FjaGUvbW9ua2V5LWFyb3VuZC1ucG0tMi4xLjAtNzBkZjMyZDJhYy0xYmQ3MmQyNWY5LnppcC9ub2RlX21vZHVsZXMvbW9ua2V5LWFyb3VuZC9tanMvaW5kZXguanMiLCJzcmMvcGx1Z2luLmpzIl0sInNvdXJjZXNDb250ZW50IjpbImV4cG9ydCBmdW5jdGlvbiBhcm91bmQob2JqLCBmYWN0b3JpZXMpIHtcbiAgICBjb25zdCByZW1vdmVycyA9IE9iamVjdC5rZXlzKGZhY3RvcmllcykubWFwKGtleSA9PiBhcm91bmQxKG9iaiwga2V5LCBmYWN0b3JpZXNba2V5XSkpO1xuICAgIHJldHVybiByZW1vdmVycy5sZW5ndGggPT09IDEgPyByZW1vdmVyc1swXSA6IGZ1bmN0aW9uICgpIHsgcmVtb3ZlcnMuZm9yRWFjaChyID0+IHIoKSk7IH07XG59XG5mdW5jdGlvbiBhcm91bmQxKG9iaiwgbWV0aG9kLCBjcmVhdGVXcmFwcGVyKSB7XG4gICAgY29uc3Qgb3JpZ2luYWwgPSBvYmpbbWV0aG9kXSwgaGFkT3duID0gb2JqLmhhc093blByb3BlcnR5KG1ldGhvZCk7XG4gICAgbGV0IGN1cnJlbnQgPSBjcmVhdGVXcmFwcGVyKG9yaWdpbmFsKTtcbiAgICAvLyBMZXQgb3VyIHdyYXBwZXIgaW5oZXJpdCBzdGF0aWMgcHJvcHMgZnJvbSB0aGUgd3JhcHBpbmcgbWV0aG9kLFxuICAgIC8vIGFuZCB0aGUgd3JhcHBpbmcgbWV0aG9kLCBwcm9wcyBmcm9tIHRoZSBvcmlnaW5hbCBtZXRob2RcbiAgICBpZiAob3JpZ2luYWwpXG4gICAgICAgIE9iamVjdC5zZXRQcm90b3R5cGVPZihjdXJyZW50LCBvcmlnaW5hbCk7XG4gICAgT2JqZWN0LnNldFByb3RvdHlwZU9mKHdyYXBwZXIsIGN1cnJlbnQpO1xuICAgIG9ialttZXRob2RdID0gd3JhcHBlcjtcbiAgICAvLyBSZXR1cm4gYSBjYWxsYmFjayB0byBhbGxvdyBzYWZlIHJlbW92YWxcbiAgICByZXR1cm4gcmVtb3ZlO1xuICAgIGZ1bmN0aW9uIHdyYXBwZXIoLi4uYXJncykge1xuICAgICAgICAvLyBJZiB3ZSBoYXZlIGJlZW4gZGVhY3RpdmF0ZWQgYW5kIGFyZSBubyBsb25nZXIgd3JhcHBlZCwgcmVtb3ZlIG91cnNlbHZlc1xuICAgICAgICBpZiAoY3VycmVudCA9PT0gb3JpZ2luYWwgJiYgb2JqW21ldGhvZF0gPT09IHdyYXBwZXIpXG4gICAgICAgICAgICByZW1vdmUoKTtcbiAgICAgICAgcmV0dXJuIGN1cnJlbnQuYXBwbHkodGhpcywgYXJncyk7XG4gICAgfVxuICAgIGZ1bmN0aW9uIHJlbW92ZSgpIHtcbiAgICAgICAgLy8gSWYgbm8gb3RoZXIgcGF0Y2hlcywganVzdCBkbyBhIGRpcmVjdCByZW1vdmFsXG4gICAgICAgIGlmIChvYmpbbWV0aG9kXSA9PT0gd3JhcHBlcikge1xuICAgICAgICAgICAgaWYgKGhhZE93bilcbiAgICAgICAgICAgICAgICBvYmpbbWV0aG9kXSA9IG9yaWdpbmFsO1xuICAgICAgICAgICAgZWxzZVxuICAgICAgICAgICAgICAgIGRlbGV0ZSBvYmpbbWV0aG9kXTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoY3VycmVudCA9PT0gb3JpZ2luYWwpXG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgIC8vIEVsc2UgcGFzcyBmdXR1cmUgY2FsbHMgdGhyb3VnaCwgYW5kIHJlbW92ZSB3cmFwcGVyIGZyb20gdGhlIHByb3RvdHlwZSBjaGFpblxuICAgICAgICBjdXJyZW50ID0gb3JpZ2luYWw7XG4gICAgICAgIE9iamVjdC5zZXRQcm90b3R5cGVPZih3cmFwcGVyLCBvcmlnaW5hbCB8fCBGdW5jdGlvbik7XG4gICAgfVxufVxuZXhwb3J0IGZ1bmN0aW9uIGFmdGVyKHByb21pc2UsIGNiKSB7XG4gICAgcmV0dXJuIHByb21pc2UudGhlbihjYiwgY2IpO1xufVxuZXhwb3J0IGZ1bmN0aW9uIHNlcmlhbGl6ZShhc3luY0Z1bmN0aW9uKSB7XG4gICAgbGV0IGxhc3RSdW4gPSBQcm9taXNlLnJlc29sdmUoKTtcbiAgICBmdW5jdGlvbiB3cmFwcGVyKC4uLmFyZ3MpIHtcbiAgICAgICAgcmV0dXJuIGxhc3RSdW4gPSBuZXcgUHJvbWlzZSgocmVzLCByZWopID0+IHtcbiAgICAgICAgICAgIGFmdGVyKGxhc3RSdW4sICgpID0+IHtcbiAgICAgICAgICAgICAgICBhc3luY0Z1bmN0aW9uLmFwcGx5KHRoaXMsIGFyZ3MpLnRoZW4ocmVzLCByZWopO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH0pO1xuICAgIH1cbiAgICB3cmFwcGVyLmFmdGVyID0gZnVuY3Rpb24gKCkge1xuICAgICAgICByZXR1cm4gbGFzdFJ1biA9IG5ldyBQcm9taXNlKChyZXMsIHJlaikgPT4geyBhZnRlcihsYXN0UnVuLCByZXMpOyB9KTtcbiAgICB9O1xuICAgIHJldHVybiB3cmFwcGVyO1xufVxuIiwiaW1wb3J0IHtQbHVnaW4sIFBsYXRmb3JtLCBLZXltYXAsIFNldHRpbmcsIE1vZGFsLCBkZWJvdW5jZX0gZnJvbSBcIm9ic2lkaWFuXCI7XG5pbXBvcnQge2Fyb3VuZCwgc2VyaWFsaXplfSBmcm9tIFwibW9ua2V5LWFyb3VuZFwiO1xuXG5mdW5jdGlvbiBob3RrZXlUb1N0cmluZyhob3RrZXkpIHtcbiAgICByZXR1cm4gS2V5bWFwLmNvbXBpbGVNb2RpZmllcnMoaG90a2V5Lm1vZGlmaWVycykrXCIsXCIgKyBob3RrZXkua2V5LnRvTG93ZXJDYXNlKClcbn1cblxuZnVuY3Rpb24gaXNQbHVnaW5UYWIoaWQpIHtcbiAgICByZXR1cm4gaWQgPT09IFwicGx1Z2luc1wiIHx8IGlkID09PSBcImNvbW11bml0eS1wbHVnaW5zXCI7XG59XG5cbmZ1bmN0aW9uIHBsdWdpblNldHRpbmdzQXJlT3BlbihhcHApIHtcbiAgICByZXR1cm4gc2V0dGluZ3NBcmVPcGVuKGFwcCkgJiYgaXNQbHVnaW5UYWIoYXBwLnNldHRpbmcuYWN0aXZlVGFiPy5pZClcbn1cblxuZnVuY3Rpb24gc2V0dGluZ3NBcmVPcGVuKGFwcCkge1xuICAgIHJldHVybiBhcHAuc2V0dGluZy5jb250YWluZXJFbC5wYXJlbnRFbGVtZW50ICE9PSBudWxsXG59XG5cbmZ1bmN0aW9uIGlzUGx1Z2luVmlld2VyKG9iKSB7XG4gICAgcmV0dXJuIChcbiAgICAgICAgb2IgaW5zdGFuY2VvZiBNb2RhbCAmJlxuICAgICAgICBvYi5oYXNPd25Qcm9wZXJ0eShcImF1dG9sb2FkXCIpICYmXG4gICAgICAgIHR5cGVvZiBvYi5zaG93UGx1Z2luID09PSBcImZ1bmN0aW9uXCIgJiZcbiAgICAgICAgdHlwZW9mIG9iLnVwZGF0ZVNlYXJjaCA9PT0gXCJmdW5jdGlvblwiICYmXG4gICAgICAgIHR5cGVvZiBvYi5zZWFyY2hFbCA9PSBcIm9iamVjdFwiXG4gICAgKTtcbn1cblxuZnVuY3Rpb24gb25FbGVtZW50KGVsLCBldmVudCwgc2VsZWN0b3IsIGNhbGxiYWNrLCBvcHRpb25zPWZhbHNlKSB7XG4gICAgZWwub24oZXZlbnQsIHNlbGVjdG9yLCBjYWxsYmFjaywgb3B0aW9ucylcbiAgICByZXR1cm4gKCkgPT4gZWwub2ZmKGV2ZW50LCBzZWxlY3RvciwgY2FsbGJhY2ssIG9wdGlvbnMpO1xufVxuXG5leHBvcnQgZGVmYXVsdCBjbGFzcyBIb3RrZXlIZWxwZXIgZXh0ZW5kcyBQbHVnaW4ge1xuXG4gICAgb25sb2FkKCkge1xuICAgICAgICBjb25zdCB3b3Jrc3BhY2UgPSB0aGlzLmFwcC53b3Jrc3BhY2UsIHBsdWdpbiA9IHRoaXM7XG4gICAgICAgIHRoaXMubGFzdFNlYXJjaCA9IHt9OyAgIC8vIGxhc3Qgc2VhcmNoIHVzZWQsIGluZGV4ZWQgYnkgdGFiXG5cbiAgICAgICAgdGhpcy5yZWdpc3RlckV2ZW50KCB3b3Jrc3BhY2Uub24oXCJwbHVnaW4tc2V0dGluZ3M6YmVmb3JlLWRpc3BsYXlcIiwgKHNldHRpbmdzVGFiLCB0YWJJZCkgPT4ge1xuICAgICAgICAgICAgdGhpcy5ob3RrZXlCdXR0b25zID0ge307XG4gICAgICAgICAgICB0aGlzLmNvbmZpZ0J1dHRvbnMgPSB7fTtcbiAgICAgICAgICAgIHRoaXMuZ2xvYmFsc0FkZGVkID0gZmFsc2U7XG4gICAgICAgICAgICB0aGlzLnNlYXJjaElucHV0ID0gbnVsbDtcbiAgICAgICAgICAgIGNvbnN0IHJlbW92ZSA9IGFyb3VuZChTZXR0aW5nLnByb3RvdHlwZSwge1xuICAgICAgICAgICAgICAgIGFkZFNlYXJjaChvbGQpIHsgcmV0dXJuIGZ1bmN0aW9uKGYpIHtcbiAgICAgICAgICAgICAgICAgICAgcmVtb3ZlKCk7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBvbGQuY2FsbCh0aGlzLCBpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHBsdWdpbi5zZWFyY2hJbnB1dCA9IGk7IGY/LihpKTtcbiAgICAgICAgICAgICAgICAgICAgfSlcbiAgICAgICAgICAgICAgICB9fVxuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICBzZXRJbW1lZGlhdGUocmVtb3ZlKTtcbiAgICAgICAgfSkgKTtcbiAgICAgICAgdGhpcy5yZWdpc3RlckV2ZW50KCB3b3Jrc3BhY2Uub24oXCJwbHVnaW4tc2V0dGluZ3M6YWZ0ZXItZGlzcGxheVwiLCAgKCkgPT4gdGhpcy5yZWZyZXNoQnV0dG9ucyh0cnVlKSkgKTtcblxuICAgICAgICB0aGlzLnJlZ2lzdGVyRXZlbnQoIHdvcmtzcGFjZS5vbihcInBsdWdpbi1zZXR0aW5nczpwbHVnaW4tY29udHJvbFwiLCAoc2V0dGluZywgbWFuaWZlc3QsIGVuYWJsZWQsIHRhYklkKSA9PiB7XG4gICAgICAgICAgICB0aGlzLmdsb2JhbHNBZGRlZCB8fCB0aGlzLmFkZEdsb2JhbHModGFiSWQsIHNldHRpbmcuc2V0dGluZ0VsKTtcbiAgICAgICAgICAgIHRoaXMuY3JlYXRlRXh0cmFCdXR0b25zKHNldHRpbmcsIG1hbmlmZXN0LCBlbmFibGVkKTtcbiAgICAgICAgfSkgKTtcblxuICAgICAgICAvLyBSZWZyZXNoIHRoZSBidXR0b25zIHdoZW4gY29tbWFuZHMgb3Igc2V0dGluZyB0YWJzIGFyZSBhZGRlZCBvciByZW1vdmVkXG4gICAgICAgIGNvbnN0IHJlcXVlc3RSZWZyZXNoID0gZGVib3VuY2UodGhpcy5yZWZyZXNoQnV0dG9ucy5iaW5kKHRoaXMpLCA1MCwgdHJ1ZSk7XG4gICAgICAgIGZ1bmN0aW9uIHJlZnJlc2hlcihvbGQpIHsgcmV0dXJuIGZ1bmN0aW9uKC4uLmFyZ3MpeyByZXF1ZXN0UmVmcmVzaCgpOyByZXR1cm4gb2xkLmFwcGx5KHRoaXMsIGFyZ3MpOyB9OyB9XG4gICAgICAgIHRoaXMucmVnaXN0ZXIoYXJvdW5kKGFwcC5jb21tYW5kcywge2FkZENvbW1hbmQ6ICAgIHJlZnJlc2hlciwgcmVtb3ZlQ29tbWFuZDogICAgcmVmcmVzaGVyfSkpO1xuICAgICAgICB0aGlzLnJlZ2lzdGVyKGFyb3VuZChhcHAuc2V0dGluZywgIHthZGRQbHVnaW5UYWI6ICByZWZyZXNoZXIsIHJlbW92ZVBsdWdpblRhYjogIHJlZnJlc2hlcn0pKTtcbiAgICAgICAgdGhpcy5yZWdpc3Rlcihhcm91bmQoYXBwLnNldHRpbmcsICB7YWRkU2V0dGluZ1RhYjogcmVmcmVzaGVyLCByZW1vdmVTZXR0aW5nVGFiOiByZWZyZXNoZXJ9KSk7XG5cbiAgICAgICAgd29ya3NwYWNlLm9uTGF5b3V0UmVhZHkodGhpcy53aGVuUmVhZHkuYmluZCh0aGlzKSk7XG4gICAgICAgIHRoaXMucmVnaXN0ZXJPYnNpZGlhblByb3RvY29sSGFuZGxlcihcImdvdG8tcGx1Z2luXCIsICh7aWQsIHNob3d9KSA9PiB7XG4gICAgICAgICAgICB3b3Jrc3BhY2Uub25MYXlvdXRSZWFkeSgoKSA9PiB7IHRoaXMuZ290b1BsdWdpbihpZCwgc2hvdyk7IH0pO1xuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICB3aGVuUmVhZHkoKSB7XG4gICAgICAgIGNvbnN0IGFwcCA9IHRoaXMuYXBwLCBwbHVnaW4gPSB0aGlzO1xuXG4gICAgICAgIC8vIFNhdmUgYW5kIHJlc3RvcmUgY3VycmVudCB0YWIgKHdvcmthcm91bmQgaHR0cHM6Ly9mb3J1bS5vYnNpZGlhbi5tZC90L3NldHRpbmdzLWRpYWxvZy1yZXNldHMtdG8tZmlyc3QtdGFiLWV2ZXJ5LXRpbWUvMTgyNDApXG4gICAgICAgIHRoaXMucmVnaXN0ZXIoYXJvdW5kKGFwcC5zZXR0aW5nLCB7XG4gICAgICAgICAgICBvbk9wZW4ob2xkKSB7IHJldHVybiBmdW5jdGlvbiguLi5hcmdzKSB7XG4gICAgICAgICAgICAgICAgb2xkLmFwcGx5KHRoaXMsIGFyZ3MpO1xuICAgICAgICAgICAgICAgIGlmICghUGxhdGZvcm0uaXNNb2JpbGUgJiYgcGx1Z2luLmxhc3RUYWJJZCkgdGhpcy5vcGVuVGFiQnlJZChwbHVnaW4ubGFzdFRhYklkKTtcbiAgICAgICAgICAgIH19LFxuICAgICAgICAgICAgb25DbG9zZShvbGQpIHsgcmV0dXJuIGZ1bmN0aW9uKC4uLmFyZ3MpIHtcbiAgICAgICAgICAgICAgICBwbHVnaW4ubGFzdFRhYklkID0gdGhpcy5hY3RpdmVUYWI/LmlkO1xuICAgICAgICAgICAgICAgIHJldHVybiBvbGQuYXBwbHkodGhpcywgYXJncyk7XG4gICAgICAgICAgICB9fVxuICAgICAgICB9KSlcblxuICAgICAgICBjb25zdCBjb3JlUGx1Z2lucyA9IHRoaXMuZ2V0U2V0dGluZ3NUYWIoXCJwbHVnaW5zXCIpO1xuICAgICAgICBjb25zdCBjb21tdW5pdHkgICA9IHRoaXMuZ2V0U2V0dGluZ3NUYWIoXCJjb21tdW5pdHktcGx1Z2luc1wiKTtcblxuICAgICAgICAvLyBIb29rIGludG8gdGhlIGRpc3BsYXkoKSBtZXRob2Qgb2YgdGhlIHBsdWdpbiBzZXR0aW5ncyB0YWJzXG4gICAgICAgIGlmIChjb3JlUGx1Z2lucykgdGhpcy5yZWdpc3Rlcihhcm91bmQoY29yZVBsdWdpbnMsIHtkaXNwbGF5OiB0aGlzLmFkZFBsdWdpblNldHRpbmdFdmVudHMuYmluZCh0aGlzLCBjb3JlUGx1Z2lucy5pZCl9KSk7XG4gICAgICAgIGlmIChjb21tdW5pdHkpICAgdGhpcy5yZWdpc3Rlcihhcm91bmQoY29tbXVuaXR5LCAgIHtkaXNwbGF5OiB0aGlzLmFkZFBsdWdpblNldHRpbmdFdmVudHMuYmluZCh0aGlzLCBjb21tdW5pdHkuaWQpfSkpO1xuXG4gICAgICAgIGNvbnN0IGVuaGFuY2VWaWV3ZXIgPSAoKSA9PiB0aGlzLmVuaGFuY2VWaWV3ZXIoKTtcblxuICAgICAgICBpZiAoY29tbXVuaXR5KSAgIHRoaXMucmVnaXN0ZXIoXG4gICAgICAgICAgICAvLyBUcmFwIG9wZW5zIG9mIHRoZSBjb21tdW5pdHkgcGx1Z2lucyB2aWV3ZXIgZnJvbSB0aGUgc2V0dGluZ3MgcGFuZWxcbiAgICAgICAgICAgIG9uRWxlbWVudChcbiAgICAgICAgICAgICAgICBjb21tdW5pdHkuY29udGFpbmVyRWwsIFwiY2xpY2tcIixcbiAgICAgICAgICAgICAgICBcIi5tb2QtY3RhLCAuaW5zdGFsbGVkLXBsdWdpbnMtY29udGFpbmVyIC5zZXR0aW5nLWl0ZW0taW5mb1wiLFxuICAgICAgICAgICAgICAgIGVuaGFuY2VWaWV3ZXIsXG4gICAgICAgICAgICAgICAgdHJ1ZVxuICAgICAgICAgICAgKVxuICAgICAgICApO1xuXG4gICAgICAgIC8vIFRyYXAgb3BlbnMgb2YgdGhlIGNvbW11bml0eSBwbHVnaW5zIHZpZXdlciB2aWEgVVJMXG4gICAgICAgIHRoaXMucmVnaXN0ZXIoXG4gICAgICAgICAgICBhcm91bmQoYXBwLndvcmtzcGFjZS5wcm90b2NvbEhhbmRsZXJzLCB7XG4gICAgICAgICAgICAgICAgZ2V0KG9sZCkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gZnVuY3Rpb24gZ2V0KGtleSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGtleSA9PT0gXCJzaG93LXBsdWdpblwiKSBlbmhhbmNlVmlld2VyKCk7XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gb2xkLmNhbGwodGhpcywga2V5KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0pXG4gICAgICAgIClcblxuICAgICAgICAvLyBOb3cgZm9yY2UgYSByZWZyZXNoIGlmIGVpdGhlciBwbHVnaW5zIHRhYiBpcyBjdXJyZW50bHkgdmlzaWJsZSAodG8gc2hvdyBvdXIgbmV3IGJ1dHRvbnMpXG4gICAgICAgIGZ1bmN0aW9uIHJlZnJlc2hUYWJJZk9wZW4oKSB7XG4gICAgICAgICAgICBpZiAocGx1Z2luU2V0dGluZ3NBcmVPcGVuKGFwcCkpIGFwcC5zZXR0aW5nLm9wZW5UYWJCeUlkKGFwcC5zZXR0aW5nLmFjdGl2ZVRhYi5pZCk7XG4gICAgICAgIH1cbiAgICAgICAgcmVmcmVzaFRhYklmT3BlbigpO1xuXG4gICAgICAgIC8vIEFuZCBkbyBpdCBhZ2FpbiBhZnRlciB3ZSB1bmxvYWQgKHRvIHJlbW92ZSB0aGUgb2xkIGJ1dHRvbnMpXG4gICAgICAgIHRoaXMucmVnaXN0ZXIoKCkgPT4gc2V0SW1tZWRpYXRlKHJlZnJlc2hUYWJJZk9wZW4pKTtcblxuICAgICAgICAvLyBUd2VhayB0aGUgaG90a2V5IHNldHRpbmdzIHRhYiB0byBtYWtlIGZpbHRlcmluZyB3b3JrIG9uIGlkIHByZWZpeGVzIGFzIHdlbGwgYXMgY29tbWFuZCBuYW1lc1xuICAgICAgICBjb25zdCBob3RrZXlzVGFiID0gdGhpcy5nZXRTZXR0aW5nc1RhYihcImhvdGtleXNcIik7XG4gICAgICAgIGlmIChob3RrZXlzVGFiKSB7XG4gICAgICAgICAgICB0aGlzLnJlZ2lzdGVyKGFyb3VuZChob3RrZXlzVGFiLCB7XG4gICAgICAgICAgICAgICAgZGlzcGxheShvbGQpIHsgcmV0dXJuIGZ1bmN0aW9uKCkgeyBvbGQuY2FsbCh0aGlzKTsgdGhpcy5zZWFyY2hJbnB1dEVsLmZvY3VzKCk7IH07IH0sXG4gICAgICAgICAgICAgICAgdXBkYXRlSG90a2V5VmlzaWJpbGl0eShvbGQpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGZ1bmN0aW9uKCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgY29uc3Qgb2xkU2VhcmNoID0gdGhpcy5zZWFyY2hJbnB1dEVsLnZhbHVlLCBvbGRDb21tYW5kcyA9IGFwcC5jb21tYW5kcy5jb21tYW5kcztcbiAgICAgICAgICAgICAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKG9sZFNlYXJjaC5lbmRzV2l0aChcIjpcIikgJiYgIW9sZFNlYXJjaC5jb250YWlucyhcIiBcIikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLy8gVGhpcyBpcyBhbiBpbmNyZWRpYmx5IHVnbHkgaGFjayB0aGF0IHJlbGllcyBvbiB1cGRhdGVIb3RrZXlWaXNpYmlsaXR5KCkgaXRlcmF0aW5nIGFwcC5jb21tYW5kcy5jb21tYW5kc1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAvLyBsb29raW5nIGZvciBob3RrZXkgY29uZmxpY3RzICpiZWZvcmUqIGFueXRoaW5nIGVsc2UuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxldCBjdXJyZW50ID0gb2xkQ29tbWFuZHM7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxldCBmaWx0ZXJlZCA9IE9iamVjdC5mcm9tRW50cmllcyhPYmplY3QuZW50cmllcyhhcHAuY29tbWFuZHMuY29tbWFuZHMpLmZpbHRlcihcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIChbaWQsIGNtZF0pID0+IChpZCtcIjpcIikuc3RhcnRzV2l0aChvbGRTZWFyY2gpXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICkpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aGlzLnNlYXJjaElucHV0RWwudmFsdWUgPSBcIlwiO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhcHAuY29tbWFuZHMuY29tbWFuZHMgPSBuZXcgUHJveHkob2xkQ29tbWFuZHMsIHtvd25LZXlzKCl7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAvLyBUaGUgZmlyc3QgdGltZSBjb21tYW5kcyBhcmUgaXRlcmF0ZWQsIHJldHVybiB0aGUgd2hvbGUgdGhpbmc7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAvLyBhZnRlciB0aGF0LCByZXR1cm4gdGhlIGZpbHRlcmVkIGxpc3RcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRyeSB7IHJldHVybiBPYmplY3Qua2V5cyhjdXJyZW50KTsgfSBmaW5hbGx5IHsgY3VycmVudCA9IGZpbHRlcmVkOyB9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH19KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIG9sZC5jYWxsKHRoaXMpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfSBmaW5hbGx5IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aGlzLnNlYXJjaElucHV0RWwudmFsdWUgPSBvbGRTZWFyY2g7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYXBwLmNvbW1hbmRzLmNvbW1hbmRzID0gb2xkQ29tbWFuZHM7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9KSk7XG4gICAgICAgIH1cblxuICAgICAgICAvLyBBZGQgY29tbWFuZHNcbiAgICAgICAgdGhpcy5hZGRDb21tYW5kKHtcbiAgICAgICAgICAgIGlkOiBcIm9wZW4tcGx1Z2luc1wiLFxuICAgICAgICAgICAgbmFtZTogXCJPcGVuIHRoZSBDb21tdW5pdHkgUGx1Z2lucyBzZXR0aW5nc1wiLFxuICAgICAgICAgICAgY2FsbGJhY2s6ICgpID0+IHRoaXMuc2hvd1NldHRpbmdzKFwiY29tbXVuaXR5LXBsdWdpbnNcIikgfHwgdHJ1ZVxuICAgICAgICB9KTtcbiAgICAgICAgdGhpcy5hZGRDb21tYW5kKHtcbiAgICAgICAgICAgIGlkOiBcImJyb3dzZS1wbHVnaW5zXCIsXG4gICAgICAgICAgICBuYW1lOiBcIkJyb3dzZSBvciBzZWFyY2ggdGhlIENvbW11bml0eSBQbHVnaW5zIGNhdGFsb2dcIixcbiAgICAgICAgICAgIGNhbGxiYWNrOiAoKSA9PiB0aGlzLmdvdG9QbHVnaW4oKVxuICAgICAgICB9KVxuICAgIH1cblxuICAgIGNyZWF0ZUV4dHJhQnV0dG9ucyhzZXR0aW5nLCBtYW5pZmVzdCwgZW5hYmxlZCkge1xuICAgICAgICBzZXR0aW5nLmFkZEV4dHJhQnV0dG9uKGJ0biA9PiB7XG4gICAgICAgICAgICBidG4uc2V0SWNvbihcImdlYXJcIik7XG4gICAgICAgICAgICBidG4ub25DbGljaygoKSA9PiB0aGlzLnNob3dDb25maWdGb3IobWFuaWZlc3QuaWQucmVwbGFjZSgvXndvcmtzcGFjZSQvLFwiZmlsZVwiKSkpO1xuICAgICAgICAgICAgYnRuLnNldFRvb2x0aXAoXCJPcHRpb25zXCIpO1xuICAgICAgICAgICAgYnRuLmV4dHJhU2V0dGluZ3NFbC50b2dnbGUoZW5hYmxlZClcbiAgICAgICAgICAgIHRoaXMuY29uZmlnQnV0dG9uc1ttYW5pZmVzdC5pZF0gPSBidG47XG4gICAgICAgIH0pO1xuICAgICAgICBzZXR0aW5nLmFkZEV4dHJhQnV0dG9uKGJ0biA9PiB7XG4gICAgICAgICAgICBidG4uc2V0SWNvbihcImFueS1rZXlcIik7XG4gICAgICAgICAgICBidG4ub25DbGljaygoKSA9PiB0aGlzLnNob3dIb3RrZXlzRm9yKG1hbmlmZXN0LmlkK1wiOlwiKSlcbiAgICAgICAgICAgIGJ0bi5leHRyYVNldHRpbmdzRWwudG9nZ2xlKGVuYWJsZWQpXG4gICAgICAgICAgICB0aGlzLmhvdGtleUJ1dHRvbnNbbWFuaWZlc3QuaWRdID0gYnRuO1xuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICAvLyBBZGQgdG9wLWxldmVsIGl0ZW1zIChzZWFyY2ggYW5kIHBzZXVkby1wbHVnaW5zKVxuICAgIGFkZEdsb2JhbHModGFiSWQsIHNldHRpbmdFbCkge1xuICAgICAgICB0aGlzLmdsb2JhbHNBZGRlZCA9IHRydWU7XG5cbiAgICAgICAgLy8gQWRkIGEgc2VhcmNoIGZpbHRlciB0byBzaHJpbmsgcGx1Z2luIGxpc3RcbiAgICAgICAgY29uc3QgY29udGFpbmVyRWwgPSBzZXR0aW5nRWwucGFyZW50RWxlbWVudDtcbiAgICAgICAgbGV0IHNlYXJjaEVsO1xuICAgICAgICBpZiAodGFiSWQgIT09IFwicGx1Z2luc1wiIHx8IHRoaXMuc2VhcmNoSW5wdXQpIHtcbiAgICAgICAgICAgIC8vIFJlcGxhY2UgdGhlIGJ1aWx0LWluIHNlYXJjaCBoYW5kbGVyXG4gICAgICAgICAgICAoc2VhcmNoRWwgPSB0aGlzLnNlYXJjaElucHV0KT8ub25DaGFuZ2UoY2hhbmdlSGFuZGxlcik7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBjb25zdCB0bXAgPSBuZXcgU2V0dGluZyhjb250YWluZXJFbCkuYWRkU2VhcmNoKHMgPT4ge1xuICAgICAgICAgICAgICAgIHNlYXJjaEVsID0gcztcbiAgICAgICAgICAgICAgICBzLnNldFBsYWNlaG9sZGVyKFwiRmlsdGVyIHBsdWdpbnMuLi5cIikub25DaGFuZ2UoY2hhbmdlSGFuZGxlcik7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIHNlYXJjaEVsLmNvbnRhaW5lckVsLnN0eWxlLm1hcmdpbiA9IDA7XG4gICAgICAgICAgICBjb250YWluZXJFbC5jcmVhdGVEaXYoXCJob3RrZXktc2VhcmNoLWNvbnRhaW5lclwiKS5hcHBlbmQoc2VhcmNoRWwuY29udGFpbmVyRWwpO1xuICAgICAgICAgICAgdG1wLnNldHRpbmdFbC5kZXRhY2goKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAodGFiSWQgPT09IFwiY29tbXVuaXR5LXBsdWdpbnNcIikge1xuICAgICAgICAgICAgc2VhcmNoRWwuaW5wdXRFbC5hZGRFdmVudExpc3RlbmVyKFwia2V5dXBcIiwgZSA9PiB7XG4gICAgICAgICAgICAgICAgaWYgKGUua2V5Q29kZSA9PT0gMTMgJiYgIUtleW1hcC5nZXRNb2RpZmllcnMoZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5nb3RvUGx1Z2luKCk7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9KVxuICAgICAgICB9XG4gICAgICAgIGNvbnN0IHBsdWdpbiA9IHRoaXM7XG4gICAgICAgIGZ1bmN0aW9uIGNoYW5nZUhhbmRsZXIoc2Vlayl7XG4gICAgICAgICAgICBjb25zdCBmaW5kID0gKHBsdWdpbi5sYXN0U2VhcmNoW3RhYklkXSA9IHNlZWspLnRvTG93ZXJDYXNlKCk7XG4gICAgICAgICAgICBmdW5jdGlvbiBtYXRjaEFuZEhpZ2hsaWdodChlbCkge1xuICAgICAgICAgICAgICAgIGlmICghZWwpIHJldHVybiBmYWxzZTtcbiAgICAgICAgICAgICAgICBjb25zdCB0ZXh0ID0gZWwudGV4dENvbnRlbnQgPSBlbC50ZXh0Q29udGVudDsgLy8gY2xlYXIgcHJldmlvdXMgaGlnaGxpZ2h0aW5nLCBpZiBhbnlcbiAgICAgICAgICAgICAgICBjb25zdCBpbmRleCA9IHRleHQudG9Mb3dlckNhc2UoKS5pbmRleE9mKGZpbmQpO1xuICAgICAgICAgICAgICAgIGlmICghfmluZGV4KSByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICAgICAgZWwudGV4dENvbnRlbnQgPSB0ZXh0LnN1YnN0cigwLCBpbmRleCk7XG4gICAgICAgICAgICAgICAgZWwuY3JlYXRlU3BhbihcInN1Z2dlc3Rpb24taGlnaGxpZ2h0XCIpLnRleHRDb250ZW50ID0gdGV4dC5zdWJzdHIoaW5kZXgsIGZpbmQubGVuZ3RoKTtcbiAgICAgICAgICAgICAgICBlbC5pbnNlcnRBZGphY2VudFRleHQoXCJiZWZvcmVlbmRcIiwgdGV4dC5zdWJzdHIoaW5kZXgrZmluZC5sZW5ndGgpKVxuICAgICAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY29udGFpbmVyRWwuZmluZEFsbChcIi5zZXR0aW5nLWl0ZW1cIikuZm9yRWFjaChlID0+IHtcbiAgICAgICAgICAgICAgICBjb25zdCBuYW1lTWF0Y2hlcyA9IG1hdGNoQW5kSGlnaGxpZ2h0KGUuZmluZChcIi5zZXR0aW5nLWl0ZW0tbmFtZVwiKSk7XG4gICAgICAgICAgICAgICAgY29uc3QgZGVzY01hdGNoZXMgPSBtYXRjaEFuZEhpZ2hsaWdodChcbiAgICAgICAgICAgICAgICAgICAgZS5maW5kKFwiLnNldHRpbmctaXRlbS1kZXNjcmlwdGlvbiA+IGRpdjpsYXN0LWNoaWxkXCIpID8/XG4gICAgICAgICAgICAgICAgICAgIGUuZmluZChcIi5zZXR0aW5nLWl0ZW0tZGVzY3JpcHRpb25cIilcbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIGNvbnN0IGF1dGhvck1hdGNoZXMgPSBtYXRjaEFuZEhpZ2hsaWdodChcbiAgICAgICAgICAgICAgICAgICAgZS5maW5kKFwiLnNldHRpbmctaXRlbS1kZXNjcmlwdGlvbiA+IGRpdjpudGgtY2hpbGQoMilcIilcbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIGUudG9nZ2xlKG5hbWVNYXRjaGVzIHx8IGRlc2NNYXRjaGVzIHx8IGF1dGhvck1hdGNoZXMpO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICAgICAgc2V0SW1tZWRpYXRlKCgpID0+IHtcbiAgICAgICAgICAgIGlmICghc2VhcmNoRWwpIHJldHVyblxuICAgICAgICAgICAgaWYgKHNlYXJjaEVsICYmIHR5cGVvZiBwbHVnaW4ubGFzdFNlYXJjaFt0YWJJZF0gPT09IFwic3RyaW5nXCIpIHtcbiAgICAgICAgICAgICAgICBzZWFyY2hFbC5zZXRWYWx1ZShwbHVnaW4ubGFzdFNlYXJjaFt0YWJJZF0pO1xuICAgICAgICAgICAgICAgIHNlYXJjaEVsLm9uQ2hhbmdlZCgpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKCFQbGF0Zm9ybS5pc01vYmlsZSkgc2VhcmNoRWwuaW5wdXRFbC5zZWxlY3QoKTtcbiAgICAgICAgfSk7XG4gICAgICAgIGNvbnRhaW5lckVsLmFwcGVuZChzZXR0aW5nRWwpO1xuXG4gICAgICAgIGlmICh0YWJJZCA9PT0gXCJwbHVnaW5zXCIpIHtcbiAgICAgICAgICAgIGNvbnN0IGVkaXRvck5hbWUgICAgPSB0aGlzLmdldFNldHRpbmdzVGFiKFwiZWRpdG9yXCIpPy5uYW1lIHx8IFwiRWRpdG9yXCI7XG4gICAgICAgICAgICBjb25zdCB3b3Jrc3BhY2VOYW1lID0gdGhpcy5nZXRTZXR0aW5nc1RhYihcImZpbGVcIik/Lm5hbWUgICB8fCBcIkZpbGVzICYgTGlua3NcIjtcbiAgICAgICAgICAgIHRoaXMuY3JlYXRlRXh0cmFCdXR0b25zKFxuICAgICAgICAgICAgICAgIG5ldyBTZXR0aW5nKHNldHRpbmdFbC5wYXJlbnRFbGVtZW50KVxuICAgICAgICAgICAgICAgICAgICAuc2V0TmFtZShcIkFwcFwiKS5zZXREZXNjKFwiTWlzY2VsbGFuZW91cyBhcHBsaWNhdGlvbiBjb21tYW5kcyAoYWx3YXlzIGVuYWJsZWQpXCIpLFxuICAgICAgICAgICAgICAgIHtpZDogXCJhcHBcIiwgbmFtZTogXCJBcHBcIn0sIHRydWVcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgICB0aGlzLmNyZWF0ZUV4dHJhQnV0dG9ucyhcbiAgICAgICAgICAgICAgICBuZXcgU2V0dGluZyhzZXR0aW5nRWwucGFyZW50RWxlbWVudClcbiAgICAgICAgICAgICAgICAgICAgLnNldE5hbWUoZWRpdG9yTmFtZSkuc2V0RGVzYyhcIkNvcmUgZWRpdGluZyBjb21tYW5kcyAoYWx3YXlzIGVuYWJsZWQpXCIpLFxuICAgICAgICAgICAgICAgIHtpZDogXCJlZGl0b3JcIiwgbmFtZTogZWRpdG9yTmFtZX0sIHRydWVcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgICB0aGlzLmNyZWF0ZUV4dHJhQnV0dG9ucyhcbiAgICAgICAgICAgICAgICBuZXcgU2V0dGluZyhzZXR0aW5nRWwucGFyZW50RWxlbWVudClcbiAgICAgICAgICAgICAgICAgICAgLnNldE5hbWUod29ya3NwYWNlTmFtZSkuc2V0RGVzYyhcIkNvcmUgZmlsZSBhbmQgcGFuZSBtYW5hZ2VtZW50IGNvbW1hbmRzIChhbHdheXMgZW5hYmxlZClcIiksXG4gICAgICAgICAgICAgICAge2lkOiBcIndvcmtzcGFjZVwiLCBuYW1lOiB3b3Jrc3BhY2VOYW1lfSwgdHJ1ZVxuICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIHNldHRpbmdFbC5wYXJlbnRFbGVtZW50LmFwcGVuZChzZXR0aW5nRWwpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgZW5oYW5jZVZpZXdlcigpIHtcbiAgICAgICAgY29uc3QgcGx1Z2luID0gdGhpcztcbiAgICAgICAgc2V0SW1tZWRpYXRlKGFyb3VuZChNb2RhbC5wcm90b3R5cGUsIHtcbiAgICAgICAgICAgIG9wZW4ob2xkKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGZ1bmN0aW9uKC4uLmFyZ3MpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKGlzUGx1Z2luVmlld2VyKHRoaXMpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBzZXRJbW1lZGlhdGUoKCkgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChwbHVnaW4ubGFzdFNlYXJjaFtcImNvbW11bml0eS1wbHVnaW5zXCJdKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC8vIERldGFjaCB0aGUgb2xkIHNlYXJjaCBhcmVhLCBpbiBjYXNlIHRoZSBlbXB0eSBzZWFyY2ggaXMgc3RpbGwgcnVubmluZ1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBuZXdSZXN1bHRzID0gdGhpcy5zZWFyY2hSZXN1bHRFbC5jbG9uZU5vZGUoKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5zZWFyY2hDb250YWluZXJFbC5yZXBsYWNlQ2hpbGQobmV3UmVzdWx0cywgdGhpcy5zZWFyY2hSZXN1bHRFbCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuc2VhcmNoUmVzdWx0RWwgPSBuZXdSZXN1bHRzO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAvLyBGb3JjZSBhbiB1cGRhdGU7IHVzZSBhbiBldmVudCBzbyB0aGF0IHRoZSBcInhcIiBhcHBlYXJzIG9uIHNlYXJjaFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aGlzLnNlYXJjaEVsLnZhbHVlID0gcGx1Z2luLmxhc3RTZWFyY2hbXCJjb21tdW5pdHktcGx1Z2luc1wiXTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5zZWFyY2hFbC5kaXNwYXRjaEV2ZW50KG5ldyBFdmVudCgnaW5wdXQnKSk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuc2VhcmNoRWwuc2VsZWN0KCk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHBsdWdpbi5jdXJyZW50Vmlld2VyID0gdGhpcztcbiAgICAgICAgICAgICAgICAgICAgICAgIGFyb3VuZCh0aGlzLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdXBkYXRlU2VhcmNoOiBzZXJpYWxpemUsICAvLyBwcmV2ZW50IHJhY2UgY29uZGl0aW9uc1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2xvc2Uob2xkKSB7IHJldHVybiBmdW5jdGlvbiguLi5hcmdzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBsdWdpbi5jdXJyZW50Vmlld2VyID0gbnVsbDtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIG9sZC5hcHBseSh0aGlzLCBhcmdzKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9fSxcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNob3dQbHVnaW4ob2xkKSB7IHJldHVybiBhc3luYyBmdW5jdGlvbihtYW5pZmVzdCl7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IHJlcyA9IGF3YWl0IG9sZC5jYWxsKHRoaXMsIG1hbmlmZXN0KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHBsdWdpbi5hcHAucGx1Z2lucy5wbHVnaW5zW21hbmlmZXN0LmlkXSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgYnV0dG9ucyA9IHRoaXMucGx1Z2luQ29udGVudEVsLmZpbmQoXCJidXR0b25cIikucGFyZW50RWxlbWVudDtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IHJlbW92ZUJ0bnMgPSBbaTE4bmV4dC50KFwic2V0dGluZy5vcHRpb25zXCIpLCBpMThuZXh0LnQoXCJzZXR0aW5nLmhvdGtleXMubmFtZVwiKV07XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBmb3IgKGNvbnN0IGIgb2YgYnV0dG9ucy5maW5kQWxsKFwiYnV0dG9uXCIpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHJlbW92ZUJ0bnMuaW5kZXhPZihiLnRleHRDb250ZW50KSAhPT0gLTEpIGIuZGV0YWNoKCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBrZXlCdG4gPSBidXR0b25zLmNyZWF0ZUVsKFwiYnV0dG9uXCIsIHtwcmVwZW5kOiB0cnVlLCB0ZXh0OiBcIkhvdGtleXNcIn0pO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgY2ZnQnRuID0gYnV0dG9ucy5jcmVhdGVFbChcImJ1dHRvblwiLCB7cHJlcGVuZDogdHJ1ZSwgdGV4dDogXCJPcHRpb25zXCJ9KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBsdWdpbi5ob3RrZXlCdXR0b25zW21hbmlmZXN0LmlkXSA9IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBzZXRUb29sdGlwKHRpcCkge2tleUJ0bi50aXRsZSA9IHRpcH0sIGV4dHJhU2V0dGluZ3NFbDoga2V5QnRuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwbHVnaW4uY29uZmlnQnV0dG9uc1ttYW5pZmVzdC5pZF0gPSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgc2V0VG9vbHRpcCgpIHt9LCBleHRyYVNldHRpbmdzRWw6IGNmZ0J0blxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcGx1Z2luLnJlZnJlc2hCdXR0b25zKHRydWUpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAga2V5QnRuLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAgKCkgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuY2xvc2UoKTsgcGx1Z2luLnNob3dIb3RrZXlzRm9yKG1hbmlmZXN0LmlkK1wiOlwiKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY2ZnQnRuLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAgKCkgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuY2xvc2UoKTsgcGx1Z2luLnNob3dDb25maWdGb3IobWFuaWZlc3QuaWQpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHJlcztcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9fVxuICAgICAgICAgICAgICAgICAgICAgICAgfSlcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gb2xkLmFwcGx5KHRoaXMsIGFyZ3MpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfSkpO1xuICAgIH1cblxuICAgIGdldFNldHRpbmdzVGFiKGlkKSB7IHJldHVybiB0aGlzLmFwcC5zZXR0aW5nLnNldHRpbmdUYWJzLmZpbHRlcih0ID0+IHQuaWQgPT09IGlkKS5zaGlmdCgpOyB9XG5cbiAgICBhZGRQbHVnaW5TZXR0aW5nRXZlbnRzKHRhYklkLCBvbGQpIHtcbiAgICAgICAgY29uc3QgYXBwID0gdGhpcy5hcHA7XG4gICAgICAgIGxldCBpbl9ldmVudCA9IGZhbHNlO1xuXG4gICAgICAgIGZ1bmN0aW9uIHRyaWdnZXIoLi4uYXJncykge1xuICAgICAgICAgICAgaW5fZXZlbnQgPSB0cnVlO1xuICAgICAgICAgICAgdHJ5IHsgYXBwLndvcmtzcGFjZS50cmlnZ2VyKC4uLmFyZ3MpOyB9IGNhdGNoKGUpIHsgY29uc29sZS5lcnJvcihlKTsgfVxuICAgICAgICAgICAgaW5fZXZlbnQgPSBmYWxzZTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIFdyYXBwZXIgdG8gYWRkIHBsdWdpbi1zZXR0aW5ncyBldmVudHNcbiAgICAgICAgcmV0dXJuIGZ1bmN0aW9uIGRpc3BsYXkoLi4uYXJncykge1xuICAgICAgICAgICAgaWYgKGluX2V2ZW50KSByZXR1cm47XG4gICAgICAgICAgICB0cmlnZ2VyKFwicGx1Z2luLXNldHRpbmdzOmJlZm9yZS1kaXNwbGF5XCIsIHRoaXMsIHRhYklkKTtcblxuICAgICAgICAgICAgLy8gVHJhY2sgd2hpY2ggcGx1Z2luIGVhY2ggc2V0dGluZyBpcyBmb3JcbiAgICAgICAgICAgIGxldCBtYW5pZmVzdHM7XG4gICAgICAgICAgICBpZiAodGFiSWQgPT09IFwicGx1Z2luc1wiKSB7XG4gICAgICAgICAgICAgICAgbWFuaWZlc3RzID0gT2JqZWN0LmVudHJpZXMoYXBwLmludGVybmFsUGx1Z2lucy5wbHVnaW5zKS5tYXAoXG4gICAgICAgICAgICAgICAgICAgIChbaWQsIHtpbnN0YW5jZToge25hbWV9LCBfbG9hZGVkOmVuYWJsZWR9XSkgPT4ge3JldHVybiB7aWQsIG5hbWUsIGVuYWJsZWR9O31cbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBtYW5pZmVzdHMgPSBPYmplY3QudmFsdWVzKGFwcC5wbHVnaW5zLm1hbmlmZXN0cyk7XG4gICAgICAgICAgICAgICAgbWFuaWZlc3RzLnNvcnQoKGUsIHQpID0+IGUubmFtZS5sb2NhbGVDb21wYXJlKHQubmFtZSkpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgbGV0IHdoaWNoID0gMDtcblxuICAgICAgICAgICAgLy8gVHJhcCB0aGUgYWRkaXRpb24gb2YgdGhlIFwidW5pbnN0YWxsXCIgYnV0dG9ucyBuZXh0IHRvIGVhY2ggcGx1Z2luXG4gICAgICAgICAgICBjb25zdCByZW1vdmUgPSBhcm91bmQoU2V0dGluZy5wcm90b3R5cGUsIHtcbiAgICAgICAgICAgICAgICBhZGRUb2dnbGUob2xkKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBmdW5jdGlvbiguLi5hcmdzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAodGFiSWQgPT09IFwicGx1Z2luc1wiICYmICFpbl9ldmVudCAmJiAobWFuaWZlc3RzW3doaWNoXXx8e30pLm5hbWUgPT09IHRoaXMubmFtZUVsLnRleHRDb250ZW50ICkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IG1hbmlmZXN0ID0gbWFuaWZlc3RzW3doaWNoKytdO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRyaWdnZXIoXCJwbHVnaW4tc2V0dGluZ3M6cGx1Z2luLWNvbnRyb2xcIiwgdGhpcywgbWFuaWZlc3QsIG1hbmlmZXN0LmVuYWJsZWQsIHRhYklkKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiBvbGQuYXBwbHkodGhpcywgYXJncyk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgIGFkZEV4dHJhQnV0dG9uKG9sZCkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gZnVuY3Rpb24oY2IpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vIFRoZSBvbmx5IFwiZXh0cmFzXCIgYWRkZWQgdG8gc2V0dGluZ3Mgdy9hIGRlc2NyaXB0aW9uIGFyZSBvbiB0aGUgcGx1Z2lucywgY3VycmVudGx5LFxuICAgICAgICAgICAgICAgICAgICAgICAgLy8gc28gb25seSB0cnkgdG8gbWF0Y2ggdGhvc2UgdG8gcGx1Z2luIG5hbWVzXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAodGFiSWQgIT09IFwicGx1Z2luc1wiICYmIHRoaXMuZGVzY0VsLmNoaWxkRWxlbWVudENvdW50ICYmICFpbl9ldmVudCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICggKG1hbmlmZXN0c1t3aGljaF18fHt9KS5uYW1lID09PSB0aGlzLm5hbWVFbC50ZXh0Q29udGVudCApIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgbWFuaWZlc3QgPSBtYW5pZmVzdHNbd2hpY2grK10sIGVuYWJsZWQgPSAhIWFwcC5wbHVnaW5zLnBsdWdpbnNbbWFuaWZlc3QuaWRdO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0cmlnZ2VyKFwicGx1Z2luLXNldHRpbmdzOnBsdWdpbi1jb250cm9sXCIsIHRoaXMsIG1hbmlmZXN0LCBlbmFibGVkLCB0YWJJZCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiBvbGQuY2FsbCh0aGlzLCBmdW5jdGlvbihiKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNiKGIpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoIWluX2V2ZW50ICYmIGIuZXh0cmFTZXR0aW5nc0VsLmZpbmQoXCJzdmcuZ2Vhciwgc3ZnLmFueS1rZXlcIikpIGIuZXh0cmFTZXR0aW5nc0VsLmRldGFjaCgpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICAgICAgfTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiBvbGQuY2FsbCh0aGlzLCBjYik7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICByZXR1cm4gb2xkLmFwcGx5KHRoaXMsIGFyZ3MpO1xuICAgICAgICAgICAgfSBmaW5hbGx5IHtcbiAgICAgICAgICAgICAgICByZW1vdmUoKTtcbiAgICAgICAgICAgICAgICB0cmlnZ2VyKFwicGx1Z2luLXNldHRpbmdzOmFmdGVyLWRpc3BsYXlcIiwgdGhpcyk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBnb3RvUGx1Z2luKGlkLCBzaG93PVwiaW5mb1wiKSB7XG4gICAgICAgIGlmIChpZCAmJiBzaG93ID09PSBcImhvdGtleXNcIikgcmV0dXJuIHRoaXMuc2hvd0hvdGtleXNGb3IoaWQrXCI6XCIpO1xuICAgICAgICBpZiAoaWQgJiYgc2hvdyA9PT0gXCJjb25maWdcIikgIHtcbiAgICAgICAgICAgIGlmICghdGhpcy5zaG93Q29uZmlnRm9yKGlkKSkgdGhpcy5hcHAuc2V0dGluZy5jbG9zZSgpO1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG5cbiAgICAgICAgdGhpcy5zaG93U2V0dGluZ3MoXCJjb21tdW5pdHktcGx1Z2luc1wiKTtcbiAgICAgICAgY29uc3QgcmVtb3ZlID0gYXJvdW5kKE1vZGFsLnByb3RvdHlwZSwge1xuICAgICAgICAgICAgb3BlbihvbGQpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gZnVuY3Rpb24oLi4uYXJncykge1xuICAgICAgICAgICAgICAgICAgICByZW1vdmUoKTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKGlkKSB0aGlzLmF1dG9sb2FkID0gaWQ7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBvbGQuYXBwbHkodGhpcywgYXJncyk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9KVxuICAgICAgICB0aGlzLmFwcC5zZXR0aW5nLmFjdGl2ZVRhYi5jb250YWluZXJFbC5maW5kKFwiLm1vZC1jdGFcIikuY2xpY2soKTtcbiAgICAgICAgLy8gWFhYIGhhbmRsZSBuYXYgdG8gbm90LWNhdGFsb2dlZCBwbHVnaW5cbiAgICB9XG5cbiAgICBzaG93U2V0dGluZ3MoaWQpIHtcbiAgICAgICAgdGhpcy5jdXJyZW50Vmlld2VyPy5jbG9zZSgpOyAgLy8gY2xvc2UgdGhlIHBsdWdpbiBicm93c2VyIGlmIG9wZW5cbiAgICAgICAgc2V0dGluZ3NBcmVPcGVuKHRoaXMuYXBwKSB8fCB0aGlzLmFwcC5zZXR0aW5nLm9wZW4oKTtcbiAgICAgICAgaWYgKGlkKSB7XG4gICAgICAgICAgICB0aGlzLmFwcC5zZXR0aW5nLm9wZW5UYWJCeUlkKGlkKTtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLmFwcC5zZXR0aW5nLmFjdGl2ZVRhYj8uaWQgPT09IGlkID8gdGhpcy5hcHAuc2V0dGluZy5hY3RpdmVUYWIgOiBmYWxzZVxuICAgICAgICB9XG4gICAgfVxuXG4gICAgc2hvd0hvdGtleXNGb3Ioc2VhcmNoKSB7XG4gICAgICAgIGNvbnN0IHRhYiA9IHRoaXMuc2hvd1NldHRpbmdzKFwiaG90a2V5c1wiKTtcbiAgICAgICAgaWYgKHRhYiAmJiB0YWIuc2VhcmNoSW5wdXRFbCAmJiB0YWIudXBkYXRlSG90a2V5VmlzaWJpbGl0eSkge1xuICAgICAgICAgICAgdGFiLnNlYXJjaElucHV0RWwudmFsdWUgPSBzZWFyY2g7XG4gICAgICAgICAgICB0YWIudXBkYXRlSG90a2V5VmlzaWJpbGl0eSgpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgc2hvd0NvbmZpZ0ZvcihpZCkge1xuICAgICAgICBpZiAodGhpcy5zaG93U2V0dGluZ3MoaWQpKSByZXR1cm4gdHJ1ZTtcbiAgICAgICAgbmV3IE5vdGljZShcbiAgICAgICAgICAgIGBObyBzZXR0aW5ncyB0YWIgZm9yIFwiJHtpZH1cIjogaXQgbWF5IG5vdCBiZSBpbnN0YWxsZWQgb3IgbWlnaHQgbm90IGhhdmUgc2V0dGluZ3MuYFxuICAgICAgICApO1xuICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuXG4gICAgcGx1Z2luRW5hYmxlZChpZCkge1xuICAgICAgICByZXR1cm4gdGhpcy5hcHAuaW50ZXJuYWxQbHVnaW5zLnBsdWdpbnNbaWRdPy5fbG9hZGVkIHx8IHRoaXMuYXBwLnBsdWdpbnMucGx1Z2luc1tpZF07XG4gICAgfVxuXG4gICAgcmVmcmVzaEJ1dHRvbnMoZm9yY2U9ZmFsc2UpIHtcbiAgICAgICAgLy8gRG9uJ3QgcmVmcmVzaCB3aGVuIG5vdCBkaXNwbGF5aW5nLCB1bmxlc3MgcmVuZGVyaW5nIGlzIGluIHByb2dyZXNzXG4gICAgICAgIGlmICghcGx1Z2luU2V0dGluZ3NBcmVPcGVuKHRoaXMuYXBwKSAmJiAhZm9yY2UpIHJldHVybjtcblxuICAgICAgICBjb25zdCBoa20gPSB0aGlzLmFwcC5ob3RrZXlNYW5hZ2VyO1xuICAgICAgICBjb25zdCBhc3NpZ25lZEtleUNvdW50ID0ge307XG5cbiAgICAgICAgLy8gR2V0IGEgbGlzdCBvZiBjb21tYW5kcyBieSBwbHVnaW5cbiAgICAgICAgY29uc3QgY29tbWFuZHMgPSBPYmplY3QudmFsdWVzKHRoaXMuYXBwLmNvbW1hbmRzLmNvbW1hbmRzKS5yZWR1Y2UoKGNtZHMsIGNtZCk9PntcbiAgICAgICAgICAgIGNvbnN0IHBpZCA9IGNtZC5pZC5zcGxpdChcIjpcIiwyKS5zaGlmdCgpO1xuICAgICAgICAgICAgY29uc3QgaG90a2V5cyA9IChoa20uZ2V0SG90a2V5cyhjbWQuaWQpIHx8IGhrbS5nZXREZWZhdWx0SG90a2V5cyhjbWQuaWQpIHx8IFtdKS5tYXAoaG90a2V5VG9TdHJpbmcpO1xuICAgICAgICAgICAgaG90a2V5cy5mb3JFYWNoKGsgPT4gYXNzaWduZWRLZXlDb3VudFtrXSA9IDEgKyAoYXNzaWduZWRLZXlDb3VudFtrXXx8MCkpO1xuICAgICAgICAgICAgKGNtZHNbcGlkXSB8fCAoY21kc1twaWRdPVtdKSkucHVzaCh7aG90a2V5cywgY21kfSk7XG4gICAgICAgICAgICByZXR1cm4gY21kcztcbiAgICAgICAgfSwge30pO1xuXG4gICAgICAgIC8vIFBsdWdpbiBzZXR0aW5nIHRhYnMgYnkgcGx1Z2luXG4gICAgICAgIGNvbnN0IHRhYnMgPSBPYmplY3QudmFsdWVzKHRoaXMuYXBwLnNldHRpbmcucGx1Z2luVGFicykucmVkdWNlKCh0YWJzLCB0YWIpPT4ge1xuICAgICAgICAgICAgdGFic1t0YWIuaWRdID0gdGFiOyByZXR1cm4gdGFic1xuICAgICAgICB9LCB7fSk7XG4gICAgICAgIHRhYnNbXCJ3b3Jrc3BhY2VcIl0gPSB0YWJzW1wiZWRpdG9yXCJdID0gdHJ1ZTtcblxuICAgICAgICBmb3IoY29uc3QgaWQgb2YgT2JqZWN0LmtleXModGhpcy5jb25maWdCdXR0b25zIHx8IHt9KSkge1xuICAgICAgICAgICAgY29uc3QgYnRuID0gdGhpcy5jb25maWdCdXR0b25zW2lkXTtcbiAgICAgICAgICAgIGlmICghdGFic1tpZF0pIHtcbiAgICAgICAgICAgICAgICBidG4uZXh0cmFTZXR0aW5nc0VsLmhpZGUoKTtcbiAgICAgICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGJ0bi5leHRyYVNldHRpbmdzRWwuc2hvdygpO1xuICAgICAgICB9XG5cbiAgICAgICAgZm9yKGNvbnN0IGlkIG9mIE9iamVjdC5rZXlzKHRoaXMuaG90a2V5QnV0dG9ucyB8fCB7fSkpIHtcbiAgICAgICAgICAgIGNvbnN0IGJ0biA9IHRoaXMuaG90a2V5QnV0dG9uc1tpZF07XG4gICAgICAgICAgICBpZiAoIWNvbW1hbmRzW2lkXSkge1xuICAgICAgICAgICAgICAgIC8vIFBsdWdpbiBpcyBkaXNhYmxlZCBvciBoYXMgbm8gY29tbWFuZHNcbiAgICAgICAgICAgICAgICBidG4uZXh0cmFTZXR0aW5nc0VsLmhpZGUoKTtcbiAgICAgICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNvbnN0IGFzc2lnbmVkID0gY29tbWFuZHNbaWRdLmZpbHRlcihpbmZvID0+IGluZm8uaG90a2V5cy5sZW5ndGgpO1xuICAgICAgICAgICAgY29uc3QgY29uZmxpY3RzID0gYXNzaWduZWQuZmlsdGVyKGluZm8gPT4gaW5mby5ob3RrZXlzLmZpbHRlcihrID0+IGFzc2lnbmVkS2V5Q291bnRba10+MSkubGVuZ3RoKS5sZW5ndGg7XG5cbiAgICAgICAgICAgIGJ0bi5zZXRUb29sdGlwKFxuICAgICAgICAgICAgICAgIGBDb25maWd1cmUgaG90a2V5cyR7XCJcXG5cIn0oJHthc3NpZ25lZC5sZW5ndGh9LyR7Y29tbWFuZHNbaWRdLmxlbmd0aH0gYXNzaWduZWQke1xuICAgICAgICAgICAgICAgICAgICBjb25mbGljdHMgPyBcIjsgXCIrY29uZmxpY3RzK1wiIGNvbmZsaWN0aW5nXCIgOiBcIlwiXG4gICAgICAgICAgICAgICAgfSlgXG4gICAgICAgICAgICApO1xuICAgICAgICAgICAgYnRuLmV4dHJhU2V0dGluZ3NFbC50b2dnbGVDbGFzcyhcIm1vZC1lcnJvclwiLCAhIWNvbmZsaWN0cyk7XG4gICAgICAgICAgICBidG4uZXh0cmFTZXR0aW5nc0VsLnNob3coKTtcbiAgICAgICAgfVxuICAgIH1cbn1cbiJdLCJuYW1lcyI6WyJLZXltYXAiLCJNb2RhbCIsIlBsdWdpbiIsIlNldHRpbmciLCJkZWJvdW5jZSIsIlBsYXRmb3JtIl0sIm1hcHBpbmdzIjoiOzs7O0FBQU8sU0FBUyxNQUFNLENBQUMsR0FBRyxFQUFFLFNBQVMsRUFBRTtBQUN2QyxJQUFJLE1BQU0sUUFBUSxHQUFHLE1BQU0sQ0FBQyxJQUFJLENBQUMsU0FBUyxDQUFDLENBQUMsR0FBRyxDQUFDLEdBQUcsSUFBSSxPQUFPLENBQUMsR0FBRyxFQUFFLEdBQUcsRUFBRSxTQUFTLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQzFGLElBQUksT0FBTyxRQUFRLENBQUMsTUFBTSxLQUFLLENBQUMsR0FBRyxRQUFRLENBQUMsQ0FBQyxDQUFDLEdBQUcsWUFBWSxFQUFFLFFBQVEsQ0FBQyxPQUFPLENBQUMsQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLENBQUMsRUFBRSxDQUFDO0FBQzdGLENBQUM7QUFDRCxTQUFTLE9BQU8sQ0FBQyxHQUFHLEVBQUUsTUFBTSxFQUFFLGFBQWEsRUFBRTtBQUM3QyxJQUFJLE1BQU0sUUFBUSxHQUFHLEdBQUcsQ0FBQyxNQUFNLENBQUMsRUFBRSxNQUFNLEdBQUcsR0FBRyxDQUFDLGNBQWMsQ0FBQyxNQUFNLENBQUMsQ0FBQztBQUN0RSxJQUFJLElBQUksT0FBTyxHQUFHLGFBQWEsQ0FBQyxRQUFRLENBQUMsQ0FBQztBQUMxQztBQUNBO0FBQ0EsSUFBSSxJQUFJLFFBQVE7QUFDaEIsUUFBUSxNQUFNLENBQUMsY0FBYyxDQUFDLE9BQU8sRUFBRSxRQUFRLENB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
