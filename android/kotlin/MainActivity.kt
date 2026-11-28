package com.bookreader.android

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.OpenableColumns
import android.view.View
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import java.io.File
import java.io.FileOutputStream
import java.util.UUID

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    appContext = applicationContext
    BookReaderPlaybackService.initAppContext(applicationContext)
    ensureNativeBound()
    requestNotificationsPermissionIfNeeded()

    val bgColor = Color.parseColor("#121211")
    window.decorView.setBackgroundColor(bgColor)
    @Suppress("DEPRECATION")
    window.statusBarColor = bgColor
    @Suppress("DEPRECATION")
    window.navigationBarColor = bgColor

    val controller = WindowInsetsControllerCompat(window, window.decorView)
    controller.isAppearanceLightStatusBars = false
    controller.isAppearanceLightNavigationBars = false

    val rootView: View = findViewById(android.R.id.content)
    rootView.setBackgroundColor(bgColor)
    ViewCompat.setOnApplyWindowInsetsListener(rootView) { view, insets ->
      val mask = WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
      val bars = insets.getInsets(mask)
      view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      WindowInsetsCompat.Builder(insets)
        .setInsets(mask, Insets.NONE)
        .build()
    }
    ViewCompat.requestApplyInsets(rootView)
  }

  override fun onResume() {
    super.onResume()
    appContext = applicationContext
    BookReaderPlaybackService.initAppContext(applicationContext)
    ensureNativeBound()
    notifyLifecycle(true)
  }

  override fun onPause() {
    notifyLifecycle(false)
    super.onPause()
  }

  private fun requestNotificationsPermissionIfNeeded() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
        != PackageManager.PERMISSION_GRANTED
      ) {
        ActivityCompat.requestPermissions(
          this,
          arrayOf(Manifest.permission.POST_NOTIFICATIONS),
          1001
        )
      }
    }
  }

  private fun ensureNativeBound() {
    if (nativeBound) return
    try {
      nativeBindApp(this)
      nativeBound = true
    } catch (_: UnsatisfiedLinkError) {
    }
  }

  private fun notifyLifecycle(foreground: Boolean) {
    try {
      nativeOnAppLifecycle(foreground)
    } catch (_: UnsatisfiedLinkError) {
    }
  }

  companion object {
    @Volatile
    private var appContext: Context? = null

    @Volatile
    private var nativeBound: Boolean = false

    @JvmStatic
    external fun nativeBindApp(activity: MainActivity)

    @JvmStatic
    external fun nativeOnAppLifecycle(foreground: Boolean)

    @JvmStatic
    fun copyContentUriToCache(uriString: String, destDirPath: String): String {
      val ctx = appContext ?: throw IllegalStateException("Android application context not initialized")
      val uri = Uri.parse(uriString)
      val resolver = ctx.contentResolver

      var displayName: String? = null
      try {
        resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
          if (cursor.moveToFirst()) {
            val idx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
            if (idx >= 0) {
              displayName = cursor.getString(idx)
            }
          }
        }
      } catch (_: Exception) {
      }

      var cleanName = (displayName ?: "")
        .replace(Regex("[\\u0000-\\u001F\\u007F]"), "")
        .replace(Regex("[/\\\\:*?\"<>|]"), "_")
        .trim()
      if (cleanName == "." || cleanName == "..") {
        cleanName = ""
      }

      val supportedExt = Regex("\\.(epub|pdf|docx|txt)$", RegexOption.IGNORE_CASE)
      if (cleanName.isEmpty() || !supportedExt.containsMatchIn(cleanName)) {
        val mime = resolver.getType(uri) ?: ""
        val ext = when {
          mime.contains("pdf") -> ".pdf"
          mime.contains("epub") -> ".epub"
          mime.contains("wordprocessingml") || mime.contains("docx") -> ".docx"
          mime.contains("text/plain") -> ".txt"
          else -> ".epub"
        }
        cleanName = if (cleanName.isEmpty()) "imported_book$ext" else "$cleanName$ext"
      }

      // Clamp UTF-8 filename length below filesystem 255-byte limit while preserving extension
      val dotIdx = cleanName.lastIndexOf('.')
      if (dotIdx > 0) {
        var stem = cleanName.substring(0, dotIdx)
        val ext = cleanName.substring(dotIdx)
        while (stem.isNotEmpty() && (stem + ext).toByteArray(Charsets.UTF_8).size > 200) {
          stem = stem.dropLast(1)
        }
        cleanName = if (stem.isEmpty()) "imported_book$ext" else "$stem$ext"
      }

      val destDir = File(destDirPath)
      if (!destDir.exists()) {
        destDir.mkdirs()
      }
      val importDir = File(destDir, UUID.randomUUID().toString())
      if (!importDir.exists()) {
        importDir.mkdirs()
      }
      val outFile = File(importDir, cleanName)
      val importRoot = importDir.canonicalPath + File.separator
      if (!outFile.canonicalPath.startsWith(importRoot)) {
        importDir.deleteRecursively()
        throw SecurityException("Invalid imported filename: $cleanName")
      }

      try {
        resolver.openInputStream(uri)?.use { input ->
          FileOutputStream(outFile).use { output ->
            input.copyTo(output, 64 * 1024)
          }
        } ?: throw IllegalStateException("Unable to open selected document stream: $uriString")
      } catch (t: Throwable) {
        importDir.deleteRecursively()
        throw t
      }

      return outFile.absolutePath
    }
  }
}
