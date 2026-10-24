import "gi://Gtk?version=4.0";
import "gi://Adw?version=1";
import "gi://WebKit?version=6.0";
import "gi://Soup?version=3.0";
import system from "system";
import { Application } from "./app/application.ts";

/**
 * The Linux client: GJS runs this bundle (`gjs -m main.js`), built by desktop/linux/scripts/build.sh.
 * The library versions are pinned above, before any module imports them unversioned.
 */
const app = new Application();
system.exit(app.run(ARGV));
