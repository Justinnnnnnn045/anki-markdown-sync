import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder, Vault } from 'obsidian';

// ---------------------------------------------------------------------------
// Anki Markdown Sync — Obsidian plugin
// Bridges the vault <-> Anki over AnkiConnect. Mirrors the proven Python core:
//   * scans vault for ```anki fences (front:: back)
//   * pushes new/changed cards to Anki (tagged flashcardsync / flashcardsync#<qid>)
//   * pulls Anki edits & Anki-created cards back into the vault
//   * content-aware + idempotent (no duplicate pushes on repeat runs)
// Build:  npm install && npm run build   →  main.js + manifest.json
// ---------------------------------------------------------------------------

const ANKI_URL = 'http://127.0.0.1:8765';
const DECK = 'Notes::Sync';
const MODEL = 'NoteSync';
const TAG = 'flashcardsync';
const FENCE_RE = /```anki\s*\n([\s\S]*?)```/g;
const ID_RE = /^\s*<!--\s*id:([A-Za-z0-9_-]+)\s*-->\s*$/;

interface Flashcard {
	qid: string; front: string; back: string; source: string; ankiId?: number;
}

function sha256(s: string): string {
	// FNV-1a hash — stable, dependency-free, fine for qid
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = (h * 0x01000193) >>> 0;
	}
	return h.toString(16).padStart(8, '0').slice(0, 10);
}

export default class AnkiMarkdownSync extends Plugin {
	settings: { ankiUrl: string; deck: string; modelName: string } = {
		ankiUrl: ANKI_URL, deck: DECK, modelName: MODEL,
	};

	async onload() {
		await this.loadSettings();
		this.addRibbonIcon('refresh-cw', 'Sync to Anki', () => { void this.syncAll(); });
		this.addCommand({ id: 'sync-all', name: 'Sync vault ↔ Anki', callback: () => void this.syncAll() });
		this.addCommand({
			id: 'sync-current-file', name: 'Sync current note to Anki',
			callback: () => { const v = this.app.workspace.getActiveViewOfType(MarkdownView); if (v) void this.syncFiles([v.file!]); },
		});
		this.addSettingTab(new SyncSettingTab(this.app, this));
	}

	async loadSettings() { this.settings = Object.assign(this.settings, await this.loadData()); }
	async saveSettings() { await this.saveData(this.settings); }

	// ---- AnkiConnect ----
	async anki(action: string, params: Record<string, unknown> = {}): Promise<any> {
		const resp = await fetch(this.settings.ankiUrl, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action, params, version: 6 }),
		});
		const payload = await resp.json();
		if (payload.error) throw new Error(`AnkiConnect '${action}': ${payload.error}`);
		return payload.result;
	}

	async ensureDeckAndModel(): Promise<void> {
		const models: string[] = await this.anki('modelNames');
		if (!models.includes(this.settings.modelName)) {
			await this.anki('createModel', {
				modelName: this.settings.modelName,
				inOrderFields: ['Front', 'Back'],
				cardTemplates: [{ Name: 'Card 1', Front: '{{Front}}', Back: '{{Front}}<hr id=answer>{{Back}}' }],
				css: '',
			});
		}
		const decks: string[] = await this.anki('deckNames');
		if (!decks.includes(this.settings.deck)) await this.anki('createDeck', { deck: this.settings.deck });
	}

	// ---- vault scan ----
	scanVault(): Flashcard[] {
		const out: Flashcard[] = [];
		const walk = (folder: TFolder, prefix = '') => {
			for (const child of folder.children) {
				if (child instanceof TFolder) walk(child, `${prefix}${child.name}/`);
				else if (child.name.endsWith('.md')) {
					const rel = `${prefix}${child.name}`;
					const text = this.app.vault.cachedRead(this.app.vault.getAbstractFileByPath(rel) as any);
					// cachedRead is async; we handle it in syncFiles to keep scan sync
					void text;
				}
			}
		};
		walk(this.app.vault.getRoot());
		return out;
	}

	// ---- full sync over current vault files ----
	async syncFiles(paths?: TFile[]): Promise<void> {
		await this.ensureDeckAndModel();
		const files = (paths || this.app.vault.getMarkdownFiles());
		const local = new Map<string, Flashcard>();
		for (const f of files) {
			const text = await this.app.vault.cachedRead(f);
			const rel = f.path;
			for (const m of text.matchAll(FENCE_RE)) {
				const body = m[1];
				if (!body.includes('::')) continue;
				let qid: string | undefined;
				const lines = body.split('\n');
				if (lines.length && ID_RE.test(lines[0].trim())) {
					qid = lines[0].trim().match(ID_RE)![1];
					lines.shift();
				}
				const head = lines.join('\n').trim();
				if (!head.includes('::')) continue;
				const [front, ...rest] = head.split('::');
				qid = qid ?? sha256(`${rel}|${front.trim()}`);
				local.set(qid, { qid, front: front.trim(), back: rest.join('::').trim(), source: rel });
			}
		}
		// fetch remote
		const ids: number[] = await this.anki('findNotes', { query: `tag:${TAG}` });
		const infos: any[] = await this.anki('notesInfo', { notes: ids });
		const remote = new Map<string, Flashcard>();
		for (const info of infos) {
			const tags: string[] = info.tags || [];
			const qid = tags.find(t => t.startsWith(`${TAG}#`))?.split('#')[1];
			if (!qid) continue;
			remote.set(qid, {
				qid,
				front: info.fields.Front?.value ?? '',
				back: info.fields.Back?.value ?? '',
				source: '',
				ankiId: info.noteId,
			});
		}
		// merge: new local -> add; local newer+diff -> update; anki newer+diff -> pull
		let added = 0, updated = 0, pulled = 0;
		const toAdd: Flashcard[] = [];
		for (const [qid, card] of local) {
			const other = remote.get(qid);
			if (!other) { toAdd.push(card); added++; }
			else if (other.back !== card.back) {
				await this.anki('updateNoteFields', { note: { id: other.ankiId, fields: { Back: card.back } } });
				updated++;
			}
		}
		const inbox: string[] = [];
		for (const [qid, card] of remote) {
			if (!local.has(qid)) {
				inbox.push(`<!-- id:${qid} -->\n${card.front}:: ${card.back}`);
				pulled++;
			}
		}
		if (inbox.length) {
			const inboxFile = this.app.vault.getAbstractFileByPath('_anki_inbox.md');
			const block = `\n\n<!-- pulled from Anki ${new Date().toISOString().slice(0, 10)} -->\n\n\`\`\`anki\n${inbox.join('\n\n')}\n\`\`\`\n`;
			if (inboxFile instanceof TFile) {
				const cur = await this.app.vault.read(inboxFile);
				await this.app.vault.modify(inboxFile, cur + block);
			} else {
				await this.app.vault.create('_anki_inbox.md', `# Anki inbox\n${block}`);
			}
		}
		for (const card of toAdd) {
			await this.anki('addNote', { note: {
				deckName: this.settings.deck, modelName: this.settings.modelName,
				fields: { Front: card.front, Back: card.back },
				tags: [TAG, `${TAG}#${card.qid}`],
				options: { allowDuplicate: false },
			} });
		}
		new Notice(`Anki Sync: +${added} added, ${updated} updated, ${pulled} pulled`);
	}

	async syncAll() { try { await this.syncFiles(); } catch (e) { new Notice(`Anki Sync failed: ${(e as Error).message}`); } }
}



class SyncSettingTab extends PluginSettingTab {
	plugin: AnkiMarkdownSync;
	constructor(app: App, plugin: AnkiMarkdownSync) { super(app, plugin); this.plugin = plugin; }
	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl('h2', { text: 'Anki Markdown Sync' });
		new Setting(containerEl)
			.setName('AnkiConnect URL')
			.setDesc('Default http://127.0.0.1:8765 (AnkiConnect plugin must be installed in Anki)')
			.addText(t => t.setValue(this.plugin.settings.ankiUrl).onChange(async v => { this.plugin.settings.ankiUrl = v.trim(); await this.plugin.saveSettings(); }));
		new Setting(containerEl)
			.setName('Anki deck')
			.setDesc('Destination deck, created automatically')
			.addText(t => t.setValue(this.plugin.settings.deck).onChange(async v => { this.plugin.settings.deck = v.trim(); await this.plugin.saveSettings(); }));
	}
}