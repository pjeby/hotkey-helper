import Builder from "@ophidian/build";

new Builder("src/hotkey-helper.ts")
.withSass()
.withInstall()
.build();

