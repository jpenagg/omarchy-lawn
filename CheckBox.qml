import QtQuick
import qs.Commons
import qs.Commons as Commons

// A small square that carries a tick when checked. The tick is drawn rather
// than typed, so it does not depend on the theme font having the glyph.
Item {
  id: root

  property bool checked: false
  property bool hasCursor: false
  property color foreground: Commons.Color.popups.text
  property real size: Style.space(14)

  signal toggled()
  signal hovered(bool isHovered)

  implicitWidth: size
  implicitHeight: size

  readonly property bool hot: hasCursor || mouse.containsMouse

  Rectangle {
    anchors.fill: parent
    radius: Math.min(3, Style.cornerRadius)
    color: root.checked ? root.foreground : (root.hot ? Style.hoverFillFor(root.foreground, Commons.Color.accent) : "transparent")
    border.width: 1
    border.color: root.checked || root.hot ? root.foreground : Qt.darker(root.foreground, 1.6)
  }

  Canvas {
    id: tick
    anchors.fill: parent
    visible: root.checked
    onVisibleChanged: requestPaint()
    onWidthChanged: requestPaint()
    onPaint: {
      var ctx = getContext("2d")
      ctx.reset()
      ctx.strokeStyle = Commons.Color.popups.background
      ctx.lineWidth = Math.max(1.5, width * 0.14)
      ctx.lineCap = "round"
      ctx.lineJoin = "round"
      ctx.beginPath()
      ctx.moveTo(width * 0.24, height * 0.52)
      ctx.lineTo(width * 0.43, height * 0.72)
      ctx.lineTo(width * 0.78, height * 0.30)
      ctx.stroke()
    }
  }

  MouseArea {
    id: mouse
    // A little wider than the box, so it is easy to hit.
    anchors.fill: parent
    anchors.margins: -Style.space(4)
    hoverEnabled: true
    cursorShape: Qt.PointingHandCursor
    onContainsMouseChanged: root.hovered(containsMouse)
    onClicked: root.toggled()
  }
}
