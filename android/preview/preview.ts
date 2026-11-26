interface DevicePreset {
  id: string;
  name: string;
  width: number;
  height: number;
  tier: "Compact" | "Medium" | "Expanded";
  defaultScale: number;
}

const PRESETS: DevicePreset[] = [
  { id: "small", name: "Small Phone", width: 360, height: 640, tier: "Compact", defaultScale: 0.9 },
  { id: "standard", name: "Standard Phone (Pixel)", width: 393, height: 851, tier: "Compact", defaultScale: 0.85 },
  { id: "large", name: "Large Phone (Ultra)", width: 412, height: 915, tier: "Compact", defaultScale: 0.8 },
  { id: "landscape", name: "Phone Landscape", width: 851, height: 393, tier: "Medium", defaultScale: 0.78 },
  { id: "foldable", name: "Foldable Unfolded", width: 673, height: 841, tier: "Medium", defaultScale: 0.78 },
  { id: "tablet", name: "Android Tablet", width: 840, height: 1180, tier: "Expanded", defaultScale: 0.65 },
];

let layoutMode: "grid" | "single" = "grid";
let singlePresetId = "standard";
let hardwareChrome = true;
let theme: "dark" | "light" = "dark";
let ccEnabled = true;
let dockCollapsed = false;

const barEl = document.getElementById("lab-bar")!;
const stageEl = document.getElementById("lab-stage")!;

function broadcast(message: Record<string, unknown>): void {
  const origin = window.location.origin;
  stageEl.querySelectorAll<HTMLIFrameElement>("iframe").forEach((frame) => {
    frame.contentWindow?.postMessage(message, origin);
  });
}

function syncFrameState(target: Window): void {
  const origin = window.location.origin;
  target.postMessage(
    {
      type: "preview:set-insets",
      top: hardwareChrome ? 28 : 0,
      bottom: hardwareChrome ? 18 : 0,
    },
    origin,
  );
  target.postMessage({ type: "preview:set-theme", theme }, origin);
  target.postMessage({ type: "preview:toggle-cc", enabled: ccEnabled }, origin);
  target.postMessage({ type: "preview:toggle-dock", collapsed: dockCollapsed }, origin);
}

window.addEventListener("message", (ev) => {
  if (ev.origin !== window.location.origin) return;
  const data = ev.data as { type?: string } | null;
  if (data?.type === "preview:ready" && ev.source && "postMessage" in ev.source) {
    syncFrameState(ev.source as Window);
  }
});

function renderBar(): void {
  barEl.innerHTML = `
    <div class="lab-title">
      <span>BookReader Android UI Lab</span>
      <span class="lab-badge">Real App + Live CC Sim</span>
    </div>

    <div class="lab-group">
      <button class="lab-btn ${layoutMode === "grid" ? "active" : ""}" id="btn-mode-grid">Compare All Sizes</button>
      <button class="lab-btn ${layoutMode === "single" ? "active" : ""}" id="btn-mode-single">Single Device</button>
      ${
        layoutMode === "single"
          ? PRESETS.map(
              (p) =>
                `<button class="lab-btn ${singlePresetId === p.id ? "active" : ""}" data-preset="${p.id}">${p.name} (${p.width}×${p.height})</button>`,
            ).join("")
          : ""
      }
    </div>

    <div class="lab-group">
      <button class="lab-btn ${hardwareChrome ? "active" : ""}" id="btn-hw">Notch &amp; Gesture Bar</button>
      <button class="lab-btn" id="btn-theme">Theme: ${theme === "dark" ? "Dark" : "Light"}</button>
      <button class="lab-btn" id="btn-play">Play / Pause CC</button>
      <button class="lab-btn ${ccEnabled ? "active" : ""}" id="btn-cc">CC: ${ccEnabled ? "On" : "Off"}</button>
      <button class="lab-btn ${dockCollapsed ? "active" : ""}" id="btn-dock">Dock: ${dockCollapsed ? "Pill" : "Full"}</button>
    </div>

    <div class="lab-group">
      <button class="lab-btn" data-jump="reader">Reader</button>
      <button class="lab-btn" data-jump="quick">Quick Aa</button>
      <button class="lab-btn" data-jump="drawer">Drawer</button>
      <button class="lab-btn" data-jump="voices">Voices</button>
      <button class="lab-btn" data-jump="settings">Settings</button>
      <button class="lab-btn" data-jump="library">Library</button>
      <button class="lab-btn" data-jump="toc">Chapters</button>
      <button class="lab-btn" data-jump="pronunciation">Rules</button>
      <button class="lab-btn" data-jump="export">Export</button>
    </div>
  `;

  barEl.querySelector("#btn-mode-grid")?.addEventListener("click", () => {
    layoutMode = "grid";
    renderAll();
  });
  barEl.querySelector("#btn-mode-single")?.addEventListener("click", () => {
    layoutMode = "single";
    renderAll();
  });
  barEl.querySelectorAll<HTMLButtonElement>("[data-preset]").forEach((btn) => {
    btn.addEventListener("click", () => {
      singlePresetId = btn.dataset.preset!;
      renderAll();
    });
  });

  barEl.querySelector("#btn-hw")?.addEventListener("click", () => {
    hardwareChrome = !hardwareChrome;
    syncHwOverlays();
    broadcast({
      type: "preview:set-insets",
      top: hardwareChrome ? 28 : 0,
      bottom: hardwareChrome ? 18 : 0,
    });
    renderBar();
  });

  barEl.querySelector("#btn-theme")?.addEventListener("click", () => {
    theme = theme === "dark" ? "light" : "dark";
    broadcast({ type: "preview:set-theme", theme });
    renderBar();
  });

  barEl.querySelector("#btn-play")?.addEventListener("click", () => {
    broadcast({ type: "preview:toggle-play" });
  });

  barEl.querySelector("#btn-cc")?.addEventListener("click", () => {
    ccEnabled = !ccEnabled;
    broadcast({ type: "preview:toggle-cc", enabled: ccEnabled });
    renderBar();
  });

  barEl.querySelector("#btn-dock")?.addEventListener("click", () => {
    dockCollapsed = !dockCollapsed;
    broadcast({ type: "preview:toggle-dock", collapsed: dockCollapsed });
    renderBar();
  });

  barEl.querySelectorAll<HTMLButtonElement>("[data-jump]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.jump!;
      if (target === "reader") {
        broadcast({ type: "preview:open-modal", modal: null });
      } else if (target === "quick") {
        broadcast({ type: "preview:open-quick-sheet", open: true });
      } else if (target === "drawer") {
        broadcast({ type: "preview:open-drawer", open: true });
      } else {
        broadcast({ type: "preview:open-modal", modal: target });
      }
    });
  });
}

function syncHwOverlays(): void {
  stageEl.querySelectorAll<HTMLElement>(".hw-overlay").forEach((el) => {
    el.classList.toggle("hidden-hw", !hardwareChrome);
  });
}

function renderStage(): void {
  const visiblePresets =
    layoutMode === "grid"
      ? PRESETS
      : PRESETS.filter((p) => p.id === singlePresetId);

  stageEl.innerHTML = visiblePresets
    .map((p) => {
      const scale = layoutMode === "single" ? Math.min(1, 780 / Math.max(p.width, p.height)) : p.defaultScale;
      const boxW = Math.round(p.width * scale);
      const boxH = Math.round(p.height * scale);
      return `
        <div class="device-card">
          <div class="device-meta">
            <strong>${p.name}</strong>
            <span>${p.width}×${p.height} dp</span>
            <span class="device-tier">${p.tier}</span>
          </div>
          <div class="device-bezel">
            <div class="device-screen" style="width:${boxW}px;height:${boxH}px;">
              <iframe
                src="/?preview=android"
                title="${p.name}"
                style="width:${p.width}px;height:${p.height}px;transform:scale(${scale});transform-origin:top left;"
              ></iframe>
              <div class="sim-status-time hw-overlay ${hardwareChrome ? "" : "hidden-hw"}">10:05</div>
              <div class="sim-notch hw-overlay ${hardwareChrome ? "" : "hidden-hw"}"></div>
              <div class="sim-gesture-pill hw-overlay ${hardwareChrome ? "" : "hidden-hw"}"></div>
            </div>
          </div>
        </div>
      `;
    })
    .join("");
}

function renderAll(): void {
  renderBar();
  renderStage();
}

renderAll();
