## Hotkey Helper: Easier Hotkey and Options Management for Obsidian

> New in 0.2.0: support for core plugins as well as community plugins!

This plugin makes it easier to manage plugins' hotkeys and options in [Obsidian.md](https://obsidian.md), by adding icons next to each plugin (in the Core and Community plugin tabs) that you can use to open that plugin's options or hotkey assignments.

![](https://raw.githubusercontent.com/pjeby/hotkey-helper/master/hotkey-helper.gif)

Better still: hovering over the hotkeys icon shows you how many commands the plugin has, how many of those commands have hotkeys assigned, and how many of the assignments are in conflict with any other hotkey assignments.  (The icon is also highlighted with your theme's error background color if there are any conflicts.)

The icons automatically come and go or change color as you enable or disable plugins, so you can immediately find out where a conflict is taking place, and easily review or set up a new plugin's hotkeys or settings.

### Installation

To install the plugin, search for "hotkey helper" in Obsidian's Community Plugins interface.  Or, if it's not there yet, just visit the [Github releases page](https://github.com/pjeby/hotkey-helper/releases), download the plugin .zip from the latest release, and unzip it in your vault's `.obsidian/plugins/` directory.

Either way, you can then enable it from the Obsidian "Community Plugins" tab for that vault.

If you encounter any problems with the plugin, please file bug reports to this repository rather than using the Obsidian forums: I don't check the forums every day (or even every week!) but I do receive email notices from Github and will get back to you much faster than I will see forum comments.

### Known Issues/Current Limitations

* Some commands are not part of any plugin (core or community) and thus have no button shown anywhere.  You can see these commands by entering `editor:` or `workspace:` into the search box on the Hotkeys tab.
* If you search in the Hotkeys tab for a string without spaces, ending with `:`, it will only display commands provided by the named plugin; e.g. searching for `workspaces:` would list only commands from the built-in Workspaces plugin (if enabled), rather than all commands whose name *contains* the word workspaces followed by a `:`.
