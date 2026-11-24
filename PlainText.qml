import QtQuick
import qs.Commons
import qs.Commons as Commons

// Every label in the panel. PlainText is the point: a place name read from a
// file or the network can never be promoted to rich text and load a resource.
Text {
  property bool dim: false

  textFormat: Text.PlainText
  color: dim ? Qt.darker(Commons.Color.popups.text, 1.4) : Commons.Color.popups.text
  font.family: Style.font.family
  font.pixelSize: Style.font.body
}
