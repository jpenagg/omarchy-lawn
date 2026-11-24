import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Commons as Commons
import "Model.js" as Model

// The lawn's state, shared by every copy of the bar widget: one log, one set
// of network requests, and one stream of notifications however many monitors
// (and so bars) there are. The shell mounts it as the plugin's service; the
// widgets read it and call its actions.
Item {
  id: service

  // Filled in by the shell.
  property var shell: null
  property var manifest: null

  // The widget's entry in shell.json. A service is not handed its plugin's
  // bar settings, so the widget passes them in through configure(), and
  // nothing touches the network until it has.
  property var settings: ({})
  property bool configured: false

  function configure(values) {
    settings = values || ({})
    if (configured) return
    configured = true
    Qt.callLater(refresh)
    Qt.callLater(ensureClimate)
  }

  function setting(name, fallback) {
    var value = settings ? settings[name] : undefined
    return value === undefined || value === null ? fallback : value
  }

  // `omarchy bar set ... conditions false` without --json stores the string.
  function flag(name, fallback) {
    return String(setting(name, fallback)).toLowerCase() === "true"
  }

  readonly property bool conditionsEnabled: flag("conditions", true)
  readonly property bool notifyEnabled: flag("notify", false)
  readonly property string grassType: Model.grassFor(setting("grassType", "")).name
  // "Auto", or a zone picked by hand.
  readonly property string zoneSetting: Model.isAutoZone(setting("zone", "")) ? Model.AUTO_ZONE : Model.normalizeZone(setting("zone", ""))
  readonly property bool autoZone: zoneSetting === Model.AUTO_ZONE
  // The lawn's own location, set in the panel. A lawn stays put when the
  // laptop travels, so this wins over anything detected.
  readonly property var ownLocation: Model.cleanLocation(setting("location", null))
  readonly property bool imperial: Model.usesImperial(Qt.locale().name)

  // ---- State.
  property string today: Qt.formatDate(new Date(), "yyyy-MM-dd")
  property var log: Model.cleanLog(null)

  // Without a location of its own the lawn takes the Weather widget's when
  // that has coordinates, and otherwise wherever geo.omarchy.org places this
  // network, as the Weather widget itself does.
  property var weatherLocation: Model.cleanLocation(null)
  property var networkLocation: Model.cleanLocation(null)
  property bool locationSettled: false
  property bool locationFailed: false
  readonly property var location: Model.pickLocation(ownLocation, weatherLocation, networkLocation)
  readonly property bool southern: Model.hasCoordinates(location) && location.latitude < 0
  readonly property string forecastUrl: Model.forecastUrl(location)
  onForecastUrlChanged: if (forecastUrl !== "") { retries = 0; Qt.callLater(refresh) }

  // Parsed weather. Kept when a later fetch fails, so stale beats blank.
  property var conditions: null
  property string fetchingUrl: ""
  property bool fetchFailed: false
  property double fetchedAt: 0
  property int retries: 0
  readonly property var activeConditions: conditionsEnabled ? conditions : null

  // ---- Climate: the zone and the usual frost dates, worked out once per
  // location from thirty years of winter lows and kept in a small cache file.
  property var climateCache: Model.parseClimateCache("")
  property bool climateCacheSettled: false
  property bool climateFailed: false
  property string climateFetchingKey: ""
  property bool climateFetchingSouthern: false
  readonly property string climateKey: Model.locationKey(location)
  readonly property var estimate: climateCache.key !== "" && climateCache.key === climateKey ? climateCache : null
  // The estimate, with any frost date set by hand ("MM-DD") in its place.
  readonly property var climate: Model.climateWith(estimate, setting("lastFrost", ""), setting("firstFrost", ""))
  readonly property string estimatedZone: estimate ? estimate.zone : ""
  readonly property bool zoneKnown: !autoZone || estimatedZone !== ""
  readonly property string zone: autoZone ? (estimatedZone || Model.DEFAULT_ZONE) : zoneSetting
  // What the calendar's dates rest on: the location's own frost dates, or
  // failing that the zone.
  readonly property bool frostBased: Model.hasFrostDates(climate)
  readonly property bool climatePending: conditionsEnabled && climateKey !== "" && !estimate && !climateFailed
  onClimateKeyChanged: Qt.callLater(ensureClimate)

  // ---- What the panel shows, all derived.
  // What today is like for mowing, and the dry stretch of daylight if any.
  readonly property string mowingState: Model.mowingToday(activeConditions, today, grassType)
  readonly property var mowing: Model.mowWindow(activeConditions)
  // How fast the grass is growing: in words, and from 0 to 1.
  readonly property string pace: Model.growthPace(activeConditions, today, grassType)
  readonly property real growthRate: {
    if (!activeConditions || Model.isDormant(activeConditions, today, grassType)) return 0
    var rate = Model.recentGrowth(activeConditions, today, grassType)
    return rate === null ? 0 : rate
  }
  readonly property var water: Model.waterBalance(activeConditions, today, grassType)
  readonly property var jobs: Model.calendar(grassType, zone, today, activeConditions, southern, log, climate)
  readonly property int openJobCount: Model.openJobs(jobs).length

  readonly property string conditionsStatus: {
    if (!conditionsEnabled) return "off"
    if (conditions) return ""
    if (fetchFailed) return "unavailable"
    if (locationFailed && forecastUrl === "") return "noLocation"
    return "loading"
  }

  // ---- Town search.
  property var suggestions: []
  property string searchPending: ""
  property string searchActive: ""

  // ---- The log: which calendar jobs have been checked off. Writing the
  // file is what tells the other copies of the widget.

  function saveLog(next) {
    log = next
    logFile.setText(Model.serialiseLog(next))
  }

  // Checks a calendar job off, or unchecks it.
  function toggleJob(job) {
    saveLog(Model.toggleJob(log, job, today))
  }

  // For scripts and keybindings, which should never undo by being run twice.
  function finishJob(id) {
    for (var i = 0; i < jobs.length; i++) {
      if (jobs[i].id !== id) continue
      if (jobs[i].doneOn === "") toggleJob(jobs[i])
      return "ok"
    }
    return "unknown job"
  }

  // ---- Network. Fixed HTTPS hosts, a timeout, and a size cap on each, and
  // nothing fetched is ever handed to a shell.

  function refresh() {
    if (!configured || !conditionsEnabled || !locationSettled) return
    if (forecastUrl === "") {
      if (!geoProc.running) geoProc.running = true
      return
    }
    if (fetchProc.running) return
    fetchingUrl = forecastUrl
    fetchProc.command = ["curl", "-fsS", "--proto", "=https", "--max-time", "8",
      "--max-filesize", String(Model.MAX_RESPONSE_BYTES), fetchingUrl]
    fetchProc.running = true
  }

  function refreshNow() {
    retries = 0
    refresh()
    ensureClimate()
  }

  function refreshIfStale() {
    logFile.reload()
    if (Date.now() - fetchedAt > 10 * 60 * 1000) refresh()
    ensureClimate()
  }

  // The network may still be coming up after a wake or a login: try a few
  // times before leaving it to the refresh timer.
  function scheduleRetry() {
    if (retries >= 3) return
    retries++
    retryTimer.restart()
  }

  // Works the climate out for the current location, unless it is already
  // known or lookups are off.
  function ensureClimate() {
    if (!configured || !conditionsEnabled || !climateCacheSettled || climateKey === "" || estimate || archiveProc.running) return
    climateFetchingKey = climateKey
    climateFetchingSouthern = southern
    archiveProc.command = ["curl", "-fsS", "--proto", "=https", "--max-time", "20",
      "--max-filesize", String(Model.MAX_ARCHIVE_BYTES), Model.archiveUrl(location)]
    archiveProc.running = true
  }

  // Only one town lookup runs at a time; if the text moved on while it was
  // in flight, the latest is fetched right after.
  function search(text) {
    var url = conditionsEnabled ? Model.geocodeUrl(text) : ""
    searchPending = url
    if (url === "") {
      suggestions = []
      return
    }
    if (!geocodeProc.running) startSearch()
  }

  function startSearch() {
    if (searchPending === "") return
    searchActive = searchPending
    geocodeProc.command = ["curl", "-fsS", "--proto", "=https", "--max-time", "5",
      "--max-filesize", String(Model.MAX_RESPONSE_BYTES), searchActive]
    geocodeProc.running = true
  }

  function clearSearch() {
    searchPending = ""
    suggestions = []
  }

  onConditionsEnabledChanged: if (conditionsEnabled) { Qt.callLater(refresh); Qt.callLater(ensureClimate) }

  Process {
    id: geoProc
    command: ["curl", "-fsS", "--proto", "=https", "--max-time", "4", "--max-filesize", "4096", "https://geo.omarchy.org/"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var detected = Model.parseLocation(text)
        if (Model.hasCoordinates(detected)) {
          service.locationFailed = false
          service.networkLocation = detected
        } else {
          service.locationFailed = true
          service.scheduleRetry()
        }
      }
    }
  }

  Process {
    id: fetchProc
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var parsed = Model.parseConditions(text)
        if (parsed && service.fetchingUrl === service.forecastUrl) {
          service.conditions = parsed
          service.fetchFailed = false
          service.fetchedAt = Date.now()
          service.retries = 0
        } else if (parsed) {
          // The location moved while this was in flight: ask again.
          Qt.callLater(service.refresh)
        } else {
          service.fetchFailed = true
          service.scheduleRetry()
        }
      }
    }
  }

  Process {
    id: geocodeProc
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        // An answer for text that has since been cleared is dropped.
        service.suggestions = service.searchPending !== "" ? Model.parseGeocoding(text) : []
        if (service.searchPending !== service.searchActive) Qt.callLater(service.startSearch)
      }
    }
  }

  Process {
    id: archiveProc
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var found = Model.climateFromArchive(text, service.climateFetchingSouthern)
        if (!found || found.zone === "") {
          service.climateFailed = true
          return
        }
        service.climateFailed = false
        service.climateCache = {
          key: service.climateFetchingKey, zone: found.zone, lastFrost: found.lastFrost, firstFrost: found.firstFrost
        }
        climateFile.setText(Model.serialiseClimateCache(service.climateFetchingKey, found))
        // The location moved while this was in flight: work it out again.
        if (service.climateFetchingKey !== service.climateKey) Qt.callLater(service.ensureClimate)
      }
    }
  }

  Timer {
    interval: 60 * 60 * 1000
    running: service.configured && service.conditionsEnabled
    repeat: true
    onTriggered: {
      service.retries = 0
      service.climateFailed = false
      service.refresh()
      service.ensureClimate()
    }
  }

  Timer {
    id: retryTimer
    interval: 5000
    onTriggered: service.refresh()
  }

  // Rolls `today` over at midnight and sends any notification that is due.
  Timer {
    interval: 60 * 1000
    running: true
    repeat: true
    onTriggered: {
      service.today = Qt.formatDate(new Date(), "yyyy-MM-dd")
      service.announce()
    }
  }

  // ---- Files.

  readonly property string stateDir: (Quickshell.env("XDG_STATE_HOME") || Quickshell.env("HOME") + "/.local/state") + "/lawn"

  Process {
    command: ["mkdir", "-p", service.stateDir]
    running: true
    onExited: logFile.reload()
  }

  FileView {
    id: logFile
    path: service.stateDir + "/log.json"
    watchChanges: true
    atomicWrites: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: service.log = Model.parseLog(text())
    onLoadFailed: service.log = Model.parseLog("")
  }

  FileView {
    id: climateFile
    path: service.stateDir + "/climate.json"
    watchChanges: true
    atomicWrites: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: service.settleClimateCache(Model.parseClimateCache(text()))
    onLoadFailed: service.settleClimateCache(Model.parseClimateCache(""))
  }

  function settleClimateCache(parsed) {
    if (parsed.key !== "") climateCache = parsed
    climateCacheSettled = true
    Qt.callLater(ensureClimate)
  }

  FileView {
    id: weatherFile
    path: Quickshell.env("HOME") + "/.local/state/omarchy/settings/weather.json"
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: service.settleLocation(Model.parseLocation(text()))
    onLoadFailed: service.settleLocation(Model.parseLocation(""))
  }

  function settleLocation(parsed) {
    weatherLocation = parsed
    if (locationSettled) return
    locationSettled = true
    Qt.callLater(refresh)
  }

  // ---- Notifications, when the `notify` setting is on: one when a calendar
  // job's window opens. The keys already announced are kept in a file so a
  // restart does not repeat them.

  property var notified: []
  property bool notifiedSettled: false

  Commons.Translations { id: strings; directory: Qt.resolvedUrl("i18n") }

  FileView {
    id: notifiedFile
    path: service.stateDir + "/notified.json"
    atomicWrites: true
    printErrors: false
    onLoaded: { service.notified = Model.parseNotified(text()); service.notifiedSettled = true }
    onLoadFailed: { service.notified = []; service.notifiedSettled = true }
  }

  function announce() {
    if (!configured || !notifyEnabled || !notifiedSettled) return
    // Not in the small hours: a job that opened at midnight can wait.
    var hour = new Date().getHours()
    if (hour < 8 || hour >= 20) return

    var due = Model.alerts(jobs).filter(function(alert) { return service.notified.indexOf(alert.key) === -1 })
    if (due.length === 0) return

    var keys = notified.slice()
    for (var i = 0; i < due.length; i++) {
      keys.push(due[i].key)
      var headline = strings.t("notify.job").arg(strings.t("job." + due[i].id))
      var body = strings.t("notify.job.body")
      // The notification daemon renders markup, so the text goes through
      // plainText first; it is passed as arguments, never through a shell.
      Quickshell.execDetached(["omarchy-notification-send", "--app-name", "Lawn Almanac", Model.plainText(headline), Model.plainText(body)])
    }
    notified = Model.parseNotified(Model.serialiseNotified(keys))
    notifiedFile.setText(Model.serialiseNotified(keys))
  }
}
