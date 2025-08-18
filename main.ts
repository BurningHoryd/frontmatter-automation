// main.ts
import {
  App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile
} from 'obsidian';
import * as YAML from 'js-yaml';

// Language codes and labels
type TagLang = { code: string; max: number };

const TAG_LANG_LABELS: Record<string, string> = {
  en: 'English',
  ko: '한국어',
  ja: '日本語',
  zh: '中文',
  es: 'Español',
  de: 'Deutsch',
  fr: 'Français',
};

const TAG_LANG_CHOICES: Array<{ code: string; label: string }> = Object.entries(TAG_LANG_LABELS)
  .map(([code, label]) => ({ code, label }));


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

export default class FrontmatterAutomation extends Plugin {
  settings: FMSettings;

  async onload() {
    await this.loadSettings();

    // Ribbon button
    this.addRibbonIcon('wand-2', 'Frontmatter: Update current note', async () => {
      await this.processCurrentNote();
    });

    // Command - Update Current Note
    this.addCommand({
      id: 'fm-update-current-note',
      name: 'Frontmatter: Update current note',
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
    // Read original file and split frontmatter/body
    const raw = await this.app.vault.read(file);
    const { frontmatter, body } = this.splitFrontmatter(raw);

    // Extract inline tags from body & remove them
    const { inlineTags, strippedBody } = extractInlineTagsAndStrip(body);

    // AI prompt generation — JSON format
    const jsonPrompt = this.buildJsonPrompt({
      path: file.path,
      body: strippedBody,
      existingFM: frontmatter,
    });

    // AI call (JSON)
    const obj = await this.callAIForJSON(jsonPrompt);
    if (!obj || typeof obj !== 'object') {
      new Notice(`Did not receive JSON from AI: ${file.path}`);
      return;
    }

    // Expected schema: { title, summary, tags_by_lang: { <code>: string[] } }
    const tagsByLang: Record<string, string[]> = obj.tags_by_lang ?? {};
    const aiFlatTags = Object.values(tagsByLang).flat().filter(Boolean);

    // Merge existing (FM), inline, and AI tags, removing duplicates (case preserved)
    const chosen = new Map<string, string>();

    const addKeepCase = (arr: any[]) => {
      for (const t of arr) {
        const raw = formatExistingTag(String(t ?? ''));
        const k = tagKey(raw);
        if (k && !chosen.has(k)) chosen.set(k, raw);
      }
    };
    const addAi = (arr: any[]) => {
      for (const t of arr) {
        const raw = formatAiTag(String(t ?? ''));
        const k = tagKey(raw);
        if (k && !chosen.has(k)) chosen.set(k, raw);
      }
    };

    addKeepCase(inlineTags);                 // Inline first
    addKeepCase(asArray(frontmatter?.tags)); // Then existing FM
    addAi(aiFlatTags);                       // Last AI

    const finalTags = Array.from(chosen.values());

    // Compose AI-generated fields (tags are merged and overwritten)
    const generated = {
      title: obj.title ?? '',
      summary: obj.summary ?? '',
    } as Record<string, any>;

    // Merge existing (FM) + AI-generated FM
    const merged = this.mergeFrontmatter(frontmatter, generated);

    // Final tags overwrite with case preserved
    (merged as any).tags = finalTags;

    // Remove unnecessary/forbidden fields
    delete (merged as any).updated;
    delete (merged as any).last_modified;
    delete (merged as any).path;

    // created: if missing, fill with file creation/modification timestamp; if string, normalize to YYYY-MM-DD
    if (!('created' in merged) || !merged.created) {
      const stat = file.stat;
      const baseTs = stat?.ctime ?? stat?.mtime ?? Date.now();
      (merged as any).created = formatYYYYMMDDLocal(baseTs);
    } else if (typeof (merged as any).created === 'string') {
      const dt = new Date((merged as any).created);
      if (!isNaN(dt.getTime())) (merged as any).created = formatYYYYMMDDLocal(dt);
    }

    // fm_created: always record today's date (local)
    (merged as any).fm_created = formatYYYYMMDDLocal(Date.now());

    // Write back to file — use body with tags removed
    const newRaw = this.composeWithFrontmatter(merged, strippedBody);
    await this.app.vault.modify(file, newRaw);
    new Notice(`Frontmatter updated: ${file.path}`);
  }





  // === Prompt generation ===
  private buildPrompt(args: { path: string; body: string; existingFM: Record<string, any> | null }) {
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
  private buildJsonPrompt(args: { path: string; body: string; existingFM: Record<string, any> | null }) {
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
  private async callAIForJSON(prompt: string): Promise<any | null> {
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
      return JSON.parse(text);
    } catch (e) {
      console.error('JSON parse failed:', e, 'original:', text);
      new Notice('Failed to parse AI JSON response');
      return null;
    }
  }


  // === frontmatter split/merge/compose ===
  private splitFrontmatter(raw: string): { frontmatter: Record<string, any> | null; body: string } {
    if (raw.startsWith('---')) {
      const end = raw.indexOf('\n---', 3);
      if (end !== -1) {
        const yaml = raw.slice(3, end + 1).trim();
        const body = raw.slice(end + 4).replace(/^\s*\n/, '');
        const fm = safeLoadYaml(yaml) as Record<string, any> | null;
        return { frontmatter: fm, body };
      }
    }
    return { frontmatter: null, body: raw };
  }

  private composeWithFrontmatter(fm: Record<string, any>, body: string): string {
    const yaml = YAML.dump(fm).trimEnd();
    return `---\n${yaml}\n---\n\n${body}`;
  }

  //  Merge existing frontmatter with generated fields. For tags, merge arrays and dedupe.
  private mergeFrontmatter(oldFM: Record<string, any> | null, genFM: Record<string, any>) {
    const out: Record<string, any> = { ...(oldFM ?? {}) };

    // Always overwrite + tags merged
    for (const [k, v] of Object.entries(genFM)) {
      if (k === 'tags') {
        out[k] = uniqArray([...(asArray(out[k])), ...(asArray(v))]);
      } else {
        out[k] = v;
      }
    }

    // Tag cleanup
    if (out.tags) {
      out.tags = asArray(out.tags)
        .map((t: any) => String(t ?? '').trim())
        .filter(Boolean)
        .map(t => t.replace(/^#/, ''))
        .map(t => t.replace(/\s+/g, '-'))
      out.tags = uniqArray(out.tags);
    }

    return out;
  }
  
  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }
}

// === Utils ===
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
  // Simple cycle detection to prevent infinite recursion
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
  //  Convert English-like tokens to PascalCase for AI-generated tags when desired.
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
  //  Apply formatting rules for tags that originate from AI output.
  //  Korean tags are concatenated; English tags are PascalCased; others use hyphens.
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
  //  Apply conservative cleanup to user-provided or existing tags (preserve case for many languages).
  return cleanupBare(s);
}

function normalizeTag(s: string) {
  //  Alias for cleanupBare; retains the same behavior.
  return cleanupBare(s);
}

function isEnglishTag(tag: string) {
  //  Heuristic check whether a tag is "English-like" (ASCII letters/numbers with separators).
  const s = String(tag).trim();
  const normalized = s.replace(/[ _/]+/g, '-');
  return /^[A-Za-z0-9-]+$/.test(normalized);
}

function hasKorean(tag: string) {
  //  Simple detection for Hangul characters.
  return /[\uAC00-\uD7AF]/.test(tag);
}
function detectTagLang(tag: string): string {
  //  Detect language code for a tag: 'ko' for Korean, 'en' for English-like, otherwise 'other'.
  const s = String(tag).trim();
  if (/[\uAC00-\uD7AF]/.test(s)) return 'ko';
  if (isEnglishTag(s)) return 'en';
  return 'other';
}

function enforceTagQuotas(allTags: string[], tagLangs: Array<{code:string; max:number}>) {
  //  Pick tags while respecting per-language quotas. Uses normalized form for uniqueness.
  const clean = Array.from(new Set(allTags.map(t => formatExistingTag(t)).filter(Boolean)));
  const allowed = new Map(tagLangs.map(x => [x.code, x.max]));
  const picked: string[] = [];
  const counts = new Map<string, number>();

  for (const tag of clean) {
    const lang = detectTagLang(tag);
    if (!allowed.has(lang)) continue;
    const used = counts.get(lang) ?? 0;
    const limit = allowed.get(lang)!;
    if (used < limit) {
      picked.push(tag);
      counts.set(lang, used + 1);
    }
  }
  return picked;
}

function formatYYYYMMDDLocal(ts: number | Date) {
  //  Format a timestamp as YYYY-MM-DD using local date values.
  const d = ts instanceof Date ? ts : new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function safeLoadYaml(y: string): any {
  //  Load YAML safely, returning null on parse errors.
  try { return YAML.load(y); } catch { return null; }
}
function stripCodeFences(s: string) {
  //  Helper to remove code fence markers.
  return s.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```$/, '');
}
function asArray(v: any): any[] {
  //  Ensure value is always returned as an array (empty array for null/undefined).
  if (Array.isArray(v)) return v;
  if (v == null) return [];
  return [v];
}
function uniqArray<T>(arr: T[]): T[] {
  //  Return deduplicated array preserving insertion order.
  return Array.from(new Set(arr));
}
function mergeValue(oldV: any, newV: any) {
  //  Merge two values, concatenating arrays and otherwise taking the new value.
  if (Array.isArray(oldV) || Array.isArray(newV)) {
    return uniqArray([...(asArray(oldV)), ...(asArray(newV))]);
  }
  return newV;
}

function cleanupAfterTagRemoval(s: string) {
  //  Perform whitespace cleanup after inline tags have been removed from the body.
  s = s.replace(/[\u200B-\u200D\uFEFF]/g, '');

  s = s.replace(/[ \t]+$/gm, '');

  s = s.replace(/\n{3,}/g, '\n\n');

  s = s.replace(/\s+$/g, '');
  return s;
}

function extractInlineTagsAndStrip(text: string) {
  //  Find inline tags (e.g., #tag or #한글태그) in the body, collect them, and return the body with tags removed.
  //  Returns { inlineTags: string[], strippedBody: string }.
  const found: string[] = [];

  const TAG_REGEX =
    /(^|(?<=\s)|(?<=[([{:]))#(?!#|\s)((?=[A-Za-z0-9_\-\/\uAC00-\uD7AF]*[A-Za-z\uAC00-\uD7AF])[A-Za-z0-9_\-\/\uAC00-\uD7AF]+)(?=$|[\s,.;:!?)}\]])/gu;

  let s = text.replace(TAG_REGEX, (_full, prefix: string, tag: string) => {
    const norm = formatExistingTag(tag);
    if (norm) found.push(norm);
    return prefix ?? '';
  });

  
  s = cleanupAfterTagRemoval(s);

  const unique = Array.from(new Set(found.map(t => t)));
  return { inlineTags: unique, strippedBody: s };
}

// === setting ===

//  Settings UI tab for configuring API key, model, and language quotas for tags.
class FMSettingTab extends PluginSettingTab {
  plugin: FrontmatterAutomation;
  constructor(app: App, plugin: FrontmatterAutomation) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h3', { text: 'Frontmatter Automation Settings' });

    // API Base
    {
      const row = new Setting(containerEl)
        .setName('API Base')
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
      .setName('API Key')
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
        const optionValues = Array.from((drop as any).selectEl.options).map((o: HTMLOptionElement) => o.value);

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
              const valuesNow = Array.from((drop as any).selectEl.options).map((o: HTMLOptionElement) => o.value);
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

    
    containerEl.createEl('h4', { text: 'Tags Language Settings' });

    for (const entry of this.plugin.settings.tagLangs) {
      const label = TAG_LANG_LABELS[entry.code] ?? entry.code;
      const row = new Setting(containerEl).setName(label).setDesc('Maximum number of tags for this language');

      row.addText(t => {
        t.setPlaceholder('5').setValue(String(entry.max));
        t.inputEl.type = 'number';
        t.inputEl.min = '0';
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
        if (Object.keys((d as any).selectEl.options).length === 0) {
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

