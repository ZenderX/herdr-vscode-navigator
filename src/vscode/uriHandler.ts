import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as vscode from "vscode";
import type { Logger } from "../herdr";
import { analyzeHosting, readProcessTable } from "../hosting";
import { herdrVarsToRemove, planOpenRequest, terminalNameFor, withoutHerdrVars } from "../launch/planOpenRequest";
import { resolveOnPath } from "../launch/whichHerdr";
import { errorText } from "../log";
import { parseOpenRequest } from "../uri/openRequest";

const execFileAsync = promisify(execFile);
const FOCUS_ATTEMPTS = 8;
const FOCUS_RETRY_MS = 1000;
const FOCUS_TIMEOUT_MS = 5000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// The server may still be starting when the client has only just been launched, so the first attempts can fail.
async function focusSpace(herdrPath: string, args: string[], log: Logger): Promise<void> {
  for (let attempt = 1; attempt <= FOCUS_ATTEMPTS; attempt++) {
    try {
      await execFileAsync(herdrPath, args, { env: withoutHerdrVars(process.env), timeout: FOCUS_TIMEOUT_MS, windowsHide: true });
      log("info", `open request: focused space (attempt ${attempt})`);
      return;
    } catch (err: unknown) {
      log("info", `open request: focus attempt ${attempt} failed: ${errorText(err)}`);
      if (attempt < FOCUS_ATTEMPTS) await sleep(FOCUS_RETRY_MS);
    }
  }
  void vscode.window.showWarningMessage("Herdr Navigator could not focus the requested space; see the Herdr Navigator output.");
}

const HERDR_SHELL = /(^|[\\/])herdr(\.exe)?$/i;

function runsHerdrAsShell({ creationOptions }: vscode.Terminal): boolean {
  return "shellPath" in creationOptions && typeof creationOptions.shellPath === "string" && HERDR_SHELL.test(creationOptions.shellPath);
}

// Terminals we created run herdr as the shell; a typed-in client (auto-launch) needs the process tree. Anything unproven is not live.
async function findLiveHerdrTerminals(candidates: readonly vscode.Terminal[], log: Logger): Promise<Set<vscode.Terminal>> {
  const live = new Set<vscode.Terminal>();
  const shells: { terminal: vscode.Terminal; pid: number }[] = [];
  for (const terminal of candidates) {
    if (terminal.exitStatus !== undefined || runsHerdrAsShell(terminal)) continue;
    const pid = await terminal.processId;
    if (pid !== undefined) shells.push({ terminal, pid });
  }
  if (shells.length === 0) return live;
  try {
    const { table, msysEdges } = await readProcessTable(process.platform, log);
    for (const { terminal, pid } of shells) {
      if (analyzeHosting(table, [pid], msysEdges).state === "yes") live.add(terminal);
    }
  } catch (err: unknown) {
    log("info", `open request: process table unavailable, treating shell terminals as not running herdr: ${errorText(err)}`);
  }
  return live;
}

export function createUriHandler(log: Logger): vscode.UriHandler {
  return {
    handleUri: async (uri) => {
      try {
        // uri.query is already decoded; the parser rejects what a second decoding would have produced.
        const request = parseOpenRequest({ path: uri.path, query: uri.query });
        const herdrPath = request.ok ? await resolveOnPath("herdr", process.platform, process.env) : undefined;
        const liveTerminals = request.ok
          ? await findLiveHerdrTerminals(
              vscode.window.terminals.filter(({ name }) => name === terminalNameFor(request.session)),
              log,
            )
          : new Set<vscode.Terminal>();
        // No await from here to show/createTerminal, so a request handled right after this one sees the terminal created here.
        const terminals = vscode.window.terminals;
        const plan = planOpenRequest({
          request,
          terminals: terminals.map((terminal) => ({ name: terminal.name, live: terminal.exitStatus === undefined && (runsHerdrAsShell(terminal) || liveTerminals.has(terminal)) })),
          herdrPath,
        });
        log("info", `open request: ${plan.action}${plan.action === "reject" ? ` (${plan.reason})` : ""}`);
        if (plan.action === "reject") {
          void vscode.window.showErrorMessage("Herdr Navigator ignored an invalid open request.");
          return;
        }
        if (plan.action === "herdr-missing") {
          void vscode.window.showErrorMessage("Herdr Navigator cannot find herdr on PATH.");
          return;
        }
        if (plan.action === "reveal") {
          terminals[plan.terminalIndex].show();
          if (herdrPath === undefined) {
            log("info", "open request: herdr not on PATH, cannot focus the space");
            void vscode.window.showWarningMessage("Herdr Navigator could not focus the requested space: herdr was not found on PATH.");
            return;
          }
          await focusSpace(herdrPath, plan.focusArgs, log);
          return;
        }
        vscode.window
          .createTerminal({
            name: plan.name,
            location: vscode.TerminalLocation.Editor,
            shellPath: plan.shellPath,
            shellArgs: plan.shellArgs,
            env: herdrVarsToRemove(process.env),
            isTransient: true,
          })
          .show();
        await focusSpace(plan.shellPath, plan.focusArgs, log);
      } catch (err: unknown) {
        log("error", `open request failed: ${errorText(err)}`);
        void vscode.window.showErrorMessage("Herdr Navigator could not handle the open request; see the Herdr Navigator output.");
      }
    },
  };
}
