import * as fs from 'fs';
import * as path from 'path';

export type InfoFileKind = 'exclude' | 'attributes';

/** Walk up from a file or directory until a `.git` entry (dir or pointer file) is found. */
export function findRepoRoot(startPath: string): string | undefined {
	let dir = startPath;
	try {
		if (!fs.statSync(dir).isDirectory()) {
			dir = path.dirname(dir);
		}
	} catch {
		dir = path.dirname(dir);
	}
	while (true) {
		if (fs.existsSync(path.join(dir, '.git'))) {
			return dir;
		}
		const parent = path.dirname(dir);
		if (parent === dir) {
			return undefined;
		}
		dir = parent;
	}
}

/**
 * Resolve the actual git directory for a repo root. `.git` may be a directory
 * (standard repo) or a file containing a `gitdir: <path>` pointer (worktree/submodule).
 */
export function resolveGitDir(repoRoot: string): string {
	const dotGit = path.join(repoRoot, '.git');
	if (fs.statSync(dotGit).isDirectory()) {
		return dotGit;
	}
	const content = fs.readFileSync(dotGit, 'utf8');
	const match = /^gitdir:\s*(.+?)\s*$/m.exec(content);
	if (!match) {
		throw new Error(`Cannot parse gitdir pointer in ${dotGit}`);
	}
	return path.resolve(repoRoot, match[1]);
}

/**
 * The git directory that holds `info/`. Linked worktrees share the main repo's
 * (named by their `commondir` file); git ignores a per-worktree `info/`.
 */
export function resolveCommonGitDir(repoRoot: string): string {
	const gitDir = resolveGitDir(repoRoot);
	const commonDirFile = path.join(gitDir, 'commondir');
	if (fs.existsSync(commonDirFile)) {
		return path.resolve(gitDir, fs.readFileSync(commonDirFile, 'utf8').trim());
	}
	return gitDir;
}

export function getInfoFilePath(repoRoot: string, kind: InfoFileKind): string {
	return path.join(resolveCommonGitDir(repoRoot), 'info', kind);
}

export function samePath(a: string, b: string): boolean {
	const norm = (p: string) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
	return norm(a) === norm(b);
}

/**
 * Given the fsPath of a `<gitdir>/info/exclude|attributes` file, find the working
 * tree root it belongs to. Candidate roots (the open workspace) win, so a linked
 * worktree maps to itself rather than to the main checkout that owns the shared gitdir.
 */
export function findWorkTreeRoot(infoFilePath: string, candidateRoots: string[] = []): string | undefined {
	const gitDir = path.dirname(path.dirname(infoFilePath));
	for (const root of candidateRoots) {
		try {
			if (samePath(resolveCommonGitDir(root), gitDir)) {
				return root;
			}
		} catch {
			// unreadable .git pointer; try the next candidate
		}
	}
	if (path.basename(gitDir) === '.git') {
		return path.dirname(gitDir);
	}
	// Submodule gitdirs (.git/modules/<name>) record their working tree in config.
	try {
		const config = fs.readFileSync(path.join(gitDir, 'config'), 'utf8');
		const match = /^\s*worktree\s*=\s*(.+?)\s*$/m.exec(config);
		if (match) {
			return path.resolve(gitDir, match[1]);
		}
	} catch {
		// no config; give up
	}
	return undefined;
}

export function ensureFile(filePath: string): void {
	if (!fs.existsSync(filePath)) {
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, '');
	}
}

export function isRuleLine(line: string): boolean {
	const trimmed = line.trim();
	return trimmed.length > 0 && !trimmed.startsWith('#');
}

/** Index after the last non-blank line, i.e. where appended content belongs. */
function contentEnd(lines: string[]): number {
	let end = lines.length;
	while (end > 0 && lines[end - 1].trim() === '') {
		end--;
	}
	return end;
}

/** Indices of lines matching the rule exactly (trimmed). */
export function findRuleLines(lines: string[], rule: string): number[] {
	const found: number[] = [];
	lines.forEach((line, i) => {
		if (line.trim() === rule) {
			found.push(i);
		}
	});
	return found;
}

/**
 * Line index to insert a new rule at, keeping rule lines alphabetically ordered;
 * comments and blank lines stay where they are. Undefined when the rule already exists.
 *
 * In attributes files and ignore files with `!` negations, later lines override
 * earlier ones, so the rule is appended instead to make sure it takes effect.
 */
export function findInsertLine(lines: string[], rule: string, fileName: string): number | undefined {
	if (findRuleLines(lines, rule).length > 0) {
		return undefined;
	}
	const end = contentEnd(lines);
	const orderMatters =
		fileName === '.gitattributes' ||
		fileName === 'attributes' ||
		rule.startsWith('!') ||
		lines.some(line => line.trim().startsWith('!'));
	if (orderMatters) {
		return end;
	}
	let lastRuleIndex = -1;
	for (let i = 0; i < end; i++) {
		if (!isRuleLine(lines[i])) {
			continue;
		}
		if (lines[i].trim().localeCompare(rule) > 0) {
			return i;
		}
		lastRuleIndex = i;
	}
	return lastRuleIndex >= 0 ? lastRuleIndex + 1 : end;
}

/** A rule file being edited as lines; indices match VS Code's document line numbers. */
export interface RuleFile {
	readonly fileName: string;
	lines(): string[];
	insert(at: number, rule: string): Promise<void>;
	remove(indices: number[]): Promise<void>;
}

/** Edits a file on disk, keeping its line endings. Call `save()` when done. */
export class DiskRuleFile implements RuleFile {
	readonly fileName: string;
	private readonly current: string[];
	private readonly eol: string;
	private changed = false;

	constructor(private readonly filePath: string) {
		this.fileName = path.basename(filePath);
		const content = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
		this.current = content.split(/\r?\n/);
		this.eol = content.includes('\r\n') ? '\r\n' : '\n';
	}

	lines(): string[] {
		return this.current;
	}

	insert(at: number, rule: string): Promise<void> {
		this.current.splice(at, 0, rule);
		this.changed = true;
		return Promise.resolve();
	}

	remove(indices: number[]): Promise<void> {
		for (const i of [...indices].sort((a, b) => b - a)) {
			this.current.splice(i, 1);
		}
		this.changed = true;
		return Promise.resolve();
	}

	save(): void {
		if (this.changed) {
			fs.writeFileSync(this.filePath, this.current.join(this.eol));
		}
	}
}

/** True when the text matches the file on disk, ignoring line-ending differences. */
export function matchesDisk(filePath: string, text: string): boolean {
	const normalize = (s: string) => s.replace(/\r\n/g, '\n');
	return normalize(fs.readFileSync(filePath, 'utf8')) === normalize(text);
}

/** Add a rule at its sorted (or, where order matters, appended) position. */
export async function addRule(file: RuleFile, rule: string): Promise<'added' | 'exists'> {
	const at = findInsertLine(file.lines(), rule, file.fileName);
	if (at === undefined) {
		return 'exists';
	}
	await file.insert(at, rule);
	return 'added';
}

/** Remove every line matching the rule. Returns true if anything was removed. */
export async function removeRule(file: RuleFile, rule: string): Promise<boolean> {
	const found = findRuleLines(file.lines(), rule);
	if (found.length === 0) {
		return false;
	}
	await file.remove(found);
	return true;
}

/**
 * Repo-root-relative rule text: forward slashes, trailing slash for directories,
 * and `[` escaped so names like `file[1].txt` aren't read as a pattern (as VS Code's git.ignore does).
 */
export function toRelativeRule(repoRoot: string, targetPath: string): string {
	let rule = path.relative(repoRoot, targetPath).split(path.sep).join('/').replace(/\[/g, '\\[');
	try {
		if (fs.statSync(targetPath).isDirectory() && !rule.endsWith('/')) {
			rule += '/';
		}
	} catch {
		// target may not exist on disk; leave the rule as-is
	}
	return rule;
}

const INFO_FILE_RE = /(^|\/)\.git\/(?:modules\/.+\/)?info\/(exclude|attributes)$/;

/** Classify a normalized (forward-slash) fsPath as a local info file, if it is one. */
export function classifyInfoFile(fsPath: string): InfoFileKind | undefined {
	const match = INFO_FILE_RE.exec(fsPath.replace(/\\/g, '/'));
	return match ? (match[2] as InfoFileKind) : undefined;
}

/** True when the given file sits directly in a repo root (a sibling `.git` exists). */
export function isInRepoRoot(fsPath: string): boolean {
	return fs.existsSync(path.join(path.dirname(fsPath), '.git'));
}
