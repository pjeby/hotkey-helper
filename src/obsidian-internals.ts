import {i18n} from "i18next";

declare global {
    const i18next: i18n
}

declare module "obsidian" {
    namespace Keymap {
        function compileModifiers(mods: string[]): string
        function getModifiers(event: MouseEvent|KeyboardEvent): string
    }
    interface App {
        plugins: Plugins
        commands: Commands
        internalPlugins: InternalPluginsManager
        setting: SettingsManager
        hotkeyManager: HotKeyManager
    }

    interface Workspace {
        protocolHandlers: Map<string, ObsidianProtocolHandler>
    }

    interface Commands {
        commands: Record<string, Command>;
        addCommand(cmd: Command): void;
        removeCommand(cmd: Command): void;
    }

    interface HotKeyManager {
        getHotkeys(id: string): Hotkey[];
        getDefaultHotkeys(id: string): Hotkey[];
    }

    interface SettingsManager {
        activeTab: SettingTab | null;
        openTabById(id: string): SettingTab | null;
        openTab(tab: SettingTab): void;
        open(): void;
        close(): void;
        onOpen(): void;
        onClose(): void;
        settingTabs: SettingTab[];
        pluginTabs: SettingTab[];
        addSettingTab(): void;
        removeSettingTab(): void;
        containerEl: HTMLDivElement;
    }

    interface SettingTab {
        id: string
        searchInputEl?: HTMLInputElement; // XXX should be subtypes for hotkey and plugin tabs
        updateHotkeyVisibility?(): void;
    }

    interface SearchComponent {
        containerEl: HTMLDivElement;
    }

    interface Plugins {
        manifests: Record<string, PluginManifest>;
        plugins: Record<string, Plugin>;

        enablePlugin(pluginId: string): Promise<boolean>;
        disblePlugin(pluginId: string): Promise<void>;
    }

    interface InternalPluginsManager {
        getEnabledPlugins(): InternalPlugin<unknown>[];
        getPluginById(id: string & keyof InternalPlugins): InternalPlugin<unknown>
        plugins: InternalPlugins & Record<string, InternalPlugin<unknown>>
    }

    interface InternalPlugin<T> extends Component {
        /** The actual internal plugin object (state and methods). */
        instance: InternalPluginInstance<T>;
    }

    interface InternalPlugins {
        "command-palette": InternalPlugin<{modal: FuzzySuggestModal<Command>}>
    }

    type InternalPluginInstance<T> = T & {
        name: string
    }

    type ViewFactory = (leaf: WorkspaceLeaf) => View
}
