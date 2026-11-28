//! Desktop window placement persistence and multi-monitor recovery safeguards.

use crate::models::WindowState;
#[cfg(not(target_os = "android"))]
use crate::storage::Storage;
#[cfg(not(target_os = "android"))]
use std::sync::{Arc, Condvar, Mutex};
#[cfg(not(target_os = "android"))]
use std::time::{Duration, Instant};
#[cfg(not(target_os = "android"))]
use tauri::{Monitor, PhysicalPosition, PhysicalSize, Position, Size, WebviewWindow, WindowEvent};

const DEFAULT_LOGICAL_WIDTH: f64 = 1280.0;
const DEFAULT_LOGICAL_HEIGHT: f64 = 820.0;
const MIN_LOGICAL_WIDTH: f64 = 900.0;
const MIN_LOGICAL_HEIGHT: f64 = 600.0;
const MIN_VISIBLE_OVERLAP_W_LOGICAL: f64 = 120.0;
const MIN_VISIBLE_OVERLAP_H_LOGICAL: f64 = 80.0;
const EST_CHROME_W_LOGICAL: f64 = 16.0;
const EST_CHROME_H_LOGICAL: f64 = 40.0;
const DWM_BORDER_SLOP_LOGICAL: f64 = if cfg!(target_os = "windows") {
    10.0
} else {
    0.0
};
const BOGUS_POS_THRESHOLD: i32 = -30_000;
const MIN_VALID_CLIENT_DIM: u32 = 200;
const SAVE_DEBOUNCE_MS: u64 = 350;
const STARTUP_SETTLE_MS: u64 = 300;

/// Integer axis-aligned screen rectangle in physical desktop coordinates.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

impl Rect {
    pub fn right(self) -> i64 {
        i64::from(self.x) + i64::from(self.width)
    }

    pub fn bottom(self) -> i64 {
        i64::from(self.y) + i64::from(self.height)
    }

    pub fn area(self) -> u64 {
        let p = u128::from(self.width) * u128::from(self.height);
        u64::try_from(p).unwrap_or(u64::MAX)
    }

    pub fn intersection_dims(self, other: Rect) -> (i64, i64) {
        let left = i64::from(self.x).max(i64::from(other.x));
        let top = i64::from(self.y).max(i64::from(other.y));
        let right = self.right().min(other.right());
        let bottom = self.bottom().min(other.bottom());
        ((right - left).max(0), (bottom - top).max(0))
    }

    pub fn intersection_area(self, other: Rect) -> u64 {
        let (w, h) = self.intersection_dims(other);
        let p = (w as u128) * (h as u128);
        u64::try_from(p).unwrap_or(u64::MAX)
    }
}

/// Snapshot of an attached OS display monitor in physical coordinates.
#[derive(Clone, Debug)]
pub struct MonitorInfo {
    pub work_area: Rect,
    pub scale_factor: f64,
    pub is_primary: bool,
}

/// Clamped, monitor-safe startup placement for the main window.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ResolvedPlacement {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub maximized: bool,
    pub relocated: bool,
}

fn sanitize_scale(scale: f64) -> f64 {
    if scale.is_finite() && (0.25..=8.0).contains(&scale) {
        scale
    } else {
        1.0
    }
}

fn clamp_i64_to_i32(value: i64) -> i32 {
    value.clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32
}

fn clamp_f64_u32(value: f64) -> u32 {
    if !value.is_finite() || value <= 0.0 {
        return 0;
    }
    value.round().clamp(0.0, f64::from(u32::MAX)) as u32
}

fn primary_or_first(monitors: &[MonitorInfo]) -> &MonitorInfo {
    monitors
        .iter()
        .find(|m| m.is_primary)
        .unwrap_or(&monitors[0])
}

fn visible_overlap_thresholds(work: Rect, scale: f64) -> (i64, i64) {
    let min_w = i64::from(clamp_f64_u32(MIN_VISIBLE_OVERLAP_W_LOGICAL * scale))
        .min(i64::from(work.width));
    let min_h = i64::from(clamp_f64_u32(MIN_VISIBLE_OVERLAP_H_LOGICAL * scale))
        .min(i64::from(work.height));
    (min_w, min_h)
}

fn clamp_inner_and_outer_size(
    work: Rect,
    raw_w: u32,
    raw_h: u32,
    scale: f64,
) -> (u32, u32, u32, u32) {
    let chrome_w = clamp_f64_u32(EST_CHROME_W_LOGICAL * scale);
    let chrome_h = clamp_f64_u32(EST_CHROME_H_LOGICAL * scale);
    let max_inner_w = work.width.saturating_sub(chrome_w).max(1);
    let max_inner_h = work.height.saturating_sub(chrome_h).max(1);
    let min_inner_w = clamp_f64_u32(MIN_LOGICAL_WIDTH * scale).min(max_inner_w);
    let min_inner_h = clamp_f64_u32(MIN_LOGICAL_HEIGHT * scale).min(max_inner_h);

    let width = raw_w.clamp(min_inner_w, max_inner_w);
    let height = raw_h.clamp(min_inner_h, max_inner_h);
    let est_outer_w = width.saturating_add(chrome_w).min(work.width);
    let est_outer_h = height.saturating_add(chrome_h).min(work.height);
    (width, height, est_outer_w, est_outer_h)
}

fn center_origin(work: Rect, outer_w: u32, outer_h: u32) -> (i32, i32) {
    let free_w = (i64::from(work.width) - i64::from(outer_w)).max(0);
    let free_h = (i64::from(work.height) - i64::from(outer_h)).max(0);
    let x = clamp_i64_to_i32(i64::from(work.x) + free_w / 2);
    let y = clamp_i64_to_i32(i64::from(work.y) + free_h / 2);
    (x, y)
}

/// Computes centered initial window placement when no prior state exists on disk.
pub fn resolve_initial_placement(monitors: &[MonitorInfo]) -> Option<ResolvedPlacement> {
    if monitors.is_empty() {
        return None;
    }
    let target = primary_or_first(monitors);
    let scale = sanitize_scale(target.scale_factor);
    let raw_w = clamp_f64_u32(DEFAULT_LOGICAL_WIDTH * scale);
    let raw_h = clamp_f64_u32(DEFAULT_LOGICAL_HEIGHT * scale);
    let (width, height, est_outer_w, est_outer_h) =
        clamp_inner_and_outer_size(target.work_area, raw_w, raw_h, scale);
    let (x, y) = center_origin(target.work_area, est_outer_w, est_outer_h);

    Some(ResolvedPlacement {
        x,
        y,
        width,
        height,
        maximized: false,
        relocated: false,
    })
}

/// Resolves a saved [`WindowState`] against currently attached monitors, relocating onto
/// active screen real estate whenever the previous monitor was disconnected or off-screen.
pub fn resolve_window_placement(
    saved: &WindowState,
    monitors: &[MonitorInfo],
) -> Option<ResolvedPlacement> {
    if monitors.is_empty() {
        return None;
    }

    let saved_scale = sanitize_scale(saved.scale_factor);
    let mut raw_w = if saved.width == 0 {
        clamp_f64_u32(DEFAULT_LOGICAL_WIDTH * saved_scale)
    } else {
        saved.width
    };
    let mut raw_h = if saved.height == 0 {
        clamp_f64_u32(DEFAULT_LOGICAL_HEIGHT * saved_scale)
    } else {
        saved.height
    };

    let bogus_pos = saved.x <= BOGUS_POS_THRESHOLD || saved.y <= BOGUS_POS_THRESHOLD;
    let saved_chrome_w = clamp_f64_u32(EST_CHROME_W_LOGICAL * saved_scale);
    let saved_chrome_h = clamp_f64_u32(EST_CHROME_H_LOGICAL * saved_scale);
    let saved_rect = Rect {
        x: saved.x,
        y: saved.y,
        width: raw_w.saturating_add(saved_chrome_w),
        height: raw_h.saturating_add(saved_chrome_h),
    };

    let (target, relocated) = match (
        saved.maximized,
        saved.monitor_x,
        saved.monitor_y,
        saved.monitor_width,
        saved.monitor_height,
    ) {
        (true, Some(mx), Some(my), Some(mw), Some(mh)) if mw > 0 && mh > 0 => {
            let saved_mon = Rect {
                x: mx,
                y: my,
                width: mw,
                height: mh,
            };
            let best = monitors
                .iter()
                .map(|m| (m, m.work_area.intersection_area(saved_mon)))
                .max_by_key(|(m, area)| (*area, m.is_primary));
            if let Some((m, area)) = best {
                let min_area = saved_mon.area().min(m.work_area.area());
                if min_area > 0 && u128::from(area) * 4 >= u128::from(min_area) {
                    (m, false)
                } else {
                    (primary_or_first(monitors), true)
                }
            } else {
                (primary_or_first(monitors), true)
            }
        }
        _ if !bogus_pos => {
            let best = monitors
                .iter()
                .filter_map(|m| {
                    let (ov_w, ov_h) = saved_rect.intersection_dims(m.work_area);
                    if ov_w > 0 && ov_h > 0 {
                        Some((m, ov_w, ov_h, (ov_w as u128) * (ov_h as u128)))
                    } else {
                        None
                    }
                })
                .max_by_key(|(m, _, _, area)| (*area, m.is_primary));

            if let Some((m, ov_w, ov_h, _)) = best {
                let (min_ov_w, min_ov_h) =
                    visible_overlap_thresholds(m.work_area, sanitize_scale(m.scale_factor));
                if ov_w >= min_ov_w && ov_h >= min_ov_h {
                    (m, false)
                } else {
                    (primary_or_first(monitors), true)
                }
            } else {
                (primary_or_first(monitors), true)
            }
        }
        _ => (primary_or_first(monitors), true),
    };

    let target_scale = sanitize_scale(target.scale_factor);
    if relocated && (target_scale - saved_scale).abs() > 0.05 {
        let ratio = target_scale / saved_scale;
        raw_w = clamp_f64_u32(f64::from(raw_w) * ratio);
        raw_h = clamp_f64_u32(f64::from(raw_h) * ratio);
    }

    let work = target.work_area;
    let (width, height, est_outer_w, est_outer_h) =
        clamp_inner_and_outer_size(work, raw_w, raw_h, target_scale);

    let (min_ov_w, min_ov_h) = visible_overlap_thresholds(work, target_scale);
    let (target_ov_w, target_ov_h) = saved_rect.intersection_dims(work);
    let normal_rect_fits_target = !bogus_pos && target_ov_w >= min_ov_w && target_ov_h >= min_ov_h;

    let (x, y) = if relocated || bogus_pos || (saved.maximized && !normal_rect_fits_target) {
        center_origin(work, est_outer_w, est_outer_h)
    } else {
        let slop = i64::from(clamp_f64_u32(DWM_BORDER_SLOP_LOGICAL * target_scale));
        let min_x = i64::from(work.x) - slop;
        let max_x = (work.right() - i64::from(est_outer_w) + slop).max(min_x);
        let min_y = i64::from(work.y);
        let max_y = (work.bottom() - i64::from(est_outer_h)).max(min_y);
        (
            clamp_i64_to_i32(i64::from(saved.x).clamp(min_x, max_x)),
            clamp_i64_to_i32(i64::from(saved.y).clamp(min_y, max_y)),
        )
    };

    Some(ResolvedPlacement {
        x,
        y,
        width,
        height,
        maximized: saved.maximized,
        relocated,
    })
}

#[cfg(not(target_os = "android"))]
fn same_monitor(a: &Monitor, b: &Monitor) -> bool {
    a.position() == b.position() && a.size() == b.size() && a.name() == b.name()
}

#[cfg(not(target_os = "android"))]
fn collect_monitors(window: &WebviewWindow) -> Vec<MonitorInfo> {
    let primary = window.primary_monitor().ok().flatten();
    let avail = window.available_monitors().unwrap_or_default();

    avail
        .into_iter()
        .map(|m| {
            let wa = m.work_area();
            let is_primary = primary.as_ref().is_some_and(|p| same_monitor(&m, p));
            MonitorInfo {
                work_area: Rect {
                    x: wa.position.x,
                    y: wa.position.y,
                    width: wa.size.width,
                    height: wa.size.height,
                },
                scale_factor: m.scale_factor(),
                is_primary,
            }
        })
        .collect()
}

#[cfg(not(target_os = "android"))]
fn capture_live_state(window: &WebviewWindow, prev: Option<&WindowState>) -> Option<WindowState> {
    if window.is_minimized().unwrap_or(false) {
        return None;
    }

    let mon_wa = window
        .current_monitor()
        .ok()
        .flatten()
        .map(|m| *m.work_area());

    if window.is_maximized().unwrap_or(false) {
        let mut base = prev.cloned().unwrap_or_else(|| {
            let scale = sanitize_scale(window.scale_factor().unwrap_or(1.0));
            WindowState {
                width: clamp_f64_u32(DEFAULT_LOGICAL_WIDTH * scale),
                height: clamp_f64_u32(DEFAULT_LOGICAL_HEIGHT * scale),
                scale_factor: scale,
                ..WindowState::default()
            }
        });
        base.maximized = true;
        if let Some(wa) = mon_wa {
            base.monitor_x = Some(wa.position.x);
            base.monitor_y = Some(wa.position.y);
            base.monitor_width = Some(wa.size.width);
            base.monitor_height = Some(wa.size.height);
        }
        return Some(base);
    }

    let pos = window.outer_position().ok()?;
    let size = window.inner_size().ok()?;
    if pos.x <= BOGUS_POS_THRESHOLD
        || pos.y <= BOGUS_POS_THRESHOLD
        || size.width < MIN_VALID_CLIENT_DIM
        || size.height < MIN_VALID_CLIENT_DIM
    {
        return None;
    }

    Some(WindowState {
        x: pos.x,
        y: pos.y,
        width: size.width,
        height: size.height,
        maximized: false,
        scale_factor: sanitize_scale(window.scale_factor().unwrap_or(1.0)),
        monitor_x: mon_wa.map(|r| r.position.x),
        monitor_y: mon_wa.map(|r| r.position.y),
        monitor_width: mon_wa.map(|r| r.size.width),
        monitor_height: mon_wa.map(|r| r.size.height),
    })
}

#[cfg(not(target_os = "android"))]
struct DebounceInner {
    latest: Option<WindowState>,
    dirty: bool,
    deadline: Option<Instant>,
    shutdown: bool,
    revision: u64,
}

/// Restores saved window geometry with multi-monitor safeguards before showing the window,
/// then persists move/resize/maximize updates via a debounced background writer and final
/// `CloseRequested` flush.
#[cfg(not(target_os = "android"))]
pub fn init_window_state(window: WebviewWindow, storage: Arc<Storage>) {
    let monitors = collect_monitors(&window);
    let saved = storage.window_state();
    let placement = match &saved {
        Some(s) => resolve_window_placement(s, &monitors),
        None => resolve_initial_placement(&monitors),
    };

    if let Some(p) = placement {
        let _ = window.set_position(Position::Physical(PhysicalPosition::new(p.x, p.y)));
        let _ = window.set_size(Size::Physical(PhysicalSize::new(p.width, p.height)));
        // Re-apply position in case Windows shifted the frame during a cross-DPI resize.
        let _ = window.set_position(Position::Physical(PhysicalPosition::new(p.x, p.y)));
        if p.maximized {
            let _ = window.maximize();
        }
    }

    let _ = window.show();
    let _ = window.set_focus();

    let seeded_state = if let Some(s) = saved {
        if placement.is_some_and(|p| p.relocated) {
            capture_live_state(&window, Some(&s)).or(Some(s))
        } else {
            Some(s)
        }
    } else {
        None
    };

    let debouncer = Arc::new((
        Mutex::new(DebounceInner {
            latest: seeded_state,
            dirty: false,
            deadline: None,
            shutdown: false,
            revision: 0,
        }),
        Condvar::new(),
    ));
    let write_lock = Arc::new(Mutex::new(()));

    let worker_debouncer = Arc::clone(&debouncer);
    let worker_storage = Arc::clone(&storage);
    let worker_write_lock = Arc::clone(&write_lock);
    let _ = std::thread::Builder::new()
        .name("bookreader-winstate".to_string())
        .spawn(move || {
            let (lock, cvar) = &*worker_debouncer;
            loop {
                let snapshot = {
                    let mut guard = lock.lock().unwrap_or_else(|e| e.into_inner());
                    loop {
                        if guard.shutdown {
                            return;
                        }
                        if guard.dirty {
                            let now = Instant::now();
                            match guard.deadline {
                                Some(dl) if now < dl => {
                                    let (next_guard, _) = cvar
                                        .wait_timeout(guard, dl.saturating_duration_since(now))
                                        .unwrap_or_else(|e| e.into_inner());
                                    guard = next_guard;
                                    continue;
                                }
                                _ => {
                                    guard.dirty = false;
                                    guard.deadline = None;
                                    break guard.latest.clone().map(|s| (s, guard.revision));
                                }
                            }
                        }
                        guard = cvar.wait(guard).unwrap_or_else(|e| e.into_inner());
                    }
                };

                if let Some((state, snap_rev)) = snapshot {
                    let _write_guard = worker_write_lock.lock().unwrap_or_else(|e| e.into_inner());
                    let still_current = {
                        let guard = lock.lock().unwrap_or_else(|e| e.into_inner());
                        !guard.shutdown && guard.revision == snap_rev
                    };
                    if still_current
                        && let Err(err) = worker_storage.save_window_state(state)
                    {
                        tracing::warn!(error = %err, "Failed to persist debounced window state");
                    }
                }
            }
        });

    let ready_at = Instant::now() + Duration::from_millis(STARTUP_SETTLE_MS);
    let window_for_events = window.clone();
    let event_debouncer = Arc::clone(&debouncer);
    let event_storage = Arc::clone(&storage);
    let event_write_lock = Arc::clone(&write_lock);

    window.on_window_event(move |event| match event {
        WindowEvent::Moved(_)
        | WindowEvent::Resized(_)
        | WindowEvent::ScaleFactorChanged { .. } => {
            if Instant::now() < ready_at {
                return;
            }
            let (lock, cvar) = &*event_debouncer;
            let mut guard = lock.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(next) = capture_live_state(&window_for_events, guard.latest.as_ref()) {
                if guard.latest.as_ref() != Some(&next) {
                    guard.latest = Some(next);
                    guard.dirty = true;
                    guard.revision = guard.revision.saturating_add(1);
                    guard.deadline = Some(Instant::now() + Duration::from_millis(SAVE_DEBOUNCE_MS));
                    cvar.notify_one();
                }
            }
        }
        WindowEvent::CloseRequested { .. } => {
            let final_state = {
                let (lock, cvar) = &*event_debouncer;
                let mut guard = lock.lock().unwrap_or_else(|e| e.into_inner());
                if Instant::now() >= ready_at || guard.latest.is_none() {
                    if let Some(next) =
                        capture_live_state(&window_for_events, guard.latest.as_ref())
                    {
                        guard.latest = Some(next);
                    }
                }
                guard.dirty = false;
                guard.shutdown = true;
                guard.revision = guard.revision.saturating_add(1);
                let out = guard.latest.clone();
                cvar.notify_one();
                out
            };
            if let Some(state) = final_state {
                let _write_guard = event_write_lock.lock().unwrap_or_else(|e| e.into_inner());
                if let Err(err) = event_storage.save_window_state(state) {
                    tracing::warn!(error = %err, "Failed to persist final window state on close");
                }
            }
        }
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mon(x: i32, y: i32, w: u32, h: u32, scale: f64, is_primary: bool) -> MonitorInfo {
        MonitorInfo {
            work_area: Rect {
                x,
                y,
                width: w,
                height: h,
            },
            scale_factor: scale,
            is_primary,
        }
    }

    fn mon_with_work(work_area: Rect, scale: f64, is_primary: bool) -> MonitorInfo {
        MonitorInfo {
            work_area,
            scale_factor: scale,
            is_primary,
        }
    }

    #[test]
    fn exact_restore_on_secondary_monitor() {
        let monitors = vec![
            mon(0, 0, 1920, 1040, 1.0, true),
            mon(1920, 0, 2560, 1400, 1.0, false),
        ];
        let saved = WindowState {
            x: 2100,
            y: 120,
            width: 1400,
            height: 900,
            maximized: false,
            scale_factor: 1.0,
            monitor_x: Some(1920),
            monitor_y: Some(0),
            monitor_width: Some(2560),
            monitor_height: Some(1400),
        };

        let p = resolve_window_placement(&saved, &monitors).unwrap();
        assert!(!p.relocated);
        assert_eq!((p.x, p.y, p.width, p.height, p.maximized), (2100, 120, 1400, 900, false));
    }

    #[test]
    fn disconnected_secondary_monitor_relocates_to_primary() {
        let monitors = vec![mon(0, 0, 1920, 1040, 1.0, true)];
        let saved = WindowState {
            x: 2100,
            y: 120,
            width: 1280,
            height: 820,
            maximized: false,
            scale_factor: 1.0,
            ..WindowState::default()
        };

        let p = resolve_window_placement(&saved, &monitors).unwrap();
        assert!(p.relocated);
        assert!(p.x >= 0 && p.x + (p.width as i32) <= 1920);
        assert!(p.y >= 0 && p.y + (p.height as i32) <= 1040);
    }

    #[test]
    fn tiny_dwm_border_sliver_triggers_relocation() {
        let monitors = vec![mon(0, 0, 1920, 1040, 1.0, true)];
        let saved = WindowState {
            x: 1913, // Only 7 px of left shadow overlaps monitor 0
            y: 100,
            width: 1200,
            height: 800,
            maximized: false,
            scale_factor: 1.0,
            ..WindowState::default()
        };

        let p = resolve_window_placement(&saved, &monitors).unwrap();
        assert!(p.relocated);
        assert!(p.x < 1000 && p.x >= 0);
    }

    #[test]
    fn negative_coordinate_left_monitor_restores_and_falls_back_on_disconnect() {
        let both = vec![
            mon(-1920, 0, 1920, 1040, 1.0, false),
            mon(0, 0, 1920, 1040, 1.0, true),
        ];
        let saved = WindowState {
            x: -1700,
            y: 90,
            width: 1280,
            height: 820,
            maximized: false,
            scale_factor: 1.0,
            ..WindowState::default()
        };

        let p_both = resolve_window_placement(&saved, &both).unwrap();
        assert!(!p_both.relocated);
        assert_eq!((p_both.x, p_both.y), (-1700, 90));

        let primary_only = vec![mon(0, 0, 1920, 1040, 1.0, true)];
        let p_fallback = resolve_window_placement(&saved, &primary_only).unwrap();
        assert!(p_fallback.relocated);
        assert!(p_fallback.x >= 0 && p_fallback.y >= 0);
    }

    #[test]
    fn high_dpi_to_small_100pct_monitor_rescales_and_clamps() {
        let small = vec![mon(0, 0, 1366, 728, 1.0, true)];
        let saved = WindowState {
            x: 4000,
            y: 200,
            width: 2560,
            height: 1640,
            maximized: false,
            scale_factor: 2.0,
            ..WindowState::default()
        };

        let p = resolve_window_placement(&saved, &small).unwrap();
        assert!(p.relocated);
        // 2560 / 2.0 = 1280, 1640 / 2.0 = 820 clamped to 728 - 40 = 688
        assert_eq!(p.width, 1280);
        assert_eq!(p.height, 688);
        assert!(p.x >= 0 && p.y >= 0);
    }

    #[test]
    fn offscreen_top_titlebar_clamped_into_work_area() {
        let monitors = vec![mon_with_work(
            Rect { x: 0, y: 40, width: 1920, height: 1040 }, // top taskbar
            1.0,
            true,
        )];
        let saved = WindowState {
            x: 200,
            y: -120,
            width: 1200,
            height: 800,
            maximized: false,
            scale_factor: 1.0,
            ..WindowState::default()
        };

        let p = resolve_window_placement(&saved, &monitors).unwrap();
        assert!(!p.relocated);
        assert_eq!(p.y, 40);
    }

    #[test]
    fn maximized_reopens_on_saved_monitor_or_relocates_when_unplugged() {
        let both = vec![
            mon(0, 0, 1920, 1040, 1.0, true),
            mon(1920, 0, 2560, 1400, 1.0, false),
        ];
        // Normal rect happened to sit on Monitor 0, while maximized was on Monitor 1.
        let saved = WindowState {
            x: 200,
            y: 120,
            width: 1200,
            height: 800,
            maximized: true,
            scale_factor: 1.0,
            monitor_x: Some(1920),
            monitor_y: Some(0),
            monitor_width: Some(2560),
            monitor_height: Some(1400),
        };

        let p_both = resolve_window_placement(&saved, &both).unwrap();
        assert!(!p_both.relocated);
        assert!(p_both.maximized);
        assert!(p_both.x >= 1920 && p_both.x < 1920 + 2560);

        let primary_only = vec![mon(0, 0, 1920, 1040, 1.0, true)];
        let p_fallback = resolve_window_placement(&saved, &primary_only).unwrap();
        assert!(p_fallback.relocated);
        assert!(p_fallback.maximized);
        assert!(p_fallback.x >= 0 && p_fallback.x < 1920);
    }

    #[test]
    fn dwm_aero_snap_overhang_is_preserved() {
        let monitors = vec![mon(0, 0, 1920, 1040, 1.0, true)];
        let saved = WindowState {
            x: -7,
            y: 0,
            width: 960,
            height: 1000,
            maximized: false,
            scale_factor: 1.0,
            ..WindowState::default()
        };

        let p = resolve_window_placement(&saved, &monitors).unwrap();
        assert!(!p.relocated);
        let expected_x = if cfg!(target_os = "windows") { -7 } else { 0 };
        assert_eq!((p.x, p.y, p.width, p.height), (expected_x, 0, 960, 1000));
    }

    #[test]
    fn empty_monitor_list_returns_none() {
        assert!(resolve_initial_placement(&[]).is_none());
        assert!(resolve_window_placement(&WindowState::default(), &[]).is_none());
    }

    #[test]
    fn extreme_and_corrupt_coordinates_do_not_overflow_or_panic() {
        let monitors = vec![mon(0, 0, 1920, 1040, 1.0, true)];
        let corrupt = WindowState {
            x: i32::MIN,
            y: i32::MAX,
            width: 0,
            height: 0,
            maximized: false,
            scale_factor: f64::NAN,
            monitor_x: Some(i32::MIN),
            monitor_y: Some(i32::MAX),
            monitor_width: Some(u32::MAX),
            monitor_height: Some(u32::MAX),
        };

        let p = resolve_window_placement(&corrupt, &monitors).unwrap();
        assert!(p.relocated);
        assert!(p.x >= 0 && p.y >= 0);
        assert!(p.width >= 900 && p.height >= 600);
    }
}
