// main.ts
import {
  App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile
} from 'obsidian';
import * as YAML from 'js-yaml';

// 언어 코드와 라벨
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

// DEFAULT_SETTINGS 교체
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

    // 리본 버튼
    this.addRibbonIcon('wand-2', 'Frontmatter: 현재 노트 갱신', async () => {
      await this.processCurrentNote();
    });

    // 커맨드 - 현재 노트
    this.addCommand({
      id: 'fm-update-current-note',
      name: 'Frontmatter: 현재 노트 갱신',
      callback: async () => this.processCurrentNote(),
    });

    // 설정 탭
    this.addSettingTab(new FMSettingTab(this.app, this));
  }

  onunload() {}

  // === 핵심 로직들 ===
  private async processCurrentNote() {
    const file = this.app.workspace.getActiveFile();
    if (!file) return new Notice('활성 노트가 없습니다.');
    await this.updateFrontmatterForFile(file);
  }

  private async updateFrontmatterForFile(file: TFile) {
    // 원본 읽기 및 프론트매터/본문 분리
    const raw = await this.app.vault.read(file);
    const { frontmatter, body } = this.splitFrontmatter(raw);

    // ✅ 본문에서 인라인 태그 추출 & 본문에서 제거
    const { inlineTags, strippedBody } = extractInlineTagsAndStrip(body);

    // AI 프롬프트 생성 — JSON 방식
    const jsonPrompt = this.buildJsonPrompt({
      path: file.path,
      body: strippedBody,
      existingFM: frontmatter,
    });

    // AI 호출(JSON)
    const obj = await this.callAIForJSON(jsonPrompt);
    if (!obj || typeof obj !== 'object') {
      new Notice(`AI로부터 JSON을 받지 못했습니다: ${file.path}`);
      return;
    }

    // 기대 스키마: { title, summary, tags_by_lang: { <code>: string[] } }
    const tagsByLang: Record<string, string[]> = obj.tags_by_lang ?? {};
    const aiFlatTags = Object.values(tagsByLang).flat().filter(Boolean);

    // ✅ 기존(FM) + 인라인 + AI 태그를 "단순 합치고" 중복 제거(케이스 보존)
    const chosen = new Map<string, string>();

    const addKeepCase = (arr: any[]) => {
      for (const t of arr) {
        const raw = formatExistingTag(String(t ?? '')); // 케이스 보존 + 최소 정리
        const k = tagKey(raw);                          // 케이스 무시 키
        if (k && !chosen.has(k)) chosen.set(k, raw);
      }
    };
    const addAi = (arr: any[]) => {
      for (const t of arr) {
        const raw = formatAiTag(String(t ?? ''));       // 케이스 보존 + 최소 정리
        const k = tagKey(raw);
        if (k && !chosen.has(k)) chosen.set(k, raw);
      }
    };

    addKeepCase(inlineTags);                 // 인라인 우선
    addKeepCase(asArray(frontmatter?.tags)); // 그 다음 기존 FM
    addAi(aiFlatTags);                       // 마지막 AI

    const finalTags = Array.from(chosen.values());

    // ✅ AI 생성 필드 구성 (tags는 merge 후 우리가 덮어씀)
    const generated = {
      title: obj.title ?? '',
      summary: obj.summary ?? '',
    } as Record<string, any>;

    // 기존 FM + AI 생성 FM 병합
    const merged = this.mergeFrontmatter(frontmatter, generated);

    // 🔒 최종 태그를 케이스 보존 상태로 덮어쓰기
    (merged as any).tags = finalTags;

    // ✅ 불필요/금지 필드 제거
    delete (merged as any).updated;
    delete (merged as any).last_modified;
    delete (merged as any).path;

    // ✅ created: 없으면 파일 생성/수정 시각 기반으로 채움, 문자열이면 YYYY-MM-DD 로 정규화
    if (!('created' in merged) || !merged.created) {
      const stat = file.stat;
      const baseTs = stat?.ctime ?? stat?.mtime ?? Date.now();
      (merged as any).created = formatYYYYMMDDLocal(baseTs);
    } else if (typeof (merged as any).created === 'string') {
      const dt = new Date((merged as any).created);
      if (!isNaN(dt.getTime())) (merged as any).created = formatYYYYMMDDLocal(dt);
    }

    // ✅ fm_created: 항상 오늘 날짜(로컬)로 기록
    (merged as any).fm_created = formatYYYYMMDDLocal(Date.now());

    // 파일에 다시 쓰기 — 본문은 태그 제거된 버전 사용
    const newRaw = this.composeWithFrontmatter(merged, strippedBody);
    await this.app.vault.modify(file, newRaw);
    new Notice(`Frontmatter 업데이트 완료: ${file.path}`);
  }





  // === 프롬프트 생성 ===
  private buildPrompt(args: { path: string; body: string; existingFM: Record<string, any> | null }) {
    const { path, body, existingFM } = args;
    const cleanBody = sanitizeBodyForLLM(body, 40000, true);
    const existingYaml = existingFM ? YAML.dump(existingFM).trim() : '(없음)';

    // 언어/개수 규칙 문자열 생성 (예: "English:3, 한국어:3")
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
      - Examples: "us-history", "government", "역사", "정부".

    Reference (do NOT include as fields):
    - File path: "${path}"

    Existing frontmatter (if any):
    ${existingYaml}

    Body (images/code removed/truncated as needed):
    ${cleanBody}
    `.trim();

  }

  // === JSON 프롬프트 생성(권장 경로) ===
  private buildJsonPrompt(args: { path: string; body: string; existingFM: Record<string, any> | null }) {
    const { path, body, existingFM } = args;
    const cleanBody = sanitizeBodyForLLM(body, 40000, true);
    const existingYaml = existingFM ? YAML.dump(existingFM).trim() : '(없음)';

    // { "en":5, "ko":5, ... } 형태의 맵 + 설명문 생성
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
        // 라틴계 언어 등: 너무 빡세게 제한하지 않고 “그 언어 단어” 지시만
        langSpecLines.push(`- "${code}": exactly ${max} tags; MUST be ${TAG_LANG_LABELS[code] ?? code} words.`);
      }
    }

    // tags_by_lang 키를 명시적으로 나열 (형식 고정)
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



  // === OpenAI-호환 엔드포인트 호출 (JSON 전용) ===
  private async callAIForJSON(prompt: string): Promise<any | null> {
    if (!this.settings.apiKey) {
      new Notice('API Key가 설정되지 않았습니다. 플러그인 설정에서 입력하세요.');
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
      // OpenAI 호환 엔드포인트에서 JSON 강제 (미지원 환경이면 제거하세요)
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
      console.error('AI 호출 실패(OpenAI/JSON):', res.status, t);
      new Notice(`AI 호출 실패(OpenAI): ${res.status}`);
      return null;
    }

    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content?.trim?.();
    if (!text) return null;

    try {
      return JSON.parse(text);
    } catch (e) {
      console.error('JSON 파싱 실패:', e, '원본:', text);
      new Notice('AI JSON 응답 파싱 실패');
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

  private mergeFrontmatter(oldFM: Record<string, any> | null, genFM: Record<string, any>) {
    const out: Record<string, any> = { ...(oldFM ?? {}) };

    // 무조건 덮어쓰기 + tags는 병합
    for (const [k, v] of Object.entries(genFM)) {
      if (k === 'tags') {
        out[k] = uniqArray([...(asArray(out[k])), ...(asArray(v))]);
      } else {
        out[k] = v;
      }
    }

    // 태그 정리
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

// === 유틸 ===
// LLM에 보내기 전 본문 정리:
// - 이미지 임베드 제거: ![alt](url), ![[file.jpg]], <img ...>
// - data URI(매우 김) 제거
// - 코드블록(optional) 축약
// - 길이 상한 적용
function sanitizeBodyForLLM(
  body: string,
  maxChars = 40000,            // 필요하면 조절
  collapseCodeBlocks = true
) {
  let s = body;

  // 1) data URI 이미지 제거
  s = s.replace(/!\[[^\]]*]\(\s*data:image\/[^)]+\)/gi, '');  // ![](data:image...)
  s = s.replace(/<img[^>]+src\s*=\s*["']data:image\/[^"']+["'][^>]*>/gi, ''); // <img src="data:...">

  // 2) 일반 이미지 마크다운/위키링크/HTML 제거
  s = s.replace(/!\[[^\]]*]\(\s*[^)]+\)/g, '');         // ![alt](http.../file.png)
  s = s.replace(/!\[\[[^\]]+]]/g, '');                  // ![[file.png]]
  s = s.replace(/<img[^>]*>/gi, '');                    // <img ...>

  // 3) 코드블록 축약 (선택)
  if (collapseCodeBlocks) {
    s = s.replace(/```[\s\S]*?```/g, '[code omitted]');
  }

  // 4) 길이 제한
  if (s.length > maxChars) {
    s = s.slice(0, maxChars) + '\n\n[... truncated for LLM ...]';
  }

  return s;
}

/** 태그 문자열의 공통 정리(언어별 규칙 적용, 케이스 보존) */
function cleanupBare(s: string) {
  const base = String(s ?? '').trim().replace(/^#/, '');
  // 순환 방지를 위해 이 자리에서만 간단 감지
  const isKorean  = /[\uAC00-\uD7AF]/.test(base);
  const isEnglish = /^[A-Za-z0-9 _/\-]+$/.test(base) && /[A-Za-z]/.test(base);

  if (isKorean || isEnglish) {
    // ✅ ko/en: 붙여쓰기 (하이픈 포함 모든 구분자 제거)
    return base.replace(/[ _/\-]+/g, '');
  }

  // ✅ 기타: 기존처럼 하이픈 스타일
  return base
    .replace(/[ _/]+/g, '-')   // 공백·언더스코어·슬래시 -> '-'
    .replace(/-{2,}/g, '-')    // 연속 '-' 정리
    .replace(/^-+|-+$/g, '');  // 앞뒤 '-' 제거
}



/** 중복 판별용 key (케이스 무시) */
function tagKey(s: string) {
  return cleanupBare(s).toLowerCase();
}

// 영어 토큰들을 PascalCase로 결합 (약어/숫자는 원형 유지, 이미 Camel/Pascal이면 보존)
function toPascalCaseEnglish(base: string) {
  // 우선 공백/언더스코어/슬래시/하이픈으로 토큰화
  const splitTokens = base.split(/[ _/\-]+/).filter(Boolean);
  const tokens = splitTokens.length > 0 ? splitTokens : [base];

  return tokens
    .map(tok => {
      // 약어(전부 대문자)나 숫자 시작 토큰은 보존
      if (/^[A-Z0-9]+$/.test(tok)) return tok;
      if (/^\d/.test(tok)) return tok;
      // 이미 내부에 대문자가 섞여 있으면 (Camel/Pascal) 원형 보존
      if (/[A-Z].*[a-z]|[a-z].*[A-Z]/.test(tok)) {
        return tok.charAt(0).toUpperCase() + tok.slice(1); // 맨 앞만 보정
      }
      // 일반 소문자/대문자 혼합 아닌 경우: 첫 글자만 대문자
      return tok.charAt(0).toUpperCase() + tok.slice(1).toLowerCase();
    })
    .join('');
}

/** AI 태그용 포맷: ko는 붙여쓰기, en은 PascalCase, 그 외는 기존 규칙 */
function formatAiTag(s: string) {
  const base = String(s ?? '').trim().replace(/^#/, '');
  const isKorean  = /[\uAC00-\uD7AF]/.test(base);
  const isEnglish = /^[A-Za-z0-9 _/\-]+$/.test(base) && /[A-Za-z]/.test(base);

  if (isKorean) {
    // ko: 붙여쓰기
    return base.replace(/[ _/\-]+/g, '');
  }
  if (isEnglish) {
    // en: 단어 경계를 보존해 받은 뒤 PascalCase로 결합
    return toPascalCaseEnglish(base);
  }
  // 기타 언어: 기존 하이픈 스타일 유지
  return base
    .replace(/[ _/]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}


/** 기존/인라인 태그 포맷: 규칙 정리만, 케이스 보존 */
function formatExistingTag(s: string) {
  return cleanupBare(s);
}

/** (호환용) 과거 normalizeTag 호출이 남아있을 수 있으니 alias */
function normalizeTag(s: string) {
  return cleanupBare(s);
}

function isEnglishTag(tag: string) {
  const s = String(tag).trim();
  // 공백/언더스코어/슬래시를 하이픈으로만 바꿔서 검사 (cleanupBare/태그키 미사용)
  const normalized = s.replace(/[ _/]+/g, '-');
  return /^[A-Za-z0-9-]+$/.test(normalized);
}

function hasKorean(tag: string) {
  return /[\uAC00-\uD7AF]/.test(tag);
}
function detectTagLang(tag: string): string {
  const s = String(tag).trim();
  if (/[\uAC00-\uD7AF]/.test(s)) return 'ko';
  if (isEnglishTag(s)) return 'en';
  return 'other';
}

/** 언어별 상한 적용: 설정에 없는 언어는 버림, 같은 언어는 limit 초과분 잘라냄
 *  (지금은 사용 안 할 수도 있지만, 호환을 위해 유지)
 */
function enforceTagQuotas(allTags: string[], tagLangs: Array<{code:string; max:number}>) {
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
  const d = ts instanceof Date ? ts : new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function safeLoadYaml(y: string): any {
  try { return YAML.load(y); } catch { return null; }
}
function stripCodeFences(s: string) {
  return s.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```$/, '');
}
function asArray(v: any): any[] {
  if (Array.isArray(v)) return v;
  if (v == null) return [];
  return [v];
}
function uniqArray<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}
function mergeValue(oldV: any, newV: any) {
  if (Array.isArray(oldV) || Array.isArray(newV)) {
    return uniqArray([...(asArray(oldV)), ...(asArray(newV))]);
  }
  return newV; // 단순 덮어쓰기
}

function cleanupAfterTagRemoval(s: string) {
  // 1) 제로폭 문자 제거
  s = s.replace(/[\u200B-\u200D\uFEFF]/g, '');
  // 2) 줄 끝 공백 제거
  s = s.replace(/[ \t]+$/gm, '');
  // 3) 3줄 이상 연속 빈 줄 → 2줄로 축약
  s = s.replace(/\n{3,}/g, '\n\n');
  // 4) 파일 끝쪽 공백/빈 줄 정리
  s = s.replace(/\s+$/g, '');
  return s;
}

// === 본문에서 인라인 태그 추출 & 제거 ===
// - 마크다운 헤더("# 제목")는 건드리지 않음 (# 뒤에 공백이 있으면 무시)
// - 태그 형식: #tag, #multi-word → 공백/언더바/슬래시는 하이픈 처리(케이스 보존)
// - 한글/영문/숫자/하이픈/언더스코어/슬래시 허용
function extractInlineTagsAndStrip(text: string) {
  const found: string[] = [];

  const TAG_REGEX =
    /(^|(?<=\s)|(?<=[([{:]))#(?!#|\s)((?=[A-Za-z0-9_\-\/\uAC00-\uD7AF]*[A-Za-z\uAC00-\uD7AF])[A-Za-z0-9_\-\/\uAC00-\uD7AF]+)(?=$|[\s,.;:!?)}\]])/gu;

  let s = text.replace(TAG_REGEX, (_full, prefix: string, tag: string) => {
    const norm = formatExistingTag(tag); // 케이스 보존 + 규칙 정리
    if (norm) found.push(norm);
    return prefix ?? ''; // 태그는 본문에서 완전히 제거
  });

  // ✅ 청소: 제로폭 문자/줄 끝 공백/여분 빈 줄/파일 끝 공백 제거
  s = cleanupAfterTagRemoval(s);

  const unique = Array.from(new Set(found.map(t => t))); // 유지: 케이스 보존
  return { inlineTags: unique, strippedBody: s };
}




// === 설정 탭 ===
class FMSettingTab extends PluginSettingTab {
  plugin: FrontmatterAutomation;
  constructor(app: App, plugin: FrontmatterAutomation) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h3', { text: 'Frontmatter Automation 설정' });

    // API Base: 읽기 전용 표시 + 버튼 (기본값 적용 / 직접 입력)
    {
      const row = new Setting(containerEl)
        .setName('API Base')
        .setDesc('OpenAI 호환 엔드포인트 (기본: https://api.openai.com/v1)');

      let apiText: import('obsidian').TextComponent;
      row.addText(t => {
        apiText = t;
        t.setValue(this.plugin.settings.apiBase);
        t.setDisabled(true);
      });

      row.addButton(b => {
        b.setButtonText('기본값 적용')
          .setCta()
          .onClick(async () => {
            this.plugin.settings.apiBase = 'https://api.openai.com/v1';
            await this.plugin.saveSettings();
            apiText.setValue(this.plugin.settings.apiBase);
            new Notice('API Base를 기본값으로 설정했습니다.');
          });
      });

      row.addButton(b => {
        b.setButtonText('직접 입력…')
          .onClick(async () => {
            const cur = this.plugin.settings.apiBase || 'https://api.openai.com/v1';
            const url = window.prompt('API Base URL을 입력하세요', cur);
            if (url && url.trim()) {
              this.plugin.settings.apiBase = url.trim();
              await this.plugin.saveSettings();
              apiText.setValue(this.plugin.settings.apiBase);
              new Notice('API Base가 변경되었습니다.');
            }
          });
      });
    }

    // API Key
    new Setting(containerEl)
      .setName('API Key')
      .setDesc('OpenAI 호환 키 (Bearer)')
      .addText(t => t
        .setPlaceholder('sk-...')
        .setValue(this.plugin.settings.apiKey)
        .onChange(async v => { this.plugin.settings.apiKey = v; await this.plugin.saveSettings(); }));

    // Model (OpenAI 계열 프리셋 + 커스텀 입력)
    new Setting(containerEl)
      .setName('Model')
      .setDesc('OpenAI 호환 모델 선택')
      .addDropdown(drop => {
        const presets = ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-3.5-turbo'];
        for (const m of presets) drop.addOption(m, m);
        drop.addOption('custom', '직접 입력…');

        const cur = (this.plugin.settings.model || '').trim();
        const optionValues = Array.from((drop as any).selectEl.options).map((o: HTMLOptionElement) => o.value);

        if (cur && !optionValues.includes(cur)) {
          drop.addOption(cur, `(현재) ${cur}`);
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
            const name = window.prompt('모델명을 입력하세요', this.plugin.settings.model || 'gpt-4o-mini');
            if (name && name.trim()) {
              const val = name.trim();
              this.plugin.settings.model = val;
              const valuesNow = Array.from((drop as any).selectEl.options).map((o: HTMLOptionElement) => o.value);
              if (!valuesNow.includes(val)) drop.addOption(val, `(현재) ${val}`);
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

    // --- Tags 언어 설정 ---
    containerEl.createEl('h4', { text: 'Tags 언어 설정' });

    for (const entry of this.plugin.settings.tagLangs) {
      const label = TAG_LANG_LABELS[entry.code] ?? entry.code;
      const row = new Setting(containerEl).setName(label).setDesc('언어별 최대 태그 개수');

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
            .setTooltip('이 언어 제거')
            .onClick(async () => {
              this.plugin.settings.tagLangs = this.plugin.settings.tagLangs.filter(x => x !== entry);
              await this.plugin.saveSettings();
              this.display();
            });
        });
      }
    }

    new Setting(containerEl)
      .setName('언어 추가')
      .setDesc('추가할 언어를 선택하고 “추가”를 누르세요')
      .addDropdown(d => {
        const selectedCodes = new Set(this.plugin.settings.tagLangs.map(x => x.code));
        for (const { code, label } of TAG_LANG_CHOICES) {
          if (!selectedCodes.has(code)) d.addOption(code, label);
        }
        if (Object.keys((d as any).selectEl.options).length === 0) {
          d.addOption('none', '추가할 수 있는 언어가 없습니다');
          d.setDisabled(true);
        } else {
          d.setValue('ko');
        }
      })
      .addButton(b => {
        b.setButtonText('추가').setCta().onClick(async () => {
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

