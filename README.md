# Anki Markdown Sync

Two-way sync between your Obsidian markdown vault and Anki via [AnkiConnect](https://ankiconnect.net/).

Write `` `anki `` fenced blocks in any note, sync to Anki, edit the card in Anki, sync back. Conflict-safe, id-stable.

## Why

The note-taking stack is broken: your notes live in Obsidian, your spaced repetition lives in Anki, and they never talk to each other. This plugin closes the loop.

- Write flashcards **in your notes** — no copy-paste, no juggling two apps
- Edit a card **in Anki** — the change flows back into your markdown
- Stable card IDs — your review history survives resyncs

## Install (development / BRAT)

1. Install the [AnkiConnect](https://ankiconnect.net/) addon in Anki (code `2055492159`) and restart Anki.
2. Install the **BRAT** Obsidian plugin, then add `Justinnnnnnn045/anki-markdown-sync` as a beta plugin.
3. Enable **Anki Markdown Sync** in Obsidian Community plugins.

## Usage

In any note, write:

`​``anki
What is the difference between a vector and a tensor?::A vector is a rank-1 tensor; a tensor is a multi-dimensional array with transformation rules.
`​``

Run the **"Sync vault ↔ Anki"** command (Ctrl/Cmd+P → "Anki").

Cards are pushed into the `Notes::Sync` deck. Edits made in Anki are pulled back into the original note, preserving the card id.

## Requirements

- Obsidian desktop (AnkiConnect is desktop-only)
- Anki with AnkiConnect addon installed and enabled

## License

MIT