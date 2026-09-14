const {
  Plugin,
  PluginSettingTab,
  Setting,
  Notice,
  requestUrl,
  TFile,
  normalizePath
} = require("obsidian");

const BOOK_START = "<!-- weread-wiki:start -->";
const BOOK_END = "<!-- weread-wiki:end -->";
const CONCEPT_START = "<!-- weread-wiki:concept:start -->";
const CONCEPT_END = "<!-- weread-wiki:concept:end -->";
const REFS_START = "<!-- weread-wiki:refs:start -->";
const REFS_END = "<!-- weread-wiki:refs:end -->";

const DEFAULT_SETTINGS = {
  geminiApiKey: "",
  geminiModel: "gemini-2.5-flash",
  wereadFolder: "Books/Weread",
  conceptsFolder: "Concepts",
  autoProcess: true,
  debounceSeconds: 10,
  cache: {}
};

module.exports = class WereadWikiLinker extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.settings.cache = this.settings.cache || {};
    this.busy = new Set();
    this.timers = new Map();

    this.addSettingTab(new WikiLinkerSettingTab(this.app, this));

    this.addCommand({
      id: "scan-all-weread-notes",
      name: "扫描全部微信读书笔记并生成维基注释",
      callback: () => this.scanAll(true)
    });

    this.addCommand({
      id: "process-active-weread-note",
      name: "处理当前微信读书笔记",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const valid = file instanceof TFile && this.isTarget(file);
        if (valid && !checking) this.processFile(file, true);
        return valid;
      }
    });

    this.registerEvent(
      this.app.vault.on("modify", (file) => this.queueFile(file))
    );
  }

  onunload() {
    for (const timer of this.timers.values()) window.clearTimeout(timer);
    this.timers.clear();
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  isTarget(file) {
    if (!(file instanceof TFile) || file.extension !== "md") return false;
    const folder = normalizePath(this.settings.wereadFolder).replace(/\/$/, "");
    return file.path.startsWith(folder + "/");
  }

  queueFile(file) {
    if (!this.settings.autoProcess || !this.isTarget(file)) return;
    if (this.busy.has(file.path)) return;

    const oldTimer = this.timers.get(file.path);
    if (oldTimer) window.clearTimeout(oldTimer);

    const timer = window.setTimeout(() => {
      this.timers.delete(file.path);
      this.processFile(file, false);
    }, Math.max(3, this.settings.debounceSeconds) * 1000);

    this.timers.set(file.path, timer);
  }

  async scanAll(showNotice = true) {
    if (!this.settings.geminiApiKey) {
      new Notice("请先在 Weread Wiki Linker 设置中填写 Gemini API Key");
      return;
    }

    const files = this.app.vault
      .getMarkdownFiles()
      .filter((file) => this.isTarget(file));

    let success = 0;
    let failed = 0;

    for (const file of files) {
      try {
        await this.processFile(file, false);
        success++;
      } catch (error) {
        console.error("Weread Wiki Linker:", file.path, error);
        failed++;
      }
    }

    if (showNotice) {
      new Notice(`维基注释处理完成：成功 ${success}，失败 ${failed}`);
    }
  }

  async processFile(file, showNotice = false) {
    if (!this.isTarget(file) || this.busy.has(file.path)) return;

    this.busy.add(file.path);

    try {
      const original = await this.app.vault.read(file);
      const cleanContent = stripBookBlock(original);

      if (!cleanContent.includes("weread-highlights-reviews")) return;

      const highlights = extractHighlights(cleanContent);
      if (!highlights.length) {
        if (showNotice) new Notice("当前笔记中没有识别到微信读书划线");
        return;
      }

      const hash = hashText(JSON.stringify(highlights));
      const previous = this.settings.cache[file.path];
      let entries;

      if (previous && previous.hash === hash) {
        entries = previous.entries || [];
      } else {
        if (!this.settings.geminiApiKey) {
          if (showNotice) new Notice("请先填写 Gemini API Key");
          return;
        }

        const candidates = await this.extractEntities(highlights);
        entries = await this.enrichWithWikipedia(highlights, candidates);

        this.settings.cache[file.path] = {
          hash,
          bookTitle: file.basename,
          entries,
          updatedAt: new Date().toISOString()
        };

        await this.saveSettings();
      }

      const updated = renderBookNote(cleanContent, entries);

      if (updated !== original) {
        await this.app.vault.modify(file, updated);
      }

      const oldTitles = (previous?.entries || []).map((item) => item.wikiTitle);
      const newTitles = entries.map((item) => item.wikiTitle);
      const affected = [...new Set([...oldTitles, ...newTitles])];

      for (const title of affected) {
        await this.updateConceptNote(title);
      }

      if (showNotice) {
        new Notice(
          entries.length
            ? `已生成 ${entries.length} 条维基注释`
            : "未发现符合规则且具有维基词条的重要概念"
        );
      }
    } catch (error) {
      console.error("Weread Wiki Linker:", error);
      if (showNotice) new Notice(`处理失败：${error.message || error}`);
      throw error;
    } finally {
      window.setTimeout(() => this.busy.delete(file.path), 1500);
    }
  }

  async extractEntities(highlights) {
    const all = [];

    for (let start = 0; start < highlights.length; start += 20) {
      const batch = highlights.slice(start, start + 20);
      const numbered = batch
        .map((text, i) => `${start + i}. ${text}`)
        .join("\n");

      const prompt = `
你是中文阅读笔记实体识别器。请分析以下微信读书划线。

只提取：
1. 明确且重要的概念；
2. 人物；
3. 作品；
4. 机构；
5. 组织。

不要提取普通动作、情绪、形容词、泛称或无百科价值的日常词语。
例如“哭泣、微笑、漂亮、生活、东西”通常不应提取。
名称应尽量采用中文维基百科可能使用的正式词条名。
每条划线最多提取 6 项。没有合适内容时返回空数组。

严格返回 JSON：
{"items":[{"index":0,"entities":[{"term":"词条名","type":"概念"}]}]}

type 只能是：概念、人物、作品、机构、组织。

划线：
${numbered}
`.trim();

      const result = await this.callGemini(prompt);
      const items = Array.isArray(result) ? result : result.items || [];

      for (const item of items) {
        const index = Number(item.index);
        if (!Number.isInteger(index) || !highlights[index]) continue;

        const entities = Array.isArray(item.entities) ? item.entities : [];

        for (const entity of entities.slice(0, 6)) {
          const term =
            typeof entity === "string" ? entity.trim() : entity.term?.trim();
          const type =
            typeof entity === "string" ? "概念" : entity.type || "概念";

          if (term && term.length <= 80) {
            all.push({ index, term, type });
          }
        }
      }
    }

    highlights.forEach((text, index) => {
      for (const year of extractYears(text)) {
        all.push({ index, term: year, type: "年份" });
      }
    });

    const seen = new Set();
    return all.filter((item) => {
      const key = `${item.index}:${item.term}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  async callGemini(prompt) {
    const model = encodeURIComponent(
      this.settings.geminiModel || "gemini-2.5-flash"
    );

    const response = await requestUrl({
      url:
        `https://generativelanguage.googleapis.com/v1beta/models/` +
        `${model}:generateContent`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": this.settings.geminiApiKey
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 4096,
          responseMimeType: "application/json"
        }
      })
    });

    const text = response.json?.candidates?.[0]?.content?.parts
      ?.map((part) => part.text || "")
      .join("");

    if (!text) throw new Error("Gemini 没有返回内容");

    try {
      return JSON.parse(
        text.replace(/^```json\s*/i, "").replace(/\s*```$/, "")
      );
    } catch {
      throw new Error("Gemini 返回的内容不是有效 JSON");
    }
  }

  async enrichWithWikipedia(highlights, candidates) {
    const uniqueTerms = [...new Set(candidates.map((item) => item.term))];
    const wikiMap = new Map();

    for (const term of uniqueTerms) {
      try {
        wikiMap.set(term, await this.lookupWikipedia(term));
      } catch (error) {
        console.warn("Wikipedia lookup failed:", term, error);
        wikiMap.set(term, null);
      }
    }

    const entries = [];

    for (const candidate of candidates) {
      const wiki = wikiMap.get(candidate.term);
      if (!wiki) continue;

      entries.push({
        highlightIndex: candidate.index,
        quote: highlights[candidate.index],
        requestedTerm: candidate.term,
        type: candidate.type,
        wikiTitle: wiki.title,
        summary: wiki.summary,
        url: wiki.url
      });
    }

    const seen = new Set();
    return entries.filter((entry) => {
      const key = `${entry.highlightIndex}:${entry.wikiTitle}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  async lookupWikipedia(term) {
    let page = await this.fetchWikipediaPage(term);
    if (page) return page;

    const searchUrl =
      "https://zh.wikipedia.org/w/api.php?action=query&list=search" +
      "&format=json&origin=*&srlimit=5&srnamespace=0&srsearch=" +
      encodeURIComponent(term);

    const searchResponse = await requestUrl({ url: searchUrl });
    const results = searchResponse.json?.query?.search || [];
    const normalizedTerm = normalizeTitle(term);

    const match = results.find((result) => {
      const title = normalizeTitle(result.title);
      return (
        title === normalizedTerm ||
        title.includes(normalizedTerm) ||
        normalizedTerm.includes(title)
      );
    });

    if (!match) return null;
    return await this.fetchWikipediaPage(match.title);
  }

  async fetchWikipediaPage(title) {
    const url =
      "https://zh.wikipedia.org/w/api.php?action=query" +
      "&format=json&origin=*&redirects=1&prop=extracts%7Cinfo" +
      "&exintro=1&explaintext=1&inprop=url&titles=" +
      encodeURIComponent(title);

    const response = await requestUrl({ url });
    const pages = Object.values(response.json?.query?.pages || {});
    const page = pages[0];

    if (!page || page.missing !== undefined) return null;

    const summary = String(page.extract || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 700);

    return {
      title: page.title,
      summary: summary || "该词条目前没有可用的简介。",
      url:
        page.fullurl ||
        `https://zh.wikipedia.org/wiki/${encodeURIComponent(page.title)}`
    };
  }

  async updateConceptNote(title) {
    if (!title) return;

    await ensureFolder(this.app, this.settings.conceptsFolder);

    const safeName = sanitizeFileName(title);
    const path = normalizePath(
      `${this.settings.conceptsFolder}/${safeName}.md`
    );

    const refs = [];
    let representative = null;

    for (const [bookPath, record] of Object.entries(this.settings.cache)) {
      if (!this.app.vault.getAbstractFileByPath(bookPath)) continue;

      for (const entry of record.entries || []) {
        if (entry.wikiTitle !== title) continue;
        representative = representative || entry;

        refs.push({
          bookPath: bookPath.replace(/\.md$/i, ""),
          bookTitle: record.bookTitle || basename(bookPath),
          quote: entry.quote
        });
      }
    }

    const conceptBlock = representative
      ? [
          CONCEPT_START,
          "## 维基百科摘要",
          "",
          representative.summary,
          "",
          `[查看中文维基百科原词条](${representative.url})`,
          CONCEPT_END
        ].join("\n")
      : "";

    const uniqueRefs = [];
    const refSeen = new Set();

    for (const ref of refs) {
      const key = `${ref.bookPath}:${ref.quote}`;
      if (refSeen.has(key)) continue;
      refSeen.add(key);
      uniqueRefs.push(ref);
    }

    const refsBlock = [
      REFS_START,
      "## 相关微信读书划线",
      "",
      uniqueRefs.length
        ? uniqueRefs
            .map(
              (ref) =>
                `- [[${escapeWiki(ref.bookPath)}|${escapeWiki(
                  ref.bookTitle
                )}]]：${escapeMarkdown(ref.quote)}`
            )
            .join("\n")
        : "- 暂无关联划线",
      REFS_END
    ].join("\n");

    const existing = this.app.vault.getAbstractFileByPath(path);

    if (existing instanceof TFile) {
      let content = await this.app.vault.read(existing);
      content = replaceManagedBlock(
        content,
        CONCEPT_START,
        CONCEPT_END,
        conceptBlock
      );
      content = replaceManagedBlock(
        content,
        REFS_START,
        REFS_END,
        refsBlock
      );
      await this.app.vault.modify(existing, content.trimEnd() + "\n");
    } else if (representative) {
      const content = [
        `# ${title}`,
        "",
        conceptBlock,
        "",
        refsBlock,
        ""
      ].join("\n");

      await this.app.vault.create(path, content);
    }
  }

  async testGemini() {
    if (!this.settings.geminiApiKey) {
      new Notice("请先填写 Gemini API Key");
      return;
    }

    try {
      const result = await this.callGemini(
        '只返回 JSON：{"status":"ok"}'
      );

      if (result.status === "ok") {
        new Notice("Gemini API 连接成功");
      } else {
        new Notice("Gemini 已响应，但返回格式异常");
      }
    } catch (error) {
      new Notice(`Gemini 测试失败：${error.message || error}`);
    }
  }
};

class WikiLinkerSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Weread Wiki Linker" });

    containerEl.createEl("p", {
      text:
        "Gemini Key 保存在插件 data.json 中。如果坚果云同步 .obsidian，" +
        "该设置也会同步到你的其他设备。请勿向他人分享 data.json。"
    }).addClass("weread-wiki-linker-warning");

    new Setting(containerEl)
      .setName("Gemini API Key")
      .setDesc("用于从划线中识别重要概念；不会写入公开笔记。")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("AIza...")
          .setValue(this.plugin.settings.geminiApiKey)
          .onChange(async (value) => {
            this.plugin.settings.geminiApiKey = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Gemini 模型")
      .setDesc("默认使用稳定、成本较低的 gemini-2.5-flash。")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.geminiModel)
          .onChange(async (value) => {
            this.plugin.settings.geminiModel =
              value.trim() || "gemini-2.5-flash";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("微信读书笔记目录")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.wereadFolder)
          .onChange(async (value) => {
            this.plugin.settings.wereadFolder = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("概念笔记目录")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.conceptsFolder)
          .onChange(async (value) => {
            this.plugin.settings.conceptsFolder = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("微信读书同步后自动处理")
      .setDesc("监测 Books/Weread 中的笔记变化并自动重建维基注释。")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoProcess)
          .onChange(async (value) => {
            this.plugin.settings.autoProcess = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("处理等待时间")
      .setDesc("等待微信读书插件完成写入后再处理，建议 10 秒。")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.debounceSeconds))
          .onChange(async (value) => {
            const number = Number(value);
            this.plugin.settings.debounceSeconds =
              Number.isFinite(number) && number >= 3 ? number : 10;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("测试 Gemini")
      .addButton((button) =>
        button.setButtonText("测试连接").onClick(() => {
          this.plugin.testGemini();
        })
      );

    new Setting(containerEl)
      .setName("扫描现有微信读书笔记")
      .setDesc("首次安装或修改规则后，可手动重新扫描。")
      .addButton((button) =>
        button
          .setButtonText("开始扫描")
          .setCta()
          .onClick(() => this.plugin.scanAll(true))
      );
  }
}

function extractHighlights(content) {(content) {
  const heading =
    /(?:^|\n)#{1,6}\s*高亮划线[^\n]*(?:\n|$)/.exec(content);

  if (!heading) return [];

  const start = heading.index + heading[0].length;
  const remaining = content.slice(start);
  const nextHeading =
    /\n#{1,6}\s*(?:读书笔记|本书评论)[^\n]*(?:\n|$)/.exec(
      remaining
    );

  const section = nextHeading
    ? remaining.slice(0, nextHeading.index)
    : remaining;

  const highlights = [];

  for (const line of section.split("\n")) {
    if (!line.includes("📌")) continue;

    const text = line
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/<[^>]+>/g, "")
      .replace(/^.*?📌\s*/, "")
      .replace(/[*_~`>#]/g, "")
      .trim();

    if (text.length >= 2) highlights.push(text);
  }

  return [...new Set(highlights)];
}

function extractYears(text) {
  const pattern =
    /(?:1\d{3}|20\d{2}|21\d{2}|[〇零一二三四五六七八九]{3,4})年/g;
  return [...new Set(text.match(pattern) || [])];
}

function renderBookNote(cleanContent, entries) {
  if (!entries.length) return cleanContent.trimEnd() + "\n";

  const grouped = new Map();

  for (const entry of entries) {
    if (!grouped.has(entry.highlightIndex)) {
      grouped.set(entry.highlightIndex, {
        quote: entry.quote,
        items: []
      });
    }
    grouped.get(entry.highlightIndex).items.push(entry);
  }

  const sections = [];

  for (const [index, group] of grouped.entries()) {
    const lines = [
      `### 划线 ${index + 1}`,
      "",
      `> ${escapeMarkdown(group.quote)}`,
      ""
    ];

    for (const item of group.items) {
      const conceptPath = `Concepts/${sanitizeFileName(item.wikiTitle)}`;
      lines.push(
        `- [[${escapeWiki(conceptPath)}|${escapeWiki(
          item.wikiTitle
        )}]]（${item.type}）：${escapeMarkdown(item.summary)} ` +
          `[[${item.url}|维基百科]]`
      );
    }

    sections.push(lines.join("\n"));
  }

  const block = [
    BOOK_START,
    "## 自动维基注释",
    "",
    "> [!info] 此区域由 Weread Wiki Linker 自动维护，请勿直接编辑。",
    "",
    sections.join("\n\n"),
    BOOK_END
  ].join("\n");

  return cleanContent.trimEnd() + "\n\n" + block + "\n";
}

function stripBookBlock(content) {
  return replaceManagedBlock(content, BOOK_START, BOOK_END, "")
    .trimEnd()
    .concat("\n");
}

function replaceManagedBlock(content, start, end, replacement) {
  const startIndex = content.indexOf(start);

  if (startIndex === -1) {
    return replacement
      ? content.trimEnd() + "\n\n" + replacement + "\n"
      : content;
  }

  const endIndex = content.indexOf(end, startIndex);
  if (endIndex === -1) return content;

  const before = content.slice(0, startIndex).trimEnd();
  const after = content.slice(endIndex + end.length).trim();

  return [before, replacement, after].filter(Boolean).join("\n\n") + "\n";
}

async function ensureFolder(app, folderPath) {
  const normalized = normalizePath(folderPath);
  const parts = normalized.split("/");
  let current = "";

  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (!app.vault.getAbstractFileByPath(current)) {
      try {
        await app.vault.createFolder(current);
      } catch {}
    }
  }
}

function sanitizeFileName(name) {
  return String(name)
    .replace(/[\\/:*?"<>|#^[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}

function normalizeTitle(value) {
  return String(value)
    .toLowerCase()
    .replace(/[\s·•—\-_,，。、《》“”"'（）()]/g, "");
}

function escapeMarkdown(text) {
  return String(text).replace(/\s+/g, " ").trim();
}

function escapeWiki(text) {
  return String(text).replace(/\|/g, "｜").replace(/\]/g, "］");
}

function basename(path) {
  return path.split("/").pop().replace(/\.md$/i, "");
}

function hashText(text) {
  let hash = 2166136261;

  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(16);
}
