import * as path from 'path';
import * as vscode from 'vscode';
import * as core from './core';

/** Find the repo root for a path; tells the user and returns undefined when there is none. */
function resolveRepoRoot(fromPath: string): string | undefined {
	const root = core.findRepoRoot(fromPath);
	if (!root) {
		void vscode.window.showWarningMessage('No Git repository found.');
	}
	return root;
}

/** Best-effort starting path for palette invocations without a resource argument. */
function contextPath(uri?: vscode.Uri): string | undefined {
	const active = vscode.window.activeTextEditor?.document.uri;
	return (
		uri?.fsPath ??
		(active?.scheme === 'file' ? active.fsPath : undefined) ??
		vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
	);
}

/** Repo roots of the open workspace folders, used to map a shared gitdir back to the right worktree. */
function workspaceRepoRoots(): string[] {
	return (vscode.workspace.workspaceFolders ?? [])
		.map(folder => core.findRepoRoot(folder.uri.fsPath))
		.filter((root): root is string => root !== undefined);
}

/** The slice of VS Code's Git extension API we use. */
interface GitApi {
	getRepository(uri: vscode.Uri): { status(): Promise<void> } | null;
}

/**
 * Ask VS Code's Git extension to re-run status after a rule file changes. It misses
 * `.git/info/*` entirely (it only watches the top level of `.git`), and only picks up
 * `.gitignore`/`.gitattributes` after a debounce, so refresh explicitly for both.
 */
function refreshGitStatus(filePath: string): void {
	const base = path.basename(filePath);
	const root = core.classifyInfoFile(filePath)
		? core.findWorkTreeRoot(filePath, workspaceRepoRoots())
		: (base === '.gitignore' || base === '.gitattributes') && core.isInRepoRoot(filePath)
			? path.dirname(filePath)
			: undefined;
	const git = vscode.extensions.getExtension<{ getAPI(version: 1): GitApi }>('vscode.git');
	if (!git?.isActive || !root) {
		return;
	}
	git.exports.getAPI(1).getRepository(vscode.Uri.file(root))?.status().then(undefined, () => undefined);
}

async function openFileEnsured(filePath: string): Promise<void> {
	core.ensureFile(filePath);
	const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
	await vscode.window.showTextDocument(doc);
}

/**
 * Rule files Git Hush edited and saved, keyed by URI. Undo/redo of exactly those
 * edits is saved too, so Ctrl+Z reverts the hush on disk rather than leaving the
 * file dirty with the rule still in effect. Any other change ends the tracking.
 */
const ourSavedEdits = new Map<string, TrackedEdits>();

interface TrackedEdits {
	version: number;
	steps: number;
	undone: number;
	/** Keeps another file in step, e.g. the target of a moved rule. */
	linked?: { undo(): Promise<void>; redo(): Promise<void> };
}

function trackSavedEdits(doc: vscode.TextDocument, steps: number, linked?: TrackedEdits['linked']): void {
	if (steps > 0) {
		ourSavedEdits.set(doc.uri.toString(), { version: doc.version, steps, undone: 0, linked });
	}
}

function onRuleFileChanged(e: vscode.TextDocumentChangeEvent): void {
	const key = e.document.uri.toString();
	const tracked = ourSavedEdits.get(key);
	if (!tracked || e.contentChanges.length === 0) {
		return;
	}
	const isNext = e.document.version === tracked.version + 1;
	let linkedStep: (() => Promise<void>) | undefined;
	if (isNext && e.reason === vscode.TextDocumentChangeReason.Undo && tracked.undone < tracked.steps) {
		tracked.undone++;
		linkedStep = tracked.linked?.undo;
	} else if (isNext && e.reason === vscode.TextDocumentChangeReason.Redo && tracked.undone > 0) {
		tracked.undone--;
		linkedStep = tracked.linked?.redo;
	} else {
		ourSavedEdits.delete(key);
		return;
	}
	tracked.version = e.document.version;
	void e.document.save();
	linkedStep?.().then(undefined, error =>
		vscode.window.showErrorMessage(`Could not update the other file – ${String(error)}`));
}

/** A rule file open in VS Code, edited through WorkspaceEdits so changes are undoable. */
class DocRuleFile implements core.RuleFile {
	readonly fileName: string;
	/** Number of edits applied, i.e. the undo steps they occupy. */
	edits = 0;

	constructor(private readonly doc: vscode.TextDocument) {
		this.fileName = path.basename(doc.uri.fsPath);
	}

	lines(): string[] {
		return this.doc.getText().split(/\r?\n/);
	}

	async insert(at: number, rule: string): Promise<void> {
		const edit = new vscode.WorkspaceEdit();
		if (at < this.doc.lineCount) {
			edit.insert(this.doc.uri, new vscode.Position(at, 0), rule + '\n');
		} else {
			// Last line has no trailing newline: append after it.
			edit.insert(this.doc.uri, this.doc.lineAt(this.doc.lineCount - 1).range.end, '\n' + rule);
		}
		await applyOrThrow(edit);
		this.edits++;
	}

	async remove(indices: number[]): Promise<void> {
		const edit = new vscode.WorkspaceEdit();
		for (const i of indices) {
			edit.delete(this.doc.uri, this.doc.lineAt(i).rangeIncludingLineBreak);
		}
		await applyOrThrow(edit);
		this.edits++;
	}
}

async function applyOrThrow(edit: vscode.WorkspaceEdit): Promise<void> {
	if (!(await vscode.workspace.applyEdit(edit))) {
		throw new Error('edit was rejected');
	}
}

/**
 * Edit a rule file. If VS Code already has it open, edit it there: unsaved changes
 * stay unsaved (ours are added alongside), otherwise it is saved and undo works.
 * Files VS Code doesn't have open, or holds a stale copy of, are edited on disk.
 */
async function editRuleFile<T>(filePath: string, apply: (file: core.RuleFile) => Promise<T>, trackUndo = true): Promise<T> {
	core.ensureFile(filePath);
	const doc = vscode.workspace.textDocuments.find(d => d.uri.scheme === 'file' && core.samePath(d.uri.fsPath, filePath));
	if (doc && (doc.isDirty || core.matchesDisk(filePath, doc.getText()))) {
		const wasDirty = doc.isDirty;
		const file = new DocRuleFile(doc);
		const result = await apply(file);
		if (!wasDirty && doc.isDirty) {
			if (!(await doc.save())) {
				throw new Error(`could not save ${path.basename(filePath)}`);
			}
			if (trackUndo) {
				trackSavedEdits(doc, file.edits);
			}
		}
		return result;
	}
	const file = new core.DiskRuleFile(filePath);
	const result = await apply(file);
	file.save();
	refreshGitStatus(filePath);
	return result;
}

async function openLocalInfoFile(kind: core.InfoFileKind, uri?: vscode.Uri): Promise<void> {
	const start = contextPath(uri);
	if (!start) {
		return;
	}
	const repoRoot = resolveRepoRoot(start);
	if (!repoRoot) {
		return;
	}
	try {
		await openFileEnsured(core.getInfoFilePath(repoRoot, kind));
	} catch (error) {
		void vscode.window.showErrorMessage(`Could not open local ${kind} – ${String(error)}`);
	}
}

async function openSharedFile(fileName: '.gitignore' | '.gitattributes', uri?: vscode.Uri): Promise<void> {
	const start = contextPath(uri);
	if (!start) {
		return;
	}
	// From inside a gitdir's info/ file, map back to the working tree first.
	const kind = core.classifyInfoFile(start);
	const repoRoot = kind ? core.findWorkTreeRoot(start, workspaceRepoRoots()) : resolveRepoRoot(start);
	if (!repoRoot) {
		if (kind) {
			void vscode.window.showWarningMessage(`Could not find the working tree for ${start}`);
		}
		return;
	}
	try {
		await openFileEnsured(path.join(repoRoot, fileName));
	} catch (error) {
		void vscode.window.showErrorMessage(`Could not open ${fileName} – ${String(error)}`);
	}
}

function capitalize(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Toggle the given resources in the target ignore file (local exclude or root .gitignore). */
async function toggleIgnore(scope: 'local' | 'shared', uri?: vscode.Uri, uris?: vscode.Uri[]): Promise<void> {
	const targets = uris?.length ? uris : uri ? [uri] : [];
	const start = targets[0]?.fsPath ?? contextPath();
	if (!start) {
		return;
	}
	if (targets.length === 0) {
		targets.push(vscode.Uri.file(start));
	}
	const repoRoot = resolveRepoRoot(start);
	if (!repoRoot) {
		return;
	}
	let ignoreFile: string;
	try {
		ignoreFile = scope === 'local' ? core.getInfoFilePath(repoRoot, 'exclude') : path.join(repoRoot, '.gitignore');
	} catch (error) {
		void vscode.window.showErrorMessage(`Could not resolve ignore file – ${String(error)}`);
		return;
	}
	const added: string[] = [];
	const removed: string[] = [];
	const toggled: vscode.Uri[] = [];
	try {
		await editRuleFile(ignoreFile, async file => {
			for (const target of targets) {
				const rule = core.toRelativeRule(repoRoot, target.fsPath);
				if (!rule || rule.startsWith('..')) {
					continue;
				}
				if (await core.removeRule(file, rule)) {
					removed.push(rule);
				} else {
					await core.addRule(file, rule);
					added.push(rule);
				}
				toggled.push(target);
			}
		});
	} catch (error) {
		void vscode.window.showErrorMessage(`Failed to update ${path.basename(ignoreFile)} – ${String(error)}`);
		return;
	}
	const parts: string[] = [];
	if (added.length) {
		parts.push(`hushed ${added.join(', ')}`);
	}
	if (removed.length) {
		parts.push(`un-hushed ${removed.join(', ')}`);
	}
	if (parts.length) {
		// Toggling the same paths again is the exact inverse, so it doubles as undo.
		void vscode.window.showInformationMessage(`${capitalize(parts.join('; '))} (${scope})`, 'Undo').then(choice => {
			if (choice === 'Undo') {
				void toggleIgnore(scope, undefined, toggled);
			}
		});
	}
}

/** Move a rule line between a shared tracked file and its local gitdir counterpart. */
async function moveRule(direction: 'toLocal' | 'toShared', uri: vscode.Uri, lineNumber: number): Promise<void> {
	const doc = await vscode.workspace.openTextDocument(uri);
	if (lineNumber >= doc.lineCount) {
		return;
	}
	const line = doc.lineAt(lineNumber);
	const rule = line.text.trim();
	if (!core.isRuleLine(rule)) {
		return;
	}

	let targetFile: string;
	let targetLabel: string;
	try {
		if (direction === 'toLocal') {
			const repoRoot = path.dirname(uri.fsPath);
			const kind: core.InfoFileKind = path.basename(uri.fsPath) === '.gitattributes' ? 'attributes' : 'exclude';
			targetFile = core.getInfoFilePath(repoRoot, kind);
			targetLabel = `.git/info/${kind}`;
		} else {
			const kind = core.classifyInfoFile(uri.fsPath);
			const repoRoot = kind ? core.findWorkTreeRoot(uri.fsPath, workspaceRepoRoots()) : undefined;
			if (!kind || !repoRoot) {
				void vscode.window.showWarningMessage('Could not find the working tree for this file.');
				return;
			}
			targetLabel = kind === 'attributes' ? '.gitattributes' : '.gitignore';
			targetFile = path.join(repoRoot, targetLabel);
		}
	} catch (error) {
		void vscode.window.showErrorMessage(`Could not resolve target file – ${String(error)}`);
		return;
	}

	// Write the target first: if that fails, the rule is still in the source.
	// Its undo is driven from the source file (below), so it isn't tracked on its own.
	let addedToTarget: boolean;
	try {
		addedToTarget = await editRuleFile(targetFile, target => core.addRule(target, rule), false) === 'added';
		if (!addedToTarget) {
			void vscode.window.showInformationMessage(`Rule already in ${targetLabel}`);
		}
	} catch (error) {
		void vscode.window.showErrorMessage(`Failed to write ${targetLabel} – ${String(error)}`);
		return;
	}

	// Only save if the file had no other unsaved edits, so we never save work the user hasn't.
	const wasDirty = doc.isDirty;
	const edit = new vscode.WorkspaceEdit();
	edit.delete(uri, line.rangeIncludingLineBreak);
	const removed = (await vscode.workspace.applyEdit(edit)) && (wasDirty || (await doc.save()));
	if (removed && !wasDirty) {
		// Ctrl+Z in the source undoes the whole move, but only takes back what we added to the target.
		trackSavedEdits(doc, 1, addedToTarget ? {
			undo: () => editRuleFile(targetFile, target => core.removeRule(target, rule), false).then(() => undefined),
			redo: () => editRuleFile(targetFile, target => core.addRule(target, rule), false).then(() => undefined),
		} : undefined);
	}
	if (!removed) {
		void vscode.window.showWarningMessage(`Rule added to ${targetLabel}, but could not remove it from ${path.basename(uri.fsPath)}`);
	}
}

const FILE_SELECTOR: vscode.DocumentSelector = [
	{ scheme: 'file', pattern: '**/.gitignore' },
	{ scheme: 'file', pattern: '**/.gitattributes' },
	{ scheme: 'file', pattern: '**/.git/**/info/{exclude,attributes}' },
];

interface Counterpart {
	lensTitle: string;
	openCommand: string;
	moveTitle: string;
	moveCommand: string;
}

/** Each rule file's partner: the link shown at its top and the quick fix that moves rules across. */
const COUNTERPARTS: Record<'.gitignore' | '.gitattributes' | core.InfoFileKind, Counterpart> = {
	'.gitignore': {
		lensTitle: 'Open .git/info/exclude',
		openCommand: 'git-hush.openExclude',
		moveTitle: 'Git Hush: Move rule to local exclude',
		moveCommand: 'git-hush.moveRuleToLocal',
	},
	'.gitattributes': {
		lensTitle: 'Open .git/info/attributes',
		openCommand: 'git-hush.openAttributes',
		moveTitle: 'Git Hush: Move rule to local attributes',
		moveCommand: 'git-hush.moveRuleToLocal',
	},
	exclude: {
		lensTitle: 'Open .gitignore',
		openCommand: 'git-hush.openGitignore',
		moveTitle: 'Git Hush: Move rule to .gitignore',
		moveCommand: 'git-hush.moveRuleToShared',
	},
	attributes: {
		lensTitle: 'Open .gitattributes',
		openCommand: 'git-hush.openGitattributes',
		moveTitle: 'Git Hush: Move rule to .gitattributes',
		moveCommand: 'git-hush.moveRuleToShared',
	},
};

/** The counterpart for a repo-root .gitignore/.gitattributes or a .git/info file, if it is one. */
function counterpartOf(fsPath: string): Counterpart | undefined {
	const base = path.basename(fsPath);
	if ((base === '.gitignore' || base === '.gitattributes') && core.isInRepoRoot(fsPath)) {
		return COUNTERPARTS[base];
	}
	const kind = core.classifyInfoFile(fsPath);
	return kind ? COUNTERPARTS[kind] : undefined;
}

class GitHushCodeLensProvider implements vscode.CodeLensProvider {
	provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
		const counterpart = counterpartOf(document.uri.fsPath);
		if (!counterpart) {
			return [];
		}
		return [new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
			title: counterpart.lensTitle,
			command: counterpart.openCommand,
			arguments: [document.uri],
		})];
	}
}

class GitHushCodeActionProvider implements vscode.CodeActionProvider {
	provideCodeActions(document: vscode.TextDocument, range: vscode.Range): vscode.CodeAction[] {
		if (!core.isRuleLine(document.lineAt(range.start.line).text)) {
			return [];
		}
		const counterpart = counterpartOf(document.uri.fsPath);
		if (!counterpart) {
			return [];
		}
		const action = new vscode.CodeAction(counterpart.moveTitle, vscode.CodeActionKind.QuickFix);
		action.command = {
			title: counterpart.moveTitle,
			command: counterpart.moveCommand,
			arguments: [document.uri, range.start.line],
		};
		return [action];
	}
}

export function activate(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('git-hush.openExclude', (uri?: vscode.Uri) => openLocalInfoFile('exclude', uri)),
		vscode.commands.registerCommand('git-hush.openAttributes', (uri?: vscode.Uri) => openLocalInfoFile('attributes', uri)),
		vscode.commands.registerCommand('git-hush.openGitignore', (uri?: vscode.Uri) => openSharedFile('.gitignore', uri)),
		vscode.commands.registerCommand('git-hush.openGitattributes', (uri?: vscode.Uri) => openSharedFile('.gitattributes', uri)),
		vscode.commands.registerCommand('git-hush.ignoreLocally', (uri?: vscode.Uri, uris?: vscode.Uri[]) => toggleIgnore('local', uri, uris)),
		vscode.commands.registerCommand('git-hush.ignoreShared', (uri?: vscode.Uri, uris?: vscode.Uri[]) => toggleIgnore('shared', uri, uris)),
		vscode.commands.registerCommand('git-hush.moveRuleToLocal', (uri: vscode.Uri, line: number) => moveRule('toLocal', uri, line)),
		vscode.commands.registerCommand('git-hush.moveRuleToShared', (uri: vscode.Uri, line: number) => moveRule('toShared', uri, line)),
		vscode.languages.registerCodeLensProvider(FILE_SELECTOR, new GitHushCodeLensProvider()),
		vscode.languages.registerCodeActionsProvider(FILE_SELECTOR, new GitHushCodeActionProvider(), {
			providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
		}),
		// Covers our editor-path saves as well as the user editing .git/info/* by hand.
		vscode.workspace.onDidSaveTextDocument(doc => refreshGitStatus(doc.uri.fsPath)),
		vscode.workspace.onDidChangeTextDocument(onRuleFileChanged)
	);
}

export function deactivate() { }
