//! Sleep timer supporting timed countdown (minutes) or end-of-chapter pause with smooth fade-out.

use crate::models::SleepTimerStatus;
use crate::storage::Storage;
use crate::tts::TtsController;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

#[derive(Clone, Debug)]
enum TimerMode {
    Off,
    Minutes {
        deadline: Instant,
    },
    EndOfChapter {
        end_sentence_idx: usize,
    },
}

pub struct SleepTimer {
    mode: Arc<Mutex<TimerMode>>,
    storage: Arc<Storage>,
    tts: Arc<TtsController>,
}

impl SleepTimer {
    pub fn start(app: AppHandle, storage: Arc<Storage>, tts: Arc<TtsController>) -> Arc<Self> {
        let timer = Arc::new(Self {
            mode: Arc::new(Mutex::new(TimerMode::Off)),
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
        let mut guard = self.mode.lock().unwrap();
        if minutes == 0 {
            *guard = TimerMode::Off;
        } else {
            *guard = TimerMode::Minutes {
                deadline: Instant::now() + Duration::from_secs(minutes * 60),
            };
        }
        status_from_mode(&guard)
    }

    pub fn set_end_of_chapter(&self, end_sentence_idx: usize) -> SleepTimerStatus {
        let mut guard = self.mode.lock().unwrap();
        *guard = TimerMode::EndOfChapter { end_sentence_idx };
        status_from_mode(&guard)
    }

    pub fn clear(&self) -> SleepTimerStatus {
        let mut guard = self.mode.lock().unwrap();
        *guard = TimerMode::Off;
        status_from_mode(&guard)
    }

    pub fn status(&self) -> SleepTimerStatus {
        let guard = self.mode.lock().unwrap();
        status_from_mode(&guard)
    }

    fn run_loop(&self, app: AppHandle) {
        let mut last_active = false;
        let mut pending_off_emit = false;

        loop {
            std::thread::sleep(Duration::from_secs(1));

            let in_fg = crate::media_keys::is_app_in_foreground();
            let (trigger_fade, emit_status) = {
                let mut guard = self.mode.lock().unwrap();
                match *guard {
                    TimerMode::Off => {
                        let status = if last_active {
                            last_active = false;
                            if in_fg {
                                pending_off_emit = false;
                                Some(status_from_mode(&guard))
                            } else {
                                pending_off_emit = true;
                                None
                            }
                        } else if in_fg && pending_off_emit {
                            pending_off_emit = false;
                            Some(status_from_mode(&guard))
                        } else {
                            None
                        };
                        (false, status)
                    }
                    TimerMode::Minutes { deadline } => {
                        last_active = true;
                        pending_off_emit = false;
                        let now = Instant::now();
                        if now >= deadline {
                            *guard = TimerMode::Off;
                            (true, None)
                        } else {
                            (false, in_fg.then(|| status_from_mode(&guard)))
                        }
                    }
                    TimerMode::EndOfChapter { end_sentence_idx } => {
                        last_active = true;
                        pending_off_emit = false;
                        let evt = self.tts.current_state_event();
                        if evt.status == "playing" && evt.sentence_idx >= end_sentence_idx {
                            *guard = TimerMode::Off;
                            (true, None)
                        } else {
                            (false, in_fg.then(|| status_from_mode(&guard)))
                        }
                    }
                }
            };

            if let Some(status) = emit_status {
                let _ = app.emit("sleep:tick", status);
            }

            if trigger_fade {
                last_active = false;
                let base_vol = self.storage.settings().volume;
                // Gentle 2.4-second fade out before pausing
                for step in (0..12).rev() {
                    let frac = step as f32 / 12.0;
                    self.tts.set_volume(base_vol * frac);
                    std::thread::sleep(Duration::from_millis(200));
                }
                self.tts.pause();
                self.tts.set_volume(base_vol);
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
