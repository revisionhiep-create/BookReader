package com.bookreader.android

import android.content.Context
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.provider.OpenableColumns
import android.view.View
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import java.io.File
import java.io.FileOutputStream

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    appContext = applicationContext
    ensureNativeBound()

    val bgColor = Color.parseColor("#181818")
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
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
      )
      view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      insets
    }
    ViewCompat.requestApplyInsets(rootView)
  }

  override fun onResume() {
    super.onResume()
    appContext = applicationContext
    ensureNativeBound()
  }

  private fun ensureNativeBound() {
    if (nativeBound) return
    try {
      nativeBindApp(this)
      nativeBound = true
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
    fun copyContentUriToCache(uriString: String, destDirPath: String): String {
      val ctx = appContext ?: throw IllegalStateException("Android application context not initialized")
      val uri = Uri.parse(uriString)
      val resolver = ctx.contentResolver

      var displayName: String? = null
      resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
        if (cursor.moveToFirst()) {
          val idx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
          if (idx >= 0) {
            displayName = cursor.getString(idx)
          }
        }
      }

      var cleanName = displayName?.replace(Regex("[/\\\\]"), "_")?.trim() ?: ""
      if (cleanName.isEmpty()) {
        val mime = resolver.getType(uri) ?: ""
        val ext = when {
          mime.contains("pdf") -> ".pdf"
          mime.contains("epub") -> ".epub"
          mime.contains("wordprocessingml") || mime.contains("docx") -> ".docx"
          mime.contains("text/plain") -> ".txt"
          else -> ".epub"
        }
        cleanName = "imported_book_${System.currentTimeMillis()}$ext"
      }

      val destDir = File(destDirPath)
      if (!destDir.exists()) {
        destDir.mkdirs()
      }
      val outFile = File(destDir, "${System.currentTimeMillis()}_$cleanName")

      resolver.openInputStream(uri)?.use { input ->
        FileOutputStream(outFile).use { output ->
          val buf = ByteArray(64 * 1024)
          while (true) {
            val read = input.read(buf)
            if (read <= 0) break
            output.write(buf, 0, read)
          }
        }
      } ?: throw IllegalStateException("Unable to open selected document stream: $uriString")

      return outFile.absolutePath
    }
  }
}
