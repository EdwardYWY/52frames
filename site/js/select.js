// Styled dropdowns layered on real <select> elements.
//
// The native <select> stays in the page (visually hidden) and remains the source of truth: the
// page reads .value / .selectedOptions and listens for "change" as usual, forms and autofill keep
// working, and if this script fails the native control is still there. The custom part is a
// button plus a listbox popup with the usual keyboard behaviour (arrows, Home/End, type to jump,
// Enter/Space to pick, Esc to close) and ARIA roles. <select multiple> becomes a checklist.
// On narrow screens the list opens as a bottom sheet, which is easier to use with a thumb.
// { header } puts a node of its own controls (e.g. chain pills) at the top of the list.
// { search: "Placeholder" } adds a search box there that narrows the list as you type.

let openOne = null;
let uid = 0;

function closeOpen() {
  openOne?.close();
}

document.addEventListener("pointerdown", (e) => {
  if (openOne && !openOne.root.contains(e.target)) closeOpen();
});
window.addEventListener("resize", () => openOne?.place());
// On phones the list is a bottom sheet with its own history entry, so the Back button closes it
// instead of leaving the page.
let inHistory = null; // the dropdown whose entry is on top of the history
window.addEventListener("popstate", () => {
  const owner = inHistory;
  inHistory = null;
  owner?.close(false);
});
window.addEventListener("scroll", (e) => {
  if (openOne && !openOne.list.contains(e.target)) openOne.place();
}, true);

/** Option text as searched: case, stars and punctuation don't matter. */
const searchable = (text) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

export function enhanceSelect(select, { summary, header, search } = {}) {
  const id = `cs${++uid}`;
  const root = document.createElement("span");
  root.className = `cselect${select.multiple ? " multi" : ""}`;
  select.parentNode.insertBefore(root, select);
  root.append(select);
  select.classList.add("cselect-native");
  select.tabIndex = -1;
  select.setAttribute("aria-hidden", "true");

  const button = document.createElement("button");
  button.type = "button";
  button.className = "cselect-button";
  button.setAttribute("aria-haspopup", "listbox");
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-controls", `${id}-list`);
  const labelText = select.closest("label")?.querySelector(".label")?.textContent?.trim();
  if (labelText) button.setAttribute("aria-label", labelText);
  const text = document.createElement("span");
  text.className = "cselect-text";
  button.append(text);
  root.append(button);

  const list = document.createElement("div");
  list.className = "cselect-list";
  list.id = `${id}-list`;
  list.setAttribute("role", "listbox");
  list.tabIndex = -1;
  if (select.multiple) list.setAttribute("aria-multiselectable", "true");
  if (labelText) list.setAttribute("aria-label", labelText);
  list.hidden = true;
  root.append(list);

  // The header and search box stay pinned at the top of the list while it scrolls.
  const top = document.createElement("div");
  top.className = "cselect-top";
  let input = null;
  if (search) {
    const box = document.createElement("span");
    box.className = "cselect-search";
    input = document.createElement("input");
    input.type = "search";
    input.placeholder = search;
    input.spellcheck = false;
    input.autocomplete = "off";
    input.setAttribute("enterkeyhint", "done");
    input.setAttribute("aria-label", search);
    input.setAttribute("aria-controls", list.id);
    box.append(input);
    top.append(box);
  }
  const noMatch = document.createElement("div");
  noMatch.className = "cselect-none";
  noMatch.hidden = true;

  let items = []; // [{ option, node }]
  let active = -1;
  let typed = "";
  let typedAt = 0;

  const enabledItems = () => items.filter((i) => !i.option.disabled && !i.node.hidden);

  function build() {
    items = [];
    // Keep the header and search box themselves: they hold their own state and listeners.
    for (const node of [...list.children]) if (node !== top) node.remove();
    if (header && header.parentNode !== top) top.prepend(header);
    if (top.children.length && top.parentNode !== list) list.prepend(top);
    const add = (option, parent) => {
      const node = document.createElement("div");
      node.className = "cselect-option";
      node.id = `${id}-o${items.length}`;
      node.setAttribute("role", "option");
      node.textContent = option.text;
      if (option.disabled) node.setAttribute("aria-disabled", "true");
      parent.append(node);
      items.push({ option, node });
    };
    for (const child of select.children) {
      if (child.tagName === "OPTGROUP") {
        const group = document.createElement("div");
        group.setAttribute("role", "group");
        group.setAttribute("aria-label", child.label);
        const head = document.createElement("div");
        head.className = "cselect-group";
        head.textContent = child.label;
        head.setAttribute("aria-hidden", "true");
        group.append(head);
        for (const option of child.children) add(option, group);
        list.append(group);
      } else if (child.tagName === "OPTION") add(child, list);
    }
    list.append(noMatch);
    narrow();
    mark();
  }

  /** Hide the options (and whole groups) that don't match the search box. A group's name matches all of it. */
  function narrow() {
    const query = input ? searchable(input.value) : "";
    let shown = 0;
    for (const { option, node } of items) {
      const group = option.parentNode.tagName === "OPTGROUP" ? searchable(option.parentNode.label) : "";
      node.hidden = Boolean(query) && !searchable(option.text).includes(query) && !group.includes(query);
      if (!node.hidden) shown++;
    }
    for (const group of list.querySelectorAll(":scope > [role=group]")) {
      group.hidden = ![...group.querySelectorAll(".cselect-option")].some((n) => !n.hidden);
    }
    noMatch.hidden = shown > 0;
    noMatch.textContent = `No match for “${input?.value.trim() || ""}”`;
    // Keep the highlight on something you can see.
    if (items[active]?.node.hidden) active = items.indexOf(enabledItems()[0] ?? null);
  }

  function mark() {
    items.forEach(({ option, node }, i) => {
      node.setAttribute("aria-selected", String(option.selected));
      node.classList.toggle("active", i === active);
    });
    const node = items[active]?.node;
    for (const owner of input ? [list, input] : [list]) {
      if (node) owner.setAttribute("aria-activedescendant", node.id);
      else owner.removeAttribute("aria-activedescendant");
    }
    node?.scrollIntoView({ block: "nearest" });
  }

  function sync() {
    const chosen = [...select.selectedOptions];
    text.textContent = summary ? summary(select, chosen) : chosen.map((o) => o.text).join(", ") || select.options[0]?.text || "";
    button.disabled = select.disabled;
    if (!list.hidden) {
      build();
    }
  }

  function place() {
    if (list.hidden) return;
    const sheet = window.matchMedia("(max-width: 560px)").matches;
    // Not "sheet": that's the movie view's class, and it would cover the whole screen.
    root.classList.toggle("is-sheet", sheet);
    if (sheet) {
      list.style.cssText = "";
      return;
    }
    const r = button.getBoundingClientRect();
    const below = window.innerHeight - r.bottom - 12;
    const above = r.top - 12;
    const up = below < 220 && above > below;
    list.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - Math.max(r.width, 220) - 8))}px`;
    list.style.minWidth = `${r.width}px`;
    list.style.maxHeight = `${Math.max(160, Math.min(360, up ? above : below))}px`;
    list.style.top = up ? "" : `${r.bottom + 4}px`;
    list.style.bottom = up ? `${window.innerHeight - r.top + 4}px` : "";
  }

  function open() {
    if (!list.hidden || select.disabled) return;
    closeOpen();
    openOne = api;
    if (input) input.value = "";
    build();
    list.hidden = false;
    root.classList.add("open");
    button.setAttribute("aria-expanded", "true");
    active = Math.max(0, items.findIndex((i) => i.option.selected));
    place();
    mark();
    // Phones: focusing the search box would bring up the keyboard over the list, so wait for a tap.
    if (input && !root.classList.contains("is-sheet")) input.focus({ preventScroll: true });
    else list.focus({ preventScroll: true });
    if (root.classList.contains("is-sheet")) {
      history.pushState(history.state, "");
      inHistory = api;
    }
  }

  function close(refocus = true) {
    if (list.hidden) return;
    list.hidden = true;
    root.classList.remove("open", "is-sheet");
    button.setAttribute("aria-expanded", "false");
    if (openOne === api) openOne = null;
    // Closed some other way than Back: drop the history entry it added.
    if (inHistory === api) {
      inHistory = null;
      history.back();
    }
    if (refocus) button.focus({ preventScroll: true });
  }

  function choose(index) {
    const item = items[index];
    if (!item || item.option.disabled) return;
    if (select.multiple) item.option.selected = !item.option.selected;
    else select.value = item.option.value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    sync();
    if (select.multiple) {
      active = index;
      mark();
    } else close();
  }

  function move(to) {
    const enabled = enabledItems();
    if (!enabled.length) return;
    const pos = enabled.indexOf(items[active]);
    const next = to === "first" ? 0 : to === "last" ? enabled.length - 1 : Math.max(0, Math.min(enabled.length - 1, (pos < 0 ? -1 : pos) + to));
    active = items.indexOf(enabled[next]);
    mark();
  }

  button.addEventListener("click", (e) => {
    e.preventDefault();
    list.hidden ? open() : close();
  });
  button.addEventListener("keydown", (e) => {
    if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
      e.preventDefault();
      open();
    }
  });
  // The dropdown usually sits inside a <label>: stop clicks here from also "activating" the label,
  // which would move focus to the hidden native <select>. Keep focus on the list while picking.
  list.addEventListener("mousedown", (e) => {
    if (e.target !== input) e.preventDefault();
  });
  input?.addEventListener("input", () => {
    narrow();
    mark();
  });
  input?.addEventListener("keydown", (e) => {
    const keys = { ArrowDown: 1, ArrowUp: -1, PageDown: 8, PageUp: -8 };
    if (e.key in keys) {
      e.preventDefault();
      move(keys[e.key]);
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(active);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      // First Esc clears the search, the next one closes.
      if (input.value) {
        input.value = "";
        narrow();
        mark();
      } else close();
    } else if (e.key === "Tab") close(false);
  });
  list.addEventListener("click", (e) => {
    e.preventDefault();
    const node = e.target.closest(".cselect-option");
    if (node) choose(items.findIndex((i) => i.node === node));
  });
  list.addEventListener("pointermove", (e) => {
    const node = e.target.closest(".cselect-option");
    const index = items.findIndex((i) => i.node === node);
    if (index >= 0 && index !== active) {
      active = index;
      items.forEach(({ node: n }, i) => n.classList.toggle("active", i === active));
    }
  });
  list.addEventListener("keydown", (e) => {
    if (top.contains(e.target)) return;
    const keys = { ArrowDown: 1, ArrowUp: -1, PageDown: 8, PageUp: -8, Home: "first", End: "last" };
    if (e.key in keys) {
      e.preventDefault();
      move(keys[e.key]);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      choose(active);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "Tab") {
      close(false);
    } else if (input && e.key.length === 1 && !e.metaKey && !e.ctrlKey) {
      // Typing goes to the search box.
      input.focus({ preventScroll: true });
    } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey) {
      // Type to jump to an option starting with the typed letters.
      typed = Date.now() - typedAt > 700 ? e.key.toLowerCase() : typed + e.key.toLowerCase();
      typedAt = Date.now();
      const hit = items.findIndex((i) => !i.option.disabled && i.option.text.toLowerCase().replace(/^[★\s]+/, "").startsWith(typed));
      if (hit >= 0) {
        active = hit;
        mark();
      }
    }
  });
  select.addEventListener("change", sync);
  // A tap on the label's text would otherwise focus the hidden native <select>, and phones then
  // open their own (rounded) picker instead of ours. Send it to our button instead.
  select.closest("label")?.addEventListener("click", (e) => {
    if (root.contains(e.target) && e.target !== select) return;
    e.preventDefault();
    if (!select.disabled) button.click();
  });

  const api = { root, list, sync, open, close, place };
  sync();
  return api;
}
