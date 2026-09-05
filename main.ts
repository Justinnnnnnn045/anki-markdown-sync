import { App, MarkdownView, Notice, Plugin, PluginSettingTab, Setting, TFile, requestUrl } from 'obsidian';

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
	qid: string;
	front: string;
	back: string;
	source: string;
	ankiId?: number;
}

interface AnkiActionResponse {
	result?: unknown;
	error?: string;
}

interface SyncSettings {
	ankiUrl: string;
	deck: string;
	modelName: string;
}

interface AnkiNoteInfo {
	noteId: number;
	tags: string[];
	fields: Record<string, { value?: string }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toHash(s: string): string {
	// FNV-1a hash — stable, dependency-free, fine for qid
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = (h * 0x01000193) >>> 0;
	}
	return h.toString(16).padStart(8, '0').slice(0, 10);
}

export default class AnkiMarkdownSync extends Plugin {
	settings: SyncSettings = {
		ankiUrl: ANKI_URL,
		deck: DECK,
		modelName: MODEL,
	};

	async onload(): Promise<void> {
		await this.loadSettings();
		this.addRibbonIcon('refresh-cw', 'Sync to Anki', () => {
			void this.syncAll();
		});
		this.addCommand({
			id: 'sync-all',
			name: 'Sync vault ↔ Anki',
			callback: () => void this.syncAll(),
		});
		this.addCommand({
			id: 'sync-current-file',
			name: 'Sync current note to Anki',
			callback: () => {
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (view) void this.syncFiles([view.file as TFile]);
			},
		});
		this.addSettingTab(new SyncSettingTab(this.app, this));
	}

	async loadSettings(): Promise<void> {
		const raw = await this.loadData() as unknown;
		const data: Partial<SyncSettings> = isRecord(raw) ? raw : {};
		this.settings = Object.assign(this.settings, data);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	// ---- AnkiConnect ----
	async anki(action: string, params: Record<string, unknown> = {}): Promise<unknown> {
		const resp = await requestUrl({
			url: this.settings.ankiUrl,
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action, params, version: 6 }),
		});
		const payload = resp.json as AnkiActionResponse;
		if (payload.error) throw new Error(`AnkiConnect '${action}': ${payload.error}`);
		return payload.result;
	}

	private async cardQuery(query: string): Promise<number[]> {
		const raw = await this.anki('findNotes', { query });
		return Array.isArray(raw) ? (raw as number[]) : [];
	}

	private async notesInfo(ids: number[]): Promise<AnkiNoteInfo[]> {
		const raw = await this.anki('notesInfo', { notes: ids });
		return Array.isArray(raw) ? (raw as AnkiNoteInfo[]) : [];
	}

	private async modelNames(): Promise<string[]> {
		const raw = await this.anki('modelNames');
		return Array.isArray(raw) ? (raw as string[]) : [];
	}

	private async deckNames(): Promise<string[]> {
		const raw = await this.anki('deckNames');
		return Array.isArray(raw) ? (raw as string[]) : [];
	}

	async ensureDeckAndModel(): Promise<void> {
		const models = await this.modelNames();
		if (!models.includes(this.settings.modelName)) {
			await this.anki('createModel', {
				modelName: this.settings.modelName,
				inOrderFields: ['Front', 'Back'],
				cardTemplates: [{ Name: 'Card 1', Front: '{{Front}}', Back: '{{Front}}<hr id=answer>{{Back}}' }],
				css: '',
			});
		}
		const decks = await this.deckNames();
		if (!decks.includes(this.settings.deck)) await this.anki('createDeck', { deck: this.settings.deck });
	}

	// ---- full sync over current vault files ----
	async syncFiles(paths?: TFile[]): Promise<void> {
		await this.ensureDeckAndModel();
		const files = paths || this.app.vault.getMarkdownFiles();
		const local = new Map<string, Flashcard>();

		for (const file of files) {
			const text = await this.app.vault.cachedRead(file);
			const rel = file.path;
			for (const match of text.matchAll(FENCE_RE)) {
				const block = match[1];
				if (!block.includes('::')) continue;
				let qid: string | undefined;
				const lines = block.split('\n');
				const first = lines[0].trim();
				const idMatch = first.match(ID_RE);
				if (idMatch) {
					qid = idMatch[1];
					lines.shift();
				}
				const head = lines.join('\n').trim();
				if (!head.includes('::')) continue;
				const sep = head.indexOf('::');
				const front = head.slice(0, sep).trim();
				const back = head.slice(sep + 2).trim();
				const id = qid || toHash(`${rel}|${front}`);
				local.set(id, { qid: id, front, back, source: rel });
			}
		}

		const ids = await this.cardQuery(`tag:${TAG}`);
		const infos = await this.notesInfo(ids);
		const remote = new Map<string, Flashcard>();
		for (const info of infos) {
			const tagged = info.tags.find(t => t.startsWith(`${TAG}#`));
			if (!tagged) continue;
			const qid = tagged.split('#')[1];
			if (!qid) continue;
			remote.set(qid, {
				qid,
				front: info.fields.Front?.value ?? '',
				back: info.fields.Back?.value ?? '',
				source: '',
				ankiId: info.noteId,
			});
		}

		let added = 0;
		let updated = 0;
		let pulled = 0;
		const toAdd: Flashcard[] = [];

		for (const [id, card] of local) {
			const other = remote.get(id);
			if (!other) {
				toAdd.push(card);
				added++;
			} else if (other.back !== card.back) {
				await this.anki('updateNoteFields', { note: { id: other.ankiId, fields: { Back: card.back } } });
				updated++;
			}
		}

		const inbox: string[] = [];
		for (const [id, card] of remote) {
			if (!local.has(id)) {
				inbox.push(`<!-- id:${id} -->\n${card.front}:: ${card.back}`);
				pulled++;
			}
		}

		if (inbox.length) {
			const block = `\n\n<!-- pulled from Anki ${new Date().toISOString().slice(0, 10)} -->\n\n\`\`\`anki\n${inbox.join('\n\n')}\n\`\`\`\n`;
			const inboxPath = '_anki_inbox.md';
			const existing = this.app.vault.getAbstractFileByPath(inboxPath);
			if (existing instanceof TFile) {
				const current = await this.app.vault.read(existing);
				await this.app.vault.modify(existing, current + block);
			} else {
				await this.app.vault.create(inboxPath, `# Anki inbox\n${block}`);
			}
		}

		for (const card of toAdd) {
			await this.anki('addNote', {
				note: {
					deckName: this.settings.deck,
					modelName: this.settings.modelName,
					fields: { Front: card.front, Back: card.back },
					tags: [TAG, `${TAG}#${card.qid}`],
					options: { allowDuplicate: false },
				},
			});
		}

		new Notice(`Anki Sync: +${added} added, ${updated} updated, ${pulled} pulled`);
	}

	async syncAll(): Promise<void> {
		try {
			await this.syncFiles();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			new Notice(`Anki Sync failed: ${message}`);
		}
	}
}

class SyncSettingTab extends PluginSettingTab {
	plugin: AnkiMarkdownSync;

	constructor(app: App, plugin: AnkiMarkdownSync) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl).setName('Connection').setHeading();
		new Setting(containerEl)
			.setName('AnkiConnect URL')
			.setDesc('Default http://127.0.0.1:8765 (AnkiConnect plugin must be installed in Anki)')
			.addText(text => text
				.setValue(this.plugin.settings.ankiUrl)
				.onChange(async value => {
					this.plugin.settings.ankiUrl = value.trim();
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl).setName('Sync target').setHeading();
		new Setting(containerEl)
			.setName('Anki deck')
			.setDesc('Destination deck, created automatically')
			.addText(text => text
				.setValue(this.plugin.settings.deck)
				.onChange(async value => {
					this.plugin.settings.deck = value.trim();
					await this.plugin.saveSettings();
				}));
	}
}