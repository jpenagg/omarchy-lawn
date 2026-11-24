import QtQuick
import Quickshell
import qs.Commons
import qs.Commons as Commons
import qs.Ui
import "Model.js" as Model

// Lawn: a tuft of grass in the bar, and a panel that says what today is like
// for the lawn and when the year's jobs fall due.
//
// This file is the bar icon and the panel: a header and a short stack of
// cards. The lawn's state lives in Service.qml, which every copy of this
// widget (one per monitor) shares.
//
// The id is `lawn` rather than the usual `root` so the component handed to
// BarIconButton, which has a `root` of its own, can never resolve it to the
// wrong object.
Panel {
  id: lawn
  moduleName: "jpenagg.lawn"
  ipcTarget: moduleName
  manageIpc: false

  readonly property color foreground: Commons.Color.popups.text

  // ---- The shared service. The shell mounts it before the bar, but ask a
  // few times in case this widget got there first, and fall back to a
  // private copy if the shell never hands one over.
  property var sharedStore: null
  property int storeAttempts: 0
  readonly property var store: sharedStore || privateStore.item

  function findStore() {
    if (sharedStore) return
    var found = bar && bar.shell && typeof bar.shell.serviceFor === "function" ? bar.shell.serviceFor(moduleName) : null
    if (found && typeof found.configure === "function") sharedStore = found
  }

  Timer {
    interval: 500
    running: lawn.sharedStore === null && lawn.storeAttempts < 6
    repeat: true
    triggeredOnStart: true
    onTriggered: {
      lawn.storeAttempts++
      lawn.findStore()
    }
  }

  Loader {
    id: privateStore
    active: lawn.sharedStore === null && lawn.storeAttempts >= 6
    source: Qt.resolvedUrl("Service.qml")
  }

  // The service is not given this widget's settings, so hand them over.
  function configureStore() {
    if (store) store.configure(settings)
  }
  onStoreChanged: configureStore()
  onSettingsChanged: configureStore()
  onBarChanged: findStore()

  // Named `wording`, not `words`: the setup section has a `words` property,
  // and `words: words` there would bind it to itself.
  Words {
    id: wording
    store: lawn.store
  }

  // ---- The panel's own state.
  property bool setupOpen: false
  property bool editingLocation: false
  property int suggestionIndex: 0
  property bool fullYear: false
  // The calendar job the keyboard cursor is on, by id; "" for none.
  property string jobCursor: ""

  readonly property var shownJobs: !store ? [] : (fullYear ? store.jobs : Model.shortCalendar(store.jobs))

  function toggleSetup() {
    if (setupOpen && editingLocation) stopEditingLocation()
    setupOpen = !setupOpen
  }

  // ---- Settings. Applied here first so the panel redraws on the click; the
  // shell.json write comes back through the bar as the same value. A null
  // value removes the key.
  function persistSettings(values) {
    var entry = { id: lawn.moduleName }
    for (var existing in lawn.settings) if (existing !== "id") entry[existing] = lawn.settings[existing]
    for (var key in values) {
      if (values[key] === null) delete entry[key]
      else entry[key] = values[key]
    }

    lawn.settings = entry
    if (lawn.bar && lawn.bar.shell && typeof lawn.bar.shell.updateEntryInline === "function")
      lawn.bar.shell.updateEntryInline(lawn.moduleName, entry)
  }

  // ---- Location editing. The row swaps to a search field; picking a
  // suggestion saves its name and coordinates to this widget's shell.json
  // entry, and committing an empty field goes back to automatic.

  function locationInput() {
    var setup = panel.loadedContent ? panel.loadedContent.setup : null
    return setup ? setup.locationField : null
  }

  function startEditingLocation() {
    if (!store || !store.conditionsEnabled) return
    setupOpen = true
    editingLocation = true
    suggestionIndex = 0
    store.clearSearch()
    Qt.callLater(function() {
      var field = lawn.locationInput()
      if (!field) return
      field.text = lawn.store.ownLocation.name
      field.selectAll()
      field.forceActiveFocus()
    })
  }

  function stopEditingLocation() {
    editingLocation = false
    if (store) store.clearSearch()
    Qt.callLater(function() { if (panel.loadedContent) panel.loadedContent.forceActiveFocus() })
  }

  function commitLocation(text) {
    if (String(text || "").trim() === "") {
      persistSettings({ location: null })
      stopEditingLocation()
      return
    }
    pickSuggestion(store.suggestions[suggestionIndex])
  }

  function pickSuggestion(suggestion) {
    var stored = Model.storedLocation(suggestion)
    if (!stored) return
    persistSettings({ location: stored })
    stopEditingLocation()
  }

  // ---- The calendar's keyboard cursor.

  function moveJobCursor(direction) {
    var ids = shownJobs.map(function(job) { return job.id })
    if (ids.length === 0) { jobCursor = ""; return }
    var at = ids.indexOf(jobCursor)
    if (at === -1) at = direction > 0 ? 0 : ids.length - 1
    else at = Math.max(0, Math.min(ids.length - 1, at + direction))
    jobCursor = ids[at]
  }

  function activateJobCursor() {
    for (var i = 0; i < shownJobs.length; i++) {
      if (shownJobs[i].id === jobCursor) { store.toggleJob(shownJobs[i]); return }
    }
  }

  onOpenedChanged: {
    if (!opened) {
      editingLocation = false
      jobCursor = ""
      if (store) store.clearSearch()
      return
    }
    if (store) store.refreshIfStale()
  }

  // ---- What the cards say.

  function mowHeight() {
    var height = Model.mowHeight(store.grassType, wording.imperial)
    return wording.t(wording.imperial ? "mow.height.in" : "mow.height.cm").arg(wording.number(height.low)).arg(wording.number(height.high))
  }

  // The dry stretch of daylight to mow in, when there is one.
  function mowValue() {
    var slot = store.mowing.window
    if (!slot || store.mowingState === "resting") return wording.t("unknown")
    return wording.t("range").arg(wording.hour(slot.from)).arg(wording.hour(slot.to))
  }

  function waterNote() {
    var water = store.water
    if (water.status === "") return ""
    if (water.status === "water") return wording.t("water.give").arg(wording.depth(water.deficitMm))
    return wording.t("water." + water.status)
  }

  function frostValue() {
    var year = parseInt(store.today.slice(0, 4), 10)
    return wording.dateRange(Model.frostDate(store.climate.lastFrost, year), Model.frostDate(store.climate.firstFrost, year))
  }

  function jobValue(job) {
    if (job.doneOn !== "") return wording.t("job.done")
    if (job.late) return wording.t("job.closed")
    if (job.active) return wording.t("job.now")
    return wording.tn("job.in", job.daysUntil)
  }

  function jobValueNote(job) {
    if (job.doneOn !== "") return wording.shortDate(job.doneOn)
    if (job.late) return wording.tn("job.ago", job.daysLate)
    if (job.active) return job.daysLeft <= 0 ? wording.t("job.lastDay") : wording.tn("job.left", job.daysLeft)
    return ""
  }

  ShellIpc {
    target: lawn.ipcTarget

    function open(): void { lawn.open() }
    function close(): void { lawn.close() }
    function show(): void { lawn.open() }
    function hide(): void { lawn.close() }
    function toggle(): void { lawn.toggle() }
    function refresh(): void { if (lawn.store) lawn.store.refreshNow() }
    // Checks a calendar job off by its id (see the README for the list).
    function done(job: string): string { return lawn.store ? lawn.store.finishJob(job) : "unavailable" }
    // What today is like for mowing: resting, today, tomorrow, wet, or hot.
    function status(): string { return lawn.store ? lawn.store.mowingState : "" }
    // Which copy of the service this widget is using: "shared" when the shell
    // handed over the plugin's one service, "private" when it fell back to its own.
    function service(): string { return lawn.sharedStore ? "shared" : (lawn.store ? "private" : "none") }
  }

  // ---- Bar icon.

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  // The blades stand as tall as the grass is growing fast: full height in
  // the flush of spring, cropped short when the lawn is resting.
  property real shownGrowth: store ? store.growthRate : 1
  Behavior on shownGrowth {
    NumberAnimation { duration: Style.duration(220); easing.type: Easing.Bezier; easing.bezierCurve: Style.easeOut }
  }

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: lawn.bar
    slotSize: Style.bar.statusSlot
    // The panel is the detail view.
    tooltipText: ""
    iconComponent: Component {
      GrassIcon {
        width: Style.bar.iconSize
        height: Style.bar.iconSize
        growth: lawn.shownGrowth
        color: button.foreground
        // Dotted while a calendar job is open and not yet checked off.
        dot: lawn.store ? lawn.store.openJobCount > 0 : false
      }
    }

    onPressed: function(pressedButton) {
      if (pressedButton === Qt.MiddleButton) {
        if (lawn.store) lawn.store.refreshNow()
      } else {
        lawn.toggle()
      }
    }
  }

  // ---- Panel.

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: lawn
    bar: lawn.bar
    open: lawn.opened && lawn.store !== null
    focusTarget: panel.loadedContent
    contentWidth: panel.fittedContentWidth(Style.space(340))
    contentHeight: panel.fittedContentHeight(panel.loadedContentHeight)

    content: PanelKeyCatcher {
      id: keys
      property alias setup: setupLoader.item
      implicitHeight: column.implicitHeight
      anchors.fill: parent
      blocked: lawn.editingLocation || (setupLoader.item ? setupLoader.item.pickerOpen : false)
      onCloseRequested: lawn.close()
      onTabRequested: function(direction) { lawn.switchPanel(direction) }
      onMoveRequested: function(dx, dy) { if (dy !== 0) lawn.moveJobCursor(dy) }
      onActivateRequested: lawn.activateJobCursor()
      onTextKey: function(typed) {
        var key = typed.toLowerCase()
        if (key === "t") lawn.toggleSetup()
        else if (key === "c") lawn.fullYear = !lawn.fullYear
        else if (key === "r") lawn.store.refreshNow()
      }

      Flickable {
        id: flick
        anchors.fill: parent
        contentWidth: width
        contentHeight: column.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        interactive: contentHeight > height

        Column {
          id: column
          width: flick.width
          spacing: Style.spacing.panelGap

          // ---- Header: the grass, what today is like, and the lawn itself
          // (its grass, zone, and town) as three chips. Click them to change
          // any of it.
          Column {
            width: parent.width
            spacing: Style.space(8)

            GrassIcon {
              anchors.horizontalCenter: parent.horizontalCenter
              width: Style.space(40)
              height: Style.space(40)
              growth: lawn.shownGrowth
              color: lawn.foreground
            }

            PlainText {
              anchors.horizontalCenter: parent.horizontalCenter
              width: Math.min(implicitWidth, parent.width)
              text: wording.t("title")
              font.pixelSize: Style.font.heading
              font.weight: Font.DemiBold
              elide: Text.ElideRight
            }

            Item {
              width: parent.width
              height: chips.height

              Row {
                id: chips
                anchors.horizontalCenter: parent.horizontalCenter
                spacing: Style.space(6)

                readonly property bool lit: chipArea.containsMouse || lawn.setupOpen

                Chip {
                  id: grassChip
                  text: wording.grass(Model.grassFor(lawn.store.grassType))
                  lit: chips.lit
                }
                Chip {
                  id: zoneChip
                  text: wording.t("lawn.zoneOption").arg(lawn.store.zone)
                  lit: chips.lit
                }
                Chip {
                  text: lawn.store.location.name !== "" ? lawn.store.location.name : wording.t("chip.noPlace")
                  lit: chips.lit
                  // Whatever the other two leave of the panel's width.
                  maxWidth: Math.max(Style.space(60), column.width - grassChip.width - zoneChip.width - chips.spacing * 2)
                }
              }

              MouseArea {
                id: chipArea
                anchors.fill: chips
                hoverEnabled: true
                cursorShape: Qt.PointingHandCursor
                onClicked: lawn.toggleSetup()
              }
            }
          }

          // Town, grass, and zone, when the header has been clicked.
          Loader {
            id: setupLoader
            width: parent.width
            // Above the cards, so an open picker covers them.
            z: 1
            active: lawn.setupOpen
            visible: active
            sourceComponent: SetupSection {
              ui: lawn
              store: lawn.store
              words: wording
              onPickerClosed: keys.forceActiveFocus()
            }
          }

          Column {
            width: parent.width
            spacing: Style.spacing.md

            Card {
              label: wording.t("card.mowing")
              note: lawn.mowHeight()
              value: lawn.mowValue()
              valueNote: lawn.store.mowingState !== "" ? wording.t("mow." + lawn.store.mowingState) : ""
              emphasized: lawn.store.mowingState === "today"
            }

            Card {
              label: wording.t("card.soil")
              note: lawn.store.pace !== "" ? wording.t("pace." + lawn.store.pace) : wording.t(lawn.store.conditionsStatus !== "" ? "conditions." + lawn.store.conditionsStatus : "unknown")
              value: lawn.store.activeConditions ? wording.temperature(lawn.store.activeConditions.soilC) : wording.t("unknown")
              level: lawn.store.activeConditions ? lawn.store.growthRate : -1
            }

            Card {
              label: wording.t("card.rain")
              note: lawn.waterNote()
              value: wording.depth(lawn.store.water.rainMm)
              valueNote: lawn.store.water.aheadMm !== null ? wording.t("rain.coming").arg(wording.depth(lawn.store.water.aheadMm)) : ""
            }

            Card {
              visible: lawn.store.frostBased
              label: wording.t("card.frost")
              note: wording.t("frost.note").arg(lawn.store.zone)
              value: lawn.store.frostBased ? lawn.frostValue() : ""
            }

            Repeater {
              model: lawn.shownJobs

              Card {
                id: jobCard
                required property var modelData
                readonly property bool done: modelData.doneOn !== ""
                label: wording.t("job." + modelData.id)
                note: wording.dateRange(modelData.start, modelData.end)
                value: lawn.jobValue(modelData)
                valueNote: lawn.jobValueNote(modelData)
                emphasized: modelData.active && !done
                muted: done
                hasCursor: lawn.jobCursor === modelData.id

                CheckBox {
                  checked: jobCard.done
                  hasCursor: jobCard.hasCursor
                  onToggled: lawn.store.toggleJob(jobCard.modelData)
                  onHovered: function(isHovered) { if (isHovered) lawn.jobCursor = jobCard.modelData.id }
                }
              }
            }
          }

          PlainText {
            anchors.horizontalCenter: parent.horizontalCenter
            text: wording.t(lawn.fullYear ? "calendar.less" : "calendar.all")
            dim: !yearArea.containsMouse
            font.pixelSize: Style.font.caption

            MouseArea {
              id: yearArea
              anchors.fill: parent
              anchors.margins: -Style.space(4)
              hoverEnabled: true
              cursorShape: Qt.PointingHandCursor
              onClicked: lawn.fullYear = !lawn.fullYear
            }
          }
        }
      }
    }
  }
}
