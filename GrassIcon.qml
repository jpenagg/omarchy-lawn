import QtQuick

// Three blades of grass fanning out of one tuft. `growth` runs from 0 (freshly
// cut: shorter and upright) to 1 (ready to mow: full height, the outer blades
// arching over). A Canvas rather than a Shape so the bar measures the item's
// fixed bounds: the blades then grow inside the icon instead of being scaled
// back to fill it.
Canvas {
  id: root

  property real growth: 0
  property color color: "white"
  // A dot in the top corner: something on the lawn calendar wants doing.
  property bool dot: false

  // Each blade: where its root and its grown tip sit across the width, and
  // its grown height against the tallest. Drawn outer blades first, so the
  // tall middle one sits on top.
  readonly property var blades: [
    { root: 0.36, tip: 0.05, height: 0.70 },
    { root: 0.64, tip: 0.97, height: 0.82 },
    { root: 0.50, tip: 0.55, height: 1.00 }
  ]

  // How much of its grown height a blade keeps right after a mow.
  readonly property real cutHeight: 0.7

  width: 16
  height: 16

  onGrowthChanged: requestPaint()
  onColorChanged: requestPaint()
  onDotChanged: requestPaint()
  onWidthChanged: requestPaint()
  onHeightChanged: requestPaint()

  onPaint: {
    var ctx = getContext("2d")
    ctx.reset()

    var w = width
    var h = height
    var g = Math.max(0, Math.min(1, growth))
    var half = w * 0.085

    ctx.fillStyle = root.color

    for (var i = 0; i < blades.length; i++) {
      var blade = blades[i]
      var x = w * blade.root
      var bladeHeight = h * blade.height * (cutHeight + (1 - cutHeight) * g)
      // A cut blade stands nearly straight; it arches out as it grows.
      var tipX = x + w * (blade.tip - blade.root) * (0.45 + 0.55 * g)
      var tipY = h - bladeHeight
      var lean = tipX - x

      // Both edges bow the same way, so the blade tapers to its tip as one
      // slender curve instead of swelling in the middle.
      var bowX = x + lean * 0.12
      var bowY = h - bladeHeight * 0.55
      ctx.beginPath()
      ctx.moveTo(x - half, h)
      ctx.quadraticCurveTo(bowX - half * 0.6, bowY, tipX, tipY)
      ctx.quadraticCurveTo(bowX + half * 0.6, bowY, x + half, h)
      ctx.closePath()
      ctx.fill()
    }

    if (dot) {
      // Clear a ring around the dot first, so it stays separate from a blade
      // that has grown up behind it.
      var radius = w * 0.14
      ctx.globalCompositeOperation = "destination-out"
      ctx.beginPath()
      ctx.arc(w - radius, radius, radius * 1.7, 0, Math.PI * 2)
      ctx.fill()
      ctx.globalCompositeOperation = "source-over"
      ctx.beginPath()
      ctx.arc(w - radius, radius, radius, 0, Math.PI * 2)
      ctx.fill()
    }
  }
}
