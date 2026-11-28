//! Sleep timer supporting timed countdown (minutes) or end-of-chapter pause with smooth fade-out.

use crate::models::SleepTimerStatus;
use crate::storage::Storage;
use crate::tts::TtsController;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const MAX_SLEEP_MINUTES: u64 = 24 * 60;

#[derive(Clone, Debug)]
enum TimerMode {
    Off,
    Minutes {
        deadline: Instant,
    },
    EndOfChapter {
        book_id: Option<String>,
        end_sentence_idx: usize,
    },
}

#[derive(Clone, Debug)]
struct SleepState {
    mode: TimerMode,
    generation: u64,
}

pub struct SleepTimer {
    state: Arc<Mutex<SleepState>>,
    storage: Arc<Storage>,
    tts: Arc<TtsController>,
}

impl SleepTimer {
    pub fn start(app: AppHandle, storage: Arc<Storage>, tts: Arc<TtsController>) -> Arc<Self> {
        let timer = Arc::new(Self {
            state: Arc::new(Mutex::new(SleepState {
                mode: TimerMode::Off,
                generation: 0,
            })),
            storage,
            tts,
        });

        let bg = Arc::clone(&timer);
        std::thread::Builder::new()
            .name("bookreader-sleep-timer".to_string())
            .spawn(move || bg.run_loop(app))
            .ok();

        timer
    }

    pub fn set_minutes(&self, minutes: u64) -> SleepTimerStatus {
        let mut guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
        guard.generation = guard.generation.saturating_add(1);
        if minutes == 0 {
            guard.mode = TimerMode::Off;
        } else {
            let clamped_mins = minutes.min(MAX_SLEEP_MINUTES);
            let dur = Duration::from_secs(clamped_mins.saturating_mul(60));
            let deadline = Instant::now()
                .checked_add(dur)
                .unwrap_or_else(Instant::now);
            guard.mode = TimerMode::Minutes { deadline };
        }
        status_from_mode(&guard.mode)
    }

    pub fn set_end_of_chapter(&self, end_sentence_idx: usize) -> SleepTimerStatus {
        let book_id = self.tts.current_state_event().book_id;
        let mut guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
        guard.generation = guard.generation.saturating_add(1);
        guard.mode = TimerMode::EndOfChapter {
            book_id,
            end_sentence_idx,
        };
        status_from_mode(&guard.mode)
    }

    pub fn clear(&self) -> SleepTimerStatus {
        let mut guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
        guard.generation = guard.generation.saturating_add(1);
        guard.mode = TimerMode::Off;
        status_from_mode(&guard.mode)
    }

    pub fn status(&self) -> SleepTimerStatus {
        let guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
        status_from_mode(&guard.mode)
    }

    fn run_loop(&self, app: AppHandle) {
        let mut last_active = false;
        let mut pending_off_emit = false;

        loop {
            std::thread::sleep(Duration::from_secs(1));

            let in_fg = crate::media_keys::is_app_in_foreground();
            let (trigger_fade_gen, emit_status) = {
                let mut guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
                let state_mode = guard.mode.clone();
                match state_mode {
                    TimerMode::Off => {
                        let status = if last_active {
                            last_active = false;
                            if in_fg {
                                pending_off_emit = false;
                                Some(status_from_mode(&guard.mode))
                            } else {
                                pending_off_emit = true;
                                None
                            }
                        } else if in_fg && pending_off_emit {
                            pending_off_emit = false;
                            Some(status_from_mode(&guard.mode))
                        } else {
                            None
                        };
                        (None, status)
                    }
                    TimerMode::Minutes { deadline } => {
                        last_active = true;
                        pending_off_emit = false;
                        let now = Instant::now();
                        if now >= deadline {
                            guard.mode = TimerMode::Off;
                            (Some(guard.generation), None)
                        } else {
                            (None, in_fg.then(|| status_from_mode(&guard.mode)))
                        }
                    }
                    TimerMode::EndOfChapter {
                        book_id,
                        end_sentence_idx,
                    } => {
                        last_active = true;
                        pending_off_emit = false;
                        let evt = self.tts.current_state_event();
                        if book_id.is_some() && evt.book_id.is_some() && evt.book_id != book_id {
                            guard.mode = TimerMode::Off;
                            (None, in_fg.then(|| status_from_mode(&guard.mode)))
                        } else if evt.status == "playing" && evt.sentence_idx >= end_sentence_idx {
                            guard.mode = TimerMode::Off;
                            (Some(guard.generation), None)
                        } else {
                            (None, in_fg.then(|| status_from_mode(&guard.mode)))
                        }
                    }
                }
            };

            if let Some(status) = emit_status {
                let _ = app.emit("sleep:tick", status);
            }

            if let Some(fade_gen) = trigger_fade_gen {
                last_active = false;
                if self.tts.is_actively_playing() {
                    let base_vol = self.storage.settings().volume;
                    let mut aborted = false;
                    // Gentle 2.4-second fade out before pausing
                    for step in (0..12).rev() {
                        let gen_changed = self
                            .state
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .generation
                            != fade_gen;
                        if gen_changed {
                            aborted = true;
                            break;
                        }
                        let frac = step as f32 / 12.0;
                        self.tts.set_volume(base_vol * frac);
                        std::thread::sleep(Duration::from_millis(200));
                    }
                    if !aborted {
                        aborted = self
                            .state
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .generation
                            != fade_gen;
                    }
                    if !aborted {
                        self.tts.pause();
                    }
                    let current_saved_vol = self.storage.settings().volume;
                    if (current_saved_vol - base_vol).abs() <= 0.001 {
                        self.tts.set_volume(base_vol);
                    }
                }
                if crate::media_keys::is_app_in_foreground() {
                    let _ = app.emit("sleep:tick", self.status());
                } else {
                    pending_off_emit = true;
                }
            }
        }
    }
}

fn status_from_mode(mode: &TimerMode) -> SleepTimerStatus {
    match mode {
        TimerMode::Off => SleepTimerStatus {
            active: false,
            mode: "off".to_string(),
            remaining_sec: None,
        },
        TimerMode::Minutes { deadline } => {
            let rem = deadline
                .checked_duration_since(Instant::now())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            SleepTimerStatus {
                active: true,
                mode: "minutes".to_string(),
                remaining_sec: Some(rem),
            }
        }
        TimerMode::EndOfChapter { .. } => SleepTimerStatus {
            active: true,
            mode: "end_of_chapter".to_string(),
            remaining_sec: None,
        },
    }
}
