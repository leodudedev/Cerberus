// CLI entrypoint. Real subcommands (ls, prompt) arrive in Fase 4.
import { readFileSync } from "node:fs";

const pkg = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { version: string };

const [cmd] = process.argv.slice(2);

switch (cmd) {
  case "version":
    console.log(`cerberus ${pkg.version}`);
    break;
  default:
    console.log("cerberus — comandi: version (altri in arrivo)");
}
