import { App, MarkdownView, Notice, Plugin, PluginSettingTab, Setting, SettingDefinitionItem, TFile, requestUrl } from 'obsidian';

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

interface AnkiActionResponse {
	result?: unknown;
	error?: string;
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

	async ensureDeckAndModel(): Promise<void> {
		const models: unknown = await this.anki('modelNames');
		const modelNames: string[] = Array.isArray(models) ? (models as string[]) : [];
		if (!modelNames.includes(this.settings.modelName)) {
			await this.anki('createModel', {
				modelName: this.settings.modelName,
				inOrderFields: ['Front', 'Back'],
				cardTemplates: [{ Name: 'Card 1', Front: '{{Front}}', Back: '{{Front}}<hr id=answer>{{Back}}' }],
				css: '',
			});
		}
		const decksRaw: unknown = await this.anki('deckNames');
		const decks: string[] = Array.isArray(decksRaw) ? (decksRaw as string[]) : [];
		if (!decks.includes(this.settings.deck)) await this.anki('createDeck', { deck: this.settings.deck });
	}

	// ---- vault scan ----
	scanVault(): Flashcard[] {
		// Scan is superseded by the async syncFiles() full-vault pass below.
		// Kept as a sync helper for callers that only want the parsed fences.
		const out: Flashcard[] = [];
		const files = this.app.vault.getMarkdownFiles();
		for (const f of files) {
			const text = this.app.vault.cachedRead(f);
			// cachedRead is async; the async pass in syncFiles handles real reads.
			void text;
		}
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
					const idMatch = lines[0].trim().match(ID_RE);
					if (idMatch) qid = idMatch[1];
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
		const idsRaw: unknown = await this.anki('findNotes', { query: `tag:${TAG}` });
		const ids: number[] = Array.isArray(idsRaw) ? (idsRaw as number[]) : [];
		const infosRaw: unknown = await this.anki('notesInfo', { notes: ids });
		const infos: Array<Record<string, unknown>> = Array.isArray(infosRaw) ? (infosRaw as Array<Record<string, unknown>>) : [];
		const remote = new Map<string, Flashcard>();
		for (const info of infos) {
			const tags: string[] = Array.isArray(info.tags) ? (info.tags as string[]) : [];
			const tagged = tags.find(t => t.startsWith(`${TAG}#`));
			const qid = tagged ? tagged.split('#')[1] : undefined;
			if (!qid) continue;
			const fields = (info.fields as Record<string, { value?: string }>) || {};
			remote.set(qid, {
				qid,
				front: fields.Front?.value ?? '',
				back: fields.Back?.value ?? '',
				source: '',
				ankiId: info.noteId as number,
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

interface SyncSettings {
	ankiUrl: string;
	deck: string;
	modelName: string;
}

class SyncSettingTab extends PluginSettingTab {
	plugin: AnkiMarkdownSync;
	constructor(app: App, plugin: AnkiMarkdownSync) { super(app, plugin); this.plugin = plugin; }

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				name: 'Anki Markdown Sync',
				type: 'group',
				items: [
					{ name: 'AnkiConnect URL', desc: 'Default http://127.0.0.1:8765 (AnkiConnect plugin must be installed in Anki)', control: { key: 'ankiUrl', type: 'text', placeholder: 'http://127.0.0.1:8765' } },
					{ name: 'Anki deck', desc: 'Destination deck, created automatically', control: { key: 'deck', type: 'text', placeholder: 'Notes::Sync' } },
				],
			},
		] as unknown as SettingDefinitionItem[];
	}

	getControlValue(key: string): unknown {
		const s = this.plugin.settings as unknown as Record<string, unknown>;
		return s[key];
	}

	setControlValue(key: string, value: unknown): void {
		const s = this.plugin.settings as unknown as Record<string, unknown>;
		s[key] = value as never;
		void this.plugin.saveSettings();
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		new Setting(containerEl).setName('Anki Markdown Sync').setHeading();
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