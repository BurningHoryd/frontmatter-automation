# Frontmatter Autogen

An Obsidian plugin that analyzes note content and automatically generates and updates title, summary, and tags in the frontmatter.
Inline tags (#tag) are extracted from the body, removed, and merged into the frontmatter tags.
Supports multi-language tagging rules.


## ✨ Features

- Generates title and summary

- Creates tags per language (with quotas and rules)

- Merges existing frontmatter tags + inline tags + AI tags (duplicates removed)

- Adds fm_created (today’s date) to indicate when frontmatter was updated

- Works with any OpenAI-compatible API endpoint


## 📦 Installation

### Manual installation (development)

Clone this repo into your Obsidian vault’s plugin folder
Example: <vault>/.obsidian/plugins/frontmatter-generator

Build/compile if needed, then reload plugins in Obsidian.

Enable the plugin in Community plugins.

### BRAT installation

You can also install it via the Obsidian BRAT plugin.


## ⚙️ Settings

API Base – OpenAI-compatible endpoint. Default: https://api.openai.com/v1

API Key – Bearer token format (sk-...)

Model – Examples: gpt-4o-mini, gpt-4o, gpt-4.1-mini, gpt-3.5-turbo (custom models allowed)

Tags Language Settings – Configure max number of tags per language (e.g., en: 10, ko: 5). Add/remove languages.


## 🚀 Usage

Ribbon Button → Click the wand icon in the left ribbon to update the frontmatter for the active note.

Command Palette → Run Frontmatter: Update current note.


## 🔍 Workflow

- Split note into frontmatter and body

- Extract inline tags (#tag) from the body

- Clean up the body (remove images, code blocks, length limit)

- Send prompt to LLM (JSON format)

- Receive title, summary, and tags_by_lang

- Merge existing FM tags + inline tags + AI tags (deduped)

- Normalize created / add fm_created

- Write updated frontmatter + cleaned body back to the file


## 🧪 Example

Input (body excerpt):
```md
# My Note
This note is about important historical changes in society.
#history #world
```

AI Suggested Tags:
```json
{
  "en": ["CivilRights", "Revolution"],
  "ko": ["세계역사"]
}
```

Final Output (frontmatter):
```yaml
---
title: My Note
summary: A short summary generated from the note body.
tags:
  - History        # from inline
  - World          # from inline
  - CivilRights    # from AI (English tags are normalized to PascalCase)
  - Revolution     # from AI
  - 세계역사         # from AI
created: 2025-08-18
fm_created: 2025-08-18
---
```

## 👉 Note

Final tags always include inline tags, existing frontmatter tags, and AI-generated tags, with duplicates removed.

English AI tags are normalized to PascalCase (e.g., civil rights → CivilRights) for consistency.

Tags in other languages follow their own formatting rules (e.g., Korean tags are concatenated without spaces).


## 🛠 Troubleshooting

“API key not set” → Enter your API key in settings.

AI call failed (HTTP error) → Check API base, model, and API key.

JSON parse failed → Your endpoint may not support response_format: { type: "json_object" }. Remove or adjust.


## 🔒 Privacy & Network Usage

This plugin requires an API key from [OpenAI](https://platform.openai.com/) or another compatible provider.
Your notes' content (with images and code truncated) is sent to the configured API endpoint for generating
titles, summaries, and tags.

- **API Key**: You must provide your own API key in the plugin settings.
- **Network use**: Note content is transmitted over the internet to the configured endpoint.
- **Costs**: Depending on your provider’s pricing, using this plugin may incur costs.
- **Local safety**: Aside from the AI requests, all processing happens locally inside Obsidian.


## 📄 License

This project is licensed under the ISC License – see the [LICENSE](./LICENSE) file for details.

Copyright (C) 2025 by BurningHoryd

Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.


## 🤝 Contributing

Issues and PRs welcome.

Commit messages follow Conventional Commits
:
```txt
feat: add batch update command

fix: handle JSON parse error

refactor: normalize tag formatting
```
