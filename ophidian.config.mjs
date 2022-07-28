import Builder from "@ophidian/build";
import {readFileSync} from "node:fs"

new Builder("src/plugin.js")
.withCss()
.withInstall()
.build();

