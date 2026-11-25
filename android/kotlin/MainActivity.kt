package com.bookreader.android

import android.graphics.Color
import android.os.Bundle
import android.view.View
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)

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
}
