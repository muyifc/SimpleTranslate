const NOTES_STORAGE_KEY = "readingNotesV1";
const MAX_NOTE_CONTENT_CHARACTERS = 10_000;
const noteList = document.querySelector("#noteList");
const noteDetail = document.querySelector("#noteDetail");
const status = document.querySelector("#status");
let notes = [];
let selectedId = "";

initialize();

async function initialize() {
  try {
    notes = await readNotes();
    selectedId = notes[0]?.id || "";
    render();
  } catch (error) {
    noteList.textContent = "读取笔记失败";
    noteDetail.textContent = "选择一条笔记查看详情";
    setStatus(error.message || String(error), true);
  }
}

async function readNotes() {
  const stored = await chrome.storage.local.get(NOTES_STORAGE_KEY);
  return (Array.isArray(stored[NOTES_STORAGE_KEY]) ? stored[NOTES_STORAGE_KEY] : [])
    .map(normalizedNote).filter(Boolean).sort(byUpdatedAt);
}

function validNoteUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.href.slice(0, 2000) : "";
  } catch {
    return "";
  }
}

function normalizedNote(note) {
  if (!note || !["selection", "interpretation", "article-guide"].includes(note.type) || typeof note.id !== "string") return null;
  const createdAt = Number.isFinite(note.createdAt) ? note.createdAt : Date.now();
  return {
    id: note.id.slice(0, 100),
    type: note.type,
    title: String(note.title || "未命名页面").slice(0, 300),
    url: validNoteUrl(note.url),
    sourceText: String(note.sourceText || "").slice(0, 1200),
    content: String(note.content || "").slice(0, MAX_NOTE_CONTENT_CHARACTERS),
    createdAt,
    updatedAt: Number.isFinite(note.updatedAt) ? note.updatedAt : createdAt,
  };
}

function byUpdatedAt(left, right) {
  return right.updatedAt - left.updatedAt;
}

function noteTypeLabel(type) {
  return type === "article-guide" ? "文章导读" : type === "selection" ? "划词摘录" : "划词解读";
}

function exportNote(note, editor, button) {
  button.disabled = true;
  try {
    const title = note.title.replace(/[\r\n]+/g, " ");
    const lines = [
      `# ${title}`,
      "",
      `- 类型：${noteTypeLabel(note.type)}`,
      `- 更新时间：${new Date(note.updatedAt).toLocaleString()}`,
    ];
    if (note.url) lines.push(`- 原文：[打开链接](${note.url})`);
    lines.push("");
    if (note.sourceText) lines.push(...note.sourceText.split(/\r?\n/).map((line) => `> ${line}`), "");
    lines.push(editor.value, "");
    const url = URL.createObjectURL(new Blob([lines.join("\n")], {type: "text/markdown;charset=utf-8"}));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 100) || "阅读笔记"}.md`;
    link.click();
    URL.revokeObjectURL(url);
    setStatus("当前笔记已下载为 Markdown 文件");
  } catch (error) {
    setStatus(error.message || String(error), true);
  } finally {
    button.disabled = false;
  }
}

function render() {
  renderList();
  renderDetail();
}

function renderList() {
  if (!notes.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "还没有阅读笔记";
    noteList.replaceChildren(empty);
    return;
  }
  noteList.replaceChildren(...notes.map((note) => {
    const card = document.createElement("button");
    const title = document.createElement("span");
    const meta = document.createElement("span");
    const excerpt = document.createElement("span");
    card.type = "button";
    card.className = "note-card";
    card.dataset.noteId = note.id;
    card.setAttribute("aria-current", String(note.id === selectedId));
    title.className = "note-card__title";
    meta.className = "note-card__meta";
    excerpt.className = "note-card__excerpt";
    title.textContent = note.title;
    meta.textContent = `${noteTypeLabel(note.type)} · ${new Date(note.updatedAt).toLocaleString()}`;
    excerpt.textContent = note.content.slice(0, 160);
    card.append(title, meta, excerpt);
    card.addEventListener("click", () => {
      selectedId = note.id;
      for (const item of noteList.querySelectorAll("[data-note-id]")) {
        item.setAttribute("aria-current", String(item.dataset.noteId === selectedId));
      }
      renderDetail();
    });
    return card;
  }));
}

function renderDetail() {
  let note = notes.find(({id}) => id === selectedId);
  if (!note) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "选择一条笔记查看详情";
    noteDetail.replaceChildren(empty);
    return;
  }

  const title = document.createElement("h3");
  const meta = document.createElement("p");
  const source = document.createElement("div");
  const editor = document.createElement("textarea");
  const actions = document.createElement("div");
  const save = document.createElement("button");
  const open = document.createElement("a");
  const exportButton = document.createElement("button");
  const remove = document.createElement("button");
  const safeUrl = validNoteUrl(note.url);

  title.className = "note-detail-heading";
  title.textContent = note.title;
  meta.className = "note-meta";
  meta.textContent = `${noteTypeLabel(note.type)} · ${new Date(note.updatedAt).toLocaleString()}`;
  source.className = "note-source";
  source.textContent = note.sourceText;
  source.hidden = !note.sourceText;
  editor.id = "noteEditor";
  editor.setAttribute("aria-label", "笔记正文");
  editor.maxLength = MAX_NOTE_CONTENT_CHARACTERS;
  editor.value = note.content;
  actions.className = "note-actions";
  save.type = exportButton.type = remove.type = "button";
  save.dataset.action = "save-note";
  exportButton.dataset.action = "export-note";
  remove.dataset.action = "delete-note";
  save.textContent = "保存修改";
  exportButton.className = "secondary";
  exportButton.textContent = "导出当前笔记";
  remove.className = "danger";
  remove.textContent = "删除笔记";
  open.id = "openSource";
  open.href = safeUrl || "#";
  open.target = "_blank";
  open.rel = "noopener noreferrer";
  open.textContent = "打开原文";
  open.hidden = !safeUrl;

  editor.addEventListener("input", () => { save.textContent = "保存修改"; });
  save.addEventListener("click", async () => {
    const content = editor.value.trim().slice(0, MAX_NOTE_CONTENT_CHARACTERS);
    if (!content) return setStatus("笔记内容不能为空", true);
    save.disabled = true;
    try {
      // ponytail: chrome.storage has no transaction; re-read immediately before writes to preserve ordinary cross-page additions.
      const latest = await readNotes();
      const current = latest.find(({id}) => id === note.id);
      if (!current) throw new Error("笔记不存在");
      const updated = {...current, content, updatedAt: Date.now()};
      const next = latest.map((item) => item.id === note.id ? updated : item).sort(byUpdatedAt);
      await chrome.storage.local.set({[NOTES_STORAGE_KEY]: next});
      notes = next;
      note = updated;
      renderList();
      save.textContent = "已保存";
      setStatus("笔记已保存");
    } catch (error) {
      setStatus(error.message || String(error), true);
    } finally {
      save.disabled = false;
    }
  });
  open.addEventListener("click", (event) => {
    event.preventDefault();
    const url = validNoteUrl(note.url);
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  });
  exportButton.addEventListener("click", () => exportNote(note, editor, exportButton));
  remove.addEventListener("click", async () => {
    if (!confirm("删除这条笔记？")) return;
    remove.disabled = true;
    try {
      const latest = await readNotes();
      const index = latest.findIndex(({id}) => id === note.id);
      if (index < 0) throw new Error("笔记不存在");
      const next = latest.filter(({id}) => id !== note.id);
      await chrome.storage.local.set({[NOTES_STORAGE_KEY]: next});
      notes = next;
      selectedId = notes[Math.min(index, notes.length - 1)]?.id || "";
      render();
      setStatus("笔记已删除");
    } catch (error) {
      remove.disabled = false;
      setStatus(error.message || String(error), true);
    }
  });

  actions.append(save, open, exportButton, remove);
  noteDetail.replaceChildren(title, meta, source, editor, actions);
}

function setStatus(message, error = false) {
  status.textContent = message;
  status.classList.toggle("error", error);
}
