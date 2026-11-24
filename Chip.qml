import QtQuick
import qs.Commons
import qs.Commons as Commons

// A small pill holding one fact about the lawn: its grass, zone, or town.
Rectangle {
  id: chip

  property string text: ""
  property bool lit: false
  // The widest the chip may grow; a long town name is cut short to fit.
  property real maxWidth: 10000

  readonly property color foreground: Commons.Color.popups.text
  readonly property int padX: Style.space(9)

  function mix(from, to, t) {
    return Qt.rgba(from.r + (to.r - from.r) * t, from.g + (to.g - from.g) * t, from.b + (to.b - from.b) * t, 1)
  }

  width: Math.min(maxWidth, label.implicitWidth + padX * 2)
  height: label.implicitHeight + Style.space(8)
  radius: Style.cornerRadius
  color: mix(Commons.Color.popups.background, foreground, lit ? 0.2 : 0.12)

  PlainText {
    id: label
    anchors.centerIn: parent
    width: Math.min(implicitWidth, chip.maxWidth - chip.padX * 2)
    text: chip.text
    font.pixelSize: Style.font.bodySmall
    font.weight: Font.DemiBold
    elide: Text.ElideRight
  }
}
