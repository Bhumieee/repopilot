"use strict";

const API_ROOT = "https://api.github.com";
const MAX_FILES = 5000;
const MAX_PREVIEW_BYTES = 5 * 1024 * 1024;
const COLORS = ["#8a82ff", "#22d3a6", "#f0b37e", "#6db3fa", "#e987c5", "#e9d26a", "#70d6c3", "#f47d7d"];
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "avif", "bmp"]);
const DOC_EXTENSIONS = new Set(["md", "mdx", "rst", "txt", "adoc", "pdf"]);
const LANGUAGE_EXTENSIONS = {
  js: "JavaScript", mjs: "JavaScript", cjs: "JavaScript", jsx: "JavaScript",
  ts: "TypeScript", tsx: "TypeScript", py: "Python", go: "Go", rs: "Rust",
  java: "Java", kt: "Kotlin", swift: "Swift", rb: "Ruby", php: "PHP",
  c: "C", h: "C", cpp: "C++", hpp: "C++", cs: "C#", html: "HTML",
  css: "CSS", scss: "SCSS", sass: "Sass", json: "JSON", yml: "YAML",
  yaml: "YAML", sh: "Shell", sql: "SQL", vue: "Vue", svelte: "Svelte",
  dart: "Dart", ex: "Elixir", exs: "Elixir", clj: "Clojure", scala: "Scala"
};
const LANGUAGE_COLORS = {
  JavaScript: "#f0db4f", TypeScript: "#5b9ce9", Python: "#75a85b", HTML: "#e87952",
  CSS: "#6c9df2", SCSS: "#d879ad", Go: "#61c5d5", Rust: "#e79a68", Java: "#ec8f5b",
  Ruby: "#df6470", PHP: "#8589da", Vue: "#42b883", Svelte: "#ff7857", Shell: "#8bc98b"
};

const elements = {
  form: document.querySelector("#analyzer-form"),
  url: document.querySelector("#repo-url"),
  analyze: document.querySelector("#analyze-button"),
  status: document.querySelector("#status-message"),
  dashboard: document.querySelector("#workspace"),
  tree: document.querySelector("#file-tree"),
  fileSearch: document.querySelector("#file-search"),
  filters: [...document.querySelectorAll(".filter-chip")],
  readerEmpty: document.querySelector("#reader-empty"),
  codeArea: document.querySelector("#code-area"),
  filePreview: document.querySelector("#file-preview"),
  codeLines: document.querySelector("#code-lines"),
  copy: document.querySelector("#copy-code"),
  codeScroll: document.querySelector("#code-scroll"),
  codeSearch: document.querySelector("#code-search-input"),
  codeSearchCount: document.querySelector("#code-search-count"),
  insightList: document.querySelector("#insight-list")
};

const state = {
  repo: null,
  files: [],
  selectedPath: null,
  activeFilter: "all",
  code: "",
  matches: [],
  currentMatch: -1,
  loadId: 0
};

function setStatus(message, kind = "error") {
  elements.status.textContent = message;
  elements.status.className = `status-message${kind === "loading" ? " loading" : kind === "success" ? " success" : ""}`;
  elements.status.hidden = !message;
}

function readableSize(bytes = 0) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileExtension(path) {
  const name = path.split("/").pop() || "";
  const index = name.lastIndexOf(".");
  return index > 0 ? name.slice(index + 1).toLowerCase() : "";
}

function fileCategory(file) {
  const extension = fileExtension(file.path);
  if (["html", "htm"].includes(extension)) return "html";
  if (["css", "scss", "sass", "less"].includes(extension)) return "css";
  if (["js", "mjs", "cjs", "jsx", "ts", "tsx"].includes(extension)) return "javascript";
  if (IMAGE_EXTENSIONS.has(extension)) return "images";
  if (DOC_EXTENSIONS.has(extension) || /(^|\/)(readme|license|changelog|contributing)(\.|$)/i.test(file.path)) return "documentation";
  return "other";
}

function apiError(response) {
  if (response.status === 404) return new Error("Repository or file not found. Check the URL and confirm the repository is public.");
  if (response.status === 403 || response.status === 429) {
    const reset = response.headers.get("X-RateLimit-Reset");
    const resetTime = reset ? new Date(Number(reset) * 1000).toLocaleTimeString() : "";
    return new Error(`GitHub API rate limit reached. Try again later${resetTime ? ` (resets around ${resetTime})` : ""}.`);
  }
  if (response.status === 401) return new Error("GitHub did not allow this request. Private repositories require a secure authenticated backend.");
  return new Error(`GitHub returned an error (${response.status}). Please try again.`);
}

async function fetchJSON(url, signal) {
  const response = await fetch(url, {
    signal,
    headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" }
  });
  if (!response.ok) throw apiError(response);
  return response.json();
}

function parseRepositoryURL(value) {
  let url;
  try { url = new URL(value.trim()); } catch { throw new Error("Enter a valid GitHub repository URL, such as https://github.com/owner/repository."); }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") {
    throw new Error("Use a public repository URL from https://github.com/owner/repository.");
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 2) throw new Error("Enter the repository's main GitHub URL, not a file, folder, or profile link.");
  const [owner, rawRepo] = parts;
  const repo = rawRepo.replace(/\.git$/i, "");
  if (!owner || !repo) throw new Error("That doesn't look like a GitHub repository URL.");
  return { owner, repo };
}

async function getRepositoryFiles(repository, signal) {
  const treeURL = `${API_ROOT}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/git/trees/${encodeURIComponent(repository.default_branch)}?recursive=1`;
  const treeData = await fetchJSON(treeURL, signal);
  if (!treeData.truncated) {
    const files = treeData.tree.filter((item) => item.type === "blob");
    return {
      files: files.slice(0, MAX_FILES).map((item) => ({
        path: item.path, size: item.size || 0, sha: item.sha, url: item.url
      })),
      limited: files.length > MAX_FILES
    };
  }
  return getFilesProgressively(repository, signal);
}

async function getFilesProgressively(repository, signal) {
  const files = [];
  const pending = [""];
  while (pending.length && files.length < MAX_FILES) {
    const directory = pending.shift();
    const path = directory ? `${directory}/` : "";
    const url = `${API_ROOT}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(repository.default_branch)}`;
    const contents = await fetchJSON(url, signal);
    if (!Array.isArray(contents)) continue;
    for (const item of contents) {
      if (item.type === "dir") pending.push(item.path);
      else if (item.type === "file") files.push({ path: item.path, size: item.size || 0, sha: item.sha, url: item.url, download_url: item.download_url });
      if (files.length >= MAX_FILES) break;
    }
  }
  return { files, limited: pending.length > 0 };
}

async function analyzeRepository(event) {
  event.preventDefault();
  const loadId = ++state.loadId;
  const controller = new AbortController();
  if (state.controller) state.controller.abort();
  state.controller = controller;
  elements.dashboard.hidden = true;
  elements.analyze.disabled = true;
  elements.analyze.querySelector("span:first-child").textContent = "Analyzing...";
  setStatus("Connecting to GitHub and reading the repository structure...", "loading");
  try {
    const { owner, repo } = parseRepositoryURL(elements.url.value);
    const repository = await fetchJSON(`${API_ROOT}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, controller.signal);
    if (loadId !== state.loadId) return;
    state.repo = repository;
    const [treeResult, languagesResult] = await Promise.all([
      getRepositoryFiles({
        owner: repository.owner.login,
        repo: repository.name,
        default_branch: repository.default_branch
      }, controller.signal),
      fetchJSON(repository.languages_url, controller.signal)
    ]);
    if (loadId !== state.loadId) return;
    state.files = treeResult.files.sort((a, b) => a.path.localeCompare(b.path));
    state.selectedPath = null;
    state.activeFilter = "all";
    state.languages = languagesResult;
    renderDashboard(treeResult.limited);
    elements.dashboard.hidden = false;
    setStatus(
      treeResult.limited
        ? `Showing the first ${state.files.length.toLocaleString()} files. This repository is very large; the explorer is capped to keep your browser responsive.`
        : `Loaded ${state.files.length.toLocaleString()} files from ${repository.full_name}.`,
      treeResult.limited ? "loading" : "success"
    );
    if (treeResult.limited) elements.status.classList.add("limited");
    document.querySelector("#workspace").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    if (error.name === "AbortError" || loadId !== state.loadId) return;
    setStatus(error.message || "Unable to analyze this repository. Please try again.");
  } finally {
    if (loadId === state.loadId) {
      elements.analyze.disabled = false;
      elements.analyze.querySelector("span:first-child").textContent = "Analyze repository";
    }
  }
}

function renderDashboard(limited) {
  const repo = state.repo;
  document.querySelector("#repo-avatar").textContent = (repo.name || "R").slice(0, 1).toUpperCase();
  document.querySelector("#repo-owner").textContent = repo.owner.login;
  document.querySelector("#repo-name").textContent = repo.name;
  document.querySelector("#repo-description").textContent = repo.description || "No description provided by the repository owner.";
  document.querySelector("#repo-github-link").href = repo.html_url;
  document.querySelector("#stat-files").textContent = `${state.files.length.toLocaleString()}${limited ? "+" : ""}`;
  const primaryLanguage = repo.language || Object.keys(state.languages || {})[0] || "Not specified";
  document.querySelector("#stat-language").textContent = primaryLanguage;
  document.querySelector("#stat-branch").textContent = repo.default_branch;
  document.querySelector("#stat-updated").textContent = new Date(repo.updated_at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  document.querySelector("#stat-size").textContent = `repository size · ${readableSize(repo.size * 1024)}`;
  document.querySelector("#overview-description").textContent = repo.description || "The repository owner has not added a project description.";
  document.querySelector("#repo-facts").replaceChildren(
    factText(`${repo.stargazers_count.toLocaleString()} stars`),
    factText(`${repo.forks_count.toLocaleString()} forks`),
    factText(`Updated ${new Date(repo.updated_at).toLocaleDateString()}`),
    factLink(`${repo.license?.spdx_id || "No license listed"}`, repo.license?.url)
  );
  renderTree();
  renderLanguages();
  renderDNA();
  renderInsights();
  loadReadme();
  populateConnectionSamples();
}

function factText(text) {
  const item = document.createElement("span");
  item.textContent = text;
  return item;
}

function factLink(text, href) {
  if (!href) return factText(text);
  const item = document.createElement("a");
  item.textContent = text;
  item.href = href;
  item.target = "_blank";
  item.rel = "noreferrer";
  return item;
}

function createFileTree(files) {
  const root = { dirs: new Map(), files: [] };
  for (const file of files) {
    const parts = file.path.split("/");
    let node = root;
    for (const part of parts.slice(0, -1)) {
      if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), files: [] });
      node = node.dirs.get(part);
    }
    node.files.push(file);
  }
  return root;
}

function renderTree() {
  elements.tree.replaceChildren();
  const query = elements.fileSearch.value.trim().toLowerCase();
  const matches = state.files.filter((file) => {
    const matchesText = !query || file.path.toLowerCase().includes(query);
    return matchesText && (state.activeFilter === "all" || fileCategory(file) === state.activeFilter);
  });
  document.querySelector("#explorer-count").textContent = `${matches.length} / ${state.files.length}`;
  if (!matches.length) {
    const empty = document.createElement("div");
    empty.className = "tree-empty";
    empty.textContent = state.files.length ? "No files match this search." : "This repository contains no files.";
    elements.tree.append(empty);
    return;
  }
  const tree = createFileTree(matches);
  renderTreeNode(tree, elements.tree, "", true);
}

function renderTreeNode(node, container, prefix, expanded = false) {
  for (const [name, child] of [...node.dirs.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const path = prefix ? `${prefix}/${name}` : name;
    const details = document.createElement("details");
    details.className = "tree-directory";
    details.open = Boolean(elements.fileSearch.value.trim()) || expanded;
    const summary = document.createElement("summary");
    summary.className = "tree-row folder";
    summary.style.paddingLeft = `${6 + path.split("/").length * 9}px`;
    const icon = document.createElement("span");
    icon.className = "tree-icon";
    icon.textContent = "▸";
    const label = document.createElement("span");
    label.className = "tree-name";
    label.textContent = name;
    summary.append(icon, label);
    icon.textContent = details.open ? "▾" : "▸";
    details.addEventListener("toggle", () => { icon.textContent = details.open ? "▾" : "▸"; });
    details.append(summary);
    renderTreeNode(child, details, path);
    container.append(details);
  }
  for (const file of node.files.sort((a, b) => a.path.localeCompare(b.path))) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = `tree-row${state.selectedPath === file.path ? " selected" : ""}`;
    row.style.paddingLeft = `${6 + (prefix ? prefix.split("/").length + 1 : 0) * 9}px`;
    row.title = file.path;
    const icon = document.createElement("span");
    icon.className = "tree-icon";
    icon.textContent = fileIcon(file);
    const name = document.createElement("span");
    name.className = "tree-name";
    name.textContent = file.path.split("/").pop();
    const size = document.createElement("span");
    size.className = "tree-size";
    size.textContent = readableSize(file.size);
    row.append(icon, name, size);
    row.addEventListener("click", () => selectFile(file));
    container.append(row);
  }
}

function fileIcon(file) {
  const category = fileCategory(file);
  if (category === "images") return "▧";
  if (category === "documentation") return "≡";
  if (category === "html") return "◇";
  if (category === "css") return "◈";
  if (category === "javascript") return "JS";
  return "·";
}

async function selectFile(file) {
  state.selectedPath = file.path;
  renderTree();
  document.querySelector("#file-breadcrumb").lastElementChild.textContent = file.path;
  elements.readerEmpty.hidden = true;
  elements.codeArea.hidden = true;
  elements.filePreview.hidden = true;
  elements.filePreview.replaceChildren();
  elements.copy.disabled = true;
  document.querySelector("#file-meta").textContent = `${readableSize(file.size)} · Loading…`;
  elements.codeArea.hidden = false;
  elements.codeLines.replaceChildren();
  const extension = fileExtension(file.path);
  if (IMAGE_EXTENSIONS.has(extension)) {
    await renderImage(file);
    return;
  }
  if (file.size > MAX_PREVIEW_BYTES) {
    elements.codeArea.hidden = true;
    elements.filePreview.hidden = false;
    elements.filePreview.textContent = `This file is ${readableSize(file.size)}, which is over the ${readableSize(MAX_PREVIEW_BYTES)} browser preview limit. Open it on GitHub to inspect the full file.`;
    return;
  }
  try {
    const rawURL = file.download_url || rawFileURL(file.path);
    const response = await fetch(rawURL, { headers: { Accept: "text/plain" } });
    if (!response.ok) throw apiError(response);
    const text = await response.text();
    if (state.selectedPath !== file.path) return;
    state.code = text;
    document.querySelector("#file-meta").textContent = `${readableSize(file.size)} · ${text.split("\n").length.toLocaleString()} lines`;
    elements.copy.disabled = false;
    renderCode(text);
    elements.codeSearch.value = "";
    updateCodeSearch();
  } catch (error) {
    if (state.selectedPath !== file.path) return;
    elements.codeArea.hidden = true;
    elements.filePreview.hidden = false;
    elements.filePreview.textContent = `${error.message || "Could not load this file."} Try opening it on GitHub instead.`;
  }
}

async function renderImage(file) {
  elements.codeArea.hidden = true;
  elements.filePreview.hidden = false;
  document.querySelector("#file-meta").textContent = `${readableSize(file.size)} · Image preview`;
  elements.filePreview.textContent = `${file.path.split("/").pop()} · ${readableSize(file.size)}`;
  const image = document.createElement("img");
  image.alt = `Preview of ${file.path}`;
  image.src = file.download_url || rawFileURL(file.path);
  image.addEventListener("error", () => {
    image.remove();
    elements.filePreview.append(document.createTextNode(" Image preview is unavailable."));
  }, { once: true });
  elements.filePreview.append(document.createElement("br"), image);
}

function renderCode(text) {
  elements.codeLines.replaceChildren();
  const fragment = document.createDocumentFragment();
  text.split("\n").forEach((line, index) => {
    const row = document.createElement("tr");
    const lineNumber = document.createElement("td");
    lineNumber.className = "line-number";
    lineNumber.textContent = String(index + 1);
    const source = document.createElement("td");
    source.className = "line-code";
    source.textContent = line || " ";
    row.append(lineNumber, source);
    fragment.append(row);
  });
  elements.codeLines.append(fragment);
}

async function copyCode() {
  if (!state.code) return;
  try {
    await navigator.clipboard.writeText(state.code);
    const label = elements.copy.innerHTML;
    elements.copy.textContent = "Copied!";
    window.setTimeout(() => { elements.copy.innerHTML = label; }, 1400);
  } catch {
    setStatus("Clipboard access was blocked by the browser. Select and copy the code manually.", "error");
  }
}

function updateCodeSearch() {
  const query = elements.codeSearch.value;
  const cells = [...elements.codeLines.querySelectorAll(".line-code")];
  const lines = state.code.split("\n");
  cells.forEach((cell, index) => {
    cell.replaceChildren();
    const line = lines[index] || " ";
    if (!query) {
      cell.textContent = line;
      return;
    }
    const lower = line.toLowerCase();
    const search = query.toLowerCase();
    let from = 0;
    let at = lower.indexOf(search, from);
    while (at !== -1) {
      cell.append(document.createTextNode(line.slice(from, at)));
      const mark = document.createElement("mark");
      mark.textContent = line.slice(at, at + query.length);
      cell.append(mark);
      from = at + query.length;
      at = lower.indexOf(search, from);
    }
    cell.append(document.createTextNode(line.slice(from) || (!line ? " " : "")));
  });
  state.matches = [...elements.codeLines.querySelectorAll("mark")];
  state.currentMatch = state.matches.length ? 0 : -1;
  setCurrentMatch();
  elements.codeSearchCount.textContent = `${state.matches.length ? state.currentMatch + 1 : 0} / ${state.matches.length}`;
}

function setCurrentMatch() {
  state.matches.forEach((match) => match.classList.remove("current-match"));
  if (state.currentMatch >= 0 && state.matches[state.currentMatch]) {
    const match = state.matches[state.currentMatch];
    match.classList.add("current-match");
    match.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
  elements.codeSearchCount.textContent = `${state.matches.length ? state.currentMatch + 1 : 0} / ${state.matches.length}`;
}

function moveCodeSearch(direction) {
  if (!state.matches.length) return;
  state.currentMatch = (state.currentMatch + direction + state.matches.length) % state.matches.length;
  setCurrentMatch();
}

async function loadReadme() {
  const readme = state.files.find((file) => /^readme(?:\.[^/]*)?$/i.test(file.path.split("/").pop()));
  const preview = document.querySelector("#readme-preview");
  preview.replaceChildren();
  if (!readme) {
    const message = document.createElement("span");
    message.className = "muted-copy";
    message.textContent = "README not found in this repository.";
    preview.append(message);
    return;
  }
  try {
    const response = await fetch(readme.download_url || rawFileURL(readme.path));
    if (!response.ok) throw apiError(response);
    const content = (await response.text()).slice(0, 5000);
    preview.textContent = content;
  } catch {
    const message = document.createElement("span");
    message.className = "muted-copy";
    message.textContent = "README preview could not be loaded.";
    preview.append(message);
  }
}

function renderLanguages() {
  const languages = Object.entries(state.languages || {}).sort((a, b) => b[1] - a[1]);
  const total = languages.reduce((sum, [, bytes]) => sum + bytes, 0);
  const bar = document.querySelector("#language-bar");
  const legend = document.querySelector("#language-legend");
  bar.replaceChildren();
  legend.replaceChildren();
  if (!total) {
    bar.style.background = "#252e40";
    legend.textContent = "GitHub has no language data for this repository.";
    return;
  }
  languages.forEach(([name, bytes], index) => {
    const color = LANGUAGE_COLORS[name] || COLORS[index % COLORS.length];
    const segment = document.createElement("span");
    segment.style.width = `${(bytes / total) * 100}%`;
    segment.style.background = color;
    segment.title = `${name}: ${((bytes / total) * 100).toFixed(1)}%`;
    bar.append(segment);
    const key = document.createElement("span");
    const swatch = document.createElement("i");
    swatch.style.background = color;
    key.append(swatch, document.createTextNode(`${name} ${((bytes / total) * 100).toFixed(1)}%`));
    legend.append(key);
  });
}

function renderDNA() {
  const extensionCounts = new Map();
  const folderCounts = new Map();
  const languages = new Map();
  for (const file of state.files) {
    const extension = fileExtension(file.path);
    const type = extension ? `.${extension}` : "no ext";
    extensionCounts.set(type, (extensionCounts.get(type) || 0) + 1);
    const topFolder = file.path.includes("/") ? file.path.split("/")[0] : "(root)";
    folderCounts.set(topFolder, (folderCounts.get(topFolder) || 0) + 1);
    const language = LANGUAGE_EXTENSIONS[extension];
    if (language) languages.set(language, (languages.get(language) || 0) + 1);
  }
  renderBarChart("#type-chart", [...extensionCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 7), state.files.length, "type");
  renderBarChart("#folder-chart", [...folderCounts.entries()].filter(([name]) => name !== "(root)").sort((a, b) => b[1] - a[1]).slice(0, 7), state.files.length, "folder");
  renderBarChart("#dna-language-chart", [...languages.entries()].sort((a, b) => b[1] - a[1]).slice(0, 7), state.files.length, "language");
  document.querySelector("#file-type-total").textContent = `${extensionCounts.size} extensions`;
}

function renderBarChart(selector, entries, total, kind) {
  const container = document.querySelector(selector);
  container.replaceChildren();
  if (!entries.length) {
    const empty = document.createElement("span");
    empty.className = "dna-empty";
    empty.textContent = kind === "folder" ? "No folders at the top level." : "No file type data available.";
    container.append(empty);
    return;
  }
  const max = Math.max(...entries.map(([, count]) => count), 1);
  entries.forEach(([label, count], index) => {
    const row = document.createElement("div");
    row.className = kind === "type" ? "type-row" : kind === "folder" ? "folder-row" : "language-chart-row";
    const name = document.createElement("span");
    name.className = kind === "type" ? "type-row-label" : "";
    name.textContent = label;
    const track = document.createElement("span");
    track.className = kind === "type" ? "type-track" : kind === "folder" ? "folder-track" : "lang-track";
    const fill = document.createElement("i");
    fill.style.width = `${Math.max((count / max) * 100, 2)}%`;
    if (kind === "language") fill.style.setProperty("--chart-color", LANGUAGE_COLORS[label] || COLORS[index % COLORS.length]);
    track.append(fill);
    const value = document.createElement(kind === "language" ? "small" : "span");
    value.className = kind === "type" ? "type-row-value" : kind === "folder" ? "folder-count" : "";
    value.textContent = kind === "language" ? `${Math.round((count / total) * 100)}%` : String(count);
    row.append(name, track, value);
    container.append(row);
  });
}

function renderInsights() {
  const repo = state.repo;
  const extensions = new Map();
  const folders = new Map();
  for (const file of state.files) {
    const extension = fileExtension(file.path);
    if (extension) extensions.set(extension, (extensions.get(extension) || 0) + 1);
    if (file.path.includes("/")) {
      const folder = file.path.split("/")[0];
      folders.set(folder, (folders.get(folder) || 0) + 1);
    }
  }
  const languages = [...new Set(state.files.map((file) => LANGUAGE_EXTENSIONS[fileExtension(file.path)]).filter(Boolean))];
  const topFolders = [...folders.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
  const entryCandidates = state.files.filter((file) => /^(index|main|app|server|manage)\.(js|mjs|cjs|jsx|ts|tsx|py|go|rs|java|html)$/i.test(file.path.split("/").pop()) || /(^|\/)(src\/)?main\.(py|java|kt|rs)$/i.test(file.path));
  const purpose = inferPurpose(repo, extensions);
  const linkedModules = findConnections(state.files);
  const insights = [
    ["What it appears to be", `${purpose} This is an automated guess based on repository metadata and file names.`],
    ["Main technologies", languages.length ? `Detected file types suggest ${languages.slice(0, 6).join(", ")}${languages.length > 6 ? " and more" : ""}. GitHub's language summary is shown separately above.` : "No common source-language extensions were detected in the repository file list."],
    ["Notable folders", topFolders.length ? topFolders.map(([folder, count]) => `${folder}/ (${count} ${count === 1 ? "file" : "files"})`).join(" · ") : "No top-level folders were found; files appear to be at the repository root."],
    ["Possible entry points", entryCandidates.length ? entryCandidates.slice(0, 5).map((file) => file.path).join(", ") : "No conventional entry-point filenames were identified. Check the README and project configuration."],
    ["File connections", linkedModules.length ? `Inferred import/reference patterns found in file contents: ${linkedModules.slice(0, 4).join("; ")}. This scans only a small sample and is not a complete dependency graph.` : "No direct local imports were inferred from sampled JavaScript/TypeScript/Python files."]
  ];
  elements.insightList.replaceChildren();
  insights.forEach(([title, description]) => {
    const item = document.createElement("div");
    item.className = "insight-item";
    const heading = document.createElement("h4");
    heading.textContent = title;
    const content = document.createElement("p");
    content.textContent = description;
    item.append(heading, content);
    elements.insightList.append(item);
  });
}

function inferPurpose(repo, extensions) {
  const description = repo.description?.trim();
  if (description) return description;
  const ext = (name) => extensions.has(name);
  if (ext("html") && (ext("css") || ext("js"))) return "The files suggest this may be a web project.";
  if (ext("py")) return "Python files suggest this may be a Python project or tool.";
  if (ext("go")) return "Go files suggest this may be a Go application or library.";
  if (ext("rs")) return "Rust files suggest this may be a Rust application or library.";
  if (ext("java") || ext("kt")) return "JVM source files suggest this may be a Java or Kotlin project.";
  if (ext("md") || ext("mdx")) return "The repository includes Markdown documentation; its purpose is not clear from metadata alone.";
  return "Not enough repository metadata to identify the project purpose. Review the README and source files for context.";
}

function findConnections(files) {
  const candidates = files.filter((file) => /\.(js|mjs|cjs|jsx|ts|tsx|py)$/.test(file.path)).slice(0, 14);
  const result = [];
  for (const file of candidates) {
    const source = state.cachedContents?.get(file.path);
    if (!source) continue;
    const matches = [...source.matchAll(/(?:from\s+|import\s*\(|require\s*\(|^\s*from\s+)(["'])(\.{1,2}\/[^"']+)\1/gm)].slice(0, 2);
    for (const match of matches) result.push(`${file.path} → ${match[2]}`);
    if (result.length >= 5) break;
  }
  return result;
}

async function populateConnectionSamples() {
  const loadId = state.loadId;
  const repository = state.repo;
  state.cachedContents = new Map();
  const files = state.files.filter((file) => /\.(js|mjs|cjs|jsx|ts|tsx|py)$/.test(file.path) && file.size <= 80_000).slice(0, 8);
  await Promise.all(files.map(async (file) => {
    try {
      const url = file.download_url || rawFileURL(file.path);
      const response = await fetch(url);
      if (response.ok && loadId === state.loadId) state.cachedContents.set(file.path, (await response.text()).slice(0, 80_000));
    } catch { /* Optional inference sample; the rest of the explorer remains available. */ }
  }));
  if (repository === state.repo && loadId === state.loadId) renderInsights();
}

function rawFileURL(path) {
  const owner = encodeURIComponent(state.repo.owner.login);
  const repo = encodeURIComponent(state.repo.name);
  const branch = state.repo.default_branch.split("/").map(encodeURIComponent).join("/");
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${encodedPath}`;
}

function applyFilter(filter) {
  state.activeFilter = filter;
  elements.filters.forEach((button) => {
    const selected = button.dataset.filter === filter;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
  renderTree();
}

elements.form.addEventListener("submit", analyzeRepository);
elements.fileSearch.addEventListener("input", renderTree);
elements.filters.forEach((button) => button.addEventListener("click", () => applyFilter(button.dataset.filter)));
elements.copy.addEventListener("click", copyCode);
elements.codeSearch.addEventListener("input", updateCodeSearch);
document.querySelector("#code-search-prev").addEventListener("click", () => moveCodeSearch(-1));
document.querySelector("#code-search-next").addEventListener("click", () => moveCodeSearch(1));
document.addEventListener("keydown", (event) => {
  if (event.key === "/" && !["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)) {
    event.preventDefault();
    elements.fileSearch.focus();
  }
  if (event.key === "Escape" && document.activeElement === elements.fileSearch) elements.fileSearch.value = "";
});

