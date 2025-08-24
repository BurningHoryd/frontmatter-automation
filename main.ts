// main.ts
import {
  App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile
} from 'obsidian';
import * as YAML from 'js-yaml';

/* =========================
   Types (no 'any' casts)
   ========================= */
type TagLang = { code: string; max: number };

// Frontmatter object we manipulate
type FrontmatterData = Record<string, unknown> & {
  tags?: string[] | string;
  title?: string;
  summary?: string;
  created?: string | number | Date;
  fm_created?: string;
};

// helper: narrow arbitrary value to object
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/* =========================
   Language labels/choices
   ========================= */
const TAG_LANG_LABELS: Record<string, string> = {
  en: 'English',
  ko: '한국어',
  ja: '日本語',
  zh: '中文',
  es: 'Español',
  de: 'Deutsch',
  fr: 'Français',
};

const TAG_LANG_CHOICES: Array<{ code: string; label: string }> =
  Object.entries(TAG_LANG_LABELS).map(([code, label]) => ({ code, label }));

/* =========================
   Settings
   ========================= */
interface FMSettings {
  apiKey: string;
  apiBase: string;      // ex) https://api.openai.com/v1
  model: string;        // ex) gpt-4o-mini, gpt-4o
  tagLangs: TagLang[];
}

const DEFAULT_SETTINGS: FMSettings = {
  apiKey: '',
  apiBase: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  tagLangs: [{ code: 'en', max: 10 }],
};

/* =========================
   Plugin
   ========================= */
export default class FrontmatterAutomation extends Plugin {
  settings: FMSettings;

  async onload() {
    await this.loadSettings();

    // Ribbon button
    this.addRibbonIcon('wand-2', 'Frontmatter: update current note', async () => {
      await this.processCurrentNote();
    });

    // Command - Update Current Note
    this.addCommand({
      id: 'fm-update-current-note',
      name: 'Frontmatter: update current note',
      callback: async () => this.processCurrentNote(),
    });

    // Settings Tab
    this.addSettingTab(new FMSettingTab(this.app, this));
  }

  onunload() {}

  // === Core logic ===
  private async processCurrentNote() {
    const file = this.app.workspace.getActiveFile();
    if (!file) return new Notice('No active note.');
    await this.updateFrontmatterForFile(file);
  }

  private async updateFrontmatterForFile(file: TFile) {
    // 1) Read raw file and split into frontmatter/body (FM is only used as reference for prompt)
    const raw = await this.app.vault.read(file);
    const { frontmatter, body } = this.splitFrontmatter(raw);

    // 2) Extract inline tags from the body and remove them
    const { inlineTags, strippedBody } = extractInlineTagsAndStrip(body);

    // 3) Build JSON prompt (existing FM used as reference only)
    const jsonPrompt = this.buildJsonPrompt({
      path: file.path,
      body: strippedBody,
      existingFM: frontmatter,
    });

    // 4) Call LLM → expected { title, summary, tags_by_lang }
    const obj = await this.callAIForJSON(jsonPrompt);
    if (!obj || typeof obj !== 'object') {
      new Notice(`Did not receive JSON from AI: ${file.path}`);
      return;
    }

    // Flatten tags_by_lang into one array
    const tagsByLang: Record<string, string[]> =
      (obj as Record<string, unknown>).tags_by_lang as Record<string, string[]> ?? {};
    const aiFlatTags = Object.values(tagsByLang).flat().filter(Boolean);

    // 5) Tag merge order: inline → existing FM → AI (dedupe, preserve case)
    const chosen = new Map<string, string>();

    const addKeepCase = (arr: unknown[]) => {
      for (const t of arr) {
        const rawTag = formatExistingTag(String(t ?? ''));
        const k = tagKey(rawTag);
        if (k && !chosen.has(k)) chosen.set(k, rawTag);
      }
    };
    const addAi = (arr: unknown[]) => {
      for (const t of arr) {
        const rawTag = formatAiTag(String(t ?? ''));
        const k = tagKey(rawTag);
        if (k && !chosen.has(k)) chosen.set(k, rawTag);
      }
    };

    addKeepCase(inlineTags);                       // Inline tags first
    addKeepCase(asArray(frontmatter?.tags));       // Then existing FM
    addAi(aiFlatTags);                             // Finally AI tags
    const finalTags = Array.from(chosen.values());

    // 6) FRONTMATTER FIRST: update FM atomically (leave `created` untouched if present)
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      // title/summary: overwrite if provided by AI
      const t = (obj as Record<string, unknown>).title;
      const s = (obj as Record<string, unknown>).summary;
      if (typeof t === 'string') fm.title = t;
      if (typeof s === 'string') fm.summary = s;

      const existing = Array.isArray(fm.tags) ? fm.tags : (typeof fm.tags !== 'undefined' ? [fm.tags] : []);
      const mergedOnce = Array.from(new Set([
        ...existing.map((v: unknown) => String(v ?? '')),
        ...finalTags.map((v: string) => String(v ?? '')),
      ]))
        .filter(Boolean)
        .map(x => x.replace(/^#/, ''))
        .map(x => x.replace(/\s+/g, '-'));

      fm.tags = Array.from(new Set(mergedOnce));

      // Remove unnecessary/forbidden fields
      const g = fm as { [k: string]: unknown };
      delete g['updated'];
      delete g['last_modified'];
      delete g['path'];

      // ✅ created: only fill when missing; DO NOT touch existing values (prevents off-by-one)
      if (fm.created == null || fm.created === '') {
        const stat = file.stat;
        const baseTs = stat?.ctime ?? stat?.mtime ?? Date.now();
        fm.created = formatYYYYMMDDLocal(baseTs);  // 'YYYY-MM-DD'
      }

      // fm_created: always record today's date (local)
      fm.fm_created = formatYYYYMMDDLocal(Date.now());
    });

    // 7) BODY SECOND: replace ONLY the body while preserving the FM text exactly
    {
      const latestRaw = await this.app.vault.read(file);
      let newContent = strippedBody;

      if (latestRaw.startsWith('---')) {
        const end = latestRaw.indexOf('\n---', 3);
        if (end !== -1) {
          const fmBlock = latestRaw.slice(0, end + 4); // includes the closing '---'
          // keep FM block AS-IS, only replace the body with strippedBody
          newContent = `${fmBlock}\n\n${strippedBody}`;
        }
      }

      const active = this.app.workspace.activeEditor?.editor;
      const activeFile = this.app.workspace.getActiveFile();

      if (active && activeFile && activeFile.path === file.path) {
        const cur = active.getValue();
        if (cur !== newContent) active.setValue(newContent);     // preserve cursor/folds
      } else {
        await this.app.vault.process(file, () => newContent);     // atomic background update
      }
    }

    new Notice(`Frontmatter updated: ${file.path}`);
  }



  // === Prompt generation (YAML path, unused in JSON mode but kept) ===
  private buildPrompt(args: { path: string; body: string; existingFM: FrontmatterData | null }) {
    const { path, body, existingFM } = args;
    const cleanBody = sanitizeBodyForLLM(body, 40000, true);
    const existingYaml = existingFM ? YAML.dump(existingFM).trim() : '(none)';

    // Rules string for language/number (e.g., "English:3, 한국어:3")
    const langRule = (this.settings.tagLangs?.length ? this.settings.tagLangs : [{ code: 'en', max: 5 }])
      .map(x => `${TAG_LANG_LABELS[x.code] ?? x.code}:${x.max}`)
      .join(', ');

    return `
    You are an assistant that outputs **pure YAML only** (no backticks, no fences).
    Read the note body and produce exactly these fields:
    - title: string
    - tags: string[]
    - summary: short string

    Rules:
    - Do NOT create fields about dates/paths (e.g., path, created, updated, last_modified, fm_created).
    - Tags quota by language: ${langRule}.
      - Generate **exactly** that many tags per language (no fewer/no more).
      - Tags are keyphrases of 1-2 words, ideally 1.
      - Lowercase; spaces → hyphens; no "#".
      - Examples: "us-history", "government", "history", "government".

    Reference (do NOT include as fields):
    - File path: "${path}"

    Existing frontmatter (if any):
    ${existingYaml}

    Body (images/code removed/truncated as needed):
    ${cleanBody}
    `.trim();
  }

  // === JSON prompt generation (recommended path) ===
  private buildJsonPrompt(args: { path: string; body: string; existingFM: FrontmatterData | null }) {
    const { path, body, existingFM } = args;
    const cleanBody = sanitizeBodyForLLM(body, 40000, true);
    const existingYaml = existingFM ? YAML.dump(existingFM).trim() : '(none)';

    // { "en":5, "ko":5, ... } map + description
    const quotas = new Map(this.settings.tagLangs.map(x => [x.code, x.max]));
    const langSpecLines: string[] = [];
    for (const [code, max] of quotas) {
      if (code === 'en') {
        langSpecLines.push(`- "en": exactly ${max} tags; write multi-word concepts with spaces (or hyphens). Do NOT return concatenated forms like "legalprinciple". (Examples: "legal principle", "civil rights", "unlawful imprisonment", "US Constitution")`);
      } else if (code === 'ko') {
        langSpecLines.push(`- "ko": exactly ${max} tags; MUST contain Hangul (Korean). Do NOT use hyphens; write tags as a single concatenated word (no spaces).`);
      } else if (code === 'ja') {
        langSpecLines.push(`- "${code}": exactly ${max} tags; MUST be Japanese (Hiragana/Katakana/Kanji).`);
      } else if (code === 'zh') {
        langSpecLines.push(`- "${code}": exactly ${max} tags; MUST contain CJK ideographs (Chinese Han).`);
      } else {
        langSpecLines.push(`- "${code}": exactly ${max} tags; MUST be ${TAG_LANG_LABELS[code] ?? code} words.`);
      }
    }

    // Explicitly list tags_by_lang keys (fixed format)
    const tagsObjShape = [...quotas.entries()]
      .map(([code, max]) => `  "${code}": string[${max}]`)
      .join(",\n");

    return [
      'Return **JSON only** (no code fences, no extra text).',
      'The JSON must have exactly these fields:',
      '{',
      '  "title": string,',
      '  "summary": string,',
      '  "tags_by_lang": {',
      tagsObjShape,
      '  }',
      '}',
      '',
      'Global tag rules:',
      '- Tags are keyphrases of 1-2 words (prefer 1).',
      '- Avoid "#" characters. Use separators only if appropriate for the language.',
      '',
      'Per-language constraints:',
      ...langSpecLines,
      '',
      'Do NOT add any fields about dates/paths (e.g., path, created, updated, last_modified, fm_created).',
      '',
      `Reference (do NOT include as fields): file path = "${path}"`,
      '',
      'Existing frontmatter (if any):',
      existingYaml,
      '',
      'Body (images/code removed/truncated as needed):',
      cleanBody,
    ].join('\n');
  }

  // === OpenAI-compatible endpoint call (JSON only) ===
  private async callAIForJSON(prompt: string): Promise<Record<string, unknown> | null> {
    if (!this.settings.apiKey) {
      new Notice('API key not set. Please enter it in plugin settings.');
      return null;
    }

    const url = `${this.settings.apiBase.replace(/\/+$/, '')}/chat/completions`;
    const payload = {
      model: this.settings.model,
      messages: [
        { role: 'system', content: 'You output JSON only. No code fences. No extra commentary.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.2,
      // Force JSON response format (remove if unsupported)
      response_format: { type: "json_object" },
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.settings.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const t = await res.text();
      console.error('AI call failed (OpenAI/JSON):', res.status, t);
      new Notice(`AI call failed (OpenAI): ${res.status}`);
      return null;
    }

    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content?.trim?.();
    if (!text) return null;

    try {
      const parsed = JSON.parse(text);
      return isObject(parsed) ? parsed : null;
    } catch (e) {
      console.error('JSON parse failed:', e, 'original:', text);
      new Notice('Failed to parse AI JSON response');
      return null;
    }
  }

  // === frontmatter split/merge/compose ===
  private splitFrontmatter(raw: string): { frontmatter: FrontmatterData | null; body: string } {
    if (raw.startsWith('---')) {
      const end = raw.indexOf('\n---', 3);
      if (end !== -1) {
        const yaml = raw.slice(3, end + 1).trim();
        const body = raw.slice(end + 4).replace(/^\s*\n/, '');
        const fmUnknown = safeLoadYaml(yaml);
        const fm = isObject(fmUnknown) ? (fmUnknown as FrontmatterData) : null;
        return { frontmatter: fm, body };
      }
    }
    return { frontmatter: null, body: raw };
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }
}

/* =========================
   Utils
   ========================= */

// Prepare body for LLM:
function sanitizeBodyForLLM(
  body: string,
  maxChars = 40000,
  collapseCodeBlocks = true
) {
  let s = body;

  // - Remove image embeds: ![alt](url), ![[file.jpg]], <img ...>
  s = s.replace(/!\[[^\]]*]\(\s*data:image\/[^)]+\)/gi, '');  // ![](data:image...)
  s = s.replace(/<img[^>]+src\s*=\s*["']data:image\/[^"']+["'][^>]*>/gi, ''); // <img src="data:...">

  // - Remove data URI (very long)
  s = s.replace(/!\[[^\]]*]\(\s*[^)]+\)/g, '');         // ![alt](http.../file.png)
  s = s.replace(/!\[\[[^\]]+]]/g, '');                  // ![[file.png]]
  s = s.replace(/<img[^>]*>/gi, '');                    // <img ...>

  // - Optionally collapse code blocks
  if (collapseCodeBlocks) {
    s = s.replace(/```[\s\S]*?```/g, '[code omitted]');
  }

  // - Apply length limit
  if (s.length > maxChars) {
    s = s.slice(0, maxChars) + '\n\n[... truncated for LLM ...]';
  }

  return s;
}

/** Common tag string cleanup (apply language-specific rules, preserve case) */
function cleanupBare(s: string) {
  const base = String(s ?? '').trim().replace(/^#/, '');
  const isKorean  = /[\uAC00-\uD7AF]/.test(base);
  const isEnglish = /^[A-Za-z0-9 _/\-]+$/.test(base) && /[A-Za-z]/.test(base);

  if (isKorean || isEnglish) {
    // ko/en: concatenate words (remove all separators, keep case)
    return base.replace(/[ _/\-]+/g, '');
  }

  // Others: keep hyphen style
  return base
    .replace(/[ _/]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Key for duplicate detection (case-insensitive) */
function tagKey(s: string) {
  return cleanupBare(s).toLowerCase();
}

function toPascalCaseEnglish(base: string) {
  // Convert English-like tokens to PascalCase for AI-generated tags when desired.
  const splitTokens = base.split(/[ _/\-]+/).filter(Boolean);
  const tokens = splitTokens.length > 0 ? splitTokens : [base];

  return tokens
    .map(tok => {
      if (/^[A-Z0-9]+$/.test(tok)) return tok;
      if (/^\d/.test(tok)) return tok;
      if (/[A-Z].*[a-z]|[a-z].*[A-Z]/.test(tok)) {
        return tok.charAt(0).toUpperCase() + tok.slice(1);
      }
      return tok.charAt(0).toUpperCase() + tok.slice(1).toLowerCase();
    })
    .join('');
}

function formatAiTag(s: string) {
  // Korean tags are concatenated; English tags are PascalCased; others use hyphens.
  const base = String(s ?? '').trim().replace(/^#/, '');
  const isKorean  = /[\uAC00-\uD7AF]/.test(base);
  const isEnglish = /^[A-Za-z0-9 _/\-]+$/.test(base) && /[A-Za-z]/.test(base);

  if (isKorean) {
    return base.replace(/[ _/\-]+/g, '');
  }
  if (isEnglish) {
    return toPascalCaseEnglish(base);
  }

  return base
    .replace(/[ _/]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

function formatExistingTag(s: string) {
  // Conservative cleanup for user/existing tags
  return cleanupBare(s);
}

function formatYYYYMMDDLocal(ts: number | Date) {
  const d = ts instanceof Date ? ts : new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function safeLoadYaml(y: string): unknown {
  try { return YAML.load(y); } catch { return null; }
}

function stripCodeFences(s: string) {
  return s.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```$/, '');
}

function asArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (v == null) return [];
  return [v];
}

function uniqArray<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}


function cleanupAfterTagRemoval(s: string) {
  s = s.replace(/[\u200B-\u200D\uFEFF]/g, '');
  s = s.replace(/[ \t]+$/gm, '');
  s = s.replace(/\n{3,}/g, '\n\n');
  s = s.replace(/\s+$/g, '');
  return s;
}

function extractInlineTagsAndStrip(text: string) {
  // Find inline tags and strip them from body.
  const found: string[] = [];

  // Lookbehind-free regex; capture prefix in group1 and tag body in group2
  const TAG_REGEX =
    /(^|[\s(\[{:])#(?!#|\s)((?=[A-Za-z0-9_\-\/\uAC00-\uD7AF]*[A-Za-z\uAC00-\uD7AF])[A-Za-z0-9_\-\/\uAC00-\uD7AF]+)(?=$|[\s,.;:!?)}\]])/gu;

  let s = text.replace(TAG_REGEX, (_full, prefix: string, tag: string) => {
    const norm = formatExistingTag(tag);
    if (norm) found.push(norm);
    return prefix ?? '';
  });

  s = cleanupAfterTagRemoval(s);

  const unique = Array.from(new Set(found.map(t => t)));
  return { inlineTags: unique, strippedBody: s };
}

/* =========================
   Settings UI
   ========================= */
class FMSettingTab extends PluginSettingTab {
  plugin: FrontmatterAutomation;
  constructor(app: App, plugin: FrontmatterAutomation) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setName('API').setHeading();

    // API Base
    {
      const row = new Setting(containerEl)
        .setName('API base')
        .setDesc('OpenAI-compatible endpoint (default: https://api.openai.com/v1)');

      let apiText: import('obsidian').TextComponent;
      row.addText(t => {
        apiText = t;
        t.setValue(this.plugin.settings.apiBase);
        t.setDisabled(true);
      });

      row.addButton(b => {
        b.setButtonText('Reset to default')
          .setCta()
          .onClick(async () => {
            this.plugin.settings.apiBase = 'https://api.openai.com/v1';
            await this.plugin.saveSettings();
            apiText.setValue(this.plugin.settings.apiBase);
            new Notice('API Base set to default.');
          });
      });

      row.addButton(b => {
        b.setButtonText('Enter manually…')
          .onClick(async () => {
            const cur = this.plugin.settings.apiBase || 'https://api.openai.com/v1';
            const url = window.prompt('Enter API Base URL', cur);
            if (url && url.trim()) {
              this.plugin.settings.apiBase = url.trim();
              await this.plugin.saveSettings();
              apiText.setValue(this.plugin.settings.apiBase);
              new Notice('API Base updated.');
            }
          });
      });
    }

    // API Key
    new Setting(containerEl)
      .setName('API key')
      .setDesc('OpenAI-compatible key (Bearer)')
      .addText(t => t
        .setPlaceholder('sk-...')
        .setValue(this.plugin.settings.apiKey)
        .onChange(async v => { this.plugin.settings.apiKey = v; await this.plugin.saveSettings(); }));

    // Model
    new Setting(containerEl)
      .setName('Model')
      .setDesc('Choose OpenAI-compatible model')
      .addDropdown(drop => {
        const presets = ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-3.5-turbo'];
        for (const m of presets) drop.addOption(m, m);
        drop.addOption('custom', 'Enter custom…');

        const cur = (this.plugin.settings.model || '').trim();

        // Access internal selectEl without 'any'
        const selectEl = (drop as unknown as { selectEl: HTMLSelectElement }).selectEl;
        const optionValues = Array.from(selectEl.options).map((o) => o.value);

        if (cur && !optionValues.includes(cur)) {
          drop.addOption(cur, `(current) ${cur}`);
          drop.setValue(cur);
        } else if (cur) {
          drop.setValue(cur);
        } else {
          const fallback = 'gpt-4o-mini';
          drop.setValue(fallback);
          this.plugin.settings.model = fallback;
          this.plugin.saveSettings();
        }

        drop.onChange(async (v) => {
          if (v === 'custom') {
            const name = window.prompt('Enter model name', this.plugin.settings.model || 'gpt-4o-mini');
            if (name && name.trim()) {
              const val = name.trim();
              this.plugin.settings.model = val;
              const selectEl2 = (drop as unknown as { selectEl: HTMLSelectElement }).selectEl;
              const valuesNow = Array.from(selectEl2.options).map((o) => o.value);
              if (!valuesNow.includes(val)) drop.addOption(val, `(current) ${val}`);
              drop.setValue(val);
              await this.plugin.saveSettings();
            } else {
              drop.setValue(this.plugin.settings.model || 'gpt-4o-mini');
            }
          } else {
            this.plugin.settings.model = v;
            await this.plugin.saveSettings();
          }
        });
      });

    new Setting(containerEl).setName('Tags language').setHeading();


    for (const entry of this.plugin.settings.tagLangs) {
      const label = TAG_LANG_LABELS[entry.code] ?? entry.code;
      const row = new Setting(containerEl).setName(label).setDesc('Maximum number of tags for this language');

      row.addText(t => {
        t.setPlaceholder('5').setValue(String(entry.max));
        (t.inputEl as HTMLInputElement).type = 'number';
        (t.inputEl as HTMLInputElement).min = '0';
        t.onChange(async v => {
          const n = Math.max(0, Number.isFinite(+v) ? parseInt(v, 10) : entry.max);
          entry.max = n;
          await this.plugin.saveSettings();
        });
      });

      if (entry.code !== 'en') {
        row.addExtraButton(btn => {
          btn.setIcon('trash')
            .setTooltip('Remove this language')
            .onClick(async () => {
              this.plugin.settings.tagLangs = this.plugin.settings.tagLangs.filter(x => x !== entry);
              await this.plugin.saveSettings();
              this.display();
            });
        });
      }
    }

    new Setting(containerEl)
      .setName('Add language')
      .setDesc('Select a language to add and click "Add"')
      .addDropdown(d => {
        const selectedCodes = new Set(this.plugin.settings.tagLangs.map(x => x.code));
        for (const { code, label } of TAG_LANG_CHOICES) {
          if (!selectedCodes.has(code)) d.addOption(code, label);
        }
        const selectEl = (d as unknown as { selectEl: HTMLSelectElement }).selectEl;
        if (selectEl.options.length === 0) {
          d.addOption('none', 'No languages available to add');
          d.setDisabled(true);
        } else {
          d.setValue('ko');
        }
      })
      .addButton(b => {
        b.setButtonText('Add').setCta().onClick(async () => {
          const dd = (b.buttonEl.parentElement!.querySelector('select') as HTMLSelectElement);
          const code = dd?.value;
          if (!code || code === 'none') return;
          const exists = this.plugin.settings.tagLangs.some(x => x.code === code);
          if (!exists) {
            this.plugin.settings.tagLangs.push({ code, max: 5 });
            await this.plugin.saveSettings();
            this.display();
          }
        });
      });
  }
}
