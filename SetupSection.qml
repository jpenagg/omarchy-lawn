import QtQuick
import qs.Commons
import qs.Commons as Commons
import qs.Ui
import "Model.js" as Model

// Where the lawn is and what grows on it: the town search, the grass and zone
// pickers, and the notification switch. Opened from the panel's header, since
// none of it changes often.
Column {
  id: root

  required property var ui
  required property var store
  required property var words

  property alias locationField: locationField
  readonly property bool pickerOpen: grassPicker.popupOpen || zonePicker.popupOpen

  // Emitted when a picker closes, so the panel can take the keyboard back.
  signal pickerClosed()

  function openGrass() { grassPicker.open() }
  function openZone() { zonePicker.open() }

  readonly property var grass: Model.grassFor(store.grassType)

  // Where the calendar's dates come from, and how sure the zone is.
  function basis() {
    if (store.frostBased) return words.t("basis.frost")
    if (store.climatePending) return words.t("basis.finding")
    if (!store.conditionsEnabled) return words.t("basis.offline").arg(store.zone)
    if (store.estimate) return words.t("basis.noFrost").arg(store.zone)
    return words.t("basis.unknown").arg(store.zone)
  }

  spacing: Style.space(8)

  Column {
    width: parent.width
    spacing: Style.space(10)

    // The lawn's town. Shown as a button; a click swaps it for a search
    // field with suggestions underneath.
    Column {
      visible: root.store.conditionsEnabled
      width: parent.width
      spacing: Style.spacing.labelGap

      PlainText {
        text: root.words.t("location.label")
        dim: true
        font.pixelSize: Style.font.caption
        font.bold: true
      }

      Button {
        visible: !root.ui.editingLocation
        width: parent.width
        text: root.store.location.name !== "" ? root.store.location.name : root.words.t("location.set")
        bordered: true
        leftAlign: true
        onClicked: root.ui.startEditingLocation()
      }

      TextField {
        id: locationField
        visible: root.ui.editingLocation
        width: parent.width
        placeholderText: root.words.t("location.search")

        onTextChanged: if (root.ui.editingLocation) searchDebounce.restart()

        Keys.onPressed: function(event) {
          if (event.key === Qt.Key_Escape) {
            root.ui.stopEditingLocation()
            event.accepted = true
          } else if (event.key === Qt.Key_Down) {
            if (root.ui.suggestionIndex < root.store.suggestions.length - 1) root.ui.suggestionIndex++
            event.accepted = true
          } else if (event.key === Qt.Key_Up) {
            if (root.ui.suggestionIndex > 0) root.ui.suggestionIndex--
            event.accepted = true
          } else if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) {
            root.ui.commitLocation(locationField.text)
            event.accepted = true
          }
        }
      }

      Timer {
        id: searchDebounce
        interval: 300
        onTriggered: if (root.ui.editingLocation) root.store.search(locationField.text)
      }

      Repeater {
        model: root.ui.editingLocation ? root.store.suggestions : []

        Rectangle {
          id: suggestionRow
          required property var modelData
          required property int index
          width: parent.width
          height: suggestionText.implicitHeight + Style.space(10)
          radius: Style.cornerRadius
          color: index === root.ui.suggestionIndex ? Style.hoverFillFor(Commons.Color.popups.text, Commons.Color.accent) : "transparent"

          Row {
            id: suggestionText
            anchors.left: parent.left
            anchors.leftMargin: Style.space(10)
            anchors.verticalCenter: parent.verticalCenter
            spacing: Style.space(8)

            PlainText { text: suggestionRow.modelData.name }
            PlainText {
              visible: text !== ""
              anchors.verticalCenter: parent.verticalCenter
              text: suggestionRow.modelData.description
              dim: true
              font.pixelSize: Style.font.bodySmall
            }
          }

          MouseArea {
            anchors.fill: parent
            hoverEnabled: true
            cursorShape: Qt.PointingHandCursor
            onPositionChanged: root.ui.suggestionIndex = suggestionRow.index
            onClicked: root.ui.pickSuggestion(suggestionRow.modelData)
          }
        }
      }

      PlainText {
        visible: !root.ui.editingLocation && root.store.location.source !== "own"
        width: parent.width
        text: root.words.t("location.source." + root.store.location.source)
        dim: true
        font.pixelSize: Style.font.bodySmall
        wrapMode: Text.WordWrap
      }
    }

    Row {
      width: parent.width
      spacing: Style.space(8)
      // Above what follows, so an open list covers it.
      z: 1

      Dropdown {
        id: grassPicker
        width: Math.round((parent.width - parent.spacing) * 0.6)
        label: root.words.t("lawn.grass")
        options: Model.GRASSES.map(function(entry) { return { value: entry.name, label: root.words.grass(entry) } })
        onChanged: function(value) { root.ui.persistSettings({ grassType: value }) }
        onPopupOpenChanged: if (!popupOpen) root.pickerClosed()
      }
      Dropdown {
        id: zonePicker
        width: parent.width - parent.spacing - grassPicker.width
        label: root.words.t("lawn.zone")
        options: [{
          value: Model.AUTO_ZONE,
          label: root.store.estimatedZone !== "" ? root.words.t("lawn.zoneAuto").arg(root.store.estimatedZone) : root.words.t("lawn.zoneAutoPending")
        }].concat(Model.zoneOptions().map(function(zone) { return { value: zone, label: root.words.t("lawn.zoneOption").arg(zone) } }))
        onChanged: function(value) { root.ui.persistSettings({ zone: value }) }
        onPopupOpenChanged: if (!popupOpen) root.pickerClosed()
      }

      // A Dropdown assigns its own value when picked from, which would drop
      // a plain binding; these keep it following shell.json.
      Binding { target: grassPicker; property: "value"; value: root.store.grassType }
      Binding { target: zonePicker; property: "value"; value: root.store.zoneSetting }
    }

    PlainText {
      visible: root.store.autoZone && root.store.estimatedZone !== ""
      width: parent.width
      text: root.words.t("zone.estimated").arg(root.store.estimatedZone)
      dim: true
      font.pixelSize: Style.font.bodySmall
      wrapMode: Text.WordWrap
    }

    PlainText {
      width: parent.width
      text: root.basis()
      dim: true
      font.pixelSize: Style.font.bodySmall
      wrapMode: Text.WordWrap
    }

    PlainText {
      visible: root.store.zoneKnown && !Model.zoneFits(root.store.grassType, root.store.zone)
      width: parent.width
      text: root.words.t("lawn.poorFit").arg(root.words.grass(root.grass)).arg(root.store.zone)
      color: Commons.Color.urgent
      font.pixelSize: Style.font.bodySmall
      wrapMode: Text.WordWrap
    }

    Row {
      width: parent.width
      spacing: Style.space(10)

      CheckBox {
        id: notifyBox
        anchors.verticalCenter: parent.verticalCenter
        checked: root.store.notifyEnabled
        onToggled: root.ui.persistSettings({ notify: !root.store.notifyEnabled })
      }
      PlainText {
        width: parent.width - notifyBox.width - parent.spacing
        text: root.words.t("notify.label")
        wrapMode: Text.WordWrap

        MouseArea {
          anchors.fill: parent
          cursorShape: Qt.PointingHandCursor
          onClicked: root.ui.persistSettings({ notify: !root.store.notifyEnabled })
        }
      }
    }
  }
}
