/**
 * pi-cc-commands
 *
 * Exposes Claude Code-format slash commands (`.claude/commands/**\/*.md`)
 * through a single `/cc-commands` picker. Selecting a command prefills the
 * editor with its expanded body so you can review and edit before sending.
 *
 * Nothing is added to the system prompt or autocomplete list, so 100+
 * commands cost zero tokens during normal use.
 *
 * Discovery (in priority order, deepest first):
 *   1. `.claude/commands/` walking from cwd up to the git repo (or worktree)
 *      root. Project-local definitions override anything higher up.
 *   2. `~/.claude/commands/` for personal/global commands.
 *   3. Any directories listed under `extraCommandRoots` in
 *      `~/.pi/agent/cc-commands.json`.
 *
 * Namespacing follows the Claude Code convention:
 *
 *   .claude/commands/git/silver-bullet.md  →  git:silver-bullet
 *   .claude/commands/walkthrough.md        →  walkthrough
 *   .claude/commands/zip-intro/triage.md   →  zip-intro:triage
 *
 * Skills are intentionally NOT loaded here — point pi's `skills` setting at
 * `~/.claude/skills` (and `.claude/skills`) directly. Pi has first-class
 * support for that and it keeps this extension scope-tight.
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
	type AutocompleteItem,
	Container,
	fuzzyFilter,
	getKeybindings,
	type SelectItem,
	SelectList,
	Text,
} from "@earendil-works/pi-tui";

// How many rows of the picker are visible at once. Clamped to item count.
const PICKER_VISIBLE_ROWS = 15;

// ---------- Types ----------

interface CcCommand {
	name: string; // namespaced, e.g. "git:silver-bullet"
	path: string; // absolute file path
	scope: "project" | "global";
	rootLabel: string; // pretty origin, e.g. ".claude/commands" or "~/.claude/commands"
	description?: string;
	argumentHint?: string;
	body: string; // raw body with frontmatter stripped
}

interface CcConfig {
	extraCommandRoots: string[];
	expandAtRefs: boolean;
	execBashOnExpand: boolean;
	maxFileBytes: number;
	execTimeoutMs: number;
}

interface CommandRoot {
	path: string;
	scope: "project" | "global";
	label: string;
}

const DEFAULT_CONFIG: CcConfig = {
	extraCommandRoots: [],
	expandAtRefs: false,
	execBashOnExpand: false,
	maxFileBytes: 200 * 1024,
	execTimeoutMs: 30000,
};

// ---------- Config ----------

function loadConfig(): CcConfig {
	const cfg: CcConfig = { ...DEFAULT_CONFIG };
	try {
		const p = join(homedir(), ".pi", "agent", "cc-commands.json");
		const raw = readFileSync(p, "utf8");
		const parsed = JSON.parse(raw) as Partial<CcConfig>;
		Object.assign(cfg, parsed);
	} catch {
		/* missing or invalid – use defaults */
	}
	if (process.env.PI_CC_EXPAND_AT_REFS === "1") cfg.expandAtRefs = true;
	if (process.env.PI_CC_EXEC_BASH === "1") cfg.execBashOnExpand = true;
	return cfg;
}

// ---------- Discovery ----------

function tildeify(path: string): string {
	const home = homedir();
	return path === home || path.startsWith(`${home}${sep}`) ? path.replace(home, "~") : path;
}

function expandTilde(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
}

// Find the worktree/repo root by walking up looking for `.git` (dir for normal
// repos, file for worktrees). Returns the directory containing `.git`, or
// undefined if none is found.
function findGitRoot(start: string): string | undefined {
	let dir = resolve(start);
	for (let i = 0; i < 64; i++) {
		try {
			statSync(join(dir, ".git"));
			return dir;
		} catch {
			/* keep walking */
		}
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
	return undefined;
}

function safeIsDir(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function findCommandRoots(cwd: string, cfg: CcConfig): CommandRoot[] {
	const roots: CommandRoot[] = [];

	// Walk from cwd up to (and including) the worktree/repo root, collecting
	// every `.claude/commands` we find. Deepest first → wins on name collision.
	const gitRoot = findGitRoot(cwd);
	const startDir = resolve(cwd);
	let dir = startDir;
	for (let i = 0; i < 64; i++) {
		const candidate = join(dir, ".claude", "commands");
		if (safeIsDir(candidate)) {
			roots.push({ path: candidate, scope: "project", label: tildeify(candidate) });
		}
		if (gitRoot && dir === gitRoot) break;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}

	// Global personal commands
	const personal = join(homedir(), ".claude", "commands");
	if (safeIsDir(personal)) {
		roots.push({ path: personal, scope: "global", label: "~/.claude/commands" });
	}

	// User-configured extras (lowest priority — appended last)
	for (const extra of cfg.extraCommandRoots) {
		const abs = resolve(expandTilde(extra));
		if (safeIsDir(abs)) {
			roots.push({ path: abs, scope: "global", label: tildeify(abs) });
		}
	}

	// Dedupe by absolute path while preserving order (first wins).
	const seen = new Set<string>();
	return roots.filter((r) => (seen.has(r.path) ? false : (seen.add(r.path), true)));
}

// Recursively collect .md files under a commands root.
// Skips `references/` subtrees (Claude Code convention for companion docs)
// and hidden files/dirs.
function walkMdFiles(root: string): string[] {
	const out: string[] = [];
	const stack: string[] = [root];
	while (stack.length > 0) {
		const dir = stack.pop() as string;
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const ent of entries) {
			if (ent.name.startsWith(".")) continue;
			if (ent.isDirectory()) {
				if (ent.name === "references") continue;
				stack.push(join(dir, ent.name));
				continue;
			}
			if (!ent.isFile()) continue;
			if (!ent.name.endsWith(".md")) continue;
			out.push(join(dir, ent.name));
		}
	}
	return out;
}

function deriveName(root: string, file: string): string {
	let rel = relative(root, file);
	if (rel.endsWith(".md")) rel = rel.slice(0, -3);
	return rel.split(sep).join(":");
}

// ---------- Frontmatter ----------

// Minimal YAML-ish frontmatter parser. Supports `key: value`, single-line
// quoted values, and `key: |` / `key: >` block scalars (continuation lines
// must be indented). That's enough for Claude Code's `description`,
// `argument-hint`, `allowed-tools`, `model`, etc.
function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
	const openMatch = raw.match(/^---\r?\n/);
	if (!openMatch) return { meta: {}, body: raw };
	const yamlStart = openMatch[0].length;
	const closingMatch = raw.slice(yamlStart).match(/\r?\n---\r?\n?/);
	if (!closingMatch || closingMatch.index === undefined) return { meta: {}, body: raw };
	const yamlEnd = yamlStart + closingMatch.index;
	const bodyStart = yamlEnd + closingMatch[0].length;
	const yaml = raw.slice(yamlStart, yamlEnd);

	const meta: Record<string, string> = {};
	let pendingKey: string | undefined;
	let pendingBuffer: string[] = [];
	const flushPending = () => {
		if (pendingKey !== undefined) {
			meta[pendingKey] = pendingBuffer.join("\n").trim();
			pendingKey = undefined;
			pendingBuffer = [];
		}
	};

	for (const line of yaml.split(/\r?\n/)) {
		// Continuation of a pending block-scalar value (must be indented).
		if (pendingKey !== undefined && (/^\s+\S/.test(line) || line.trim() === "")) {
			pendingBuffer.push(line.replace(/^\s+/, ""));
			continue;
		}
		const m = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
		if (!m) {
			flushPending();
			continue;
		}
		flushPending();
		const key = m[1];
		const valueRaw = m[2].trim();
		if (valueRaw === "" || valueRaw === "|" || valueRaw === "|-" || valueRaw === ">" || valueRaw === ">-") {
			pendingKey = key;
			pendingBuffer = [];
		} else {
			let v = valueRaw;
			if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
				v = v.slice(1, -1);
			}
			meta[key] = v;
		}
	}
	flushPending();

	return { meta, body: raw.slice(bodyStart) };
}

// ---------- Loading ----------

function loadAllCommands(cwd: string, cfg: CcConfig): { commands: CcCommand[]; roots: CommandRoot[] } {
	const roots = findCommandRoots(cwd, cfg);
	const byName = new Map<string, CcCommand>();

	for (const root of roots) {
		const files = walkMdFiles(root.path);
		for (const file of files) {
			const name = deriveName(root.path, file);
			// First occurrence wins. Roots are ordered deepest-project-first,
			// so a worktree-local override beats anything higher up or global.
			if (byName.has(name)) continue;

			let raw: string;
			try {
				raw = readFileSync(file, "utf8");
			} catch {
				continue;
			}
			const { meta, body } = parseFrontmatter(raw);
			const description = meta.description ? meta.description.replace(/\s+/g, " ").trim() : undefined;
			const argumentHint = meta["argument-hint"]?.trim();

			byName.set(name, {
				name,
				path: file,
				scope: root.scope,
				rootLabel: root.label,
				description,
				argumentHint,
				body: body.replace(/^\r?\n+/, ""),
			});
		}
	}

	return {
		commands: Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name)),
		roots,
	};
}

// ---------- Argument substitution ----------

// Shell-ish word splitter that respects single and double quotes.
function tokenizeArgs(input: string): string[] {
	const out: string[] = [];
	const re = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;
	let m: RegExpExecArray | null = re.exec(input);
	while (m !== null) {
		out.push((m[1] ?? m[2] ?? m[3] ?? "").replace(/\\(["'\\])/g, "$1"));
		m = re.exec(input);
	}
	return out;
}

function substituteArgs(body: string, rawArgs: string): string {
	const argv = tokenizeArgs(rawArgs);
	const joinAll = rawArgs.trim();
	const joinFrom = (n: number, len?: number): string => {
		const start = Math.max(1, n) - 1;
		const slice = typeof len === "number" ? argv.slice(start, start + len) : argv.slice(start);
		return slice.join(" ");
	};

	let out = body;
	// Order matters: most specific patterns first so they aren't eaten by
	// shorter ones (e.g. ${1:-x} before ${1} before $1).
	out = out.replace(/\$\{@:(\d+):(\d+)\}/g, (_, n, l) => joinFrom(parseInt(n, 10), parseInt(l, 10)));
	out = out.replace(/\$\{@:(\d+)\}/g, (_, n) => joinFrom(parseInt(n, 10)));
	out = out.replace(/\$\{ARGUMENTS\}/g, joinAll);
	out = out.replace(/\$\{(\d+):-([^}]*)\}/g, (_, n, def) => argv[parseInt(n, 10) - 1] ?? def);
	out = out.replace(/\$\{(\d+)\}/g, (_, n) => argv[parseInt(n, 10) - 1] ?? "");
	out = out.replace(/\$ARGUMENTS\b/g, joinAll);
	out = out.replace(/\$@/g, joinAll);
	out = out.replace(/\$([1-9])/g, (_, n) => argv[parseInt(n, 10) - 1] ?? "");
	return out;
}

// ---------- Optional expansions (off by default) ----------

// `@path` inline file inclusion. Conservative: require the token to look like
// a path (`./`, `../`, `~/`, `/`, or `something/...`) to avoid eating email
// addresses and decorators.
function expandAtRefs(body: string, cwd: string, maxBytes: number): string {
	return body.replace(/(^|\s)@((?:\.\.?\/|~\/|\/)\S+|[A-Za-z0-9_.-]+\/\S+)/g, (full, lead: string, ref: string) => {
		const target = ref.startsWith("~/") || ref === "~" ? expandTilde(ref) : resolve(cwd, ref);
		try {
			const st = statSync(target);
			if (!st.isFile()) return full;
			const buf = readFileSync(target, "utf8");
			const truncated = buf.length > maxBytes;
			const body = truncated ? `${buf.slice(0, maxBytes)}\n…truncated at ${maxBytes} bytes` : buf;
			return `${lead}\n\n\`\`\`\n# @${ref}\n${body}\n\`\`\`\n`;
		} catch {
			return full;
		}
	});
}

// `!cmd` line execution. Only matches lines whose first non-whitespace char is
// `!` and is not part of a code fence. Output is captured into a fenced block.
function execBangLines(body: string, cwd: string, timeoutMs: number): string {
	const lines = body.split(/\r?\n/);
	const out: string[] = [];
	let inFence = false;
	for (const ln of lines) {
		if (/^\s*```/.test(ln)) {
			inFence = !inFence;
			out.push(ln);
			continue;
		}
		const m = !inFence ? ln.match(/^\s*!\s*(.+)$/) : null;
		if (!m) {
			out.push(ln);
			continue;
		}
		const cmd = m[1];
		let result: string;
		let exitTag = "exit 0";
		try {
			const buf = execFileSync("bash", ["-c", cmd], {
				cwd,
				stdio: ["ignore", "pipe", "pipe"],
				timeout: timeoutMs,
				maxBuffer: 256 * 1024,
			});
			result = buf.toString("utf8");
		} catch (err: unknown) {
			const e = err as { stdout?: Buffer; stderr?: Buffer; status?: number; code?: string };
			const stdout = e.stdout?.toString("utf8") ?? "";
			const stderr = e.stderr?.toString("utf8") ?? "";
			result = `${stdout}${stderr ? `\n[stderr]\n${stderr}` : ""}`;
			exitTag = `exit ${e.status ?? e.code ?? "?"}`;
		}
		out.push("```");
		out.push(`# ! ${cmd}  (${exitTag})`);
		out.push(result.replace(/\s+$/, ""));
		out.push("```");
	}
	return out.join("\n");
}

function expandBody(cmd: CcCommand, args: string, cwd: string, cfg: CcConfig): string {
	let body = cmd.body;
	body = substituteArgs(body, args);
	if (cfg.expandAtRefs) body = expandAtRefs(body, cwd, cfg.maxFileBytes);
	if (cfg.execBashOnExpand) body = execBangLines(body, cwd, cfg.execTimeoutMs);
	return body;
}

function bodyExpectsArgs(cmd: CcCommand): boolean {
	if (cmd.argumentHint && cmd.argumentHint.length > 0) return true;
	return /\$(?:ARGUMENTS|@|\{ARGUMENTS\}|\{@|\{?[1-9])/.test(cmd.body);
}

function unsupportedSyntaxWarnings(cmd: CcCommand, cfg: CcConfig): string[] {
	const warns: string[] = [];
	if (!cfg.execBashOnExpand && /^\s*!\s*\S/m.test(cmd.body)) {
		warns.push("contains `!cmd` lines (bash exec disabled — left literal)");
	}
	if (!cfg.expandAtRefs && /(^|\s)@(?:\.\.?\/|~\/|\/|[A-Za-z0-9_.-]+\/)\S+/.test(cmd.body)) {
		warns.push("contains `@file` refs (file inclusion disabled — left literal)");
	}
	return warns;
}

// ---------- Flow ----------

async function runFlow(_pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string) {
	const cfg = loadConfig();
	const { commands } = loadAllCommands(ctx.cwd, cfg);

	if (commands.length === 0) {
		ctx.ui.notify(
			"No Claude Code commands found. Looked for .claude/commands/ between cwd and the git/worktree root, plus ~/.claude/commands.",
			"warning",
		);
		return;
	}

	// Parse optional inline name and args:
	//   /cc-commands                          → picker
	//   /cc-commands git:silver-bullet        → load by name, ask for args if any
	//   /cc-commands git:silver-bullet --foo  → load by name with args
	const trimmed = args.trim();
	let chosen: CcCommand | undefined;
	let cmdArgs = "";

	if (trimmed.length > 0) {
		const headMatch = trimmed.match(/^(\S+)(?:\s+([\s\S]*))?$/);
		const head = headMatch?.[1] ?? trimmed;
		cmdArgs = headMatch?.[2]?.trim() ?? "";
		chosen = commands.find((c) => c.name === head);
		if (!chosen) {
			ctx.ui.notify(
				`No Claude Code command named "${head}". Run /cc-commands with no arguments to browse.`,
				"error",
			);
			return;
		}
	} else {
		if (!ctx.hasUI) {
			ctx.ui.notify(
				"/cc-commands needs an interactive UI to show the picker. Pass a command name as an argument instead.",
				"error",
			);
			return;
		}
		const items: SelectItem[] = commands.map((c) => {
			const scopeTag = c.scope === "project" ? "[prj]" : "[~]  ";
			const hint = c.argumentHint ? ` ${c.argumentHint}` : "";
			return {
				value: c.name,
				label: `${scopeTag} ${c.name}${hint}`,
				description: c.description,
			};
		});
		const selectedName = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
			const container = new Container();
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			container.addChild(
				new Text(
					theme.fg("accent", theme.bold(`Claude Code commands (${commands.length})`)),
					1,
					0,
				),
			);

			const selectList = new SelectList(
				items,
				Math.min(items.length, PICKER_VISIBLE_ROWS),
				{
					selectedPrefix: (t: string) => theme.fg("accent", t),
					selectedText: (t: string) => theme.fg("accent", t),
					description: (t: string) => theme.fg("muted", t),
					scrollInfo: (t: string) => theme.fg("dim", t),
					noMatch: (t: string) => theme.fg("warning", t),
				},
			);
			selectList.onSelect = (item) => done(item.value);
			selectList.onCancel = () => done(null);
			container.addChild(selectList);

			// SelectList's built-in handleInput only handles up/down/enter/esc,
			// and its setFilter() does prefix-on-value only. We layer fuzzy
			// substring matching on top by maintaining our own buffer and
			// swapping the SelectList's internal filteredItems each keystroke.
			let filter = "";
			const slPrivate = selectList as unknown as {
				filteredItems: SelectItem[];
				selectedIndex: number;
			};
			const filterStatus = new Text(theme.fg("dim", "Filter: (type to filter)"), 1, 0);
			container.addChild(filterStatus);
			container.addChild(
				new Text(
					theme.fg(
						"dim",
						"type to filter • backspace delete • ctrl+u clear • ↑↓ navigate • enter select • esc cancel",
					),
					1,
					0,
				),
			);
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

			const applyFilter = (): void => {
				const filtered =
					filter === ""
						? items
						: fuzzyFilter(
								items,
								filter,
								(it) => `${it.value} ${it.description ?? ""}`,
							);
				slPrivate.filteredItems = filtered;
				slPrivate.selectedIndex = 0;
				selectList.invalidate();
				const label =
					filter === ""
						? "Filter: (type to filter)"
						: `Filter: ${filter}  (${filtered.length}/${items.length})`;
				filterStatus.setText(theme.fg("dim", label));
			};

			const hasControlChars = (s: string): boolean =>
				[...s].some((ch) => {
					const code = ch.charCodeAt(0);
					return code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
				});

			return {
				render: (w: number) => container.render(w),
				invalidate: () => container.invalidate(),
				handleInput: (data: string) => {
					const kb = getKeybindings();
					let changed = false;

					// Navigation + submit/cancel go to SelectList unchanged.
					if (
						kb.matches(data, "tui.select.up") ||
						kb.matches(data, "tui.select.down") ||
						kb.matches(data, "tui.select.confirm") ||
						kb.matches(data, "tui.select.cancel")
					) {
						selectList.handleInput(data);
						tui.requestRender();
						return;
					}

					// Backspace deletes one char from the filter.
					if (kb.matches(data, "tui.editor.deleteCharBackward")) {
						if (filter.length > 0) {
							filter = filter.slice(0, -1);
							changed = true;
						}
					}
					// Ctrl+U / delete-to-line-start clears the filter.
					else if (
						kb.matches(data, "tui.editor.deleteToLineStart") ||
						kb.matches(data, "tui.editor.deleteWordBackward")
					) {
						if (filter.length > 0) {
							filter = "";
							changed = true;
						}
					}
					// Plain printable text gets appended.
					else if (data.length > 0 && !hasControlChars(data)) {
						filter += data;
						changed = true;
					}

					if (changed) {
						applyFilter();
						tui.requestRender();
					}
				},
			};
		});
		if (!selectedName) return;
		chosen = commands.find((c) => c.name === selectedName);
		if (!chosen) return;
	}

	// Prompt for arguments if the body expects them and none were supplied.
	if (chosen && cmdArgs.length === 0 && bodyExpectsArgs(chosen)) {
		if (ctx.hasUI) {
			const hint = chosen.argumentHint ?? "$ARGUMENTS";
			const input = await ctx.ui.input(`Arguments for /${chosen.name}`, hint);
			if (input === undefined) return;
			cmdArgs = input;
		}
		// Without UI we just expand with empty args; users can edit afterwards.
	}

	if (!chosen) return;

	for (const w of unsupportedSyntaxWarnings(chosen, cfg)) {
		ctx.ui.notify(`/${chosen.name}: ${w}`, "warning");
	}

	const expanded = expandBody(chosen, cmdArgs, ctx.cwd, cfg);

	// Don't silently clobber an in-flight prompt the user is composing.
	const existing = ctx.ui.getEditorText?.() ?? "";
	if (existing.trim().length > 0) {
		const ok = await ctx.ui.confirm(
			"Replace editor contents?",
			`The editor has unsent text. Replace it with the expansion of /${chosen.name}?`,
		);
		if (!ok) {
			ctx.ui.notify(`/${chosen.name} not loaded — editor left as-is.`, "info");
			return;
		}
	}

	ctx.ui.setEditorText(expanded);
	ctx.ui.notify(
		`Loaded /${chosen.name} from ${chosen.rootLabel} (${expanded.length.toLocaleString()} chars). Review and press Enter to send.`,
		"info",
	);
}

// ---------- Extension entry ----------

export default function ccCommandsExtension(pi: ExtensionAPI) {
	pi.registerCommand("cc-commands", {
		description: "Browse Claude Code slash commands (.claude/commands) and prefill the editor",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			try {
				const cfg = loadConfig();
				// getArgumentCompletions has no ctx; fall back to process.cwd().
				const { commands } = loadAllCommands(process.cwd(), cfg);
				const matches = commands
					.filter((c) => c.name.startsWith(prefix))
					.slice(0, 50) // keep dropdown manageable
					.map((c) => ({
						value: c.name,
						label: c.description ? `${c.name} — ${c.description}` : c.name,
					}));
				return matches.length > 0 ? matches : null;
			} catch {
				return null;
			}
		},
		handler: async (args, ctx) => {
			await runFlow(pi, ctx, args);
		},
	});

	pi.registerCommand("cc-commands-info", {
		description: "Show how pi-cc-commands resolved its sources",
		handler: async (_args, ctx) => {
			const cfg = loadConfig();
			const { commands, roots } = loadAllCommands(ctx.cwd, cfg);

			const lines: string[] = [];
			lines.push(`cwd:               ${ctx.cwd}`);
			lines.push(`git/worktree root: ${findGitRoot(ctx.cwd) ?? "(none)"}`);
			lines.push(`expandAtRefs:      ${cfg.expandAtRefs}`);
			lines.push(`execBashOnExpand:  ${cfg.execBashOnExpand}`);
			lines.push(
				`extraCommandRoots: ${cfg.extraCommandRoots.length > 0 ? cfg.extraCommandRoots.join(", ") : "(none)"}`,
			);
			lines.push("");
			lines.push(`Command roots (priority high → low):`);
			if (roots.length === 0) {
				lines.push("  (none found)");
			} else {
				for (const r of roots) lines.push(`  [${r.scope}] ${r.label}`);
			}
			lines.push("");
			lines.push(`Discovered ${commands.length} command(s):`);
			const MAX_LISTED = 40;
			const listed = commands.slice(0, MAX_LISTED);
			for (const c of listed) {
				const hint = c.argumentHint ? ` ${c.argumentHint}` : "";
				lines.push(`  /${c.name}${hint}  ← ${c.rootLabel}`);
			}
			if (commands.length > MAX_LISTED) {
				lines.push(`  … and ${commands.length - MAX_LISTED} more — use /cc-commands to browse all`);
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
