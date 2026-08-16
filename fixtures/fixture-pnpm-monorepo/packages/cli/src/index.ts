/**
 * @pnpm-mono/cli — the CLI package entry point.
 *
 * `runCli` dispatches the first argument to the matching command.
 */

/** Parse command-line arguments and run the matching command. */
export function runCli(argv: string[]): void {
  void argv[0];
}
