import { tr } from "../i18n";
import { invoke, openDialog, saveDialog } from "../tauri_bridge";
import { Icons } from "../icons";
import { state } from "../state";
import type { AppBootstrap, IgnoreRule, PronunciationRule } from "../types";
import { escapeAttr, escapeHtml } from "./sidebar";

export type RulesModalMode = "pronunciation" | "ignore";

export interface RulesModalHandlers {
  onClose: () => void;
  onUpdated: () => void;
  onToast: (msg: string) => void;
}

let searchFilter = "";
let selectedIds = new Set<string>();
let editingId: string | null = null;
let draftSource = "";
let draftReplace = "";
let draftMatchCase = false;
let draftIgnoreBoundary = false;
let draftIsRegex = false;
let validationError = "";

export function resetRulesModalDraft(): void {
  searchFilter = "";
  selectedIds.clear();
  editingId = null;
  draftSource = "";
  draftReplace = "";
  draftMatchCase = false;
  draftIgnoreBoundary = false;
  draftIsRegex = false;
  validationError = "";
}

export function renderRulesModal(
  container: HTMLElement,
  mode: RulesModalMode,
  handlers: RulesModalHandlers,
): void {
  const isPron = mode === "pronunciation";
  const title = isPron ? tr("rules_pronunciation_title") : tr("rules_ignore_title");
  const q = searchFilter.trim().toLowerCase();

  const rows = isPron
    ? state.pronunciations.filter(
        (r) =>
          !q ||
          r.source.toLowerCase().includes(q) ||
          r.replace.toLowerCase().includes(q),
      )
    : state.ignoreRules.filter((r) => !q || r.pattern.toLowerCase().includes(q));

  container.innerHTML = `
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal-card mobile-page" role="dialog" aria-label="${escapeAttr(title)}">
        <div class="modal-header">
          <button class="btn-secondary" style="padding:4px 9px;" id="btn-rules-back">
            ${Icons.chevronLeft()}
            <span>${escapeHtml(tr("common_back"))}</span>
          </button>
          <span class="modal-title">${escapeHtml(title)}</span>
          <button class="icon-btn" id="btn-rules-close" title="${escapeAttr(tr("common_close"))}">${Icons.close()}</button>
        </div>

        <div class="modal-body">
          <div class="rules-toolbar">
            <input type="text" id="rules-search" placeholder="${escapeAttr(isPron ? tr("rules_search_pron") : tr("rules_search_ignore"))}" value="${escapeAttr(searchFilter)}" />
            <button class="icon-btn" id="btn-rules-import" title="${escapeAttr(tr("rules_import_json"))}">${Icons.downloadTray()}</button>
            <button class="icon-btn" id="btn-rules-export" title="${escapeAttr(tr("rules_export_json"))}">${Icons.uploadTray()}</button>
            <button class="icon-btn" id="btn-rules-delete" title="${escapeAttr(tr("rules_delete_selected"))}" ${selectedIds.size === 0 ? "disabled" : ""}>${Icons.trash()}</button>
          </div>

          <div class="rules-list">
            ${
              rows.length === 0
                ? `<div style="padding:28px;text-align:center;color:var(--text-muted);font-size:13px;">
                     ${escapeHtml(isPron ? tr("rules_empty_pron") : tr("rules_empty_ignore"))}
                   </div>`
                : rows
                    .map((r) => {
                      const checked = selectedIds.has(r.id) ? "checked" : "";
                      const flags = [
                        r.match_case ? tr("rules_flag_case") : "",
                        r.ignore_word_boundary ? tr("rules_flag_boundary") : "",
                        r.is_regex ? tr("rules_flag_regex") : "",
                      ]
                        .filter(Boolean)
                        .map((f) => `<span class="flag-tag">${escapeHtml(f)}</span>`)
                        .join("");

                      if (isPron) {
                        const pr = r as PronunciationRule;
                        return `
                          <div class="rule-row${editingId === pr.id ? " editing" : ""}" data-edit-id="${pr.id}">
                            <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(pr.source)}</span>
                            <span style="color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(pr.replace)}</span>
                            <div class="rule-flags">${flags}</div>
                            <input type="checkbox" class="rule-select" data-rid="${pr.id}" title="${escapeAttr(tr("rules_select_delete_tooltip"))}" aria-label="${escapeAttr(tr("rules_select_delete_aria"))}" ${checked} />
                          </div>
                        `;
                      } else {
                        const ig = r as IgnoreRule;
                        return `
                          <div class="rule-row ignore-mode${editingId === ig.id ? " editing" : ""}" data-edit-id="${ig.id}">
                            <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(ig.pattern)}</span>
                            <div class="rule-flags">${flags}</div>
                            <input type="checkbox" class="rule-select" data-rid="${ig.id}" title="${escapeAttr(tr("rules_select_delete_tooltip"))}" aria-label="${escapeAttr(tr("rules_select_delete_aria"))}" ${checked} />
                          </div>
                        `;
                      }
                    })
                    .join("")
            }
          </div>
        </div>

        <div class="modal-footer">
          <div class="rule-input-row">
            <input type="text" id="draft-source" placeholder="${escapeAttr(isPron ? tr("rules_source_placeholder") : tr("rules_ignore_placeholder"))}" value="${escapeAttr(draftSource)}" />
            ${
              isPron
                ? `
              <div class="replace-wrap">
                <input type="text" id="draft-replace" placeholder="${escapeAttr(tr("rules_replace_placeholder"))}" value="${escapeAttr(draftReplace)}" />
                <button class="inline-play-btn" id="btn-preview-pron" title="${escapeAttr(tr("rules_preview_tooltip"))}">${Icons.play(11)}</button>
              </div>
            `
                : ""
            }
            <button class="btn-primary" id="btn-save-rule">${escapeHtml(editingId ? tr("rules_btn_update") : tr("rules_btn_add"))}</button>
            ${editingId ? `<button class="btn-secondary" id="btn-cancel-edit">${escapeHtml(tr("common_cancel"))}</button>` : ""}
          </div>

          <div class="checkbox-row">
            <label class="checkbox-label">
              <input type="checkbox" id="chk-match-case" ${draftMatchCase ? "checked" : ""} />
              <span>${escapeHtml(tr("rules_match_case"))}</span>
            </label>
            <label class="checkbox-label">
              <input type="checkbox" id="chk-ignore-boundary" ${draftIgnoreBoundary ? "checked" : ""} />
              <span>${escapeHtml(tr("rules_ignore_boundary"))}</span>
            </label>
            <label class="checkbox-label">
              <input type="checkbox" id="chk-is-regex" ${draftIsRegex ? "checked" : ""} />
              <span>${escapeHtml(tr("rules_use_regex"))}</span>
            </label>
          </div>
          <div class="rules-hint">${escapeHtml(
            editingId ? tr("rules_hint_editing") : tr("rules_hint_default"),
          )}</div>
          ${validationError ? `<div class="error-text">${escapeHtml(validationError)}</div>` : ""}
        </div>
      </div>
    </div>
  `;

  container.querySelector("#modal-backdrop")?.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) handlers.onClose();
  });
  container.querySelector("#btn-rules-back")?.addEventListener("click", handlers.onClose);
  container.querySelector("#btn-rules-close")?.addEventListener("click", handlers.onClose);

  container.querySelector<HTMLInputElement>("#rules-search")?.addEventListener("input", (e) => {
    searchFilter = (e.target as HTMLInputElement).value;
    renderRulesModal(container, mode, handlers);
    const sInput = container.querySelector<HTMLInputElement>("#rules-search");
    if (sInput) {
      sInput.focus();
      sInput.setSelectionRange(sInput.value.length, sInput.value.length);
    }
  });

  container.querySelectorAll<HTMLInputElement>(".rule-select").forEach((chk) => {
    chk.addEventListener("click", (e) => e.stopPropagation());
    chk.addEventListener("change", () => {
      const id = chk.dataset.rid!;
      if (chk.checked) selectedIds.add(id);
      else selectedIds.delete(id);
      const delBtn = container.querySelector<HTMLButtonElement>("#btn-rules-delete");
      if (delBtn) delBtn.disabled = selectedIds.size === 0;
    });
  });

  container.querySelectorAll<HTMLElement>("[data-edit-id]").forEach((row) => {
    row.addEventListener("click", () => {
      const id = row.dataset.editId!;
      if (isPron) {
        const found = state.pronunciations.find((r) => r.id === id);
        if (!found) return;
        editingId = found.id;
        draftSource = found.source;
        draftReplace = found.replace;
        draftMatchCase = found.match_case;
        draftIgnoreBoundary = found.ignore_word_boundary;
        draftIsRegex = found.is_regex;
      } else {
        const found = state.ignoreRules.find((r) => r.id === id);
        if (!found) return;
        editingId = found.id;
        draftSource = found.pattern;
        draftMatchCase = found.match_case;
        draftIgnoreBoundary = found.ignore_word_boundary;
        draftIsRegex = found.is_regex;
      }
      validationError = "";
      renderRulesModal(container, mode, handlers);
    });
  });

  container.querySelector("#btn-cancel-edit")?.addEventListener("click", () => {
    editingId = null;
    draftSource = "";
    draftReplace = "";
    validationError = "";
    renderRulesModal(container, mode, handlers);
  });

  container.querySelector<HTMLInputElement>("#draft-source")?.addEventListener("input", (e) => {
    draftSource = (e.target as HTMLInputElement).value;
  });
  container.querySelector<HTMLInputElement>("#draft-replace")?.addEventListener("input", (e) => {
    draftReplace = (e.target as HTMLInputElement).value;
  });
  container.querySelector<HTMLInputElement>("#chk-match-case")?.addEventListener("change", (e) => {
    draftMatchCase = (e.target as HTMLInputElement).checked;
  });
  container
    .querySelector<HTMLInputElement>("#chk-ignore-boundary")
    ?.addEventListener("change", (e) => {
      draftIgnoreBoundary = (e.target as HTMLInputElement).checked;
    });
  container.querySelector<HTMLInputElement>("#chk-is-regex")?.addEventListener("change", (e) => {
    draftIsRegex = (e.target as HTMLInputElement).checked;
  });

  container.querySelector("#btn-preview-pron")?.addEventListener("click", async () => {
    const sample = draftReplace.trim() || draftSource.trim();
    if (!sample) return;
    try {
      await invoke("tts_preview_text", { text: sample, voiceId: null });
    } catch (err) {
      handlers.onToast(tr("voices_toast_preview_err", { error: String(err) }));
    }
  });

  const saveRule = async () => {
    const pat = draftSource.trim();
    if (!pat) {
      validationError = isPron ? tr("rules_err_empty_pron") : tr("rules_err_empty_ignore");
      renderRulesModal(container, mode, handlers);
      return;
    }
    try {
      await invoke("validate_rule_regex", {
        pattern: pat,
        matchCase: draftMatchCase,
        ignoreWordBoundary: draftIgnoreBoundary,
        isRegex: draftIsRegex,
      });
    } catch (err) {
      validationError = String(err);
      renderRulesModal(container, mode, handlers);
      return;
    }

    if (isPron) {
      const nextRule: PronunciationRule = {
        id: editingId ?? crypto.randomUUID(),
        source: pat,
        replace: draftReplace,
        match_case: draftMatchCase,
        ignore_word_boundary: draftIgnoreBoundary,
        is_regex: draftIsRegex,
        enabled: true,
      };
      const updated = editingId
        ? state.pronunciations.map((r) => (r.id === editingId ? nextRule : r))
        : [...state.pronunciations, nextRule];
      state.pronunciations = await invoke<PronunciationRule[]>("save_pronunciation_rules", {
        rules: updated,
      });
    } else {
      const nextRule: IgnoreRule = {
        id: editingId ?? crypto.randomUUID(),
        pattern: pat,
        match_case: draftMatchCase,
        ignore_word_boundary: draftIgnoreBoundary,
        is_regex: draftIsRegex,
        enabled: true,
      };
      const updated = editingId
        ? state.ignoreRules.map((r) => (r.id === editingId ? nextRule : r))
        : [...state.ignoreRules, nextRule];
      state.ignoreRules = await invoke<IgnoreRule[]>("save_ignore_rules", {
        rules: updated,
      });
    }

    const wasEditing = editingId !== null;
    editingId = null;
    draftSource = "";
    draftReplace = "";
    validationError = "";
    handlers.onUpdated();
    renderRulesModal(container, mode, handlers);
    handlers.onToast(wasEditing ? tr("rules_toast_updated") : tr("rules_toast_added"));
  };

  container.querySelector("#btn-save-rule")?.addEventListener("click", () => {
    void saveRule();
  });

  const handleDraftEnter = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void saveRule();
    }
  };
  container.querySelector<HTMLInputElement>("#draft-source")?.addEventListener("keydown", handleDraftEnter);
  container.querySelector<HTMLInputElement>("#draft-replace")?.addEventListener("keydown", handleDraftEnter);

  container.querySelector("#btn-rules-delete")?.addEventListener("click", async () => {
    if (selectedIds.size === 0) return;
    if (isPron) {
      const filtered = state.pronunciations.filter((r) => !selectedIds.has(r.id));
      state.pronunciations = await invoke<PronunciationRule[]>("save_pronunciation_rules", {
        rules: filtered,
      });
    } else {
      const filtered = state.ignoreRules.filter((r) => !selectedIds.has(r.id));
      state.ignoreRules = await invoke<IgnoreRule[]>("save_ignore_rules", {
        rules: filtered,
      });
    }
    selectedIds.clear();
    handlers.onUpdated();
    renderRulesModal(container, mode, handlers);
  });

  container.querySelector("#btn-rules-export")?.addEventListener("click", async () => {
    try {
      const target = await saveDialog({
        defaultPath: isPron ? "bookreader-pronunciations.json" : "bookreader-ignore-rules.json",
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!target) return;
      await invoke("export_rules_json", { kind: mode, path: target });
      handlers.onToast(tr("rules_toast_exported"));
    } catch (err) {
      handlers.onToast(tr("toast_export_error", { error: String(err) }));
    }
  });

  container.querySelector("#btn-rules-import")?.addEventListener("click", async () => {
    try {
      const picked = await openDialog({
        multiple: false,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!picked || typeof picked !== "string") return;
      const count = await invoke<number>("import_rules_json", {
        kind: mode,
        path: picked,
      });
      const boot = await invoke<AppBootstrap>("get_bootstrap");
      state.pronunciations = boot.pronunciations;
      state.ignoreRules = boot.ignore_rules;
      handlers.onUpdated();
      renderRulesModal(container, mode, handlers);
      const noun = count === 1 ? tr("rules_rule_singular") : tr("rules_rule_plural");
      handlers.onToast(tr("rules_toast_imported", { count, noun }));
    } catch (err) {
      handlers.onToast(tr("toast_import_failed", { error: String(err) }));
    }
  });
}
