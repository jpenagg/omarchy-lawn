import QtQuick
import qs.Commons
import qs.Commons as Commons

// One row of the panel, in the manner of the world clock's: a softly tinted
// card with a name and a note on the left, and a value and a note on the
// right. `level` (0 to 1) draws a thin gauge along the bottom. Anything
// declared inside the card, such as a check box, sits before the name.
Rectangle {
  id: card

  property string label: ""
  property string note: ""
  property string value: ""
  property string valueNote: ""
  property real level: -1
  // Brighter: this row wants attention. Dimmer: it is finished with.
  property bool emphasized: false
  property bool muted: false
  property bool hasCursor: false

  default property alias leading: leadingSlot.data

  readonly property color foreground: Commons.Color.popups.text
  readonly property int pad: Style.space(12)
  readonly property bool gauged: level >= 0

  function mix(from, to, t) {
    return Qt.rgba(from.r + (to.r - from.r) * t, from.g + (to.g - from.g) * t, from.b + (to.b - from.b) * t, 1)
  }

  width: parent ? parent.width : implicitWidth
  implicitHeight: pad * 2 + Math.max(labels.implicitHeight, values.implicitHeight) + (gauged ? Style.space(9) + track.height : 0)
  radius: Style.cornerRadius
  color: mix(Commons.Color.popups.background, foreground, (emphasized ? 0.11 : 0.06) + (hasCursor ? 0.05 : 0))

  Row {
    id: leadingSlot
    anchors.left: parent.left
    anchors.leftMargin: Style.spacing.rowPaddingX
    anchors.verticalCenter: labels.verticalCenter
  }

  Column {
    id: labels
    anchors.left: leadingSlot.right
    anchors.leftMargin: leadingSlot.width > 0 ? Style.space(10) : 0
    anchors.right: values.left
    anchors.rightMargin: Style.spacing.xl
    anchors.top: parent.top
    anchors.topMargin: card.pad
    spacing: Style.space(2)

    PlainText {
      width: parent.width
      text: card.label
      dim: card.muted
      font.pixelSize: Style.font.subtitle
      font.weight: Font.DemiBold
      elide: Text.ElideRight
    }
    PlainText {
      visible: card.note !== ""
      width: parent.width
      text: card.note
      dim: true
      font.pixelSize: Style.font.caption
      elide: Text.ElideRight
    }
  }

  Column {
    id: values
    anchors.right: parent.right
    anchors.rightMargin: Style.spacing.rowPaddingX
    anchors.verticalCenter: labels.verticalCenter
    spacing: Style.space(1)

    PlainText {
      anchors.right: parent.right
      text: card.value
      dim: card.muted
      font.pixelSize: Style.font.heading
      font.weight: Font.DemiBold
    }
    PlainText {
      visible: card.valueNote !== ""
      anchors.right: parent.right
      text: card.valueNote
      dim: true
      font.pixelSize: Style.font.caption
    }
  }

  Rectangle {
    id: track
    visible: card.gauged
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.bottom: parent.bottom
    anchors.leftMargin: Style.spacing.rowPaddingX
    anchors.rightMargin: Style.spacing.rowPaddingX
    anchors.bottomMargin: card.pad
    height: Math.max(2, Style.space(3))
    radius: height / 2
    color: Util.alpha(card.foreground, 0.12)

    Rectangle {
      width: parent.width * Math.max(0, Math.min(1, card.level))
      height: parent.height
      radius: parent.radius
      color: card.foreground
      Behavior on width {
        NumberAnimation { duration: Style.duration(220); easing.type: Easing.Bezier; easing.bezierCurve: Style.easeOut }
      }
    }
  }
}
