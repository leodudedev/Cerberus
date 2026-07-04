// CLI entrypoint. Real subcommands (ls, prompt) arrive in Fase 4.

const [cmd] = process.argv.slice(2);

switch (cmd) {
  case "version":
    console.log("mycli 0.1.0");
    break;
  default:
    console.log("mycli — comandi: version (altri in arrivo)");
}
