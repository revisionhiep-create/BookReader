package com.bookreader.android

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaMetadata
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager

/**
 * Foreground MediaSession service keeping Phonon 31M TTS playback alive with the screen off
 * and exposing lock-screen / notification transport actions back into Rust via JNI.
 */
class BookReaderPlaybackService : Service() {

    private var mediaSession: MediaSession? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var audioManager: AudioManager? = null
    private var focusRequest: AudioFocusRequest? = null
    private var noisyReceiverRegistered = false
    private var isForeground = false

    private val noisyReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action == AudioManager.ACTION_AUDIO_BECOMING_NOISY) {
                safeNativeAction(ACTION_PAUSE)
            }
        }
    }

    override fun onCreate() {
        super.onCreate()
        appContext = applicationContext
        instance = this
        safeBindJvm()
        ensureNotificationChannel()

        audioManager = getSystemService(Context.AUDIO_SERVICE) as AudioManager

        mediaSession = MediaSession(this, "BookReaderSession").apply {
            setCallback(object : MediaSession.Callback() {
                override fun onPlay() {
                    requestAudioFocus()
                    safeNativeAction(ACTION_PLAY)
                }

                override fun onPause() {
                    safeNativeAction(ACTION_PAUSE)
                }

                override fun onStop() {
                    safeNativeAction(ACTION_PAUSE)
                }

                override fun onSkipToNext() {
                    safeNativeAction(ACTION_NEXT)
                }

                override fun onSkipToPrevious() {
                    safeNativeAction(ACTION_PREV)
                }
            })
            isActive = true
        }

        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "BookReader::TtsWakeLock").apply {
            setReferenceCounted(false)
        }

        val filter = IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(noisyReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            registerReceiver(noisyReceiver, filter)
        }
        noisyReceiverRegistered = true
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            INTENT_ACTION_PLAY -> safeNativeAction(ACTION_PLAY)
            INTENT_ACTION_PAUSE -> safeNativeAction(ACTION_PAUSE)
            INTENT_ACTION_PREV -> safeNativeAction(ACTION_PREV)
            INTENT_ACTION_NEXT -> safeNativeAction(ACTION_NEXT)
            else -> {
                val title = intent?.getStringExtra(EXTRA_TITLE) ?: currentTitle
                val playing = intent?.getBooleanExtra(EXTRA_PLAYING, currentPlaying) ?: currentPlaying
                val paused = intent?.getBooleanExtra(EXTRA_PAUSED, currentPaused) ?: currentPaused
                applyState(title, playing, paused)
            }
        }
        return START_NOT_STICKY
    }

    private fun applyState(title: String, playing: Boolean, paused: Boolean) {
        currentTitle = title
        currentPlaying = playing
        currentPaused = paused

        if (playing) {
            requestAudioFocus()
            acquireWakeLockInternal()
        } else {
            releaseWakeLockInternal()
            abandonAudioFocus()
        }

        val stateCode = when {
            playing -> PlaybackState.STATE_PLAYING
            paused -> PlaybackState.STATE_PAUSED
            else -> PlaybackState.STATE_STOPPED
        }

        val actions = PlaybackState.ACTION_PLAY or
            PlaybackState.ACTION_PAUSE or
            PlaybackState.ACTION_PLAY_PAUSE or
            PlaybackState.ACTION_SKIP_TO_NEXT or
            PlaybackState.ACTION_SKIP_TO_PREVIOUS or
            PlaybackState.ACTION_STOP

        mediaSession?.setMetadata(
            MediaMetadata.Builder()
                .putString(MediaMetadata.METADATA_KEY_TITLE, title)
                .putString(MediaMetadata.METADATA_KEY_ARTIST, "BookReader — Phonon 31M")
                .build()
        )
        mediaSession?.setPlaybackState(
            PlaybackState.Builder()
                .setActions(actions)
                .setState(stateCode, PlaybackState.PLAYBACK_POSITION_UNKNOWN, 1.0f)
                .build()
        )

        val notification = buildNotification(title, playing)
        if (playing || paused) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(
                    NOTIFICATION_ID,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
                )
            } else {
                startForeground(NOTIFICATION_ID, notification)
            }
            isForeground = true
        } else {
            if (!isForeground && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    startForeground(
                        NOTIFICATION_ID,
                        notification,
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
                    )
                } else {
                    startForeground(NOTIFICATION_ID, notification)
                }
            }
            isForeground = false
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
        }
    }

    private fun buildNotification(title: String, playing: Boolean): Notification {
        val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
        val contentIntent = PendingIntent.getActivity(
            this,
            0,
            launchIntent ?: Intent(),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val prevIntent = servicePendingIntent(INTENT_ACTION_PREV, 10)
        val toggleIntent = servicePendingIntent(
            if (playing) INTENT_ACTION_PAUSE else INTENT_ACTION_PLAY,
            11
        )
        val nextIntent = servicePendingIntent(INTENT_ACTION_NEXT, 12)

        val toggleLabel = if (playing) "Pause" else "Play"
        val toggleIcon = if (playing) android.R.drawable.ic_media_pause else android.R.drawable.ic_media_play

        return Notification.Builder(this, CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(if (playing) "Reading aloud (Phonon 31M)" else "Paused")
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentIntent(contentIntent)
            .setOngoing(playing)
            .addAction(
                Notification.Action.Builder(
                    android.R.drawable.ic_media_previous,
                    "Previous",
                    prevIntent
                ).build()
            )
            .addAction(
                Notification.Action.Builder(toggleIcon, toggleLabel, toggleIntent).build()
            )
            .addAction(
                Notification.Action.Builder(
                    android.R.drawable.ic_media_next,
                    "Next",
                    nextIntent
                ).build()
            )
            .setStyle(
                Notification.MediaStyle()
                    .setMediaSession(mediaSession?.sessionToken)
                    .setShowActionsInCompactView(0, 1, 2)
            )
            .build()
    }

    private fun servicePendingIntent(action: String, reqCode: Int): PendingIntent {
        val intent = Intent(this, BookReaderPlaybackService::class.java).apply {
            this.action = action
        }
        return PendingIntent.getService(
            this,
            reqCode,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
    }

    private fun requestAudioFocus() {
        val am = audioManager ?: return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            if (focusRequest == null) {
                focusRequest = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                    .setAudioAttributes(
                        AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_MEDIA)
                            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                            .build()
                    )
                    .setOnAudioFocusChangeListener { change ->
                        if (change == AudioManager.AUDIOFOCUS_LOSS ||
                            change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT
                        ) {
                            safeNativeAction(ACTION_PAUSE)
                        }
                    }
                    .build()
            }
            focusRequest?.let { am.requestAudioFocus(it) }
        }
    }

    private fun abandonAudioFocus() {
        val am = audioManager ?: return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            focusRequest?.let { am.abandonAudioFocusRequest(it) }
        }
    }

    private fun acquireWakeLockInternal() {
        val wl = wakeLock ?: return
        if (!wl.isHeld) {
            wl.acquire(4 * 60 * 60 * 1000L)
        }
    }

    private fun releaseWakeLockInternal() {
        val wl = wakeLock ?: return
        if (wl.isHeld) {
            wl.release()
        }
    }

    private fun ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            val existing = nm.getNotificationChannel(CHANNEL_ID)
            if (existing == null) {
                val ch = NotificationChannel(
                    CHANNEL_ID,
                    "BookReader Narration",
                    NotificationManager.IMPORTANCE_LOW
                ).apply {
                    description = "Controls for offline audiobook narration"
                    setShowBadge(false)
                }
                nm.createNotificationChannel(ch)
            }
        }
    }

    override fun onDestroy() {
        isForeground = false
        releaseWakeLockInternal()
        abandonAudioFocus()
        if (noisyReceiverRegistered) {
            unregisterReceiver(noisyReceiver)
            noisyReceiverRegistered = false
        }
        mediaSession?.release()
        mediaSession = null
        if (instance === this) instance = null
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        private const val CHANNEL_ID = "bookreader_playback"
        private const val NOTIFICATION_ID = 4101

        private const val ACTION_PLAY = 0
        private const val ACTION_PAUSE = 1
        private const val ACTION_TOGGLE = 2
        private const val ACTION_NEXT = 3
        private const val ACTION_PREV = 4

        private const val INTENT_ACTION_PLAY = "com.bookreader.android.ACTION_PLAY"
        private const val INTENT_ACTION_PAUSE = "com.bookreader.android.ACTION_PAUSE"
        private const val INTENT_ACTION_PREV = "com.bookreader.android.ACTION_PREV"
        private const val INTENT_ACTION_NEXT = "com.bookreader.android.ACTION_NEXT"

        private const val EXTRA_TITLE = "title"
        private const val EXTRA_PLAYING = "playing"
        private const val EXTRA_PAUSED = "paused"

        @Volatile
        private var appContext: Context? = null
        @Volatile
        private var instance: BookReaderPlaybackService? = null
        @Volatile
        private var currentTitle: String = "BookReader"
        @Volatile
        private var currentPlaying: Boolean = false
        @Volatile
        private var currentPaused: Boolean = false

        private val mainHandler = Handler(Looper.getMainLooper())
        private val exportWakeLockLock = Any()
        @Volatile
        private var exportWakeLock: PowerManager.WakeLock? = null

        @JvmStatic
        fun initAppContext(context: Context) {
            appContext = context.applicationContext
        }

        @JvmStatic
        external fun nativeBindJvm()

        @JvmStatic
        external fun nativeOnMediaAction(action: Int)

        private fun safeBindJvm() {
            try {
                nativeBindJvm()
            } catch (_: UnsatisfiedLinkError) {
            }
        }

        private fun safeNativeAction(action: Int) {
            try {
                nativeOnMediaAction(action)
            } catch (_: UnsatisfiedLinkError) {
            }
        }

        @JvmStatic
        fun updatePlaybackStateFromNative(title: String, playing: Boolean, paused: Boolean) {
            currentTitle = title
            currentPlaying = playing
            currentPaused = paused
            mainHandler.post {
                val svc = instance
                if (svc != null) {
                    svc.applyState(currentTitle, currentPlaying, currentPaused)
                } else if (currentPlaying || currentPaused) {
                    appContext?.let { ctx ->
                        try {
                            syncFromApp(ctx, currentTitle, currentPlaying, currentPaused)
                        } catch (_: Exception) {
                        }
                    }
                }
            }
        }

        @JvmStatic
        fun setWakeLockFromNative(hold: Boolean) {
            synchronized(exportWakeLockLock) {
                if (hold) {
                    val ctx = appContext ?: instance?.applicationContext ?: return
                    val wl = exportWakeLock ?: (ctx.getSystemService(Context.POWER_SERVICE) as PowerManager)
                        .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "BookReader::ExportWakeLock")
                        .apply { setReferenceCounted(false) }
                        .also { exportWakeLock = it }
                    if (!wl.isHeld) {
                        wl.acquire(4 * 60 * 60 * 1000L)
                    }
                } else {
                    val wl = exportWakeLock ?: return
                    if (wl.isHeld) {
                        wl.release()
                    }
                }
            }
        }

        fun syncFromApp(context: Context, title: String, playing: Boolean, paused: Boolean) {
            val intent = Intent(context, BookReaderPlaybackService::class.java).apply {
                putExtra(EXTRA_TITLE, title)
                putExtra(EXTRA_PLAYING, playing)
                putExtra(EXTRA_PAUSED, paused)
            }
            if ((playing || paused) && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else if (instance != null) {
                context.startService(intent)
            }
        }
    }
}
