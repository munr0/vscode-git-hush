import * as assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

function git(cwd: string, ...args: string[]): void {
	cp.execFileSync('git', args, { cwd });
}

function readLines(filePath: string): string[] {
	return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(l => l.trim() !== '');
}

async function activateExtension(): Promise<void> {
	const ext = vscode.extensions.all.find(e => e.id.endsWith('.git-hush'));
	assert.ok(ext, 'git-hush extension not found');
	await ext.activate();
}

suite('Git Hush', () => {
	let root: string;

	suiteSetup(async () => {
		await activateExtension();
	});

	setup(async () => {
		root = fs.realpathSync(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'git-hush-')));
	});

	teardown(async () => {
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		// Windows: editors/watchers can briefly hold handles on files we just opened.
		await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
	});

	test('missing local exclude is created on open', async () => {
		git(root, 'init');
		fs.rmSync(path.join(root, '.git', 'info'), { recursive: true, force: true });

		await vscode.commands.executeCommand('git-hush.openExclude', vscode.Uri.file(root));

		const exclude = path.join(root, '.git', 'info', 'exclude');
		assert.ok(fs.existsSync(exclude), 'exclude file should be created');
	});

	test('worktree: local ignore lands in the shared exclude git actually reads', async () => {
		const main = path.join(root, 'main');
		git(root, 'init', 'main');
		git(main, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-m', 'init');
		const wt = path.join(root, 'wt');
		git(main, 'worktree', 'add', wt);
		assert.ok(fs.statSync(path.join(wt, '.git')).isFile(), 'worktree .git should be a pointer file');
		fs.writeFileSync(path.join(wt, 'a.txt'), '');

		await vscode.commands.executeCommand('git-hush.ignoreLocally', vscode.Uri.file(path.join(wt, 'a.txt')));

		// Throws if git does not consider the file ignored.
		git(wt, 'check-ignore', 'a.txt');
		assert.ok(readLines(path.join(main, '.git', 'info', 'exclude')).includes('a.txt'));
	});

	test('toggle, alphabetical insertion and dedup', async () => {
		git(root, 'init');
		const exclude = path.join(root, '.git', 'info', 'exclude');
		fs.writeFileSync(exclude, 'b.txt\n');
		fs.writeFileSync(path.join(root, 'a.txt'), '');
		fs.writeFileSync(path.join(root, 'b.txt'), '');

		// Add: inserted alphabetically before the existing rule.
		await vscode.commands.executeCommand('git-hush.ignoreLocally', vscode.Uri.file(path.join(root, 'a.txt')));
		assert.deepStrictEqual(readLines(exclude), ['a.txt', 'b.txt']);

		// Toggle: an already-present path is removed instead of duplicated.
		await vscode.commands.executeCommand('git-hush.ignoreLocally', vscode.Uri.file(path.join(root, 'b.txt')));
		assert.deepStrictEqual(readLines(exclude), ['a.txt']);

		// Dedup via code-action move: rule exists in both files, no duplicate appears.
		const gitignore = path.join(root, '.gitignore');
		fs.writeFileSync(gitignore, 'a.txt\n');
		await vscode.commands.executeCommand('git-hush.moveRuleToLocal', vscode.Uri.file(gitignore), 0);
		assert.deepStrictEqual(readLines(exclude), ['a.txt'], 'no duplicate after move');
		assert.deepStrictEqual(readLines(gitignore), [], 'rule removed from source');
	});
});
